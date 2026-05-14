/**
 * Client-facing browser API (token-authenticated).
 * Routes are registered under `/client/v1/browser/*`.
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  captureLiveScreenshot,
  captureScreenshot,
  captureSnapshot,
  closeBrowserSession,
  createBrowser,
  createBrowserAgent,
  createBrowserSession,
  deleteBrowser,
  deleteBrowserAgent,
  deleteBrowserSession,
  exportSessionPdf,
  extractFromBrowser,
  getBrowser,
  getBrowserAgent,
  getBrowserSession,
  listBrowserAgents,
  listBrowserSessionEvents,
  listBrowserSessions,
  listBrowsers,
  runBrowserAction,
  runBrowserAgent,
  updateBrowser,
  updateBrowserAgent,
} from '@/lib/services/browser';
import type {
  BrowserAction,
  BrowserAgentRunInput,
  BrowserExtractInput,
  BrowserPdfInput,
  BrowserScreenshotInput,
  CreateBrowserAgentInput,
  CreateBrowserInput,
  CreateBrowserSessionInput,
  UpdateBrowserAgentInput,
  UpdateBrowserInput,
} from '@/lib/services/browser';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-browser');

export const clientBrowserApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Browsers (parent profiles) ────────────────────────────────────
  app.post('/client/v1/browser/browsers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<CreateBrowserInput>(request);
      const browser = await createBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { ...body, createdBy: body.createdBy ?? ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send({ browser });
    } catch (error) {
      logger.error('Create browser failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
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
      const body = readJsonBody<UpdateBrowserInput>(request);
      const updated = await updateBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        idOrKey,
        { ...body, updatedBy: body.updatedBy ?? ctx.user?.email ?? 'api-token' },
      );
      if (!updated) return reply.code(404).send({ error: 'Browser not found' });
      return reply.code(200).send({ browser: updated });
    } catch (error) {
      logger.error('Update browser failed', { error });
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Failed' });
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
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'Failed' });
    }
  }));

  // ── Sessions ──────────────────────────────────────────────────────
  app.post('/client/v1/browser/sessions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<CreateBrowserSessionInput>(request);
      const session = await createBrowserSession(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { ...body, createdBy: body.createdBy ?? ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send({ session });
    } catch (error) {
      logger.error('Create browser session failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to create session',
      });
    }
  }));

  app.get('/client/v1/browser/sessions', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; agentId?: string; search?: string; limit?: string };
      const sessions = await listBrowserSessions(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        {
          status: query.status,
          agentId: query.agentId,
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
      const action = readJsonBody<BrowserAction>(request);
      const result = await runBrowserAction(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        action,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Run browser action failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to run action',
      });
    }
  }));

  app.post('/client/v1/browser/sessions/:sessionKey/extract', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserExtractInput>(request);
      const result = await extractFromBrowser(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        input,
      );
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Browser extract failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to extract',
      });
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
      const { buffer, contentType } = await captureLiveScreenshot(sessionKey, {
        fullPage: query.fullPage === 'true',
      });
      reply.header('content-type', contentType);
      reply.header('cache-control', 'no-store');
      return reply.send(buffer);
    } catch (error) {
      logger.error('Live screenshot failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to capture',
      });
    }
  }));

  // Persisted screenshot
  app.post('/client/v1/browser/sessions/:sessionKey/screenshot', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserScreenshotInput>(request);
      const result = await captureScreenshot(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        { ...input, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send(result);
    } catch (error) {
      logger.error('Persist screenshot failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to persist screenshot',
      });
    }
  }));

  app.post('/client/v1/browser/sessions/:sessionKey/pdf', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { sessionKey } = request.params as { sessionKey: string };
      const input = readJsonBody<BrowserPdfInput>(request);
      const result = await exportSessionPdf(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        sessionKey,
        { ...input, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send(result);
    } catch (error) {
      logger.error('Export PDF failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to export PDF',
      });
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
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to close session',
      });
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
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  // ── Agents ────────────────────────────────────────────────────────
  app.post('/client/v1/browser/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = readJsonBody<CreateBrowserAgentInput>(request);
      const agent = await createBrowserAgent(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { ...body, createdBy: body.createdBy ?? ctx.user?.email ?? 'api-token' },
      );
      return reply.code(201).send({ agent });
    } catch (error) {
      logger.error('Create browser agent failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to create agent',
      });
    }
  }));

  app.get('/client/v1/browser/agents', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const agents = await listBrowserAgents(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        query,
      );
      return reply.code(200).send({ agents });
    } catch (error) {
      logger.error('List browser agents failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/browser/agents/:agentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const agent = await getBrowserAgent(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        agentId,
      );
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });
      return reply.code(200).send({ agent });
    } catch (error) {
      logger.error('Get browser agent failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/browser/agents/:agentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const body = readJsonBody<UpdateBrowserAgentInput>(request);
      const agent = await updateBrowserAgent(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        agentId,
        { ...body, updatedBy: body.updatedBy ?? ctx.user?.email ?? 'api-token' },
      );
      if (!agent) return reply.code(404).send({ error: 'Agent not found' });
      return reply.code(200).send({ agent });
    } catch (error) {
      logger.error('Update browser agent failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to update agent',
      });
    }
  }));

  app.delete('/client/v1/browser/agents/:agentId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentId } = request.params as { agentId: string };
      const ok = await deleteBrowserAgent(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        agentId,
      );
      if (!ok) return reply.code(404).send({ error: 'Agent not found' });
      return reply.code(200).send({ deleted: true });
    } catch (error) {
      logger.error('Delete browser agent failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/browser/agents/:agentIdOrKey/run', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { agentIdOrKey } = request.params as { agentIdOrKey: string };
      const body = readJsonBody<BrowserAgentRunInput>(request);
      const result = await runBrowserAgent(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        agentIdOrKey,
        { ...body, createdBy: ctx.user?.email ?? 'api-token' },
      );
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Run browser agent failed', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to run agent',
      });
    }
  }));
};
