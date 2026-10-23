/**
 * SQLite Provider – retention primitives mixin
 *
 * Mirror of the MongoDB mixin. Table and column names are interpolated into
 * SQL, so each one must be a plain identifier and must exist on the table:
 * anything else is a no-op (0 rows), never an error, because the registry
 * also names enterprise tables a community database does not have.
 * Batches go by `rowid`, which every ordinary table has.
 */

import type Database from 'better-sqlite3';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase } from './base';
import type { RetentionFilter, RetentionRedactField } from '../provider/types';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Columns per table per handle; null = the table does not exist. Weak: handles come and go. */
const columnCache = new WeakMap<Database.Database, Map<string, Set<string> | null>>();

function tableColumns(db: Database.Database, table: string): Set<string> | null {
  if (!IDENTIFIER_RE.test(table)) return null;
  let perHandle = columnCache.get(db);
  if (!perHandle) {
    perHandle = new Map();
    columnCache.set(db, perHandle);
  }
  if (perHandle.has(table)) return perHandle.get(table)!;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const columns = rows.length > 0 ? new Set(rows.map((r) => r.name)) : null;
  // A missing table may be created later (lazily created enterprise tables): only remember the ones that exist.
  if (columns) perHandle.set(table, columns);
  return columns;
}

function sqlValue(value: string | number | boolean): string | number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

interface BuiltWhere {
  sql: string;
  params: Record<string, unknown>;
}

/** The WHERE clause of a filter, or null when the table lacks a column it needs (nothing can match). */
export function buildRetentionWhere(filter: RetentionFilter, columns: Set<string>): BuiltWhere | null {
  const needed = [filter.timeField, ...(filter.projectField ? [filter.projectField] : []), ...(filter.where ?? []).map((w) => w.field)];
  if (needed.some((name) => !IDENTIFIER_RE.test(name) || !columns.has(name))) return null;

  const clauses: string[] = [`"${filter.timeField}" < @before`];
  const params: Record<string, unknown> = { before: filter.before.toISOString() };
  if (filter.after) {
    clauses.push(`"${filter.timeField}" >= @after`);
    params.after = filter.after.toISOString();
  }
  let n = 0;
  const list = (values: Array<string | number | boolean>): string => values
    .map((value) => {
      const key = `v${n++}`;
      params[key] = sqlValue(value);
      return `@${key}`;
    })
    .join(', ');
  if (filter.projectField) {
    if (filter.projectIn) {
      clauses.push(filter.projectIn.length > 0 ? `"${filter.projectField}" IN (${list(filter.projectIn)})` : '0');
    }
    if (filter.projectNotIn && filter.projectNotIn.length > 0) {
      // NULL NOT IN (...) is NULL in SQL; a row without a project is not one of the excluded projects.
      clauses.push(`("${filter.projectField}" IS NULL OR "${filter.projectField}" NOT IN (${list(filter.projectNotIn)}))`);
    }
  }
  for (const condition of filter.where ?? []) {
    if (condition.in) {
      clauses.push(condition.in.length > 0 ? `"${condition.field}" IN (${list(condition.in)})` : '0');
    }
    if (condition.notIn && condition.notIn.length > 0) {
      clauses.push(`("${condition.field}" IS NULL OR "${condition.field}" NOT IN (${list(condition.notIn)}))`);
    }
  }
  return { sql: clauses.join(' AND '), params };
}

function usableFields(fields: RetentionRedactField[], columns: Set<string>): RetentionRedactField[] {
  return fields.filter(({ field }) => IDENTIFIER_RE.test(field) && columns.has(field));
}

function holdsContentSql(fields: RetentionRedactField[]): string {
  return `(${fields.map(({ field }) => `("${field}" IS NOT NULL AND "${field}" != '')`).join(' OR ')})`;
}

export function RetentionMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RetentionOps extends Base {
    async retentionCount(collection: string, filter: RetentionFilter): Promise<number> {
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      const where = columns && buildRetentionWhere(filter, columns);
      if (!where) return 0;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${collection} WHERE ${where.sql}`).get(where.params) as SqliteRow;
      return Number(row.n ?? 0);
    }

    async retentionCountRedactable(collection: string, filter: RetentionFilter, fields: RetentionRedactField[]): Promise<number> {
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      const where = columns && buildRetentionWhere(filter, columns);
      const usable = columns ? usableFields(fields, columns) : [];
      if (!where || usable.length === 0) return 0;
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${collection} WHERE ${where.sql} AND ${holdsContentSql(usable)}`)
        .get(where.params) as SqliteRow;
      return Number(row.n ?? 0);
    }

    async retentionDeleteBatch(collection: string, filter: RetentionFilter, limit: number): Promise<number> {
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      const where = columns && buildRetentionWhere(filter, columns);
      if (!where) return 0;
      return db
        .prepare(`DELETE FROM ${collection} WHERE rowid IN (SELECT rowid FROM ${collection} WHERE ${where.sql} LIMIT @limit)`)
        .run({ ...where.params, limit: Math.max(1, Math.floor(limit)) }).changes;
    }

    async retentionRedactBatch(
      collection: string,
      filter: RetentionFilter,
      fields: RetentionRedactField[],
      limit: number,
    ): Promise<number> {
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      const where = columns && buildRetentionWhere(filter, columns);
      const usable = columns ? usableFields(fields, columns) : [];
      if (!where || usable.length === 0) return 0;
      const assignments = usable.map(({ field, clearTo }) => `"${field}" = ${clearTo === 'empty' ? "''" : 'NULL'}`).join(', ');
      return db
        .prepare(
          `UPDATE ${collection} SET ${assignments} WHERE rowid IN (
             SELECT rowid FROM ${collection} WHERE ${where.sql} AND ${holdsContentSql(usable)} LIMIT @limit
           )`,
        )
        .run({ ...where.params, limit: Math.max(1, Math.floor(limit)) }).changes;
    }

    async retentionSelectValues(collection: string, filter: RetentionFilter, field: string, limit: number): Promise<string[]> {
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      const where = columns && buildRetentionWhere(filter, columns);
      if (!where || !IDENTIFIER_RE.test(field) || !columns.has(field)) return [];
      const rows = db
        .prepare(`SELECT "${field}" AS v FROM ${collection} WHERE ${where.sql} LIMIT @limit`)
        .all({ ...where.params, limit: Math.max(1, Math.floor(limit)) }) as SqliteRow[];
      const values = new Set<string>();
      for (const row of rows) {
        if (typeof row.v === 'string' && row.v.length > 0) values.add(row.v);
      }
      return [...values];
    }

    async retentionDeleteWhereIn(collection: string, field: string, values: string[]): Promise<number> {
      if (values.length === 0) return 0;
      const db = this.getTenantDb();
      const columns = tableColumns(db, collection);
      if (!columns || !IDENTIFIER_RE.test(field) || !columns.has(field)) return 0;
      const params: Record<string, string> = {};
      const placeholders = values.map((value, i) => {
        params[`v${i}`] = value;
        return `@v${i}`;
      });
      return db.prepare(`DELETE FROM ${collection} WHERE "${field}" IN (${placeholders.join(', ')})`).run(params).changes;
    }
  };
}
