import { NextResponse, type NextRequest } from '@/server/api/http';
import { countMcpRequestLogs, getMcpServer, listMcpRequestLogs } from '@/lib/services/mcp';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-api-logs');

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

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const skip = parseInt(searchParams.get('skip') || '0', 10);
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1);
    const status = searchParams.get('status') ?? undefined;
    const keyword = searchParams.get('keyword')?.trim() || undefined;
    const fromRaw = searchParams.get('from');
    const toRaw = searchParams.get('to');
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw
      ? (toRaw.length === 10
        ? new Date(`${toRaw}T23:59:59.999Z`)
        : new Date(toRaw))
      : undefined;

    const resolvedSkip = Number.isNaN(skip) ? (page - 1) * limit : Math.max(skip, 0);

    const logs = await listMcpRequestLogs(tenantDbName, server.key, {
      limit,
      skip: resolvedSkip,
      status,
      from,
      to,
      keyword,
    });

    const total = await countMcpRequestLogs(tenantDbName, server.key, {
      status,
      from,
      to,
      keyword,
    });

    return NextResponse.json(
      {
        logs,
        total,
        page,
        limit,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    logger.error('List MCP request logs error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
