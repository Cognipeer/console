/**
 * In-memory pairing of browser WS <-> runner-agent WS for sandbox terminal
 * (PTY) sessions. Sessions are created from the admin API, expire after a TTL,
 * and self-clean when either party disconnects. State is per-process and
 * ephemeral — terminal sessions are short-lived and reconnecting after a
 * console restart is acceptable.
 *
 * Independent of the gpu-fleet terminal session manager.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { createLogger } from '@/lib/core/logger';

const log = createLogger('sandbox:terminal');

export interface SandboxTerminalSession {
  sessionId: string;
  tenantId: string;
  tenantDbName: string;
  tenantSlug: string;
  runnerId: string;
  instanceId: string;
  cwd: string | null;
  shell: string | null;
  cols: number;
  rows: number;
  ttlSeconds: number;
  openedBy: string;
  createdAt: Date;
  expiresAt: Date;
  pendingAgentToBrowser: string[];
  pendingBrowserToAgent: string[];
  browserSocket: WebSocket | null;
  agentSocket: WebSocket | null;
}

const SESSIONS = new Map<string, SandboxTerminalSession>();

export interface CreateSessionInput {
  tenantId: string;
  tenantDbName: string;
  tenantSlug: string;
  runnerId: string;
  instanceId: string;
  cwd?: string | null;
  shell?: string | null;
  cols?: number;
  rows?: number;
  ttlSeconds: number;
  openedBy: string;
}

export function createTerminalSession(input: CreateSessionInput): SandboxTerminalSession {
  const now = new Date();
  const session: SandboxTerminalSession = {
    sessionId: randomUUID(),
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    tenantSlug: input.tenantSlug,
    runnerId: input.runnerId,
    instanceId: input.instanceId,
    cwd: input.cwd ?? null,
    shell: input.shell ?? null,
    cols: input.cols ?? 120,
    rows: input.rows ?? 30,
    ttlSeconds: input.ttlSeconds,
    openedBy: input.openedBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000),
    pendingAgentToBrowser: [],
    pendingBrowserToAgent: [],
    browserSocket: null,
    agentSocket: null,
  };
  SESSIONS.set(session.sessionId, session);
  log.info('sandbox terminal session created', { sessionId: session.sessionId, instanceId: input.instanceId });
  scheduleExpiry(session);
  return session;
}

export function getTerminalSession(sessionId: string): SandboxTerminalSession | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    closeSession(sessionId, 'expired');
    return null;
  }
  return session;
}

export function attachBrowserSocket(sessionId: string, socket: WebSocket): boolean {
  const session = getTerminalSession(sessionId);
  if (!session) return false;
  session.browserSocket = socket;
  for (const frame of session.pendingAgentToBrowser) socket.send(frame);
  session.pendingAgentToBrowser.length = 0;
  return true;
}

export function attachAgentSocket(sessionId: string, socket: WebSocket): boolean {
  const session = getTerminalSession(sessionId);
  if (!session) return false;
  session.agentSocket = socket;
  for (const frame of session.pendingBrowserToAgent) socket.send(frame);
  session.pendingBrowserToAgent.length = 0;
  return true;
}

export function forwardFromBrowser(sessionId: string, frame: string): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  if (session.agentSocket && session.agentSocket.readyState === 1) {
    session.agentSocket.send(frame);
  } else {
    session.pendingBrowserToAgent.push(frame);
    if (session.pendingBrowserToAgent.length > 16) session.pendingBrowserToAgent.shift();
  }
}

export function forwardFromAgent(sessionId: string, frame: string): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  if (session.browserSocket && session.browserSocket.readyState === 1) {
    session.browserSocket.send(frame);
  } else {
    session.pendingAgentToBrowser.push(frame);
    if (session.pendingAgentToBrowser.length > 64) session.pendingAgentToBrowser.shift();
  }
}

export function closeSession(sessionId: string, reason: string): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  SESSIONS.delete(sessionId);
  const exitFrame = JSON.stringify({ type: 'exit', code: null, reason });
  try {
    session.browserSocket?.send(exitFrame);
    session.browserSocket?.close(1000, reason);
  } catch {
    /* ignore */
  }
  try {
    session.agentSocket?.send(exitFrame);
    session.agentSocket?.close(1000, reason);
  } catch {
    /* ignore */
  }
  log.info('sandbox terminal session closed', { sessionId, reason });
}

function scheduleExpiry(session: SandboxTerminalSession): void {
  const ms = Math.max(1_000, session.expiresAt.getTime() - Date.now());
  setTimeout(() => closeSession(session.sessionId, 'ttl-expired'), ms).unref();
}
