/**
 * Dynamic LLM routing analytics: what a router actually spent, what the same
 * traffic would have cost on its baseline model, and how each route, model,
 * guard and shadow decision contributed.
 *
 * Built from the attribution the router writes onto the rows it causes
 * (`routing.role` = `child` | `decider`), so the router's own zero-priced
 * decision rows never enter the sums and nothing is counted twice.
 */

import { getDatabase, type IModel, type IModelUsageLog } from '@/lib/database';

export interface RoutingAnalyticsTotals {
  requests: number;
  errors: number;
  /** Child + decider spend. */
  costUsd: number;
  deciderCostUsd: number;
  deciderCalls: number;
  /** The same child usage priced at the baseline model. */
  baselineCostUsd: number;
  /** baseline − (child + decider). Negative means the router costs more. */
  savingsUsd: number;
  savingsPct: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Responses cut off by the output limit — a quality proxy for cheap routes. */
  lengthStops: number;
  fallbacks: number;
  defaults: number;
  guardTrips: number;
  avgLatencyMs: number | null;
  /**
   * Weighted absolute % error of the decision-time cost estimate vs realized
   * cost (Σ|est − actual| / Σactual). Weighted, not a per-request mean: a
   * one-token reply against a 512-token assumption would otherwise dominate.
   */
  costEstimateErrorPct: number | null;
}

export interface RoutingAnalyticsModelRow {
  modelKey: string;
  requests: number;
  errors: number;
  costUsd: number;
  baselineCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  lengthStops: number;
  avgLatencyMs: number | null;
}

export interface RoutingAnalyticsRouteRow {
  route: string;
  decision: string;
  policy?: string;
  requests: number;
  errors: number;
  costUsd: number;
  baselineCostUsd: number;
  savingsUsd: number;
  lengthStops: number;
  models: Record<string, number>;
}

export interface RoutingAnalyticsShadowRow {
  actualModelKey: string;
  proposedModelKey: string;
  requests: number;
  actualCostUsd: number;
  /** Decision-time estimates of both sides, for an apples-to-apples comparison. */
  actualEstimatedCostUsd: number;
  proposedEstimatedCostUsd: number;
  estimatedSavingsUsd: number;
}

export interface RoutingAnalytics {
  from: string;
  to: string;
  /** True when the window held more rows than were read. */
  truncated: boolean;
  rowsRead: number;
  totals: RoutingAnalyticsTotals;
  byModel: RoutingAnalyticsModelRow[];
  byRoute: RoutingAnalyticsRouteRow[];
  byGuard: Array<{ guard: string; requests: number }>;
  shadow: RoutingAnalyticsShadowRow[];
  daily: Array<{ day: string; requests: number; costUsd: number; baselineCostUsd: number }>;
}

const MAX_ROWS = 10_000;

function rowCost(log: IModelUsageLog): number {
  return log.pricingSnapshot?.totalCost ?? 0;
}

function routeLabel(log: IModelUsageLog): string {
  const routing = log.routing;
  if (!routing) return 'unknown';
  if (routing.matchedRuleLabel) return `rule:${routing.matchedRuleLabel}`;
  if (routing.deciderLabel) return `label:${routing.deciderLabel}`;
  return routing.decision === 'fallback' ? 'fallback' : 'default';
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Pure aggregation over routed rows (exported for tests). */
export function summarizeRoutedUsage(
  logs: IModelUsageLog[],
  window: { from: Date; to: Date },
  truncated = false,
): RoutingAnalytics {
  const totals: RoutingAnalyticsTotals = {
    requests: 0,
    errors: 0,
    costUsd: 0,
    deciderCostUsd: 0,
    deciderCalls: 0,
    baselineCostUsd: 0,
    savingsUsd: 0,
    savingsPct: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    lengthStops: 0,
    fallbacks: 0,
    defaults: 0,
    guardTrips: 0,
    avgLatencyMs: null,
    costEstimateErrorPct: null,
  };
  const byModel = new Map<string, RoutingAnalyticsModelRow & { latencySum: number; latencyN: number }>();
  const byRoute = new Map<string, RoutingAnalyticsRouteRow>();
  const byGuard = new Map<string, number>();
  const shadow = new Map<string, RoutingAnalyticsShadowRow>();
  const daily = new Map<string, { day: string; requests: number; costUsd: number; baselineCostUsd: number }>();
  let latencySum = 0;
  let latencyN = 0;
  let estimateAbsError = 0;
  let estimateActual = 0;

  for (const log of logs) {
    const routing = log.routing;
    if (!routing) continue;
    const cost = rowCost(log);

    if (routing.role === 'decider') {
      totals.deciderCalls += 1;
      totals.deciderCostUsd += cost;
      totals.costUsd += cost;
      continue;
    }
    if (routing.role !== 'child') continue;

    const failed = log.status === 'error';
    const lengthStop = log.finishReason === 'length';
    const baseline = routing.baselineCostUsd ?? 0;
    totals.requests += 1;
    totals.costUsd += cost;
    totals.baselineCostUsd += baseline;
    totals.inputTokens += log.inputTokens ?? 0;
    totals.outputTokens += log.outputTokens ?? 0;
    totals.cachedInputTokens += log.cachedInputTokens ?? 0;
    if (failed) totals.errors += 1;
    if (lengthStop) totals.lengthStops += 1;
    if (routing.decision === 'fallback') totals.fallbacks += 1;
    if (routing.decision === 'default') totals.defaults += 1;
    if (routing.guard) {
      totals.guardTrips += 1;
      byGuard.set(routing.guard, (byGuard.get(routing.guard) ?? 0) + 1);
    }
    if (typeof log.latencyMs === 'number') {
      latencySum += log.latencyMs;
      latencyN += 1;
    }
    if (!failed && routing.estimatedCostUsd !== undefined && cost > 0) {
      estimateAbsError += Math.abs(routing.estimatedCostUsd - cost);
      estimateActual += cost;
    }

    const model = byModel.get(log.modelKey) ?? {
      modelKey: log.modelKey,
      requests: 0,
      errors: 0,
      costUsd: 0,
      baselineCostUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      lengthStops: 0,
      avgLatencyMs: null,
      latencySum: 0,
      latencyN: 0,
    };
    model.requests += 1;
    model.costUsd += cost;
    model.baselineCostUsd += baseline;
    model.inputTokens += log.inputTokens ?? 0;
    model.outputTokens += log.outputTokens ?? 0;
    model.cachedInputTokens += log.cachedInputTokens ?? 0;
    if (failed) model.errors += 1;
    if (lengthStop) model.lengthStops += 1;
    if (typeof log.latencyMs === 'number') {
      model.latencySum += log.latencyMs;
      model.latencyN += 1;
    }
    byModel.set(log.modelKey, model);

    const label = routeLabel(log);
    const route = byRoute.get(label) ?? {
      route: label,
      decision: routing.decision,
      ...(routing.policy ? { policy: routing.policy } : {}),
      requests: 0,
      errors: 0,
      costUsd: 0,
      baselineCostUsd: 0,
      savingsUsd: 0,
      lengthStops: 0,
      models: {},
    };
    route.requests += 1;
    route.costUsd += cost;
    route.baselineCostUsd += baseline;
    if (failed) route.errors += 1;
    if (lengthStop) route.lengthStops += 1;
    route.models[log.modelKey] = (route.models[log.modelKey] ?? 0) + 1;
    byRoute.set(label, route);

    if (routing.mode === 'shadow' && routing.shadow?.chosenModelKey) {
      const k = `${log.modelKey}→${routing.shadow.chosenModelKey}`;
      const row = shadow.get(k) ?? {
        actualModelKey: log.modelKey,
        proposedModelKey: routing.shadow.chosenModelKey,
        requests: 0,
        actualCostUsd: 0,
        actualEstimatedCostUsd: 0,
        proposedEstimatedCostUsd: 0,
        estimatedSavingsUsd: 0,
      };
      row.requests += 1;
      row.actualCostUsd += cost;
      if (routing.estimatedCostUsd !== undefined && routing.shadow.estimatedCostUsd !== undefined) {
        row.actualEstimatedCostUsd += routing.estimatedCostUsd;
        row.proposedEstimatedCostUsd += routing.shadow.estimatedCostUsd;
      }
      shadow.set(k, row);
    }

    const created = log.createdAt ? new Date(log.createdAt) : null;
    if (created && !Number.isNaN(created.getTime())) {
      const day = created.toISOString().slice(0, 10);
      const point = daily.get(day) ?? { day, requests: 0, costUsd: 0, baselineCostUsd: 0 };
      point.requests += 1;
      point.costUsd += cost;
      point.baselineCostUsd += baseline;
      daily.set(day, point);
    }
  }

  totals.savingsUsd = totals.baselineCostUsd - totals.costUsd;
  totals.savingsPct =
    totals.baselineCostUsd > 0 ? (totals.savingsUsd / totals.baselineCostUsd) * 100 : null;
  totals.avgLatencyMs = latencyN > 0 ? latencySum / latencyN : null;
  totals.costEstimateErrorPct = estimateActual > 0 ? (estimateAbsError / estimateActual) * 100 : null;
  for (const key of ['costUsd', 'deciderCostUsd', 'baselineCostUsd', 'savingsUsd'] as const) {
    totals[key] = round(totals[key]);
  }

  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    truncated,
    rowsRead: logs.length,
    totals,
    byModel: [...byModel.values()]
      .map(({ latencySum: sum, latencyN: n, ...row }) => ({
        ...row,
        costUsd: round(row.costUsd),
        baselineCostUsd: round(row.baselineCostUsd),
        avgLatencyMs: n > 0 ? sum / n : null,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    byRoute: [...byRoute.values()]
      .map((row) => ({
        ...row,
        costUsd: round(row.costUsd),
        baselineCostUsd: round(row.baselineCostUsd),
        savingsUsd: round(row.baselineCostUsd - row.costUsd),
      }))
      .sort((a, b) => b.requests - a.requests),
    byGuard: [...byGuard.entries()]
      .map(([guard, requests]) => ({ guard, requests }))
      .sort((a, b) => b.requests - a.requests),
    shadow: [...shadow.values()]
      .map((row) => ({
        ...row,
        actualCostUsd: round(row.actualCostUsd),
        actualEstimatedCostUsd: round(row.actualEstimatedCostUsd),
        proposedEstimatedCostUsd: round(row.proposedEstimatedCostUsd),
        estimatedSavingsUsd: round(row.actualEstimatedCostUsd - row.proposedEstimatedCostUsd),
      }))
      .sort((a, b) => b.requests - a.requests),
    daily: [...daily.values()]
      .map((point) => ({ ...point, costUsd: round(point.costUsd), baselineCostUsd: round(point.baselineCostUsd) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

export async function getRoutingAnalytics(
  tenantDbName: string,
  router: IModel,
  projectId: string,
  window: { from: Date; to: Date },
): Promise<RoutingAnalytics> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const logs = await db.listRoutedUsageLogs(
    router.key,
    { from: window.from, to: window.to, limit: MAX_ROWS + 1 },
    projectId,
  );
  const truncated = logs.length > MAX_ROWS;
  return summarizeRoutedUsage(truncated ? logs.slice(0, MAX_ROWS) : logs, window, truncated);
}
