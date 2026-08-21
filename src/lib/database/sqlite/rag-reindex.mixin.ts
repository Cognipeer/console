/**
 * SQLite Provider – RAG re-index run operations mixin
 *
 * Mirrors `mongodb/rag-reindex.mixin.ts`. `key` is unique within a tenant
 * database and is what the queue payload carries — the record, not the queue,
 * is the source of truth.
 */

import type { IRagReindexRun } from '../provider/types.domain';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function RagReindexMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RagReindexOps extends Base {
    async createRagReindexRun(
      run: Omit<IRagReindexRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRagReindexRun> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.ragReindexRuns}
        (id, tenantId, projectId, key, ragModuleKey, status, reason, attempt,
         totalDocuments, processedDocuments, failedDocuments, batchSize,
         errorMessage, startedAt, completedAt, progress, metadata,
         createdBy, createdAt, updatedAt)
        VALUES
        (@id, @tenantId, @projectId, @key, @ragModuleKey, @status, @reason, @attempt,
         @totalDocuments, @processedDocuments, @failedDocuments, @batchSize,
         @errorMessage, @startedAt, @completedAt, @progress, @metadata,
         @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: run.tenantId,
        projectId: run.projectId ?? null,
        key: run.key,
        ragModuleKey: run.ragModuleKey,
        status: run.status,
        reason: run.reason ?? null,
        attempt: run.attempt,
        totalDocuments: run.totalDocuments,
        processedDocuments: run.processedDocuments,
        failedDocuments: run.failedDocuments,
        batchSize: run.batchSize,
        errorMessage: run.errorMessage ?? null,
        startedAt: run.startedAt ? run.startedAt.toISOString() : null,
        completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        progress: run.progress ? this.toJson(run.progress) : null,
        metadata: this.toJson(run.metadata ?? {}),
        createdBy: run.createdBy,
        createdAt: now,
        updatedAt: now,
      });

      return { ...run, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateRagReindexRun(
      key: string,
      data: Partial<Omit<IRagReindexRun, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRagReindexRun | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { key, updatedAt: now };

      // Presence (not value) decides: an explicit `undefined` clears the column
      // — a retry resets errorMessage/startedAt/completedAt/progress that way.
      const has = (field: keyof typeof data) => Object.hasOwn(data, field);

      if (has('projectId')) { sets.push('projectId = @projectId'); params.projectId = data.projectId ?? null; }
      if (has('ragModuleKey')) { sets.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = data.ragModuleKey; }
      if (has('status')) { sets.push('status = @status'); params.status = data.status; }
      if (has('reason')) { sets.push('reason = @reason'); params.reason = data.reason ?? null; }
      if (has('attempt')) { sets.push('attempt = @attempt'); params.attempt = data.attempt; }
      if (has('totalDocuments')) { sets.push('totalDocuments = @totalDocuments'); params.totalDocuments = data.totalDocuments; }
      if (has('processedDocuments')) { sets.push('processedDocuments = @processedDocuments'); params.processedDocuments = data.processedDocuments; }
      if (has('failedDocuments')) { sets.push('failedDocuments = @failedDocuments'); params.failedDocuments = data.failedDocuments; }
      if (has('batchSize')) { sets.push('batchSize = @batchSize'); params.batchSize = data.batchSize; }
      if (has('errorMessage')) { sets.push('errorMessage = @errorMessage'); params.errorMessage = data.errorMessage ?? null; }
      if (has('startedAt')) { sets.push('startedAt = @startedAt'); params.startedAt = data.startedAt ? data.startedAt.toISOString() : null; }
      if (has('completedAt')) { sets.push('completedAt = @completedAt'); params.completedAt = data.completedAt ? data.completedAt.toISOString() : null; }
      if (has('progress')) { sets.push('progress = @progress'); params.progress = data.progress ? this.toJson(data.progress) : null; }
      if (has('metadata')) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata ?? {}); }

      db.prepare(`UPDATE ${TABLES.ragReindexRuns} SET ${sets.join(', ')} WHERE key = @key`).run(params);
      return this.findRagReindexRunByKey(key);
    }

    async findRagReindexRunByKey(key: string): Promise<IRagReindexRun | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ragReindexRuns} WHERE key = @key`).get({ key }) as SqliteRow | undefined;
      return row ? this.rowToRagReindexRun(row) : null;
    }

    async listRagReindexRuns(filters?: {
      ragModuleKey?: string;
      projectId?: string;
      statuses?: IRagReindexRun['status'][];
      limit?: number;
    }): Promise<IRagReindexRun[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.ragModuleKey) { clauses.push('ragModuleKey = @ragModuleKey'); params.ragModuleKey = filters.ragModuleKey; }
      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.statuses && filters.statuses.length > 0) {
        const placeholders = filters.statuses.map((_, i) => `@status${i}`);
        clauses.push(`status IN (${placeholders.join(', ')})`);
        filters.statuses.forEach((value, i) => { params[`status${i}`] = value; });
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = filters?.limit ? `LIMIT ${filters.limit}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.ragReindexRuns} ${where} ORDER BY createdAt DESC ${limit}`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.rowToRagReindexRun(row));
    }

    async deleteRagReindexRun(key: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.ragReindexRuns} WHERE key = @key`).run({ key }).changes > 0;
    }

    // ── Private helpers ──────────────────────────────────────────────

    private rowToRagReindexRun(row: SqliteRow): IRagReindexRun {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : undefined,
        key: String(row.key),
        ragModuleKey: String(row.ragModuleKey),
        status: String(row.status) as IRagReindexRun['status'],
        reason: row.reason ? (String(row.reason) as IRagReindexRun['reason']) : undefined,
        attempt: Number(row.attempt ?? 0),
        totalDocuments: Number(row.totalDocuments ?? 0),
        processedDocuments: Number(row.processedDocuments ?? 0),
        failedDocuments: Number(row.failedDocuments ?? 0),
        batchSize: Number(row.batchSize ?? 0),
        errorMessage: row.errorMessage ? String(row.errorMessage) : undefined,
        startedAt: row.startedAt ? new Date(String(row.startedAt)) : undefined,
        completedAt: row.completedAt ? new Date(String(row.completedAt)) : undefined,
        progress: row.progress ? this.parseJson<Record<string, unknown>>(String(row.progress), {}) : undefined,
        metadata: row.metadata ? this.parseJson<Record<string, unknown>>(String(row.metadata), {}) : undefined,
        createdBy: String(row.createdBy),
        createdAt: row.createdAt ? new Date(String(row.createdAt)) : undefined,
        updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : undefined,
      };
    }
  };
}
