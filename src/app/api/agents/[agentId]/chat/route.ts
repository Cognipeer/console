import { NextRequest, NextResponse } from 'next/server';
import { executePlaygroundChat } from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:chat');
export const runtime = 'nodejs';

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
    const body = await request.json();
    const { message, history } = body;

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 },
      );
    }

    // agentId here is the DB _id; we need the agent's key
    const { getAgentById } = await import('@/lib/services/agents');
    const agent = await getAgentById(tenantDbName, agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const result = await executePlaygroundChat({
      tenantDbName,
      tenantId,
      projectId,
      agentKey: agent.key,
      userMessage: message,
      history: Array.isArray(history) ? history : undefined,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Agent chat failed', { error });
    const msg =
      error instanceof Error ? error.message : 'Agent chat failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
