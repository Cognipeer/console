import { NextResponse, type NextRequest } from '@/server/api/http';
import { listFileBuckets } from '@/lib/services/files';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import {
  isDateInDashboardRange,
  parseDashboardDateFilterFromSearchParams,
} from '@/lib/utils/dashboardDateFilter';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('files-dashboard');

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

    const buckets = await listFileBuckets(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    const filter = parseDashboardDateFilterFromSearchParams(
      request.nextUrl.searchParams,
    );

    const scopedBuckets = buckets.filter((bucket) =>
      isDateInDashboardRange(bucket.createdAt, filter),
    );

    const activeBuckets = scopedBuckets.filter((b) => b.status === 'active').length;
    const disabledBuckets = scopedBuckets.filter((b) => b.status === 'disabled').length;

    // Provider breakdown
    const providerMap = new Map<string, { count: number; active: number }>();
    for (const bucket of scopedBuckets) {
      const current = providerMap.get(bucket.providerKey) ?? { count: 0, active: 0 };
      providerMap.set(bucket.providerKey, {
        count: current.count + 1,
        active: current.active + (bucket.status === 'active' ? 1 : 0),
      });
    }
    const providerBreakdown = Array.from(providerMap.entries()).map(([providerKey, summary]) => ({
      providerKey,
      count: summary.count,
      active: summary.active,
    }));

    const recentBuckets = [...scopedBuckets]
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 6)
      .map((b) => ({
        key: b.key,
        name: b.name,
        providerKey: b.providerKey,
        status: b.status,
        createdAt: b.createdAt,
      }));

    return NextResponse.json({
      overview: {
        totalBuckets: scopedBuckets.length,
        activeBuckets,
        disabledBuckets,
      },
      providerBreakdown,
      recentBuckets,
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
