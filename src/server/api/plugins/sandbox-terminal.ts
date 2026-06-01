/**
 * Sandbox terminal WebSocket endpoints.
 *
 *   /api/sandbox/terminal/:sessionId/browser
 *     Browser-side WS. Cookie-authenticated; we re-check the session and ensure
 *     the requester opened the terminal. Streams TerminalFrame JSON.
 *
 *   /api/sandbox/agent/:tenantSlug/terminal/:sessionId/agent
 *     Agent-side WS. Bearer-token authenticated against the runner.
 *
 * Both multiplex JSON frames through the in-process session manager. Routes are
 * written without the '/api' prefix (added by the parent). Independent of the
 * gpu-fleet terminal relay.
 */

import websocket from '@fastify/websocket';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  attachAgentSocket,
  attachBrowserSocket,
  closeSession,
  forwardFromAgent,
  forwardFromBrowser,
  getTerminalSession,
} from '@/lib/services/sandbox/terminalSessionManager';
import { authenticateAgent } from '@/lib/services/sandbox/runnerService';
import { TokenManager } from '@/lib/license/token-manager';

const log = createLogger('api:sandbox-terminal');

export const sandboxTerminalApiPlugin: FastifyPluginAsync = async (app) => {
  // @fastify/websocket attaches to the root instance; only register once.
  if (!(app as { websocketServer?: unknown }).websocketServer) {
    await app.register(websocket);
  }

  // ── Browser side ────────────────────────────────────────────────────
  app.get<{ Params: { sessionId: string } }>(
    '/sandbox/terminal/:sessionId/browser',
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
      socket.on('message', (raw: Buffer) => forwardFromBrowser(sessionId, raw.toString('utf8')));
      socket.on('close', () => closeSession(sessionId, 'browser-disconnected'));
      socket.on('error', (err: Error) => {
        log.warn('browser ws error', { sessionId, error: err.message });
        closeSession(sessionId, 'browser-error');
      });
    },
  );

  // ── Agent side ──────────────────────────────────────────────────────
  app.get<{ Params: { tenantSlug: string; sessionId: string } }>(
    '/sandbox/agent/:tenantSlug/terminal/:sessionId/agent',
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
      // Token may arrive via the Authorization header or the `?token=` query
      // param (browser-style WebSocket clients cannot set custom headers).
      const bearer = (request.headers['authorization'] || '').toString();
      const queryToken = (request.query as { token?: string } | undefined)?.token;
      const token = bearer.startsWith('Bearer ')
        ? bearer.slice(7).trim()
        : queryToken
          ? String(queryToken).trim()
          : null;
      if (!token) {
        socket.close(4401, 'missing-bearer');
        return;
      }
      const runner = await authenticateAgent(session.tenantDbName, token);
      if (!runner || runner.id !== session.runnerId) {
        socket.close(4401, 'unauthorized');
        return;
      }
      if (!attachAgentSocket(sessionId, socket)) {
        socket.close(4410, 'attach-failed');
        return;
      }
      socket.on('message', (raw: Buffer) => forwardFromAgent(sessionId, raw.toString('utf8')));
      socket.on('close', () => closeSession(sessionId, 'agent-disconnected'));
      socket.on('error', (err: Error) => {
        log.warn('agent ws error', { sessionId, error: err.message });
        closeSession(sessionId, 'agent-error');
      });
    },
  );
};
