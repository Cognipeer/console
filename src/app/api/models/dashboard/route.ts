import { NextRequest, NextResponse } from 'next/server';
import { listModels, listModelProviders, getUsageAggregate } from '@/lib/services/models/modelService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('models-dashboard');

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const filter = parseDashboardDateFilterFromSearchParams(
      request.nextUrl.searchParams,
    );

    const [models, providers] = await Promise.all([
      listModels(tenantDbName, projectContext.projectId, {}),
      listModelProviders(tenantDbName, tenantId, projectContext.projectId, {}),
    ]);

    const aggregates = await Promise.all(
      models.map(async (model) => {
        try {
          const agg = await getUsageAggregate(
            tenantDbName,
            model.key,
            projectContext.projectId,
            {
              from: filter.from,
              to: filter.to,
              groupBy: 'day',
            },
          );
          return { model, agg };
        } catch {
          return { model, agg: null };
        }
      }),
    );

    const hasDateFilter = Boolean(filter.from || filter.to);

    const scopedAggregates = hasDateFilter
      ? aggregates.filter(({ model, agg }) => {
          if (isDateInDashboardRange(model.createdAt, filter)) {
            return true;
          }
          return Boolean(agg && agg.totalCalls > 0);
        })
      : aggregates;

    const scopedModels = scopedAggregates.map((item) => item.model);

    const topModels = scopedAggregates
      .filter((item) => item.agg && item.agg.totalCalls > 0)
      .map(({ model, agg }) => ({
        key: model.key,
        name: model.name,
        category: model.category,
        callCount: agg!.totalCalls,
        totalTokens: agg!.totalTokens,
        totalCost: agg!.costSummary?.totalCost ?? 0,
        errorRate: agg!.totalCalls > 0 ? agg!.errorCalls / agg!.totalCalls : 0,
        avgLatencyMs: agg!.avgLatencyMs,
      }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    let totalCalls = 0, successCalls = 0, errorCalls = 0;
    let totalInputTokens = 0, totalOutputTokens = 0, totalTokens = 0;
    let totalToolCalls = 0, cacheHits = 0, totalCost = 0;
    let latencySum = 0, latencyCount = 0;
    const dailyMap = new Map<string, { callCount: number; totalTokens: number }>();

    for (const { agg } of scopedAggregates) {
      if (!agg) continue;
      totalCalls += agg.totalCalls;
      successCalls += agg.successCalls;
      errorCalls += agg.errorCalls;
      totalInputTokens += agg.totalInputTokens;
      totalOutputTokens += agg.totalOutputTokens;
      totalTokens += agg.totalTokens;
      totalToolCalls += agg.totalToolCalls;
      cacheHits += agg.cacheHits;
      totalCost += agg.costSummary?.totalCost ?? 0;
      if (agg.avgLatencyMs !== null && agg.avgLatencyMs !== undefined) {
        latencySum += agg.avgLatencyMs * agg.totalCalls;
        latencyCount += agg.totalCalls;
      }
      for (const row of agg.timeseries ?? []) {
        const key = row.period.slice(0, 10);
        const existing = dailyMap.get(key) ?? { callCount: 0, totalTokens: 0 };
        dailyMap.set(key, {
          callCount: existing.callCount + row.callCount,
          totalTokens: existing.totalTokens + row.totalTokens,
        });
      }
    }

    const avgLatencyMs = latencyCount > 0 ? Math.round(latencySum / latencyCount) : null;
    const cacheHitRate = totalCalls > 0 ? cacheHits / totalCalls : 0;
    const errorRate = totalCalls > 0 ? errorCalls / totalCalls : 0;
    const daily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-14)
      .map(([period, data]) => ({ period, ...data }));

    const scopedProviderKeys = new Set(scopedModels.map((model) => model.providerKey));
    const scopedProviderCount = hasDateFilter
      ? providers.filter((provider) => scopedProviderKeys.has(provider.key)).length
      : providers.length;

    return NextResponse.json({
      overview: {
        totalModels: scopedModels.length,
        llmCount: scopedModels.filter((m) => m.category === 'llm').length,
        embeddingCount: scopedModels.filter((m) => m.category === 'embedding').length,
        providerCount: scopedProviderCount,
        totalCalls, successCalls, errorCalls,
        totalInputTokens, totalOutputTokens, totalTokens,
        totalToolCalls, cacheHits, cacheHitRate,
        avgLatencyMs, totalCost, currency: 'USD', errorRate,
      },
      topModels,
      daily,
    });
  } catch (error: unknown) {
    logger.error('Dashboard error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
