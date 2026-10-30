/**
 * Knowledge Engine access control: the rules both database providers share.
 *
 * `sqlite/rag-access.mixin.ts` and `mongodb/rag-access.mixin.ts` each turn the
 * same inputs into their own queries. What an input MEANS - how an e-mail is
 * folded, which attribute names are legal, how long a page may be, what a
 * duplicate permission entry is - is decided once, here, so the two backends
 * cannot drift (db-parity.test.ts holds them to it).
 */

import type { IRagIdentityUser } from './types.domain';

/**
 * `attr:<name>` lookups put the name into a JSON path (SQLite) or a field path
 * (MongoDB), so it is limited to this alphabet; anything else matches nothing.
 */
export const RAG_IDENTITY_ATTR_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** `listRagIdentityUsers`: page size when none is given, and the most one page may hold. */
export const RAG_IDENTITY_PAGE_DEFAULT = 50;
export const RAG_IDENTITY_PAGE_MAX = 200;

/** The distinct, non-empty strings of `values`, first seen first. */
export function distinctNonEmptyStrings(values: readonly unknown[] | undefined | null): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * How an identity value (e-mail, user principal name, attribute value) is
 * compared: trimmed and lower-cased. `undefined` when nothing is left, so an
 * empty value is stored as absent rather than as a string that matches blanks.
 */
export function foldIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const folded = value.trim().toLowerCase();
  return folded.length > 0 ? folded : undefined;
}

/** A directory user as it is stored: identity values folded, junk dropped. */
export interface NormalizedRagIdentityUser {
  tenantId: string;
  extId: string;
  email?: string;
  upn?: string;
  name?: string;
  type?: 'member' | 'guest';
  groups?: string[];
  attrs?: Record<string, string>;
  syncRunId?: string;
  syncedAt: Date;
}

function normalizeAttrs(attrs: unknown): Record<string, string> | undefined {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    // A name outside the lookup alphabet can never be asked for, and a `$`-led
    // or empty one is not a field name MongoDB accepts.
    if (!RAG_IDENTITY_ATTR_NAME.test(name)) continue;
    const folded = foldIdentityValue(value);
    if (folded !== undefined) out[name] = folded;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The stored form of a directory user, or null when it has no `extId` (nothing
 * to key it by). `email`, `upn` and attribute values are lower-cased.
 */
export function normalizeRagIdentityUser(
  user: Omit<IRagIdentityUser, '_id' | 'domain'>,
  now: Date,
): NormalizedRagIdentityUser | null {
  if (typeof user.extId !== 'string' || user.extId.length === 0) return null;
  return {
    tenantId: user.tenantId,
    extId: user.extId,
    email: foldIdentityValue(user.email),
    upn: foldIdentityValue(user.upn),
    name: typeof user.name === 'string' && user.name.length > 0 ? user.name : undefined,
    type: user.type === 'member' || user.type === 'guest' ? user.type : undefined,
    groups: Array.isArray(user.groups) ? distinctNonEmptyStrings(user.groups) : undefined,
    attrs: normalizeAttrs(user.attrs),
    syncRunId: typeof user.syncRunId === 'string' && user.syncRunId.length > 0 ? user.syncRunId : undefined,
    syncedAt: user.syncedAt instanceof Date ? user.syncedAt : now,
  };
}

/**
 * A batch of directory users ready to write: normalized, users without an
 * `extId` dropped, and one row per `extId` (the last one given wins) so both
 * backends write the same rows and report the same count.
 */
export function prepareRagIdentityUsers(
  users: ReadonlyArray<Omit<IRagIdentityUser, '_id' | 'domain'>>,
  now: Date,
): NormalizedRagIdentityUser[] {
  const byExtId = new Map<string, NormalizedRagIdentityUser>();
  for (const user of users) {
    const normalized = normalizeRagIdentityUser(user, now);
    if (!normalized) continue;
    // Delete first so the Map keeps the position of the LAST occurrence.
    byExtId.delete(normalized.extId);
    byExtId.set(normalized.extId, normalized);
  }
  return [...byExtId.values()];
}

/** What `findRagIdentityUsers` compares, once the field and values are checked. */
export type RagIdentityLookup =
  | { kind: 'extId' | 'email' | 'upn'; values: string[] }
  | { kind: 'attr'; name: string; values: string[] };

/**
 * The lookup behind `findRagIdentityUsers(domain, field, values)`: `extId` is
 * compared as given, every other field lower-cased. Null when nothing can match
 * (no values, an unknown field, an `attr:` name outside the allowed alphabet).
 */
export function resolveRagIdentityLookup(
  field: string,
  values: readonly string[] | undefined,
): RagIdentityLookup | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (field === 'extId') {
    const wanted = distinctNonEmptyStrings(values);
    return wanted.length > 0 ? { kind: 'extId', values: wanted } : null;
  }
  const folded = [...new Set(values.map(foldIdentityValue).filter((v): v is string => v !== undefined))];
  if (folded.length === 0) return null;
  if (field === 'email' || field === 'upn') return { kind: field, values: folded };
  if (field.startsWith('attr:')) {
    const name = field.slice('attr:'.length);
    if (!RAG_IDENTITY_ATTR_NAME.test(name)) return null;
    return { kind: 'attr', name, values: folded };
  }
  return null;
}

/** `listRagIdentityUsers` paging: default 50, at most 200, `limit: 0` = only the total. */
export function clampRagIdentityPage(options?: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const rawLimit = options?.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 0), RAG_IDENTITY_PAGE_MAX)
      : RAG_IDENTITY_PAGE_DEFAULT;
  const rawOffset = options?.offset;
  const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;
  return { limit, offset };
}

/**
 * The literal prefix `deleteRagAclEntriesByPrincipalPrefix` removes by (and
 * `countRagAclNodes` / `listRagAclPrincipalLabels` read entries by), or null
 * when nothing may match: an empty prefix would match every entry, and a
 * principal never holds a control character, so a prefix with one matches none
 * (and a NUL cannot be put into a MongoDB regular expression).
 */
export function ragAclPrincipalPrefix(prefix: unknown): string | null {
  if (typeof prefix !== 'string' || prefix.length === 0) return null;
  return /[\u0000-\u001f\u007f]/.test(prefix) ? null : prefix;
}

/** `listRagAclPrincipalLabels`: rows when no limit is given, and the most one call may return. */
export const RAG_ACL_LABELS_LIMIT_DEFAULT = 5000;
export const RAG_ACL_LABELS_LIMIT_MAX = 20000;

/** The row limit of `listRagAclPrincipalLabels`: 5000 by default, at most 20000, and 0 (or less) asks for nothing. */
export function clampRagAclLabelsLimit(options?: { limit?: number }): number {
  const raw = options?.limit;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return RAG_ACL_LABELS_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(raw), 0), RAG_ACL_LABELS_LIMIT_MAX);
}

/** Permission entries of one node with each principal once (the first wins) and blank principals dropped. */
export function dedupeAclEntries<T extends { principal: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const entry of entries) {
    if (typeof entry.principal !== 'string' || entry.principal.length === 0 || seen.has(entry.principal)) continue;
    seen.add(entry.principal);
    out.push(entry);
  }
  return out;
}
