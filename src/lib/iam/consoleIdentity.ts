/**
 * Console identity: a short-lived token Console signs for the person behind a call, so an MCP
 * server or a connected agent can tell who it is working for. Console never hands on a
 * credential somebody else issued (an SSO token, a caller's header): it states, in its own
 * name, who the call is for. `identityAssertion.ts` is the inbound half (Console verifies what
 * other issuers sign); this module is the outbound half (Console is the issuer).
 *
 * Keys. One RS256 key pair per workspace, created on first use and kept in the tenant's
 * `iam_meta` collection (document `console_identity_keys`), the private half encrypted with the
 * provider-encryption secret (`encryptObject`). MongoDB and SQLite behave the same; nothing to
 * migrate. The first creation is serialised across nodes with an atomic counter
 * (`iamDocIncrement`): the caller that draws 1 generates the key, the others wait for it. Should
 * that caller die before writing, a waiter creates the key after `KEYGEN_WAIT_MS`.
 *
 * Issuer. `${APP_URL}/api/public/identity/<tenantId>`. Its public keys are served without
 * authentication at `<issuer>/.well-known/jwks.json`, next to a discovery document at
 * `<issuer>/.well-known/openid-configuration` (what API gateways read). The URL comes from the
 * configured APP_URL, never from request headers, so a caller cannot change it.
 *
 * Token. An access token in the RFC 9068 shape (`typ: at+jwt`), valid five minutes, minted for
 * ONE destination: `aud` is the URL the request is about to go to (query, fragment and
 * credentials stripped), never a separately configured value. A token given to one server is
 * therefore useless against any other that checks its audience.
 *
 *   iss, aud, sub (the Console user id), iat, nbf, exp, jti
 *   client_id   always `cognipeer-console`
 *   tenant_id   the workspace; project_id when the call belongs to a project
 *   email, name the person's profile, when set
 *   idp, idp_sub the SSO subject, for an OIDC / SAML account (LDAP DNs are not sent)
 *   src         the channel: portal, messaging, api, mcp, a2a, playground, realtime, trigger, console
 *   via         how Console knew the person: session, api_token, delegated, trigger
 *   act         `{ sub: "agent:<key>" }` when an agent makes the call (RFC 8693 actor)
 *
 * Who gets one. Only a real, active person of this workspace. There is no token for a call with
 * nobody behind it (public A2A, synthetic actors such as `system:*`), for an account that is not
 * found or belongs to another workspace, or for a disabled account. The callers turn the refusal
 * (`ConsoleIdentityError`) into a failed call, so an upstream set up for Console identity never
 * receives a request without one.
 *
 * What the caller (`ConsoleIdentityCaller`) says is always what the SERVER knows: it is built from
 * the stamped runtime context (`runtimeContext.ts`), never from anything a client sent.
 */

import { randomUUID } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase, runWithTenantScope, type IUser } from '@/lib/database';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

const logger = createLogger('iam:console-identity');

/** The upstream auth type (MCP servers, connected agents) that asks for a Console identity token. */
export const CONSOLE_IDENTITY_AUTH_TYPE = 'console_identity' as const;
export const CONSOLE_IDENTITY_ALG = 'RS256' as const;
export const CONSOLE_IDENTITY_TTL_SECONDS = 300;
export const CONSOLE_IDENTITY_CLIENT_ID = 'cognipeer-console';

const META = 'iam_meta' as const;
const KEYS_DOC_ID = 'console_identity_keys';
const KEYGEN_DOC_ID = 'console_identity_keygen';
const KEYGEN_WAIT_MS = 5_000;
const KEYGEN_POLL_MS = 150;
const KEY_CACHE_TTL_MS = 60_000;
const EMPTY_KEYS_CACHE_TTL_MS = 5_000;
const PERSON_CACHE_TTL_MS = 15_000;
const TENANT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_ENTRIES = 2_000;

export type ConsoleIdentitySource =
  | 'portal' | 'messaging' | 'api' | 'mcp' | 'a2a' | 'playground' | 'realtime' | 'trigger' | 'console';

export type ConsoleIdentityVia = 'session' | 'api_token' | 'delegated' | 'trigger';

/**
 * Who a call is for, as the server knows it. Plain data (it travels in the cross-node MCP job):
 * no token, no secret. Build it with `consoleIdentityCallerOf` or by hand from a session.
 */
export interface ConsoleIdentityCaller {
  /** The Console user the token is about. */
  userId?: string;
  /** The API token that carried the call, when one did. */
  tokenId?: string;
  /** A trusted issuer vouched for `userId` on an application's token (client-API delegation). */
  delegated?: boolean;
  /** The channel the call came through. */
  source?: ConsoleIdentitySource;
  /** The agent making the call, when an agent makes it. */
  agentKey?: string;
  /** The project the call belongs to. */
  projectId?: string;
}

export type ConsoleIdentityErrorCode =
  | 'no_person'
  | 'unknown_person'
  | 'person_disabled'
  | 'bad_audience'
  | 'unknown_workspace'
  | 'unavailable';

/** Every refusal opens with this, so a routed call (which carries back only the text) is recognised too. */
export const CONSOLE_IDENTITY_ERROR_PREFIX = 'Console identity: ';

const ERROR_MESSAGES: Record<ConsoleIdentityErrorCode, string> = {
  no_person: 'this server receives the identity of the person behind each call, and this call is not made for a signed-in person.',
  unknown_person: 'this server receives the identity of the person behind each call, and the person this call is made for is not an account of this workspace.',
  person_disabled: 'this server receives the identity of the person behind each call, and the account this call is made for is disabled.',
  bad_audience: 'the server URL must be an absolute http(s) URL.',
  unknown_workspace: 'the workspace of this call could not be found.',
  unavailable: 'Console could not prepare the token for this call. Try again shortly.',
};

/** Why no token was minted. The message is safe to show to the person and to log. */
export class ConsoleIdentityError extends Error {
  readonly code: ConsoleIdentityErrorCode;
  constructor(code: ConsoleIdentityErrorCode) {
    super(`${CONSOLE_IDENTITY_ERROR_PREFIX}${ERROR_MESSAGES[code]}`);
    this.name = 'ConsoleIdentityError';
    this.code = code;
  }
}

export function isConsoleIdentityError(error: unknown): error is ConsoleIdentityError {
  return error instanceof ConsoleIdentityError;
}

/** A refusal, also when it arrives as plain text from another node. */
export function isConsoleIdentityRefusal(error: unknown): boolean {
  if (isConsoleIdentityError(error)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.startsWith(CONSOLE_IDENTITY_ERROR_PREFIX);
}

// ── issuer URLs ──────────────────────────────────────────────────────────

function appUrl(): string {
  return getConfig().app.url.replace(/\/+$/, '');
}

/** The `iss` of every token of this workspace. */
export function consoleIdentityIssuer(tenantId: string): string {
  return `${appUrl()}/api/public/identity/${encodeURIComponent(tenantId)}`;
}

export function consoleIdentityJwksUri(tenantId: string): string {
  return `${consoleIdentityIssuer(tenantId)}/.well-known/jwks.json`;
}

export function consoleIdentityDiscoveryUri(tenantId: string): string {
  return `${consoleIdentityIssuer(tenantId)}/.well-known/openid-configuration`;
}

/** What an administrator hands to the team that runs the upstream. */
export function consoleIdentityIssuerInfo(tenantId: string): {
  issuer: string;
  jwksUri: string;
  discoveryUri: string;
  algorithm: typeof CONSOLE_IDENTITY_ALG;
  lifetimeSeconds: number;
} {
  return {
    issuer: consoleIdentityIssuer(tenantId),
    jwksUri: consoleIdentityJwksUri(tenantId),
    discoveryUri: consoleIdentityDiscoveryUri(tenantId),
    algorithm: CONSOLE_IDENTITY_ALG,
    lifetimeSeconds: CONSOLE_IDENTITY_TTL_SECONDS,
  };
}

/**
 * The discovery document. Console issues these tokens to itself only (there is no authorization
 * or token endpoint): the document exists so verifiers and API gateways can find the keys.
 */
export function consoleIdentityDiscovery(tenantId: string): Record<string, unknown> {
  const issuer = consoleIdentityIssuer(tenantId);
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [CONSOLE_IDENTITY_ALG],
    token_endpoint_auth_signing_alg_values_supported: [CONSOLE_IDENTITY_ALG],
    claims_supported: [
      'iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti', 'client_id', 'tenant_id', 'project_id',
      'email', 'name', 'idp', 'idp_sub', 'src', 'via', 'act',
    ],
  };
}

/**
 * The audience of a token sent to `url`: the URL itself without query, fragment or user info, and
 * without a trailing slash. The destination decides the audience; nothing else can.
 */
export function consoleIdentityAudience(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    throw new ConsoleIdentityError('bad_audience');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConsoleIdentityError('bad_audience');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.username = '';
  parsed.password = '';
  return parsed.toString().replace(/\/+$/, '');
}

// ── who the call is for ──────────────────────────────────────────────────

const SOURCES = new Set<ConsoleIdentitySource>([
  'portal', 'messaging', 'api', 'mcp', 'a2a', 'playground', 'realtime', 'trigger', 'console',
]);

/**
 * The caller of a run, from its server-stamped runtime context. A trigger run has no `userId` of
 * its own; it acts for the trigger's accountable person (who last saved it), passed as
 * `accountableUserId`.
 */
export function consoleIdentityCallerOf(
  runtimeContext: AgentRuntimeContext | undefined,
  extra: { agentKey?: string; projectId?: string; accountableUserId?: string } = {},
): ConsoleIdentityCaller {
  const trigger = runtimeContext?.source === 'trigger';
  const userId = runtimeContext?.userId || (trigger ? extra.accountableUserId : undefined);
  const source = runtimeContext?.source && SOURCES.has(runtimeContext.source as ConsoleIdentitySource)
    ? (runtimeContext.source as ConsoleIdentitySource)
    : undefined;
  return {
    ...(userId ? { userId } : {}),
    ...(runtimeContext?.tokenId ? { tokenId: runtimeContext.tokenId } : {}),
    ...(runtimeContext?.via?.kind === 'delegated' ? { delegated: true } : {}),
    ...(source ? { source } : {}),
    ...(extra.agentKey ? { agentKey: extra.agentKey } : {}),
    ...(extra.projectId ? { projectId: extra.projectId } : {}),
  };
}

/** The person part of a caller: what a paused turn stores so its continuation calls for the same person. */
export type ConsoleIdentityPerson = Pick<ConsoleIdentityCaller, 'userId' | 'tokenId' | 'delegated' | 'source'>;

/** The person part of a caller (or of a stored one, read back from a paused turn); undefined when there is none. */
export function consoleIdentityPersonOf(value: unknown): ConsoleIdentityPerson | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const caller = value as Record<string, unknown>;
  const person: ConsoleIdentityPerson = {
    ...(typeof caller.userId === 'string' && caller.userId ? { userId: caller.userId } : {}),
    ...(typeof caller.tokenId === 'string' && caller.tokenId ? { tokenId: caller.tokenId } : {}),
    ...(caller.delegated === true ? { delegated: true } : {}),
    ...(typeof caller.source === 'string' && SOURCES.has(caller.source as ConsoleIdentitySource)
      ? { source: caller.source as ConsoleIdentitySource }
      : {}),
  };
  return Object.keys(person).length > 0 ? person : undefined;
}

/**
 * Who a continued pause is for: the person stored with the pause, else (a pause stored before it recorded
 * one) whoever started the turn. Never the person answering it: the answering request's caller is not read.
 */
export function consoleIdentityOfPausedTurn(input: {
  stored: unknown;
  startedBy?: string;
  source?: AgentRuntimeContext['source'];
  accountableUserId?: string;
}): ConsoleIdentityPerson {
  return consoleIdentityPersonOf(input.stored)
    ?? consoleIdentityPersonOf(consoleIdentityCallerOf(
      { ...(input.source ? { source: input.source } : {}), ...(input.startedBy ? { userId: input.startedBy } : {}) },
      input.accountableUserId ? { accountableUserId: input.accountableUserId } : {},
    ))
    ?? {};
}

/** A real person's id, not one of the synthetic actors written where a user id goes. */
function isPersonId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const value = id.trim();
  if (!value || value.length > 128) return false;
  if (value.startsWith('system:') || value.startsWith('agent:') || value === 'a2a-public') return false;
  return true;
}

function viaOf(caller: ConsoleIdentityCaller): ConsoleIdentityVia {
  if (caller.delegated) return 'delegated';
  if (caller.source === 'trigger') return 'trigger';
  if (caller.tokenId) return 'api_token';
  return 'session';
}

// ── small bounded caches ─────────────────────────────────────────────────

interface Cached<T> {
  value: T;
  expiresAt: number;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, ttlMs: number): void {
  if (cache.size >= MAX_CACHED_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function recall<T>(cache: Map<string, Cached<T>>, key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt > Date.now()) return hit.value;
  cache.delete(key);
  return undefined;
}

const tenantCache = new Map<string, Cached<string>>();
const personCache = new Map<string, Cached<IUser | null>>();
const signingCache = new Map<string, Cached<Promise<SigningMaterial>>>();
const jwksCache = new Map<string, Cached<StoredKey[]>>();

/** EXPORTED FOR TESTS: forget every cached key, person and workspace. */
export function resetConsoleIdentityCachesForTests(): void {
  tenantCache.clear();
  personCache.clear();
  signingCache.clear();
  jwksCache.clear();
}

/** The database of workspace `tenantId`. Throws `ConsoleIdentityError('unknown_workspace')`. */
export async function consoleIdentityTenantDbName(tenantId: string): Promise<string> {
  const hit = recall(tenantCache, tenantId);
  if (hit) return hit;
  const db = await getDatabase();
  const tenant = await db.findTenantById(tenantId).catch(() => null);
  if (!tenant?.dbName) throw new ConsoleIdentityError('unknown_workspace');
  remember(tenantCache, tenantId, tenant.dbName, TENANT_CACHE_TTL_MS);
  return tenant.dbName;
}

async function loadPerson(tenantDbName: string, tenantId: string, userId: string): Promise<IUser> {
  const key = `${tenantDbName}\u0000${userId}`;
  let user = recall(personCache, key);
  if (user === undefined) {
    // A failed lookup is not an answer: it is not cached, and it does not read as a missing account.
    user = await runWithTenantScope(tenantDbName, (db) => db.findUserById(userId)).catch((error: unknown) => {
      logger.warn('Console identity could not look up the person of a call', { tenantDbName, error });
      throw new ConsoleIdentityError('unavailable');
    });
    remember(personCache, key, user ?? null, PERSON_CACHE_TTL_MS);
  }
  if (!user || String(user.tenantId) !== String(tenantId)) throw new ConsoleIdentityError('unknown_person');
  if (user.status === 'disabled') throw new ConsoleIdentityError('person_disabled');
  return user;
}

// ── keys ─────────────────────────────────────────────────────────────────

interface StoredKey {
  kid: string;
  alg: typeof CONSOLE_IDENTITY_ALG;
  /** The public half, as published (kty, n, e, kid, alg, use). */
  publicJwk: JWK;
  /** The private JWK, encrypted with `encryptObject`. */
  privateJwkSealed: string;
  createdAt: string;
}

interface SigningMaterial {
  kid: string;
  key: CryptoKey | Uint8Array;
}

const PUBLIC_JWK_FIELDS = ['kty', 'n', 'e', 'kid', 'alg', 'use'] as const;

function publicPartOf(jwk: JWK): JWK {
  const out: JWK = {};
  for (const field of PUBLIC_JWK_FIELDS) {
    const value = (jwk as Record<string, unknown>)[field];
    if (typeof value === 'string' && value) (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/** The keys of a stored document, newest first; anything malformed is skipped. */
function parseKeys(data: unknown): StoredKey[] {
  const raw = (data as { keys?: unknown } | null | undefined)?.keys;
  if (!Array.isArray(raw)) return [];
  const keys: StoredKey[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const k = entry as Record<string, unknown>;
    if (typeof k.kid !== 'string' || !k.kid) continue;
    if (k.alg !== CONSOLE_IDENTITY_ALG) continue;
    if (!k.publicJwk || typeof k.publicJwk !== 'object') continue;
    if (typeof k.privateJwkSealed !== 'string' || !k.privateJwkSealed) continue;
    const publicJwk = publicPartOf(k.publicJwk as JWK);
    if (publicJwk.kty !== 'RSA' || !publicJwk.n || !publicJwk.e) continue;
    keys.push({
      kid: k.kid,
      alg: CONSOLE_IDENTITY_ALG,
      publicJwk: { ...publicJwk, kid: k.kid, alg: CONSOLE_IDENTITY_ALG, use: 'sig' },
      privateJwkSealed: k.privateJwkSealed,
      createdAt: typeof k.createdAt === 'string' ? k.createdAt : '',
    });
  }
  return keys;
}

async function readKeys(tenantDbName: string): Promise<StoredKey[]> {
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(META, KEYS_DOC_ID));
  return parseKeys(doc?.data);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function generateKey(): Promise<StoredKey> {
  const { publicKey, privateKey } = await generateKeyPair(CONSOLE_IDENTITY_ALG, { modulusLength: 2048, extractable: true });
  const publicJwk = publicPartOf(await exportJWK(publicKey));
  const kid = await calculateJwkThumbprint(publicJwk);
  const privateJwk = await exportJWK(privateKey);
  return {
    kid,
    alg: CONSOLE_IDENTITY_ALG,
    publicJwk: { ...publicJwk, kid, alg: CONSOLE_IDENTITY_ALG, use: 'sig' },
    privateJwkSealed: encryptObject(privateJwk),
    createdAt: new Date().toISOString(),
  };
}

/** Create the workspace's first key, once across nodes (see the header). Returns the stored keys. */
async function createFirstKey(tenantDbName: string): Promise<StoredKey[]> {
  const ticket = await runWithTenantScope(tenantDbName, (db) => db.iamDocIncrement(META, KEYGEN_DOC_ID, 'n', 1));
  if (ticket !== 1) {
    const deadline = Date.now() + KEYGEN_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(KEYGEN_POLL_MS);
      const keys = await readKeys(tenantDbName);
      if (keys.length > 0) return keys;
    }
    logger.warn('Console identity key was not written by the node that claimed it; creating it here', { tenantDbName });
  }
  const key = await generateKey();
  await runWithTenantScope(tenantDbName, async (db) => {
    const existing = parseKeys((await db.iamDocGet(META, KEYS_DOC_ID))?.data);
    if (existing.length > 0) return;
    await db.iamDocPut(META, KEYS_DOC_ID, { keys: [key], updatedAt: new Date().toISOString() });
  });
  // Converge on what is stored: another writer may have finished first.
  const stored = await readKeys(tenantDbName);
  return stored.length > 0 ? stored : [key];
}

async function loadSigningMaterial(tenantDbName: string): Promise<SigningMaterial> {
  let keys = await readKeys(tenantDbName);
  if (keys.length === 0) keys = await createFirstKey(tenantDbName);
  const active = keys[0]!;
  const privateJwk = decryptObject<JWK>(active.privateJwkSealed);
  const key = await importJWK({ ...privateJwk, alg: CONSOLE_IDENTITY_ALG }, CONSOLE_IDENTITY_ALG);
  remember(jwksCache, tenantDbName, keys, KEY_CACHE_TTL_MS);
  return { kid: active.kid, key };
}

async function signingMaterialOf(tenantDbName: string): Promise<SigningMaterial> {
  const hit = recall(signingCache, tenantDbName);
  if (hit) return hit;
  // The promise is cached, so concurrent calls on this node share one load (and one creation).
  const pending = loadSigningMaterial(tenantDbName).catch((error: unknown) => {
    signingCache.delete(tenantDbName);
    if (isConsoleIdentityError(error)) throw error;
    logger.error('Console identity signing key unavailable', { tenantDbName, error });
    throw new ConsoleIdentityError('unavailable');
  });
  remember(signingCache, tenantDbName, pending, KEY_CACHE_TTL_MS);
  return pending;
}

/**
 * Make sure the workspace has a signing key, so its key set is published before the first call
 * (called when an administrator turns Console identity on, or reads the issuer details).
 */
export async function ensureConsoleIdentityKey(tenantDbName: string): Promise<void> {
  await signingMaterialOf(tenantDbName);
}

/** The workspace's public key set. Never creates a key: an unused workspace publishes none. */
export async function getConsoleIdentityJwks(tenantDbName: string): Promise<{ keys: JWK[] }> {
  let keys = recall(jwksCache, tenantDbName);
  if (!keys) {
    keys = await readKeys(tenantDbName);
    // An empty set is remembered briefly: the key may be created on another node any moment.
    remember(jwksCache, tenantDbName, keys, keys.length > 0 ? KEY_CACHE_TTL_MS : EMPTY_KEYS_CACHE_TTL_MS);
  }
  return { keys: keys.map((k) => ({ ...k.publicJwk })) };
}

// ── minting ──────────────────────────────────────────────────────────────

export interface MintConsoleIdentityInput {
  tenantId: string;
  /** Saves a lookup when the caller has it; resolved from `tenantId` otherwise. */
  tenantDbName?: string;
  /** The URL the request goes to. */
  audience: string;
  caller: ConsoleIdentityCaller | undefined;
}

/** What may be recorded about a minted token: no token, no profile data. */
export interface ConsoleIdentitySummary {
  type: typeof CONSOLE_IDENTITY_AUTH_TYPE;
  sub: string;
  via: ConsoleIdentityVia;
  src: ConsoleIdentitySource;
  act?: string;
  jti: string;
}

export interface MintedConsoleIdentity {
  token: string;
  expiresAt: Date;
  summary: ConsoleIdentitySummary;
}

function idpClaimsOf(user: IUser): Record<string, string> {
  if ((user.authProvider === 'oidc' || user.authProvider === 'saml') && typeof user.externalId === 'string' && user.externalId) {
    return { idp: user.authProvider, idp_sub: user.externalId };
  }
  return {};
}

/** Sign a token for `input.caller`, for the destination `input.audience`. Throws `ConsoleIdentityError`. */
export async function mintConsoleIdentity(input: MintConsoleIdentityInput): Promise<MintedConsoleIdentity> {
  const caller = input.caller;
  if (!caller || !isPersonId(caller.userId)) throw new ConsoleIdentityError('no_person');
  const userId = caller.userId.trim();
  const audience = consoleIdentityAudience(input.audience);
  const tenantDbName = input.tenantDbName || await consoleIdentityTenantDbName(input.tenantId);
  const person = await loadPerson(tenantDbName, input.tenantId, userId);
  const signing = await signingMaterialOf(tenantDbName);

  const now = Math.floor(Date.now() / 1000);
  const expires = now + CONSOLE_IDENTITY_TTL_SECONDS;
  const jti = randomUUID();
  const via = viaOf(caller);
  const src: ConsoleIdentitySource = caller.source ?? 'console';
  const act = caller.agentKey ? `agent:${caller.agentKey}` : undefined;

  const token = await new SignJWT({
    client_id: CONSOLE_IDENTITY_CLIENT_ID,
    tenant_id: input.tenantId,
    ...(caller.projectId ? { project_id: caller.projectId } : {}),
    ...(person.email ? { email: person.email } : {}),
    ...(person.name ? { name: person.name } : {}),
    ...idpClaimsOf(person),
    src,
    via,
    ...(act ? { act: { sub: act } } : {}),
  })
    .setProtectedHeader({ alg: CONSOLE_IDENTITY_ALG, kid: signing.kid, typ: 'at+jwt' })
    .setIssuer(consoleIdentityIssuer(input.tenantId))
    .setAudience(audience)
    .setSubject(userId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(expires)
    .setJti(jti)
    .sign(signing.key);

  return {
    token,
    expiresAt: new Date(expires * 1000),
    summary: { type: CONSOLE_IDENTITY_AUTH_TYPE, sub: userId, via, src, ...(act ? { act } : {}), jti },
  };
}

/**
 * The header a request to `audience` carries for `caller`, plus what may be logged about it.
 * Callers put the header LAST, after static auth and caller-supplied runtime headers, so nothing
 * a caller sends can replace it.
 */
export async function consoleIdentityHeaders(input: MintConsoleIdentityInput): Promise<{
  headers: { Authorization: string };
  token: string;
  summary: ConsoleIdentitySummary;
}> {
  const minted = await mintConsoleIdentity(input);
  return { headers: { Authorization: `Bearer ${minted.token}` }, token: minted.token, summary: minted.summary };
}

/** Replace a minted token wherever it appears in a message (an upstream may echo its request back). */
export function scrubConsoleIdentityToken(text: string, token: string | undefined): string {
  if (!token || !text) return text;
  return text.split(token).join('[redacted]');
}

/** A JSON value with the minted token masked in every string it holds. */
export function scrubConsoleIdentityValue<T>(value: T, token: string | undefined): T {
  if (!token || value === undefined || value === null) return value;
  if (typeof value === 'string') return scrubConsoleIdentityToken(value, token) as T;
  const text = JSON.stringify(value);
  // A token is base64url and dots: it never needs escaping, so it appears verbatim in the JSON text.
  return typeof text === 'string' && text.includes(token)
    ? JSON.parse(scrubConsoleIdentityToken(text, token)) as T
    : value;
}

/**
 * The error with the minted token masked in its message and its stack. The stack is written when the
 * error is created and keeps the original text, so masking the message alone is not enough.
 */
export function scrubConsoleIdentityError(error: unknown, token: string | undefined): unknown {
  if (!token || !(error instanceof Error)) return error;
  const message = scrubConsoleIdentityToken(error.message, token);
  const stack = typeof error.stack === 'string' ? scrubConsoleIdentityToken(error.stack, token) : undefined;
  if (message === error.message && (stack === undefined || stack === error.stack)) return error;
  try {
    error.message = message;
    if (stack !== undefined) error.stack = stack;
    return error;
  } catch {
    // A frozen error cannot be edited: hand back a copy that carries the safe text.
    const copy = new Error(message);
    copy.name = error.name;
    return copy;
  }
}

/**
 * Streamed text with the minted token masked. A token can arrive split across chunks, so a tail that
 * could still grow into the token is held back until the next chunk (or `flush`) settles it; any
 * other text passes straight through.
 */
export function consoleIdentityChunkMasker(token: string, emit: (text: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let pending = '';
  const heldTail = (text: string): number => {
    for (let n = Math.min(text.length, token.length - 1); n > 0; n -= 1) {
      const at = text.length - n;
      if (text.charCodeAt(at) === token.charCodeAt(0) && token.startsWith(text.slice(at))) return n;
    }
    return 0;
  };
  return {
    push(text) {
      pending = scrubConsoleIdentityToken(pending + text, token);
      const hold = heldTail(pending);
      const ready = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      if (ready) emit(ready);
    },
    flush() {
      const rest = pending;
      pending = '';
      if (rest) emit(rest);
    },
  };
}
