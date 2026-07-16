/**
 * SQLite Provider – Reranker operations mixin
 *
 * Reranker is a first-class service: a strategy-driven re-ordering pipeline
 * over candidate documents. Backing engine (dedicated model, LLM, heuristic, …)
 * is selected via `strategy` + `config`.
 */

import type {
  IReranker,
  IRerankerRunLog,
  RerankerStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function RerankerMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class RerankerOps extends Base {
    async createReranker(
      reranker: Omit<IReranker, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IReranker> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.rerankers}
        (id, tenantId, projectId, key, name, description, strategy, config, status,
         totalRuns, avgLatencyMs, lastUsedAt, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @strategy, @config, @status,
         @totalRuns, @avgLatencyMs, @lastUsedAt, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: reranker.tenantId,
        projectId: reranker.projectId ?? null,
        key: reranker.key,
        name: reranker.name,
        description: reranker.description ?? null,
        strategy: reranker.strategy,
        config: this.toJson(reranker.config ?? {}),
        status: reranker.status,
        totalRuns: reranker.totalRuns ?? 0,
        avgLatencyMs: reranker.avgLatencyMs ?? null,
        lastUsedAt: reranker.lastUsedAt ? reranker.lastUsedAt.toISOString() : null,
        metadata: this.toJson(reranker.metadata ?? {}),
        createdBy: reranker.createdBy,
        updatedBy: reranker.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...reranker, _id: id, createdAt: new Date(now), updatedAt: new Date(now) } as IReranker;
    }

    async updateReranker(
      id: string,
      data: Partial<Omit<IReranker, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.strategy !== undefined) { sets.push('strategy = @strategy'); params.strategy = data.strategy; }
      if (data.config !== undefined) { sets.push('config = @config'); params.config = this.toJson(data.config); }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.totalRuns !== undefined) { sets.push('totalRuns = @totalRuns'); params.totalRuns = data.totalRuns; }
      if (data.avgLatencyMs !== undefined) { sets.push('avgLatencyMs = @avgLatencyMs'); params.avgLatencyMs = data.avgLatencyMs; }
      if (data.lastUsedAt !== undefined) {
        sets.push('lastUsedAt = @lastUsedAt');
        params.lastUsedAt = data.lastUsedAt instanceof Date ? data.lastUsedAt.toISOString() : data.lastUsedAt;
      }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.rerankers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findRerankerById(id);
    }

    async deleteReranker(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.rerankers} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findRerankerById(id: string): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.rerankers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRerankerRow(row) : null;
    }

    async findRerankerByKey(key: string, projectId?: string): Promise<IReranker | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.rerankers} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapRerankerRow(row) : null;
    }

    async listRerankers(filters?: {
      projectId?: string;
      status?: RerankerStatus;
      search?: string;
    }): Promise<IReranker[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId !== undefined) {
        const scopeFilter = this.buildProjectScopeFilter(filters.projectId);
        clauses.push(scopeFilter.clause);
        Object.assign(params, scopeFilter.params);
      }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.rerankers} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRerankerRow(r));
    }

    // ── Run logs ──────────────────────────────────────────────────────

    async createRerankerRunLog(
      log: Omit<IRerankerRunLog, '_id' | 'createdAt'>,
    ): Promise<IRerankerRunLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.rerankerRunLogs}
        (id, tenantId, projectId, rerankerKey, strategy, modelKey, query,
         inputCount, outputCount, latencyMs, status, errorMessage, source, ragModuleKey, metadata,
         userId, apiTokenId, actorType, createdAt)
        VALUES (@id, @tenantId, @projectId, @rerankerKey, @strategy, @modelKey, @query,
         @inputCount, @outputCount, @latencyMs, @status, @errorMessage, @source, @ragModuleKey, @metadata,
         @userId, @apiTokenId, @actorType, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        rerankerKey: log.rerankerKey,
        strategy: log.strategy,
        modelKey: log.modelKey ?? null,
        query: log.query,
        inputCount: log.inputCount,
        outputCount: log.outputCount,
        latencyMs: log.latencyMs ?? null,
        status: log.status,
        errorMessage: log.errorMessage ?? null,
        source: log.source ?? null,
        ragModuleKey: log.ragModuleKey ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        userId: log.userId ?? null,
        apiTokenId: log.apiTokenId ?? null,
        actorType: log.actorType ?? null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) } as IRerankerRunLog;
    }

    async listRerankerRunLogs(
      rerankerKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IRerankerRunLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['rerankerKey = @rerankerKey'];
      const params: Record<string, unknown> = { rerankerKey };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.rerankerRunLogs} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRunLogRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapRerankerRow(r: SqliteRow): IReranker {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null | undefined) ?? undefined,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null | undefined) ?? undefined,
        strategy: r.strategy as IReranker['strategy'],
        config: this.parseJson(r.config, {}),
        status: r.status as RerankerStatus,
        totalRuns: (r.totalRuns as number | null | undefined) ?? 0,
        avgLatencyMs: (r.avgLatencyMs as number | null | undefined) ?? undefined,
        lastUsedAt: r.lastUsedAt ? this.toDate(r.lastUsedAt) : undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null | undefined) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapRunLogRow(r: SqliteRow): IRerankerRunLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null | undefined) ?? undefined,
        rerankerKey: r.rerankerKey as string,
        strategy: r.strategy as IRerankerRunLog['strategy'],
        modelKey: (r.modelKey as string | null | undefined) ?? undefined,
        query: r.query as string,
        inputCount: (r.inputCount as number) ?? 0,
        outputCount: (r.outputCount as number) ?? 0,
        latencyMs: (r.latencyMs as number | null | undefined) ?? undefined,
        status: r.status as IRerankerRunLog['status'],
        errorMessage: (r.errorMessage as string | null | undefined) ?? undefined,
        source: (r.source as IRerankerRunLog['source']) ?? undefined,
        ragModuleKey: (r.ragModuleKey as string | null | undefined) ?? undefined,
        metadata: this.parseJson(r.metadata, {}),
        userId: (r.userId as string | null) ?? undefined,
        apiTokenId: (r.apiTokenId as string | null) ?? undefined,
        actorType: (r.actorType as IRerankerRunLog['actorType'] | null) ?? undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
