/**
 * SQLite Provider – Batch API (jobs + per-request items) mixin
 */

import type { IBatchJob, IBatchJobItem, BatchJobAggregateDelta } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function BatchJobMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class BatchJobOps extends Base {
    // ── Batch jobs ───────────────────────────────────────────────────
    async createBatchJob(
      record: Omit<IBatchJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IBatchJob> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.batchJobs}
        (id, tenantId, projectId, endpoint, status, completionWindow,
         inputFile, outputFile, errorMessage,
         itemsTotal, itemsSucceeded, itemsFailed, itemsCancelled,
         usageInputTokens, usageOutputTokens, usageTotalTokens,
         metadata, createdBy, startedAt, completedAt, cancelledAt,
         createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @endpoint, @status, @completionWindow,
         @inputFile, @outputFile, @errorMessage,
         @itemsTotal, @itemsSucceeded, @itemsFailed, @itemsCancelled,
         @usageInputTokens, @usageOutputTokens, @usageTotalTokens,
         @metadata, @createdBy, @startedAt, @completedAt, @cancelledAt,
         @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        endpoint: record.endpoint,
        status: record.status,
        completionWindow: record.completionWindow ?? null,
        inputFile: record.inputFile ? this.toJson(record.inputFile) : null,
        outputFile: record.outputFile ? this.toJson(record.outputFile) : null,
        errorMessage: record.errorMessage ?? null,
        itemsTotal: record.itemsTotal ?? 0,
        itemsSucceeded: record.itemsSucceeded ?? 0,
        itemsFailed: record.itemsFailed ?? 0,
        itemsCancelled: record.itemsCancelled ?? 0,
        usageInputTokens: record.usageInputTokens ?? 0,
        usageOutputTokens: record.usageOutputTokens ?? 0,
        usageTotalTokens: record.usageTotalTokens ?? 0,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
        completedAt: record.completedAt ? new Date(record.completedAt).toISOString() : null,
        cancelledAt: record.cancelledAt ? new Date(record.cancelledAt).toISOString() : null,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateBatchJob(
      id: string,
      data: Partial<Omit<IBatchJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = ['projectId', 'endpoint', 'status', 'completionWindow', 'errorMessage', 'createdBy'];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const numberFields = [
        'itemsTotal', 'itemsSucceeded', 'itemsFailed', 'itemsCancelled',
        'usageInputTokens', 'usageOutputTokens', 'usageTotalTokens',
      ];
      for (const f of numberFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const nullableJsonFields = ['inputFile', 'outputFile', 'metadata'];
      for (const f of nullableJsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f];
          params[f] = v == null ? null : this.toJson(v);
        }
      }
      const dateFields: Array<'startedAt' | 'completedAt' | 'cancelledAt'> = ['startedAt', 'completedAt', 'cancelledAt'];
      for (const f of dateFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f] as Date | string | null;
          params[f] = v ? new Date(v).toISOString() : null;
        }
      }
      db.prepare(`UPDATE ${TABLES.batchJobs} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBatchJobById(id);
    }

    async incrementBatchJobAggregates(
      id: string,
      delta: BatchJobAggregateDelta,
    ): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      const incFields: Array<keyof BatchJobAggregateDelta> = [
        'itemsTotal', 'itemsSucceeded', 'itemsFailed', 'itemsCancelled',
        'usageInputTokens', 'usageOutputTokens', 'usageTotalTokens',
      ];
      for (const f of incFields) {
        const v = delta[f];
        if (v) {
          sets.push(`${f} = ${f} + @${f}`);
          params[f] = v;
        }
      }
      db.prepare(`UPDATE ${TABLES.batchJobs} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBatchJobById(id);
    }

    async findBatchJobById(id: string): Promise<IBatchJob | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.batchJobs} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapBatchJob(row) : null;
    }

    async listBatchJobs(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IBatchJob[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      let sql = `SELECT * FROM ${TABLES.batchJobs} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`;
      if (filters?.limit && filters.limit > 0) sql += ` LIMIT ${Math.min(filters.limit, 500)}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapBatchJob(r));
    }

    async deleteBatchJob(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.batchJobItems} WHERE batchId = @id`).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.batchJobs} WHERE id = @id`).run({ id }).changes === 1;
    }

    private mapBatchJob(row: SqliteRow): IBatchJob {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        endpoint: row.endpoint as IBatchJob['endpoint'],
        status: row.status as IBatchJob['status'],
        completionWindow: (row.completionWindow as string) ?? undefined,
        inputFile: row.inputFile
          ? this.parseJson(row.inputFile, undefined as unknown as IBatchJob['inputFile'])
          : undefined,
        outputFile: row.outputFile
          ? this.parseJson(row.outputFile, undefined as unknown as IBatchJob['outputFile'])
          : undefined,
        errorMessage: (row.errorMessage as string) ?? undefined,
        itemsTotal: Number(row.itemsTotal) || 0,
        itemsSucceeded: Number(row.itemsSucceeded) || 0,
        itemsFailed: Number(row.itemsFailed) || 0,
        itemsCancelled: Number(row.itemsCancelled) || 0,
        usageInputTokens: Number(row.usageInputTokens) || 0,
        usageOutputTokens: Number(row.usageOutputTokens) || 0,
        usageTotalTokens: Number(row.usageTotalTokens) || 0,
        metadata: this.parseJson(row.metadata, {}),
        createdBy: row.createdBy as string,
        startedAt: this.toDate(row.startedAt),
        completedAt: this.toDate(row.completedAt),
        cancelledAt: this.toDate(row.cancelledAt),
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── Batch job items ──────────────────────────────────────────────
    async createBatchJobItems(
      records: Array<Omit<IBatchJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IBatchJobItem[]> {
      const db = this.getTenantDb();
      const now = this.now();
      const stmt = db.prepare(`
        INSERT INTO ${TABLES.batchJobItems}
        (id, tenantId, batchId, "index", customId, requestBody, status,
         responseStatusCode, responseBody, errorMessage, usage,
         startedAt, endedAt, createdAt, updatedAt)
        VALUES (@id, @tenantId, @batchId, @index, @customId, @requestBody, @status,
         @responseStatusCode, @responseBody, @errorMessage, @usage,
         @startedAt, @endedAt, @createdAt, @updatedAt)
      `);
      const created: IBatchJobItem[] = [];
      const insertMany = db.transaction((rows: typeof records) => {
        for (const record of rows) {
          const id = this.newId();
          stmt.run({
            id,
            tenantId: record.tenantId,
            batchId: record.batchId,
            index: record.index ?? 0,
            customId: record.customId ?? null,
            requestBody: this.toJson(record.requestBody),
            status: record.status,
            responseStatusCode: record.responseStatusCode ?? null,
            responseBody: record.responseBody ? this.toJson(record.responseBody) : null,
            errorMessage: record.errorMessage ?? null,
            usage: record.usage ? this.toJson(record.usage) : null,
            startedAt: record.startedAt ? new Date(record.startedAt).toISOString() : null,
            endedAt: record.endedAt ? new Date(record.endedAt).toISOString() : null,
            createdAt: now,
            updatedAt: now,
          });
          created.push({ ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) });
        }
      });
      insertMany(records);
      return created;
    }

    async updateBatchJobItem(
      id: string,
      data: Partial<Omit<IBatchJobItem, '_id' | 'tenantId' | 'batchId' | 'createdAt'>>,
    ): Promise<IBatchJobItem | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.customId !== undefined) { sets.push('customId = @customId'); params.customId = data.customId ?? null; }
      if (data.index !== undefined) { sets.push('"index" = @index'); params.index = data.index; }
      if (data.errorMessage !== undefined) { sets.push('errorMessage = @errorMessage'); params.errorMessage = data.errorMessage ?? null; }
      if (data.responseStatusCode !== undefined) { sets.push('responseStatusCode = @responseStatusCode'); params.responseStatusCode = data.responseStatusCode ?? null; }
      if (data.requestBody !== undefined) { sets.push('requestBody = @requestBody'); params.requestBody = this.toJson(data.requestBody); }
      if (data.responseBody !== undefined) {
        sets.push('responseBody = @responseBody');
        params.responseBody = data.responseBody == null ? null : this.toJson(data.responseBody);
      }
      if (data.usage !== undefined) {
        sets.push('usage = @usage');
        params.usage = data.usage == null ? null : this.toJson(data.usage);
      }
      const dateFields: Array<'startedAt' | 'endedAt'> = ['startedAt', 'endedAt'];
      for (const f of dateFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f] as Date | string | null;
          params[f] = v ? new Date(v).toISOString() : null;
        }
      }
      db.prepare(`UPDATE ${TABLES.batchJobItems} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findBatchJobItemById(id);
    }

    async findBatchJobItemById(id: string): Promise<IBatchJobItem | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.batchJobItems} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapBatchJobItem(row) : null;
    }

    async listBatchJobItems(
      batchId: string,
      options?: { limit?: number; skip?: number; status?: string },
    ): Promise<IBatchJobItem[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['batchId = @batchId'];
      const params: Record<string, unknown> = { batchId };
      if (options?.status) { conds.push('status = @status'); params.status = options.status; }
      let sql = `SELECT * FROM ${TABLES.batchJobItems} WHERE ${conds.join(' AND ')} ORDER BY "index" ASC`;
      if (options?.limit) sql += ` LIMIT ${Math.min(options.limit, 10000)}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapBatchJobItem(r));
    }

    private mapBatchJobItem(row: SqliteRow): IBatchJobItem {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        batchId: row.batchId as string,
        index: Number(row.index) || 0,
        customId: (row.customId as string) ?? undefined,
        requestBody: this.parseJson(row.requestBody, {} as Record<string, unknown>),
        status: row.status as IBatchJobItem['status'],
        responseStatusCode: row.responseStatusCode == null ? undefined : Number(row.responseStatusCode),
        responseBody: row.responseBody
          ? this.parseJson(row.responseBody, undefined as unknown as Record<string, unknown>)
          : undefined,
        errorMessage: (row.errorMessage as string) ?? undefined,
        usage: row.usage
          ? this.parseJson(row.usage, undefined as unknown as IBatchJobItem['usage'])
          : undefined,
        startedAt: this.toDate(row.startedAt),
        endedAt: this.toDate(row.endedAt),
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
