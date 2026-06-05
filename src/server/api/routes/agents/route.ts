import { type IAgent } from '@/lib/database';
import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  createAgentRecord,
  listAgents,
} from '@/lib/services/agents';
import {
  requireProjectContext,
  ProjectContextError,
} from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('api:agents');

export async function GET(request: NextRequest) {
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

    const search = request.nextUrl.searchParams.get('search') || undefined;
    const rawStatus = request.nextUrl.searchParams.get('status');
    const status: IAgent['status'] | undefined =
      rawStatus === 'active' || rawStatus === 'inactive' || rawStatus === 'draft'
        ? rawStatus
        : undefined;

    const agents = await listAgents(tenantDbName, {
      projectId,
      status,
      search,
    });

    return NextResponse.json({ agents }, { status: 200 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to list agents', { error });
    return NextResponse.json(
      { error: 'Failed to list agents' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
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

    const body = await request.json();
    const { name, description, config } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Agent name is required' },
        { status: 400 },
      );
    }

    if (!config?.modelKey) {
      return NextResponse.json(
        { error: 'Model configuration is required' },
        { status: 400 },
      );
    }

    const agent = await createAgentRecord(
      tenantDbName,
      tenantId,
      projectId,
      userId,
      { name, description, config },
    );

    return NextResponse.json({ agent }, { status: 201 });
  } catch (error) {
    if (error instanceof ProjectContextError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    logger.error('Failed to create agent', { error });
    return NextResponse.json(
      { error: 'Failed to create agent' },
      { status: 500 },
    );
  }
}
