/**
 * Red-team dashboard API plugin (session-authenticated, `/api/redteam/*`).
 *
 * Authoring + operating surface for the console UI: probe catalog, campaign
 * CRUD, async scan trigger, run history, and the human-in-the-loop review
 * endpoint that overrides a machine verdict (and recomputes the aggregate).
 */

import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { BUILTIN_PROBE_KEYS, listProbeCatalog } from '@/lib/services/redteam/probes';
import { validateCron } from '@/lib/services/redteam/schedulePlanner';
import { runCalibration } from '@/lib/services/redteam/calibration/calibrationRunner';
import { enqueueCampaignRun } from '@/lib/services/redteam/campaignJob';
import { buildJudgeInvoker, type RedTeamModelContext } from '@/lib/services/redteam/adapters';
import type { IRedTeamCampaign } from '@/lib/database';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  getRun,
  listCampaigns,
  listRuns,
  reviewAttempt,
  updateCampaign,
  type RunOptions,
} from '@/lib/services/redteam/service';
import type { RedTeamOutcome, RedTeamTargetKind } from '@/lib/database';
import {
  readJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:redteam');

const VALID_KINDS: RedTeamTargetKind[] = ['agent', 'model'];
const VALID_OUTCOMES: RedTeamOutcome[] = ['safe', 'vulnerable', 'needs_review'];

function internalError(reply: import('fastify').FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

/** Validate probe keys against the built-in catalog. Returns null if invalid. */
function sanitizeProbeKeys(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const keys = raw.filter((k): k is string => typeof k === 'string');
  if (keys.length !== raw.length) return null;
  const unknown = keys.find((k) => !BUILTIN_PROBE_KEYS.includes(k));
  if (unknown) return null;
  return keys;
}

type ScheduleResult = { schedule: IRedTeamCampaign['schedule'] } | { error: string };

/** Validate an optional cron schedule. Returns the parsed schedule or an error. */
function sanitizeSchedule(raw: unknown): ScheduleResult {
  if (raw === undefined || raw === null) return { schedule: undefined };
  if (typeof raw !== 'object') return { error: 'schedule must be an object' };
  const s = raw as Record<string, unknown>;
  if (typeof s.cron !== 'string') return { error: 'schedule.cron must be a string' };
  const cronError = validateCron(s.cron);
  if (cronError) return { error: cronError };
  return { schedule: { cron: s.cron, enabled: s.enabled !== false } };
}

type RunOptionsResult = { options: RunOptions } | { error: string };

/** Validate the per-run scan overrides from a request body. */
function sanitizeRunOptions(body: Record<string, unknown>): RunOptionsResult {
  const options: RunOptions = {};
  if (body.maxTurns !== undefined) {
    const n = Number(body.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 10) return { error: 'maxTurns must be an integer between 1 and 10' };
    options.maxTurns = n;
  }
  if (body.concurrency !== undefined) {
    const n = Number(body.concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 16) return { error: 'concurrency must be an integer between 1 and 16' };
    options.concurrency = n;
  }
  if (body.probeKeys !== undefined) {
    if (!Array.isArray(body.probeKeys)) return { error: 'probeKeys must be an array' };
    const keys = body.probeKeys.filter((k): k is string => typeof k === 'string');
    const unknown = keys.find((k) => !BUILTIN_PROBE_KEYS.includes(k));
    if (unknown) return { error: `unknown probe: ${unknown}` };
    options.probeKeys = keys;
  }
  if (typeof body.judgeModelKey === 'string' && body.judgeModelKey) {
    options.judgeModelKey = body.judgeModelKey;
  }
  return { options };
}

export const redTeamApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Probe catalog ──────────────────────────────────────────────────
  app.get('/redteam/probes', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      return reply.code(200).send({ probes: listProbeCatalog() });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Calibration ────────────────────────────────────────────────────
  // Run the golden set through the live detectors + decision policy to measure
  // precision/recall. An optional judgeModelKey enables judge-dependent cases.
  app.post('/redteam/calibration', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const ctx: RedTeamModelContext = {
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId: projectId ?? '',
        userId: session.userId,
      };
      const judgeModelKey = typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined;
      const result = await runCalibration(undefined, {
        invokeJudge: judgeModelKey ? buildJudgeInvoker(judgeModelKey, ctx) : undefined,
      });
      return reply.code(200).send({ calibration: result });
    } catch (error) {
      logger.error('Red-team calibration error', { error });
      return internalError(reply, error);
    }
  }));

  // ── Campaigns ──────────────────────────────────────────────────────
  app.get('/redteam/campaigns', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const campaigns = await listCampaigns(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ campaigns });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/redteam/campaigns', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      if (!VALID_KINDS.includes(body.targetKind as RedTeamTargetKind)) {
        return reply.code(400).send({ error: 'targetKind must be "agent" or "model"' });
      }
      if (body.targetKind === 'agent' && typeof body.agentKey !== 'string') {
        return reply.code(400).send({ error: 'agentKey is required for agent campaigns' });
      }
      if (body.targetKind === 'model' && typeof body.modelKey !== 'string') {
        return reply.code(400).send({ error: 'modelKey is required for model campaigns' });
      }
      const probeKeys = sanitizeProbeKeys(body.probeKeys);
      if (!probeKeys) {
        return reply.code(400).send({ error: `probeKeys must be a subset of: ${BUILTIN_PROBE_KEYS.join(', ')}` });
      }
      const runConfig = body.runConfig && typeof body.runConfig === 'object'
        ? { concurrency: Number((body.runConfig as Record<string, unknown>).concurrency) || undefined }
        : undefined;
      const sched = sanitizeSchedule(body.schedule);
      if ('error' in sched) return reply.code(400).send({ error: sched.error });
      const campaign = await createCampaign(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        targetKind: body.targetKind as RedTeamTargetKind,
        agentKey: typeof body.agentKey === 'string' ? body.agentKey : undefined,
        modelKey: typeof body.modelKey === 'string' ? body.modelKey : undefined,
        probeKeys,
        judgeModelKey: typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined,
        runConfig,
        policy: (body.policy as Record<string, never> | undefined) ?? undefined,
        schedule: sched.schedule,
        projectId,
      });
      return reply.code(201).send({ campaign });
    } catch (error) {
      logger.error('Create red-team campaign error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/redteam/campaigns/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const campaign = await getCampaign(session.tenantDbName, id);
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      return reply.code(200).send({ campaign });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/redteam/campaigns/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const probeKeys = body.probeKeys !== undefined ? sanitizeProbeKeys(body.probeKeys) : undefined;
      if (body.probeKeys !== undefined && !probeKeys) {
        return reply.code(400).send({ error: `probeKeys must be a subset of: ${BUILTIN_PROBE_KEYS.join(', ')}` });
      }
      let schedule: IRedTeamCampaign['schedule'] | undefined;
      if (body.schedule !== undefined) {
        const sched = sanitizeSchedule(body.schedule);
        if ('error' in sched) return reply.code(400).send({ error: sched.error });
        schedule = sched.schedule;
      }
      const campaign = await updateCampaign(session.tenantDbName, id, session.userId, {
        name: body.name as string | undefined,
        description: body.description as string | undefined,
        agentKey: body.agentKey as string | undefined,
        modelKey: body.modelKey as string | undefined,
        probeKeys: probeKeys ?? undefined,
        judgeModelKey: body.judgeModelKey as string | undefined,
        schedule,
      });
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      return reply.code(200).send({ campaign });
    } catch (error) {
      logger.error('Update red-team campaign error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/redteam/campaigns/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteCampaign(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Campaign not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Scan (async, queue-backed) ─────────────────────────────────────
  // Mirrors evaluation: create a pending run, publish a job, return immediately.
  // The queue consumer runs it in the background; the dashboard polls the run.
  // The optional body carries per-run overrides (turns, concurrency, probes, judge).
  app.post('/redteam/campaigns/:key/scan', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const optionsResult = sanitizeRunOptions(body);
      if ('error' in optionsResult) return reply.code(400).send({ error: optionsResult.error });
      const run = await enqueueCampaignRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        campaignKey: key,
        options: optionsResult.options,
      });
      return reply.code(202).send({ run, status: 'pending' });
    } catch (error) {
      logger.error('Run red-team scan error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes('already in progress')) {
        return reply.code(409).send({ error: error.message });
      }
      return internalError(reply, error);
    }
  }));

  // ── Runs ───────────────────────────────────────────────────────────
  app.get('/redteam/runs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { campaignKey?: string; limit?: string; skip?: string };
      const runs = await listRuns(session.tenantDbName, {
        projectId,
        campaignKey: query.campaignKey,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 200) : undefined,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      return reply.code(200).send({ runs });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/redteam/runs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const run = await getRun(session.tenantDbName, id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── HITL review ────────────────────────────────────────────────────
  app.post('/redteam/runs/:id/attempts/:attemptId/review', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id, attemptId } = request.params as { id: string; attemptId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (!VALID_OUTCOMES.includes(body.outcome as RedTeamOutcome)) {
        return reply.code(400).send({ error: 'outcome must be "safe", "vulnerable", or "needs_review"' });
      }
      const run = await reviewAttempt(session.tenantDbName, id, attemptId, {
        outcome: body.outcome as RedTeamOutcome,
        note: typeof body.note === 'string' ? body.note : undefined,
        reviewedBy: session.userId,
      });
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run });
    } catch (error) {
      logger.error('Review red-team attempt error', { error });
      return internalError(reply, error);
    }
  }));
};
