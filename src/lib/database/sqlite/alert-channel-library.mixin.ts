/**
 * SQLite Provider – Alert channel library mixin
 *
 * Tenant-wide reusable notification channels (secrets stay sealed inside
 * `config`). The table is created lazily (`CREATE TABLE IF NOT EXISTS`) the
 * first time a tenant handle touches it: no change to the shared tenant schema.
 */

import type Database from 'better-sqlite3';
import type { IAlertChannelLibraryEntry } from '../provider/types.domain';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase } from './base';

const TABLE = 'alert_channel_library';
const ensuredHandles = new WeakSet<Database.Database>();

export function AlertChannelLibraryMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AlertChannelLibraryOps extends Base {
    private libraryTable(): Database.Database {
      const db = this.getTenantDb();
      if (!ensuredHandles.has(db)) {
        db.exec(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (
             id TEXT PRIMARY KEY,
             tenantId TEXT NOT NULL,
             name TEXT NOT NULL,
             kind TEXT NOT NULL,
             config TEXT NOT NULL,
             createdBy TEXT NOT NULL,
             createdAt TEXT NOT NULL,
             updatedAt TEXT NOT NULL
           )`,
        );
        ensuredHandles.add(db);
      }
      return db;
    }

    async listAlertChannelLibrary(tenantId: string): Promise<IAlertChannelLibraryEntry[]> {
      const rows = this.libraryTable()
        .prepare(`SELECT * FROM ${TABLE} WHERE tenantId = @tenantId ORDER BY name COLLATE NOCASE ASC LIMIT 500`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((row) => this.mapLibraryRow(row));
    }

    async findAlertChannelLibraryEntry(id: string): Promise<IAlertChannelLibraryEntry | null> {
      const row = this.libraryTable().prepare(`SELECT * FROM ${TABLE} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapLibraryRow(row) : null;
    }

    async createAlertChannelLibraryEntry(
      entry: Omit<IAlertChannelLibraryEntry, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAlertChannelLibraryEntry> {
      const db = this.libraryTable();
      const id = this.newId();
      const now = this.now();
      db.prepare(
        `INSERT INTO ${TABLE} (id, tenantId, name, kind, config, createdBy, createdAt, updatedAt)
         VALUES (@id, @tenantId, @name, @kind, @config, @createdBy, @now, @now)`,
      ).run({
        id,
        tenantId: entry.tenantId,
        name: entry.name,
        kind: entry.kind,
        config: JSON.stringify(entry.config),
        createdBy: entry.createdBy,
        now,
      });
      return (await this.findAlertChannelLibraryEntry(id)) as IAlertChannelLibraryEntry;
    }

    async updateAlertChannelLibraryEntry(
      id: string,
      data: Partial<Pick<IAlertChannelLibraryEntry, 'name' | 'config'>>,
    ): Promise<IAlertChannelLibraryEntry | null> {
      const db = this.libraryTable();
      const sets: string[] = ['updatedAt = @now'];
      const params: Record<string, unknown> = { id, now: this.now() };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.config !== undefined) {
        sets.push('config = @config', 'kind = @kind');
        params.config = JSON.stringify(data.config);
        params.kind = data.config.type;
      }
      const result = db.prepare(`UPDATE ${TABLE} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return result.changes === 1 ? this.findAlertChannelLibraryEntry(id) : null;
    }

    async deleteAlertChannelLibraryEntry(id: string): Promise<boolean> {
      return this.libraryTable().prepare(`DELETE FROM ${TABLE} WHERE id = @id`).run({ id }).changes === 1;
    }

    protected mapLibraryRow(r: SqliteRow): IAlertChannelLibraryEntry {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        name: r.name as string,
        kind: r.kind as IAlertChannelLibraryEntry['kind'],
        config: this.parseJson(r.config, { type: 'email', recipients: [] }),
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
