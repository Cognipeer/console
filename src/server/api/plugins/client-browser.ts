/**
 * Client-facing browser API (token-authenticated).
 * Routes are registered under `/client/v1/browser/*`.
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
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-browser');

function sendBrowserError(reply: { code: (statusCode: number) => { send: (body: Record<string, unknown>) => unknown } }, error: unknown, fallback: string) {
  const status = getBrowserErrorStatus(error);
  return reply.code(status).send({ error: getBrowserErrorMessage(error, fallback) });
}

export const clientBrowserApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Browsers (parent profiles) ────────────────────────────────────
  app.post('/client/v1/browser/browsers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = createBrowserInputSchema.parse(readJsonBody<unknown>(request));
      const browser = await createBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { ...body, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send({ browser });
    } catch (error) {
      logger.error('Create browser failed', { error });
      return sendBrowserError(reply, error, 'Failed to create browser');
    }
  }));

  app.get('/client/v1/browser/browsers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const browsers = await listBrowsers(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        query,
      );
      return reply.code(200).send({ browsers });
    } catch (error) {
      logger.error('List browsers failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/browser/browsers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const browser = await getBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        idOrKey,
      );
      if (!browser) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(200).send({ browser });
    } catch (error) {
      logger.error('Get browser failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/browser/browsers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = updateBrowserInputSchema.parse(readJsonBody<unknown>(request));
      const updated = await updateBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        idOrKey,
        { ...body, updatedBy: ctx.user?.email ?? 'api-token' },
      );
      if (!updated) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(200).send({ browser: updated });
    } catch (error) {
      logger.error('Update browser failed', { error });
      return sendBrowserError(reply, error, 'Failed to update browser');
    }
  }));

  app.delete('/client/v1/browser/browsers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const ok = await deleteBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        idOrKey,
      );
      if (!ok) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(204).send();
    } catch (error) {
      logger.error('Delete browser failed', { error });
      return sendBrowserError(reply, error, 'Failed to delete browser');
    }
  }));

  // ── Sessions ──────────────────────────────────────────────────────
  app.post('/client/v1/browser/sessions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = createBrowserSessionInputSchema.parse(readJsonBody<unknown>(request));
      const session = await createBrowserSession(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { ...body, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send({ session });
    } catch (error) {
      logger.error('Create browser session failed', { error });
      return sendBrowserError(reply, error, 'Failed to create browser session');
    }
  }));

  app.get('/client/v1/browser/sessions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; agentId?: string; browserId?: string; search?: string; limit?: string };
      const sessions = await listBrowserSessions(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
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
      logger.error('List browser sessions failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/browser/sessions/:sessionId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const session = await getBrowserSession(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionId,
      );
      if (!session) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(200).send({ session });
    } catch (error) {
      logger.error('Get browser session failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/browser/sessions/:sessionId/events', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string };
      const events = await listBrowserSessionEvents(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionId,
        {
          limit: query.limit ? Number(query.limit) : undefined,
          skip: query.skip ? Number(query.skip) : undefined,
        },
      );
      return reply.code(200).send({ events });
    } catch (error) {
      logger.error('List browser session events failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/browser/sessions/:sessionKey/actions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const action = browserActionSchema.parse(readJsonBody<unknown>(request));
      const result = await runBrowserAction(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        action,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Run browser action failed', { error });
      return sendBrowserError(reply, error, 'Failed to run browser action');
    }
  }));

  app.post('/client/v1/browser/sessions/:sessionKey/extract', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserExtractInputSchema.parse(readJsonBody<unknown>(request));
      const result = await extractFromBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        input,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Browser extract failed', { error });
      return sendBrowserError(reply, error, 'Failed to extract browser data');
    }
  }));

  app.get('/client/v1/browser/sessions/:sessionKey/snapshot', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const snapshot = await captureSnapshot(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
      );
      return reply.code(200).send(snapshot);
    } catch (error) {
      logger.error('Browser snapshot failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to snapshot',
      });
    }
  }));

  // Live screenshot — streams raw bytes (no persistence). Useful for UI poll.
  app.get('/client/v1/browser/sessions/:sessionKey/screenshot/live', withClientApiRequestContext(async (request, reply) => {
    try {
      const { sessionKey } = request.params as { sessionKey: string };
      const query = (request.query ?? {}) as { fullPage?: string };
      const ctx = await getApiTokenContextForRequest(request);
      const { buffer, contentType } = await captureLiveScreenshot({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
      }, sessionKey, {
        fullPage: query.fullPage === 'true',
      });
      reply.header('content-type', contentType);
      reply.header('cache-control', 'no-store');
      return reply.send(buffer);
    } catch (error) {
      logger.error('Live screenshot failed', { error });
      return sendBrowserError(reply, error, 'Failed to capture live screenshot');
    }
  }));

  // Persisted screenshot
  app.post('/client/v1/browser/sessions/:sessionKey/screenshot', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserScreenshotInputSchema.parse(readJsonBody<unknown>(request));
      const result = await captureScreenshot(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        { ...input, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send(result);
    } catch (error) {
      logger.error('Persist screenshot failed', { error });
      return sendBrowserError(reply, error, 'Failed to persist screenshot');
    }
  }));

  app.post('/client/v1/browser/sessions/:sessionKey/pdf', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = browserPdfInputSchema.parse(readJsonBody<unknown>(request));
      const result = await exportSessionPdf(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        { ...input, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send(result);
    } catch (error) {
      logger.error('Export PDF failed', { error });
      return sendBrowserError(reply, error, 'Failed to export PDF');
    }
  }));

  app.delete('/client/v1/browser/sessions/:sessionKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const result = await closeBrowserSession(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
      );
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Close session failed', { error });
      return sendBrowserError(reply, error, 'Failed to close browser session');
    }
  }));

  app.delete('/client/v1/browser/sessions/by-id/:sessionId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const ok = await deleteBrowserSession(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionId,
      );
      if (!ok) return reply.code(404).send({ error: 'Session not found' });
      return reply.code(200).send({ deleted: true });
    } catch (error) {
      logger.error('Delete session failed', { error });
      return sendBrowserError(reply, error, 'Failed to delete browser session');
    }
  }));
};
