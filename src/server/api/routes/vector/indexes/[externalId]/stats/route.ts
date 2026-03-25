import { NextResponse, type NextRequest } from '@/server/api/http';
import { ProjectContextError, requireProjectContext } from '@/lib/services/projects/projectContext';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import { getDatabase } from '@/lib/database';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
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

    try {
      await requireProjectContext(request, { tenantDbName, tenantId, userId });
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

    const dbProvider = await getDatabase() as MongoDBProvider;
    const client = dbProvider.getClient();
    if (!client) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }
    const db = client.db(tenantDbName);

    const indexQuery: Record<string, unknown> = { externalId };
    if (providerKey) indexQuery.providerKey = providerKey;
    const indexDoc = await db
      .collection('vector_indexes')
      .findOne(indexQuery, { projection: { key: 1, _id: 0 } });

    const indexKey = (indexDoc?.key as string | undefined) ?? externalId;
    const [daily, totalsRaw, topKDist] = await Promise.all([
      db.collection('vector_query_logs').aggregate([
        { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
            queryCount: { $sum: 1 },
            avgLatencyMs: { $avg: '$latencyMs' },
            avgScore: { $avg: '$avgScore' },
            filterCount: { $sum: { $cond: [{ $eq: ['$filterApplied', true] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ]).toArray(),

      db.collection('vector_query_logs').aggregate([
        { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
        {
          $group: {
            _id: null,
            totalQueries: { $sum: 1 },
            avgLatencyMs: { $avg: '$latencyMs' },
            avgScore: { $avg: '$avgScore' },
            minLatencyMs: { $min: '$latencyMs' },
            maxLatencyMs: { $max: '$latencyMs' },
          },
        },
      ]).toArray(),

      db.collection('vector_query_logs').aggregate([
        { $match: { indexKey, timestamp: { $gte: since, $lte: until } } },
        { $group: { _id: '$topK', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    const dateMap = new Map(daily.map((d) => [d._id as string, d]));
    const filledDaily: Array<{
      date: string;
      queryCount: number;
      avgLatencyMs: number;
      avgScore: number;
      filterCount: number;
    }> = [];
    const dayStart = new Date(since);
    dayStart.setHours(0, 0, 0, 0);
    for (let i = 0; i < days; i++) {
      const d = new Date(dayStart);
      d.setDate(dayStart.getDate() + i);
      const key = d.toISOString().substring(0, 10);
      const row = dateMap.get(key);
      filledDaily.push({
        date: key,
        queryCount: (row?.queryCount as number | undefined) ?? 0,
        avgLatencyMs: row ? Math.round((row.avgLatencyMs as number | undefined) ?? 0) : 0,
        avgScore: row ? parseFloat(((row.avgScore as number | undefined) ?? 0).toFixed(4)) : 0,
        filterCount: (row?.filterCount as number | undefined) ?? 0,
      });
    }

    const totals = totalsRaw[0] ?? {};

    return NextResponse.json({
      daily: filledDaily,
      totals: {
        totalQueries: (totals.totalQueries as number | undefined) ?? 0,
        avgLatencyMs: totals.avgLatencyMs ? Math.round(totals.avgLatencyMs as number) : 0,
        minLatencyMs: (totals.minLatencyMs as number | undefined) ?? 0,
        maxLatencyMs: (totals.maxLatencyMs as number | undefined) ?? 0,
        avgScore: totals.avgScore ? parseFloat((totals.avgScore as number).toFixed(4)) : 0,
      },
      topKDistribution: topKDist.map((r) => ({
        topK: r._id as number,
        count: r.count as number,
      })),
      days,
    });
  } catch (error) {
    log.error('Vector stats error', { error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
