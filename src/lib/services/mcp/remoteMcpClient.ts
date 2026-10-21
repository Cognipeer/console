/**
 * Remote MCP client — speaks JSON-RPC over HTTP (streamable HTTP transport)
 * to an upstream MCP server, through the shared SSRF-guarded fetch.
 *
 * The gateway calls remote servers statelessly: one POST per JSON-RPC call.
 * Servers that require the legacy HTTP+SSE session dance are not supported
 * for proxying; 'sse' transport still attempts plain POSTs (many servers
 * accept both), and fails with a clear error otherwise.
 */

import { safeFetch } from '@/lib/security/outboundFetch';
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
async function readSseResponse(response: Response, id: number): Promise<JsonRpcMessage> {
  if (!response.body) throw new Error('MCP server returned an empty SSE response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    reader.cancel().catch(() => { /* already closed */ });
  }
  throw new Error('MCP server closed the SSE stream without answering the request');
}

async function rpcCall(
  target: RemoteMcpTarget,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = ++rpcId;
  const authHeaders = buildUpstreamAuthHeaders(target.auth);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable HTTP servers may respond with JSON or an SSE stream.
    Accept: 'application/json, text/event-stream',
    ...authHeaders,
    ...(target.extraHeaders ?? {}),
  };

  const response = await safeFetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  }, {
    // Credentials injected for this upstream do not follow a redirect to
    // another origin.
    sensitiveHeaders: [...Object.keys(authHeaders), ...Object.keys(target.extraHeaders ?? {})],
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new McpUpstreamError(`MCP server responded with ${response.status}: ${errText.slice(0, 500)}`, response.status);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload: JsonRpcMessage = contentType.includes('text/event-stream')
    ? await readSseResponse(response, id)
    : await response.json();

  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code ?? ''}: ${payload.error.message ?? 'unknown'}`);
  }
  return payload.result;
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
      clientInfo: { name: 'cognipeer-mcp-gateway', version: '1.0.0' },
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
