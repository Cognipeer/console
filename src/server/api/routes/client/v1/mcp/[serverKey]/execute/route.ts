import { NextResponse, type NextRequest } from '@/server/api/http';
import {
  getMcpServerByKey,
  executeMcpTool,
  logMcpRequest,
  serializeMcpServer,
} from '@/lib/services/mcp';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('client-mcp');

/**
 * POST /api/client/v1/mcp/:serverKey/execute
 *
 * Execute a tool on the MCP server.
 *
 * Body:
 * {
 *   "tool": "toolName",
 *   "arguments": { ... }
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverKey: string }> },
) {
  let ctx;
  try {
    ctx = await requireApiToken(request);
  } catch (error: unknown) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantDbName, tenantId, projectId } = ctx;

  try {
    const { serverKey } = await params;
    const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);

    if (!server) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    if (server.status !== 'active') {
      return NextResponse.json({ error: 'MCP server is disabled' }, { status: 403 });
    }

    const body = await request.json();

    if (!body.tool || typeof body.tool !== 'string') {
      return NextResponse.json({ error: '"tool" is required' }, { status: 400 });
    }

    const args = body.arguments || {};

    try {
      const { result, latencyMs } = await executeMcpTool(server, body.tool, args);

      // Log success
      void logMcpRequest(
        tenantDbName,
        tenantId,
        projectId,
        server.key,
        body.tool,
        'success',
        latencyMs,
        { tool: body.tool, arguments: args },
        typeof result === 'object' ? result as Record<string, unknown> : { value: result },
        undefined,
        ctx.tokenRecord._id?.toString(),
      );

      return NextResponse.json({
        result,
        metadata: {
          tool: body.tool,
          server: server.key,
          latencyMs,
        },
      });
    } catch (execError: unknown) {
      const errorMessage = execError instanceof Error ? execError.message : 'Tool execution failed';

      // Log error
      void logMcpRequest(
        tenantDbName,
        tenantId,
        projectId,
        server.key,
        body.tool,
        'error',
        0,
        { tool: body.tool, arguments: args },
        undefined,
        errorMessage,
        ctx.tokenRecord._id?.toString(),
      );

      return NextResponse.json({ error: errorMessage }, { status: 502 });
    }
  } catch (error: unknown) {
    logger.error('MCP execute error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}

/**
 * GET /api/client/v1/mcp/:serverKey/execute
 *
 * List available tools on the MCP server.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serverKey: string }> },
) {
  let ctx;
  try {
    ctx = await requireApiToken(request);
  } catch (error: unknown) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { tenantDbName, projectId } = ctx;

  try {
    const { serverKey } = await params;
    const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);

    if (!server) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    return NextResponse.json({
      server: serializeMcpServer(server),
      tools: server.tools,
    });
  } catch (error: unknown) {
    logger.error('MCP list tools error', { error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
