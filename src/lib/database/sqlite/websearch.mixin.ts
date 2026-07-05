/**
 * SQLite Provider – Web Search operations mixin
 *
 * Web Search instances are stored as websearch-domain provider records; this
 * mixin only persists their per-instance run logs.
 */

import type { IWebSearchRunLog } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function WebSearchMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class WebSearchOps extends Base {
    async createWebSearchRunLog(
      log: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
    ): Promise<IWebSearchRunLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.websearchRunLogs}
        (id, tenantId, projectId, searchKey, driver, query,
         resultCount, latencyMs, status, errorMessage, source, answer, results, metadata, createdAt)
        VALUES (@id, @tenantId, @projectId, @searchKey, @driver, @query,
         @resultCount, @latencyMs, @status, @errorMessage, @source, @answer, @results, @metadata, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        searchKey: log.searchKey,
        driver: log.driver,
        query: log.query,
        resultCount: log.resultCount,
        latencyMs: log.latencyMs ?? null,
        status: log.status,
        errorMessage: log.errorMessage ?? null,
        source: log.source ?? null,
        answer: log.answer ?? null,
        results: log.results ? this.toJson(log.results) : null,
        metadata: this.toJson(log.metadata ?? {}),
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) } as IWebSearchRunLog;
    }

    async listWebSearchRunLogs(
      searchKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
    ): Promise<IWebSearchRunLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['searchKey = @searchKey'];
      const params: Record<string, unknown> = { searchKey };
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.websearchRunLogs} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapWebSearchRunLogRow(r));
    }

    protected mapWebSearchRunLogRow(r: SqliteRow): IWebSearchRunLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null | undefined) ?? undefined,
        searchKey: r.searchKey as string,
        driver: r.driver as string,
        query: r.query as string,
        resultCount: (r.resultCount as number | null | undefined) ?? 0,
        latencyMs: (r.latencyMs as number | null | undefined) ?? undefined,
        status: r.status as IWebSearchRunLog['status'],
        errorMessage: (r.errorMessage as string | null | undefined) ?? undefined,
        source: (r.source as IWebSearchRunLog['source'] | null | undefined) ?? undefined,
        answer: (r.answer as string | null | undefined) ?? undefined,
        results: r.results ? this.parseJson(r.results, []) : undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdAt: r.createdAt ? this.toDate(r.createdAt) : undefined,
      };
    }
  };
}
