/**
 * Client Evaluation API plugin.
 *
 * External-facing, API-token-authenticated surface under `/client/v1/*` with
 * snake_case fields like the other client modules. It is read- and
 * trigger-oriented — designed for CI/automation:
 *
 *   GET  /client/v1/evaluation/suites             – list configured suites
 *   POST /client/v1/evaluation/suites/:key/run    – run a suite (synchronous by
 *        default; `{ wait: false }` queues it and answers 202 with the pending run
 *        to poll); optional body `{ agent_version }`: "published", "draft" or a
 *        version number, for agent targets. Running an agent target also needs write
 *        access to Agents (403 otherwise), whichever version is asked for
 *   GET  /client/v1/evaluation/runs               – list runs (?suite_key, ?limit)
 *   GET  /client/v1/evaluation/runs/:id           – get one run + per-item scores
 *
 * Authoring of targets / datasets / suites stays on the dashboard surface
 * (`/api/evaluation/*`, session-authenticated) — an admin concern.
 *
 * Serializers live in a shared module
 * (`lib/services/evaluation/clientEvaluationShared.ts`) (one envelope).
 */

import { enforceServiceQuota, isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { getRun, listRuns, listSuites, runSuite } from '@/lib/services/evaluation/service';
import { enqueueSuiteRun } from '@/lib/services/evaluation/evaluationRunJob';
import { EvaluationConflictError, EvaluationInputError } from '@/lib/services/evaluation/errors';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import { parseAgentRunOverride } from '@/lib/shared/agentRevision';
import {
  toRunSummary,
  toRunView,
  toSuiteView,
} from '@/lib/services/evaluation/clientEvaluationShared';
import {
  getApiTokenContextForRequest,
  readOptionalJsonObjectBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';
import type { ApiTokenContext } from '@/lib/services/apiTokenAuth';
import { apiTokenViewer, withoutRestrictedRunItems } from '../restrictedKnowledgeRequest';
import { requireAgentTestAccess, sendAgentTestRefusal } from './agent-test-permission';

const logger = createLogger('api:client-evaluation');

function clampLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 200);
}

/**
 * A client API run is started by the token that calls, never by the token's owner: the run is stored with the token
 * and executes as it, synchronously or from the queue (delegated or not, see RunSuiteParams.actorType).
 */
function startedByToken(ctx: Pick<ApiTokenContext, 'tokenRecord'>) {
  return {
    createdBy: ctx.tokenRecord.userId ?? 'api-token',
    actorType: 'api_token' as const,
    ...(ctx.tokenRecord._id ? { apiTokenId: String(ctx.tokenRecord._id) } : {}),
  };
}

/** Whose stored copies a token reads: what the token itself started, nothing a person did (see apiTokenViewer). */
function tokenViewer(ctx: Pick<ApiTokenContext, 'tenantDbName' | 'tokenRecord'>) {
  return { tenantDbName: ctx.tenantDbName, viewerUserId: ctx.tokenRecord._id ? apiTokenViewer(String(ctx.tokenRecord._id)) : null };
}

function fail(reply: import('fastify').FastifyReply, error: unknown, scope: string) {
  if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
  // A refusal (403, or the 503 when the engine cannot decide) is answered as the gate answers it, never as a 404 or a 500.
  const refused = sendAgentTestRefusal(reply, error);
  if (refused) return refused;
  logger.error(`Client evaluation ${scope} error`, { error });
  if (error instanceof EvaluationConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof EvaluationInputError) return reply.code(400).send({ error: error.message });
  const message = error instanceof Error ? error.message : 'Internal error';
  return (
    sendApiTokenError(reply, error)
    ?? reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({ error: message })
  );
}

export const clientEvaluationsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/evaluation/suites', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const suites = await listSuites(ctx.tenantDbName, { projectId: ctx.projectId });
      return reply.code(200).send({ suites: suites.map(toSuiteView) });
    } catch (error) {
      return fail(reply, error, 'list suites');
    }
  }));

  app.post('/client/v1/evaluation/suites/:key/run', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!key) return reply.code(400).send({ error: 'suite key is required' });
      // The body is optional: existing callers POST with none. One that is
      // sent must parse, or the run would quietly test the default revision.
      let body: Record<string, unknown>;
      try {
        body = readOptionalJsonObjectBody(request);
      } catch {
        return reply.code(400).send({ error: 'Request body must be a JSON object' });
      }
      const revision = parseAgentRunOverride(body.agent_version, 'agent_version');
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      if (body.wait !== undefined && typeof body.wait !== 'boolean') {
        return reply.code(400).send({ error: '`wait` must be a boolean' });
      }
      const wait = body.wait !== false;
      await enforceServiceQuota(
        { tenantDbName: ctx.tenantDbName, tenantId: ctx.tenantId, projectId: ctx.projectId },
        { domain: 'jobs', resourceKey: 'evaluation', cost: { requests: 1 } },
      );
      if (!wait) {
        // Queue and return at once (a long suite outlives most HTTP clients' and proxies' timeouts); the caller
        // polls GET /runs/:id. Same quota and agent authorisation as the synchronous path.
        const pending = await enqueueSuiteRun({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          ...startedByToken(ctx),
          suiteKey: key,
          agentVersion: revision.revision,
          authorizeAgentRun: () => requireAgentTestAccess(request),
        });
        return reply.code(202).send({ run: toRunSummary(pending) });
      }
      const run = await runSuite({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        ...startedByToken(ctx),
        suiteKey: key,
        agentVersion: revision.revision,
        // Asked by the service once it knows the suite's target is an agent, before a run row exists. For a
        // token it is the owner's permission, capped by the token's scope.
        authorizeAgentRun: () => requireAgentTestAccess(request),
      });
      return reply.code(201).send({ run: toRunView(await withoutRestrictedRunItems(request, tokenViewer(ctx), run)) });
    } catch (error) {
      if (error instanceof AgentRevisionError) return reply.code(400).send({ error: error.message });
      // The same suite on the same revision is already running (a different revision may run alongside).
      if (error instanceof Error && error.message.toLowerCase().includes('already in progress')) {
        return reply.code(409).send({ error: error.message });
      }
      return fail(reply, error, 'run suite');
    }
  }));

  app.get('/client/v1/evaluation/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { suite_key?: string; limit?: string };
      const runs = await listRuns(ctx.tenantDbName, {
        projectId: ctx.projectId,
        suiteKey: query.suite_key,
        limit: clampLimit(query.limit),
      });
      return reply.code(200).send({ runs: runs.map(toRunSummary) });
    } catch (error) {
      return fail(reply, error, 'list runs');
    }
  }));

  app.get('/client/v1/evaluation/runs/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const run = await getRun(ctx.tenantDbName, id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run: toRunView(await withoutRestrictedRunItems(request, tokenViewer(ctx), run)) });
    } catch (error) {
      return fail(reply, error, 'get run');
    }
  }));
};
