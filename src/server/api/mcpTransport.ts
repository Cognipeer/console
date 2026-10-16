/**
 * Pieces shared by the MCP HTTP plugins (public, client, console, browser):
 * the SSE response, the lookup of the session a message names, and the reading
 * of a JSON-RPC request. Keeping them in one place is what keeps the four
 * transports behaving alike.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getSseSessionFor,
  McpSseLimitError,
  openSseStream,
  removeSseSession,
  type McpSseBinding,
  type McpSseSession,
} from '@/lib/services/mcp/sseSessionManager';
import { applyStreamHeaders, readJsonBody } from './fastify-utils';

const logger = createLogger('api:mcp-transport');

/** Streams refused for a limit are logged this often at most, however many are refused. */
const REFUSAL_LOG_INTERVAL_MS = 30_000;
let lastRefusalLoggedAt = 0;

// ── JSON-RPC ──────────────────────────────────────────────────────────────

export interface JsonRpcRequestBody {
  id?: string | number | null;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
}

export type JsonRpcReadResult =
  | { ok: true; body: JsonRpcRequestBody }
  | { ok: false; code: -32700 | -32600; message: string };

/**
 * The request body as a JSON-RPC request object. Text that is not JSON is a
 * parse error; JSON that is not an object (`null`, a number, a string, an
 * array — batches are not supported) is an invalid request.
 */
export function readJsonRpcRequest(request: FastifyRequest): JsonRpcReadResult {
  let parsed: unknown;
  try {
    parsed = readJsonBody<unknown>(request);
  } catch {
    return { ok: false, code: -32700, message: 'Parse error' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: -32600, message: 'Invalid Request' };
  }
  return { ok: true, body: parsed as JsonRpcRequestBody };
}

/**
 * The body of a REST call as a JSON object, or null when it is missing, not
 * JSON, or JSON of another shape.
 */
export function readJsonObjectBody<T extends Record<string, unknown>>(request: FastifyRequest): T | null {
  try {
    const parsed = readJsonBody<unknown>(request);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function jsonRpcErrorBody(id: string | number | null, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: '2.0' };
}

/** True when the request declares a JSON body: `application/json` or `application/*+json`, with or without parameters. */
export function hasJsonContentType(request: FastifyRequest): boolean {
  const header = request.headers['content-type'];
  const value = Array.isArray(header) ? header[0] : header;
  const mediaType = (value ?? '').split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || /^application\/[\w.+-]+\+json$/.test(mediaType);
}

// ── Sessions ──────────────────────────────────────────────────────────────

export type MessageSession =
  /** The message names no session: a streamable-HTTP call, answered in the HTTP response. */
  | { kind: 'stateless' }
  /** The message belongs to an open stream this caller opened. */
  | { kind: 'session'; sessionId: string; session: McpSseSession }
  /** The message names a session that does not exist, or that someone else opened. */
  | { kind: 'unknown' };

/** Resolve the `?sessionId=` of a message request against the caller's binding. */
export function lookupMessageSession(request: FastifyRequest, binding: McpSseBinding): MessageSession {
  const raw = (request.query as { sessionId?: unknown } | undefined)?.sessionId;
  if (raw === undefined || raw === '') return { kind: 'stateless' };
  if (typeof raw !== 'string') return { kind: 'unknown' };
  const session = getSseSessionFor(raw, binding);
  return session ? { kind: 'session', sessionId: raw, session } : { kind: 'unknown' };
}

/** The answer to a message that names a session the caller does not have. */
export function sendSessionNotFound(reply: FastifyReply) {
  return reply.code(404).send(jsonRpcErrorBody(null, -32001, 'Session not found'));
}

// ── SSE response ──────────────────────────────────────────────────────────

/**
 * Where a client should POST its messages, for the `endpoint` event: the path
 * and query alone, never an absolute URL. MCP clients resolve it against the
 * URL they opened the stream on, so it is right whatever hostname or port the
 * client reached the gateway through; a URL built here from the configured
 * public URL (APP_URL) or from the request's headers would be wrong for a
 * client that arrives under another name.
 */
export function mcpEndpointUrl(path: string, sessionId: string): string {
  return `${path}?sessionId=${encodeURIComponent(sessionId)}`;
}

export interface McpSseResponseOptions {
  /** Path the client POSTs its messages to, without the query. */
  messagePath: string;
  /** Binding and routing context of the new session (the stream supplies the controller). */
  session: Omit<McpSseSession, 'controller'>;
  /** Fields for the log lines about the stream. */
  logFields: Record<string, unknown>;
}

/**
 * Answer a GET .../sse request with an event stream and register its session.
 * A stream over a limit is answered with 429/503, a `Retry-After` and a JSON
 * body instead. The session is removed however the response ends — the client
 * leaving, the socket failing, the server finishing it — and not only when the
 * stream is cancelled.
 */
export function startMcpSseResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  options: McpSseResponseOptions,
): FastifyReply {
  const sessionId = randomUUID();
  const sessionRef = sessionId.slice(0, 8);

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = openSseStream({
      sessionId,
      session: options.session,
      messageEndpoint: mcpEndpointUrl(options.messagePath, sessionId),
    });
  } catch (error) {
    if (error instanceof McpSseLimitError) {
      const now = Date.now();
      if (now - lastRefusalLoggedAt >= REFUSAL_LOG_INTERVAL_MS) {
        lastRefusalLoggedAt = now;
        logger.warn('MCP SSE stream refused', { ...options.logFields, status: error.status });
      }
      return reply
        .code(error.status)
        .header('Retry-After', String(error.retryAfterSeconds))
        .send({ error: error.message });
    }
    throw error;
  }

  const socket = request.raw.socket;
  const release = () => {
    socket?.off('close', release);
    socket?.off('error', release);
    removeSseSession(sessionId);
  };
  reply.raw.once('close', release);
  reply.raw.once('finish', release);
  reply.raw.once('error', release);
  socket?.once('close', release);
  socket?.once('error', release);
  // The caller may be gone already (it hung up while the request was being
  // authorised); the events above would never fire.
  if (reply.raw.destroyed || socket?.destroyed) release();

  logger.info('MCP SSE session opened', { ...options.logFields, session: sessionRef });

  applyStreamHeaders(reply);
  reply.raw.setHeader('X-Mcp-Session-Id', sessionId);

  return reply.send(Readable.fromWeb(stream as unknown as NodeReadableStream<Uint8Array>));
}
