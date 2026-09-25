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
import { getAgentRunStatus, requestAgentRunCancellation } from '@/lib/services/agents';
import { agentRunNotFoundErrorBody, apiErrorBody, serializeAgentRun } from '@/lib/services/agents/agentRunService';
import { withClientApiRequestContext } from '../fastify-utils';

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
