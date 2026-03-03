import { NextRequest, NextResponse } from 'next/server';
import {
  getAgentById,
  updateAgentRecord,
  deleteAgentRecord,
} from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents:detail');
export const runtime = 'nodejs';

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

    await requireProjectContext(request, { tenantDbName, tenantId, userId });

    const { agentId } = await params;
    const agent = await getAgentById(tenantDbName, agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ agent }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to get agent', { error });
    return NextResponse.json({ error: 'Failed to get agent' }, { status: 500 });
  }
}

export async function PATCH(
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
    const body = await request.json();

    const agent = await updateAgentRecord(tenantDbName, agentId, body, userId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ agent }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to update agent', { error });
    return NextResponse.json({ error: 'Failed to update agent' }, { status: 500 });
  }
}

export async function DELETE(
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
    const deleted = await deleteAgentRecord(tenantDbName, agentId);
    if (!deleted) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to delete agent', { error });
    return NextResponse.json({ error: 'Failed to delete agent' }, { status: 500 });
  }
}
