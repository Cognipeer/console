import { NextRequest, NextResponse } from 'next/server';
import {
  createMcpServer,
  listMcpServers,
  serializeMcpServer,
} from '@/lib/services/mcp';
import { requireProjectContext, ProjectContextError } from '@/lib/services/projects/projectContext';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-api');

export const runtime = 'nodejs';

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
    const status = searchParams.get('status') as 'active' | 'disabled' | null;
    const search = searchParams.get('search') ?? undefined;

    const servers = await listMcpServers(tenantDbName, {
      projectId: projectContext.projectId,
      status: status ?? undefined,
      search,
    });

    return NextResponse.json(
      { servers: servers.map(serializeMcpServer) },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('List MCP servers error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
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

    const body = await request.json();

    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (!body.openApiSpec || typeof body.openApiSpec !== 'string') {
      return NextResponse.json({ error: 'openApiSpec is required' }, { status: 400 });
    }

    if (!body.upstreamAuth || !body.upstreamAuth.type) {
      return NextResponse.json({ error: 'upstreamAuth with type is required' }, { status: 400 });
    }

    const validAuthTypes = ['none', 'token', 'header', 'basic'];
    if (!validAuthTypes.includes(body.upstreamAuth.type)) {
      return NextResponse.json(
        { error: 'upstreamAuth.type must be "none", "token", "header", or "basic"' },
        { status: 400 },
      );
    }

    const server = await createMcpServer(
      tenantDbName,
      tenantId,
      userId,
      projectContext.projectId,
      {
        name: body.name.trim(),
        description: body.description?.trim(),
        openApiSpec: body.openApiSpec,
        upstreamBaseUrl: body.upstreamBaseUrl?.trim(),
        upstreamAuth: body.upstreamAuth,
      },
    );

    return NextResponse.json(
      { server: serializeMcpServer(server) },
      { status: 201 },
    );
  } catch (error: unknown) {
    logger.error('Create MCP server error', { error });
    if (error instanceof ProjectContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
