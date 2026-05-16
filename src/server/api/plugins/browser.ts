/**
 * Dashboard browser API (cookie-authenticated).
 * Routes registered under `/browser/*` (the Fastify plugin mounts at `/api/`).
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  getBrowserErrorMessage,
  getBrowserErrorStatus,
} from '@/lib/services/browser/errors';
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
import {
  browserActionSchema,
  browserExtractInputSchema,
  browserPdfInputSchema,
  browserScreenshotInputSchema,
  createBrowserInputSchema,
  createBrowserSessionInputSchema,
  updateBrowserInputSchema,
} from '@/lib/services/browser/validation';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:browser');

function sendBrowserError(reply: { code: (statusCode: number) => { send: (body: Record<string, unknown>) => unknown } }, error: unknown, fallback: string) {
  const status = getBrowserErrorStatus(error);
  return reply.code(status).send({ error: getBrowserErrorMessage(error, fallback) });
}

export const browserApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Browsers (parent profiles) ────────────────────────────────────
  app.post('/browser/browsers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = createBrowserInputSchema.parse(readJsonBody<unknown>(request));
      const created = await createBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ browser: created });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create browser failed', { error });
      return sendBrowserError(reply, error, 'Failed to create browser');
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
      const body = updateBrowserInputSchema.parse(readJsonBody<unknown>(request));
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
      return sendBrowserError(reply, error, 'Failed to update browser');
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
      return sendBrowserError(reply, error, 'Failed to delete browser');
    }
  }));

  // ── Sessions ──────────────────────────────────────────────────────
  app.post('/browser/sessions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = createBrowserSessionInputSchema.parse(readJsonBody<unknown>(request));
      const created = await createBrowserSession(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ session: created });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create browser session failed', { error });
      return sendBrowserError(reply, error, 'Failed to create browser session');
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
      const action = browserActionSchema.parse(readJsonBody<unknown>(request));
      const result = await runBrowserAction(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        action,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Run action failed', { error });
      return sendBrowserError(reply, error, 'Failed to run browser action');
    }
  }));

  app.post('/browser/sessions/:sessionKey/extract', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserExtractInputSchema.parse(readJsonBody<unknown>(request));
      const result = await extractFromBrowser(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        input,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Extract failed', { error });
      return sendBrowserError(reply, error, 'Failed to extract browser data');
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { buffer, contentType } = await captureLiveScreenshot({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
      }, sessionKey, {
        fullPage: query.fullPage === 'true',
      });
      reply.header('content-type', contentType);
      reply.header('cache-control', 'no-store');
      return reply.send(buffer);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Live screenshot failed', { error });
      return sendBrowserError(reply, error, 'Failed to capture live screenshot');
    }
  }));

  app.post('/browser/sessions/:sessionKey/screenshot', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserScreenshotInputSchema.parse(readJsonBody<unknown>(request));
      const result = await captureScreenshot(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        { ...input, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Persist screenshot failed', { error });
      return sendBrowserError(reply, error, 'Failed to persist screenshot');
    }
  }));

  app.post('/browser/sessions/:sessionKey/pdf', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserPdfInputSchema.parse(readJsonBody<unknown>(request));
      const result = await exportSessionPdf(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        sessionKey,
        { ...input, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('PDF export failed', { error });
      return sendBrowserError(reply, error, 'Failed to export PDF');
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
      return sendBrowserError(reply, error, 'Failed to close browser session');
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
      return sendBrowserError(reply, error, 'Failed to delete browser session');
    }
  }));
};
