import { NextRequest, NextResponse } from 'next/server';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('tracing-threads');

/**
 * GET /api/tracing/threads
 * List agent tracing threads (grouped sessions by threadId)
 */
export async function GET(request: NextRequest) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 401 });
    }

    const projectContext = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const searchParams = request.nextUrl.searchParams;
    const filters = {
      threadId: searchParams.get('threadId') || undefined,
      agent: searchParams.get('agent') || undefined,
      status: searchParams.get('status') || undefined,
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      limit: searchParams.get('limit') || '50',
      skip: searchParams.get('skip') || '0',
    };

    const result = await AgentTracingService.listThreads(
      tenantDbName,
      projectContext.projectId,
      filters,
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error('List threads error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch threads',
      },
      { status: 500 },
    );
  }
}
