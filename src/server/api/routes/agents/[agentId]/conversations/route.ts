import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createConversation,
  listConversations,
  getAgentById,
} from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:conversations');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');
    if (!tenantDbName || !tenantId || !userId)
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { projectId } = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { agentId } = await params;
    const agent = await getAgentById(tenantDbName, agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const conversations = await listConversations(tenantDbName, agent.key, {
      projectId,
      limit: 50,
    });

    return NextResponse.json({ conversations }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to list conversations', { error });
    return NextResponse.json(
      { error: 'Failed to list conversations' },
      { status: 500 },
    );
  }
}

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

    const { projectId } = await requireProjectContext(request, {
      tenantDbName,
      tenantId,
      userId,
    });

    const { agentId } = await params;
    const agent = await getAgentById(tenantDbName, agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const conversation = await createConversation(
      tenantDbName,
      tenantId,
      projectId,
      userId,
      agent.key,
      body.title,
    );

    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to create conversation', { error });
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 },
    );
  }
}
