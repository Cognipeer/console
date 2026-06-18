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

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  buildBrowserAgentTools,
  closeBrowserSession,
  createBrowserSession,
  resolveBrowser,
} from '@/lib/services/browser';
import {
  createSseSession,
  encodeSseEndpointEvent,
  getSseSession,
  removeSseSession,
  sendSseResponse,
} from '@/lib/services/mcp/sseSessionManager';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-browser-mcp');

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
  name: 'cognipeer-browser-mcp',
  version: '1.0.0',
};

// In-memory map: MCP sessionId -> backing browser session key.
// One MCP session owns exactly one browser session for its lifetime.
const mcpToBrowserSession = new Map<string, string>();

interface BrowserToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const BROWSER_TOOL_DESCRIPTORS: BrowserToolDescriptor[] = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the live browser to a fully-qualified URL. Returns the new URL, page title and an aria-snapshot of the page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click a clickable element identified by either an aria reference (preferred, from a previous snapshot) or a CSS selector. When both are given, a stale ref falls back to the selector. Optional `timeout` (ms) bounds the wait.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        timeout: { type: 'number' },
      },
    },
  },
  {
    name: 'browser_hover',
    description: 'Hover the mouse over an element by ref or CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, selector: { type: 'string' } },
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into a text input (textarea / input). Set `clear: true` to wipe the field first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        clear: { type: 'boolean' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_press',
    description:
      'Press a keyboard key (e.g., "Enter", "Escape", "ArrowDown") on a focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a fixed duration (ms) or until a CSS selector reaches a given visibility state.',
    inputSchema: {
      type: 'object',
      properties: {
        ms: { type: 'integer', minimum: 1, maximum: 60000 },
        selector: { type: 'string' },
        state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'] },
      },
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture an aria-snapshot of the current page (YAML). Refs in this snapshot can be used for subsequent click/hover/type operations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_extract',
    description:
      'Extract text/html/attribute from the page. Either a CSS selector or aria ref must be supplied.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        mode: { type: 'string', enum: ['text', 'html', 'attr'] },
        attribute: { type: 'string' },
        multiple: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a full-page or element screenshot, persist it to the session bucket, and return a download URL.',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean' },
        selector: { type: 'string' },
        ref: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_pdf',
    description:
      'Render the current page to a PDF, persist it to the session bucket, and return a download URL. Only works in headless mode.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['A4', 'Letter', 'Legal', 'A3', 'A5'] },
        landscape: { type: 'boolean' },
        printBackground: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_close',
    description:
      'Close the browser session. Use this only when the task is fully complete.',
    inputSchema: { type: 'object', properties: {} },
  },
];

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
      const query = (request.query ?? {}) as { sessionId?: string };
      const mcpSessionId = query.sessionId;
      const sseSession = mcpSessionId ? getSseSession(mcpSessionId) : null;

      let body: {
        id?: string | number | null;
        jsonrpc?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        body = readJsonBody(request);
      } catch {
        const errorPayload = jsonRpcError(null, -32700, 'Parse error');
        if (sseSession && mcpSessionId) {
          sendSseResponse(mcpSessionId, errorPayload);
          return reply.code(202).send();
        }
        return reply.code(400).send(errorPayload);
      }

      const { id = null, method } = body;
      if (!method) {
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
        return respond(jsonRpcOk(id, { tools: BROWSER_TOOL_DESCRIPTORS }));
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
          return respond(jsonRpcError(id, -32601, `Tool not found: ${toolName}`));
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
            mcpToBrowserSession.set(mcpSessionId, sessionKey);
            logger.info('Browser MCP session backed by new browser session', {
              browserKey, mcpSessionId, sessionKey,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to create browser session';
            logger.error('Browser MCP session create failed', { browserKey, mcpSessionId, error: message });
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
          return respond(jsonRpcError(id, -32601, `Tool runtime missing: ${toolName}`));
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
            browserKey, mcpSessionId, tool: toolName, error: message,
          });
          return respond(jsonRpcOk(id, {
            content: [{ text: message, type: 'text' }],
            isError: true,
          }));
        }
      }

      return respond(jsonRpcError(id, -32601, `Method not found: ${method}`));
    } catch (error) {
      logger.error('Browser MCP message handler error', { error });
      return reply.code(500).send(jsonRpcError(null, -32603, 'Internal error'));
    }
  }));

  app.get('/client/v1/browser/:browserKey/mcp/sse', withClientApiRequestContext(async (request, reply) => {
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

      const mcpSessionId = randomUUID();
      const forwardedProto = request.headers['x-forwarded-proto'];
      const protocol = typeof forwardedProto === 'string' && forwardedProto.length > 0
        ? forwardedProto
        : 'http';
      const host = typeof request.headers.host === 'string' && request.headers.host.length > 0
        ? request.headers.host
        : 'localhost';
      const messageEndpoint = `${protocol}://${host}/api/client/v1/browser/${browserKey}/mcp/message?sessionId=${mcpSessionId}`;

      const stream = new ReadableStream<Uint8Array>({
        cancel() {
          logger.info('Browser MCP SSE session closed', { browserKey, mcpSessionId });
          // Best-effort: close any backing browser session
          const sessionKey = mcpToBrowserSession.get(mcpSessionId);
          if (sessionKey) {
            mcpToBrowserSession.delete(mcpSessionId);
            void closeBrowserSession(
              { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
              sessionKey,
            ).catch((err) => logger.warn('Failed to close backing browser session on SSE cancel', {
              error: err instanceof Error ? err.message : String(err),
            }));
          }
          removeSseSession(mcpSessionId);
        },
        start(controller) {
          createSseSession(mcpSessionId, {
            controller,
            projectId: ctx.projectId,
            serverKey: `browser:${browserKey}`,
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            tokenId: ctx.tokenRecord._id?.toString(),
          });
          controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
        },
      });

      logger.info('Browser MCP SSE session opened', {
        browserKey, mcpSessionId, tenantId: ctx.tenantId,
      });

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Mcp-Session-Id', mcpSessionId);

      return reply.send(
        Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>),
      );
    } catch (error) {
      logger.error('Browser MCP SSE error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Internal error',
      });
    }
  }));
};
