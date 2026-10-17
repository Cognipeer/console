/**
 * Client-facing Agent Run endpoints — polling/cancel surface for background
 * agent execution (docs/guide/agent-background-execution.md §8).
 *
 * Both routes resolve the run through the caller's tenantId AND projectId
 * (§12.11) — never tenantId alone — so a token cannot read or cancel a run
 * belonging to a different project in the same tenant, even if it knows or
 * guesses the run id.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getAgentRunStatus, getConversationById, requestAgentRunCancellation } from '@/lib/services/agents';
import { agentRunNotFoundErrorBody, apiErrorBody, serializeAgentRun } from '@/lib/services/agents/agentRunService';
import { cancelConversationTurn } from '@/lib/services/agents/turnCancellation';
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
      if (!run || run.mode === 'sync') {
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
      if (run && run.mode !== 'sync') {
        // Cancelling a run is acting on its session: the owner always may, anybody else needs
        // `agent.session_manage_others`.
        const refusal = await refuseSessionLinked(request, run.conversationId, 'manage', {
          actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
          alsoOwnedBy: [run.userId],
        });
        if (refusal) return sendClientSessionRefusal(reply, request, refusal);
      }
      if (run && run.mode !== 'sync' && run.status === 'requires_action') {
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

  // ── Stop a turn that is running now, by the id the client already has ──
  //
  // An inline request (`/responses`, chat completions, A2A, Assistants) holds its
  // connection until the answer is done, so the way to stop it is a second request
  // naming the conversation. The turn ends with what it had streamed as its answer
  // (`stop_reason: cancelled`) and the model call stops. Nothing running is a 200
  // with `cancelled: false`, not an error: a Stop that lands as the turn ends is normal.
  const cancelByConversation = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ctx: { tenantDbName: string; tenantId: string; projectId: string; tokenRecord: { userId?: unknown } },
    conversationId: string,
  ) => {
    const conversation = await getConversationById(ctx.tenantDbName, conversationId).catch(() => null);
    if (!conversation || conversation.projectId !== ctx.projectId) return null;
    // Stopping a session is acting on it: the owner always may, anybody else needs `agent.session_manage_others`.
    const refusal = await refuseSessionLinked(request, conversationId, 'manage', {
      actor: { tenantDbName: ctx.tenantDbName, projectId: ctx.projectId, userId: String(ctx.tokenRecord.userId ?? '') },
    });
    if (refusal) return sendClientSessionRefusal(reply, request, refusal);
    // Ending an open approval is answering it "no": without that right the turn still stops, the approval stays.
    const verdict = await authorizeEndingOpenRequests(request, { tenantDbName: ctx.tenantDbName, conversation });
    if (!verdict.allowed && verdict.unavailable) {
      return sendAuthorizationUnavailable(reply, request, 'client', { action: 'agent.approve', level: 'write', decisionId: verdict.decisionId });
    }
    return cancelConversationTurn({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      conversationId,
      cancelActions: verdict.allowed,
    });
  };

  app.post('/client/v1/agents/conversations/:conversationId/cancel', withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { conversationId } = request.params as { conversationId: string };
      const outcome = await cancelByConversation(request, reply, ctx, conversationId);
      if (!outcome) return reply.code(404).send(agentRunNotFoundErrorBody());
      if (reply.sent || !('cancelled' in outcome)) return reply;
      return reply.code(200).send({ conversation_id: conversationId, cancelled: outcome.cancelled, run_ids: outcome.runIds });
    } catch (error) {
      logger.error('Client conversation cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  }));

  // `resp_<conversationId>` (what /responses returns) or `run_<runId>` (a background run).
  const cancelResponse = withClientApiRequestContext(async (request, reply, ctx) => {
    try {
      const { responseId } = request.params as { responseId: string };
      let conversationId: string | undefined;
      if (responseId.startsWith('run_')) {
        const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, responseId.slice(4));
        conversationId = run?.conversationId;
      } else if (responseId.startsWith('resp_')) {
        conversationId = responseId.slice(5);
      }
      const outcome = conversationId ? await cancelByConversation(request, reply, ctx, conversationId) : null;
      if (!outcome) return reply.code(404).send(agentRunNotFoundErrorBody());
      if (reply.sent || !('cancelled' in outcome)) return reply;
      return reply.code(200).send({ id: responseId, conversation_id: conversationId, cancelled: outcome.cancelled, run_ids: outcome.runIds });
    } catch (error) {
      logger.error('Client response cancel error', { error });
      return reply.code(500).send(INTERNAL_ERROR_BODY);
    }
  });
  app.post('/client/v1/responses/:responseId/cancel', cancelResponse);
  app.post('/client/v1/agents/responses/:responseId/cancel', cancelResponse);
};
