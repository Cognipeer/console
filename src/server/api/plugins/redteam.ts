/**
 * Red-team dashboard API plugin (session-authenticated, `/api/redteam/*`).
 *
 * Authoring + operating surface for the console UI: probe catalog, campaign
 * CRUD, async scan trigger, run history, scan cancel, and the human-in-the-loop
 * review endpoint that overrides a machine verdict (and recomputes the aggregate).
 */

import { enforceServiceQuota, isQuotaExceededError, quotaExceededBody } from '@/lib/quota/serviceQuota';
import type { FastifyPluginAsync } from 'fastify';
import { createLogger } from '@/lib/core/logger';
import { BUILTIN_PROBE_KEYS, listProbeCatalog, validateCustomProbeDefinition } from '@/lib/services/redteam/probes';
import { isNamedDetectorKey } from '@/lib/services/redteam/detectors/named';
import { NAMED_DETECTOR_KEYS } from '@/lib/services/redteam/types';
import { ATTEMPT_ID_PATTERN, CUSTOM_PROBE_LIMITS, IMPORT_LIMITS } from '@/lib/services/redteam/limits';
import type { ImportProbeDraft } from '@/lib/services/redteam/import/types';
import { ATTEMPT_KEY_SEPARATOR } from '@/lib/services/redteam/attemptKey';
import { OWASP_LLM_CATEGORIES, isKnownOwaspCategory, normalizeOwaspCategory } from '@/lib/services/redteam/owasp';
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
  cancelRun,
  compareRuns,
  createCampaign,
  createCustomProbe,
  deleteCampaign,
  deleteCustomProbe,
  getCampaign,
  getBuiltinProbeDefinition,
  getCustomProbe,
  getOverview,
  importCustomProbes,
  getRun,
  listCampaigns,
  listCustomProbes,
  listRunsPage,
  reviewAttempt,
  updateCampaign,
  updateCustomProbe,
  validateCampaignInput,
  CustomProbeError,
  RedTeamConflictError,
  RedTeamForbiddenError,
  RedTeamNotFoundError,
  RedTeamValidationError,
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
import { restrictedKnowledgeReaderFor, withoutRestrictedAttempts } from '../restrictedKnowledgeRequest';
import { requireAgentTestAccess, sendAgentTestRefusal } from './agent-test-permission';
import { readClearableText, readRequiredText } from './partial-update';

const logger = createLogger('api:redteam');

const VALID_KINDS: RedTeamTargetKind[] = ['agent', 'model'];
const VALID_OUTCOMES: RedTeamOutcome[] = ['safe', 'vulnerable', 'needs_review'];
/** Page size of the run list: `default` when the caller names none, never more than `max`. */
const RUN_LIST_PAGE = { default: 25, max: 100 } as const;

/**
 * The service's typed errors keep their status: a bad value is a 400, a record
 * that is not there a 404, a refusal a 403 and a clash with the current state a
 * 409 (a custom probe still in use also lists who uses it).
 */
function sendServiceError(reply: import('fastify').FastifyReply, error: unknown) {
  if (error instanceof RedTeamValidationError || error instanceof CustomProbeError) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof RedTeamForbiddenError) return reply.code(403).send({ error: error.message });
  if (error instanceof RedTeamNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof RedTeamConflictError) {
    const usedBy = (error as { usedBy?: unknown }).usedBy;
    return reply.code(409).send({
      error: error.message,
      ...(Array.isArray(usedBy) && usedBy.length > 0 ? { usedBy } : {}),
    });
  }
  return null;
}

function internalError(reply: import('fastify').FastifyReply, error: unknown) {
  return (
    sendProjectContextError(reply, error)
    ?? sendServiceError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

/** A query value that must be a whole number; `undefined` when the caller sent none. */
function readQueryInteger(raw: unknown, name: string, min: number): { value?: number } | { error: string } {
  if (raw === undefined || raw === '') return {};
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return { error: `${name} must be an integer of at least ${min}` };
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < min) return { error: `${name} must be an integer of at least ${min}` };
  return { value: n };
}

/**
 * Campaigns, runs and custom probes are opened and changed in the caller's
 * active project: a record of another project answers like a missing one, and
 * owners and admins reach it by switching to its project. Rows stored before
 * records carried a projectId stay reachable.
 */
function inActiveProject<T extends { projectId?: string | null }>(record: T | null, projectId: string): T | null {
  if (!record) return null;
  if (!record.projectId) return record;
  return String(record.projectId) === String(projectId) ? record : null;
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
  return [...new Set(keys)];
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
  const enabled = s.enabled !== false;
  // A schedule that is switched off keeps whatever expression it was saved with; only an unusable one is refused.
  if (!enabled && s.cron.length > 120) return { error: 'schedule.cron is too long' };
  const cronError = validateCron(s.cron, enabled ? {} : { minInterval: false });
  if (cronError) return { error: cronError };
  return { schedule: { cron: s.cron, enabled } };
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
    options.probeKeys = [...new Set(keys)];
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

interface CampaignKnobs {
  runConfig?: { concurrency?: number; maxOutputTokens?: number };
  policy?: NonNullable<IRedTeamCampaign['policy']>;
}
type CampaignKnobsResult = CampaignKnobs | { error: string };

/**
 * The shape of a campaign's `runConfig` and `policy`. Only types are checked here (so what reaches the service
 * has the right form); the ranges are the service's to decide (validateCampaignInput).
 */
function sanitizeCampaignKnobs(body: Record<string, unknown>): CampaignKnobsResult {
  const out: CampaignKnobs = {};
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (body.runConfig !== undefined) {
    if (!isObject(body.runConfig)) return { error: 'runConfig must be an object' };
    const runConfig: { concurrency?: number; maxOutputTokens?: number } = {};
    for (const key of ['concurrency', 'maxOutputTokens'] as const) {
      const value = body.runConfig[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `runConfig.${key} must be a number` };
      runConfig[key] = value;
    }
    out.runConfig = runConfig;
  }
  if (body.policy !== undefined) {
    if (!isObject(body.policy)) return { error: 'policy must be an object' };
    const policy: NonNullable<IRedTeamCampaign['policy']> = {};
    const { deterministicConfidence, reviewBand, maxJudgeVariance } = body.policy;
    if (deterministicConfidence !== undefined) {
      if (typeof deterministicConfidence !== 'number' || !Number.isFinite(deterministicConfidence)) {
        return { error: 'policy.deterministicConfidence must be a number' };
      }
      policy.deterministicConfidence = deterministicConfidence;
    }
    if (reviewBand !== undefined) {
      if (
        !Array.isArray(reviewBand) || reviewBand.length !== 2
        || reviewBand.some((n) => typeof n !== 'number' || !Number.isFinite(n))
      ) {
        return { error: 'policy.reviewBand must be a pair of numbers [low, high]' };
      }
      policy.reviewBand = [reviewBand[0], reviewBand[1]];
    }
    if (maxJudgeVariance !== undefined) {
      if (typeof maxJudgeVariance !== 'number' || !Number.isFinite(maxJudgeVariance)) {
        return { error: 'policy.maxJudgeVariance must be a number' };
      }
      policy.maxJudgeVariance = maxJudgeVariance;
    }
    out.policy = policy;
  }
  return out;
}

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
  const L = CUSTOM_PROBE_LIMITS;
  if (typeof body.name !== 'string' || body.name.trim() === '') return { error: 'name is required' };
  // The 2025 keys, and the earlier ones they replace: a probe is stored under the 2025 key either way.
  if (typeof body.category !== 'string' || !isKnownOwaspCategory(body.category)) {
    return { error: `category must be one of: ${OWASP_LLM_CATEGORIES.join(', ')}` };
  }
  if (!VALID_SEVERITIES.includes(body.severity as RedTeamSeverity)) {
    return { error: 'severity must be "low", "medium", "high", or "critical"' };
  }
  if (!Array.isArray(body.attempts) || body.attempts.length === 0) {
    return { error: 'attempts must be a non-empty array' };
  }
  if (body.attempts.length > L.maxAttempts) {
    return { error: `a custom probe may have at most ${L.maxAttempts} attempts` };
  }
  const attempts: IRedTeamCustomAttempt[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < body.attempts.length; i += 1) {
    const a = body.attempts[i] as Record<string, unknown>;
    if (!a || typeof a !== 'object') return { error: `attempt ${i + 1} must be an object` };
    const turns = Array.isArray(a.turns) ? a.turns.filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [];
    if (turns.length === 0) return { error: `attempt ${i + 1} needs at least one non-empty turn` };
    if (turns.length > L.maxTurnsPerAttempt) {
      return { error: `attempt ${i + 1} may have at most ${L.maxTurnsPerAttempt} turns` };
    }
    if (turns.some((t) => t.length > L.maxTurnChars)) {
      return { error: `attempt ${i + 1}: a turn may be at most ${L.maxTurnChars} characters` };
    }
    const id = typeof a.id === 'string' && a.id.trim() ? a.id.trim() : `attempt-${i + 1}`;
    if (!ATTEMPT_ID_PATTERN.test(id)) {
      return { error: `attempt ${i + 1}: id may use letters, digits, ".", "_" and "-" only, up to ${L.maxAttemptIdLength} characters` };
    }
    if (seenIds.has(id)) return { error: `attempt id "${id}" is used more than once; ids must be unique within the probe` };
    seenIds.add(id);
    const system = typeof a.system === 'string' ? a.system : undefined;
    if (system && system.length > L.maxSystemChars) {
      return { error: `attempt ${i + 1}: system may be at most ${L.maxSystemChars} characters` };
    }
    const objective = typeof a.objective === 'string' ? a.objective : undefined;
    if (objective && objective.length > L.maxObjectiveChars) {
      return { error: `attempt ${i + 1}: objective may be at most ${L.maxObjectiveChars} characters` };
    }
    let history: IRedTeamCustomAttempt['history'];
    if (a.history !== undefined && a.history !== null) {
      if (!Array.isArray(a.history)) return { error: `attempt ${i + 1}: history must be a list of messages` };
      if (a.history.length > L.maxHistoryMessages) {
        return { error: `attempt ${i + 1}: history may have at most ${L.maxHistoryMessages} messages` };
      }
      history = [];
      for (const m of a.history as unknown[]) {
        const message = m as Record<string, unknown> | null;
        if (!message || typeof message !== 'object' || (message.role !== 'user' && message.role !== 'assistant')) {
          return { error: `attempt ${i + 1}: each history message needs a role of "user" or "assistant"` };
        }
        if (typeof message.content !== 'string' || !message.content.trim()) {
          return { error: `attempt ${i + 1}: each history message needs text` };
        }
        if (message.content.length > L.maxTurnChars) {
          return { error: `attempt ${i + 1}: a history message may be at most ${L.maxTurnChars} characters` };
        }
        history.push({ role: message.role, content: message.content });
      }
    }
    attempts.push({
      id,
      turns,
      system,
      canary: typeof a.canary === 'string' ? a.canary : undefined,
      forbiddenPatterns: Array.isArray(a.forbiddenPatterns)
        ? a.forbiddenPatterns.filter((p): p is string => typeof p === 'string')
        : undefined,
      refusalExpected: typeof a.refusalExpected === 'boolean' ? a.refusalExpected : undefined,
      adaptive: typeof a.adaptive === 'boolean' ? a.adaptive : undefined,
      objective,
      ...(history && history.length > 0 ? { history } : {}),
    });
  }
  if (body.polarity !== undefined && body.polarity !== 'attack' && body.polarity !== 'over-refusal') {
    return { error: 'polarity must be "attack" or "over-refusal"' };
  }
  const polarity = body.polarity as 'attack' | 'over-refusal' | undefined;
  let clonedFrom: CustomProbeInput['clonedFrom'];
  if (body.clonedFrom !== undefined && body.clonedFrom !== null) {
    const c = body.clonedFrom as Record<string, unknown>;
    if (typeof c !== 'object' || typeof c.probeKey !== 'string' || !BUILTIN_PROBE_KEYS.includes(c.probeKey)) {
      return { error: 'clonedFrom.probeKey must be the key of a built-in probe' };
    }
    if (typeof c.version !== 'number' || !Number.isInteger(c.version) || c.version < 1) {
      return { error: 'clonedFrom.version must be a positive integer' };
    }
    clonedFrom = { probeKey: c.probeKey, version: c.version };
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
  if (judges.length > L.maxJudges) return { error: `a custom probe may have at most ${L.maxJudges} judge lenses` };
  if (judges.some((j) => j.rubric.length > L.maxRubricChars)) {
    return { error: `a judge rubric may be at most ${L.maxRubricChars} characters` };
  }
  let named: string[] = [];
  if (rawDetectors.named !== undefined && rawDetectors.named !== null) {
    if (!Array.isArray(rawDetectors.named) || rawDetectors.named.some((n) => typeof n !== 'string')) {
      return { error: 'detectors.named must be a list of named detector keys' };
    }
    named = rawDetectors.named as string[];
    const unknown = named.find((n) => !isNamedDetectorKey(n));
    if (unknown !== undefined) return { error: `named detector "${unknown}" is not known; use one of ${NAMED_DETECTOR_KEYS.join(', ')}` };
    if (named.length > L.maxNamedDetectors) {
      return { error: `a custom probe may have at most ${L.maxNamedDetectors} named detectors` };
    }
  }
  const detectors: IRedTeamCustomDetectors = {
    refusal: rawDetectors.refusal !== false,
    // An over-refusal probe only looks at the refusal; the pattern detector stays off unless asked for.
    pattern: polarity === 'over-refusal' ? rawDetectors.pattern === true : rawDetectors.pattern !== false,
    judges,
    ...(named.length > 0 ? { named } : {}),
  };
  if (!detectors.refusal && !detectors.pattern && judges.length === 0 && named.length === 0) {
    return { error: 'select at least one detector (refusal, pattern, a named detector, or a judge lens)' };
  }
  return {
    input: {
      name: body.name.trim(),
      // Optional fields only when the body carries them, so a PATCH leaves the stored ones alone.
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      ...(typeof body.family === 'string' && body.family.trim() ? { family: body.family.trim() } : {}),
      category: normalizeOwaspCategory(body.category),
      severity: body.severity as RedTeamSeverity,
      attempts,
      detectors,
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(polarity ? { polarity } : {}),
      ...(clonedFrom ? { clonedFrom } : {}),
    },
  };
}

/** The source fields an import draft may carry; the service checks lengths and the link. */
function sanitizeImportSource(raw: unknown): ImportProbeDraft['source'] {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    name: typeof src.name === 'string' ? src.name : '',
    ...(text(src.format) ? { format: text(src.format) } : {}),
    ...(text(src.license) ? { license: text(src.license) } : {}),
    ...(text(src.attribution) ? { attribution: text(src.attribution) } : {}),
    ...(text(src.url) ? { url: text(src.url) } : {}),
    ...(text(src.fileName) ? { fileName: text(src.fileName) } : {}),
  };
}

/**
 * The probe definition's own rules (canary planting, pattern bounds, ...). On a PATCH the stored attempts are
 * passed too, so an attempt whose patterns did not change is not held to rules added after it was saved.
 */
function definitionError(
  input: Pick<CustomProbeInput, 'category' | 'attempts' | 'polarity'>,
  detectors: IRedTeamCustomDetectors,
  storedAttempts?: IRedTeamCustomAttempt[],
): string | null {
  try {
    validateCustomProbeDefinition(
      { category: input.category, attempts: input.attempts, detectors, polarity: input.polarity },
      storedAttempts,
    );
    return null;
  } catch (error) {
    if (error instanceof CustomProbeError || error instanceof RedTeamValidationError) return error.message;
    throw error;
  }
}

export const redTeamApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Probe catalog (built-in + tenant custom probes) ────────────────
  app.get('/redteam/probes', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const customProbes = await listCustomProbes(session.tenantDbName, { projectId });
      const disabledProbes = customProbes
        .filter((def) => def.enabled === false)
        .map((def) => ({ key: def.key, name: def.name }));
      return reply.code(200).send({ probes: listProbeCatalog(customProbes), disabledProbes });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // The code-defined definition of one built-in probe (what "Clone" starts from).
  app.get('/redteam/probes/builtin/:key', withApiRequestContext(async (request, reply) => {
    try {
      await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const probe = getBuiltinProbeDefinition(key);
      if (!probe) return reply.code(404).send({ error: 'Probe not found' });
      return reply.code(200).send({ probe });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── OWASP overview ─────────────────────────────────────────────────
  app.get('/redteam/overview', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { limit?: string };
      const limit = readQueryInteger(query.limit, 'limit', 1);
      if ('error' in limit) return reply.code(400).send({ error: limit.error });
      const overview = await getOverview(session.tenantDbName, {
        projectId,
        limit: limit.value !== undefined ? Math.min(limit.value, 500) : undefined,
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
      const limit = readQueryInteger(query.limit, 'limit', 1);
      if ('error' in limit) return reply.code(400).send({ error: limit.error });
      const report = await buildComplianceReport(session.tenantDbName, new Date(), {
        projectId,
        limit: limit.value !== undefined ? Math.min(limit.value, 500) : undefined,
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
      const knobs = sanitizeCampaignKnobs(body);
      if ('error' in knobs) return reply.code(400).send({ error: knobs.error });
      const sched = sanitizeSchedule(body.schedule);
      if ('error' in sched) return reply.code(400).send({ error: sched.error });
      const comp = sanitizeCompliance(body.compliance);
      if ('error' in comp) return reply.code(400).send({ error: comp.error });
      const revision = parseAgentRevision(body.agentVersion);
      if (!revision.ok) return reply.code(400).send({ error: revision.error });
      const isAgent = body.targetKind === 'agent';
      const draftError = isAgent ? scheduledDraftError(sched.schedule, revision.revision ?? 'published') : null;
      if (draftError) return reply.code(400).send({ error: draftError });
      // Ranges and limits (concurrency, output tokens, decision policy, probe count): a RedTeamValidationError is a 400.
      await validateCampaignInput({ probeKeys, runConfig: knobs.runConfig, policy: knobs.policy });
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
        runConfig: knobs.runConfig,
        policy: knobs.policy,
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const campaign = inActiveProject(await getCampaign(session.tenantDbName, id), projectId);
      if (!campaign) return reply.code(404).send({ error: 'Campaign not found' });
      return reply.code(200).send({ campaign });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/redteam/campaigns/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
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
      const knobs = sanitizeCampaignKnobs(body);
      if ('error' in knobs) return reply.code(400).send({ error: knobs.error });
      if (knobs.runConfig !== undefined) data.runConfig = knobs.runConfig;
      if (knobs.policy !== undefined) data.policy = knobs.policy;
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
      const existing = inActiveProject(await getCampaign(session.tenantDbName, id), projectId);
      if (!existing) return reply.code(404).send({ error: 'Campaign not found' });
      const isAgent = existing.targetKind === 'agent';
      // The stored kind decides, not the body: a PATCH cannot move a campaign between kinds, and a saved
      // campaign can run the agent later on its schedule.
      if (isAgent) await requireAgentTestAccess(request);
      if (body.probeKeys !== undefined) {
        const customKeys = await loadCustomProbeKeys(session.tenantDbName, projectId);
        const probeKeys = sanitizeProbeKeys(body.probeKeys, customKeys);
        if (!probeKeys) {
          return reply.code(400).send({ error: 'probeKeys must reference built-in or existing custom probes' });
        }
        data.probeKeys = probeKeys;
      }
      await validateCampaignInput({ probeKeys: data.probeKeys, runConfig: data.runConfig, policy: data.policy });
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
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!inActiveProject(await getCampaign(session.tenantDbName, id), projectId)) {
        return reply.code(404).send({ error: 'Campaign not found' });
      }
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
      await enforceServiceQuota(
        { tenantDbName: session.tenantDbName, tenantId: session.tenantId, projectId },
        { domain: 'jobs', resourceKey: 'redteam', cost: { requests: 1 } },
      );
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
      if (isQuotaExceededError(error)) return reply.code(429).send(quotaExceededBody(error));
      logger.error('Run red-team scan error', { error });
      const typed = sendServiceError(reply, error);
      if (typed) return typed;
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
      const limit = readQueryInteger(query.limit, 'limit', 1);
      if ('error' in limit) return reply.code(400).send({ error: limit.error });
      const skip = readQueryInteger(query.skip, 'skip', 0);
      if ('error' in skip) return reply.code(400).send({ error: skip.error });
      const { runs, total } = await listRunsPage(session.tenantDbName, {
        projectId,
        campaignKey: typeof query.campaignKey === 'string' ? query.campaignKey : undefined,
        limit: Math.min(limit.value ?? RUN_LIST_PAGE.default, RUN_LIST_PAGE.max),
        skip: skip.value ?? 0,
      });
      const viewer = { tenantDbName: session.tenantDbName, viewerUserId: session.userId };
      const shown = [];
      for (const run of runs) shown.push(await withoutRestrictedAttempts(request, viewer, run));
      return reply.code(200).send({ runs: shown, total });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/redteam/runs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const run = inActiveProject(await getRun(session.tenantDbName, id), projectId);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run: await withoutRestrictedAttempts(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, run) });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Baseline comparison ────────────────────────────────────────────
  app.get('/redteam/runs/:id/compare', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const { baseline } = (request.query ?? {}) as { baseline?: string };
      if (!baseline) return reply.code(400).send({ error: 'baseline run id is required' });
      const [current, base] = await Promise.all([getRun(session.tenantDbName, id), getRun(session.tenantDbName, baseline)]);
      if (!inActiveProject(current, projectId) || !inActiveProject(base, projectId)) {
        return reply.code(404).send({ error: 'Run or baseline not found' });
      }
      const comparison = await compareRuns(session.tenantDbName, id, baseline);
      if (!comparison) return reply.code(404).send({ error: 'Run or baseline not found' });
      return reply.code(200).send({ comparison });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Cancel ─────────────────────────────────────────────────────────
  // A pending run is cancelled on the spot; a running one is asked to stop and ends as `cancelled` with what
  // finished. Same permission as starting a scan (POST under /redteam). A finished run answers 409.
  app.post('/redteam/runs/:id/cancel', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!inActiveProject(await getRun(session.tenantDbName, id), projectId)) {
        return reply.code(404).send({ error: 'Run not found' });
      }
      const run = await cancelRun(session.tenantDbName, id, session.userId);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      return reply.code(200).send({ run: await withoutRestrictedAttempts(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }, run) });
    } catch (error) {
      logger.error('Cancel red-team run error', { error });
      return internalError(reply, error);
    }
  }));

  // ── HITL review ────────────────────────────────────────────────────
  // The attempt is named by `attemptKey` (`<probeKey>::<attemptId>`) in the body, or by the path segment, which
  // takes a key or a bare attempt id. A bare id that two probes share is refused with 409.
  app.post('/redteam/runs/:id/attempts/:attemptId/review', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id, attemptId: pathAttempt } = request.params as { id: string; attemptId: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      if (!VALID_OUTCOMES.includes(body.outcome as RedTeamOutcome)) {
        return reply.code(400).send({ error: 'outcome must be "safe", "vulnerable", or "needs_review"' });
      }
      for (const field of ['attemptKey', 'attemptId'] as const) {
        if (body[field] !== undefined && (typeof body[field] !== 'string' || !(body[field] as string).trim())) {
          return reply.code(400).send({ error: `${field} must be a non-empty string` });
        }
      }
      const fromPath = typeof pathAttempt === 'string' && pathAttempt.trim() ? pathAttempt.trim() : undefined;
      const ref: { attemptKey?: string; attemptId?: string } = {};
      if (typeof body.attemptKey === 'string') ref.attemptKey = body.attemptKey.trim();
      else if (typeof body.attemptId === 'string') ref.attemptId = body.attemptId.trim();
      else if (fromPath && fromPath.includes(ATTEMPT_KEY_SEPARATOR)) ref.attemptKey = fromPath;
      else if (fromPath) ref.attemptId = fromPath;
      if (!ref.attemptKey && !ref.attemptId) {
        return reply.code(400).send({ error: 'attemptKey or attemptId is required' });
      }
      if (!inActiveProject(await getRun(session.tenantDbName, id), projectId)) {
        return reply.code(404).send({ error: 'Run not found' });
      }
      const run = await reviewAttempt(session.tenantDbName, id, ref, {
        outcome: body.outcome as RedTeamOutcome,
        note: typeof body.note === 'string' ? body.note : undefined,
        reviewedBy: session.userId,
      }, restrictedKnowledgeReaderFor(request, { tenantDbName: session.tenantDbName, viewerUserId: session.userId }));
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
      const invalid = definitionError(result.input, result.input.detectors);
      if (invalid) return reply.code(400).send({ error: invalid });
      const probe = await createCustomProbe(session.tenantDbName, session.tenantId, session.userId, {
        ...result.input,
        projectId,
      });
      return reply.code(201).send({ probe });
    } catch (error) {
      logger.error('Create custom probe error', { error });
      return internalError(reply, error);
    }
  }));

  // Drafts made in the browser from a file (see redteam/import); every one is validated before any is stored.
  app.post('/redteam/custom-probes/import', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (!Array.isArray(body.probes) || body.probes.length === 0) {
        return reply.code(400).send({ error: 'probes must list at least one probe' });
      }
      if (body.probes.length > IMPORT_LIMITS.maxProbesPerImport) {
        return reply.code(400).send({ error: `an import can create at most ${IMPORT_LIMITS.maxProbesPerImport} probes` });
      }
      const drafts: ImportProbeDraft[] = [];
      for (let i = 0; i < body.probes.length; i += 1) {
        const raw = body.probes[i] as Record<string, unknown>;
        const label = `probe ${i + 1}${raw && typeof raw.name === 'string' && raw.name ? ` ("${raw.name}")` : ''}`;
        if (!raw || typeof raw !== 'object') return reply.code(400).send({ error: `probe ${i + 1} must be an object` });
        const result = sanitizeCustomProbe(raw);
        if ('error' in result) return reply.code(400).send({ error: `${label}: ${result.error}` });
        const { input } = result;
        const invalid = definitionError(input, input.detectors);
        if (invalid) return reply.code(400).send({ error: `${label}: ${invalid}` });
        drafts.push({
          name: input.name,
          description: input.description ?? '',
          family: input.family ?? 'imported',
          category: input.category as ImportProbeDraft['category'],
          severity: input.severity,
          polarity: input.polarity ?? 'attack',
          attempts: input.attempts,
          detectors: input.detectors,
          source: sanitizeImportSource(raw.source),
        });
      }
      const probes = await importCustomProbes(session.tenantDbName, {
        tenantId: session.tenantId,
        projectId,
        createdBy: session.userId,
        drafts,
      });
      return reply.code(201).send({ probes });
    } catch (error) {
      logger.error('Import custom probes error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const probe = inActiveProject(await getCustomProbe(session.tenantDbName, id), projectId);
      if (!probe) return reply.code(404).send({ error: 'Custom probe not found' });
      return reply.code(200).send({ probe });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      // The list's Enabled switch sends only `{ enabled }`: that toggles the probe without a full definition.
      const bodyKeys = Object.keys(body);
      if (bodyKeys.length === 1 && bodyKeys[0] === 'enabled') {
        if (typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled must be a boolean' });
        if (!inActiveProject(await getCustomProbe(session.tenantDbName, id), projectId)) {
          return reply.code(404).send({ error: 'Custom probe not found' });
        }
        const toggled = await updateCustomProbe(session.tenantDbName, id, session.userId, { enabled: body.enabled });
        if (!toggled) return reply.code(404).send({ error: 'Custom probe not found' });
        return reply.code(200).send({ probe: toggled });
      }
      const result = sanitizeCustomProbe(body);
      if ('error' in result) return reply.code(400).send({ error: result.error });
      const stored = inActiveProject(await getCustomProbe(session.tenantDbName, id), projectId);
      if (!stored) return reply.code(404).send({ error: 'Custom probe not found' });
      const invalid = definitionError(
        { ...result.input, polarity: result.input.polarity ?? stored.polarity },
        body.detectors !== undefined ? result.input.detectors : stored.detectors,
        stored.attempts,
      );
      if (invalid) return reply.code(400).send({ error: invalid });
      // The sanitizer fills in the create-time detectors when the body has none; a PATCH keeps the stored ones.
      // A clone's lineage is set when it is created and never changed.
      const { detectors, clonedFrom: _clonedFrom, ...input } = result.input;
      void _clonedFrom;
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
      logger.error('Update custom probe error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/redteam/custom-probes/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const { force } = (request.query ?? {}) as { force?: string };
      if (!inActiveProject(await getCustomProbe(session.tenantDbName, id), projectId)) {
        return reply.code(404).send({ error: 'Custom probe not found' });
      }
      // A probe campaigns still select is kept (409 with who uses it) unless the caller says ?force=true.
      const { deleted, usedBy } = await deleteCustomProbe(session.tenantDbName, id, { force: force === 'true' });
      if (!deleted && usedBy.length > 0) {
        return reply.code(409).send({
          error: `This probe is used by ${usedBy.length} ${usedBy.length === 1 ? 'campaign' : 'campaigns'}; pass force=true to delete it anyway`,
          usedBy,
        });
      }
      if (!deleted) return reply.code(404).send({ error: 'Custom probe not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));
};
