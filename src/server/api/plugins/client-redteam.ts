/**
 * Client Red-Team API plugin (API-token-authenticated, `/client/v1/*`).
 *
 * External-facing, snake_case surface for CI/automation — designed to fail a
 * pipeline when an agent regresses on safety:
 *
 *   GET  /client/v1/redteam/probes                  – built-in probe catalog
 *   GET  /client/v1/redteam/campaigns               – list configured campaigns
 *   POST /client/v1/redteam/campaigns/:key/scan     – trigger a scan (async); scanning an
 *        agent campaign also needs write access to Agents (403 otherwise), whichever version is asked for
 *   GET  /client/v1/redteam/runs                    – list runs (?campaign_key,?limit)
 *   GET  /client/v1/redteam/runs/:id                – one run + per-attempt verdicts
 *
 * Authoring of campaigns stays on the dashboard surface (`/api/redteam/*`).
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { listProbeCatalog } from '@/lib/services/redteam/probes';
import { enqueueCampaignRun } from '@/lib/services/redteam/campaignJob';
import { getRun, listCampaigns, listRuns, type WithId } from '@/lib/services/redteam/service';
import type { IRedTeamCampaign, IRedTeamRun } from '@/lib/database';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import { agentRevisionApiView, parseAgentRunOverride, storedAgentRevision } from '@/lib/shared/agentRevision';
import {
  getApiTokenContextForRequest,
  readOptionalJsonObjectBody,
  sendApiTokenError,
  withClientApiRequestContext,
} from '../fastify-utils';
import { requireAgentTestAccess, sendAgentTestRefusal } from './agent-test-permission';

const logger = createLogger('api:client-redteam');

function clampLimit(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 200);
}

function fail(reply: import('fastify').FastifyReply, error: unknown, scope: string) {
  // A refusal (403, or the 503 when the engine cannot decide) is answered as the gate answers it, never as a 404 or a 500.
  const refused = sendAgentTestRefusal(reply, error);
  if (refused) return refused;
  logger.error(`Client red-team ${scope} error`, { error });
  const message = error instanceof Error ? error.message : 'Internal error';
  return (
    sendApiTokenError(reply, error)
    ?? reply.code(message.toLowerCase().includes('not found') ? 404 : 500).send({ error: message })
  );
}

function toCampaignView(c: WithId<IRedTeamCampaign>) {
  return {
    key: c.key,
    name: c.name,
    description: c.description,
    target_kind: c.targetKind,
    agent_key: c.agentKey,
    // What a scan attacks unless it asks for another: "published", "draft" or a version.
    ...(c.targetKind === 'agent' ? { agent_version: storedAgentRevision(c.agentVersion) } : {}),
    model_key: c.modelKey,
    probe_keys: c.probeKeys,
    judge_model_key: c.judgeModelKey,
    created_at: c.createdAt,
  };
}

function toRunSummary(r: WithId<IRedTeamRun>) {
  return {
    id: r.id,
    campaign_key: r.campaignKey,
    target_kind: r.targetKind,
    target_ref: r.targetRef,
    agent_revision: agentRevisionApiView(r.agentRevision),
    status: r.status,
    aggregate: r.aggregate,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    created_at: r.createdAt,
  };
}

function toRunView(r: WithId<IRedTeamRun>) {
  return {
    ...toRunSummary(r),
    progress: r.progress,
    error: r.error,
    attempts: r.attempts.map((a) => ({
      probe_key: a.probeKey,
      attempt_id: a.attemptId,
      family: a.family,
      category: a.category,
      severity: a.severity,
      outcome: a.review?.outcome ?? a.outcome,
      machine_outcome: a.outcome,
      decided_by: a.decidedBy,
      confidence: a.confidence,
      reviewed: Boolean(a.review),
      latency_ms: a.latencyMs,
      error: a.error,
    })),
  };
}

export const clientRedTeamApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/client/v1/redteam/probes', withClientApiRequestContext(async (request, reply) => {
    try {
      await getApiTokenContextForRequest(request);
      return reply.code(200).send({ probes: listProbeCatalog() });
    } catch (error) {
      return fail(reply, error, 'list probes');
    }
  }));

  app.get('/client/v1/redteam/campaigns', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const campaigns = await listCampaigns(ctx.tenantDbName, { projectId: ctx.projectId });
      return reply.code(200).send({ campaigns: campaigns.map(toCampaignView) });
    } catch (error) {
      return fail(reply, error, 'list campaigns');
    }
  }));

  app.post('/client/v1/redteam/campaigns/:key/scan', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { key } = request.params as { key: string };
      if (!key) return reply.code(400).send({ error: 'campaign key is required' });
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
      const run = await enqueueCampaignRun({
        tenantDbName: ctx.tenantDbName,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        createdBy: ctx.tokenRecord.userId ?? 'api-token',
        campaignKey: key,
        ...(revision.revision !== undefined ? { options: { agentVersion: revision.revision } } : {}),
        // Asked by the service once it knows the campaign targets an agent, before a run row exists. For a
        // token it is the owner's permission, capped by the token's scope.
        authorizeAgentRun: () => requireAgentTestAccess(request),
      });
      return reply.code(202).send({ run: toRunSummary(run), status: 'pending' });
    } catch (error) {
      // Before the message checks below: a refusal must never be read as a 409.
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
      if (error instanceof AgentRevisionError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes('already in progress')) {
        return reply.code(409).send({ error: error.message });
      }
      return fail(reply, error, 'run scan');
    }
  }));

  app.get('/client/v1/redteam/runs', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const query = (request.query ?? {}) as { campaign_key?: string; limit?: string };
      const runs = await listRuns(ctx.tenantDbName, {
        projectId: ctx.projectId,
        campaignKey: query.campaign_key,
        limit: clampLimit(query.limit),
      });
      return reply.code(200).send({ runs: runs.map(toRunSummary) });
    } catch (error) {
      return fail(reply, error, 'list runs');
    }
  }));

  app.get('/client/v1/redteam/runs/:id', withClientApiRequestContext(async (request, reply) => {
    try {
      const ctx = await getApiTokenContextForRequest(request);
      const { id } = request.params as { id: string };
      const run = await getRun(ctx.tenantDbName, id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run: toRunView(run) });
    } catch (error) {
      return fail(reply, error, 'get run');
    }
  }));
};
