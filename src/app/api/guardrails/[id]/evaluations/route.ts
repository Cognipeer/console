import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('guardrail-evaluations');

export const runtime = 'nodejs';

/**
 * GET /api/guardrails/:id/evaluations
 * Returns evaluation logs + aggregate stats for a guardrail.
 *
 * Query params:
 *  - limit (default 50, max 200)
 *  - skip  (default 0)
 *  - from  (ISO date)
 *  - to    (ISO date)
 *  - passed (true|false)
 *  - groupBy (hour|day|month, default day)
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    // Verify guardrail exists
    const guardrail = await db.findGuardrailById(id);
    if (!guardrail) {
      return NextResponse.json({ error: 'Guardrail not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const parsedFilter = parseDashboardDateFilterFromSearchParams(searchParams);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const skip = parseInt(searchParams.get('skip') || '0', 10);
    const from = searchParams.get('from') || parsedFilter.from?.toISOString();
    const to = searchParams.get('to') || parsedFilter.to?.toISOString();
    const passedParam = searchParams.get('passed');
    const groupBy = (searchParams.get('groupBy') || 'day') as 'hour' | 'day' | 'month';

    const passed = passedParam === 'true' ? true : passedParam === 'false' ? false : undefined;

    const [logs, aggregate] = await Promise.all([
      db.listGuardrailEvaluationLogs(id, {
        limit,
        skip,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        passed,
      }),
      db.aggregateGuardrailEvaluations(id, {
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        groupBy,
      }),
    ]);

    return NextResponse.json({ logs, aggregate });
  } catch (error: unknown) {
    logger.error('Evaluations error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : 'Internal error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
