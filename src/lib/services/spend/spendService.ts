/**
 * Spend reporting service.
 *
 * Rolls the per-model usage logs up into a tenant/project-level spend report
 * (totals, per-model breakdown, merged timeseries). Budget *enforcement*
 * lives in the quota guard (`checkBudget`); this module is the read side:
 * what was spent, and how close each budget window is to its limit.
 */

import { getDatabase } from '@/lib/database';
import type { IModel, IModelUsageAggregate } from '@/lib/database';
import { listModels } from '@/lib/services/models/modelService';

export interface SpendContext {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
}

export interface SpendReportOptions {
  from?: Date;
  to?: Date;
  groupBy?: 'hour' | 'day' | 'month';
  /** Restrict the report to a single model key. */
  modelKey?: string;
}

export interface ModelSpendEntry {
  modelKey: string;
  modelName?: string;
  category?: string;
  providerKey?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  currency: string;
}

export interface SpendTimeseriesPoint {
  period: string;
  calls: number;
  totalTokens: number;
  cost: number;
}

export interface SpendReport {
  from?: Date;
  to?: Date;
  groupBy: 'hour' | 'day' | 'month';
  currency: string;
  totalCost: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  byModel: ModelSpendEntry[];
  timeseries: SpendTimeseriesPoint[];
}

function toEntry(model: IModel, aggregate: IModelUsageAggregate): ModelSpendEntry {
  return {
    modelKey: model.key,
    modelName: model.name,
    category: model.category,
    providerKey: model.providerKey,
    calls: aggregate.totalCalls,
    inputTokens: aggregate.totalInputTokens,
    outputTokens: aggregate.totalOutputTokens,
    totalTokens: aggregate.totalTokens,
    cost: aggregate.costSummary?.totalCost ?? 0,
    currency: aggregate.costSummary?.currency ?? 'USD',
  };
}

export async function getSpendReport(
  ctx: SpendContext,
  options?: SpendReportOptions,
): Promise<SpendReport> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const groupBy = options?.groupBy ?? 'day';
  let models = await listModels(ctx.tenantDbName, ctx.projectId ?? '', {});
  if (options?.modelKey) {
    models = models.filter((model) => model.key === options.modelKey);
  }

  const byModel: ModelSpendEntry[] = [];
  const periods = new Map<string, SpendTimeseriesPoint>();

  for (const model of models) {
    const aggregate = await db.aggregateModelUsage(
      model.key,
      { from: options?.from, to: options?.to, groupBy },
      ctx.projectId,
    );
    if (aggregate.totalCalls === 0) continue;
    byModel.push(toEntry(model, aggregate));

    for (const point of aggregate.timeseries ?? []) {
      const existing = periods.get(point.period) ?? {
        period: point.period,
        calls: 0,
        totalTokens: 0,
        cost: 0,
      };
      existing.calls += point.callCount;
      existing.totalTokens += point.totalTokens;
      existing.cost += point.totalCost ?? 0;
      periods.set(point.period, existing);
    }
  }

  byModel.sort((a, b) => b.cost - a.cost);
  const timeseries = [...periods.values()].sort((a, b) => a.period.localeCompare(b.period));

  return {
    from: options?.from,
    to: options?.to,
    groupBy,
    currency: byModel[0]?.currency ?? 'USD',
    totalCost: byModel.reduce((sum, entry) => sum + entry.cost, 0),
    totalCalls: byModel.reduce((sum, entry) => sum + entry.calls, 0),
    totalInputTokens: byModel.reduce((sum, entry) => sum + entry.inputTokens, 0),
    totalOutputTokens: byModel.reduce((sum, entry) => sum + entry.outputTokens, 0),
    totalTokens: byModel.reduce((sum, entry) => sum + entry.totalTokens, 0),
    byModel,
    timeseries,
  };
}
