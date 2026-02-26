import { NextRequest, NextResponse } from 'next/server';
import { AlertService } from '@/lib/services/alerts';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import type { AlertEventStatus } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('alert-history');

export const runtime = 'nodejs';

/**
 * GET /api/alerts/history — list alert events for the active project
 */
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

    const { searchParams } = new URL(request.url);
    const ruleId = searchParams.get('ruleId') ?? undefined;
    const status = searchParams.get('status') as AlertEventStatus | null;
    const limit = parseInt(searchParams.get('limit') ?? '50', 10);
    const skip = parseInt(searchParams.get('skip') ?? '0', 10);

    const events = await AlertService.listEvents(tenantDbName, tenantId, {
      projectId: projectContext.projectId,
      ruleId,
      status: status ?? undefined,
      limit,
      skip,
    });

    const activeCount = await AlertService.countActive(
      tenantDbName,
      tenantId,
      projectContext.projectId,
    );

    return NextResponse.json({ events, activeCount }, { status: 200 });
  } catch (error: unknown) {
    logger.error('List history error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
