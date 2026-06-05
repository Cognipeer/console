import { NextResponse, type NextRequest } from '@/server/api/http';
import { randomUUID } from 'crypto';
import { getMcpServerByKey } from '@/lib/services/mcp';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createSseSession,
  removeSseSession,
  encodeSseEndpointEvent,
} from '@/lib/services/mcp/sseSessionManager';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-sse');

/**
 * GET /api/client/v1/mcp/:serverKey/sse
 *
 * Opens an SSE stream for MCP protocol communication.
 * After connection the server sends an `endpoint` event containing the
 * URL the client should POST JSON-RPC messages to.
 *
 * Authentication: Bearer token in Authorization header.
 */
export async function GET(
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

  // --- Resolve server ---
  const { serverKey } = await params;
  const server = await getMcpServerByKey(tenantDbName, serverKey, projectId);

  if (!server) {
    return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
  }
  if (server.status !== 'active') {
    return NextResponse.json({ error: 'MCP server is disabled' }, { status: 403 });
  }

  // --- Create session ---
  const sessionId = randomUUID();

  // Build the message endpoint URL that the client should POST to
  const origin = request.headers.get('x-forwarded-proto')
    ? `${request.headers.get('x-forwarded-proto')}://${request.headers.get('host')}`
    : new URL(request.url).origin;

  const messageEndpoint = `${origin}/api/client/v1/mcp/${serverKey}/message?sessionId=${sessionId}`;

  logger.info('MCP SSE session opened', { sessionId, serverKey, tenantId });

  // --- SSE stream ---
  const stream = new ReadableStream({
    start(controller) {
      // Register session
      createSseSession(sessionId, {
        serverKey,
        tenantDbName,
        tenantId,
        projectId,
        tokenId: ctx.tokenRecord._id?.toString(),
        controller,
      });

      // Send the `endpoint` event so the client knows where to POST messages
      controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
    },
    cancel() {
      logger.info('MCP SSE session closed', { sessionId, serverKey });
      removeSseSession(sessionId);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Mcp-Session-Id': sessionId,
    },
  });
}
