/**
 * Client-facing Agent Run endpoints — polling/cancel surface for background
 * agent execution (docs/guide/agent-background-execution.md §8).
 *
 * Both routes resolve the run through the caller's tenantId AND projectId
 * (§12.11) — never tenantId alone — so a token cannot read or cancel a run
 * belonging to a different project in the same tenant, even if it knows or
 * guesses the run id.
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getAgentRunStatus, getConversationById, requestAgentRunCancellation } from '@/lib/services/agents';
import { agentRunNotFoundErrorBody, apiErrorBody, serializeAgentRun } from '@/lib/services/agents/agentRunService';
import { withClientApiRequestContext } from '../fastify-utils';
import { authorizeEndingOpenRequests } from './agent-approval-authz';
import { refuseSessionLinked, sendAuthorizationUnavailable, sendClientSessionRefusal } from './agent-session-access';

const logger = createLogger('api:client-agent-runs');

const INTERNAL_ERROR_BODY = apiErrorBody('api_error', 'Internal error', 'internal_error');

export const clientAgentRunsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Poll status + result ──
  app.get('/client/v1/agents/runs/:runId', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { runId } = request.params as { runId: string };
      const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      // A sync reservation is an internal lock row, not a run a caller owns.
      if (!run || run.mode !== 'background') {
        return reply.code(404).send(agentRunNotFoundErrorBody());
      }
      // A run is a handle on its session (its `result` is the answer): reading it is reading the session - the
      // token's owner who queued it, or who started the session, needs nothing more; anybody else needs
      // `agent.session_view_others`.
      // (A session that is gone has nothing to protect; one the store cannot be asked about is a 503, not an allow.)
      const refusal = await refuseSessionLinked(request, run.conversationId, 'view', {
        actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
        alsoOwnedBy: [run.userId],
      });
      if (refusal) return sendClientSessionRefusal(reply, request, refusal);
      return reply.code(200).send(serializeAgentRun(run));
    } catch (error) {
      logger.error('Client agent run get error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // ── Cooperative cancel (queued or running) ──
  app.post('/client/v1/agents/runs/:runId/cancel', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { runId } = request.params as { runId: string };
      // A run paused on an approval is ended by cancelling it, which answers the open request with "no".
      const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      if (run && run.mode === 'background') {
        // Cancelling a run is acting on its session: the owner always may, anybody else needs
        // `agent.session_manage_others`.
        const refusal = await refuseSessionLinked(request, run.conversationId, 'manage', {
          actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
          alsoOwnedBy: [run.userId],
        });
        if (refusal) return sendClientSessionRefusal(reply, request, refusal);
      }
      if (run && run.mode === 'background' && run.status === 'requires_action') {
        const conversation = await getConversationById(ctx.tenantDbName, run.conversationId);
        if (conversation && conversation.projectId === ctx.projectId) {
          const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation });
          if (!verdict.allowed && verdict.unavailable) {
            return sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
          }
          if (!verdict.allowed) {
            return reply.code(403).send(apiErrorBody(
              'permission_error',
              'This run is waiting for an approval or an answer. You are not allowed to answer it, so you cannot cancel it.',
              'action_forbidden',
              verdict.decisionId ? { decision_id: verdict.decisionId } : undefined,
            ));
          }
        }
      }
      const outcome = await requestAgentRunCancellation(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      if (outcome.kind === 'not_found') {
        return reply.code(404).send(agentRunNotFoundErrorBody());
      }
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send(apiErrorBody(
          'agent_run_already_terminal',
          `Agent run is already ${outcome.run.status}; it cannot be canceled.`,
        ));
      }
      return reply.code(200).send(serializeAgentRun(outcome.run));
    } catch (error) {
      logger.error('Client agent run cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));
};
