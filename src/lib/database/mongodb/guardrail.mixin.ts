/**
 * MongoDB Provider – Guardrail operations mixin
 *
 * Includes guardrail CRUD, evaluation logs listing, and aggregation.
 */

import { ObjectId } from 'mongodb';
import type { IGuardrail, IGuardrailEvaluationLog, GuardrailType } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function GuardrailMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class GuardrailOps extends Base {
    // ── Guardrail CRUD ───────────────────────────────────────────────

    async createGuardrail(
      guardrail: Omit<IGuardrail, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGuardrail> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...guardrail, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.guardrails)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateGuardrail(
      id: string,
      data: Partial<Omit<IGuardrail, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IGuardrail>(COLLECTIONS.guardrails)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IGuardrail;
    }

    async deleteGuardrail(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.guardrails)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findGuardrailById(id: string): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.guardrails)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IGuardrail | null;
    }

    async findGuardrailByKey(key: string, projectId?: string): Promise<IGuardrail | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.guardrails)
        .findOne(filter);
      return doc as unknown as IGuardrail | null;
    }

    async listGuardrails(filters?: {
      projectId?: string;
      type?: GuardrailType;
      enabled?: boolean;
      search?: string;
    }): Promise<IGuardrail[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.type !== undefined) filter.type = filters.type;
      if (filters?.enabled !== undefined) filter.enabled = filters.enabled;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.guardrails)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IGuardrail[];
    }

    // ── Guardrail evaluation logs ────────────────────────────────────

    async listGuardrailEvaluationLogs(
      guardrailId: string,
      options?: { limit?: number; skip?: number; from?: Date; to?: Date; passed?: boolean },
    ) {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { guardrailId };
      if (options?.passed !== undefined) filter.passed = options.passed;
      if (options?.from || options?.to) {
        filter.createdAt = {};
        if (options.from) (filter.createdAt as Record<string, unknown>).$gte = options.from;
        if (options.to) (filter.createdAt as Record<string, unknown>).$lte = options.to;
      }
      const docs = await db
        .collection(COLLECTIONS.guardrailEvalLogs)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IGuardrailEvaluationLog[];
    }

    async aggregateGuardrailEvaluations(
      guardrailId: string,
      options?: { from?: Date; to?: Date; groupBy?: 'hour' | 'day' | 'month' },
    ) {
      const db = this.getTenantDb();
      const matchStage: Record<string, unknown> = { guardrailId };
      if (options?.from || options?.to) {
        matchStage.createdAt = {};
        if (options?.from) (matchStage.createdAt as Record<string, unknown>).$gte = options.from;
        if (options?.to) (matchStage.createdAt as Record<string, unknown>).$lte = options.to;
      }

      // Aggregate totals
      const pipeline = [
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalEvaluations: { $sum: 1 },
            passedCount: { $sum: { $cond: ['$passed', 1, 0] } },
            failedCount: { $sum: { $cond: ['$passed', 0, 1] } },
            avgLatencyMs: { $avg: '$latencyMs' },
          },
        },
      ];
      const [totals] = await db.collection(COLLECTIONS.guardrailEvalLogs).aggregate(pipeline).toArray();

      // Aggregate findings by type and severity
      const findPipeline = [
        { $match: { ...matchStage, passed: false } },
        { $unwind: '$findings' },
        {
          $facet: {
            byType: [{ $group: { _id: '$findings.type', count: { $sum: 1 } } }],
            bySeverity: [{ $group: { _id: '$findings.severity', count: { $sum: 1 } } }],
          },
        },
      ];
      const [findingAgg] = await db.collection(COLLECTIONS.guardrailEvalLogs).aggregate(findPipeline).toArray();

      const findingsByType: Record<string, number> = {};
      const findingsBySeverity: Record<string, number> = {};
      for (const r of (findingAgg?.byType || [])) findingsByType[r._id as string] = r.count as number;
      for (const r of (findingAgg?.bySeverity || [])) findingsBySeverity[r._id as string] = r.count as number;

      // Time series
      const groupBy = options?.groupBy || 'day';
      const dateFormat = groupBy === 'hour' ? '%Y-%m-%dT%H:00' : groupBy === 'month' ? '%Y-%m' : '%Y-%m-%d';
      const tsPipeline = [
        { $match: matchStage },
        {
          $group: {
            _id: { $dateToString: { format: dateFormat, date: '$createdAt' } },
            total: { $sum: 1 },
            passed: { $sum: { $cond: ['$passed', 1, 0] } },
            failed: { $sum: { $cond: ['$passed', 0, 1] } },
          },
        },
        { $sort: { _id: 1 } },
      ];
      const tsResults = await db.collection(COLLECTIONS.guardrailEvalLogs).aggregate(tsPipeline).toArray();
      const timeseries = tsResults.map((r) => ({
        period: r._id as string,
        total: r.total as number,
        passed: r.passed as number,
        failed: r.failed as number,
      }));

      const totalEvaluations = (totals?.totalEvaluations as number) || 0;
      const passedCount = (totals?.passedCount as number) || 0;
      return {
        guardrailId,
        totalEvaluations,
        passedCount,
        failedCount: (totals?.failedCount as number) || 0,
        passRate: totalEvaluations > 0 ? Math.round((passedCount / totalEvaluations) * 100) : 0,
        avgLatencyMs: (totals?.avgLatencyMs as number) ?? null,
        findingsByType,
        findingsBySeverity,
        timeseries,
      };
    }
  };
}
