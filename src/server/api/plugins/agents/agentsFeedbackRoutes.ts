import type { FastifyInstance } from 'fastify';
import {
  withApiRequestContext,
} from '../../fastify-utils';
import {
  sessionHasAgentsPermission,
} from '../agents-permission';
import {
  FeedbackError,
  listAgentFeedback,
  listSessionFeedback,
  summarizeAgentFeedback,
  toFeedbackView,
} from '@/lib/services/agents/agentFeedback';
import {
  requireScopedAgent,
  requireScopedSession,
  AGENT_SCOPED,
  feedbackDays,
  parseFeedbackFilter,
  sendRouteError,
} from './agentsRouteHelpers';

export function registerAgentsFeedbackRoutes(app: FastifyInstance): void {
  // ── Feedback: what people said about this agent's answers ──
  //
  // Counts and reasons are for everyone who can read agents; the words people wrote (and
  // who wrote them) only for those who can change them (`canReadComments` says which).

  app.get('/agents/:agentId/sessions/:sessionId/feedback', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedSession(request, reply, { need: 'view' });
      if (!scoped) return reply;
      const canReadComments = await sessionHasAgentsPermission(scoped.session, 'write');
      const rows = await listSessionFeedback({
        tenantDbName: scoped.session.tenantDbName,
        projectId: scoped.projectId,
        conversationId: String(scoped.conversation._id),
        agentKey: scoped.agent.key,
      });
      return reply.code(200).send({
        feedback: rows.map((row) => {
          const view = toFeedbackView(row, { includeComment: canReadComments });
          return canReadComments ? view : { ...view, userId: undefined };
        }),
        canReadComments,
      });
    } catch (error) {
      if (error instanceof FeedbackError) return reply.code(error.status).send({ error: error.message, code: error.code });
      return sendRouteError(reply, error, 'List session feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const query = (request.query ?? {}) as Record<string, string | undefined>;
      const canReadComments = await sessionHasAgentsPermission(session, 'write');
      const page = await listAgentFeedback(session.tenantDbName, filter, {
        limit: Math.min(Math.max(Number(query.limit) || 25, 1), 100),
        skip: Math.max(Number(query.skip) || 0, 0),
      });
      return reply.code(200).send({
        items: page.items.map((row) => ({
          ...toFeedbackView(row, { includeComment: canReadComments }),
          conversationId: row.conversationId,
          agentVersion: row.agentVersion ?? null,
          ...(canReadComments ? {} : { userId: undefined }),
        })),
        total: page.total,
        canReadComments,
      });
    } catch (error) {
      return sendRouteError(reply, error, 'List agent feedback error', 'Failed to list feedback');
    }
  }));

  app.get('/agents/:agentId/feedback/summary', AGENT_SCOPED, withApiRequestContext(async (request, reply) => {
    try {
      const scoped = await requireScopedAgent(request, reply);
      if (!scoped) return reply;
      const { agent, projectId, session } = scoped;
      const filter = parseFeedbackFilter(request.query, agent.key, projectId);
      if ('error' in filter) return reply.code(400).send({ error: filter.error });
      const summary = await summarizeAgentFeedback(session.tenantDbName, filter);
      return reply.code(200).send({ summary, days: feedbackDays(request.query) });
    } catch (error) {
      return sendRouteError(reply, error, 'Summarize agent feedback error', 'Failed to summarize feedback');
    }
  }));
}
