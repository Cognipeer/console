import { NextResponse, type NextRequest } from '@/server/api/http';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import { getVectorIndexQueryStats } from '@/lib/services/vector';
import { createLogger } from '@/lib/core/logger';

const log = createLogger('vector-stats');

interface RouteContext {
  params: Promise<{ externalId: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { externalId } = await context.params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let projectContext: Awaited<ReturnType<typeof requireProjectContext>>;
    try {
      projectContext = await requireProjectContext(request, { tenantDbName, tenantId, userId });
    } catch (error) {
      if (error instanceof ProjectContextError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    const { searchParams } = new URL(request.url);
    const parsedFilter = parseDashboardDateFilterFromSearchParams(searchParams);
    const providerKey = searchParams.get('providerKey');
    const daysParam = searchParams.get('days');
    const fromParam = searchParams.get('from') || parsedFilter.from?.toISOString();
    const toParam = searchParams.get('to') || parsedFilter.to?.toISOString();

    const now = new Date();
    const parsedFrom = fromParam ? new Date(fromParam) : undefined;
    const parsedTo = toParam ? new Date(toParam) : undefined;
    const hasFrom = parsedFrom && !Number.isNaN(parsedFrom.getTime());
    const hasTo = parsedTo && !Number.isNaN(parsedTo.getTime());
    const since = hasFrom
      ? parsedFrom
      : new Date(Date.now() - (daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 7), 90) : 30) * 24 * 3_600_000);
    const until = hasTo ? parsedTo : now;
    const diffMs = Math.max(until.getTime() - since.getTime(), 0);
    const computedDays = Math.floor(diffMs / (24 * 3_600_000)) + 1;
    const days = hasFrom || hasTo
      ? Math.min(Math.max(computedDays, 1), 365)
      : (daysParam ? Math.min(Math.max(parseInt(daysParam, 10) || 30, 7), 90) : 30);

    const stats = await getVectorIndexQueryStats(tenantDbName, projectContext.projectId, {
      externalId,
      providerKey: providerKey ?? undefined,
      from: since,
      to: until,
      days,
    });

    return NextResponse.json(stats);
  } catch (error) {
    log.error('Vector stats error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
