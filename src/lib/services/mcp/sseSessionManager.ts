/**
 * MCP SSE session manager.
 *
 * Maps sessionId → session data with an SSE controller reference so the
 * message endpoint can push JSON-RPC responses back through the open stream.
 *
 * A session belongs to the stream that opened it: it is bound to the tenant,
 * the MCP server (endpoint) and the principal that opened it — `public` for the
 * unauthenticated endpoints, `token:<id>` for an API token — and a message may
 * only be delivered into it by a caller presenting the same binding
 * (`getSseSessionFor`).
 *
 * The registry is bounded (limits are env-configurable, see
 * docs/guide/configuration.md "MCP Gateway"):
 *  - a process-wide cap on open sessions, and a per-address cap on the public
 *    endpoints; a stream over a cap is refused with `McpSseLimitError`;
 *  - an idle timeout: a session that has received no message for a while is
 *    closed (the keep-alive comments sent to the client do not count);
 *  - a backlog bound: a session whose unsent output exceeds it is closed;
 *  - a keep-alive comment frame on an otherwise quiet stream.
 * A session never outlives its stream: whichever way the stream ends, the entry
 * is removed.
 *
 * The stream lives on the node that accepted `GET /sse`, but the follow-up
 * `POST /message?sessionId=…` can land on any node behind a load balancer. When
 * a Redis relay transport exists, each session is therefore also:
 *   - registered under a short-lived key (`mcp:sse:session:<id>`) carrying its
 *     binding (server, tenant, project, principal), so any node can recognise
 *     and authorise it (`getRemoteSseSessionFor`), and
 *   - subscribed on `mcp:sse:down:<id>`, so a response published by another
 *     node (`deliverSseResponse`) is written into the local stream.
 * Without Redis (single node) everything stays in-process.
 */

import { getRelayTransport } from '@/lib/core/cluster/streamRelay';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('mcp-sse');

/** Principal of a stream opened on a public (unauthenticated) endpoint. */
export const PUBLIC_SSE_PRINCIPAL = 'public';

/** Principal of a stream opened with an API token. */
export function tokenSsePrincipal(tokenId: string | undefined): string {
  return `token:${tokenId ?? ''}`;
}

export interface McpSseSession {
  serverKey: string;
  tenantDbName: string;
  tenantId: string;
  projectId: string | undefined;
  tokenId: string | undefined;
  controller: ReadableStreamDefaultController | null;
  /** `public`, or `token:<id>`. Derived from `tokenId` when the opener leaves it out. */
  principal?: string;
  /** Address of the caller, on the public endpoints (they are capped per address). */
  clientIp?: string;
  /** Runs once, with the session's id, when the session is removed — however that happens. */
  onClose?: (sessionId: string) => void;
}

/** What a message request must present to deliver into a session. */
export interface McpSseBinding {
  tenantId: string;
  projectId?: string;
  serverKey: string;
  principal: string;
}

/** Owner info any node can read for a session it does not hold. */
export interface McpSseSessionRef {
  serverKey: string;
  tenantId: string;
  projectId?: string;
  /** Absent in a record written before sessions carried a principal; such a record never matches a binding. */
  principal?: string;
}

/** A stream was refused: a cap is reached. Carries the HTTP status and a retry hint. */
export class McpSseLimitError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 503,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'McpSseLimitError';
  }
}

interface ManagedSession extends McpSseSession {
  principal: string;
  /** Last message received for the session (or its creation). Keep-alive output does not count. */
  lastInboundAt: number;
  /** Last frame enqueued. */
  lastWriteAt: number;
  /** Byte budget of the stream's queue when the manager built it; 0 = unbounded. */
  queueBudget: number;
  /** Whether this session was registered with the Redis relay (and so must be unregistered). */
  relayRegistered: boolean;
  /** Last time the relay registry entry was written. */
  registryWrittenAt: number;
  /** Ends the relay subscription; null until it is live. */
  unsubscribe: (() => Promise<void>) | null;
}

const sessions = new Map<string, ManagedSession>();
/** Open sessions per client address (public endpoints only). */
const sessionsPerAddress = new Map<string, number>();

/** A refused stream may be retried after this long: streams free up as clients leave. */
const LIMIT_RETRY_AFTER_SECONDS = 30;
/** Public streams stop at this share of the process cap so token callers keep room. */
const PUBLIC_SESSION_SHARE = 0.75;
const KEEPALIVE_FRAME = ': keepalive\n\n';
/** Registry TTL; refreshed by the sweep while the stream is open. */
const REGISTRY_TTL_SECONDS = 90;
/** How often the sweep rewrites a session's registry entry (well inside the TTL). */
const REGISTRY_REFRESH_MS = 20_000;

const encoder = new TextEncoder();

const registryKey = (sessionId: string) => `mcp:sse:session:${sessionId}`;
const downChannel = (sessionId: string) => `mcp:sse:down:${sessionId}`;

/** First characters of an id: enough to correlate log lines, not enough to use it. */
function idRef(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** Encode one SSE frame */
function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

function principalOf(session: Pick<McpSseSession, 'principal' | 'tokenId'>): string {
  return session.principal ?? (session.tokenId ? tokenSsePrincipal(session.tokenId) : PUBLIC_SSE_PRINCIPAL);
}

/**
 * Throws `McpSseLimitError` when a stream with this principal / address cannot
 * be admitted. Public streams are held to a smaller share of the process cap
 * than token streams, so anonymous traffic cannot take the last slots.
 */
function assertCapacity(principal: string, clientIp: string | undefined): void {
  const { maxSessions, maxSessionsPerIp } = getConfig().mcp.sse;
  const isPublic = principal === PUBLIC_SSE_PRINCIPAL;

  if (isPublic && clientIp && maxSessionsPerIp > 0 && (sessionsPerAddress.get(clientIp) ?? 0) >= maxSessionsPerIp) {
    throw new McpSseLimitError(
      'Too many open MCP streams from this address; close one and retry',
      429,
      LIMIT_RETRY_AFTER_SECONDS,
    );
  }
  if (maxSessions > 0) {
    const cap = isPublic ? Math.max(1, Math.floor(maxSessions * PUBLIC_SESSION_SHARE)) : maxSessions;
    if (sessions.size >= cap) {
      throw new McpSseLimitError(
        'The MCP gateway has too many open streams; retry shortly',
        503,
        LIMIT_RETRY_AFTER_SECONDS,
      );
    }
  }
}

function sweepIntervalMs(): number {
  const { idleTimeoutMs, keepaliveMs } = getConfig().mcp.sse;
  const candidates = [15_000];
  if (keepaliveMs > 0) candidates.push(Math.floor(keepaliveMs / 2));
  if (idleTimeoutMs > 0) candidates.push(Math.floor(idleTimeoutMs / 4));
  return Math.max(250, Math.min(...candidates));
}

let sweeper: ReturnType<typeof setInterval> | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepSseSessions(), sweepIntervalMs());
  // The sweep must never keep the process alive.
  if (typeof sweeper === 'object' && 'unref' in sweeper) sweeper.unref();
}

function stopSweeperWhenEmpty(): void {
  if (sessions.size > 0 || !sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

function register(sessionId: string, session: McpSseSession, queueBudget: number): void {
  const now = Date.now();
  const managed: ManagedSession = {
    ...session,
    principal: principalOf(session),
    lastInboundAt: now,
    lastWriteAt: now,
    queueBudget,
    relayRegistered: false,
    registryWrittenAt: now,
    unsubscribe: null,
  };
  // A second registration under the same id replaces the first; keep the
  // per-address count honest.
  if (sessions.has(sessionId)) removeSseSession(sessionId);
  sessions.set(sessionId, managed);
  if (managed.clientIp) {
    sessionsPerAddress.set(managed.clientIp, (sessionsPerAddress.get(managed.clientIp) ?? 0) + 1);
  }
  ensureSweeper();
  attachRelay(sessionId, managed);
}

function writeRegistry(sessionId: string, session: ManagedSession): void {
  const transport = getRelayTransport();
  if (!transport?.setKey) return;
  session.registryWrittenAt = Date.now();
  const ref: McpSseSessionRef = {
    serverKey: session.serverKey,
    tenantId: session.tenantId,
    projectId: session.projectId,
    principal: session.principal,
  };
  transport.setKey(registryKey(sessionId), JSON.stringify(ref), REGISTRY_TTL_SECONDS).catch((error: Error) => {
    logger.warn('MCP SSE registry write failed', { session: idRef(sessionId), error: error.message });
  });
}

/** Make the session reachable from other nodes, when a relay with a key store exists. */
function attachRelay(sessionId: string, session: ManagedSession): void {
  const transport = getRelayTransport();
  if (!transport?.setKey || !transport.getKey) return;
  session.relayRegistered = true;
  writeRegistry(sessionId, session);
  transport
    .subscribe(downChannel(sessionId), (message) => {
      if (sessions.get(sessionId) === session) {
        writeFrame(sessionId, session, encoder.encode(sseFrame('message', message)));
      }
    })
    .then((unsubscribe) => {
      // The session may have ended while the subscription was being set up.
      if (sessions.get(sessionId) !== session) void unsubscribe().catch(() => undefined);
      else session.unsubscribe = unsubscribe;
    })
    .catch((error: Error) => {
      logger.warn('MCP SSE relay subscribe failed', { session: idRef(sessionId), error: error.message });
    });
}

/**
 * Register a session whose stream the caller built. Refused with
 * `McpSseLimitError` when a cap is reached. Prefer `openSseStream`, which also
 * sizes the stream so its backlog can be bounded.
 */
export function createSseSession(sessionId: string, session: McpSseSession): void {
  assertCapacity(principalOf(session), session.clientIp);
  register(sessionId, session, 0);
}

export function getSseSession(sessionId: string): McpSseSession | undefined {
  return sessions.get(sessionId);
}

/**
 * The session, only when it was opened under this binding. An unknown id and a
 * session that belongs to someone else are indistinguishable to the caller.
 * Counts as activity for the idle timeout.
 */
export function getSseSessionFor(sessionId: string, binding: McpSseBinding): McpSseSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;
  if (
    session.tenantId !== binding.tenantId
    || session.serverKey !== binding.serverKey
    || session.principal !== binding.principal
    || (session.projectId ?? '') !== (binding.projectId ?? '')
  ) {
    return undefined;
  }
  session.lastInboundAt = Date.now();
  return session;
}

export function removeSseSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  if (session.clientIp) {
    const left = (sessionsPerAddress.get(session.clientIp) ?? 1) - 1;
    if (left > 0) sessionsPerAddress.set(session.clientIp, left);
    else sessionsPerAddress.delete(session.clientIp);
  }
  stopSweeperWhenEmpty();
  if (session.relayRegistered) {
    void session.unsubscribe?.().catch(() => undefined);
    void getRelayTransport()?.delKey?.(registryKey(sessionId)).catch(() => undefined);
  }
  try {
    session.onClose?.(sessionId);
  } catch (error) {
    logger.warn('MCP SSE session cleanup failed', {
      session: idRef(sessionId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * End a session from the server side: drop it and finish its stream. With
 * `discardBacklog` the stream is errored instead of closed, so output the
 * client never read is released rather than held until it does.
 */
export function closeSseSession(sessionId: string, reason: string, discardBacklog = false): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  logger.info('MCP SSE session closed by the gateway', { session: idRef(sessionId), reason });
  removeSseSession(sessionId);
  try {
    if (discardBacklog) session.controller?.error(new Error(reason));
    else session.controller?.close();
  } catch {
    // The stream is already finished.
  }
}

/** True once the stream's unsent output is past its budget. */
function overBudget(session: ManagedSession): boolean {
  if (session.queueBudget <= 0 || !session.controller) return false;
  const desired = session.controller.desiredSize;
  return desired !== null && desired < 0;
}

/** Enqueue one frame; false when the session is gone or was closed for not draining. */
function writeFrame(sessionId: string, session: ManagedSession, frame: Uint8Array): boolean {
  if (!session.controller) return false;
  if (overBudget(session)) {
    closeSseSession(sessionId, 'client is not reading the stream', true);
    return false;
  }
  try {
    session.controller.enqueue(frame);
  } catch {
    // The stream ended under us.
    removeSseSession(sessionId);
    return false;
  }
  session.lastWriteAt = Date.now();
  return true;
}

/**
 * Send a JSON-RPC response through the SSE stream identified by sessionId.
 * Returns false when it could not be delivered.
 */
export function sendSseResponse(sessionId: string, payload: Record<string, unknown>): boolean {
  const session = sessions.get(sessionId);
  if (!session?.controller) return false;
  return writeFrame(sessionId, session, encoder.encode(sseFrame('message', JSON.stringify(payload))));
}

/**
 * Look a session up on another node: its registered binding, when this node
 * does not hold it. Undefined when there is no Redis, the session is unknown or
 * expired, or Redis is unreachable.
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
    logger.warn('MCP SSE registry read failed', {
      session: idRef(sessionId),
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The remote session's binding, only when it was opened under this binding —
 * the cross-node counterpart of `getSseSessionFor`. An unknown id and a session
 * that belongs to someone else are indistinguishable to the caller.
 */
export async function getRemoteSseSessionFor(
  sessionId: string,
  binding: McpSseBinding,
): Promise<McpSseSessionRef | undefined> {
  const ref = await getRemoteSseSession(sessionId);
  if (!ref) return undefined;
  if (
    ref.tenantId !== binding.tenantId
    || ref.serverKey !== binding.serverKey
    || ref.principal !== binding.principal
    || (ref.projectId ?? '') !== (binding.projectId ?? '')
  ) {
    return undefined;
  }
  return ref;
}

/**
 * Send a JSON-RPC response through the stream identified by sessionId —
 * locally when this node holds it, otherwise over the Redis relay (a no-op
 * without one). Rejects when the relay publish fails.
 */
export async function deliverSseResponse(sessionId: string, payload: Record<string, unknown>): Promise<void> {
  if (sessions.has(sessionId)) {
    sendSseResponse(sessionId, payload);
    return;
  }
  const transport = getRelayTransport();
  if (!transport) return;
  await transport.publish(downChannel(sessionId), JSON.stringify(payload));
}

/**
 * One pass of housekeeping: close sessions that received no message within the
 * idle timeout, give quiet streams a keep-alive comment, and refresh the relay
 * registry entries of the sessions this node holds. Runs on a timer
 * while any session is open; exported so a pass can be driven directly.
 */
export function sweepSseSessions(now: number = Date.now()): void {
  const { idleTimeoutMs, keepaliveMs } = getConfig().mcp.sse;
  for (const [sessionId, session] of sessions) {
    if (idleTimeoutMs > 0 && now - session.lastInboundAt >= idleTimeoutMs) {
      closeSseSession(sessionId, 'idle');
      continue;
    }
    if (keepaliveMs > 0 && now - session.lastWriteAt >= keepaliveMs) {
      if (!writeFrame(sessionId, session, encoder.encode(KEEPALIVE_FRAME))) continue;
    }
    if (session.relayRegistered && now - session.registryWrittenAt >= REGISTRY_REFRESH_MS) {
      writeRegistry(sessionId, session);
    }
  }
}

export interface OpenSseStreamInput {
  sessionId: string;
  /** Everything about the session but the controller, which the stream supplies. */
  session: Omit<McpSseSession, 'controller'>;
  /** Where the client should POST its messages (sent as the first, `endpoint`, event). */
  messageEndpoint: string;
}

/**
 * Build the stream for a new session, registering the session with it. Throws
 * `McpSseLimitError` (before anything is registered) when a cap is reached.
 * The stream's queue is sized to the backlog bound, which is what lets a
 * client that stops reading be detected.
 */
export function openSseStream(input: OpenSseStreamInput): ReadableStream<Uint8Array> {
  const { sessionId, session, messageEndpoint } = input;
  assertCapacity(principalOf(session), session.clientIp);

  const budget = getConfig().mcp.sse.maxBufferedBytes;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        register(sessionId, { ...session, controller }, budget);
        controller.enqueue(encodeSseEndpointEvent(messageEndpoint));
      },
      cancel() {
        removeSseSession(sessionId);
      },
    },
    budget > 0 ? new ByteLengthQueuingStrategy({ highWaterMark: budget }) : undefined,
  );
}

/** Open sessions in this process (diagnostics and tests). */
export function sseSessionCount(): number {
  return sessions.size;
}

/**
 * Encode an SSE endpoint event (used during stream initialization).
 */
export function encodeSseEndpointEvent(messageEndpoint: string): Uint8Array {
  // The endpoint is data of a line-oriented frame: it must stay on one line.
  return encoder.encode(sseFrame('endpoint', messageEndpoint.replace(/[\r\n]/g, '')));
}
