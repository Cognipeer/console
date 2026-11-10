/**
 * SQLite Provider – Web Search operations mixin
 *
 * Web Search instances are stored as websearch-domain provider records; this
 * mixin only persists their per-instance run logs.
 */

import type { IWebSearchInstance, IWebSearchRunLog } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function WebSearchMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class WebSearchOps extends Base {
    async createWebSearchInstance(
      instance: Omit<IWebSearchInstance, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IWebSearchInstance> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.websearchInstances}
        (id, tenantId, projectId, key, name, description, providerKey, status, settings, metadata,
         platform, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @providerKey, @status, @settings, @metadata,
         @platform, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: instance.tenantId,
        projectId: instance.projectId ?? null,
        key: instance.key,
        name: instance.name,
        description: instance.description ?? null,
        providerKey: instance.providerKey,
        status: instance.status,
        settings: this.toJson(instance.settings ?? {}),
        metadata: this.toJson(instance.metadata ?? {}),
        platform: instance.platform ? 1 : 0,
        createdBy: instance.createdBy,
        updatedBy: instance.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...instance, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateWebSearchInstance(
      id: string,
      data: Partial<Omit<IWebSearchInstance, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<IWebSearchInstance | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId ?? null; }
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.providerKey !== undefined) { sets.push('providerKey = @providerKey'); params.providerKey = data.providerKey; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.settings !== undefined) { sets.push('settings = @settings'); params.settings = this.toJson(data.settings); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.platform !== undefined) { sets.push('platform = @platform'); params.platform = data.platform ? 1 : 0; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      db.prepare(`UPDATE ${TABLES.websearchInstances} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      const row = db.prepare(`SELECT * FROM ${TABLES.websearchInstances} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapWebSearchInstanceRow(row) : null;
    }

    async deleteWebSearchInstance(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.websearchInstances} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findWebSearchInstanceByKey(tenantId: string, key: string): Promise<IWebSearchInstance | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.websearchInstances} WHERE tenantId = @tenantId AND key = @key`,
      ).get({ tenantId, key }) as SqliteRow | undefined;
      return row ? this.mapWebSearchInstanceRow(row) : null;
    }

    async listWebSearchInstances(
      tenantId: string,
      filters?: { providerKey?: string },
    ): Promise<IWebSearchInstance[]> {
      const db = this.getTenantDb();
      const clauses = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.providerKey) { clauses.push('providerKey = @providerKey'); params.providerKey = filters.providerKey; }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.websearchInstances} WHERE ${clauses.join(' AND ')} ORDER BY key ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapWebSearchInstanceRow(r));
    }

    protected mapWebSearchInstanceRow(r: SqliteRow): IWebSearchInstance {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string | null | undefined) ?? null,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null | undefined) ?? undefined,
        providerKey: r.providerKey as string,
        status: r.status as IWebSearchInstance['status'],
        settings: this.parseJson(r.settings, {}),
        metadata: this.parseJson(r.metadata, {}),
        platform: r.platform === 1 || r.platform === true ? true : undefined,
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string | null | undefined) ?? undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    async createWebSearchRunLog(
      log: Omit<IWebSearchRunLog, '_id' | 'createdAt'>,
    ): Promise<IWebSearchRunLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.websearchRunLogs}
        (id, tenantId, projectId, searchKey, driver, query,
         resultCount, latencyMs, status, errorMessage, source, answer, results, metadata,
         userId, apiTokenId, actorType, createdAt)
        VALUES (@id, @tenantId, @projectId, @searchKey, @driver, @query,
         @resultCount, @latencyMs, @status, @errorMessage, @source, @answer, @results, @metadata,
         @userId, @apiTokenId, @actorType, @createdAt)
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
        userId: log.userId ?? null,
        apiTokenId: log.apiTokenId ?? null,
        actorType: log.actorType ?? null,
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
        userId: (r.userId as string | null) ?? undefined,
        apiTokenId: (r.apiTokenId as string | null) ?? undefined,
        actorType: (r.actorType as IWebSearchRunLog['actorType'] | null) ?? undefined,
        createdAt: r.createdAt ? this.toDate(r.createdAt) : undefined,
      };
    }
  };
}
