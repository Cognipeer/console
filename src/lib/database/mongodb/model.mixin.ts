/**
 * MongoDB Provider – Model operations mixin
 *
 * Includes model CRUD, usage logging, and usage aggregation.
 */

import { ObjectId } from 'mongodb';
import type {
  IModel,
  IModelUsageLog,
  IModelUsageAggregate,
  IModelUsageCostSnapshot,
  ModelCategory,
  ModelProviderType,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function ModelMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ModelOps extends Base {
    // ── Model CRUD ───────────────────────────────────────────────────

    async createModel(
      model: Omit<IModel, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IModel> {
      const db = this.getTenantDb();
      const now = new Date();
      const pricing = {
        currency: model.pricing.currency || 'USD',
        inputTokenPer1M: model.pricing.inputTokenPer1M,
        outputTokenPer1M: model.pricing.outputTokenPer1M,
        cachedTokenPer1M: model.pricing.cachedTokenPer1M ?? 0,
      };

      const modelDoc = {
        ...model,
        provider: model.provider ?? (model.providerDriver as ModelProviderType | undefined),
        pricing,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db.collection(COLLECTIONS.models).insertOne(modelDoc);

      return {
        ...modelDoc,
        _id: result.insertedId.toString(),
      };
    }

    async updateModel(id: string, data: Partial<IModel>): Promise<IModel | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = {
        ...data,
        updatedAt: new Date(),
      };
      delete updateData._id;

      const pricing = data.pricing;
      if (pricing) {
        updateData.pricing = {
          currency: pricing.currency || 'USD',
          inputTokenPer1M: pricing.inputTokenPer1M,
          outputTokenPer1M: pricing.outputTokenPer1M,
          cachedTokenPer1M: pricing.cachedTokenPer1M ?? 0,
        };
      }

      if (data.providerDriver !== undefined && data.provider === undefined) {
        updateData.provider = data.providerDriver as ModelProviderType;
      }

      const result = await db
        .collection<IModel>(COLLECTIONS.models)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      return {
        ...result,
        _id: result._id?.toString(),
      } as IModel;
    }

    async deleteModel(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.models)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async listModels(filters?: {
      projectId?: string;
      category?: ModelCategory;
      provider?: ModelProviderType;
      providerKey?: string;
      providerDriver?: string;
    }): Promise<IModel[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};

      if (filters?.projectId) {
        query.projectId = filters.projectId;
      }

      if (filters?.category) {
        query.category = filters.category;
      }

      if (filters?.provider) {
        query.provider = filters.provider;
      }

      if (filters?.providerKey) {
        query.providerKey = filters.providerKey;
      }

      if (filters?.providerDriver) {
        query.providerDriver = filters.providerDriver;
      }

      const models = await db
        .collection<IModel>(COLLECTIONS.models)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      return models.map((model) => ({
        ...model,
        _id: model._id?.toString(),
      }));
    }

    async findModelById(id: string, projectId?: string): Promise<IModel | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { _id: new ObjectId(id) };
      if (projectId) {
        query.projectId = projectId;
      }
      const model = await db
        .collection<IModel>(COLLECTIONS.models)
        .findOne(query);
      if (!model) {
        return null;
      }

      return {
        ...model,
        _id: model._id?.toString(),
      } as IModel;
    }

    async findModelByKey(key: string, projectId?: string): Promise<IModel | null> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { key };
      if (projectId) {
        query.projectId = projectId;
      }
      const model = await db.collection<IModel>(COLLECTIONS.models).findOne(query);
      if (!model) {
        return null;
      }

      return {
        ...model,
        _id: model._id?.toString(),
      } as IModel;
    }

    // ── Usage logging ────────────────────────────────────────────────

    async createModelUsageLog(
      log: Omit<IModelUsageLog, '_id' | 'createdAt'>,
    ): Promise<IModelUsageLog> {
      const db = this.getTenantDb();
      const now = new Date();
      const logDoc = {
        ...log,
        createdAt: now,
      };

      const result = await db.collection(COLLECTIONS.modelUsageLogs).insertOne(logDoc);

      return {
        ...logDoc,
        _id: result.insertedId.toString(),
      };
    }

    async listModelUsageLogs(
      modelKey: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date },
      projectId?: string,
    ): Promise<IModelUsageLog[]> {
      const db = this.getTenantDb();
      const query: {
        modelKey: string;
        projectId?: string;
        createdAt?: { $gte?: Date; $lte?: Date };
      } = { modelKey };

      if (projectId) {
        query.projectId = projectId;
      }

      if (options?.from || options?.to) {
        query.createdAt = {};
        if (options.from) {
          query.createdAt.$gte = options.from;
        }
        if (options.to) {
          query.createdAt.$lte = options.to;
        }
      }

      const limit = Math.min(options?.limit ?? 50, 200);
      const skip = options?.skip ?? 0;

      const logs = await db
        .collection<IModelUsageLog>(COLLECTIONS.modelUsageLogs)
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      return logs.map((logDoc) => ({
        ...logDoc,
        _id: logDoc._id?.toString(),
      }));
    }

    // ── Usage aggregation ────────────────────────────────────────────

    async aggregateModelUsage(
      modelKey: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
      projectId?: string,
    ): Promise<IModelUsageAggregate> {
      const db = this.getTenantDb();
      const match: {
        modelKey: string;
        projectId?: string;
        createdAt?: { $gte?: Date; $lte?: Date };
      } = { modelKey };

      if (projectId) {
        match.projectId = projectId;
      }

      if (options?.from || options?.to) {
        match.createdAt = {};
        if (options.from) {
          match.createdAt.$gte = options.from;
        }
        if (options.to) {
          match.createdAt.$lte = options.to;
        }
      }

      const totals = await db
        .collection(COLLECTIONS.modelUsageLogs)
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: null,
              totalCalls: { $sum: 1 },
              successCalls: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'success'] }, 1, 0],
                },
              },
              errorCalls: {
                $sum: {
                  $cond: [{ $eq: ['$status', 'error'] }, 1, 0],
                },
              },
              totalInputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              totalOutputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              totalCachedInputTokens: {
                $sum: { $ifNull: ['$cachedInputTokens', 0] },
              },
              totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
              totalToolCalls: { $sum: { $ifNull: ['$toolCalls', 0] } },
              cacheHits: {
                $sum: {
                  $cond: [{ $eq: ['$cacheHit', true] }, 1, 0],
                },
              },
              cacheMisses: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$status', 'success'] }, { $ne: ['$cacheHit', true] }] },
                    1,
                    0,
                  ],
                },
              },
              avgLatencyMs: { $avg: '$latencyMs' },
              totalCost: { $sum: { $ifNull: ['$pricingSnapshot.totalCost', 0] } },
              currency: { $first: '$pricingSnapshot.currency' },
              inputCost: { $sum: { $ifNull: ['$pricingSnapshot.inputCost', 0] } },
              outputCost: {
                $sum: { $ifNull: ['$pricingSnapshot.outputCost', 0] },
              },
              cachedCost: {
                $sum: { $ifNull: ['$pricingSnapshot.cachedCost', 0] },
              },
            },
          },
        ])
        .toArray();

      const totalsDoc = totals[0] ?? {
        totalCalls: 0,
        successCalls: 0,
        errorCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCachedInputTokens: 0,
        totalTokens: 0,
        totalToolCalls: 0,
        cacheHits: 0,
        cacheMisses: 0,
        avgLatencyMs: null,
        totalCost: 0,
        currency: 'USD',
        inputCost: 0,
        outputCost: 0,
        cachedCost: 0,
      };

      const unit = options?.groupBy ?? 'day';
      const timeseriesDocs = await db
        .collection(COLLECTIONS.modelUsageLogs)
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateTrunc: {
                  date: '$createdAt',
                  unit,
                },
              },
              callCount: { $sum: 1 },
              inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
              outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
              cachedInputTokens: { $sum: { $ifNull: ['$cachedInputTokens', 0] } },
              totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
              totalCost: { $sum: { $ifNull: ['$pricingSnapshot.totalCost', 0] } },
              cacheHits: {
                $sum: {
                  $cond: [{ $eq: ['$cacheHit', true] }, 1, 0],
                },
              },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray();

      const timeseries = timeseriesDocs.map((doc) => {
        const record = doc as Record<string, unknown>;
        const periodValue = record._id;
        return {
          period: periodValue instanceof Date ? periodValue.toISOString() : String(periodValue),
          callCount: Number(record.callCount ?? 0),
          inputTokens: Number(record.inputTokens ?? 0),
          outputTokens: Number(record.outputTokens ?? 0),
          cachedInputTokens: Number(record.cachedInputTokens ?? 0),
          totalTokens: Number(record.totalTokens ?? 0),
          totalCost: Number(record.totalCost ?? 0),
          cacheHits: Number(record.cacheHits ?? 0),
        };
      });

      const costSummary: IModelUsageCostSnapshot | undefined = totalsDoc.totalCost
        ? {
            currency: totalsDoc.currency || 'USD',
            totalCost: totalsDoc.totalCost ?? 0,
            inputCost: totalsDoc.inputCost ?? 0,
            outputCost: totalsDoc.outputCost ?? 0,
            cachedCost: totalsDoc.cachedCost ?? 0,
          }
        : undefined;

      return {
        modelKey,
        totalCalls: totalsDoc.totalCalls ?? 0,
        successCalls: totalsDoc.successCalls ?? 0,
        errorCalls: totalsDoc.errorCalls ?? 0,
        totalInputTokens: totalsDoc.totalInputTokens ?? 0,
        totalOutputTokens: totalsDoc.totalOutputTokens ?? 0,
        totalCachedInputTokens: totalsDoc.totalCachedInputTokens ?? 0,
        totalTokens: totalsDoc.totalTokens ?? 0,
        totalToolCalls: totalsDoc.totalToolCalls ?? 0,
        cacheHits: totalsDoc.cacheHits ?? 0,
        cacheMisses: totalsDoc.cacheMisses ?? 0,
        avgLatencyMs: totalsDoc.avgLatencyMs ?? null,
        costSummary,
        timeseries,
      };
    }
  };
}
