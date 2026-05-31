/**
 * In-memory pairing of browser WS <-> agent WS for terminal sessions.
 *
 * Sessions are created from the admin API, expire after the configured TTL,
 * and self-clean when either party disconnects. State is intentionally
 * in-memory and per-process: terminal sessions are short-lived (seconds to
 * minutes) and reconnecting after a console restart is acceptable.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { createLogger } from '@/lib/core/logger';
import type { TerminalSandbox } from '@cognipeer/gpu-fleet-protocol';

const log = createLogger('gpu-fleet:terminal');

export interface TerminalSession {
  sessionId: string;
  tenantId: string;
  tenantDbName: string;
  tenantSlug: string;
  hostId: string;
  sandbox: TerminalSandbox;
  deploymentId: string | null;
  cols: number;
  rows: number;
  ttlSeconds: number;
  openedBy: string;
  createdAt: Date;
  expiresAt: Date;
  /** Buffered frames the agent dropped while the browser hadn't joined yet. */
  pendingAgentToBrowser: string[];
  pendingBrowserToAgent: string[];
  browserSocket: WebSocket | null;
  agentSocket: WebSocket | null;
}

const SESSIONS = new Map<string, TerminalSession>();

export interface CreateSessionInput {
  tenantId: string;
  tenantDbName: string;
  tenantSlug: string;
  hostId: string;
  sandbox: TerminalSandbox;
  deploymentId?: string | null;
  cols?: number;
  rows?: number;
  ttlSeconds: number;
  openedBy: string;
}

export function createTerminalSession(input: CreateSessionInput): TerminalSession {
  const now = new Date();
  const session: TerminalSession = {
    sessionId: randomUUID(),
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    tenantSlug: input.tenantSlug,
    hostId: input.hostId,
    sandbox: input.sandbox,
    deploymentId: input.deploymentId ?? null,
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
  log.info('terminal session created', {
    sessionId: session.sessionId,
    hostId: input.hostId,
    sandbox: input.sandbox,
    ttl: input.ttlSeconds,
  });
  scheduleExpiry(session);
  return session;
}

export function getTerminalSession(sessionId: string): TerminalSession | null {
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
  // Replay any buffered agent output while the browser was still loading.
  for (const frame of session.pendingAgentToBrowser) socket.send(frame);
  session.pendingAgentToBrowser.length = 0;
  log.debug('browser attached to terminal session', { sessionId });
  return true;
}

export function attachAgentSocket(sessionId: string, socket: WebSocket): boolean {
  const session = getTerminalSession(sessionId);
  if (!session) return false;
  session.agentSocket = socket;
  for (const frame of session.pendingBrowserToAgent) socket.send(frame);
  session.pendingBrowserToAgent.length = 0;
  log.debug('agent attached to terminal session', { sessionId });
  return true;
}

export function forwardFromBrowser(sessionId: string, frame: string): void {
  const session = SESSIONS.get(sessionId);
  if (!session) return;
  if (session.agentSocket && session.agentSocket.readyState === 1) {
    session.agentSocket.send(frame);
  } else {
    // Buffer up to 16 frames; drop oldest on overflow.
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
  log.info('terminal session closed', { sessionId, reason });
}

function scheduleExpiry(session: TerminalSession): void {
  const ms = Math.max(1_000, session.expiresAt.getTime() - Date.now());
  setTimeout(() => closeSession(session.sessionId, 'ttl-expired'), ms).unref();
}

export function listSessionsForHost(hostId: string): TerminalSession[] {
  return [...SESSIONS.values()].filter((s) => s.hostId === hostId);
}
