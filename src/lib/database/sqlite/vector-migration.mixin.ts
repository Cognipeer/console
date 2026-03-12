/**
 * SQLite Provider – Vector migration operations mixin
 */

import type {
  IVectorMigration,
  IVectorMigrationLog,
  VectorMigrationStatus,
  VectorMigrationLogStatus,
} from '../provider/types.base';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function VectorMigrationMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class VectorMigrationOps extends Base {

    async createVectorMigration(
      migration: Omit<IVectorMigration, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IVectorMigration> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.vectorMigrations}
        (id, tenantId, projectId, key, name, description,
         sourceProviderKey, sourceIndexKey, sourceIndexName,
         destinationProviderKey, destinationIndexKey, destinationIndexName,
         status, totalVectors, migratedVectors, failedVectors, batchSize,
         errorMessage, startedAt, completedAt, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES
        (@id, @tenantId, @projectId, @key, @name, @description,
         @sourceProviderKey, @sourceIndexKey, @sourceIndexName,
         @destinationProviderKey, @destinationIndexKey, @destinationIndexName,
         @status, @totalVectors, @migratedVectors, @failedVectors, @batchSize,
         @errorMessage, @startedAt, @completedAt, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: migration.tenantId,
        projectId: migration.projectId ?? null,
        key: migration.key,
        name: migration.name,
        description: migration.description ?? null,
        sourceProviderKey: migration.sourceProviderKey,
        sourceIndexKey: migration.sourceIndexKey,
        sourceIndexName: migration.sourceIndexName,
        destinationProviderKey: migration.destinationProviderKey,
        destinationIndexKey: migration.destinationIndexKey,
        destinationIndexName: migration.destinationIndexName,
        status: migration.status,
        totalVectors: migration.totalVectors,
        migratedVectors: migration.migratedVectors,
        failedVectors: migration.failedVectors,
        batchSize: migration.batchSize,
        errorMessage: migration.errorMessage ?? null,
        startedAt: migration.startedAt ? migration.startedAt.toISOString() : null,
        completedAt: migration.completedAt ? migration.completedAt.toISOString() : null,
        metadata: this.toJson(migration.metadata ?? {}),
        createdBy: migration.createdBy,
        updatedBy: migration.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...migration, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateVectorMigration(
      key: string,
      data: Partial<Omit<IVectorMigration, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IVectorMigration | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { key, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.totalVectors !== undefined) { sets.push('totalVectors = @totalVectors'); params.totalVectors = data.totalVectors; }
      if (data.migratedVectors !== undefined) { sets.push('migratedVectors = @migratedVectors'); params.migratedVectors = data.migratedVectors; }
      if (data.failedVectors !== undefined) { sets.push('failedVectors = @failedVectors'); params.failedVectors = data.failedVectors; }
      if (data.errorMessage !== undefined) { sets.push('errorMessage = @errorMessage'); params.errorMessage = data.errorMessage; }
      if (data.startedAt !== undefined) { sets.push('startedAt = @startedAt'); params.startedAt = data.startedAt ? data.startedAt.toISOString() : null; }
      if (data.completedAt !== undefined) { sets.push('completedAt = @completedAt'); params.completedAt = data.completedAt ? data.completedAt.toISOString() : null; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.vectorMigrations} SET ${sets.join(', ')} WHERE key = @key`).run(params);
      return this.findVectorMigrationByKey(key);
    }

    async deleteVectorMigration(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      const changes = db.prepare(`DELETE FROM ${TABLES.vectorMigrations} WHERE key = @key`).run({ key }).changes;
      if (changes > 0) {
        db.prepare(`DELETE FROM ${TABLES.vectorMigrationLogs} WHERE migrationKey = @key`).run({ key });
      }
      return changes > 0;
    }

    async listVectorMigrations(filters?: {
      projectId?: string;
      status?: VectorMigrationStatus;
    }): Promise<IVectorMigration[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.vectorMigrations} ${where} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map(this.rowToVectorMigration.bind(this));
    }

    async findVectorMigrationByKey(key: string): Promise<IVectorMigration | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.vectorMigrations} WHERE key = @key`).get({ key }) as SqliteRow | undefined;
      return row ? this.rowToVectorMigration(row) : null;
    }

    async createVectorMigrationLog(
      log: Omit<IVectorMigrationLog, '_id' | 'createdAt'>,
    ): Promise<IVectorMigrationLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.vectorMigrationLogs}
        (id, tenantId, projectId, migrationKey, batchIndex, vectorIds, status,
         migratedCount, failedCount, errorMessage, durationMs, createdAt)
        VALUES
        (@id, @tenantId, @projectId, @migrationKey, @batchIndex, @vectorIds, @status,
         @migratedCount, @failedCount, @errorMessage, @durationMs, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        migrationKey: log.migrationKey,
        batchIndex: log.batchIndex,
        vectorIds: this.toJson(log.vectorIds),
        status: log.status,
        migratedCount: log.migratedCount,
        failedCount: log.failedCount,
        errorMessage: log.errorMessage ?? null,
        durationMs: log.durationMs ?? null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listVectorMigrationLogs(
      migrationKey: string,
      options?: { limit?: number; offset?: number },
    ): Promise<IVectorMigrationLog[]> {
      const db = this.getTenantDb();
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.vectorMigrationLogs}
        WHERE migrationKey = @migrationKey
        ORDER BY batchIndex ASC
        LIMIT @limit OFFSET @offset
      `).all({ migrationKey, limit, offset }) as SqliteRow[];
      return rows.map(this.rowToVectorMigrationLog.bind(this));
    }

    async countVectorMigrationLogs(
      migrationKey: string,
      status?: VectorMigrationLogStatus,
    ): Promise<number> {
      const db = this.getTenantDb();
      if (status) {
        const row = db.prepare(`
          SELECT COUNT(*) as cnt FROM ${TABLES.vectorMigrationLogs}
          WHERE migrationKey = @migrationKey AND status = @status
        `).get({ migrationKey, status }) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
      }
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM ${TABLES.vectorMigrationLogs}
        WHERE migrationKey = @migrationKey
      `).get({ migrationKey }) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }

    // ── Private helpers ──────────────────────────────────────────────

    private rowToVectorMigration(row: SqliteRow): IVectorMigration {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        key: String(row.key),
        name: String(row.name),
        description: row.description ? String(row.description) : undefined,
        sourceProviderKey: String(row.sourceProviderKey),
        sourceIndexKey: String(row.sourceIndexKey),
        sourceIndexName: String(row.sourceIndexName),
        destinationProviderKey: String(row.destinationProviderKey),
        destinationIndexKey: String(row.destinationIndexKey),
        destinationIndexName: String(row.destinationIndexName),
        status: String(row.status) as IVectorMigration['status'],
        totalVectors: Number(row.totalVectors),
        migratedVectors: Number(row.migratedVectors),
        failedVectors: Number(row.failedVectors),
        batchSize: Number(row.batchSize),
        errorMessage: row.errorMessage ? String(row.errorMessage) : undefined,
        startedAt: row.startedAt ? new Date(String(row.startedAt)) : undefined,
        completedAt: row.completedAt ? new Date(String(row.completedAt)) : undefined,
        metadata: row.metadata ? this.parseJson<Record<string, unknown>>(String(row.metadata), {}) : undefined,
        createdBy: String(row.createdBy),
        updatedBy: row.updatedBy ? String(row.updatedBy) : undefined,
        createdAt: row.createdAt ? new Date(String(row.createdAt)) : undefined,
        updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : undefined,
      };
    }

    private rowToVectorMigrationLog(row: SqliteRow): IVectorMigrationLog {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        migrationKey: String(row.migrationKey),
        batchIndex: Number(row.batchIndex),
        vectorIds: row.vectorIds ? this.parseJson<string[]>(String(row.vectorIds), []) : [],
        status: String(row.status) as IVectorMigrationLog['status'],
        migratedCount: Number(row.migratedCount),
        failedCount: Number(row.failedCount),
        errorMessage: row.errorMessage ? String(row.errorMessage) : undefined,
        durationMs: row.durationMs ? Number(row.durationMs) : undefined,
        createdAt: row.createdAt ? new Date(String(row.createdAt)) : undefined,
      };
    }
  };
}
