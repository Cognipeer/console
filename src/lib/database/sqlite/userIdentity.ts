/**
 * Where the SQLite provider keeps `IUser.kind` and `IUser.externalIds`.
 *
 * The users table has no column for either: storage stays additive (no migration, no new column, no new index). Both
 * live in one small document per account in the lazily created `iam_identities` collection - id = the user id, data =
 * `{ kind?, externalIds? }` - the same tables the policy engine keeps its documents in (`iam-docs.mixin.ts`).
 *
 *   - Only an account that is of a kind or holds an external identity has a document. An ordinary member has none, so a
 *     workspace that never meets such an account never gets the table: reads run no DDL, the first WRITE creates it.
 *   - A read joins on the user id, so an account row arrives with its document in the same statement (`identityData`).
 *   - The document goes with the account: it is written and deleted in the transaction of the account's own write.
 *   - Finding an account by identity scans the documents (there is deliberately no index); callers cache what it finds.
 *
 * MongoDB keeps both fields on the user document itself (schemaless, no index): see `mongodb/user.mixin.ts`. What a caller
 * sees is the same on both providers.
 */

import type Database from 'better-sqlite3';
import type { IUser } from '../provider.interface';
import { normalizeExternalIds } from '../provider/externalIds';
import { TABLES } from './base';
import { ensureIamCollectionTable, iamCollectionTableExists } from './iam-docs.mixin';

export const IDENTITY_COLLECTION = 'iam_identities' as const;

/** What an account's identity document says. */
export interface IdentityFields {
  kind?: IUser['kind'];
  externalIds?: Record<string, string>;
}

/** An identity with neither a kind nor an external identity says nothing: it has no document. */
export function isIdentityEmpty(fields: IdentityFields): boolean {
  return fields.kind === undefined && (!fields.externalIds || Object.keys(fields.externalIds).length === 0);
}

/** The fields as they are stored: only what is set, `externalIds` normalized. */
function toStored(fields: IdentityFields): Record<string, unknown> {
  const externalIds = normalizeExternalIds(fields.externalIds);
  return {
    ...(fields.kind ? { kind: fields.kind } : {}),
    ...(externalIds ? { externalIds } : {}),
  };
}

function parseStored(raw: unknown): IdentityFields {
  if (typeof raw !== 'string' || raw === '') return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const stored = data as { kind?: unknown; externalIds?: unknown };
  const kind = stored.kind === 'external' || stored.kind === 'member' ? stored.kind : undefined;
  const externalIds = normalizeExternalIds(stored.externalIds);
  return { ...(kind ? { kind } : {}), ...(externalIds ? { externalIds } : {}) };
}

/** The identity of a user row selected with {@link IdentitySql.column} (nothing when the row carries no document). */
export function identityOfRow(row: { identityData?: unknown }): IdentityFields {
  return parseStored(row.identityData);
}

// ── reading ──────────────────────────────────────────────────────────────

/** SQL over the `users` table, shaped by whether the collection exists yet (a pristine workspace has no table to join). */
export interface IdentitySql {
  /** A select-list item, comma first: the account's identity document as `identityData`. */
  column: string;
  /** A condition: the account is a member (an account without a document is one). */
  member: string;
  /** A condition: the account is of kind `external`. */
  external: string;
}

export function identitySql(db: Database.Database): IdentitySql {
  if (!iamCollectionTableExists(db, IDENTITY_COLLECTION)) {
    return { column: ', NULL AS identityData', member: '1', external: '0' };
  }
  const own = `${IDENTITY_COLLECTION}.id = ${TABLES.users}.id`;
  const external = `EXISTS (SELECT 1 FROM ${IDENTITY_COLLECTION} WHERE ${own} AND json_extract(${IDENTITY_COLLECTION}.data, '$.kind') = 'external')`;
  return {
    column: `, (SELECT data FROM ${IDENTITY_COLLECTION} WHERE ${own}) AS identityData`,
    member: `NOT ${external}`,
    external,
  };
}

/** The identity document of one account, or null when it has none. Never creates anything. */
export function readIdentityDoc(db: Database.Database, userId: string): IdentityFields | null {
  if (!iamCollectionTableExists(db, IDENTITY_COLLECTION)) return null;
  const row = db.prepare(`SELECT data FROM ${IDENTITY_COLLECTION} WHERE id = ?`).get(userId) as { data?: string } | undefined;
  return row ? parseStored(row.data) : null;
}

// ── writing ──────────────────────────────────────────────────────────────

/**
 * Make sure the collection exists. Call it BEFORE opening the transaction that writes a document: a table created inside a
 * transaction that is rolled back would leave the "exists" memory of the handle wrong.
 */
export function ensureIdentityCollection(db: Database.Database): void {
  ensureIamCollectionTable(db, IDENTITY_COLLECTION);
}

/** Replace the account's document with `fields`, or delete it when nothing is left. The collection must exist when `fields` says something. */
export function writeIdentityDoc(db: Database.Database, userId: string, fields: IdentityFields, now: string): void {
  const stored = toStored(fields);
  if (Object.keys(stored).length === 0) {
    deleteIdentityDoc(db, userId);
    return;
  }
  db.prepare(
    `INSERT INTO ${IDENTITY_COLLECTION} (id, data, updatedAt) VALUES (@id, @data, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
  ).run({ id: userId, data: JSON.stringify(stored), updatedAt: now });
}

export function deleteIdentityDoc(db: Database.Database, userId: string): void {
  if (!iamCollectionTableExists(db, IDENTITY_COLLECTION)) return;
  db.prepare(`DELETE FROM ${IDENTITY_COLLECTION} WHERE id = ?`).run(userId);
}
