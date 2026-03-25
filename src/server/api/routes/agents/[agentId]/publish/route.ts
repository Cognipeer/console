import { NextResponse, type NextRequest } from '@/server/api/http';
import { publishAgent } from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:publish');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !tenantId || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await requireProjectContext(request, { tenantDbName, tenantId, userId });

    const { agentId } = await params;
    const body = await request.json().catch(() => ({}));
    const { changelog } = body;

    const version = await publishAgent(tenantDbName, agentId, userId, changelog);

    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to publish agent', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to publish agent' },
      { status: 500 },
    );
  }
}
