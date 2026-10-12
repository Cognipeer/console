/**
 * SQLite Provider – IAM document store mixin.
 *
 * Mirror of the MongoDB mixin: a generic id → JSON document store, one table
 * per collection, created lazily (`CREATE TABLE IF NOT EXISTS`) the first time
 * a given tenant database handle WRITES to it. Reads of a table that does not
 * exist yet return "nothing" without running any DDL, so the always-on policy
 * version check of the request gate never creates tables (or takes a schema lock)
 * by reading; the first WRITE does - the engine's first evaluation of a workspace
 * records the project-levels activation instant in `iam_meta`. No migration and
 * no change to the shared tenant schema.
 */

import type Database from 'better-sqlite3';
import { IAM_COLLECTIONS, type IIamDoc, type IamCollectionName } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase } from './base';

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Handles on which the IAM tables were already ensured (weak: handles come and go). */
const ensuredHandles = new WeakMap<Database.Database, Set<string>>();

function assertCollection(collection: string): asserts collection is IamCollectionName {
  if (!(IAM_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new Error(`Unknown IAM collection "${collection}"`);
  }
}

/**
 * Write path: the collection's table on this tenant handle, created on first use. Exported for the code that keeps small
 * per-record documents next to its own tables through the same lazily created collections (the identity documents of
 * `user.mixin.ts`); everything else goes through the `iamDoc*` methods below.
 */
export function ensureIamCollectionTable(db: Database.Database, collection: IamCollectionName): void {
  assertCollection(collection);
  let ensured = ensuredHandles.get(db);
  if (!ensured) {
    ensured = new Set();
    ensuredHandles.set(db, ensured);
  }
  if (!ensured.has(collection)) {
    // `collection` is validated against a fixed whitelist above, so it is
    // safe to interpolate as an identifier.
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${collection} (
         id TEXT PRIMARY KEY,
         data TEXT NOT NULL,
         updatedAt TEXT NOT NULL
       )`,
    );
    ensured.add(collection);
  }
}

/** Read path: whether the collection's table exists on this tenant handle. Never runs DDL. */
export function iamCollectionTableExists(db: Database.Database, collection: IamCollectionName): boolean {
  assertCollection(collection);
  if (ensuredHandles.get(db)?.has(collection)) return true;
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(collection);
  if (!row) return false;
  let ensured = ensuredHandles.get(db);
  if (!ensured) {
    ensured = new Set();
    ensuredHandles.set(db, ensured);
  }
  ensured.add(collection);
  return true;
}

export function IamDocsMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class IamDocsOps extends Base {
    /** Returns the tenant handle with the collection's table guaranteed to exist. */
    private iamTable(collection: IamCollectionName): Database.Database {
      const db = this.getTenantDb();
      ensureIamCollectionTable(db, collection);
      return db;
    }

    /** Read path: the handle when the table exists, else null. Never runs DDL. */
    private iamTableIfExists(collection: IamCollectionName): Database.Database | null {
      const db = this.getTenantDb();
      return iamCollectionTableExists(db, collection) ? db : null;
    }

    private mapIamRow(row: SqliteRow): IIamDoc {
      return {
        id: String(row.id),
        data: this.parseJson<Record<string, unknown>>(row.data, {}),
        updatedAt: new Date(String(row.updatedAt)),
      };
    }

    async iamDocGet(collection: IamCollectionName, id: string): Promise<IIamDoc | null> {
      const db = this.iamTableIfExists(collection);
      if (!db) return null;
      const row = db.prepare(`SELECT * FROM ${collection} WHERE id = ?`).get(id) as SqliteRow | undefined;
      return row ? this.mapIamRow(row) : null;
    }

    async iamDocPut(
      collection: IamCollectionName,
      id: string,
      data: Record<string, unknown>,
    ): Promise<IIamDoc> {
      const db = this.iamTable(collection);
      const updatedAt = this.now();
      db.prepare(
        `INSERT INTO ${collection} (id, data, updatedAt) VALUES (@id, @data, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
      ).run({ id, data: this.toJson(data), updatedAt });
      return { id, data, updatedAt: new Date(updatedAt) };
    }

    async iamDocList(
      collection: IamCollectionName,
      options: { idPrefix?: string; limit?: number } = {},
    ): Promise<IIamDoc[]> {
      const db = this.iamTableIfExists(collection);
      if (!db) return [];
      const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
      const rows = options.idPrefix
        ? (db
            .prepare(`SELECT * FROM ${collection} WHERE substr(id, 1, @len) = @prefix ORDER BY id ASC LIMIT @limit`)
            .all({ len: options.idPrefix.length, prefix: options.idPrefix, limit }) as SqliteRow[])
        : (db.prepare(`SELECT * FROM ${collection} ORDER BY id ASC LIMIT ?`).all(limit) as SqliteRow[]);
      return rows.map((row) => this.mapIamRow(row));
    }

    async iamDocDelete(collection: IamCollectionName, id: string): Promise<boolean> {
      const db = this.iamTableIfExists(collection);
      if (!db) return false;
      return db.prepare(`DELETE FROM ${collection} WHERE id = ?`).run(id).changes > 0;
    }

    async iamDocClear(collection: IamCollectionName): Promise<number> {
      const db = this.iamTableIfExists(collection);
      if (!db) return 0;
      return db.prepare(`DELETE FROM ${collection}`).run().changes;
    }

    async iamDocIncrement(
      collection: IamCollectionName,
      id: string,
      field: string,
      by = 1,
    ): Promise<number> {
      if (!FIELD_RE.test(field)) throw new Error(`Invalid IAM counter field "${field}"`);
      const db = this.iamTable(collection);
      // better-sqlite3 is synchronous, so this read-modify-write cannot be
      // interleaved with another statement on the same connection; the
      // transaction additionally covers other processes sharing the file.
      const run = db.transaction((): number => {
        const row = db.prepare(`SELECT data FROM ${collection} WHERE id = ?`).get(id) as SqliteRow | undefined;
        const data = row ? this.parseJson<Record<string, unknown>>(row.data, {}) : {};
        const current = typeof data[field] === 'number' ? (data[field] as number) : 0;
        const next = current + by;
        data[field] = next;
        db.prepare(
          `INSERT INTO ${collection} (id, data, updatedAt) VALUES (@id, @data, @updatedAt)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt`,
        ).run({ id, data: this.toJson(data), updatedAt: this.now() });
        return next;
      });
      return run.immediate();
    }
  };
}
