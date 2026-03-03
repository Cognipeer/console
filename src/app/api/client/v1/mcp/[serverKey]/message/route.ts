import { NextRequest, NextResponse } from 'next/server';
import {
  getMcpServerByKey,
  executeMcpTool,
  logMcpRequest,
} from '@/lib/services/mcp';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { sendSseResponse, getSseSession } from '@/lib/services/mcp/sseSessionManager';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-message');

export const runtime = 'nodejs';

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';

const SERVER_INFO = {
  name: 'cognipeer-mcp-gateway',
  version: '1.0.0',
};

/** Build a JSON-RPC success response */
function jsonRpcOk(id: string | number | null, result: unknown) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** Build a JSON-RPC error response */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

/**
 * POST /api/client/v1/mcp/:serverKey/message?sessionId=...
 *
 * Receives MCP JSON-RPC messages, processes them, and pushes
 * responses back through the SSE stream identified by sessionId.
 *
 * Also works without an active SSE session (stateless mode):
 * if no sessionId is provided it returns the JSON-RPC response
 * directly in the HTTP body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverKey: string }> },
) {
  // --- Auth ---
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
  const { serverKey } = await params;

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const session = sessionId ? getSseSession(sessionId) : null;

  // Parse JSON-RPC body
  let body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    const errResp = jsonRpcError(null, -32700, 'Parse error');
    if (session && sessionId) {
      sendSseResponse(sessionId, errResp);
      return new Response(null, { status: 202 });
    }
    return NextResponse.json(errResp, { status: 400 });
  }

  const { id = null, method } = body;

  if (!method) {
    const errResp = jsonRpcError(id, -32600, 'Invalid Request: method is required');
    if (session && sessionId) {
      sendSseResponse(sessionId, errResp);
      return new Response(null, { status: 202 });
    }
    return NextResponse.json(errResp, { status: 400 });
  }

  /** Helper: send result via SSE or HTTP */
  const respond = (payload: Record<string, unknown>) => {
    if (session && sessionId) {
      sendSseResponse(sessionId, payload);
      return new Response(null, { status: 202 });
    }
    return NextResponse.json(payload);
  };

  try {
    // ── initialize ──────────────────────────────────────────────────
    if (method === 'initialize') {
      return respond(
        jsonRpcOk(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        }),
      );
    }

    // ── notifications/initialized (client ack – no response needed) ─
    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }

    // ── ping ────────────────────────────────────────────────────────
    if (method === 'ping') {
      return respond(jsonRpcOk(id, {}));
    }

    // ── tools/list ──────────────────────────────────────────────────
    if (method === 'tools/list') {
      const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);
      if (!server) {
        return respond(jsonRpcError(id, -32001, 'MCP server not found'));
      }

      const tools = (server.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      return respond(jsonRpcOk(id, { tools }));
    }

    // ── tools/call ──────────────────────────────────────────────────
    if (method === 'tools/call') {
      const toolName = (body.params?.name as string) ?? '';
      const args = (body.params?.arguments as Record<string, unknown>) ?? {};

      if (!toolName) {
        return respond(jsonRpcError(id, -32602, 'Invalid params: "name" is required'));
      }

      const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);
      if (!server) {
        return respond(jsonRpcError(id, -32001, 'MCP server not found'));
      }
      if (server.status !== 'active') {
        return respond(jsonRpcError(id, -32002, 'MCP server is disabled'));
      }

      try {
        const { result, latencyMs } = await executeMcpTool(server, toolName, args);

        void logMcpRequest(
          tenantDbName,
          tenantId,
          projectId,
          server.key,
          toolName,
          'success',
          latencyMs,
          { tool: toolName, arguments: args },
          typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
          undefined,
          ctx.tokenRecord._id?.toString(),
        );

        return respond(
          jsonRpcOk(id, {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result),
              },
            ],
            isError: false,
          }),
        );
      } catch (execError: unknown) {
        const errorMessage = execError instanceof Error ? execError.message : 'Tool execution failed';

        void logMcpRequest(
          tenantDbName,
          tenantId,
          projectId,
          server.key,
          toolName,
          'error',
          0,
          { tool: toolName, arguments: args },
          undefined,
          errorMessage,
          ctx.tokenRecord._id?.toString(),
        );

        return respond(
          jsonRpcOk(id, {
            content: [{ type: 'text', text: errorMessage }],
            isError: true,
          }),
        );
      }
    }

    // ── unknown method ──────────────────────────────────────────────
    return respond(jsonRpcError(id, -32601, `Method not found: ${method}`));
  } catch (error: unknown) {
    logger.error('MCP message handler error', { error, method, serverKey });
    return respond(jsonRpcError(id, -32603, 'Internal error'));
  }
}
