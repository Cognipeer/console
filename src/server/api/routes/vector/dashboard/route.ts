import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  listVectorProviders,
  listVectorIndexes,
} from '@/lib/services/vector/vectorService';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('vector-dashboard');

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

    const providers = await listVectorProviders(
      tenantDbName,
      tenantId,
      projectContext.projectId,
      {},
    );

    const indexesByProvider = await Promise.all(
      providers.map(async (provider) => {
        try {
          const indexes = await listVectorIndexes(
            tenantDbName,
            tenantId,
            provider.key,
            projectContext.projectId,
          );
          const scopedIndexes = indexes.filter((index) =>
            isDateInDashboardRange(index.createdAt, filter),
          );
          return { provider, indexes: scopedIndexes };
        } catch {
          return { provider, indexes: [] };
        }
      }),
    );

    const hasDateFilter = Boolean(filter.from || filter.to);
    const providersWithIndexes = new Set(
      indexesByProvider
        .filter((item) => item.indexes.length > 0)
        .map((item) => item.provider.key),
    );

    const scopedProviders = hasDateFilter
      ? providers.filter(
          (provider) =>
            isDateInDashboardRange(provider.createdAt, filter) ||
            providersWithIndexes.has(provider.key),
        )
      : providers;

    const scopedProviderKeys = new Set(scopedProviders.map((provider) => provider.key));
    const scopedIndexesByProvider = indexesByProvider.filter((item) =>
      scopedProviderKeys.has(item.provider.key),
    );

    const allIndexes = scopedIndexesByProvider.flatMap((item) => item.indexes);
    const totalIndexes = allIndexes.length;

    const activeProviders = scopedProviders.filter((p) => p.status === 'active').length;
    const disabledProviders = scopedProviders.filter((p) => p.status === 'disabled').length;
    const erroredProviders = scopedProviders.filter((p) => p.status === 'errored').length;

    // Dimension distribution
    const dimensionMap = new Map<number, number>();
    for (const idx of allIndexes) {
      const dim = idx.dimension ?? 0;
      dimensionMap.set(dim, (dimensionMap.get(dim) ?? 0) + 1);
    }
    const dimensionDistribution = Array.from(dimensionMap.entries())
      .sort(([a], [b]) => b - a)
      .map(([dimension, count]) => ({ dimension, count }));

    // Metric distribution
    const metricMap = new Map<string, number>();
    for (const idx of allIndexes) {
      const m = idx.metric ?? 'cosine';
      metricMap.set(m, (metricMap.get(m) ?? 0) + 1);
    }
    const metricDistribution = Array.from(metricMap.entries()).map(([metric, count]) => ({
      metric,
      count,
    }));

    // Provider breakdown
    const providerBreakdown = scopedIndexesByProvider.map(({ provider, indexes }) => ({
      key: provider.key,
      label: provider.label,
      driver: provider.driver,
      status: provider.status,
      indexCount: indexes.length,
    }));

    // Recently created indexes
    const recentIndexes = [...allIndexes]
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 5)
      .map((idx) => ({
        key: idx.key,
        name: idx.name,
        providerKey: idx.providerKey,
        dimension: idx.dimension,
        metric: idx.metric,
        createdAt: idx.createdAt,
      }));

    return NextResponse.json({
      overview: {
        totalProviders: scopedProviders.length,
        activeProviders,
        disabledProviders,
        erroredProviders,
        totalIndexes,
      },
      providerBreakdown,
      dimensionDistribution,
      metricDistribution,
      recentIndexes,
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
