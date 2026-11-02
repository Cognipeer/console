/**
 * Remote MCP client — speaks JSON-RPC over HTTP (streamable HTTP transport)
 * to an upstream MCP server, through the shared SSRF-guarded fetch.
 *
 * Calls are stateless first: one POST per JSON-RPC call. A streamable HTTP
 * server that requires a session gets one opened for the call (see `rpcCall`).
 * Servers that require the legacy HTTP+SSE session dance are not supported
 * for proxying; 'sse' transport still attempts plain POSTs (many servers
 * accept both), and fails with a clear error otherwise.
 */

import { readResponseText, ResponseTooLargeError, safeFetch } from '@/lib/security/outboundFetch';
import { getConfig } from '@/lib/core/config';
import { McpUpstreamError } from './errors';
import {
  MAX_TOOL_LIST_PAGES,
  readInitializeInstructions,
  readToolListPage,
  type McpDiscovery,
} from './discovery';
import { contentHasMedia, mcpResultToToolOutput } from '@/lib/services/tools/toolOutput';
import type { IMcpAuthConfig, IMcpTool } from '@/lib/database';

const JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';

export interface RemoteMcpTarget {
  url: string;
  transport?: 'streamable-http' | 'sse';
  auth?: IMcpAuthConfig;
  /** Caller-supplied, policy-filtered runtime headers; merged after static auth. */
  extraHeaders?: Record<string, string>;
  /** Aborts the HTTP requests of a call (an agent turn's signal). */
  signal?: AbortSignal;
}

export function buildUpstreamAuthHeaders(auth: IMcpAuthConfig | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!auth) return headers;
  if (auth.type === 'token' && auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  } else if (auth.type === 'header' && auth.headerName && auth.headerValue) {
    headers[auth.headerName] = auth.headerValue;
  } else if (auth.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }
  return headers;
}

/**
 * Run one upstream call under the configured total-time and response-size
 * limits. `signal` covers headers and body together; a call that exceeds
 * either limit fails as an upstream error with a neutral message.
 */
export async function withUpstreamLimits<T>(
  run: (limits: { signal: AbortSignal; maxBytes: number }) => Promise<T>,
): Promise<T> {
  const { maxResponseBytes: maxBytes, timeoutMs } = getConfig().mcp.upstream;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Upstream did not answer within ${timeoutMs} ms`));
  }, timeoutMs);
  try {
    return await run({ signal: controller.signal, maxBytes });
  } catch (error) {
    if (timedOut) {
      throw new McpUpstreamError(`Upstream did not answer within ${timeoutMs} ms`, 504);
    }
    if (error instanceof ResponseTooLargeError) {
      throw new McpUpstreamError(error.message, 502);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

let rpcId = 0;

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** The message in `data` (one JSON-RPC message or a batch) that answers request `id`, if any. */
function findResponse(data: string, id: number): JsonRpcMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as JsonRpcMessage[];
  return messages.find((m) => m
    && typeof m === 'object'
    // Some servers echo numeric ids back as strings.
    && (m.id === id || m.id === String(id))
    && (m.result !== undefined || m.error !== undefined));
}

/** The `data:` payload of one SSE event block (multi-line data joins with newlines). */
function sseEventData(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
    .join('\n');
}

/**
 * Streamable HTTP may answer with an SSE stream that carries notifications
 * (progress, log messages) or server requests BEFORE the response — read
 * events until the one answering `id` arrives, then stop: a server that keeps
 * the stream open afterwards is not waited for.
 */
async function readSseResponse(
  response: Response,
  id: number,
  limits: { signal: AbortSignal; maxBytes: number },
): Promise<JsonRpcMessage> {
  if (!response.body) throw new Error('MCP server returned an empty SSE response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  const onAbort = () => { reader.cancel().catch(() => { /* already closed */ }); };
  limits.signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (limits.signal.aborted) throw limits.signal.reason ?? new Error('Aborted');
      if (value) {
        received += value.byteLength;
        if (received > limits.maxBytes) throw new ResponseTooLargeError(limits.maxBytes);
      }
      if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      if (done) buffer += '\n\n';
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const match = findResponse(sseEventData(block), id);
        if (match) return match;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
  } finally {
    limits.signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => { /* already closed */ });
  }
  throw new Error('MCP server closed the SSE stream without answering the request');
}

const SESSION_HEADER = 'Mcp-Session-Id';

type UpstreamLimits = { signal: AbortSignal; maxBytes: number };

function requestHeaders(target: RemoteMcpTarget, sessionId?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // Streamable HTTP servers may respond with JSON or an SSE stream.
    Accept: 'application/json, text/event-stream',
    ...buildUpstreamAuthHeaders(target.auth),
    ...(target.extraHeaders ?? {}),
    ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
  };
}

/** Headers that must not follow a redirect to another origin: everything but the two content headers. */
function sensitiveHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((name) => name !== 'Content-Type' && name !== 'Accept');
}

/** The call's limits, with the caller's signal (an agent turn's) aborting it too. */
function callLimits(target: RemoteMcpTarget, limits: UpstreamLimits): UpstreamLimits {
  return target.signal ? { signal: AbortSignal.any([limits.signal, target.signal]), maxBytes: limits.maxBytes } : limits;
}

/** One POST: a JSON-RPC request, its JSON or SSE answer, and the session id the server sent, if any. */
async function exchange(
  target: RemoteMcpTarget,
  method: string,
  params: Record<string, unknown> | undefined,
  upstreamLimits: UpstreamLimits,
  sessionId?: string,
): Promise<{ result: unknown; sessionId?: string }> {
  const id = ++rpcId;
  const headers = requestHeaders(target, sessionId);
  const limits = callLimits(target, upstreamLimits);

  const response = await safeFetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
    signal: limits.signal,
  }, {
    keepAbortLinked: true,
    // Credentials injected for this upstream do not follow a redirect to
    // another origin.
    sensitiveHeaders: sensitiveHeaderNames(headers),
  });

  if (!response.ok) {
    const errText = await readResponseText(response, {
      maxBytes: Math.min(limits.maxBytes, 64 * 1024),
      signal: limits.signal,
    }).catch(() => 'Unknown error');
    throw new McpUpstreamError(`MCP server responded with ${response.status}: ${errText.slice(0, 500)}`, response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload: JsonRpcMessage = contentType.includes('text/event-stream')
    ? await readSseResponse(response, id, limits)
    : JSON.parse(await readResponseText(response, limits)) as JsonRpcMessage;

  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code ?? ''}: ${payload.error.message ?? 'unknown'}`);
  }
  return { result: payload.result, sessionId: response.headers.get(SESSION_HEADER) ?? undefined };
}

const CLIENT_INFO = { name: 'cognipeer-mcp-gateway', version: '1.0.0' };

/** `initialize`, then `notifications/initialized`. Undefined when the server hands out no session id. */
async function openSession(target: RemoteMcpTarget, upstreamLimits: UpstreamLimits): Promise<string | undefined> {
  const { sessionId } = await exchange(target, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  }, upstreamLimits);
  if (!sessionId) return undefined;
  const headers = requestHeaders(target, sessionId);
  const limits = callLimits(target, upstreamLimits);
  const response = await safeFetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' }),
    signal: limits.signal,
  }, { keepAbortLinked: true, sensitiveHeaders: sensitiveHeaderNames(headers) });
  // 202 with no body; nothing in it matters.
  await readResponseText(response, { maxBytes: Math.min(limits.maxBytes, 64 * 1024), signal: limits.signal }).catch(() => '');
  return sessionId;
}

/** Upstreams that refused a call without a session and handed one out on `initialize`. */
const sessionUpstreams = new Set<string>();

/**
 * One JSON-RPC call, under one time and size budget (a session it opens
 * included). A server that requires a session answers a call without one with
 * 400 or 404 (streamable HTTP); the call then opens a session and is sent once
 * more inside it, and later calls to that upstream open the session first. A
 * session is not reused across calls.
 */
function rpcCall(
  target: RemoteMcpTarget,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return withUpstreamLimits((limits) => rpcCallBounded(target, method, params, limits));
}

async function rpcCallBounded(
  target: RemoteMcpTarget,
  method: string,
  params: Record<string, unknown> | undefined,
  limits: UpstreamLimits,
): Promise<unknown> {
  if (method !== 'initialize' && sessionUpstreams.has(target.url)) {
    return (await exchange(target, method, params, limits, await openSession(target, limits))).result;
  }
  try {
    return (await exchange(target, method, params, limits)).result;
  } catch (error) {
    const sessionRefusal = error instanceof McpUpstreamError && (error.status === 400 || error.status === 404);
    if (method === 'initialize' || !sessionRefusal) throw error;
    const sessionId = await openSession(target, limits).catch(() => undefined);
    if (!sessionId) throw error;
    sessionUpstreams.add(target.url);
    return (await exchange(target, method, params, limits, sessionId)).result;
  }
}

/** A JSON-RPC call whose result the caller reads itself (Tools keeps its own `tools/call` result rules). */
export function remoteRpc(
  target: RemoteMcpTarget,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return rpcCall(target, method, params);
}

/** List tools on a remote MCP server, following `nextCursor` across pages. */
export async function remoteListTools(target: RemoteMcpTarget): Promise<IMcpTool[]> {
  const tools: IMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
    const result = await rpcCall(target, 'tools/list', cursor === undefined ? {} : { cursor });
    const read = readToolListPage(result);
    tools.push(...read.tools);
    if (read.nextCursor === undefined || seenCursors.has(read.nextCursor)) break;
    seenCursors.add(read.nextCursor);
    cursor = read.nextCursor;
  }
  return tools;
}

/**
 * Discover a remote server: its tools, and the `instructions` its
 * `initialize` result carries. Stateless upstreams answer tools/list without
 * the handshake, so a failed `initialize` leaves the instructions unknown
 * instead of failing discovery.
 */
export async function remoteDiscover(target: RemoteMcpTarget): Promise<McpDiscovery> {
  let instructions: string | null | undefined;
  try {
    instructions = readInitializeInstructions(await rpcCall(target, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }));
  } catch {
    instructions = undefined;
  }
  return { tools: await remoteListTools(target), instructions };
}

/** Call a tool on a remote MCP server and unwrap the content payload. */
export async function remoteCallTool(
  target: RemoteMcpTarget,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await rpcCall(target, 'tools/call', {
    name: toolName,
    arguments: args,
  })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  } | undefined;

  if (result?.isError) {
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(text || 'MCP tool call failed');
  }

  // Images/audio/resources survive as a ToolOutput; text-only results keep the legacy unwrap.
  if (contentHasMedia(result?.content)) return mcpResultToToolOutput(result);

  if (result?.structuredContent !== undefined) return result.structuredContent;

  const content = result?.content;
  if (Array.isArray(content)) {
    const textParts = content.filter((c) => c.type === 'text');
    if (textParts.length === 1) {
      // Return parsed JSON when the single text part is JSON, else raw text.
      const text = textParts[0].text ?? '';
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return textParts.map((c) => c.text).join('\n');
  }
  return result;
}
