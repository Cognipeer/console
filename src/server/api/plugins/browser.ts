/**
 * Dashboard browser API (cookie-authenticated).
 * Routes registered under `/browser/*` (the Fastify plugin mounts at `/api/`).
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  captureLiveScreenshot,
  captureScreenshot,
  captureSnapshot,
  closeBrowserSession,
  createBrowser,
  createBrowserSession,
  deleteBrowser,
  deleteBrowserSession,
  exportSessionPdf,
  extractFromBrowser,
  getBrowser,
  getBrowserSession,
  listBrowserSessionEvents,
  listBrowserSessions,
  listBrowsers,
  runBrowserAction,
  updateBrowser,
} from '@/lib/services/browser';
import type {
  BrowserAction,
  BrowserExtractInput,
  BrowserPdfInput,
  BrowserScreenshotInput,
  CreateBrowserInput,
  CreateBrowserSessionInput,
  UpdateBrowserInput,
} from '@/lib/services/browser';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:browser');

export const browserApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Browsers (parent profiles) ────────────────────────────────────
  app.post('/browser/browsers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<CreateBrowserInput>(request);
      const created = await createBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ browser: created });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create browser failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed to create' });
    }
  }));

  app.get('/browser/browsers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const browsers = await listBrowsers(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { status: query.status, search: query.search },
      );
      return reply.code(200).send({ browsers });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List browsers failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/browser/browsers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const browser = await getBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!browser) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(200).send({ browser });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get browser failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/browser/browsers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = readJsonBody<UpdateBrowserInput>(request);
      const updated = await updateBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        { ...body, updatedBy: session.userEmail ?? session.userId },
      );
      if (!updated) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(200).send({ browser: updated });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Update browser failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.delete('/browser/browsers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const ok = await deleteBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!ok) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(204).send();
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Delete browser failed', { error });
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  // ── Sessions ──────────────────────────────────────────────────────
  app.post('/browser/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<CreateBrowserSessionInput>(request);
      const created = await createBrowserSession(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ session: created });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create browser session failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed to create' });
    }
  }));

  app.get('/browser/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; agentId?: string; browserId?: string; search?: string; limit?: string };
      const sessions = await listBrowserSessions(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        {
          status: query.status,
          agentId: query.agentId,
          browserId: query.browserId,
          search: query.search,
          limit: query.limit ? Number(query.limit) : undefined,
        },
      );
      return reply.code(200).send({ sessions });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List sessions failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/browser/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const result = await getBrowserSession(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionId,
      );
      if (!result) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(200).send({ session: result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get session failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/browser/sessions/:sessionId/events', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string };
      const events = await listBrowserSessionEvents(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionId,
        {
          limit: query.limit ? Number(query.limit) : undefined,
          skip: query.skip ? Number(query.skip) : undefined,
        },
      );
      return reply.code(200).send({ events });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List session events failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/browser/sessions/:sessionKey/actions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const action = readJsonBody<BrowserAction>(request);
      const result = await runBrowserAction(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        action,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Run action failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed to run action' });
    }
  }));

  app.post('/browser/sessions/:sessionKey/extract', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserExtractInput>(request);
      const result = await extractFromBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        input,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Extract failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed to extract' });
    }
  }));

  app.get('/browser/sessions/:sessionKey/snapshot', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const result = await captureSnapshot(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Snapshot failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.get('/browser/sessions/:sessionKey/screenshot/live', withApiRequestContext(async (request, reply) => {
    try {
      const { sessionKey } = request.params as { sessionKey: string };
      const query = (request.query ?? {}) as { fullPage?: string };
      const { buffer, contentType } = await captureLiveScreenshot(sessionKey, {
        fullPage: query.fullPage === 'true',
      });
      reply.header('content-type', contentType);
      reply.header('cache-control', 'no-store');
      return reply.send(buffer);
    } catch (error) {
      logger.error('Live screenshot failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.post('/browser/sessions/:sessionKey/screenshot', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserScreenshotInput>(request);
      const result = await captureScreenshot(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        { ...input, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Persist screenshot failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.post('/browser/sessions/:sessionKey/pdf', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserPdfInput>(request);
      const result = await exportSessionPdf(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        { ...input, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('PDF export failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.delete('/browser/sessions/:sessionKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const result = await closeBrowserSession(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
      );
      return reply.code(200).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Close session failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  app.delete('/browser/sessions/by-id/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const ok = await deleteBrowserSession(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionId,
      );
      if (!ok) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(200).send({ deleted: true });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Delete session failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
