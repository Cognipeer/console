import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { offsetPageOf, pageOfVisibleRows, refuseTracingThread, sendSessionRefusal } from './agent-session-access';

const logger = createLogger('api:tracing');

// Same key charset the ingest sanitizer enforces (client-tracing.ts) — the
// key reaches a Mongo `metadata.<key>` dot-path / SQLite JSON path in the DB
// layer, so an unvalidated key is a query-shape injection surface.
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_]{1,40}$/;

function parseMetadataFilter(query: Record<string, string | undefined>):
  | { metadataKey?: string; metadataValue?: string }
  | { error: string } {
  const key = query.metadataKey?.trim();
  if (!key) return {};
  if (!METADATA_KEY_PATTERN.test(key)) {
    return { error: '`metadataKey` must match /^[a-zA-Z0-9_]{1,40}$/' };
  }
  return { metadataKey: key, metadataValue: query.metadataValue };
}

export const tracingApiPlugin: FastifyPluginAsync = async (app) => {
  const dashboardHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const from = searchParams.get('from') || filter.from?.toISOString();
      const to = searchParams.get('to') || filter.to?.toISOString();
      const timezone = searchParams.get('timezone') || undefined;

      const overview = await AgentTracingService.getDashboardOverview(
        session.tenantDbName,
        projectId,
        {
          from,
          timezone,
          to,
        },
      );

      return reply.code(200).send(overview);
    } catch (error) {
      logger.error('Tracing dashboard error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch dashboard data',
        });
    }
  });

  app.get('/tracing/dashboard', dashboardHandler);
  app.post('/tracing/dashboard', dashboardHandler);

  const sessionsHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const metadataFilter = parseMetadataFilter(query);
      if ('error' in metadataFilter) {
        return reply.code(400).send({ error: metadataFilter.error });
      }
      // A tracing session of an agent is a turn of somebody's session: the sessions of an agent whose other
      // people's sessions the caller may not view are left out. The default caller gets one plain read; a
      // restricted caller's page is filled from further reads, so it is not short while the list goes on.
      const { skip, limit } = offsetPageOf(query);
      let latest: Awaited<ReturnType<typeof AgentTracingService.listSessions>> | undefined;
      const page = await pageOfVisibleRows(request, {
        start: skip,
        limit,
        minBatch: 25,
        threadIdOf: (row: { threadId?: string | null }) => row.threadId,
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        fetchPage: async (position, size) => {
          latest = await AgentTracingService.listSessions(session.tenantDbName, projectId, {
            agent: query.agent,
            from: query.from,
            limit: String(size),
            query: query.query,
            skip: String(position),
            status: query.status,
            to: query.to,
            // Only sessions with truncatedEvents > 0 (a truncated/cut-off model
            // response somewhere in the session).
            truncated: query.truncated === 'true' ? true : undefined,
            ...metadataFilter,
          });
          const total = latest.total;
          return { rows: latest.sessions, after: (consumed) => (position + consumed >= total ? null : position + consumed) };
        },
      });
      if (!page.restricted && latest) return reply.code(200).send(latest);
      // A restricted caller's total cannot be known without reading everything: say where the next page starts instead.
      return reply.code(200).send({ sessions: page.rows, hasMore: page.next !== null, nextSkip: page.next });
    } catch (error) {
      logger.error('List tracing sessions error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch sessions',
        });
    }
  });

  app.get('/tracing/sessions', sessionsHandler);
  app.post('/tracing/sessions', sessionsHandler);

  app.get('/tracing/sessions/:sessionId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { sessionId } = request.params as { sessionId: string };
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const result = await AgentTracingService.getSessionDetail(
        session.tenantDbName,
        projectId,
        sessionId,
        {
          includeEventContent: query.includeEventContent !== 'false',
        },
      );

      if (!result) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const refusal = await refuseTracingThread(request, result.session.threadId, { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing session detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch session detail',
        });
    }
  }));

  app.get('/tracing/sessions/:sessionId/events/:eventId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { eventId, sessionId } = request.params as { eventId: string; sessionId: string };
      const refusal = await refuseTracingThread(request, await AgentTracingService.getSessionThreadId(session.tenantDbName, projectId, sessionId), { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);
      const result = await AgentTracingService.getSessionEventDetail(
        session.tenantDbName,
        projectId,
        sessionId,
        eventId,
      );

      if (!result) {
        return reply.code(404).send({ error: 'Event not found' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing session event detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch event detail',
        });
    }
  }));

  app.get('/tracing/threads', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const metadataFilter = parseMetadataFilter(query);
      if ('error' in metadataFilter) {
        return reply.code(400).send({ error: metadataFilter.error });
      }
      const { skip, limit } = offsetPageOf(query);
      let latest: Awaited<ReturnType<typeof AgentTracingService.listThreads>> | undefined;
      const page = await pageOfVisibleRows(request, {
        start: skip,
        limit,
        minBatch: 25,
        threadIdOf: (row: { threadId?: unknown }) => (typeof row.threadId === 'string' ? row.threadId : null),
        actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId },
        fetchPage: async (position, size) => {
          latest = await AgentTracingService.listThreads(session.tenantDbName, projectId, {
            agent: query.agent,
            from: query.from,
            limit: String(size),
            skip: String(position),
            status: query.status,
            threadId: query.threadId,
            to: query.to,
            ...metadataFilter,
          });
          const total = latest.total;
          return { rows: latest.threads, after: (consumed) => (position + consumed >= total ? null : position + consumed) };
        },
      });
      if (!page.restricted && latest) return reply.code(200).send(latest);
      return reply.code(200).send({ threads: page.rows, hasMore: page.next !== null, nextSkip: page.next });
    } catch (error) {
      logger.error('List tracing threads error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch threads',
        });
    }
  }));

  app.get('/tracing/threads/:threadId', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { threadId } = request.params as { threadId: string };
      const refusal = await refuseTracingThread(request, threadId, { actor: { tenantDbName: session.tenantDbName, projectId, userId: session.userId } });
      if (refusal) return sendSessionRefusal(reply, request, refusal);
      const result = await AgentTracingService.getThreadDetail(
        session.tenantDbName,
        projectId,
        threadId,
      );

      if (!result) {
        return reply.code(404).send({ error: 'Thread not found' });
      }

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing thread detail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch thread',
        });
    }
  }));

  const agentOverviewHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { agentName } = request.params as { agentName: string };
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const result = await AgentTracingService.getAgentOverview(
        session.tenantDbName,
        projectId,
        decodeURIComponent(agentName),
        {
          from: searchParams.get('from') || filter.from?.toISOString(),
          timezone: searchParams.get('timezone') || undefined,
          to: searchParams.get('to') || filter.to?.toISOString(),
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing agent overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agent overview',
        });
    }
  });

  app.get('/tracing/agents/:agentName/overview', agentOverviewHandler);
  app.post('/tracing/agents/:agentName/overview', agentOverviewHandler);

  // Lightweight agent directory (sub-nav / pickers) — last 30 days by default.
  app.get('/tracing/agents', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const from = query.from
        || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const limit = Number.parseInt(query.limit || '50', 10);
      const result = await AgentTracingService.listRecentAgents(
        session.tenantDbName,
        projectId,
        {
          from,
          limit: Number.isFinite(limit) ? limit : 50,
          to: query.to,
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('List tracing agents error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch agents',
        });
    }
  }));

  const modelOverviewHandler = withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { modelName } = request.params as { modelName: string };
      const searchParams = new URLSearchParams(request.query as Record<string, string>);
      const filter = parseDashboardDateFilterFromSearchParams(searchParams);
      const result = await AgentTracingService.getModelOverview(
        session.tenantDbName,
        projectId,
        decodeURIComponent(modelName),
        {
          from: searchParams.get('from') || filter.from?.toISOString(),
          timezone: searchParams.get('timezone') || undefined,
          to: searchParams.get('to') || filter.to?.toISOString(),
        },
      );

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Get tracing model overview error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Failed to fetch model overview',
        });
    }
  });

  app.get('/tracing/models/:modelName/overview', modelOverviewHandler);
  app.post('/tracing/models/:modelName/overview', modelOverviewHandler);
};
