/**
 * SQLite Provider – Model + usage log operations mixin
 */

import type {
  IModel, IModelUsageLog, IModelUsageAggregate,
  ModelCategory, ModelProviderType,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ModelMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ModelOps extends Base {

    // ── Models ──────────────────────────────────────────────────────

    async createModel(model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>): Promise<IModel> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.models}
        (id, tenantId, projectId, name, description, key, providerKey, providerDriver, provider,
         category, modelId, isMultimodal, supportsToolCalls, settings, pricing, semanticCache,
         inputGuardrailKey, outputGuardrailKey, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @name, @description, @key, @providerKey, @providerDriver, @provider,
         @category, @modelId, @isMultimodal, @supportsToolCalls, @settings, @pricing, @semanticCache,
         @inputGuardrailKey, @outputGuardrailKey, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: model.tenantId,
        projectId: model.projectId ?? null,
        name: model.name,
        description: model.description ?? null,
        key: model.key,
        providerKey: model.providerKey,
        providerDriver: model.providerDriver ?? '',
        provider: model.provider ?? null,
        category: model.category,
        modelId: model.modelId,
        isMultimodal: this.toBoolInt(model.isMultimodal),
        supportsToolCalls: this.toBoolInt(model.supportsToolCalls),
        settings: this.toJson(model.settings ?? {}),
        pricing: this.toJson(model.pricing),
        semanticCache: model.semanticCache ? this.toJson(model.semanticCache) : null,
        inputGuardrailKey: model.inputGuardrailKey ?? null,
        outputGuardrailKey: model.outputGuardrailKey ?? null,
        metadata: this.toJson(model.metadata ?? {}),
        createdBy: model.createdBy ?? null,
        updatedBy: model.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...model, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateModel(id: string, data: Partial<IModel>): Promise<IModel | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.providerKey !== undefined) { sets.push('providerKey = @providerKey'); params.providerKey = data.providerKey; }
      if (data.providerDriver !== undefined) { sets.push('providerDriver = @providerDriver'); params.providerDriver = data.providerDriver; }
      if (data.category !== undefined) { sets.push('category = @category'); params.category = data.category; }
      if (data.modelId !== undefined) { sets.push('modelId = @modelId'); params.modelId = data.modelId; }
      if (data.isMultimodal !== undefined) { sets.push('isMultimodal = @isMultimodal'); params.isMultimodal = this.toBoolInt(data.isMultimodal); }
      if (data.supportsToolCalls !== undefined) { sets.push('supportsToolCalls = @supportsToolCalls'); params.supportsToolCalls = this.toBoolInt(data.supportsToolCalls); }
      if (data.settings !== undefined) { sets.push('settings = @settings'); params.settings = this.toJson(data.settings); }
      if (data.pricing !== undefined) { sets.push('pricing = @pricing'); params.pricing = this.toJson(data.pricing); }
      if (data.semanticCache !== undefined) { sets.push('semanticCache = @semanticCache'); params.semanticCache = data.semanticCache ? this.toJson(data.semanticCache) : null; }
      if (data.inputGuardrailKey !== undefined) { sets.push('inputGuardrailKey = @inputGuardrailKey'); params.inputGuardrailKey = data.inputGuardrailKey; }
      if (data.outputGuardrailKey !== undefined) { sets.push('outputGuardrailKey = @outputGuardrailKey'); params.outputGuardrailKey = data.outputGuardrailKey; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.models} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findModelById(id);
    }

    async deleteModel(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.models} WHERE id = @id`).run({ id }).changes > 0;
    }

    async listModels(filters?: {
      projectId?: string;
      category?: ModelCategory;
      provider?: ModelProviderType;
      providerKey?: string;
      providerDriver?: string;
    }): Promise<IModel[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.category) { clauses.push('category = @category'); params.category = filters.category; }
      if (filters?.provider) { clauses.push('provider = @provider'); params.provider = filters.provider; }
      if (filters?.providerKey) { clauses.push('providerKey = @providerKey'); params.providerKey = filters.providerKey; }
      if (filters?.providerDriver) { clauses.push('providerDriver = @providerDriver'); params.providerDriver = filters.providerDriver; }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM ${TABLES.models} ${where} ORDER BY createdAt DESC`)
        .all(params) as SqliteRow[];
      return rows.map((r) => this.mapModelRow(r));
    }

    async findModelById(id: string, projectId?: string): Promise<IModel | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.models} WHERE id = @id`;
      const params: Record<string, unknown> = { id };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapModelRow(row) : null;
    }

    async findModelByKey(key: string, projectId?: string): Promise<IModel | null> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.models} WHERE key = @key`;
      const params: Record<string, unknown> = { key };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapModelRow(row) : null;
    }

    // ── Usage logs ──────────────────────────────────────────────────

    async createModelUsageLog(log: Omit<IModelUsageLog, '_id' | 'createdAt'>): Promise<IModelUsageLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.modelUsageLogs}
        (id, tenantId, projectId, modelKey, modelId, requestId, route, status,
         providerRequest, providerResponse, errorMessage, latencyMs,
         inputTokens, outputTokens, cachedInputTokens, totalTokens, toolCalls, cacheHit, pricingSnapshot, createdAt)
        VALUES (@id, @tenantId, @projectId, @modelKey, @modelId, @requestId, @route, @status,
         @providerRequest, @providerResponse, @errorMessage, @latencyMs,
         @inputTokens, @outputTokens, @cachedInputTokens, @totalTokens, @toolCalls, @cacheHit, @pricingSnapshot, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        modelKey: log.modelKey,
        modelId: log.modelId ?? null,
        requestId: log.requestId,
        route: log.route,
        status: log.status,
        providerRequest: this.toJson(log.providerRequest),
        providerResponse: this.toJson(log.providerResponse),
        errorMessage: log.errorMessage ?? null,
        latencyMs: log.latencyMs ?? null,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        cachedInputTokens: log.cachedInputTokens ?? 0,
        totalTokens: log.totalTokens,
        toolCalls: log.toolCalls ?? 0,
        cacheHit: this.toBoolInt(log.cacheHit),
        pricingSnapshot: log.pricingSnapshot ? this.toJson(log.pricingSnapshot) : null,
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listModelUsageLogs(
      modelKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
      projectId?: string,
    ): Promise<IModelUsageLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['modelKey = @modelKey'];
      const params: Record<string, unknown> = { modelKey };

      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const where = `WHERE ${clauses.join(' AND ')}`;

      const rows = db.prepare(
        `SELECT * FROM ${TABLES.modelUsageLogs} ${where} ORDER BY createdAt DESC LIMIT @limit OFFSET @skip`,
      ).all({ ...params, limit, skip }) as SqliteRow[];

      return rows.map((r) => this.mapUsageRow(r));
    }

    async aggregateModelUsage(
      modelKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
      projectId?: string,
    ): Promise<IModelUsageAggregate> {
      const db = this.getTenantDb();
      const clauses: string[] = ['modelKey = @modelKey'];
      const params: Record<string, unknown> = { modelKey };

      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      if (options?.from) { clauses.push('createdAt >= @from'); params.from = options.from.toISOString(); }
      if (options?.to) { clauses.push('createdAt <= @to'); params.to = options.to.toISOString(); }

      const where = `WHERE ${clauses.join(' AND ')}`;

      const agg = db.prepare(`
        SELECT
          COUNT(*) as totalCalls,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successCalls,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorCalls,
          SUM(inputTokens) as totalInputTokens,
          SUM(outputTokens) as totalOutputTokens,
          SUM(COALESCE(cachedInputTokens, 0)) as totalCachedInputTokens,
          SUM(totalTokens) as totalTokens,
          SUM(COALESCE(toolCalls, 0)) as totalToolCalls,
          SUM(CASE WHEN cacheHit = 1 THEN 1 ELSE 0 END) as cacheHits,
          SUM(CASE WHEN cacheHit = 0 OR cacheHit IS NULL THEN 1 ELSE 0 END) as cacheMisses,
          AVG(latencyMs) as avgLatencyMs
        FROM ${TABLES.modelUsageLogs} ${where}
      `).get(params) as SqliteRow;

      const result: IModelUsageAggregate = {
        modelKey,
        totalCalls: (agg.totalCalls as number) ?? 0,
        successCalls: (agg.successCalls as number) ?? 0,
        errorCalls: (agg.errorCalls as number) ?? 0,
        totalInputTokens: (agg.totalInputTokens as number) ?? 0,
        totalOutputTokens: (agg.totalOutputTokens as number) ?? 0,
        totalCachedInputTokens: (agg.totalCachedInputTokens as number) ?? 0,
        totalTokens: (agg.totalTokens as number) ?? 0,
        totalToolCalls: (agg.totalToolCalls as number) ?? 0,
        cacheHits: (agg.cacheHits as number) ?? 0,
        cacheMisses: (agg.cacheMisses as number) ?? 0,
        avgLatencyMs: (agg.avgLatencyMs as number) ?? null,
      };

      // Timeseries
      if (options?.groupBy) {
        const groupBy = options.groupBy;
        let strftime: string;
        if (groupBy === 'hour') strftime = '%Y-%m-%dT%H:00:00Z';
        else if (groupBy === 'month') strftime = '%Y-%m-01T00:00:00Z';
        else strftime = '%Y-%m-%dT00:00:00Z';

        const tsRows = db.prepare(`
          SELECT
            strftime('${strftime}', createdAt) as period,
            COUNT(*) as callCount,
            SUM(inputTokens) as inputTokens,
            SUM(outputTokens) as outputTokens,
            SUM(COALESCE(cachedInputTokens, 0)) as cachedInputTokens,
            SUM(totalTokens) as totalTokens,
            SUM(CASE WHEN cacheHit = 1 THEN 1 ELSE 0 END) as cacheHits
          FROM ${TABLES.modelUsageLogs} ${where}
          GROUP BY period
          ORDER BY period ASC
        `).all(params) as SqliteRow[];

        result.timeseries = tsRows.map((r) => ({
          period: r.period as string,
          callCount: (r.callCount as number) ?? 0,
          inputTokens: (r.inputTokens as number) ?? 0,
          outputTokens: (r.outputTokens as number) ?? 0,
          cachedInputTokens: (r.cachedInputTokens as number) ?? 0,
          totalTokens: (r.totalTokens as number) ?? 0,
          cacheHits: (r.cacheHits as number) ?? 0,
        }));
      }

      return result;
    }

    // ── Row mappers ──────────────────────────────────────────────────

    protected mapModelRow(r: SqliteRow): IModel {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        name: r.name as string,
        description: r.description as string | undefined,
        key: r.key as string,
        providerKey: r.providerKey as string,
        providerDriver: r.providerDriver as string,
        provider: r.provider as ModelProviderType | undefined,
        category: r.category as ModelCategory,
        modelId: r.modelId as string,
        isMultimodal: this.fromBoolInt(r.isMultimodal),
        supportsToolCalls: this.fromBoolInt(r.supportsToolCalls),
        settings: this.parseJson(r.settings, {}),
        pricing: this.parseJson(r.pricing, { inputTokenPer1M: 0, outputTokenPer1M: 0 }),
        semanticCache: r.semanticCache ? this.parseJson(r.semanticCache, undefined) : undefined,
        inputGuardrailKey: r.inputGuardrailKey as string | undefined,
        outputGuardrailKey: r.outputGuardrailKey as string | undefined,
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string | undefined,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapUsageRow(r: SqliteRow): IModelUsageLog {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        modelKey: r.modelKey as string,
        modelId: r.modelId as string | undefined,
        requestId: r.requestId as string,
        route: r.route as string,
        status: r.status as 'success' | 'error',
        providerRequest: this.parseJson(r.providerRequest, {}),
        providerResponse: this.parseJson(r.providerResponse, {}),
        errorMessage: r.errorMessage as string | undefined,
        latencyMs: r.latencyMs as number | undefined,
        inputTokens: (r.inputTokens as number) ?? 0,
        outputTokens: (r.outputTokens as number) ?? 0,
        cachedInputTokens: (r.cachedInputTokens as number) ?? 0,
        totalTokens: (r.totalTokens as number) ?? 0,
        toolCalls: (r.toolCalls as number) ?? 0,
        cacheHit: this.fromBoolInt(r.cacheHit),
        pricingSnapshot: r.pricingSnapshot ? this.parseJson(r.pricingSnapshot, undefined) : undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
