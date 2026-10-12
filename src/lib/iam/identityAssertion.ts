/**
 * Verified identity assertions: the one place a signed statement from a party the
 * administrator trusts ("this request is for person X of my application") is
 * checked. Everything that lets someone act for another person - the client API's
 * delegation mode, the portal embed - asks this module first and only then maps the
 * answer to an account (`delegatedIdentity.ts`).
 *
 * The assertion is a compact JWT (JWS). What is checked, in this order:
 *
 *   - the token is a well-formed three-part JWS of a sane size, and its `alg` is one
 *     of the algorithms the administrator PINNED (`trust.algorithms`; `none` never
 *     passes, whatever the pin says);
 *   - the signature, with ONLY the key material that belongs to that algorithm:
 *       HS256        a shared secret (`keys.hsSecrets`, picked by `kid`)
 *       RS256/ES256  a public key (`keys.pem`) or a remote key set (`keys.jwksUrl`)
 *     A secret is never offered to an asymmetric algorithm and a public key never to
 *     HS256 - the classic key-confusion attack has nothing to work with;
 *   - `iss` equals the trusted issuer, `aud` names one of the trusted audiences,
 *     `sub` is present, `exp` has not passed and `iat` is neither in the future nor
 *     (when `maxTokenAgeSeconds` is set) older than that, nor was the token issued
 *     for longer a life than that. Clocks may differ by `clockSkewSeconds`;
 *   - with `requireSingleUse` the `jti` must be present and is accepted ONCE until
 *     the token expires (an in-process, bounded replay cache: each node of a
 *     cluster keeps its own, so a replay across nodes needs an issuer that also
 *     keeps its tokens short-lived).
 *
 * A remote key set is fetched through `safeFetch` (the SSRF guard applies), is
 * limited in size, is cached for ten minutes and is refetched for an unknown `kid`
 * at most every thirty seconds, so a token cannot be used to make the server hammer
 * somebody's endpoint.
 *
 * What comes out is what the token SAYS, verified: the issuer and subject, and the
 * profile claims in a bounded shape. `ctx` is whatever the issuer put in the `ctx`
 * claim (at most 4 KB of JSON) - signed by the issuer, but not a statement of fact the
 * console checks, so it is untrusted data for the code that reads it.
 *
 * Every refusal is an `IdentityAssertionError` with one of four codes:
 *   invalid_assertion  the token is not acceptable (malformed, wrong algorithm, bad
 *                      signature, wrong issuer/audience, missing or odd claims);
 *   expired            it is out of its validity window (`exp`, or older than the maximum age);
 *   replayed           a single-use token was presented again;
 *   untrusted_key      no key we trust could verify it (none configured for the algorithm,
 *                      an unknown `kid`, an unreadable key, a key set that could not be fetched).
 * The messages say what was wrong with the token or the configuration, never what the
 * token contained.
 */

import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors as joseErrors,
  importSPKI,
  importX509,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { createLogger } from '@/lib/core/logger';
import { isPrivateIpAddress, safeFetch } from '@/lib/security/outboundFetch';

const logger = createLogger('iam:identity-assertion');

// ── contract ─────────────────────────────────────────────────────────────

/** The algorithms an administrator can pin. Never `none`; never anything not listed here. */
export const ASSERTION_ALGORITHMS = ['HS256', 'RS256', 'ES256'] as const;
export type AssertionAlgorithm = (typeof ASSERTION_ALGORITHMS)[number];

export interface IdentityAssertionHsSecret {
  /** Names the secret in the token's `kid` header; rotation = two secrets with two kids. */
  kid: string;
  secret: string;
}

export interface IdentityAssertionTrust {
  /** The `iss` the token must carry, compared exactly. */
  issuer: string;
  /** The `aud` the token must name (any one of them when several are trusted). */
  audience: string | string[];
  /** The algorithms the administrator pinned, a subset of {@link ASSERTION_ALGORITHMS}. */
  algorithms: AssertionAlgorithm[];
  keys: {
    hsSecrets?: IdentityAssertionHsSecret[];
    /** A PEM public key (SPKI) or X.509 certificate for RS256 / ES256. A private key is refused. */
    pem?: string;
    /** The URL of a JSON Web Key Set for RS256 / ES256. */
    jwksUrl?: string;
  };
  /** Longest life of a token (`exp - iat`) and longest time since `iat` the console accepts. */
  maxTokenAgeSeconds?: number;
  /** How far apart the issuer's clock and ours may be (default 60). */
  clockSkewSeconds?: number;
  /** Accept each `jti` once until `exp` (the `jti` becomes mandatory). */
  requireSingleUse?: boolean;
}

export type IdentityAssertionErrorCode = 'invalid_assertion' | 'expired' | 'replayed' | 'untrusted_key';

export class IdentityAssertionError extends Error {
  readonly code: IdentityAssertionErrorCode;

  constructor(code: IdentityAssertionErrorCode, message: string) {
    super(message);
    this.name = 'IdentityAssertionError';
    this.code = code;
  }
}

export interface VerifiedIdentityAssertion {
  /** The verified `iss`. */
  issuer: string;
  /** The verified `sub`. */
  subject: string;
  email?: string;
  /** `email_verified` when the token carries it as a boolean. */
  emailVerified?: boolean;
  name?: string;
  /** The `groups` claim, strings only. */
  groups?: string[];
  /** The `ctx` claim: at most 4 KB of JSON, signed by the issuer but UNTRUSTED data. */
  ctx?: unknown;
  /** Every claim of the verified token. */
  claims: Record<string, unknown>;
}

// ── limits ───────────────────────────────────────────────────────────────

/** A compact token above this is not an identity assertion. */
export const MAX_ASSERTION_LENGTH = 16 * 1024;
export const MAX_CTX_BYTES = 4 * 1024;
export const MAX_SUBJECT_LENGTH = 512;
export const MAX_ISSUER_LENGTH = 512;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 200;
const MAX_GROUPS = 100;
const MAX_GROUP_LENGTH = 200;
const MAX_JTI_LENGTH = 256;

export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const MAX_CLOCK_SKEW_SECONDS = 300;
/** Shared secrets shorter than this are refused: HS256 is only as strong as its key. */
export const MIN_HS_SECRET_LENGTH = 32;
const MAX_HS_SECRETS = 8;
const MAX_KID_LENGTH = 64;
/** Key ids of real identity providers can be long (a base64 thumbprint is 43 characters); the token's header gets more room than a configured secret's. */
const MAX_HEADER_KID_LENGTH = 256;
const KID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_PEM_LENGTH = 16 * 1024;
const MAX_URL_LENGTH = 2048;
const MAX_AUDIENCES = 8;
const MAX_AUDIENCE_LENGTH = 512;
/** The longest `maxTokenAgeSeconds` that can be configured: a day. */
export const MAX_TOKEN_AGE_SECONDS = 24 * 60 * 60;

/** A key set bigger than this is not a key set. */
export const MAX_JWKS_BYTES = 256 * 1024;
const JWKS_CACHE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5 * 1000;
const MAX_JWKS_ENTRIES = 200;
const MAX_PEM_ENTRIES = 200;

/** Single-use tokens remembered at once; beyond it the oldest entries make room. */
export const REPLAY_CACHE_MAX = 100_000;
const REPLAY_SWEEP_INTERVAL_MS = 1_000;

// ── configuration check ──────────────────────────────────────────────────

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function isLoopbackOrInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  return /^[0-9.]+$|:/.test(host) && isPrivateIpAddress(host);
}

/** Whether `url` is an address a key set may be fetched from: https, or plain http inside the network. */
export function isAcceptableJwksUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return true;
  // A key set read over plain http from the open internet can be replaced on the way: only addresses inside the network may use it.
  return parsed.protocol === 'http:' && isLoopbackOrInternalHost(parsed.hostname);
}

/**
 * What is wrong with a trust configuration, in plain words (empty = usable).
 *
 * Every verification runs the checks that are about one value at a time (a usable issuer, audience, algorithm list, key
 * texts, bounds). The save path of a configuration passes `requireKeyMatch`, which also checks that the key material and the
 * pinned algorithms belong together: a pinned algorithm without a key, and a key no pinned algorithm uses, are mistakes worth
 * stopping where an administrator can still fix them. At verification time they are harmless - a token of an algorithm that
 * has no key is `untrusted_key`, and a key is only ever used for the algorithm family it belongs to - so a verifier shared
 * with other callers does not refuse every token over them.
 */
export function validateIdentityAssertionTrust(trust: unknown, options: { requireKeyMatch?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (!trust || typeof trust !== 'object' || Array.isArray(trust)) return ['The trust configuration must be an object'];
  const t = trust as Partial<IdentityAssertionTrust>;

  if (typeof t.issuer !== 'string' || t.issuer.trim() === '' || t.issuer !== t.issuer.trim()) {
    problems.push('The issuer must be a non-empty string without surrounding spaces');
  } else if (t.issuer.length > MAX_ISSUER_LENGTH) {
    problems.push(`The issuer must be at most ${MAX_ISSUER_LENGTH} characters`);
  }

  const audiences = Array.isArray(t.audience) ? t.audience : [t.audience];
  if (audiences.length === 0 || audiences.length > MAX_AUDIENCES
    || audiences.some((a) => typeof a !== 'string' || a.trim() === '' || a.length > MAX_AUDIENCE_LENGTH)) {
    problems.push(`The audience must be one non-empty string or a list of at most ${MAX_AUDIENCES}`);
  }

  if (!Array.isArray(t.algorithms) || t.algorithms.length === 0) {
    problems.push('At least one algorithm must be pinned');
  } else if (t.algorithms.some((a) => !(ASSERTION_ALGORITHMS as readonly unknown[]).includes(a))) {
    problems.push(`Algorithms must be among ${ASSERTION_ALGORITHMS.join(', ')}`);
  }
  const algorithms = Array.isArray(t.algorithms) ? t.algorithms : [];

  const keys = t.keys;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
    problems.push('The key material is missing');
  } else {
    const wantsSecret = algorithms.includes('HS256');
    const wantsPublic = algorithms.includes('RS256') || algorithms.includes('ES256');

    if (keys.hsSecrets !== undefined) {
      const secrets = keys.hsSecrets;
      if (!Array.isArray(secrets) || secrets.length > MAX_HS_SECRETS) {
        problems.push(`Shared secrets must be a list of at most ${MAX_HS_SECRETS}`);
      } else {
        const seen = new Set<string>();
        for (const entry of secrets) {
          if (!entry || typeof entry !== 'object' || typeof entry.kid !== 'string' || !KID_PATTERN.test(entry.kid) || entry.kid.length > MAX_KID_LENGTH) {
            problems.push('Every shared secret needs a key id of letters, digits and . _ : - (at most 64 characters)');
          } else if (seen.has(entry.kid)) {
            problems.push(`The key id "${entry.kid}" is used twice`);
          } else {
            seen.add(entry.kid);
          }
          if (!entry || typeof entry.secret !== 'string' || entry.secret.length < MIN_HS_SECRET_LENGTH) {
            problems.push(`A shared secret must be at least ${MIN_HS_SECRET_LENGTH} characters`);
          }
        }
      }
    }
    if (keys.pem !== undefined) {
      if (typeof keys.pem !== 'string' || keys.pem.length === 0 || keys.pem.length > MAX_PEM_LENGTH) {
        problems.push('The public key must be a PEM text');
      } else if (/PRIVATE KEY/.test(keys.pem)) {
        problems.push('That is a private key. Provide the PUBLIC key (or certificate) of the issuer');
      } else if (!/-----BEGIN (PUBLIC KEY|CERTIFICATE)-----/.test(keys.pem)) {
        problems.push('The public key must be a PEM "PUBLIC KEY" or "CERTIFICATE"');
      }
    }
    if (keys.jwksUrl !== undefined && !isAcceptableJwksUrl(keys.jwksUrl)) {
      problems.push('The key set address must be an https URL (plain http only inside your network)');
    }

    if (options.requireKeyMatch) {
      const hasSecrets = Array.isArray(keys.hsSecrets) && keys.hsSecrets.length > 0;
      const hasPublic = typeof keys.pem === 'string' || typeof keys.jwksUrl === 'string';
      if (wantsSecret && !hasSecrets) problems.push('HS256 is pinned but no shared secret is configured');
      if (wantsPublic && !hasPublic) problems.push('RS256 / ES256 is pinned but no public key or key set is configured');
      if (algorithms.length > 0 && !wantsSecret && hasSecrets) problems.push('A shared secret is configured but HS256 is not pinned');
      if (algorithms.length > 0 && !wantsPublic && hasPublic) problems.push('A public key is configured but neither RS256 nor ES256 is pinned');
    }
  }

  if (t.maxTokenAgeSeconds !== undefined
    && (typeof t.maxTokenAgeSeconds !== 'number' || !Number.isInteger(t.maxTokenAgeSeconds)
      || t.maxTokenAgeSeconds < 1 || t.maxTokenAgeSeconds > MAX_TOKEN_AGE_SECONDS)) {
    problems.push(`The maximum token age must be a whole number of seconds between 1 and ${MAX_TOKEN_AGE_SECONDS}`);
  }
  if (t.clockSkewSeconds !== undefined
    && (typeof t.clockSkewSeconds !== 'number' || !Number.isInteger(t.clockSkewSeconds)
      || t.clockSkewSeconds < 0 || t.clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS)) {
    problems.push(`The clock skew must be a whole number of seconds between 0 and ${MAX_CLOCK_SKEW_SECONDS}`);
  }
  if (t.requireSingleUse !== undefined && typeof t.requireSingleUse !== 'boolean') {
    problems.push('requireSingleUse must be true or false');
  }
  return problems;
}

// ── key material ─────────────────────────────────────────────────────────

/** A failure to obtain a key (not a verdict on the token): the token cannot be checked, so it is not trusted. */
class KeyResolutionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'KeyResolutionError';
  }
}

const untrusted = (message: string) => new IdentityAssertionError('untrusted_key', message);
const invalid = (message: string) => new IdentityAssertionError('invalid_assertion', message);

type VerificationKey = CryptoKey | KeyObject | Uint8Array;

/** Imported static public keys, by algorithm and PEM text (parsing costs more than a lookup). */
const pemKeys = new Map<string, VerificationKey>();

async function importStaticKey(pem: string, alg: AssertionAlgorithm): Promise<VerificationKey> {
  const cacheKey = `${alg}\n${pem}`;
  const hit = pemKeys.get(cacheKey);
  if (hit) return hit;
  let key: VerificationKey;
  try {
    key = /-----BEGIN CERTIFICATE-----/.test(pem) ? await importX509(pem, alg) : await importSPKI(pem, alg);
  } catch (error) {
    // Wrong key type for the algorithm (an RSA key for ES256, ...), malformed text.
    throw new KeyResolutionError('The configured public key cannot verify this algorithm', error);
  }
  if (pemKeys.size >= MAX_PEM_ENTRIES) {
    const oldest = pemKeys.keys().next().value as string | undefined;
    if (oldest !== undefined) pemKeys.delete(oldest);
  }
  pemKeys.set(cacheKey, key);
  return key;
}

interface RemoteKeySet {
  getKey: JWTVerifyGetKey;
}

/** After a key set could not be fetched or read, it is not asked again for this long (an endpoint that is down is not hammered by bad tokens). */
const JWKS_FAILURE_COOLDOWN_MS = 10 * 1000;

const remoteKeySets = new Map<string, RemoteKeySet>();

/**
 * `safeFetch` for a key set: the SSRF guard applies, the answer must be small. A
 * response over the limit is cut off while it streams (a lying Content-Length is not
 * trusted either).
 */
const guardedKeySetFetch: FetchImplementation = async (url, options) => {
  const response = await safeFetch(url, { method: 'GET', headers: options.headers, signal: options.signal }, { timeoutMs: JWKS_TIMEOUT_MS });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JWKS_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The key set is larger than the limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Response(null, { status: response.status, headers: response.headers });
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JWKS_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('The key set is larger than the limit');
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
};

function remoteKeySetFor(url: string): RemoteKeySet {
  const existing = remoteKeySets.get(url);
  if (existing) {
    // Most recently used last, so the bound below drops the coldest one.
    remoteKeySets.delete(url);
    remoteKeySets.set(url, existing);
    return existing;
  }
  const resolver = createRemoteJWKSet(new URL(url), {
    cacheMaxAge: JWKS_CACHE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
    headers: { accept: 'application/json' },
    [customFetch]: guardedKeySetFetch,
  });
  let failedAt = 0;
  const created: RemoteKeySet = {
    getKey: async (header, token) => {
      if (failedAt && Date.now() - failedAt < JWKS_FAILURE_COOLDOWN_MS) {
        throw new KeyResolutionError('The configured key set is temporarily unavailable');
      }
      try {
        return await resolver(header, token);
      } catch (error) {
        // "No key with that kid" is an answer; anything else (timeout, refused address, not JSON, too large) means the set could not be read.
        if (!(error instanceof joseErrors.JWKSNoMatchingKey) && !(error instanceof joseErrors.JWKSMultipleMatchingKeys)) failedAt = Date.now();
        // "No key with that kid", "the key set could not be fetched / parsed": the token cannot be checked.
        throw new KeyResolutionError('No key of the configured key set could verify this token', error);
      }
    },
  };
  if (remoteKeySets.size >= MAX_JWKS_ENTRIES) {
    const oldest = remoteKeySets.keys().next().value as string | undefined;
    if (oldest !== undefined) remoteKeySets.delete(oldest);
  }
  remoteKeySets.set(url, created);
  return created;
}

// ── replay cache ─────────────────────────────────────────────────────────

/** `issuer \0 jti` -> the time (ms) until which the token would still be acceptable. */
const seenTokens = new Map<string, number>();
let replayCacheLimit = REPLAY_CACHE_MAX;
let lastReplaySweep = 0;
let lastReplayWarning = 0;

/** Room for one more entry: drop what has expired (a scan, at most once a second), and when still full the oldest entries. */
function makeRoomForToken(nowMs: number): void {
  if (nowMs - lastReplaySweep >= REPLAY_SWEEP_INTERVAL_MS) {
    lastReplaySweep = nowMs;
    for (const [key, until] of seenTokens) {
      if (until <= nowMs) seenTokens.delete(key);
    }
  }
  // Still full of tokens that are all valid: the oldest entries expire first (they were issued first), so they go.
  while (seenTokens.size >= replayCacheLimit) {
    const oldest = seenTokens.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    seenTokens.delete(oldest);
    if (nowMs - lastReplayWarning >= 60_000) {
      lastReplayWarning = nowMs;
      logger.warn('The single-use token cache is full; the oldest entries were dropped', { limit: REPLAY_CACHE_MAX });
    }
  }
}

function consumeToken(issuer: string, jti: string, untilMs: number, nowMs: number): void {
  const key = `${issuer}\u0000${jti}`;
  const until = seenTokens.get(key);
  if (until !== undefined && until > nowMs) {
    throw new IdentityAssertionError('replayed', 'This assertion was already used');
  }
  makeRoomForToken(nowMs);
  // delete first so a re-inserted key moves to the end (insertion order = age)
  seenTokens.delete(key);
  seenTokens.set(key, untilMs);
}

/** Forget every cached key, key set and single-use token (tests). */
export function resetIdentityAssertionCachesForTests(): void {
  pemKeys.clear();
  remoteKeySets.clear();
  seenTokens.clear();
  lastReplaySweep = 0;
  lastReplayWarning = 0;
  replayCacheLimit = REPLAY_CACHE_MAX;
}

/** Lower the single-use cache bound so a test can fill it (tests). */
export function setReplayCacheLimitForTests(limit: number): void {
  replayCacheLimit = Math.max(1, Math.floor(limit));
}

/** How many single-use tokens are remembered right now (tests). */
export function replayCacheSizeForTests(): number {
  return seenTokens.size;
}

// ── verification ─────────────────────────────────────────────────────────

function mapVerificationError(error: unknown): IdentityAssertionError {
  if (error instanceof IdentityAssertionError) return error;
  if (error instanceof KeyResolutionError) {
    logger.debug('Identity assertion key could not be resolved', { reason: error.message, cause: describe(error.cause) });
    return untrusted(error.message);
  }
  if (error instanceof joseErrors.JWTExpired) return new IdentityAssertionError('expired', 'The assertion has expired');
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return invalid(`The assertion's "${error.claim}" claim is not acceptable (${error.reason})`);
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return invalid('The assertion signature does not match');
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return invalid('The assertion algorithm is not allowed');
  if (error instanceof joseErrors.JWKSNoMatchingKey || error instanceof joseErrors.JWKSMultipleMatchingKeys
    || error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return untrusted('No key of the configured key set could verify this token');
  }
  if (error instanceof joseErrors.JOSEError) return invalid('The assertion is not a valid signed token');
  if (error instanceof TypeError) {
    // jose refuses a key that does not fit the algorithm (a weak RSA key, the wrong key type).
    logger.debug('Identity assertion key rejected', { reason: describe(error) });
    return untrusted('The configured key cannot be used to verify this token');
  }
  logger.warn('Unexpected error while verifying an identity assertion', { reason: describe(error) });
  return invalid('The assertion could not be verified');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : String(error).slice(0, 300);
}

/** Errors that mean "this key did not verify it" (try the next configured key), not "the token is wrong". */
function isKeyMiss(error: unknown): boolean {
  return error instanceof KeyResolutionError
    || error instanceof joseErrors.JWSSignatureVerificationFailed
    || error instanceof joseErrors.JWKSNoMatchingKey
    || error instanceof joseErrors.JWKSMultipleMatchingKeys
    || error instanceof joseErrors.JWKSTimeout
    || error instanceof joseErrors.JWKSInvalid
    || error instanceof TypeError;
}

type VerifyOptionsForRun = Parameters<typeof jwtVerify>[2];

async function verifySignedClaims(
  token: string,
  header: ReturnType<typeof decodeProtectedHeader>,
  trust: IdentityAssertionTrust,
  alg: AssertionAlgorithm,
  options: VerifyOptionsForRun,
): Promise<JWTPayload> {
  if (alg === 'HS256') {
    const secrets = trust.keys.hsSecrets ?? [];
    if (secrets.length === 0) throw untrusted('No shared secret is configured for HS256');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    // Rotation: the token names its secret. Without a kid only a single configured secret is unambiguous.
    const entry = kid !== undefined
      ? secrets.find((candidate) => candidate.kid === kid)
      : secrets.length === 1 ? secrets[0] : undefined;
    if (!entry) throw untrusted(kid === undefined ? 'The token has no key id and several secrets are configured' : 'The token names a key id that is not configured');
    return (await jwtVerify(token, new TextEncoder().encode(entry.secret), options)).payload;
  }

  // RS256 / ES256: the configured public key first, then the key set. A signature that no key accepts is the token's fault only
  // when a key was actually tried; claim failures come after a valid signature and end the search.
  const attempts: Array<() => Promise<JWTPayload>> = [];
  if (trust.keys.pem) {
    const pem = trust.keys.pem;
    attempts.push(async () => (await jwtVerify(token, await importStaticKey(pem, alg), options)).payload);
  }
  if (trust.keys.jwksUrl) {
    const url = trust.keys.jwksUrl;
    attempts.push(async () => (await jwtVerify(token, remoteKeySetFor(url).getKey, options)).payload);
  }
  if (attempts.length === 0) throw untrusted(`No public key is configured for ${alg}`);

  let firstMiss: unknown;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      if (!isKeyMiss(error)) throw error;
      firstMiss ??= error;
    }
  }
  throw firstMiss;
}

const nonEmptyString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;

function readProfile(payload: JWTPayload): Pick<VerifiedIdentityAssertion, 'email' | 'emailVerified' | 'name' | 'groups' | 'ctx'> {
  const out: Pick<VerifiedIdentityAssertion, 'email' | 'emailVerified' | 'name' | 'groups' | 'ctx'> = {};

  if (payload.email !== undefined && payload.email !== null && payload.email !== '') {
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) throw invalid('The assertion carries an email that is not an address');
    out.email = email;
    if (payload.email_verified === true) out.emailVerified = true;
    else if (payload.email_verified === false) out.emailVerified = false;
  }
  if (typeof payload.name === 'string' && payload.name.trim()) out.name = payload.name.trim().slice(0, MAX_NAME_LENGTH);
  if (Array.isArray(payload.groups)) {
    const groups = [...new Set((payload.groups as unknown[]).filter((g): g is string => nonEmptyString(g, MAX_GROUP_LENGTH)))].slice(0, MAX_GROUPS);
    out.groups = groups;
  }
  if (payload.ctx !== undefined) {
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(payload.ctx) ?? '', 'utf8');
    } catch {
      throw invalid('The assertion context cannot be read');
    }
    if (size > MAX_CTX_BYTES) throw invalid(`The assertion context is larger than ${MAX_CTX_BYTES} bytes`);
    out.ctx = payload.ctx;
  }
  return out;
}

/**
 * Verify an identity assertion against a trust configuration. See the module comment for
 * what is checked; throws {@link IdentityAssertionError}, never anything else.
 */
export async function verifyIdentityAssertion(input: {
  token: string;
  trust: IdentityAssertionTrust;
}): Promise<VerifiedIdentityAssertion> {
  const { token, trust } = input;

  const problems = validateIdentityAssertionTrust(trust);
  if (problems.length > 0) throw untrusted(`The trust configuration cannot be used: ${problems[0]}`);

  if (typeof token !== 'string' || token.length === 0) throw invalid('No assertion was presented');
  if (token.length > MAX_ASSERTION_LENGTH) throw invalid('The assertion is too large');
  if (token.split('.').length !== 3) throw invalid('The assertion is not a signed token');

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw invalid('The assertion is not a signed token');
  }
  const alg = header.alg;
  // `none` is refused whatever is pinned (and in whatever case it is spelled); otherwise the algorithm must be one the administrator pinned.
  if (typeof alg !== 'string' || alg.toLowerCase() === 'none' || !(trust.algorithms as readonly string[]).includes(alg)) {
    throw invalid('The assertion algorithm is not allowed');
  }

  if (header.kid !== undefined && (typeof header.kid !== 'string' || header.kid.length > MAX_HEADER_KID_LENGTH)) {
    throw invalid('The assertion key id is not usable');
  }

  const skew = trust.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  const audience = Array.isArray(trust.audience) ? trust.audience : [trust.audience];

  let payload: JWTPayload;
  try {
    payload = await verifySignedClaims(token, header, trust, alg as AssertionAlgorithm, {
      // Only the algorithm the token declared AND the administrator pinned: the key family is chosen from it above.
      algorithms: [alg],
      issuer: trust.issuer,
      audience,
      clockTolerance: skew,
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
    });
  } catch (error) {
    throw mapVerificationError(error);
  }

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw invalid('The assertion has no usable issue or expiry time');
  }
  if (issuedAt > nowSec + skew) throw invalid('The assertion was issued in the future');
  if (trust.maxTokenAgeSeconds !== undefined) {
    if (expiresAt - issuedAt > trust.maxTokenAgeSeconds) throw invalid('The assertion is valid for longer than allowed');
    if (nowSec - issuedAt - skew > trust.maxTokenAgeSeconds) throw new IdentityAssertionError('expired', 'The assertion is older than allowed');
  }

  const subject = payload.sub;
  if (typeof subject !== 'string' || subject.trim() === '' || subject.length > MAX_SUBJECT_LENGTH) {
    throw invalid('The assertion has no usable subject');
  }

  const profile = readProfile(payload);

  // Last, so only an assertion that is acceptable in every other way is remembered as used.
  if (trust.requireSingleUse) {
    const jti = payload.jti;
    if (typeof jti !== 'string' || jti === '' || jti.length > MAX_JTI_LENGTH) throw invalid('The assertion has no usable id');
    consumeToken(trust.issuer, jti, (expiresAt + skew) * 1000, nowMs);
  }

  return {
    issuer: trust.issuer,
    subject,
    ...profile,
    claims: { ...payload },
  };
}
