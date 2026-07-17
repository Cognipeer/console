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

async function rpcCall(
  target: RemoteMcpTarget,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable HTTP servers may respond with JSON or an SSE stream.
    Accept: 'application/json, text/event-stream',
    ...buildUpstreamAuthHeaders(target.auth),
    ...(target.extraHeaders ?? {}),
  };

  const response = await safeFetch(target.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id: ++rpcId,
      method,
      ...(params !== undefined ? { params } : {}),
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    throw new Error(`MCP server responded with ${response.status}: ${errText.slice(0, 500)}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  let payload: { result?: unknown; error?: { code?: number; message?: string } };

  if (contentType.includes('text/event-stream')) {
    // Streamable HTTP may deliver the response as a short SSE stream — take
    // the first `message` event's data payload.
    const raw = await response.text();
    const dataLine = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error('MCP server returned an empty SSE response');
    payload = JSON.parse(dataLine.slice(5).trim());
  } else {
    payload = await response.json();
  }

  if (payload.error) {
    throw new Error(`MCP error ${payload.error.code ?? ''}: ${payload.error.message ?? 'unknown'}`);
  }
  return payload.result;
}

/** Run the initialize handshake (stateless servers tolerate skipping it). */
export async function remoteInitialize(target: RemoteMcpTarget): Promise<void> {
  try {
    await rpcCall(target, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'cognipeer-mcp-gateway', version: '1.0.0' },
    });
  } catch {
    // Stateless upstreams often accept tools/list without initialize.
  }
}

/** List tools on a remote MCP server. */
export async function remoteListTools(target: RemoteMcpTarget): Promise<IMcpTool[]> {
  const result = (await rpcCall(target, 'tools/list', {})) as {
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  } | undefined;

  const tools = result?.tools ?? [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description || t.name,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
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
