/**
 * SQLite Provider – OCR jobs (container) & job items mixin
 */

import type { IOcrJob, IOcrJobItem, OcrJobAggregateDelta } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function OcrJobMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class OcrJobOps extends Base {
    // ── OCR jobs (container) ─────────────────────────────────────────
    async createOcrJob(
      record: Omit<IOcrJob, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IOcrJob> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.ocrJobs}
        (id, tenantId, projectId, name, status, bucketKey, prefix,
         ocrModelKey, llmModelKey, outputs, summaryPrompt, structuredSchema,
         language, features, pdfMaxPages,
         callbackUrl, callbackSecret, callbackEvents,
         itemsTotal, itemsProcessed, itemsFailed,
         usageInputTokens, usageOutputTokens, usageTotalTokens, usagePages,
         usageOcrTokens, usageLlmTokens, costOcr, costLlm,
         costTotal, costCurrency, lastItemAt, metadata,
         createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @name, @status, @bucketKey, @prefix,
         @ocrModelKey, @llmModelKey, @outputs, @summaryPrompt, @structuredSchema,
         @language, @features, @pdfMaxPages,
         @callbackUrl, @callbackSecret, @callbackEvents,
         @itemsTotal, @itemsProcessed, @itemsFailed,
         @usageInputTokens, @usageOutputTokens, @usageTotalTokens, @usagePages,
         @usageOcrTokens, @usageLlmTokens, @costOcr, @costLlm,
         @costTotal, @costCurrency, @lastItemAt, @metadata,
         @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId ?? null,
        name: record.name ?? null,
        status: record.status,
        bucketKey: record.bucketKey,
        prefix: record.prefix ?? null,
        ocrModelKey: record.ocrModelKey,
        llmModelKey: record.llmModelKey ?? null,
        outputs: this.toJson(record.outputs ?? []),
        summaryPrompt: record.summaryPrompt ?? null,
        structuredSchema: record.structuredSchema ? this.toJson(record.structuredSchema) : null,
        language: record.language ?? null,
        features: this.toJson(record.features ?? []),
        pdfMaxPages: record.pdfMaxPages ?? null,
        callbackUrl: record.callbackUrl ?? null,
        callbackSecret: record.callbackSecret ?? null,
        callbackEvents: record.callbackEvents ? this.toJson(record.callbackEvents) : null,
        itemsTotal: record.itemsTotal ?? 0,
        itemsProcessed: record.itemsProcessed ?? 0,
        itemsFailed: record.itemsFailed ?? 0,
        usageInputTokens: record.usageInputTokens ?? 0,
        usageOutputTokens: record.usageOutputTokens ?? 0,
        usageTotalTokens: record.usageTotalTokens ?? 0,
        usagePages: record.usagePages ?? 0,
        usageOcrTokens: record.usageOcrTokens ?? 0,
        usageLlmTokens: record.usageLlmTokens ?? 0,
        costOcr: record.costOcr ?? 0,
        costLlm: record.costLlm ?? 0,
        costTotal: record.costTotal ?? 0,
        costCurrency: record.costCurrency ?? null,
        lastItemAt: record.lastItemAt ? new Date(record.lastItemAt).toISOString() : null,
        metadata: this.toJson(record.metadata ?? {}),
        createdBy: record.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...record, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateOcrJob(
      id: string,
      data: Partial<Omit<IOcrJob, '_id' | 'tenantId' | 'createdAt'>>,
    ): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      const scalarFields = [
        'name', 'status', 'bucketKey', 'prefix', 'ocrModelKey', 'llmModelKey',
        'summaryPrompt', 'language', 'callbackUrl', 'callbackSecret', 'costCurrency', 'projectId',
      ];
      for (const f of scalarFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const numberFields = [
        'itemsTotal', 'itemsProcessed', 'itemsFailed', 'pdfMaxPages',
        'usageInputTokens', 'usageOutputTokens', 'usageTotalTokens', 'usagePages',
        'usageOcrTokens', 'usageLlmTokens', 'costOcr', 'costLlm', 'costTotal',
      ];
      for (const f of numberFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = (data as Record<string, unknown>)[f] ?? null;
        }
      }
      const jsonFields = ['outputs', 'features', 'metadata'];
      for (const f of jsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          params[f] = this.toJson((data as Record<string, unknown>)[f] ?? {});
        }
      }
      const nullableJsonFields = ['structuredSchema', 'callbackEvents'];
      for (const f of nullableJsonFields) {
        if ((data as Record<string, unknown>)[f] !== undefined) {
          sets.push(`${f} = @${f}`);
          const v = (data as Record<string, unknown>)[f];
          params[f] = v == null ? null : this.toJson(v);
        }
      }
      if (data.lastItemAt !== undefined) {
        sets.push('lastItemAt = @lastItemAt');
        params.lastItemAt = data.lastItemAt ? new Date(data.lastItemAt).toISOString() : null;
      }
      db.prepare(`UPDATE ${TABLES.ocrJobs} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findOcrJobById(id);
    }

    async incrementOcrJobAggregates(
      id: string,
      delta: OcrJobAggregateDelta,
      extra?: { costCurrency?: string; lastItemAt?: Date },
    ): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      const incFields: Array<keyof OcrJobAggregateDelta> = [
        'itemsTotal', 'itemsProcessed', 'itemsFailed',
        'usageInputTokens', 'usageOutputTokens', 'usageTotalTokens', 'usagePages',
        'usageOcrTokens', 'usageLlmTokens', 'costOcr', 'costLlm', 'costTotal',
      ];
      for (const f of incFields) {
        const v = delta[f];
        if (v) {
          sets.push(`${f} = ${f} + @${f}`);
          params[f] = v;
        }
      }
      if (extra?.costCurrency) { sets.push('costCurrency = @costCurrency'); params.costCurrency = extra.costCurrency; }
      if (extra?.lastItemAt) { sets.push('lastItemAt = @lastItemAt'); params.lastItemAt = new Date(extra.lastItemAt).toISOString(); }
      db.prepare(`UPDATE ${TABLES.ocrJobs} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findOcrJobById(id);
    }

    async findOcrJobById(id: string): Promise<IOcrJob | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ocrJobs} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapOcrJob(row) : null;
    }

    async listOcrJobs(
      tenantId: string,
      filters?: { projectId?: string; status?: string; limit?: number },
    ): Promise<IOcrJob[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId) { conds.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.status) { conds.push('status = @status'); params.status = filters.status; }
      let sql = `SELECT * FROM ${TABLES.ocrJobs} WHERE ${conds.join(' AND ')} ORDER BY createdAt DESC`;
      if (filters?.limit && filters.limit > 0) sql += ` LIMIT ${Math.min(filters.limit, 500)}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapOcrJob(r));
    }

    async deleteOcrJob(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.ocrJobItems} WHERE jobId = @id`).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.ocrJobs} WHERE id = @id`).run({ id }).changes === 1;
    }

    private mapOcrJob(row: SqliteRow): IOcrJob {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: (row.projectId as string) ?? undefined,
        name: (row.name as string) ?? undefined,
        status: row.status as IOcrJob['status'],
        bucketKey: row.bucketKey as string,
        prefix: (row.prefix as string) ?? undefined,
        ocrModelKey: row.ocrModelKey as string,
        llmModelKey: (row.llmModelKey as string) ?? undefined,
        outputs: this.parseJson(row.outputs, [] as IOcrJob['outputs']),
        summaryPrompt: (row.summaryPrompt as string) ?? undefined,
        structuredSchema: row.structuredSchema
          ? this.parseJson(row.structuredSchema, undefined as unknown as Record<string, unknown>)
          : undefined,
        language: (row.language as string) ?? undefined,
        features: this.parseJson(row.features, [] as string[]),
        pdfMaxPages: row.pdfMaxPages == null ? undefined : Number(row.pdfMaxPages),
        callbackUrl: (row.callbackUrl as string) ?? undefined,
        callbackSecret: (row.callbackSecret as string) ?? undefined,
        callbackEvents: row.callbackEvents
          ? this.parseJson(row.callbackEvents, undefined as unknown as IOcrJob['callbackEvents'])
          : undefined,
        itemsTotal: Number(row.itemsTotal) || 0,
        itemsProcessed: Number(row.itemsProcessed) || 0,
        itemsFailed: Number(row.itemsFailed) || 0,
        usageInputTokens: Number(row.usageInputTokens) || 0,
        usageOutputTokens: Number(row.usageOutputTokens) || 0,
        usageTotalTokens: Number(row.usageTotalTokens) || 0,
        usagePages: Number(row.usagePages) || 0,
        usageOcrTokens: Number(row.usageOcrTokens) || 0,
        usageLlmTokens: Number(row.usageLlmTokens) || 0,
        costOcr: Number(row.costOcr) || 0,
        costLlm: Number(row.costLlm) || 0,
        costTotal: Number(row.costTotal) || 0,
        costCurrency: (row.costCurrency as string) ?? undefined,
        lastItemAt: this.toDate(row.lastItemAt),
        metadata: this.parseJson(row.metadata, {}),
        createdBy: row.createdBy as string,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }

    // ── OCR job items ────────────────────────────────────────────────
    async createOcrJobItem(
      record: Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IOcrJobItem> {
      const [created] = await this.createOcrJobItems([record]);
      return created;
    }

    async createOcrJobItems(
      records: Array<Omit<IOcrJobItem, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<IOcrJobItem[]> {
      const db = this.getTenantDb();
      const now = this.now();
      const stmt = db.prepare(`
        INSERT INTO ${TABLES.ocrJobItems}
        (id, tenantId, jobId, "index", source, fileName, status, result, usage,
         costTotal, costCurrency, callbackStatus, errorMessage, startedAt, endedAt, createdAt, updatedAt)
        VALUES (@id, @tenantId, @jobId, @index, @source, @fileName, @status, @result, @usage,
         @costTotal, @costCurrency, @callbackStatus, @errorMessage, @startedAt, @endedAt, @createdAt, @updatedAt)
      `);
      const created: IOcrJobItem[] = [];
      const insertMany = db.transaction((rows: typeof records) => {
        for (const record of rows) {
          const id = this.newId();
          stmt.run({
            id,
            tenantId: record.tenantId,
            jobId: record.jobId,
            index: record.index ?? 0,
            source: this.toJson(record.source),
            fileName: record.fileName ?? null,
            status: record.status,
            result: record.result ? this.toJson(record.result) : null,
            usage: record.usage ? this.toJson(record.usage) : null,
            costTotal: record.costTotal ?? null,
            costCurrency: record.costCurrency ?? null,
            callbackStatus: record.callbackStatus ?? null,
            errorMessage: record.errorMessage ?? null,
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

    async updateOcrJobItem(
      id: string,
      data: Partial<Omit<IOcrJobItem, '_id' | 'tenantId' | 'jobId' | 'createdAt'>>,
    ): Promise<IOcrJobItem | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.fileName !== undefined) { sets.push('fileName = @fileName'); params.fileName = data.fileName ?? null; }
      if (data.index !== undefined) { sets.push('"index" = @index'); params.index = data.index; }
      if (data.errorMessage !== undefined) { sets.push('errorMessage = @errorMessage'); params.errorMessage = data.errorMessage ?? null; }
      if (data.callbackStatus !== undefined) { sets.push('callbackStatus = @callbackStatus'); params.callbackStatus = data.callbackStatus ?? null; }
      if (data.costTotal !== undefined) { sets.push('costTotal = @costTotal'); params.costTotal = data.costTotal ?? null; }
      if (data.costCurrency !== undefined) { sets.push('costCurrency = @costCurrency'); params.costCurrency = data.costCurrency ?? null; }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = this.toJson(data.source); }
      if (data.result !== undefined) {
        sets.push('result = @result');
        params.result = data.result == null ? null : this.toJson(data.result);
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
      db.prepare(`UPDATE ${TABLES.ocrJobItems} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findOcrJobItemById(id);
    }

    async findOcrJobItemById(id: string): Promise<IOcrJobItem | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.ocrJobItems} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapOcrJobItem(row) : null;
    }

    async listOcrJobItems(
      jobId: string,
      options?: { limit?: number; skip?: number; status?: string },
    ): Promise<IOcrJobItem[]> {
      const db = this.getTenantDb();
      const conds: string[] = ['jobId = @jobId'];
      const params: Record<string, unknown> = { jobId };
      if (options?.status) { conds.push('status = @status'); params.status = options.status; }
      let sql = `SELECT * FROM ${TABLES.ocrJobItems} WHERE ${conds.join(' AND ')} ORDER BY "index" ASC`;
      if (options?.limit) sql += ` LIMIT ${Math.min(options.limit, 5000)}`;
      if (options?.skip) sql += ` OFFSET ${options.skip}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapOcrJobItem(r));
    }

    private mapOcrJobItem(row: SqliteRow): IOcrJobItem {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        jobId: row.jobId as string,
        index: Number(row.index) || 0,
        source: this.parseJson(row.source, {} as IOcrJobItem['source']),
        fileName: (row.fileName as string) ?? undefined,
        status: row.status as IOcrJobItem['status'],
        result: row.result ? this.parseJson(row.result, undefined as unknown as IOcrJobItem['result']) : undefined,
        usage: row.usage ? this.parseJson(row.usage, undefined as unknown as IOcrJobItem['usage']) : undefined,
        costTotal: row.costTotal == null ? undefined : Number(row.costTotal),
        costCurrency: (row.costCurrency as string) ?? undefined,
        callbackStatus: (row.callbackStatus as IOcrJobItem['callbackStatus']) ?? undefined,
        errorMessage: (row.errorMessage as string) ?? undefined,
        startedAt: this.toDate(row.startedAt),
        endedAt: this.toDate(row.endedAt),
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
