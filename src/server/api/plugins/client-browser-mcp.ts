/**
 * Per-Browser MCP plugin.
 *
 * Exposes each tenant browser as its own MCP endpoint so external clients
 * can drive it via the Model Context Protocol. Tools mirror the Browser Use
 * system tool set (browser_navigate, browser_click, …, browser_close).
 *
 * URL shape:
 *   GET  /api/client/v1/browser/:browserKey/mcp/sse              (SSE init)
 *   POST /api/client/v1/browser/:browserKey/mcp/message?sessionId=…  (JSON-RPC)
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  buildBrowserAgentTools,
  closeBrowserSession,
  createBrowserSession,
  resolveBrowser,
} from '@/lib/services/browser';
import { getSseSession, sendSseResponse, tokenSsePrincipal } from '@/lib/services/mcp/sseSessionManager';
import { describeMcpTools } from '@/lib/services/mcp/toolAnnotations';
import { toolInputJsonSchema } from '@/lib/services/browser/toolSchema';
import {
  getApiTokenContextForRequest,
  withClientApiRequestContext,
} from '../fastify-utils';
import {
  lookupMessageSession,
  readJsonRpcRequest,
  sendSessionNotFound,
  startMcpSseResponse,
} from '../mcpTransport';

const logger = createLogger('api:client-browser-mcp');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'cognipeer-browser-mcp',
  version: '1.0.0',
};

// In-memory map: MCP sessionId -> backing browser session key.
// One MCP session owns exactly one browser session for its lifetime. Entries
// are only ever created for an MCP session that is open and belongs to the
// caller (see the binding check in the message handler), and are removed —
// closing the browser session — when that stream ends.
const mcpToBrowserSession = new Map<string, string>();

/**
 * The MCP tool list, DERIVED from the agent tool set rather than restated.
 *
 * These descriptors used to be hand-written JSON Schema next to the zod
 * schemas in `agentTools`, which meant every tool added to one surface was
 * missing from the other until someone noticed. Building the list from the
 * real tools makes that impossible: a tool exists on both surfaces or on
 * neither, with one description and one schema.
 *
 * The context passed here is a throwaway — only `name`, `description` and
 * `schema` are read, and no session is opened.
 */
interface BrowserToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Tools that only observe the page; everything else mutates page or session state. */
const READ_ONLY_BROWSER_TOOLS = new Set([
  'browser_wait',
  'browser_snapshot',
  'browser_find',
  'browser_extract',
  'browser_diagnostics',
  'browser_screenshot',
  'browser_pdf',
  'browser_list_flows',
]);

function buildBrowserToolDescriptors(): BrowserToolDescriptor[] {
  const tools = buildBrowserAgentTools({
    tenantDbName: '',
    tenantId: '',
    sessionKey: '',
    createdBy: 'schema-probe',
  }) as Array<{ name: string; description?: string; schema?: unknown }>;

  return tools.map((tool) => {
    return {
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: toolInputJsonSchema(tool.schema),
    };
  });
}

const BROWSER_TOOL_DESCRIPTORS: BrowserToolDescriptor[] = buildBrowserToolDescriptors();

const BROWSER_TOOL_LIST = describeMcpTools(
  BROWSER_TOOL_DESCRIPTORS.map((tool) => {
    const readOnly = READ_ONLY_BROWSER_TOOLS.has(tool.name);
    return {
      ...tool,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    };
  }),
);

/**
 * Close the browser session an MCP session backed, if it had opened one.
 * Best effort: the stream is already gone, so there is no caller to tell.
 */
function closeBackingBrowserSession(
  scope: { tenantDbName: string; tenantId: string; projectId?: string },
  mcpSessionId: string,
  browserKey: string,
): void {
  const sessionKey = mcpToBrowserSession.get(mcpSessionId);
  if (!sessionKey) return;
  mcpToBrowserSession.delete(mcpSessionId);
  logger.info('Browser MCP session closed', { browserKey, session: mcpSessionId.slice(0, 8) });
  void closeBrowserSession(scope, sessionKey).catch((err) => logger.warn(
    'Failed to close backing browser session on SSE close',
    { error: err instanceof Error ? err.message : String(err) },
  ));
}

function jsonRpcOk(id: string | number | null, result: unknown) {
  return { id, jsonrpc: JSONRPC_VERSION, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    error: { code, message },
    id,
    jsonrpc: JSONRPC_VERSION,
  };
}

export const clientBrowserMcpApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/browser/:browserKey/mcp/message', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { browserKey } = request.params as { browserKey: string };
      // A message that names an SSE session is delivered into that stream —
      // only when this token opened it, for this browser.
      const lookup = lookupMessageSession(request, {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        serverKey: `browser:${browserKey}`,
        principal: tokenSsePrincipal(ctx.tokenRecord._id?.toString()),
      });
      if (lookup.kind === 'unknown') return sendSessionNotFound(reply);
      const sseSession = lookup.kind === 'session' ? lookup.session : null;
      const mcpSessionId = lookup.kind === 'session' ? lookup.sessionId : undefined;

      const parsed = readJsonRpcRequest(request);
      if (!parsed.ok) {
        const errorPayload = jsonRpcError(null, parsed.code, parsed.message);
        if (sseSession && mcpSessionId) {
          sendSseResponse(mcpSessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }
      const body = parsed.body;

      const { id = null, method } = body;
      if (typeof method !== 'string' || method === '') {
        const errorPayload = jsonRpcError(id, -32600, 'Invalid Request: method is required');
        if (sseSession && mcpSessionId) {
          sendSseResponse(mcpSessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }

      const respond = (payload: Record<string, unknown>) => {
        if (sseSession && mcpSessionId) {
          sendSseResponse(mcpSessionId, payload);
          return reply.code(202).send();
        }
        return reply.code(200).send(payload);
      };

      const browser = await resolveBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        browserKey,
      );
      if (!browser) {
        return respond(jsonRpcError(id, -32001, 'Browser not found'));
      }
      if (browser.status !== 'active') {
        return respond(jsonRpcError(id, -32002, 'Browser is disabled'));
      }

      if (method === 'initialize') {
        return respond(jsonRpcOk(id, {
          capabilities: { tools: { listChanged: false } },
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
        }));
      }

      if (method === 'notifications/initialized') {
        return reply.code(202).send();
      }

      if (method === 'ping') {
        return respond(jsonRpcOk(id, {}));
      }

      if (method === 'tools/list') {
        return respond(jsonRpcOk(id, { tools: BROWSER_TOOL_LIST }));
      }

      if (method === 'tools/call') {
        const toolName = typeof body.params?.name === 'string' ? body.params.name : '';
        const args = body.params?.arguments && typeof body.params.arguments === 'object'
          ? (body.params.arguments as Record<string, unknown>)
          : {};

        if (!toolName) {
          return respond(jsonRpcError(id, -32602, 'Invalid params: "name" is required'));
        }
        const descriptor = BROWSER_TOOL_DESCRIPTORS.find((t) => t.name === toolName);
        if (!descriptor) {
          return respond(jsonRpcError(id, -32601, `Tool not found: ${toolName.slice(0, 100)}`));
        }
        if (!mcpSessionId) {
          return respond(jsonRpcError(id, -32600, 'Missing sessionId; open SSE first'));
        }

        // Ensure a backing browser session exists for this MCP session
        let sessionKey = mcpToBrowserSession.get(mcpSessionId);
        if (!sessionKey) {
          try {
            const created = await createBrowserSession(
              { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
              {
                browserId: String(browser._id ?? ''),
                createdBy: ctx.user?.email ?? 'mcp-client',
                metadata: { source: 'browser-mcp', mcpSessionId },
              },
            );
            sessionKey = created.sessionKey;
            if (!getSseSession(mcpSessionId)) {
              // The stream ended while the browser session was opening: nothing
              // would ever close it.
              void closeBrowserSession(
                { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
                sessionKey,
              ).catch((closeError) => logger.warn('Failed to close orphaned browser session', {
                error: closeError instanceof Error ? closeError.message : String(closeError),
              }));
              return sendSessionNotFound(reply);
            }
            mcpToBrowserSession.set(mcpSessionId, sessionKey);
            logger.info('Browser MCP session backed by new browser session', {
              browserKey, session: mcpSessionId.slice(0, 8), sessionKey,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to create browser session';
            logger.error('Browser MCP session create failed', {
              browserKey, session: mcpSessionId.slice(0, 8), error: message,
            });
            return respond(jsonRpcOk(id, {
              content: [{ text: message, type: 'text' }],
              isError: true,
            }));
          }
        }

        const tools = buildBrowserAgentTools({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          sessionKey,
          createdBy: ctx.user?.email ?? 'mcp-client',
        });
        const tool = tools.find((t) => t.name === toolName);
        if (!tool) {
          return respond(jsonRpcError(id, -32601, `Tool runtime missing: ${toolName.slice(0, 100)}`));
        }

        try {
          const result = await tool.func(args as never);
          // browser_close should also drop our session mapping
          if (toolName === 'browser_close') {
            mcpToBrowserSession.delete(mcpSessionId);
          }
          return respond(jsonRpcOk(id, {
            content: [{
              text: typeof result === 'string' ? result : JSON.stringify(result),
              type: 'text',
            }],
            isError: false,
          }));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Tool execution failed';
          logger.error('Browser MCP tool call failed', {
            browserKey, session: mcpSessionId.slice(0, 8), tool: toolName, error: message,
          });
          return respond(jsonRpcOk(id, {
            content: [{ text: message, type: 'text' }],
            isError: true,
          }));
        }
      }

      return respond(jsonRpcError(id, -32601, `Method not found: ${method.slice(0, 100)}`));
    } catch (error) {
      logger.error('Browser MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  // `exposeHeadRoute: false`: a HEAD request must not open a stream (and so a
  // session) it would never read.
  app.get('/client/v1/browser/:browserKey/mcp/sse', { exposeHeadRoute: false }, withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { browserKey } = request.params as { browserKey: string };
      const browser = await resolveBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        browserKey,
      );
      if (!browser) {
        return reply.code(404).send({ error: 'Browser not found' });
      }
      if (browser.status !== 'active') {
        return reply.code(403).send({ error: 'Browser is disabled' });
      }

      const tokenId = ctx.tokenRecord._id?.toString();
      return startMcpSseResponse(request, reply, {
        messagePath: `/api/client/v1/browser/${encodeURIComponent(browserKey)}/mcp/message`,
        session: {
          principal: tokenSsePrincipal(tokenId),
          projectId: ctx.projectId,
          serverKey: `browser:${browserKey}`,
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          tokenId,
          // Runs however the stream ends: close the browser session it backs.
          onClose: (mcpSessionId) => closeBackingBrowserSession(
            { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
            mcpSessionId,
            browserKey,
          ),
        },
        logFields: { browserKey, tenantId: ctx.tenantId },
      });
    } catch (error) {
      logger.error('Browser MCP SSE error', { error });
      return reply.code(500).send({ error: 'Internal error' });
    }
  }));
};
