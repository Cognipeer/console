import { NextResponse, type NextRequest } from '@/server/api/http';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('tracing-threads');

/**
 * GET /api/tracing/threads/:threadId
 * Get thread detail with all sessions
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  try {
    const { threadId } = await params;
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

    const result = await AgentTracingService.getThreadDetail(
      tenantDbName,
      projectContext.projectId,
      threadId,
    );

    if (!result) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error('Get thread detail error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to fetch thread',
      },
      { status: 500 },
    );
  }
}
