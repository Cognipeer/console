import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  requireProjectContextForRequest,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:tracing');

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
      const result = await AgentTracingService.listSessions(session.tenantDbName, projectId, {
        agent: query.agent,
        from: query.from,
        limit: query.limit || '50',
        query: query.query,
        skip: query.skip || '0',
        status: query.status,
        to: query.to,
      });

      return reply.code(200).send(result);
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
      const result = await AgentTracingService.listThreads(session.tenantDbName, projectId, {
        agent: query.agent,
        from: query.from,
        limit: query.limit || '50',
        skip: query.skip || '0',
        status: query.status,
        threadId: query.threadId,
        to: query.to,
      });

      return reply.code(200).send(result);
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
};
