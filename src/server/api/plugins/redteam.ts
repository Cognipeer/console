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
import type { IRedTeamCustomAttempt, IRedTeamCustomDetectors, RedTeamSeverity } from '@/lib/database';
import { validateCron } from '@/lib/services/redteam/schedulePlanner';
import { runCalibration } from '@/lib/services/redteam/calibration/calibrationRunner';
import { enqueueCampaignRun } from '@/lib/services/redteam/campaignJob';
import { buildComplianceReport } from '@/lib/services/redteam/compliance/report';
import { EU_RISK_TIERS, type CampaignComplianceMeta, type EuRiskTier } from '@/lib/services/redteam/compliance/types';
import { EU_RISK_CATEGORIES } from '@/lib/services/redteam/euTaxonomy';
import { buildJudgeInvoker, type RedTeamModelContext } from '@/lib/services/redteam/adapters';
import type { IRedTeamCampaign } from '@/lib/database';
import { AgentRevisionError } from '@/lib/services/agents/agentRevision';
import {
  parseAgentRevision,
  parseAgentRunOverride,
  storedAgentRevision,
  toStoredAgentVersion,
  type AgentRevision,
} from '@/lib/shared/agentRevision';
import {
  compareRuns,
  createCampaign,
  createCustomProbe,
  deleteCampaign,
  deleteCustomProbe,
  getCampaign,
  getCustomProbe,
  getOverview,
  getRun,
  listCampaigns,
  listCustomProbes,
  listRuns,
  reviewAttempt,
  updateCampaign,
  updateCustomProbe,
  CustomProbeError,
  type CustomProbeInput,
  type RunOptions,
  type UpdateCampaignInput,
} from '@/lib/services/redteam/service';
import type { RedTeamOutcome, RedTeamTargetKind } from '@/lib/database';
import {
  readJsonBody,
  readOptionalJsonObjectBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { withoutRestrictedAttempts } from '../restrictedKnowledgeRequest';
import { requireAgentTestAccess, sendAgentTestRefusal } from './agent-test-permission';
import { readClearableText, readRequiredText } from './partial-update';

const logger = createLogger('api:redteam');

const VALID_KINDS: RedTeamTargetKind[] = ['agent', 'model'];
const VALID_OUTCOMES: RedTeamOutcome[] = ['safe', 'vulnerable', 'needs_review'];

function internalError(reply: import('fastify').FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

/**
 * Validate probe keys against the built-in catalog plus the tenant's custom
 * probe keys. Returns null if any key is unknown.
 */
function sanitizeProbeKeys(raw: unknown, customKeys: string[] = []): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const keys = raw.filter((k): k is string => typeof k === 'string');
  if (keys.length !== raw.length) return null;
  const allowed = new Set([...BUILTIN_PROBE_KEYS, ...customKeys]);
  const unknown = keys.find((k) => !allowed.has(k));
  if (unknown) return null;
  return keys;
}

/** A PATCH's `probeKeys` must be a list of keys; which ones exist is checked once the campaign (and so its project) is known. */
function isProbeKeyList(raw: unknown): raw is string[] {
  return Array.isArray(raw) && raw.every((k) => typeof k === 'string');
}

/** Load the tenant's custom probe selection keys (for validating campaigns). */
async function loadCustomProbeKeys(tenantDbName: string, projectId?: string): Promise<string[]> {
  const probes = await listCustomProbes(tenantDbName, { projectId });
  return probes.map((p) => p.key);
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

/**
 * A scheduled scan runs unattended to guard what is in service, so it may not
 * default to an unpublished draft. `null` when the combination is fine.
 */
function scheduledDraftError(
  schedule: IRedTeamCampaign['schedule'] | undefined,
  revision: AgentRevision,
): string | null {
  if (!schedule?.enabled || revision !== 'draft') return null;
  return 'A scheduled scan guards what is published: pick Published or a version for agentVersion, or turn the schedule off.';
}

type RunOptionsResult = { options: RunOptions } | { error: string };

/** Validate the per-run scan overrides from a request body. */
function sanitizeRunOptions(body: Record<string, unknown>, customKeys: string[] = []): RunOptionsResult {
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
    const allowed = new Set([...BUILTIN_PROBE_KEYS, ...customKeys]);
    const unknown = keys.find((k) => !allowed.has(k));
    if (unknown) return { error: `unknown probe: ${unknown}` };
    options.probeKeys = keys;
  }
  if (typeof body.judgeModelKey === 'string' && body.judgeModelKey) {
    options.judgeModelKey = body.judgeModelKey;
  }
  const revision = parseAgentRunOverride(body.agentVersion);
  if (!revision.ok) return { error: revision.error };
  if (revision.revision !== undefined) options.agentVersion = revision.revision;
  return { options };
}

const VALID_SEVERITIES: RedTeamSeverity[] = ['low', 'medium', 'high', 'critical'];
const VALID_OWASP_CATEGORIES = [
  'LLM01-prompt-injection',
  'LLM02-insecure-output-handling',
  'LLM04-model-dos',
  'LLM05-supply-chain',
  'LLM06-sensitive-information-disclosure',
  'LLM07-system-prompt-leakage',
  'LLM08-excessive-agency',
  'LLM09-overreliance',
];

type ComplianceResult = { compliance: CampaignComplianceMeta | undefined } | { error: string };

/** Validate optional EU compliance metadata on a campaign body. */
function sanitizeCompliance(raw: unknown): ComplianceResult {
  if (raw === undefined || raw === null) return { compliance: undefined };
  if (typeof raw !== 'object') return { error: 'compliance must be an object' };
  const c = raw as Record<string, unknown>;
  const out: CampaignComplianceMeta = {};
  if (c.riskTier !== undefined) {
    if (typeof c.riskTier !== 'string' || !EU_RISK_TIERS.includes(c.riskTier as EuRiskTier)) {
      return { error: `riskTier must be one of: ${EU_RISK_TIERS.join(', ')}` };
    }
    out.riskTier = c.riskTier as EuRiskTier;
  }
  const strField = (v: unknown, max = 2000): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  out.intendedPurpose = strField(c.intendedPurpose);
  out.systemCardUrl = strField(c.systemCardUrl, 500);
  out.deployer = strField(c.deployer, 300);
  out.provider = strField(c.provider, 300);
  out.notes = strField(c.notes, 5000);
  // Collapse to undefined when nothing meaningful was provided.
  const hasAny = Object.values(out).some((v) => v !== undefined);
  return { compliance: hasAny ? out : undefined };
}

type CustomProbeResult = { input: Omit<CustomProbeInput, 'projectId'> } | { error: string };

/** Validate and normalise a custom-probe request body. */
function sanitizeCustomProbe(body: Record<string, unknown>): CustomProbeResult {
  if (typeof body.name !== 'string' || body.name.trim() === '') return { error: 'name is required' };
  if (typeof body.category !== 'string' || !VALID_OWASP_CATEGORIES.includes(body.category)) {
    return { error: `category must be one of: ${VALID_OWASP_CATEGORIES.join(', ')}` };
  }
  if (!VALID_SEVERITIES.includes(body.severity as RedTeamSeverity)) {
    return { error: 'severity must be "low", "medium", "high", or "critical"' };
  }
  if (!Array.isArray(body.attempts) || body.attempts.length === 0) {
    return { error: 'attempts must be a non-empty array' };
  }
  const attempts: IRedTeamCustomAttempt[] = [];
  for (let i = 0; i < body.attempts.length; i += 1) {
    const a = body.attempts[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object') return { error: `attempt ${i + 1} must be an object` };
    const turns = Array.isArray(a.turns) ? a.turns.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [];
    if (turns.length === 0) return { error: `attempt ${i + 1} needs at least one non-empty turn` };
    attempts.push({
      id: typeof a.id === 'string' && a.id.trim() ? a.id : `attempt-${i + 1}`,
      turns,
      system: typeof a.system === 'string' ? a.system : undefined,
      canary: typeof a.canary === 'string' ? a.canary : undefined,
      forbiddenPatterns: Array.isArray(a.forbiddenPatterns)
        ? a.forbiddenPatterns.filter((p): p is string => typeof p === 'string')
        : undefined,
      refusalExpected: typeof a.refusalExpected === 'boolean' ? a.refusalExpected : undefined,
      adaptive: typeof a.adaptive === 'boolean' ? a.adaptive : undefined,
      objective: typeof a.objective === 'string' ? a.objective : undefined,
    });
  }
  const rawDetectors = (body.detectors ?? {}) as Record<string, unknown>;
  const judges = Array.isArray(rawDetectors.judges)
    ? rawDetectors.judges
        .map((j) => j as Record<string, unknown>)
        .filter((j) => typeof j.lens === 'string' && typeof j.rubric === 'string')
        .map((j) => ({
          lens: j.lens as string,
          rubric: j.rubric as string,
          threshold: typeof j.threshold === 'number' ? j.threshold : undefined,
        }))
    : [];
  const detectors: IRedTeamCustomDetectors = {
    refusal: rawDetectors.refusal !== false,
    pattern: rawDetectors.pattern !== false,
    judges,
  };
  if (!detectors.refusal && !detectors.pattern && judges.length === 0) {
    return { error: 'select at least one detector (refusal, pattern, or a judge lens)' };
  }
  return {
    input: {
      name: body.name.trim(),
      // Optional fields only when the body carries them, so a PATCH leaves the stored ones alone.
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.family === 'string' && body.family.trim() ? { family: body.family.trim() } : {}),
      category: body.category,
      severity: body.severity as RedTeamSeverity,
      attempts,
      detectors,
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    },
  };
}

export const redTeamApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Probe catalog (built-in + tenant custom probes) ────────────────
  app.get('/redteam/probes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const customProbes = await listCustomProbes(session.tenantDbName, { projectId });
      return reply.code(200).send({ probes: listProbeCatalog(customProbes) });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── OWASP overview ─────────────────────────────────────────────────
  app.get('/redteam/overview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { limit?: string };
      const overview = await getOverview(session.tenantDbName, {
        projectId,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 500) : undefined,
      });
      return reply.code(200).send({ overview });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── EU AI Act compliance report ────────────────────────────────────
  // Aggregate completed-scan evidence into a regulator-facing Model-Report-style
  // document (per-EU-category posture, evidence samples, findings, coverage gaps).
  app.get('/redteam/compliance/report', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { limit?: string };
      const report = await buildComplianceReport(session.tenantDbName, new Date(), {
        projectId,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 500) : undefined,
      });
      return reply.code(200).send({ report });
    } catch (error) {
      logger.error('Compliance report error', { error });
      return internalError(reply, error);
    }
  }));

  // Static EU risk taxonomy + article mapping (for UI legends / documentation).
  app.get('/redteam/compliance/mapping', withApiRequestContext(async (request, reply) => {
    try {
      requireSessionContext(request);
      return reply.code(200).send({ categories: Object.values(EU_RISK_CATEGORIES), riskTiers: EU_RISK_TIERS });
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
      const customKeys = await loadCustomProbeKeys(session.tenantDbName, projectId);
      const probeKeys = sanitizeProbeKeys(body.probeKeys, customKeys);
      if (!probeKeys) {
        return reply.code(400).send({ error: 'probeKeys must reference built-in or existing custom probes' });
      }
      const runConfig = body.runConfig && typeof body.runConfig === 'object'
        ? { concurrency: Number((body.runConfig as Record<string, unknown>).concurrency) || undefined }
        : undefined;
      const sched = sanitizeSchedule(body.schedule);
      if ('error' in sched) return reply.code(400).send({ error: sched.error });
      const comp = sanitizeCompliance(body.compliance);
      if ('error' in comp) return reply.code(400).send({ error: comp.error });
      const revision = parseAgentRevision(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      const isAgent = body.targetKind === 'agent';
      const draftError = isAgent ? scheduledDraftError(sched.schedule, revision.revision ?? 'published') : null;
      if (draftError) return reply.code(400).send({ error: draftError });
      // A saved agent campaign is scanned later (by its schedule too), so whoever saves one may spend the agent.
      if (isAgent) await requireAgentTestAccess(request);
      const campaign = await createCampaign(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        targetKind: body.targetKind as RedTeamTargetKind,
        agentKey: typeof body.agentKey === 'string' ? body.agentKey : undefined,
        ...(isAgent && revision.revision !== undefined ? { agentVersion: toStoredAgentVersion(revision.revision) } : {}),
        modelKey: typeof body.modelKey === 'string' ? body.modelKey : undefined,
        probeKeys,
        judgeModelKey: typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined,
        runConfig,
        policy: (body.policy as Record<string, never> | undefined) ?? undefined,
        schedule: sched.schedule,
        compliance: comp.compliance,
        projectId,
      });
      return reply.code(201).send({ campaign });
    } catch (error) {
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
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
      // Only the keys the body carries reach the update: an absent key leaves the stored value alone, `null`
      // clears the description, the judge model or the schedule, and a key that cannot be cleared must hold
      // a value (see partial-update.ts).
      const data: UpdateCampaignInput = {};
      const invalid =
        readRequiredText(body, 'name', data)
        ?? readRequiredText(body, 'agentKey', data)
        ?? readRequiredText(body, 'modelKey', data)
        ?? readClearableText(body, 'description', data)
        ?? readClearableText(body, 'judgeModelKey', data, { blankClears: true });
      if (invalid) return reply.code(400).send({ error: invalid });
      if (body.probeKeys !== undefined && !isProbeKeyList(body.probeKeys)) {
        return reply.code(400).send({ error: 'probeKeys must be an array of probe keys' });
      }
      if (body.schedule === null) {
        data.schedule = null;
      } else if (body.schedule !== undefined) {
        const sched = sanitizeSchedule(body.schedule);
        if ('error' in sched) return reply.code(400).send({ error: sched.error });
        data.schedule = sched.schedule;
      }
      if (body.compliance !== undefined) {
        const comp = sanitizeCompliance(body.compliance);
        if ('error' in comp) return reply.code(400).send({ error: comp.error });
        if (comp.compliance !== undefined) data.compliance = comp.compliance;
      }
      const revision = parseAgentRevision(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      const existing = await getCampaign(session.tenantDbName, id);
      if (!existing) return reply.code(404).send({ error: 'Campaign not found' });
      const isAgent = existing.targetKind === 'agent';
      // The stored kind decides, not the body: a PATCH cannot move a campaign between kinds, and a saved
      // campaign can run the agent later on its schedule.
      if (isAgent) await requireAgentTestAccess(request);
      if (body.probeKeys !== undefined) {
        const customKeys = await loadCustomProbeKeys(session.tenantDbName, existing.projectId);
        const probeKeys = sanitizeProbeKeys(body.probeKeys, customKeys);
        if (!probeKeys) {
          return reply.code(400).send({ error: 'probeKeys must reference built-in or existing custom probes' });
        }
        data.probeKeys = probeKeys;
      }
      // A version number belongs to one agent: moving the campaign to another agent without naming a version
      // puts it back on the published one, as the form does.
      const agentMoved = isAgent && data.agentKey !== undefined && data.agentKey !== existing.agentKey;
      const nextRevision = revision.revision ?? (agentMoved ? 'published' : undefined);
      // Validate the state the PATCH leaves behind, not just the fields it
      // sends: enabling a schedule on a draft-default campaign is as wrong as
      // setting the draft on a scheduled one.
      if (isAgent && (nextRevision !== undefined || data.schedule !== undefined)) {
        const draftError = scheduledDraftError(
          data.schedule !== undefined ? data.schedule ?? undefined : existing.schedule,
          nextRevision ?? storedAgentRevision(existing.agentVersion),
        );
        if (draftError) return reply.code(400).send({ error: draftError });
      }
      // Only an agent campaign has a revision to store.
      if (isAgent && nextRevision !== undefined) data.agentVersion = toStoredAgentVersion(nextRevision);
      const campaign = await updateCampaign(session.tenantDbName, id, session.userId, data);
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      return reply.code(200).send({ campaign });
    } catch (error) {
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
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
  // The optional body carries per-run overrides (turns, concurrency, probes, judge,
  // agentVersion: "published" | "draft" | a version number).
  app.post('/redteam/campaigns/:key/scan', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      // The body is optional, as on the evaluation run; one that is sent must parse.
      let body: Record<string, unknown>;
      try {
        body = readOptionalJsonObjectBody(request);
      } catch {
        return reply.code(400).send({ error: 'Request body must be a JSON object' });
      }
      const customKeys = await loadCustomProbeKeys(session.tenantDbName, projectId);
      const optionsResult = sanitizeRunOptions(body, customKeys);
      if ('error' in optionsResult) return reply.code(400).send({ error: optionsResult.error });
      const run = await enqueueCampaignRun({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        campaignKey: key,
        options: optionsResult.options,
        // Asked by the service once it knows the campaign targets an agent, before a run row exists.
        authorizeAgentRun: () => requireAgentTestAccess(request),
      });
      return reply.code(202).send({ run, status: 'pending' });
    } catch (error) {
      // Before the message checks below: a refusal must never be read as a 404 or a 409.
      const refused = sendAgentTestRefusal(reply, error);
      if (refused) return refused;
      logger.error('Run red-team scan error', { error });
      if (error instanceof AgentRevisionError) {
        return reply.code(400).send({ error: error.message });
      }
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
      const viewer = { tenantDbName: session.tenantDbName, viewerUserId: session.userId };
      const shown = [];
      for (const run of runs) shown.push(await withoutRestrictedAttempts(request, viewer, run));
      return reply.code(200).send({ runs: shown });
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
      return reply.code(200).send({ run: await withoutRestrictedAttempts(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, run) });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Baseline comparison ────────────────────────────────────────────
  app.get('/redteam/runs/:id/compare', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const { baseline } = (request.query ?? {}) as { baseline?: string };
      if (!baseline) return reply.code(400).send({ error: 'baseline run id is required' });
      const comparison = await compareRuns(session.tenantDbName, id, baseline);
      if (!comparison) return reply.code(404).send({ error: 'Run or baseline not found' });
      return reply.code(200).send({ comparison });
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
      return reply.code(200).send({ run: await withoutRestrictedAttempts(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, run) });
    } catch (error) {
      logger.error('Review red-team attempt error', { error });
      return internalError(reply, error);
    }
  }));

  // ── Custom probes ──────────────────────────────────────────────────
  app.get('/redteam/custom-probes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const probes = await listCustomProbes(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ probes });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/redteam/custom-probes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      const result = sanitizeCustomProbe(body);
      if ('error' in result) return reply.code(400).send({ error: result.error });
      const probe = await createCustomProbe(session.tenantDbName, session.tenantId, session.userId, {
        ...result.input,
        projectId,
      });
      return reply.code(201).send({ probe });
    } catch (error) {
      if (error instanceof CustomProbeError) return reply.code(400).send({ error: error.message });
      logger.error('Create custom probe error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const probe = await getCustomProbe(session.tenantDbName, id);
      if (!probe) return reply.code(404).send({ error: 'Custom probe not found' });
      return reply.code(200).send({ probe });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const result = sanitizeCustomProbe(body);
      if ('error' in result) return reply.code(400).send({ error: result.error });
      // The sanitizer fills in the create-time detectors when the body has none; a PATCH keeps the stored ones.
      const { detectors, ...input } = result.input;
      const probe = await updateCustomProbe(session.tenantDbName, id, session.userId, {
        ...input,
        ...(body.detectors !== undefined ? { detectors } : {}),
        // `null` puts the create-time default back (see updateCustomProbe).
        ...(body.description === null ? { description: null } : {}),
        ...(body.family === null ? { family: null } : {}),
      });
      if (!probe) return reply.code(404).send({ error: 'Custom probe not found' });
      return reply.code(200).send({ probe });
    } catch (error) {
      if (error instanceof CustomProbeError) return reply.code(400).send({ error: error.message });
      logger.error('Update custom probe error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteCustomProbe(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Custom probe not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));
};
