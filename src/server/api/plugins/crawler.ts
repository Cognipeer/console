/**
 * Dashboard crawler API (cookie-authenticated).
 * Routes registered under `/crawler/*` (the Fastify plugin mounts at `/api/`).
 */
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import {
  addCrawlerUrls,
  cancelCrawlJob,
  createCrawler,
  deleteCrawler,
  getCrawler,
  getCrawlJob,
  getCrawlResult,
  listCrawlers,
  listCrawlJobResults,
  listCrawlJobs,
  listCrawlerUrls,
  removeCrawlerUrls,
  runAdhocCrawl,
  runCrawler,
  updateCrawler,
  createCrawlerInputSchema,
  updateCrawlerInputSchema,
  runCrawlerOptionsSchema,
  adhocCrawlInputSchema,
  crawlerUrlsBodySchema,
  crawlOnContainerSchema,
} from '@/lib/services/crawler';
import {
  readJsonBody,
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:crawler');

function sendError(
  reply: { code: (statusCode: number) => { send: (body: Record<string, unknown>) => unknown } },
  error: unknown,
  fallback: string,
) {
  const message = error instanceof Error ? error.message : fallback;
  const status = /not found/i.test(message)
    ? 404
    : /already exists|not active|invalid/i.test(message)
      ? 400
      : 500;
  return reply.code(status).send({ error: message });
}

export const crawlerApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Crawlers (CRUD) ───────────────────────────────────────────────
  app.post('/crawler/crawlers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = createCrawlerInputSchema.parse(readJsonBody<unknown>(request));
      const created = await createCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, createdBy: session.userEmail ?? session.userId },
      );
      return reply.code(201).send({ crawler: created });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Create crawler failed', { error });
      return sendError(reply, error, 'Failed to create crawler');
    }
  }));

  app.get('/crawler/crawlers', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const crawlers = await listCrawlers(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { status: query.status, search: query.search },
      );
      return reply.code(200).send({ crawlers });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List crawlers failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/crawler/crawlers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const crawler = await getCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!crawler) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(200).send({ crawler });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get crawler failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/crawler/crawlers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = updateCrawlerInputSchema.parse(readJsonBody<unknown>(request));
      const updated = await updateCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        { ...body, updatedBy: session.userEmail ?? session.userId },
      );
      if (!updated) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(200).send({ crawler: updated });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Update crawler failed', { error });
      return sendError(reply, error, 'Failed to update crawler');
    }
  }));

  app.delete('/crawler/crawlers/:idOrKey', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const ok = await deleteCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      if (!ok) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(204).send();
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Delete crawler failed', { error });
      return sendError(reply, error, 'Failed to delete crawler');
    }
  }));

  // ── Container URL management ──────────────────────────────────────
  app.get('/crawler/crawlers/:idOrKey/urls', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const urls = await listCrawlerUrls(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List crawler urls failed', { error });
      return sendError(reply, error, 'Failed to list URLs');
    }
  }));

  app.post('/crawler/crawlers/:idOrKey/urls', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlerUrlsBodySchema.parse(readJsonBody<unknown>(request));
      const urls = await addCrawlerUrls(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        body.urls,
        session.userEmail ?? session.userId,
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Add crawler urls failed', { error });
      return sendError(reply, error, 'Failed to add URLs');
    }
  }));

  app.delete('/crawler/crawlers/:idOrKey/urls', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlerUrlsBodySchema.parse(readJsonBody<unknown>(request));
      const urls = await removeCrawlerUrls(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        body.urls,
        session.userEmail ?? session.userId,
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Remove crawler urls failed', { error });
      return sendError(reply, error, 'Failed to remove URLs');
    }
  }));

  // ── Run dispatch ──────────────────────────────────────────────────
  app.post('/crawler/crawlers/:idOrKey/run', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = runCrawlerOptionsSchema.parse(readJsonBody<unknown>(request) ?? {});
      const result = await runCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        {
          urls: body.urls,
          seeds: body.seeds,
          callbackUrl: body.callbackUrl,
          metadata: body.metadata,
          trigger: 'manual',
          triggerActor: session.userEmail ?? session.userId,
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Run crawler failed', { error });
      return sendError(reply, error, 'Failed to run crawler');
    }
  }));

  /** Container-bound ad-hoc crawl: take URL(s) from the request body and crawl them
   *  using THIS crawler's config (engine, scope, http, rag, webhook). Equivalent to
   *  /run with a URL override but with a more explicit name for external callers. */
  app.post('/crawler/crawlers/:idOrKey/crawl', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlOnContainerSchema.parse(readJsonBody<unknown>(request));
      const result = await runCrawler(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        idOrKey,
        {
          urls: body.urls,
          callbackUrl: body.callbackUrl,
          metadata: body.metadata,
          trigger: 'manual',
          triggerActor: session.userEmail ?? session.userId,
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Crawl on container failed', { error });
      return sendError(reply, error, 'Failed to crawl on container');
    }
  }));

  app.post('/crawler/run', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = adhocCrawlInputSchema.parse(readJsonBody<unknown>(request));
      const result = await runAdhocCrawl(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { ...body, triggerActor: session.userEmail ?? session.userId },
      );
      return reply.code(202).send(result);
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Ad-hoc crawl failed', { error });
      return sendError(reply, error, 'Failed to start ad-hoc crawl');
    }
  }));

  // ── Jobs & results ────────────────────────────────────────────────
  app.get('/crawler/jobs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as {
        crawlerKey?: string;
        status?: string;
        limit?: string;
      };
      const jobs = await listCrawlJobs(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        {
          crawlerKey: query.crawlerKey,
          status: query.status as never,
          limit: query.limit ? Number(query.limit) : undefined,
        },
      );
      return reply.code(200).send({ jobs });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List crawl jobs failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/crawler/jobs/:jobId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const job = await getCrawlJob(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        jobId,
      );
      if (!job) return reply.code(404).send({ error: 'Job not found' });
      return reply.code(200).send({ job });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get crawl job failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/crawler/jobs/:jobId/results', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string; type?: string };
      const results = await listCrawlJobResults(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        jobId,
        {
          limit: query.limit ? Number(query.limit) : 100,
          skip: query.skip ? Number(query.skip) : 0,
          type: query.type,
        },
      );
      return reply.code(200).send({ results });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('List crawl results failed', { error });
      return sendError(reply, error, 'Failed to list results');
    }
  }));

  app.get('/crawler/jobs/:jobId/results/:resultId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { jobId, resultId } = request.params as { jobId: string; resultId: string };
      const result = await getCrawlResult(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        jobId,
        resultId,
      );
      if (!result) return reply.code(404).send({ error: 'Result not found' });
      return reply.code(200).send({ result });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Get crawl result failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/crawler/jobs/:jobId/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const ok = await cancelCrawlJob(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        jobId,
      );
      if (!ok) return reply.code(404).send({ error: 'Job not found or not cancelable' });
      return reply.code(200).send({ ok: true });
    } catch (error) {
      if (sendProjectContextError(reply, error)) return;
      logger.error('Cancel crawl job failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
