/**
 * `IUser.externalIds`: the identities an account has at issuers the workspace trusts (issuer -> subject).
 *
 * One shape on both providers, one place that decides what is a usable map:
 *   - SQLite keeps it as JSON in the account's identity document of the lazily created `iam_identities` collection (the users
 *     table has no column for it; see `sqlite/userIdentity.ts`);
 *   - MongoDB keeps it as a sub-document whose field names are the issuers - which are URLs, full of dots, and a dotted
 *     query path cannot address a field whose name has a dot. Names are therefore percent-encoded for storage
 *     (`encodeIssuerKey`) and decoded when a document is read back, so nothing outside the provider ever sees an
 *     encoded name.
 *
 * There is no index (deliberately: no migration, no new index): a lookup scans the workspace's accounts. The map is kept
 * small for the same reason, and the lookups callers make are cached by them.
 */

export const MAX_EXTERNAL_IDS_PER_USER = 16;
export const MAX_EXTERNAL_ISSUER_LENGTH = 512;
export const MAX_EXTERNAL_SUBJECT_LENGTH = 512;

/** A map with only usable entries (non-empty strings within bounds, at most {@link MAX_EXTERNAL_IDS_PER_USER}); undefined when nothing is left. */
export function normalizeExternalIds(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [issuer, subject] of Object.entries(input as Record<string, unknown>)) {
    if (typeof subject !== 'string' || subject === '' || subject.length > MAX_EXTERNAL_SUBJECT_LENGTH) continue;
    if (issuer === '' || issuer.length > MAX_EXTERNAL_ISSUER_LENGTH) continue;
    if (count >= MAX_EXTERNAL_IDS_PER_USER) break;
    out[issuer] = subject;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/** Both an issuer and a subject must be non-empty strings of a sane size to be looked up or linked. */
export function isUsableIdentity(issuer: unknown, subject: unknown): issuer is string {
  return typeof issuer === 'string' && issuer !== '' && issuer.length <= MAX_EXTERNAL_ISSUER_LENGTH
    && typeof subject === 'string' && subject !== '' && subject.length <= MAX_EXTERNAL_SUBJECT_LENGTH;
}

// ── MongoDB field names ───────────────────────────────────────────────────

/** A field name for an issuer: `%`, `.`, `$` and NUL percent-encoded, so the name can sit in a dotted path (`externalIds.<name>`). */
export function encodeIssuerKey(issuer: string): string {
  return issuer.replace(/[%.$\0]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function decodeIssuerKey(key: string): string {
  return key.replace(/%(25|2E|24|00)/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The map as MongoDB stores it (encoded field names); undefined when empty. */
export function encodeExternalIds(map: unknown): Record<string, string> | undefined {
  const normalized = normalizeExternalIds(map);
  if (!normalized) return undefined;
  return Object.fromEntries(Object.entries(normalized).map(([issuer, subject]) => [encodeIssuerKey(issuer), subject]));
}

/** The map as the application sees it (decoded field names); undefined when empty or not a map. */
export function decodeExternalIds(stored: unknown): Record<string, string> | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, subject] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof subject === 'string') out[decodeIssuerKey(key)] = subject;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A stored user document with its `externalIds` decoded (the field is dropped when it holds nothing usable). */
export function decodeUserDocExternalIds<T extends object>(doc: T): T {
  const stored = (doc as { externalIds?: unknown }).externalIds;
  if (stored === undefined) return doc;
  const { externalIds: _stored, ...rest } = doc as T & { externalIds?: unknown };
  void _stored;
  const decoded = decodeExternalIds(stored);
  return (decoded ? { ...rest, externalIds: decoded } : rest) as T;
}

/** The dotted path of one issuer's entry in a MongoDB user document. */
export function externalIdPath(issuer: string): string {
  return `externalIds.${encodeIssuerKey(issuer)}`;
}
