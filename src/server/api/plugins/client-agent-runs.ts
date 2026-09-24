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
import type { IAgentRun } from '@/lib/database';
import { getAgentRunStatus, requestAgentRunCancellation } from '@/lib/services/agents';
import {
  getApiTokenContextForRequest,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-agent-runs');

function toEpochSeconds(value: Date | null | undefined): number | null {
  return value ? Math.floor(new Date(value).getTime() / 1000) : null;
}

/** Matches the "Status response shape" draft in §8. */
function serializeAgentRunStatus(run: IAgentRun) {
  return {
    id: `run_${run._id}`,
    object: 'agent.run' as const,
    status: run.status,
    agent: run.agentKey,
    conversation_id: run.conversationId,
    result: run.result ?? null,
    error: run.status === 'failed' || run.status === 'canceled'
      ? { type: run.errorReason ?? 'agent_error', message: run.errorMessage ?? null }
      : null,
    created_at: toEpochSeconds(run.createdAt),
    started_at: toEpochSeconds(run.startedAt),
    completed_at: toEpochSeconds(run.completedAt),
  };
}

export const clientAgentRunsApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Poll status + result ──
  app.get('/client/v1/agents/runs/:runId', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { runId } = request.params as { runId: string };
      const run = await getAgentRunStatus(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      if (!run) {
        return reply.code(404).send({ error: 'Agent run not found' });
      }
      return reply.code(200).send(serializeAgentRunStatus(run));
    } catch (error) {
      logger.error('Client agent run get error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));

  // ── Cooperative cancel (queued or running) ──
  app.post('/client/v1/agents/runs/:runId/cancel', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { runId } = request.params as { runId: string };
      const outcome = await requestAgentRunCancellation(ctx.tenantDbName, ctx.tenantId, ctx.projectId, runId);
      if (outcome.kind === 'not_found') {
        return reply.code(404).send({ error: 'Agent run not found' });
      }
      if (outcome.kind === 'already_terminal') {
        return reply.code(409).send({
          error: {
            type: 'agent_run_already_terminal',
            message: `Agent run is already ${outcome.run.status}; it cannot be canceled.`,
            code: 'agent_run_already_terminal',
          },
        });
      }
      return reply.code(200).send(serializeAgentRunStatus(outcome.run));
    } catch (error) {
      logger.error('Client agent run cancel error', { error });
      return sendApiTokenError(reply, error)
        ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' });
    }
  }));
};
