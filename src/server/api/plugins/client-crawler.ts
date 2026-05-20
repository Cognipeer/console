/**
 * Client-facing crawler API (Bearer-token authenticated).
 * Mirrors /api/crawler under /api/client/v1/crawler/* so external apps can
 * trigger crawls programmatically without a dashboard session.
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
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-crawler');

function actorFromCtx(ctx: { user: { _id?: unknown; email?: string } | null; tokenRecord: { _id?: unknown } }): string {
  return ctx.user?.email ?? String(ctx.user?._id ?? ctx.tokenRecord?._id ?? 'api-token');
}

function projectOf(ctx: { projectId?: string }): string | undefined {
  return ctx.projectId && ctx.projectId.length > 0 ? ctx.projectId : undefined;
}

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

export const clientCrawlerApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/crawler/crawlers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { status?: string; search?: string };
      const crawlers = await listCrawlers(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        { status: query.status, search: query.search },
      );
      return reply.code(200).send({ crawlers });
    } catch (error) {
      logger.error('Client list crawlers failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/crawler/crawlers', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = createCrawlerInputSchema.parse(readJsonBody<unknown>(request));
      const created = await createCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        { ...body, createdBy: actorFromCtx(ctx) },
      );
      return reply.code(201).send({ crawler: created });
    } catch (error) {
      logger.error('Client create crawler failed', { error });
      return sendError(reply, error, 'Failed to create crawler');
    }
  }));

  app.get('/client/v1/crawler/crawlers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const crawler = await getCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
      );
      if (!crawler) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(200).send({ crawler });
    } catch (error) {
      logger.error('Client get crawler failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.patch('/client/v1/crawler/crawlers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = updateCrawlerInputSchema.parse(readJsonBody<unknown>(request));
      const updated = await updateCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
        { ...body, updatedBy: actorFromCtx(ctx) },
      );
      if (!updated) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(200).send({ crawler: updated });
    } catch (error) {
      logger.error('Client update crawler failed', { error });
      return sendError(reply, error, 'Failed to update crawler');
    }
  }));

  app.delete('/client/v1/crawler/crawlers/:idOrKey', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const ok = await deleteCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
      );
      if (!ok) return reply.code(404).send({ error: 'Crawler not found' });
      return reply.code(204).send();
    } catch (error) {
      logger.error('Client delete crawler failed', { error });
      return sendError(reply, error, 'Failed to delete crawler');
    }
  }));

  app.post('/client/v1/crawler/crawlers/:idOrKey/run', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = runCrawlerOptionsSchema.parse(readJsonBody<unknown>(request) ?? {});
      const result = await runCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
        {
          urls: body.urls,
          seeds: body.seeds,
          callbackUrl: body.callbackUrl,
          metadata: body.metadata,
          trigger: 'api',
          triggerActor: actorFromCtx(ctx),
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      logger.error('Client run crawler failed', { error });
      return sendError(reply, error, 'Failed to run crawler');
    }
  }));

  // Container URL management (client side mirror)
  app.get('/client/v1/crawler/crawlers/:idOrKey/urls', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const urls = await listCrawlerUrls(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      logger.error('Client list urls failed', { error });
      return sendError(reply, error, 'Failed to list URLs');
    }
  }));

  app.post('/client/v1/crawler/crawlers/:idOrKey/urls', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlerUrlsBodySchema.parse(readJsonBody<unknown>(request));
      const urls = await addCrawlerUrls(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
        body.urls,
        actorFromCtx(ctx),
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      logger.error('Client add urls failed', { error });
      return sendError(reply, error, 'Failed to add URLs');
    }
  }));

  app.delete('/client/v1/crawler/crawlers/:idOrKey/urls', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlerUrlsBodySchema.parse(readJsonBody<unknown>(request));
      const urls = await removeCrawlerUrls(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
        body.urls,
        actorFromCtx(ctx),
      );
      return reply.code(200).send({ urls });
    } catch (error) {
      logger.error('Client remove urls failed', { error });
      return sendError(reply, error, 'Failed to remove URLs');
    }
  }));

  /** External app integration: "give me the markdown for these URLs using this crawler's config". */
  app.post('/client/v1/crawler/crawlers/:idOrKey/crawl', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { idOrKey } = request.params as { idOrKey: string };
      const body = crawlOnContainerSchema.parse(readJsonBody<unknown>(request));
      const result = await runCrawler(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        idOrKey,
        {
          urls: body.urls,
          callbackUrl: body.callbackUrl,
          metadata: body.metadata,
          trigger: 'api',
          triggerActor: actorFromCtx(ctx),
        },
      );
      return reply.code(202).send(result);
    } catch (error) {
      logger.error('Client crawl on container failed', { error });
      return sendError(reply, error, 'Failed to crawl on container');
    }
  }));

  app.post('/client/v1/crawler/run', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const body = adhocCrawlInputSchema.parse(readJsonBody<unknown>(request));
      const result = await runAdhocCrawl(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        { ...body, triggerActor: actorFromCtx(ctx) },
      );
      return reply.code(202).send(result);
    } catch (error) {
      logger.error('Client adhoc crawl failed', { error });
      return sendError(reply, error, 'Failed to start ad-hoc crawl');
    }
  }));

  app.get('/client/v1/crawler/jobs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { crawlerKey?: string; status?: string; limit?: string };
      const jobs = await listCrawlJobs(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        {
          crawlerKey: query.crawlerKey,
          status: query.status as never,
          limit: query.limit ? Number(query.limit) : undefined,
        },
      );
      return reply.code(200).send({ jobs });
    } catch (error) {
      logger.error('Client list jobs failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/crawler/jobs/:jobId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const job = await getCrawlJob(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        jobId,
      );
      if (!job) return reply.code(404).send({ error: 'Job not found' });
      return reply.code(200).send({ job });
    } catch (error) {
      logger.error('Client get job failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.get('/client/v1/crawler/jobs/:jobId/results', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const query = (request.query ?? {}) as { limit?: string; skip?: string; type?: string };
      const results = await listCrawlJobResults(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        jobId,
        {
          limit: query.limit ? Number(query.limit) : 100,
          skip: query.skip ? Number(query.skip) : 0,
          type: query.type,
        },
      );
      return reply.code(200).send({ results });
    } catch (error) {
      logger.error('Client list results failed', { error });
      return sendError(reply, error, 'Failed to list results');
    }
  }));

  app.get('/client/v1/crawler/jobs/:jobId/results/:resultId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { jobId, resultId } = request.params as { jobId: string; resultId: string };
      const result = await getCrawlResult(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        jobId,
        resultId,
      );
      if (!result) return reply.code(404).send({ error: 'Result not found' });
      return reply.code(200).send({ result });
    } catch (error) {
      logger.error('Client get result failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));

  app.post('/client/v1/crawler/jobs/:jobId/cancel', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { jobId } = request.params as { jobId: string };
      const ok = await cancelCrawlJob(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: projectOf(ctx) },
        jobId,
      );
      if (!ok) return reply.code(404).send({ error: 'Job not found or not cancelable' });
      return reply.code(200).send({ ok: true });
    } catch (error) {
      logger.error('Client cancel job failed', { error });
      return reply.code(500).send({ error: 'Internal server error' });
    }
  }));
};
