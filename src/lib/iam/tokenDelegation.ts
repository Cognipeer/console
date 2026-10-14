/**
 * Acting for a user through an API token ("delegation"): the configuration an administrator gives an application's
 * token so that it may send a signed statement about the person a call is FOR (header `X-Cognipeer-User-Token`).
 *
 *   trust            who may vouch (issuer, audience), how (the pinned algorithm and its key material), how fresh
 *   mapping          who the vouched-for person is here (match by identity and/or verified address, what to do when
 *                    nobody matches, how groups follow the assertion) - see delegatedIdentity.ts
 *   allowPrivileged  whether an owner-level or administrator account may act through the token. The owner never may.
 *
 * Where it lives: one small document per token in the policy engine's lazily-created `iam_delegations` collection/table
 * of the tenant database, keyed by the token id (identical on MongoDB and SQLite; nothing to migrate, and a read of a
 * workspace that never configured one runs no DDL). Shared secrets never leave the server in the clear: they are sealed at
 * rest (AES-256-GCM, the same key material as provider credentials) and the screens only ever see their key ids.
 *
 * Who may change it is decided by the route (owner and admin, never upward); this module only validates and stores.
 * The request gate reads it on every call that carries the header, through a 10 second per-process cache that a local
 * write drops at once (other nodes converge within the TTL, like every other IAM setting).
 */

import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import {
  ASSERTION_ALGORITHMS,
  validateIdentityAssertionTrust,
  type AssertionAlgorithm,
  type IdentityAssertionHsSecret,
  type IdentityAssertionTrust,
} from './identityAssertion';
import { validateDelegatedMapping, type DelegatedMapping } from './delegatedIdentity';

const logger = createLogger('iam:token-delegation');

const COLLECTION = 'iam_delegations' as const;
const CACHE_TTL_MS = 10_000;
const MAX_CACHED = 5_000;
const SCHEMA_VERSION = 1;

/** The trust of delegation: an assertion for a client API call is reused across calls, so it is never single-use. */
export type DelegationTrust = Omit<IdentityAssertionTrust, 'requireSingleUse'> & { requireSingleUse: false };

/** Everything the gate needs, secrets included. Never serialised into a response. */
export interface TokenDelegationConfig {
  enabled: boolean;
  trust: DelegationTrust;
  mapping: DelegatedMapping;
  allowPrivileged: boolean;
}

export interface StoredTokenDelegation {
  tokenId: string;
  config: TokenDelegationConfig;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

/** What a screen may see: the same, with the shared secrets reduced to their key ids. */
export interface TokenDelegationView {
  tokenId: string;
  enabled: boolean;
  trust: {
    issuer: string;
    audience: string | string[];
    algorithms: AssertionAlgorithm[];
    keys: { hsSecrets?: Array<{ kid: string }>; pem?: string; jwksUrl?: string };
    maxTokenAgeSeconds?: number;
    clockSkewSeconds?: number;
  };
  mapping: DelegatedMapping;
  allowPrivileged: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface DelegationProblem {
  field: string;
  message: string;
}

// ── input ────────────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = new Set(['enabled', 'trust', 'mapping', 'allowPrivileged']);
const TRUST_KEYS = new Set(['issuer', 'audience', 'algorithms', 'keys', 'maxTokenAgeSeconds', 'clockSkewSeconds', 'requireSingleUse']);
const KEY_KEYS = new Set(['hsSecrets', 'pem', 'jwksUrl']);
const MAPPING_KEYS = new Set(['matchBy', 'jit', 'groupMap']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, prefix: string): DelegationProblem[] {
  return Object.keys(value).filter((key) => !allowed.has(key)).map((key) => ({ field: `${prefix}${key}`, message: `Unknown setting "${prefix}${key}"` }));
}

export type DelegationInputResult =
  | { ok: true; config: TokenDelegationConfig }
  | { ok: false; problems: DelegationProblem[] };

/**
 * Turn a request body into a configuration. `existing` supplies the shared secrets a body leaves out (a key id without a
 * `secret` keeps the stored one), so a screen never has to hold a secret to change another setting.
 */
export function parseDelegationInput(body: unknown, existing: TokenDelegationConfig | null): DelegationInputResult {
  if (!isRecord(body)) return { ok: false, problems: [{ field: '', message: 'The request body must be an object' }] };
  const problems: DelegationProblem[] = [...unknownKeys(body, TOP_LEVEL_KEYS, '')];

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') problems.push({ field: 'enabled', message: 'enabled must be true or false' });
  if (body.allowPrivileged !== undefined && typeof body.allowPrivileged !== 'boolean') {
    problems.push({ field: 'allowPrivileged', message: 'allowPrivileged must be true or false' });
  }

  const trustIn = body.trust;
  const mappingIn = body.mapping;
  if (!isRecord(trustIn)) problems.push({ field: 'trust', message: 'trust must be an object' });
  if (!isRecord(mappingIn)) problems.push({ field: 'mapping', message: 'mapping must be an object' });
  if (problems.length > 0 || !isRecord(trustIn) || !isRecord(mappingIn)) return { ok: false, problems };

  problems.push(...unknownKeys(trustIn, TRUST_KEYS, 'trust.'), ...unknownKeys(mappingIn, MAPPING_KEYS, 'mapping.'));
  if (trustIn.requireSingleUse !== undefined && trustIn.requireSingleUse !== false) {
    problems.push({ field: 'trust.requireSingleUse', message: 'A user token is sent with many calls: it cannot be single-use here' });
  }
  const keysIn = isRecord(trustIn.keys) ? trustIn.keys : {};
  if (trustIn.keys !== undefined && !isRecord(trustIn.keys)) problems.push({ field: 'trust.keys', message: 'trust.keys must be an object' });
  problems.push(...unknownKeys(keysIn, KEY_KEYS, 'trust.keys.'));

  // shared secrets: a key id without a secret keeps the stored one
  let hsSecrets: IdentityAssertionHsSecret[] | undefined;
  if (keysIn.hsSecrets !== undefined) {
    if (!Array.isArray(keysIn.hsSecrets)) {
      problems.push({ field: 'trust.keys.hsSecrets', message: 'Shared secrets must be a list' });
    } else {
      const kept = new Map((existing?.trust.keys.hsSecrets ?? []).map((entry) => [entry.kid, entry.secret]));
      hsSecrets = [];
      for (const raw of keysIn.hsSecrets as unknown[]) {
        const entry = isRecord(raw) ? raw : {};
        const kid = typeof entry.kid === 'string' ? entry.kid : '';
        const secret = typeof entry.secret === 'string' && entry.secret !== '' ? entry.secret : kept.get(kid);
        if (secret === undefined) {
          problems.push({ field: 'trust.keys.hsSecrets', message: `The shared secret for key id "${kid}" must be provided` });
          continue;
        }
        hsSecrets.push({ kid, secret });
      }
    }
  }

  const trust: DelegationTrust = {
    issuer: trustIn.issuer as string,
    audience: trustIn.audience as string | string[],
    algorithms: trustIn.algorithms as AssertionAlgorithm[],
    keys: {
      ...(hsSecrets !== undefined ? { hsSecrets } : {}),
      ...(keysIn.pem !== undefined ? { pem: keysIn.pem as string } : {}),
      ...(keysIn.jwksUrl !== undefined ? { jwksUrl: keysIn.jwksUrl as string } : {}),
    },
    ...(trustIn.maxTokenAgeSeconds !== undefined ? { maxTokenAgeSeconds: trustIn.maxTokenAgeSeconds as number } : {}),
    ...(trustIn.clockSkewSeconds !== undefined ? { clockSkewSeconds: trustIn.clockSkewSeconds as number } : {}),
    requireSingleUse: false,
  };
  const mapping: DelegatedMapping = {
    matchBy: mappingIn.matchBy as DelegatedMapping['matchBy'],
    jit: mappingIn.jit as DelegatedMapping['jit'],
    ...(mappingIn.groupMap !== undefined ? { groupMap: mappingIn.groupMap as DelegatedMapping['groupMap'] } : {}),
  };

  for (const message of validateIdentityAssertionTrust(trust, { requireKeyMatch: true })) problems.push({ field: 'trust', message });
  for (const message of validateDelegatedMapping(mapping)) problems.push({ field: 'mapping', message });
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      enabled: body.enabled !== false,
      trust: {
        ...trust,
        issuer: trust.issuer.trim(),
        // keep the audience as sent (a string stays a string) but without padding
        audience: Array.isArray(trust.audience) ? trust.audience.map((a) => a.trim()) : trust.audience.trim(),
        algorithms: [...new Set(trust.algorithms)].filter((a) => (ASSERTION_ALGORITHMS as readonly string[]).includes(a)),
      },
      mapping,
      allowPrivileged: body.allowPrivileged === true,
    },
  };
}

// ── storage ──────────────────────────────────────────────────────────────

interface DelegationDoc extends Record<string, unknown> {
  v: number;
  tokenId: string;
  enabled: boolean;
  trust: Omit<DelegationTrust, 'keys'> & { keys: { pem?: string; jwksUrl?: string } };
  /** `[{kid, secret}]`, sealed. */
  hsSecretsSealed?: string;
  /** The key ids of the sealed secrets, readable without opening them. */
  hsKids?: string[];
  mapping: DelegatedMapping;
  allowPrivileged: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

function toDoc(stored: StoredTokenDelegation): DelegationDoc {
  const { hsSecrets, ...publicKeys } = stored.config.trust.keys;
  return {
    v: SCHEMA_VERSION,
    tokenId: stored.tokenId,
    enabled: stored.config.enabled,
    trust: { ...stored.config.trust, keys: publicKeys },
    ...(hsSecrets && hsSecrets.length > 0
      ? { hsSecretsSealed: encryptObject(hsSecrets), hsKids: hsSecrets.map((entry) => entry.kid) }
      : {}),
    mapping: stored.config.mapping,
    allowPrivileged: stored.config.allowPrivileged,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

function fromDoc(data: Record<string, unknown>): StoredTokenDelegation | null {
  const doc = data as Partial<DelegationDoc>;
  if (!doc || typeof doc.tokenId !== 'string' || !isRecord(doc.trust) || !isRecord(doc.mapping)) return null;
  let hsSecrets: IdentityAssertionHsSecret[] | undefined;
  if (typeof doc.hsSecretsSealed === 'string') {
    // A secret that cannot be opened (the encryption key changed) is an error, not an empty list: the gate must not decide on half a configuration.
    hsSecrets = decryptObject<IdentityAssertionHsSecret[]>(doc.hsSecretsSealed);
  }
  const trust = doc.trust as DelegationDoc['trust'];
  return {
    tokenId: doc.tokenId,
    createdAt: String(doc.createdAt ?? ''),
    updatedAt: String(doc.updatedAt ?? ''),
    updatedBy: String(doc.updatedBy ?? ''),
    config: {
      enabled: doc.enabled === true,
      trust: { ...trust, keys: { ...trust.keys, ...(hsSecrets ? { hsSecrets } : {}) }, requireSingleUse: false },
      mapping: doc.mapping as unknown as DelegatedMapping,
      allowPrivileged: doc.allowPrivileged === true,
    },
  };
}

const cache = new Map<string, { value: StoredTokenDelegation | null; expiresAt: number }>();
const cacheKey = (tenantDbName: string, tokenId: string): string => `${tenantDbName}\u0000${tokenId}`;

export function resetTokenDelegationCacheForTests(): void {
  cache.clear();
}

/** Drop what this process remembers about one token's delegation (a write here; other nodes converge within the TTL). */
export function invalidateTokenDelegation(tenantDbName: string, tokenId: string): void {
  cache.delete(cacheKey(tenantDbName, tokenId));
}

/**
 * The delegation of a token, secrets included, or null when it has none. Throws when the store cannot be read or a sealed
 * secret cannot be opened - the caller refuses the request (fail closed).
 */
export async function getTokenDelegation(tenantDbName: string, tokenId: string): Promise<StoredTokenDelegation | null> {
  const key = cacheKey(tenantDbName, tokenId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(COLLECTION, tokenId));
  const value = doc ? fromDoc(doc.data) : null;
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Store the delegation of a token (create or replace). */
export async function putTokenDelegation(
  tenantDbName: string,
  tokenId: string,
  config: TokenDelegationConfig,
  actorUserId: string,
): Promise<StoredTokenDelegation> {
  const now = new Date().toISOString();
  const previous = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(COLLECTION, tokenId));
  const createdAt = previous && typeof previous.data.createdAt === 'string' ? previous.data.createdAt : now;
  const stored: StoredTokenDelegation = { tokenId, config, createdAt, updatedAt: now, updatedBy: actorUserId };
  await runWithTenantScope(tenantDbName, (db) => db.iamDocPut(COLLECTION, tokenId, toDoc(stored)));
  invalidateTokenDelegation(tenantDbName, tokenId);
  return stored;
}

/** Remove the delegation of a token. True when there was one. */
export async function deleteTokenDelegation(tenantDbName: string, tokenId: string): Promise<boolean> {
  const deleted = await runWithTenantScope(tenantDbName, (db) => db.iamDocDelete(COLLECTION, tokenId));
  invalidateTokenDelegation(tenantDbName, tokenId);
  return deleted;
}

/** Best-effort cleanup for a token that was deleted: never throws, nothing depends on it (a dead document is never read). */
export async function dropTokenDelegation(tenantDbName: string, tokenId: string): Promise<void> {
  try {
    await deleteTokenDelegation(tenantDbName, tokenId);
  } catch (error) {
    logger.warn('Could not remove the delegation of a deleted token', { tokenId, error: error instanceof Error ? error.message : String(error) });
  }
}

// ── presentation ─────────────────────────────────────────────────────────

export function toDelegationView(stored: StoredTokenDelegation): TokenDelegationView {
  const { trust } = stored.config;
  const { hsSecrets, ...publicKeys } = trust.keys;
  return {
    tokenId: stored.tokenId,
    enabled: stored.config.enabled,
    trust: {
      issuer: trust.issuer,
      audience: trust.audience,
      algorithms: trust.algorithms,
      keys: { ...publicKeys, ...(hsSecrets && hsSecrets.length > 0 ? { hsSecrets: hsSecrets.map((entry) => ({ kid: entry.kid })) } : {}) },
      ...(trust.maxTokenAgeSeconds !== undefined ? { maxTokenAgeSeconds: trust.maxTokenAgeSeconds } : {}),
      ...(trust.clockSkewSeconds !== undefined ? { clockSkewSeconds: trust.clockSkewSeconds } : {}),
    },
    mapping: stored.config.mapping,
    allowPrivileged: stored.config.allowPrivileged,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  };
}

/** What an audit row keeps of a configuration: enough for a review, never a secret or a key. */
export function delegationAuditSnapshot(config: TokenDelegationConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  const { trust, mapping } = config;
  return {
    enabled: config.enabled,
    issuer: trust.issuer,
    audience: trust.audience,
    algorithms: trust.algorithms,
    keySources: [
      ...(trust.keys.hsSecrets?.length ? ['secret'] : []),
      ...(trust.keys.pem ? ['publicKey'] : []),
      ...(trust.keys.jwksUrl ? ['keySet'] : []),
    ],
    ...(trust.keys.jwksUrl ? { jwksUrl: trust.keys.jwksUrl } : {}),
    ...(trust.maxTokenAgeSeconds !== undefined ? { maxTokenAgeSeconds: trust.maxTokenAgeSeconds } : {}),
    matchBy: mapping.matchBy,
    jit: mapping.jit,
    groupMapEntries: mapping.groupMap?.length ?? 0,
    allowPrivileged: config.allowPrivileged,
  };
}
