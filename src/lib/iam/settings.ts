/**
 * Tenant IAM settings (D2): the workspace-wide rules that are not policies.
 *
 *   tokens.maxLifetimeDays   no API token may live longer than this many days
 *                            (counted from its creation); null = no maximum
 *   tokens.requireExpiry     every API token must carry an expiry date
 *
 * Where it lives: one small document in the policy engine's own lazily-created
 * `iam_meta` collection/table (id `settings`) in the tenant database, identical on
 * MongoDB and SQLite. Nothing
 * to migrate: a tenant that never saved settings reads the defaults
 * (`null` / `false`), existing tokens are never touched, and a read of a
 * missing collection runs no DDL.
 *
 * The token code (create / extend expiry / list badges) shares the pure helper
 * `checkTokenExpiry` so the API validation, the `exceedsTenantPolicy` flag and
 * this module's own tests can never disagree on what "obeys the policy" means.
 */

import { runWithTenantScope } from '@/lib/database';

const META = 'iam_meta' as const;
const SETTINGS_DOC_ID = 'settings';
const CACHE_TTL_MS = 10_000;
const MAX_CACHED_TENANTS = 2_000;

/** A workspace cannot ask for more than ten years. */
export const MAX_TOKEN_LIFETIME_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IamTokenSettings {
  /** Maximum lifetime of a token in days, counted from its creation. `null` = unlimited. */
  maxLifetimeDays: number | null;
  /** Tokens must carry an expiry date. */
  requireExpiry: boolean;
}

export interface IamSettings {
  tokens: IamTokenSettings;
}

export interface IamSettingsPatch {
  tokens?: Partial<IamTokenSettings>;
}

export const DEFAULT_IAM_SETTINGS: Readonly<IamSettings> = Object.freeze({
  tokens: Object.freeze({ maxLifetimeDays: null, requireExpiry: false }),
}) as IamSettings;

export class IamSettingsError extends Error {
  readonly code = 'validation' as const;
  readonly details: Array<{ message: string; field?: string }>;
  constructor(details: Array<{ message: string; field?: string }>) {
    super(details.map((d) => d.message).join('; '));
    this.name = 'IamSettingsError';
    this.details = details;
  }
}

const clone = (s: IamSettings): IamSettings => ({ tokens: { ...s.tokens } });

function sanitize(data: unknown): IamSettings {
  const out = clone(DEFAULT_IAM_SETTINGS);
  if (!data || typeof data !== 'object') return out;
  const tokens = (data as { tokens?: unknown }).tokens;
  if (tokens && typeof tokens === 'object') {
    const t = tokens as Record<string, unknown>;
    if (typeof t.maxLifetimeDays === 'number' && Number.isInteger(t.maxLifetimeDays)
      && t.maxLifetimeDays >= 1 && t.maxLifetimeDays <= MAX_TOKEN_LIFETIME_DAYS) {
      out.tokens.maxLifetimeDays = t.maxLifetimeDays;
    }
    if (t.requireExpiry === true) out.tokens.requireExpiry = true;
  }
  return out;
}

/** Validate a settings patch from the API. Returns the normalised patch or throws `IamSettingsError`. */
export function parseIamSettingsPatch(input: unknown): IamSettingsPatch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new IamSettingsError([{ message: 'The request body must be an object' }]);
  }
  const body = input as Record<string, unknown>;
  const issues: Array<{ message: string; field?: string }> = [];
  const patch: IamSettingsPatch = {};

  for (const key of Object.keys(body)) {
    if (key !== 'tokens') issues.push({ message: `Unknown setting "${key}"`, field: key });
  }
  if (body.tokens !== undefined) {
    const tokens = body.tokens;
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
      issues.push({ message: 'tokens must be an object', field: 'tokens' });
    } else {
      const t = tokens as Record<string, unknown>;
      const next: Partial<IamTokenSettings> = {};
      for (const key of Object.keys(t)) {
        if (key !== 'maxLifetimeDays' && key !== 'requireExpiry') {
          issues.push({ message: `Unknown setting "tokens.${key}"`, field: `tokens.${key}` });
        }
      }
      if ('maxLifetimeDays' in t) {
        const v = t.maxLifetimeDays;
        if (v === null) next.maxLifetimeDays = null;
        else if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_TOKEN_LIFETIME_DAYS) {
          next.maxLifetimeDays = v;
        } else {
          issues.push({
            message: `tokens.maxLifetimeDays must be null or a whole number of days between 1 and ${MAX_TOKEN_LIFETIME_DAYS}`,
            field: 'tokens.maxLifetimeDays',
          });
        }
      }
      if ('requireExpiry' in t) {
        if (typeof t.requireExpiry === 'boolean') next.requireExpiry = t.requireExpiry;
        else issues.push({ message: 'tokens.requireExpiry must be true or false', field: 'tokens.requireExpiry' });
      }
      patch.tokens = next;
    }
  }
  if (issues.length > 0) throw new IamSettingsError(issues);
  return patch;
}

// ── cache ────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: IamSettings;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function remember(tenantDbName: string, value: IamSettings): void {
  if (!cache.has(tenantDbName) && cache.size >= MAX_CACHED_TENANTS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(tenantDbName, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function resetIamSettingsCacheForTests(): void {
  cache.clear();
}

// ── read / write ─────────────────────────────────────────────────────────

/**
 * The tenant's settings (defaults when never saved). A change made on another
 * node is picked up within CACHE_TTL_MS; a change made on this node is visible
 * immediately. Returns a copy: callers may mutate it freely.
 */
export async function getIamSettings(tenantDbName: string): Promise<IamSettings> {
  const hit = cache.get(tenantDbName);
  if (hit && hit.expiresAt > Date.now()) return clone(hit.value);
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(META, SETTINGS_DOC_ID));
  const value = sanitize(doc?.data);
  remember(tenantDbName, value);
  return clone(value);
}

export interface IamSettingsRecord extends IamSettings {
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Like getIamSettings, plus who saved them and when (never cached). */
export async function getIamSettingsRecord(tenantDbName: string): Promise<IamSettingsRecord> {
  const doc = await runWithTenantScope(tenantDbName, (db) => db.iamDocGet(META, SETTINGS_DOC_ID));
  const value = sanitize(doc?.data);
  remember(tenantDbName, value);
  return {
    ...clone(value),
    updatedAt: typeof doc?.data?.updatedAt === 'string' ? doc.data.updatedAt : null,
    updatedBy: typeof doc?.data?.updatedBy === 'string' ? doc.data.updatedBy : null,
  };
}

/**
 * Merge a validated patch into the stored settings. Only the keys present in
 * the patch change. Returns the new settings.
 */
export async function updateIamSettings(
  tenantDbName: string,
  patch: IamSettingsPatch,
  actor: string,
): Promise<IamSettings> {
  const validated = parseIamSettingsPatch(patch);
  const next = await runWithTenantScope(tenantDbName, async (db) => {
    const doc = await db.iamDocGet(META, SETTINGS_DOC_ID);
    const current = sanitize(doc?.data);
    const merged: IamSettings = {
      tokens: { ...current.tokens, ...(validated.tokens ?? {}) },
    };
    await db.iamDocPut(META, SETTINGS_DOC_ID, {
      ...merged,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    });
    return merged;
  });
  remember(tenantDbName, next);
  return clone(next);
}

// ── token expiry policy ──────────────────────────────────────────────────

export type TokenExpiryViolation = 'expiry_required' | 'exceeds_max_lifetime';

export type TokenExpiryCheck =
  | { ok: true }
  | {
      ok: false;
      code: TokenExpiryViolation;
      /** The latest allowed expiry for a token created at `createdAt` (null when there is no maximum). */
      maxExpiresAt: Date | null;
    };

/**
 * Does a token with this expiry obey the workspace policy?
 *
 *  - no expiry is only acceptable when neither `requireExpiry` nor a maximum is set
 *    (a maximum lifetime implies an expiry);
 *  - with a maximum, `expiresAt` may not be later than `createdAt + maxLifetimeDays`.
 *
 * `createdAt` is the token's creation time (use "now" when creating one), so
 * extending an expiry can never push a token beyond its original ceiling.
 */
export function checkTokenExpiry(
  settings: Pick<IamSettings, 'tokens'>,
  input: { expiresAt: Date | string | null | undefined; createdAt: Date | string },
): TokenExpiryCheck {
  const { maxLifetimeDays, requireExpiry } = settings.tokens;
  const created = input.createdAt instanceof Date ? input.createdAt : new Date(input.createdAt);
  const maxExpiresAt = maxLifetimeDays !== null && !Number.isNaN(created.getTime())
    ? new Date(created.getTime() + maxLifetimeDays * DAY_MS)
    : null;

  const expiresRaw = input.expiresAt;
  const expires = expiresRaw == null || expiresRaw === '' ? null : (expiresRaw instanceof Date ? expiresRaw : new Date(expiresRaw));
  if (expires === null || Number.isNaN(expires.getTime())) {
    return requireExpiry || maxLifetimeDays !== null
      ? { ok: false, code: 'expiry_required', maxExpiresAt }
      : { ok: true };
  }
  if (maxExpiresAt && expires.getTime() > maxExpiresAt.getTime()) {
    return { ok: false, code: 'exceeds_max_lifetime', maxExpiresAt };
  }
  return { ok: true };
}
