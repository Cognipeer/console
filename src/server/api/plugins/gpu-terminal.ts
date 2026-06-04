/**
 * Terminal WebSocket endpoints.
 *
 *   /api/gpu-fleet/terminal/:sessionId/browser
 *     Browser-side WS. Cookie-authenticated (we re-check the session and
 *     ensure the requester opened the terminal). Streams TerminalFrame JSON.
 *
 *   /api/gpu/agent/:tenantSlug/terminal/:sessionId/agent
 *     Agent-side WS. Bearer-token authenticated against the host. The agent
 *     opens this connection after receiving `open-terminal-session` from
 *     the command channel.
 *
 * Both endpoints multiplex JSON frames through the in-process session manager
 * (terminalSessionManager.ts).
 */

import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  attachAgentSocket,
  attachBrowserSocket,
  authenticateAgent,
  closeSession,
  forwardFromAgent,
  forwardFromBrowser,
  getTerminalSession,
} from '@/lib/services/gpuFleet';
import { TokenManager } from '@/lib/license/token-manager';

const log = createLogger('api:gpu-terminal');
type TerminalMessagePayload = string | Buffer | ArrayBuffer | Buffer[];

function readTerminalMessage(raw: TerminalMessagePayload): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString('utf8');
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString('utf8');
  }
  return Buffer.from(raw).toString('utf8');
}

export const gpuTerminalApiPlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket);

  // ── Browser side ────────────────────────────────────────────────────

  app.get<{ Params: { sessionId: string } }>(
    '/gpu-fleet/terminal/:sessionId/browser',
    { websocket: true },
    async (socket, request) => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      const session = getTerminalSession(sessionId);
      if (!session) {
        socket.close(4404, 'session-not-found');
        return;
      }
      const sessionToken = request.cookies.token;
      const payload = sessionToken ? await TokenManager.verifyToken(sessionToken) : null;
      if (!payload || payload.userId !== session.openedBy) {
        socket.close(4401, 'unauthorized');
        return;
      }

      if (!attachBrowserSocket(sessionId, socket)) {
        socket.close(4410, 'attach-failed');
        return;
      }

      socket.on('message', (raw: TerminalMessagePayload) => {
        forwardFromBrowser(sessionId, readTerminalMessage(raw));
      });
      socket.on('close', () => closeSession(sessionId, 'browser-disconnected'));
      socket.on('error', (err: Error) => {
        log.warn('browser ws error', { sessionId, error: err.message });
        closeSession(sessionId, 'browser-error');
      });
    },
  );

  // ── Agent side ──────────────────────────────────────────────────────

  app.get<{ Params: { tenantSlug: string; sessionId: string } }>(
    '/gpu/agent/:tenantSlug/terminal/:sessionId/agent',
    { websocket: true },
    async (socket, request) => {
      const { sessionId, tenantSlug } = request.params as { sessionId: string; tenantSlug: string };
      const session = getTerminalSession(sessionId);
      if (!session) {
        socket.close(4404, 'session-not-found');
        return;
      }
      if (session.tenantSlug !== tenantSlug) {
        socket.close(4403, 'tenant-mismatch');
        return;
      }
      const bearer = (request.headers['authorization'] || '').toString();
      const token = bearer.startsWith('Bearer ') ? bearer.slice(7).trim() : null;
      if (!token) {
        socket.close(4401, 'missing-bearer');
        return;
      }
      const host = await authenticateAgent(session.tenantDbName, token);
      if (!host || host.id !== session.hostId) {
        socket.close(4401, 'unauthorized');
        return;
      }

      if (!attachAgentSocket(sessionId, socket)) {
        socket.close(4410, 'attach-failed');
        return;
      }

      socket.on('message', (raw: TerminalMessagePayload) => {
        forwardFromAgent(sessionId, readTerminalMessage(raw));
      });
      socket.on('close', () => closeSession(sessionId, 'agent-disconnected'));
      socket.on('error', (err: Error) => {
        log.warn('agent ws error', { sessionId, error: err.message });
        closeSession(sessionId, 'agent-error');
      });
    },
  );
};
