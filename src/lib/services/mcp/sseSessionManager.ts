/**
 * MCP SSE session manager.
 *
 * Maps sessionId → session data with an SSE controller reference so the
 * message endpoint can push JSON-RPC responses back through the open stream.
 *
 * The stream lives on the node that accepted `GET /sse`, but the follow-up
 * `POST /message?sessionId=…` can land on any node behind a load balancer. When
 * a Redis relay transport exists, each session is therefore also:
 *   - registered under a short-lived key (`mcp:sse:session:<id>`) carrying the
 *     owning server/tenant, so any node can recognise and authorise it, and
 *   - subscribed on `mcp:sse:down:<id>`, so a response published by another
 *     node is written into the local stream.
 * Without Redis (single node) everything stays in-process.
 */

import { getRelayTransport } from '@/lib/core/cluster/streamRelay';
import { createLogger } from '@/lib/core/logger';

const log = createLogger('mcp.sse');

export interface McpSseSession {
  serverKey: string;
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  tokenId: string | undefined;
  controller: ReadableStreamDefaultController | null;
}

/** Owner info any node can read for a session it does not hold. */
export interface McpSseSessionRef {
  serverKey: string;
  tenantId: string;
}

/** Registry TTL; refreshed on every keep-alive tick while the stream is open. */
const REGISTRY_TTL_SECONDS = 90;
/** Below typical proxy idle timeouts (60s) and well inside the registry TTL. */
export const SSE_KEEPALIVE_MS = 20_000;

interface LocalEntry {
  session: McpSseSession;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => Promise<void>) | null;
  closed: boolean;
}

const sessions = new Map<string, LocalEntry>();

const registryKey = (sessionId: string) => `mcp:sse:session:${sessionId}`;
const downChannel = (sessionId: string) => `mcp:sse:down:${sessionId}`;

/** Encode one SSE frame */
function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function writeRaw(controller: ReadableStreamDefaultController | null, text: string): boolean {
  if (!controller) return false;
  try {
    controller.enqueue(new TextEncoder().encode(text));
    return true;
  } catch {
    return false; // stream already closed – ignore
  }
}

export function createSseSession(sessionId: string, session: McpSseSession) {
  const entry: LocalEntry = { session, timer: null, unsubscribe: null, closed: false };
  sessions.set(sessionId, entry);

  const transport = getRelayTransport();
  const ref: McpSseSessionRef = { serverKey: session.serverKey, tenantId: session.tenantId };
  const register = () => transport?.setKey?.(registryKey(sessionId), JSON.stringify(ref), REGISTRY_TTL_SECONDS)
    .catch((error: Error) => log.warn('SSE registry write failed', { sessionId, error: error.message }));

  if (transport?.setKey && transport.getKey) {
    void register();
    transport
      .subscribe(downChannel(sessionId), (message) => writeRaw(session.controller, sseFrame('message', message)))
      .then((unsubscribe) => {
        if (entry.closed) void unsubscribe().catch(() => undefined);
        else entry.unsubscribe = unsubscribe;
      })
      .catch((error: Error) => log.warn('SSE relay subscribe failed', { sessionId, error: error.message }));
  }

  entry.timer = setInterval(() => {
    if (!writeRaw(session.controller, ': ping\n\n')) {
      removeSseSession(sessionId);
      return;
    }
    void register();
  }, SSE_KEEPALIVE_MS);
  entry.timer.unref?.();
}

export function getSseSession(sessionId: string): McpSseSession | undefined {
  return sessions.get(sessionId)?.session;
}

export function removeSseSession(sessionId: string) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  entry.closed = true;
  sessions.delete(sessionId);
  if (entry.timer) clearInterval(entry.timer);
  void entry.unsubscribe?.().catch(() => undefined);
  void getRelayTransport()?.delKey?.(registryKey(sessionId)).catch(() => undefined);
}

/**
 * Look a session up on another node. Undefined when there is no Redis, the
 * session is unknown/expired, or Redis is unreachable (caller falls back to
 * plain streamable-HTTP behaviour, as before).
 */
export async function getRemoteSseSession(sessionId: string): Promise<McpSseSessionRef | undefined> {
  const transport = getRelayTransport();
  if (!transport?.getKey) return undefined;
  try {
    const raw = await transport.getKey(registryKey(sessionId));
    if (!raw) return undefined;
    const ref = JSON.parse(raw) as McpSseSessionRef;
    return ref && typeof ref.serverKey === 'string' && typeof ref.tenantId === 'string' ? ref : undefined;
  } catch (error) {
    log.warn('SSE registry read failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

/**
 * Send a JSON-RPC response through the SSE stream identified by sessionId —
 * locally when this node holds the stream, otherwise over the Redis relay.
 */
export async function sendSseResponse(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  const entry = sessions.get(sessionId);
  if (entry) {
    writeRaw(entry.session.controller, sseFrame('message', JSON.stringify(payload)));
    return;
  }
  const transport = getRelayTransport();
  if (!transport) return;
  await transport.publish(downChannel(sessionId), JSON.stringify(payload));
}

/**
 * Encode an SSE endpoint event (used during stream initialization).
 */
export function encodeSseEndpointEvent(messageEndpoint: string): Uint8Array {
  return new TextEncoder().encode(sseFrame('endpoint', messageEndpoint));
}
