import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getMcpServer,
  updateMcpServer,
  deleteMcpServer,
  serializeMcpServerFull,
  listMcpRequestLogs,
  aggregateMcpRequestLogs,
} from '@/lib/services/mcp';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-api-detail');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const server = await getMcpServer(tenantDbName, id);
    if (!server) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    // Include logs and aggregate
    const { searchParams } = new URL(request.url);
    const includeLogs = searchParams.get('includeLogs') === 'true';
    const includeAggregate = searchParams.get('includeAggregate') === 'true';

    const payload: Record<string, unknown> = { server: serializeMcpServerFull(server) };

    if (includeLogs) {
      const logs = await listMcpRequestLogs(tenantDbName, server.key, { limit: 50 });
      payload.logs = logs;
    }

    if (includeAggregate) {
      const aggregate = await aggregateMcpRequestLogs(tenantDbName, server.key, { groupBy: 'day' });
      payload.aggregate = aggregate;
    }

    return NextResponse.json(payload, { status: 200 });
  } catch (error: unknown) {
    logger.error('Get MCP server error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();

    if (body.upstreamAuth?.type) {
      const validAuthTypes = ['none', 'token', 'header', 'basic'];
      if (!validAuthTypes.includes(body.upstreamAuth.type)) {
        return NextResponse.json(
          { error: 'upstreamAuth.type must be "none", "token", "header", or "basic"' },
          { status: 400 },
        );
      }
    }

    if (body.status && !['active', 'disabled'].includes(body.status)) {
      return NextResponse.json(
        { error: 'status must be "active" or "disabled"' },
        { status: 400 },
      );
    }

    const updated = await updateMcpServer(tenantDbName, id, userId, {
      name: body.name,
      description: body.description,
      openApiSpec: body.openApiSpec,
      upstreamBaseUrl: body.upstreamBaseUrl,
      upstreamAuth: body.upstreamAuth,
      status: body.status,
    });

    if (!updated) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    return NextResponse.json({ server: serializeMcpServerFull(updated) }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Update MCP server error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const tenantDbName = request.headers.get('x-tenant-db-name');
    const tenantId = request.headers.get('x-tenant-id');
    const userId = request.headers.get('x-user-id');

    if (!tenantDbName || !tenantId || !userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const deleted = await deleteMcpServer(tenantDbName, id);
    if (!deleted) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error: unknown) {
    logger.error('Delete MCP server error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
