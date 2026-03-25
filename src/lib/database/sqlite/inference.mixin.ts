/**
 * SQLite Provider – Inference server operations mixin
 *
 * Includes inference servers and inference server metrics.
 */

import type { IInferenceServer, IInferenceServerMetrics } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function InferenceMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class InferenceOps extends Base {
    // ── Inference server CRUD ────────────────────────────────────────

    async createInferenceServer(
      server: Omit<IInferenceServer, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IInferenceServer> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.inferenceServers}
        (id, tenantId, key, name, type, baseUrl, apiKey,
         pollIntervalSeconds, status, lastPolledAt, lastError, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @key, @name, @type, @baseUrl, @apiKey,
         @pollIntervalSeconds, @status, @lastPolledAt, @lastError, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: server.tenantId,
        key: server.key,
        name: server.name,
        type: server.type,
        baseUrl: server.baseUrl,
        apiKey: server.apiKey ?? null,
        pollIntervalSeconds: server.pollIntervalSeconds,
        status: server.status,
        lastPolledAt: server.lastPolledAt ? server.lastPolledAt.toISOString() : null,
        lastError: server.lastError ?? null,
        metadata: this.toJson(server.metadata ?? {}),
        createdBy: server.createdBy,
        updatedBy: server.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...server, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateInferenceServer(
      id: string,
      data: Partial<Omit<IInferenceServer, 'tenantId' | 'key'>>,
    ): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.type !== undefined) { sets.push('type = @type'); params.type = data.type; }
      if (data.baseUrl !== undefined) { sets.push('baseUrl = @baseUrl'); params.baseUrl = data.baseUrl; }
      if (data.apiKey !== undefined) { sets.push('apiKey = @apiKey'); params.apiKey = data.apiKey; }
      if (data.pollIntervalSeconds !== undefined) { sets.push('pollIntervalSeconds = @pollIntervalSeconds'); params.pollIntervalSeconds = data.pollIntervalSeconds; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.lastPolledAt !== undefined) { sets.push('lastPolledAt = @lastPolledAt'); params.lastPolledAt = data.lastPolledAt instanceof Date ? data.lastPolledAt.toISOString() : data.lastPolledAt; }
      if (data.lastError !== undefined) { sets.push('lastError = @lastError'); params.lastError = data.lastError; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.inferenceServers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findInferenceServerById(id);
    }

    async deleteInferenceServer(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.inferenceServers} WHERE id = @id`).run({ id }).changes > 0;
    }

    async findInferenceServerById(id: string): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.inferenceServers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapServerRow(row) : null;
    }

    async findInferenceServerByKey(tenantId: string, key: string): Promise<IInferenceServer | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.inferenceServers} WHERE tenantId = @tenantId AND key = @key`,
      ).get({ tenantId, key }) as SqliteRow | undefined;
      return row ? this.mapServerRow(row) : null;
    }

    async listInferenceServers(tenantId: string): Promise<IInferenceServer[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.inferenceServers} WHERE tenantId = @tenantId ORDER BY createdAt DESC`,
      ).all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapServerRow(r));
    }

    // ── Inference server metrics ─────────────────────────────────────

    async createInferenceServerMetrics(
      metrics: Omit<IInferenceServerMetrics, '_id' | 'createdAt'>,
    ): Promise<IInferenceServerMetrics> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.inferenceServerMetrics}
        (id, tenantId, serverKey, timestamp,
         numRequestsRunning, numRequestsWaiting, gpuCacheUsagePercent, cpuCacheUsagePercent,
         promptTokensThroughput, generationTokensThroughput,
         timeToFirstTokenSeconds, timePerOutputTokenSeconds, e2eRequestLatencySeconds,
         requestsPerSecond, runningModels, raw, createdAt)
        VALUES (@id, @tenantId, @serverKey, @timestamp,
         @numRequestsRunning, @numRequestsWaiting, @gpuCacheUsagePercent, @cpuCacheUsagePercent,
         @promptTokensThroughput, @generationTokensThroughput,
         @timeToFirstTokenSeconds, @timePerOutputTokenSeconds, @e2eRequestLatencySeconds,
         @requestsPerSecond, @runningModels, @raw, @createdAt)
      `).run({
        id,
        tenantId: metrics.tenantId,
        serverKey: metrics.serverKey,
        timestamp: metrics.timestamp instanceof Date ? metrics.timestamp.toISOString() : metrics.timestamp,
        numRequestsRunning: metrics.numRequestsRunning ?? null,
        numRequestsWaiting: metrics.numRequestsWaiting ?? null,
        gpuCacheUsagePercent: metrics.gpuCacheUsagePercent ?? null,
        cpuCacheUsagePercent: metrics.cpuCacheUsagePercent ?? null,
        promptTokensThroughput: metrics.promptTokensThroughput ?? null,
        generationTokensThroughput: metrics.generationTokensThroughput ?? null,
        timeToFirstTokenSeconds: metrics.timeToFirstTokenSeconds ?? null,
        timePerOutputTokenSeconds: metrics.timePerOutputTokenSeconds ?? null,
        e2eRequestLatencySeconds: metrics.e2eRequestLatencySeconds ?? null,
        requestsPerSecond: metrics.requestsPerSecond ?? null,
        runningModels: this.toJson(metrics.runningModels ?? []),
        raw: this.toJson(metrics.raw ?? {}),
        createdAt: now,
      });

      return { ...metrics, _id: id, createdAt: new Date(now) } as IInferenceServerMetrics;
    }

    async listInferenceServerMetrics(
      serverKey: string,
      options?: { from?: Date; to?: Date; limit?: number },
    ): Promise<IInferenceServerMetrics[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['serverKey = @serverKey'];
      const params: Record<string, unknown> = { serverKey };
      if (options?.from) { clauses.push('timestamp >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('timestamp <= @to'); params.to = options.to.toISOString(); }

      let sql = `SELECT * FROM ${TABLES.inferenceServerMetrics} WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC`;
      if (options?.limit) sql += ` LIMIT ${options.limit}`;

      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapMetricsRow(r));
    }

    async deleteInferenceServerMetrics(serverKey: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.inferenceServerMetrics} WHERE serverKey = @serverKey`)
        .run({ serverKey }).changes;
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapServerRow(r: SqliteRow): IInferenceServer {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        key: r.key as string,
        name: r.name as string,
        type: r.type as IInferenceServer['type'],
        baseUrl: r.baseUrl as string,
        apiKey: (r.apiKey as string) || undefined,
        pollIntervalSeconds: r.pollIntervalSeconds as number,
        status: r.status as IInferenceServer['status'],
        lastPolledAt: r.lastPolledAt ? this.toDate(r.lastPolledAt) : undefined,
        lastError: (r.lastError as string) || undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: (r.updatedBy as string) || undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapMetricsRow(r: SqliteRow): IInferenceServerMetrics {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        serverKey: r.serverKey as string,
        timestamp: this.toDate(r.timestamp) ?? new Date(),
        numRequestsRunning: r.numRequestsRunning as number | undefined,
        numRequestsWaiting: r.numRequestsWaiting as number | undefined,
        gpuCacheUsagePercent: r.gpuCacheUsagePercent as number | undefined,
        cpuCacheUsagePercent: r.cpuCacheUsagePercent as number | undefined,
        promptTokensThroughput: r.promptTokensThroughput as number | undefined,
        generationTokensThroughput: r.generationTokensThroughput as number | undefined,
        timeToFirstTokenSeconds: r.timeToFirstTokenSeconds as number | undefined,
        timePerOutputTokenSeconds: r.timePerOutputTokenSeconds as number | undefined,
        e2eRequestLatencySeconds: r.e2eRequestLatencySeconds as number | undefined,
        requestsPerSecond: r.requestsPerSecond as number | undefined,
        runningModels: this.parseJson<string[]>(r.runningModels, []),
        raw: this.parseJson(r.raw, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
