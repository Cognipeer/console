/**
 * Red-team service — tenant-scoped CRUD over campaigns + runs, plus the run
 * orchestration that loads a campaign, builds live invokers, drives the pure
 * engine runner, and persists the attempts + aggregate.
 *
 * `executeRun` is shared by the synchronous path (`runCampaign`) and the async
 * queue job (see `campaignJob`), so both produce identical persisted results.
 * Target/judge invokers are injectable (RunCampaignDeps) for testability.
 *
 * Run lifecycle (one place, so every path agrees):
 *   create   inserts the run `pending`, then checks it is the oldest live run of
 *            its campaign (a loser deletes its own row and reports the conflict);
 *   claim    `pending -> running` is one compare-and-set, so a queue retry of a
 *            run somebody else started does nothing;
 *   run      a heartbeat renews the lease; a stop request (cancel) or a lost
 *            claim ends the scan between attempts;
 *   finish   one compare-and-set from `running` by the same worker;
 *   reaper   ends a run whose lease ran out (a crashed worker) or that never started.
 * Each attempt is stored as its own row as it finishes (see IRedTeamRunAttempt),
 * so a scan of hundreds of attempts never rewrites one growing document.
 */

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { assertServiceEnabled, ServiceDisabledError } from '@/lib/services/availability/serviceAvailability';
import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type {
  AgentRevision,
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamRunAttempt,
  IRedTeamAttemptResult,
  IRedTeamAggregate,
  IRedTeamPolicyConfig,
  IRedTeamSignal,
  IRedTeamCustomProbe,
  IRedTeamCustomAttempt,
  IRedTeamCustomDetectors,
  IRedTeamProbeSource,
  RedTeamInconclusiveReason,
  RedTeamOutcome,
  RedTeamRunStatus,
  RedTeamSeverity,
  RedTeamTargetKind,
} from '@/lib/database';
import { runRedTeam } from './runner';
import {
  buildProbesLenient,
  CUSTOM_PROBE_PREFIX,
  validateCustomProbe,
  validateCustomProbeDefinition,
  validateCustomProbePatterns,
  CustomProbeError,
  builtinProbeDefinition,
  type BuiltinProbeDefinition,
} from './probes';
import type { ImportProbeDraft } from './import/types';
import { compareRedTeamRuns, type RedTeamComparison } from './compare';
import { mapOwaspToEu, EU_RISK_CATEGORIES, type EuRiskCategory } from './euTaxonomy';
import type { CampaignComplianceMeta } from './compliance/types';
import {
  buildAttackerInvoker,
  buildJudgeInvoker,
  buildTargetInvoker,
  type RedTeamModelContext,
  type RedTeamTargetSpec,
} from './adapters';
import type { AttemptResult, DetectionSignal, Probe } from './types';
import { computeAggregate, isFailedAttempt } from './aggregate';
import { attemptKeyOf, parseAttemptKey } from './attemptKey';
import {
  ATTEMPT_ID_PATTERN,
  CUSTOM_PROBE_LIMITS,
  IMPORT_LIMITS,
  RUN_LIFECYCLE,
  RUN_LIMITS,
  clampConcurrency,
  clampMaxOutputTokens,
  truncateText,
} from './limits';
import { isKnownOwaspCategory, normalizeOwaspCategory } from './owasp';
import { KnowledgeExposure, runWithKnowledgeExposure } from '@/lib/services/rag/access/exposure';
import { sameAgentRevision, agentRevisionLabel, storedAgentRevision } from '@/lib/shared/agentRevision';
import {
  AgentRevisionError,
  assertAgentRevisionRunnable,
  startAgentRevision,
  type StartedAgentRevision,
} from '@/lib/services/agents/agentRevision';

const logger = createLogger('redteam:service');

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;
/** The family a custom probe gets when none is given. */
const DEFAULT_CUSTOM_PROBE_FAMILY = 'custom';
/** Rows written per call when a whole run is stored at its end. */
const ATTEMPT_ROW_BATCH = 100;
/** Longest error text stored on a run. */
const MAX_ERROR_CHARS = 300;
/** Longest error text stored on one attempt. */
const MAX_ATTEMPT_ERROR_CHARS = 1000;
/** Runs read when looking for a campaign's live runs. */
const LIVE_RUN_SCAN = 50;

export { computeAggregate };

type Db = Awaited<ReturnType<typeof getDatabase>>;

export type WithId<T> = Omit<T, '_id'> & { id: string };

// ── Errors the routes map to status codes ────────────────────────────────────

/** The request conflicts with the current state of a record (HTTP 409). */
export class RedTeamConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedTeamConflictError';
  }
}

/** The input cannot be accepted as given (HTTP 400). */
export class RedTeamValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedTeamValidationError';
  }
}

/** The caller may not read or change this (HTTP 403). */
export class RedTeamForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedTeamForbiddenError';
  }
}

/** A record the request names does not exist (HTTP 404). */
export class RedTeamNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedTeamNotFoundError';
  }
}

function toView<T extends { _id?: string | object }>(record: T): WithId<T> {
  const { _id, ...rest } = record as T & { _id?: unknown };
  const id =
    typeof _id === 'string'
      ? _id
      : _id && typeof (_id as { toString?: () => string }).toString === 'function'
        ? (_id as { toString: () => string }).toString()
        : '';
  return { ...(rest as Omit<T, '_id'>), id };
}

function runIdOf(run: IRedTeamRun): string {
  return typeof run._id === 'string' ? run._id : String(run._id ?? '');
}

async function generateUniqueKey(desired: string, exists: (key: string) => Promise<boolean>): Promise<string> {
  const base = slugify(desired?.trim() || 'campaign', SLUG_OPTIONS) || 'campaign';
  let candidate = base;
  let attempt = 0;
  while (attempt < MAX_KEY_ATTEMPTS) {
    if (!(await exists(candidate))) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
  throw new Error(`Could not generate a unique key for "${desired}"`);
}

/** Whether a database error says a unique key is already taken (MongoDB duplicate key, SQLite unique constraint). */
export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === 11000 || e.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return message.includes('E11000') || message.includes('UNIQUE constraint failed');
}

const MAX_CREATE_KEY_TRIES = 3;

/**
 * Create a record under a freshly generated key. Two creations that pick the same key at once
 * collide on the unique index: the loser takes a new key and tries again, a few times.
 */
async function createWithUniqueKey<T>(
  nextKey: () => Promise<string>,
  create: (key: string) => Promise<T>,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_CREATE_KEY_TRIES; attempt += 1) {
    const key = await nextKey();
    try {
      return await create(key);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  throw new RedTeamConflictError(`The ${what} could not be saved because its key kept being taken; try again.`);
}

/** "1 attempt was" / "3 attempts were". */
function attemptsWere(n: number): string {
  return `${n} ${n === 1 ? 'attempt was' : 'attempts were'}`;
}

function mapSignal(s: DetectionSignal): IRedTeamSignal {
  return {
    detectorKey: s.detectorKey,
    kind: s.kind,
    hit: s.hit,
    score: s.score,
    confidence: s.confidence,
    gate: s.gate,
    rationale: s.rationale,
    modelRef: s.modelRef,
    error: s.error,
  };
}

function mapAttempt(a: AttemptResult): IRedTeamAttemptResult {
  return {
    probeKey: a.probeKey,
    attemptId: a.attemptId,
    attemptKey: attemptKeyOf(a),
    family: a.family,
    category: a.category,
    severity: a.severity,
    outcome: a.outcome,
    decidedBy: a.verdict.decidedBy,
    confidence: a.verdict.confidence,
    transcript: a.transcript,
    signals: a.verdict.signals.map(mapSignal),
    latencyMs: a.latencyMs,
    error: a.error ? truncateText(a.error, MAX_ATTEMPT_ERROR_CHARS) : undefined,
    ...(a.partial ? { partial: true } : {}),
    ...(a.kbRestricted?.length ? { kbRestricted: a.kbRestricted } : {}),
    ...(a.polarity === 'over-refusal' ? { polarity: 'over-refusal' as const } : {}),
  };
}

// ── Attempt rows ─────────────────────────────────────────────────────────────

type AttemptRowInput = Omit<IRedTeamRunAttempt, '_id' | 'createdAt' | 'updatedAt'>;

/** One stored row for an attempt: the attempt, where it belongs, and its place in the run. */
function attemptRowOf(
  run: Pick<IRedTeamRun, 'tenantId' | 'projectId'>,
  runId: string,
  a: IRedTeamAttemptResult,
  seq: number,
): AttemptRowInput {
  return {
    ...a,
    attemptKey: a.attemptKey ?? attemptKeyOf(a),
    // A stored transcript is bounded; the judge and the detectors already read the full text.
    transcript: a.transcript.map((t) => ({
      user: truncateText(t.user, RUN_LIMITS.transcriptMessageChars),
      assistant: truncateText(t.assistant, RUN_LIMITS.transcriptMessageChars),
    })),
    tenantId: run.tenantId,
    projectId: run.projectId,
    runId,
    seq,
  };
}

const ROW_ONLY_FIELDS = ['_id', 'tenantId', 'projectId', 'runId', 'seq', 'createdAt', 'updatedAt'] as const;

/** A stored row as the attempt a view shows: the row's own bookkeeping is left off. */
function attemptOfRow(row: IRedTeamRunAttempt): IRedTeamAttemptResult {
  const out: Record<string, unknown> = { ...row };
  for (const field of ROW_ONLY_FIELDS) delete out[field];
  out.attemptKey = row.attemptKey || attemptKeyOf(row);
  return out as unknown as IRedTeamAttemptResult;
}

/**
 * Embedded attempts get a key each. Probes of older runs could repeat an attempt
 * id, so a repeat is numbered (`#2`) rather than collapsed into one row.
 */
function withUniqueKeys(attempts: IRedTeamAttemptResult[]): IRedTeamAttemptResult[] {
  const seen = new Map<string, number>();
  return attempts.map((a) => {
    const base = a.attemptKey ?? attemptKeyOf(a);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...a, attemptKey: n === 1 ? base : `${base}#${n}` };
  });
}

const ROW_PAGE = 500;

async function listAttemptRows(db: Db, runId: string): Promise<IRedTeamRunAttempt[]> {
  const rows: IRedTeamRunAttempt[] = [];
  for (let skip = 0; ; skip += ROW_PAGE) {
    const page = await db.listRedTeamRunAttempts(runId, { limit: ROW_PAGE, skip });
    rows.push(...page);
    if (page.length < ROW_PAGE) break;
  }
  return rows;
}

async function upsertRows(db: Db, rows: AttemptRowInput[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ATTEMPT_ROW_BATCH) {
    await db.upsertRedTeamRunAttempts(rows.slice(i, i + ATTEMPT_ROW_BATCH));
  }
}

/**
 * A run's attempts, in run order, each with its `attemptKey`: from the attempt
 * rows when the run keeps them (`attemptStore: 'collection'`), else the embedded
 * list of a run recorded before the rows existed.
 */
export async function loadRunAttempts(db: Db, run: IRedTeamRun): Promise<IRedTeamAttemptResult[]> {
  if (run.attemptStore === 'collection') {
    return (await listAttemptRows(db, runIdOf(run))).map(attemptOfRow);
  }
  return withUniqueKeys(run.attempts ?? []);
}

/** A run as the API shows it: its attempts filled in from whichever store it uses. */
async function viewOf(db: Db, run: IRedTeamRun): Promise<WithId<IRedTeamRun>> {
  return { ...toView(run), attempts: await loadRunAttempts(db, run) };
}

/**
 * Why a run's rates cannot be trusted. A run stored before reasons existed has
 * `inconclusive: true` and none: that meant judge errors.
 */
export function inconclusiveReasonsOf(aggregate: IRedTeamAggregate | undefined | null): RedTeamInconclusiveReason[] {
  if (!aggregate) return [];
  if (aggregate.inconclusiveReasons && aggregate.inconclusiveReasons.length > 0) return aggregate.inconclusiveReasons;
  return aggregate.inconclusive ? ['judge-errors'] : [];
}

// ── Safe errors ──────────────────────────────────────────────────────────────

/** Messages written for the person reading the run, which may be stored as they are. */
const USER_FACING_MESSAGE = [
  /^Agent ".{1,200}" not found$/,
  /^Version .{1,40} not found for agent ".{1,200}"$/,
  /^Model with key .{1,200} not found$/,
  /^Red-team campaign ".{1,200}" not found$/,
  /^campaign not found$/,
  /^timed out after \d+s$/,
];

/**
 * The text stored as a failed run's `error`: a short message, never a stack or a
 * provider payload. Errors written for the user (time limits, a missing campaign
 * or model, an agent revision, quota, a switched-off service) keep their message;
 * anything else says only what kind of failure it was. The full error goes to the
 * server log.
 */
export function safeRunError(err: unknown): string {
  const name = err instanceof Error
    ? err.name
    : typeof err === 'object' && err !== null ? String((err as { name?: unknown }).name ?? '') : '';
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const known =
    err instanceof AgentRevisionError
    || err instanceof ServiceDisabledError
    || err instanceof RedTeamNotFoundError
    || err instanceof RedTeamConflictError
    || err instanceof RedTeamValidationError
    || name === 'QuotaExceededError'
    || USER_FACING_MESSAGE.some((re) => re.test(message));
  if (known && message) return truncateText(message, MAX_ERROR_CHARS);
  return truncateText(`The scan failed: ${name && name !== 'Error' ? name : 'Error'}`, MAX_ERROR_CHARS);
}

function logError(err: unknown): unknown {
  return err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err;
}

// ── Campaign input limits ────────────────────────────────────────────────────

function numberIn(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RedTeamValidationError(`${label} must be a number between ${min} and ${max}`);
  }
  return value;
}

function validatePolicy(policy: unknown): IRedTeamPolicyConfig {
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new RedTeamValidationError('policy must be an object');
  }
  const p = policy as Record<string, unknown>;
  const out: IRedTeamPolicyConfig = {};
  if (p.deterministicConfidence !== undefined && p.deterministicConfidence !== null) {
    out.deterministicConfidence = numberIn(p.deterministicConfidence, 0.5, 1, 'policy.deterministicConfidence');
  }
  if (p.reviewBand !== undefined && p.reviewBand !== null) {
    const band = p.reviewBand;
    if (!Array.isArray(band) || band.length !== 2) {
      throw new RedTeamValidationError('policy.reviewBand must be a [low, high] pair');
    }
    const lo = numberIn(band[0], 0, 1, 'policy.reviewBand[0]');
    const hi = numberIn(band[1], 0, 1, 'policy.reviewBand[1]');
    if (lo > hi) throw new RedTeamValidationError('policy.reviewBand must have low <= high');
    out.reviewBand = [lo, hi];
  }
  if (p.maxJudgeVariance !== undefined && p.maxJudgeVariance !== null) {
    out.maxJudgeVariance = numberIn(p.maxJudgeVariance, 0, 1, 'policy.maxJudgeVariance');
  }
  return out;
}

type CampaignLimitsInput = {
  runConfig?: IRedTeamCampaign['runConfig'];
  policy?: IRedTeamCampaign['policy'];
  probeKeys?: string[];
};

/**
 * The campaign fields a scan's cost depends on, checked and normalised the same
 * way on create and on update: concurrency and the output-token cap are clamped
 * to their limits, the decision policy is range-checked (400 otherwise), and the
 * probe selection is deduplicated and bounded. A field that is absent stays
 * absent; the rest of the input is returned as given.
 */
export function validateCampaignInput<T extends CampaignLimitsInput>(input: T): T {
  const patch: CampaignLimitsInput = {};
  if (input.runConfig != null) {
    patch.runConfig = {
      ...(input.runConfig.concurrency !== undefined ? { concurrency: clampConcurrency(input.runConfig.concurrency) } : {}),
      ...(input.runConfig.maxOutputTokens !== undefined
        ? { maxOutputTokens: clampMaxOutputTokens(input.runConfig.maxOutputTokens) }
        : {}),
    };
  }
  if (input.policy != null) patch.policy = validatePolicy(input.policy);
  if (input.probeKeys !== undefined) {
    if (!Array.isArray(input.probeKeys) || input.probeKeys.some((k) => typeof k !== 'string' || !k.trim())) {
      throw new RedTeamValidationError('probeKeys must be a list of probe keys');
    }
    const keys = [...new Set(input.probeKeys)];
    if (keys.length > RUN_LIMITS.maxProbeKeysPerCampaign) {
      throw new RedTeamValidationError(`a campaign can select at most ${RUN_LIMITS.maxProbeKeysPerCampaign} probes`);
    }
    patch.probeKeys = keys;
  }
  return { ...input, ...patch };
}

// ── Campaign CRUD ────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  description?: string;
  targetKind: RedTeamTargetKind;
  agentKey?: string;
  /** Agent campaigns: the revision a scan attacks by default (absent / `null` = whatever is published). */
  agentVersion?: number | 'draft' | null;
  modelKey?: string;
  probeKeys?: string[];
  judgeModelKey?: string;
  runConfig?: IRedTeamCampaign['runConfig'];
  policy?: IRedTeamCampaign['policy'];
  schedule?: IRedTeamCampaign['schedule'];
  /** EU AI Act compliance classification of the system under test. */
  compliance?: CampaignComplianceMeta;
  projectId?: string;
}

/** Fold compliance metadata into a campaign's opaque `metadata` bag. */
function withCompliance(
  existing: Record<string, unknown> | undefined,
  compliance: CampaignComplianceMeta | undefined,
): Record<string, unknown> | undefined {
  if (compliance === undefined) return existing;
  return { ...(existing ?? {}), compliance };
}

export async function createCampaign(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  rawInput: CreateCampaignInput,
): Promise<WithId<IRedTeamCampaign>> {
  const input = validateCampaignInput(rawInput);
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const campaign = await createWithUniqueKey(
    () => generateUniqueKey(input.name, async (k) => !!(await db.findRedTeamCampaignByKey(k, input.projectId))),
    (key) => db.createRedTeamCampaign({
      tenantId,
      projectId: input.projectId,
      key,
      name: input.name,
      description: input.description,
      targetKind: input.targetKind,
      agentKey: input.agentKey,
      // Only an agent campaign has a revision; absent already means "published".
      ...(input.targetKind === 'agent' && input.agentVersion != null ? { agentVersion: input.agentVersion } : {}),
      modelKey: input.modelKey,
      probeKeys: input.probeKeys ?? [],
      judgeModelKey: input.judgeModelKey,
      runConfig: input.runConfig,
      policy: input.policy,
      schedule: input.schedule,
      metadata: withCompliance(undefined, input.compliance),
      createdBy,
    }),
    'campaign',
  );
  return toView(campaign);
}

export async function listCampaigns(
  tenantDbName: string,
  filters?: { projectId?: string; targetKind?: RedTeamTargetKind; search?: string },
): Promise<WithId<IRedTeamCampaign>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listRedTeamCampaigns(filters)).map(toView);
}

export async function getCampaign(tenantDbName: string, id: string): Promise<WithId<IRedTeamCampaign> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findRedTeamCampaignById(id);
  return record ? toView(record) : null;
}

/**
 * A campaign PATCH: a key that is absent leaves the stored value alone (never
 * pass `undefined` for it), and `null` clears the description, the judge model
 * or the schedule.
 */
export type UpdateCampaignInput = Partial<
  Pick<IRedTeamCampaign, 'name' | 'targetKind' | 'agentKey' | 'modelKey' | 'probeKeys' | 'agentVersion' | 'runConfig' | 'policy' | 'projectId'>
> & {
  description?: string | null;
  judgeModelKey?: string | null;
  schedule?: IRedTeamCampaign['schedule'] | null;
  compliance?: CampaignComplianceMeta;
};

export async function updateCampaign(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: UpdateCampaignInput,
): Promise<WithId<IRedTeamCampaign> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const { compliance, ...given } = data;
  const rest = validateCampaignInput(given);
  // Merge compliance into the existing metadata bag rather than replacing it.
  let metadata: Record<string, unknown> | undefined;
  if (compliance !== undefined) {
    const existing = await db.findRedTeamCampaignById(id);
    if (!existing) return null;
    metadata = withCompliance(existing.metadata, compliance);
  }
  // The provider type has no `null` for an optional field, but both mixins store one as a cleared value.
  const updated = await db.updateRedTeamCampaign(
    id,
    { ...rest, ...(metadata ? { metadata } : {}), updatedBy } as Parameters<typeof db.updateRedTeamCampaign>[1],
  );
  return updated ? toView(updated) : null;
}

/**
 * A run that still counts against its campaign: pending or running and not
 * abandoned. A running run is abandoned once its lease ran out (one recorded
 * before leases existed, once it went untouched for the legacy timeout); a pending
 * run once it waited longer than the pending timeout. The reaper ends such runs;
 * until it does they must not lock their campaign.
 */
function isStaleActiveRun(run: IRedTeamRun, nowMs: number): boolean {
  if (run.status === 'running') {
    if (run.leaseUntil) return new Date(run.leaseUntil).getTime() < nowMs;
    const touched = run.updatedAt ?? run.startedAt ?? run.createdAt;
    return touched ? nowMs - new Date(touched).getTime() > RUN_LIFECYCLE.legacyRunningTimeoutMs : false;
  }
  return run.createdAt ? nowMs - new Date(run.createdAt).getTime() > RUN_LIFECYCLE.pendingTimeoutMs : false;
}

async function listLiveRuns(
  db: Db,
  scope: { projectId?: string; campaignKey: string },
  nowMs: number,
): Promise<IRedTeamRun[]> {
  const active = await db.listRedTeamRuns({
    projectId: scope.projectId,
    campaignKey: scope.campaignKey,
    status: ['pending', 'running'],
    omitAttempts: true,
    limit: LIVE_RUN_SCAN,
  });
  return active.filter((r) => !isStaleActiveRun(r, nowMs));
}

export async function deleteCampaign(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const campaign = await db.findRedTeamCampaignById(id);
  if (!campaign) return false;
  const live = await listLiveRuns(db, { projectId: campaign.projectId, campaignKey: campaign.key }, Date.now());
  if (live.length > 0) {
    throw new RedTeamConflictError(`Campaign "${campaign.key}" has a scan in progress; stop it or wait for it to finish before deleting the campaign`);
  }
  return db.deleteRedTeamCampaign(id);
}

// ── Runs ───────────────────────────────────────────────────────────────────

/** Runs without their attempts (list views); `getRun` returns one run with them. */
export async function listRuns(
  tenantDbName: string,
  filters?: { projectId?: string; campaignKey?: string; limit?: number; skip?: number },
): Promise<WithId<IRedTeamRun>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listRedTeamRuns({ ...filters, omitAttempts: true })).map(toView);
}

/** One page of runs (no attempts) and the total across pages, for a paged list. */
export async function listRunsPage(
  tenantDbName: string,
  filters: {
    projectId?: string;
    campaignKey?: string;
    status?: RedTeamRunStatus | RedTeamRunStatus[];
    limit?: number;
    skip?: number;
  },
): Promise<{ runs: WithId<IRedTeamRun>[]; total: number }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const { limit, skip, ...scope } = filters;
  const [runs, total] = await Promise.all([
    db.listRedTeamRuns({ ...scope, limit, skip, omitAttempts: true }),
    db.countRedTeamRuns(scope),
  ]);
  return { runs: runs.map(toView), total };
}

export async function getRun(tenantDbName: string, id: string): Promise<WithId<IRedTeamRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findRedTeamRunById(id);
  return record ? viewOf(db, record) : null;
}

/**
 * Diff a run against a baseline run. Both must exist; the baseline is typically
 * an earlier completed scan of the same campaign. Returns null if either run is
 * missing.
 */
export async function compareRuns(
  tenantDbName: string,
  runId: string,
  baselineRunId: string,
): Promise<RedTeamComparison | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const [current, baseline] = await Promise.all([
    db.findRedTeamRunById(runId),
    db.findRedTeamRunById(baselineRunId),
  ]);
  if (!current || !baseline) return null;
  const [currentAttempts, baselineAttempts] = await Promise.all([
    loadRunAttempts(db, current),
    loadRunAttempts(db, baseline),
  ]);
  return compareRedTeamRuns({ ...baseline, attempts: baselineAttempts }, { ...current, attempts: currentAttempts });
}

// ── OWASP overview (compliance posture across completed scans) ─────────────────

const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 500;
/** The most runs one list read returns. */
export const RUN_LIST_PAGE_SIZE = 200;

/** A finite whole number of runs in 1..500; anything else reads the default. */
export function normalizeRunLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return DEFAULT_RUN_LIMIT;
  return Math.min(Math.floor(limit), MAX_RUN_LIMIT);
}

/** Attempts of a category that were answered; a breakdown without `failed` (a legacy aggregate) counts them all. */
export function completedInBucket(bucket: { total: number; failed?: number }): number {
  return Math.max(0, bucket.total - (bucket.failed ?? 0));
}

export interface RedTeamOverviewCategory {
  category: string;
  total: number;
  vulnerable: number;
  needsReview: number;
  /** (total - vulnerable) / total, in [0, 1]. */
  resilience: number;
}

export interface RedTeamOverviewEuCategory {
  category: EuRiskCategory;
  label: string;
  total: number;
  vulnerable: number;
  needsReview: number;
  /** (total - vulnerable) / total, in [0, 1]. */
  resilience: number;
}

export interface RedTeamOverviewTrendPoint {
  runId: string;
  campaignKey: string;
  finishedAt?: Date;
  /** null for a run whose rates cannot be trusted (see `inconclusive`). */
  resilienceScore: number | null;
  attackSuccessRate: number | null;
  vulnerable: number;
  inconclusive?: boolean;
}

export interface RedTeamOverview {
  /** Completed, conclusive scans considered in the rollup. */
  scans: number;
  totalAttempts: number;
  completed: number;
  vulnerable: number;
  needsReview: number;
  /** null when no attempt completed. */
  attackSuccessRate: number | null;
  resilienceScore: number | null;
  bySeverity: Record<string, number>;
  byCategory: RedTeamOverviewCategory[];
  /** Same posture folded onto the EU AI Act / GPAI risk taxonomy. */
  byEuCategory: RedTeamOverviewEuCategory[];
  /** Recent completed scans, oldest → newest (for a resilience trend line). */
  trend: RedTeamOverviewTrendPoint[];
  latestRunAt?: Date;
  /** How many of the latest completed runs the figures were read from. */
  windowRuns: number;
  /** Runs among them left out of the figures because their rates cannot be trusted. */
  inconclusiveRuns: number;
  /** Harmless prompts refused / harmless prompts completed, over the runs that carry them; null when none. */
  overRefusalRate: number | null;
  /** Runs among the considered ones that carry over-refusal attempts. */
  overRefusalRuns: number;
}

/**
 * Roll up completed scans into an OWASP-category compliance posture. Each
 * category aggregates attempts across every recent completed run (honouring HITL
 * review overrides already baked into the persisted aggregate), so the result
 * answers "how resilient is this project, per OWASP risk?". A scan whose rates
 * cannot be trusted adds nothing to the figures; it still shows in the trend,
 * without rates. Categories are shown under their 2025 OWASP key.
 */
export async function getOverview(
  tenantDbName: string,
  filters?: { projectId?: string; limit?: number },
): Promise<RedTeamOverview> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const limit = normalizeRunLimit(filters?.limit);
  const runs: IRedTeamRun[] = [];
  while (runs.length < limit) {
    const chunk = Math.min(limit - runs.length, RUN_LIST_PAGE_SIZE);
    const batch = await db.listRedTeamRuns({
      projectId: filters?.projectId,
      status: 'completed',
      limit: chunk,
      skip: runs.length,
      omitAttempts: true,
    });
    runs.push(...batch);
    if (batch.length < chunk) break;
  }

  const byCategory = new Map<string, RedTeamOverviewCategory & { completed: number }>();
  const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let scans = 0;
  let inconclusiveRuns = 0;
  let totalAttempts = 0;
  let completed = 0;
  let vulnerable = 0;
  let needsReview = 0;
  let overRefused = 0;
  let overRefusalCompleted = 0;
  let overRefusalRuns = 0;

  for (const run of runs) {
    const agg = run.aggregate;
    if (!agg) continue;
    if (inconclusiveReasonsOf(agg).length > 0) {
      inconclusiveRuns += 1;
      continue;
    }
    scans += 1;
    totalAttempts += agg.total;
    completed += agg.completed;
    vulnerable += agg.vulnerable;
    needsReview += agg.needsReview;
    if (agg.overRefusal && agg.overRefusal.completed > 0) {
      overRefusalRuns += 1;
      overRefused += agg.overRefusal.refused;
      overRefusalCompleted += agg.overRefusal.completed;
    }
    for (const sev of Object.keys(bySeverity)) bySeverity[sev] += agg.bySeverity?.[sev] ?? 0;
    for (const [cat, bucket] of Object.entries(agg.byCategory ?? {})) {
      const key = normalizeOwaspCategory(cat);
      const entry = byCategory.get(key) ?? { category: key, total: 0, completed: 0, vulnerable: 0, needsReview: 0, resilience: 1 };
      entry.total += bucket.total;
      entry.completed += completedInBucket(bucket);
      entry.vulnerable += bucket.vulnerable;
      entry.needsReview += bucket.needsReview;
      byCategory.set(key, entry);
    }
  }

  // A category none of whose attempts completed has no rate, so it is left out.
  const categories = [...byCategory.values()]
    .filter((c) => c.completed > 0)
    .map(({ completed: done, ...c }) => ({
      ...c,
      resilience: (done - c.vulnerable) / done,
    }));
  // Worst posture first so the dashboard surfaces the riskiest categories on top.
  categories.sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  // Fold the OWASP posture onto the EU AI Act taxonomy. One OWASP category can
  // feed several EU families, so each contributes its counts to every mapped
  // family (a finding relevant to two duties is evidenced under both).
  const byEu = new Map<EuRiskCategory, RedTeamOverviewEuCategory>();
  for (const c of categories) {
    for (const eu of mapOwaspToEu(c.category)) {
      const entry = byEu.get(eu) ?? {
        category: eu,
        label: EU_RISK_CATEGORIES[eu].label,
        total: 0,
        vulnerable: 0,
        needsReview: 0,
        resilience: 1,
      };
      entry.total += c.total;
      entry.vulnerable += c.vulnerable;
      entry.needsReview += c.needsReview;
      byEu.set(eu, entry);
    }
  }
  const euCategories = [...byEu.values()].map((c) => ({
    ...c,
    resilience: c.total > 0 ? (c.total - c.vulnerable) / c.total : 1,
  }));
  euCategories.sort((a, b) => a.resilience - b.resilience || b.vulnerable - a.vulnerable);

  const trend: RedTeamOverviewTrendPoint[] = runs
    .filter((r) => r.aggregate)
    .slice(0, 20)
    .map((r) => {
      const untrusted = inconclusiveReasonsOf(r.aggregate).length > 0;
      return {
        runId: runIdOf(r),
        campaignKey: r.campaignKey,
        finishedAt: r.finishedAt,
        resilienceScore: untrusted ? null : r.aggregate!.resilienceScore,
        attackSuccessRate: untrusted ? null : r.aggregate!.attackSuccessRate,
        vulnerable: r.aggregate!.vulnerable,
        ...(untrusted ? { inconclusive: true } : {}),
      };
    })
    .reverse();

  return {
    scans,
    totalAttempts,
    completed,
    vulnerable,
    needsReview,
    attackSuccessRate: completed > 0 ? vulnerable / completed : null,
    resilienceScore: completed > 0 ? 1 - vulnerable / completed : null,
    bySeverity,
    byCategory: categories,
    byEuCategory: euCategories,
    trend,
    latestRunAt: runs[0]?.finishedAt,
    windowRuns: runs.length,
    inconclusiveRuns,
    overRefusalRate: overRefusalCompleted > 0 ? overRefused / overRefusalCompleted : null,
    overRefusalRuns,
  };
}

export interface RunCampaignDeps {
  buildTargetInvoker?: typeof buildTargetInvoker;
  buildJudgeInvoker?: typeof buildJudgeInvoker;
  buildAttackerInvoker?: typeof buildAttackerInvoker;
}

function targetSpec(campaign: IRedTeamCampaign): RedTeamTargetSpec {
  return {
    kind: campaign.targetKind,
    key: campaign.key,
    modelKey: campaign.modelKey,
    agentKey: campaign.agentKey,
    // A model target is told how much it may write per turn; an agent keeps its own setting.
    // Left out when the campaign set none, so the model's own default applies.
    ...(campaign.targetKind === 'model' && typeof campaign.runConfig?.maxOutputTokens === 'number'
      ? { maxOutputTokens: clampMaxOutputTokens(campaign.runConfig.maxOutputTokens) }
      : {}),
  };
}

function targetRef(campaign: IRedTeamCampaign): string {
  return (campaign.targetKind === 'agent' ? campaign.agentKey : campaign.modelKey) ?? '';
}

/** An agent keeps its own instructions, so an attempt that plants a system prompt cannot test it. */
function targetAcceptsSystem(campaign: IRedTeamCampaign): boolean {
  return campaign.targetKind !== 'agent';
}

/** What a campaign's target takes; an attempt or probe the target cannot take is not run. */
interface TargetCapabilities {
  acceptsSystem: boolean;
  acceptsHistory: boolean;
  kind: RedTeamTargetKind;
}

function targetCapabilities(campaign: IRedTeamCampaign): TargetCapabilities {
  return {
    acceptsSystem: targetAcceptsSystem(campaign),
    // An agent keeps its own conversation, so forged history cannot be sent to it.
    acceptsHistory: campaign.targetKind !== 'agent',
    kind: campaign.targetKind,
  };
}

/** Why a target cannot take an attempt, or null when it can (the runner skips the same attempts). */
function notApplicableCause(
  probe: Probe,
  attempt: { system?: string; history?: unknown[] },
  caps: TargetCapabilities,
): 'system' | 'other' | null {
  if (probe.targets && !probe.targets.includes(caps.kind)) return 'other';
  if (attempt.history?.length && !caps.acceptsHistory) return 'other';
  if (attempt.system && !caps.acceptsSystem) return 'system';
  return null;
}

/** How many attempts a scan of these probes will run, after the per-run cap and the attempts a target cannot take. */
function plannedAttempts(probes: Probe[], caps: TargetCapabilities): number {
  let runnable = 0;
  for (const probe of probes) {
    for (const attempt of probe.generate()) {
      if (notApplicableCause(probe, attempt, caps)) continue;
      runnable += 1;
    }
  }
  return Math.min(runnable, RUN_LIMITS.maxAttemptsPerRun);
}

/** Whether the attempts a target cannot take all fail only because they plant a system prompt (the common agent case). */
function onlySystemCause(probes: Probe[], caps: TargetCapabilities): boolean {
  for (const probe of probes) {
    for (const attempt of probe.generate()) {
      if (notApplicableCause(probe, attempt, caps) === 'other') return false;
    }
  }
  return true;
}

function newWorkerId(): string {
  return `${os.hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

/**
 * Execute an already-created run to completion: claim it, build invokers, drive
 * the engine while the lease is kept alive, persist attempts + aggregate. Marks
 * the run failed (and rethrows) on a fatal error so the queue can record it.
 * Per-attempt errors never abort. A run that is no longer `pending` (started by
 * another worker, cancelled, already finished) is left alone.
 */
export async function executeRun(
  params: { tenantDbName: string; tenantId: string; projectId?: string; createdBy: string; apiTokenId?: string; runId: string; campaign: IRedTeamCampaign; options?: RunOptions },
  deps: RunCampaignDeps = {},
): Promise<WithId<IRedTeamRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, runId, campaign, options } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const workerId = newWorkerId();
  const claimedAtMs = Date.now();
  const claimed = await db.updateRedTeamRunIf(
    runId,
    { status: 'pending' },
    {
      status: 'running',
      workerId,
      leaseUntil: new Date(claimedAtMs + RUN_LIFECYCLE.leaseMs),
      startedAt: new Date(claimedAtMs),
    },
  );
  if (!claimed) {
    logger.info('Red-team run was not claimed (already started, finished or removed); nothing to do', { runId });
    const current = await db.findRedTeamRunById(runId);
    if (!current) throw new RedTeamNotFoundError(`Red-team run "${runId}" not found`);
    return viewOf(db, current);
  }

  const guard = { status: 'running' as const, workerId };
  // What ends the scan between attempts: a stop request, or a claim that is no longer ours.
  const control = { stop: false, cancelled: false, lost: false };
  const observe = (updated: IRedTeamRun | null): void => {
    if (!updated) {
      control.lost = true;
      control.stop = true;
    } else if (updated.cancelRequested) {
      control.cancelled = true;
      control.stop = true;
    }
  };
  const renewedLease = () => new Date(Date.now() + RUN_LIFECYCLE.leaseMs);

  let beating = false;
  const heartbeat = setInterval(() => {
    if (beating) return;
    beating = true;
    db.updateRedTeamRunIf(runId, guard, { leaseUntil: renewedLease() })
      .then((updated) => {
        if (!updated) logger.warn('Red-team run lost its claim; stopping', { runId });
        observe(updated);
      })
      .catch((err) => logger.warn('Red-team heartbeat failed', { runId, error: logError(err) }))
      .finally(() => {
        beating = false;
      });
  }, RUN_LIFECYCLE.heartbeatMs);
  heartbeat.unref?.();

  const collected = new Map<string, IRedTeamAttemptResult>();
  const seqs = new Map<string, number>();
  let writeChain: Promise<void> = Promise.resolve();

  try {
    // Inside the try so the run is recorded as failed rather than left running
    // when the service has been switched off since it was queued.
    await assertServiceEnabled({ tenantDbName, tenantId }, 'redteam');
    const customProbes = await db.listRedTeamCustomProbes({ projectId });
    const { probes, missing } = buildProbesLenient(resolveProbeKeys(campaign, options), customProbes);
    const warnings = missing.map((key) => `Custom probe ${key} no longer exists; it was skipped.`);
    const judgeModelKey = options?.judgeModelKey ?? campaign.judgeModelKey;
    const ctx: RedTeamModelContext = {
      tenantDbName,
      tenantId,
      projectId: projectId ?? '',
      userId: createdBy,
      ...(params.apiTokenId ? { tokenId: params.apiTokenId } : {}),
    };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const makeAttacker = deps.buildAttackerInvoker ?? buildAttackerInvoker;
    // The judge model doubles as the attacker model that drives adaptive turns.
    const attackerModelKey = judgeModelKey;

    // Pin the agent configuration once, here, so every attempt of the scan hits
    // the same one even if someone publishes or saves halfway through.
    let started: StartedAgentRevision | undefined;
    if (campaign.targetKind === 'agent' && campaign.agentKey) {
      const run = await db.findRedTeamRunById(runId);
      const requested = run?.agentRevision?.requested ?? options?.agentVersion ?? storedAgentRevision(campaign.agentVersion);
      started = await startAgentRevision(tenantDbName, campaign.agentKey, projectId, requested);
    }

    const caps = targetCapabilities(campaign);
    const plannedTotal = plannedAttempts(probes, caps);
    observe(
      await db.updateRedTeamRunIf(runId, guard, {
        leaseUntil: renewedLease(),
        progress: { total: plannedTotal, completed: 0, failed: 0 },
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(started ? { agentRevision: started.revision } : {}),
      }),
    );

    let completedCount = 0;
    let failedCount = 0;
    const result = await runRedTeam({
      probes,
      invokeTarget: makeTarget({ ...targetSpec(campaign), ...(started ? { agentRun: started.selector } : {}) }, ctx),
      invokeJudge: judgeModelKey ? makeJudge(judgeModelKey, ctx) : undefined,
      invokeAttacker: attackerModelKey ? makeAttacker(attackerModelKey, ctx) : undefined,
      config: {
        concurrency: clampConcurrency(options?.concurrency ?? campaign.runConfig?.concurrency),
        policy: campaign.policy,
        maxTurns: options?.maxTurns,
        maxAttempts: RUN_LIMITS.maxAttemptsPerRun,
        targetAcceptsSystem: caps.acceptsSystem,
        targetAcceptsHistory: caps.acceptsHistory,
        targetKind: caps.kind,
        shouldStop: () => control.stop,
      },
      // Each attempt (every turn, the attacker and the judge) in its own exposure: its stored copy and its model
      // calls are marked with what it handed on of documents not open to everyone.
      scope: async (run) => {
        const exposure = new KnowledgeExposure({ parent: null });
        const result = await runWithKnowledgeExposure(exposure, run);
        return exposure.restricted ? { ...result, kbRestricted: exposure.list() } : result;
      },
      // Store the attempt as soon as it is done, so the polling run page shows attempts appear one by one and
      // a crash keeps what finished. A failed write is logged: the end of the run stores every attempt again.
      onAttempt: async (att, index) => {
        const mapped = mapAttempt(att);
        const key = mapped.attemptKey!;
        collected.set(key, mapped);
        seqs.set(key, index);
        try {
          await db.upsertRedTeamRunAttempts([attemptRowOf(claimed, runId, mapped, index)]);
        } catch (err) {
          logger.warn('Red-team attempt row was not stored; it is stored again when the run ends', { runId, attemptKey: key, error: logError(err) });
        }
        if (isFailedAttempt(mapped)) failedCount += 1;
        else completedCount += 1;
        const progress = { total: plannedTotal, completed: completedCount, failed: failedCount };
        // One writer at a time keeps the progress from stepping back; the lease is renewed with it.
        writeChain = writeChain.then(async () => {
          try {
            observe(await db.updateRedTeamRunIf(runId, guard, { progress, leaseUntil: renewedLease() }));
          } catch (err) {
            logger.warn('Red-team progress update failed', { runId, error: logError(err) });
          }
        });
      },
    });

    clearInterval(heartbeat);
    await writeChain;

    const attempts = result.attempts.filter(Boolean).map(mapAttempt);
    await upsertRows(
      db,
      attempts.map((a, i) => attemptRowOf(claimed, runId, a, seqs.get(a.attemptKey!) ?? i)),
    );
    const aggregate = computeAggregate(attempts);
    // A draft is read afresh per attempt: say so when it was saved mid-scan.
    const draftChanged = started?.revision.version === null && (await started.draftChanged());

    const finalWarnings = [...warnings];
    if (result.skipped) {
      finalWarnings.push(`${attemptsWere(result.skipped)} not run: a scan runs at most ${RUN_LIMITS.maxAttemptsPerRun} attempts.`);
    }
    if (result.notApplicable) {
      const n = result.notApplicable;
      finalWarnings.push(
        onlySystemCause(probes, caps)
          ? `${attemptsWere(n)} not run: ${n === 1 ? 'it plants' : 'they plant'} a system prompt, and an agent keeps its own instructions.`
          : `${attemptsWere(n)} not run: ${n === 1 ? 'it needs' : 'they need'} a target that takes a system prompt or history, or a model.`,
      );
    }
    const cancelled = Boolean(result.stopped) && control.cancelled;
    const now = new Date();
    const finished = await db.updateRedTeamRunIf(runId, guard, {
      status: cancelled ? 'cancelled' : 'completed',
      progress: {
        total: cancelled ? plannedTotal : aggregate.total,
        completed: aggregate.completed,
        failed: aggregate.failed,
      },
      aggregate,
      ...(result.skipped ? { skippedAttempts: result.skipped } : {}),
      ...(result.notApplicable ? { notApplicableAttempts: result.notApplicable } : {}),
      ...(finalWarnings.length > 0 ? { warnings: finalWarnings } : {}),
      finishedAt: now,
      ...(cancelled ? { cancelledAt: now } : {}),
      ...(started && draftChanged ? { agentRevision: { ...started.revision, draftChanged: true } } : {}),
    });
    if (!finished) {
      logger.warn('Red-team run could not be finished: it is no longer ours; its row is left as it is', { runId });
      const current = await db.findRedTeamRunById(runId);
      return current ? viewOf(db, current) : { ...toView(claimed), attempts };
    }
    return { ...toView(finished), attempts };
  } catch (err) {
    clearInterval(heartbeat);
    logger.error('Red-team run failed', { runId, campaignKey: campaign.key, error: logError(err) });
    try {
      await writeChain;
      const attempts = [...collected.values()];
      const failed = await db.updateRedTeamRunIf(runId, guard, {
        status: 'failed',
        error: safeRunError(err),
        finishedAt: new Date(),
        ...(attempts.length > 0 ? { aggregate: computeAggregate(attempts) } : {}),
      });
      if (!failed) logger.warn('Red-team run could not be marked failed: it is no longer ours; its row is left as it is', { runId });
    } catch (updateErr) {
      logger.error('Red-team run failure could not be recorded', { runId, error: logError(updateErr) });
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

/** Per-run overrides chosen when a scan is started (override campaign defaults). */
export interface RunOptions {
  /** Cap user turns per attempt (multi-turn probes are truncated). */
  maxTurns?: number;
  /** Parallel attempt executions. */
  concurrency?: number;
  /** Run only this subset of probes (empty/undefined = campaign's selection). */
  probeKeys?: string[];
  /** Judge model for this run (overrides the campaign's judge). */
  judgeModelKey?: string;
  /**
   * Agent campaigns: attack this revision for this scan only, over the
   * campaign's default. A model campaign has none, so passing one is refused.
   */
  agentVersion?: AgentRevision;
}

export interface CreateRunParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  /** The API token a client API call starts the scan with: its agent target reads knowledge bases as the token. */
  apiTokenId?: string;
  campaignKey: string;
  /** Per-run overrides; merged over campaign defaults. */
  options?: RunOptions;
  /**
   * Asked once the campaign is known to target an agent, before anything about
   * the agent is looked at and before a run row is written; it throws to
   * refuse. Only the request that starts a scan can answer for its caller, so
   * this is never queued (the scheduler has no caller to ask).
   */
  authorizeAgentRun?: () => Promise<void>;
}

/** Resolve the effective probe keys for a run (run override → campaign default). */
function resolveProbeKeys(campaign: IRedTeamCampaign, options?: RunOptions): string[] {
  return options?.probeKeys && options.probeKeys.length > 0 ? options.probeKeys : campaign.probeKeys;
}

/** Whether a run scans the same thing as one asked for `requested` (scans of different revisions test different things, so they may overlap). */
function overlapsRevision(run: IRedTeamRun, requested: AgentRevision | undefined): boolean {
  return !requested || !run.agentRevision || sameAgentRevision(run.agentRevision.requested, requested);
}

function byCreation(a: IRedTeamRun, b: IRedTeamRun): number {
  const x = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const y = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (x !== y) return x - y;
  // Same millisecond: a run that already started was there first (ids are random, so they cannot say who was).
  if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
  const ia = runIdOf(a);
  const ib = runIdOf(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Resolve a campaign, create a pending run, and make sure no older live run of it exists. */
async function createPendingRun(
  params: CreateRunParams,
  mode: IRedTeamRun['mode'],
): Promise<{ campaign: IRedTeamCampaign; run: IRedTeamRun }> {
  await assertServiceEnabled({ tenantDbName: params.tenantDbName, tenantId: params.tenantId }, 'redteam');
  const { tenantDbName, tenantId, projectId, createdBy, campaignKey } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const campaign = await db.findRedTeamCampaignByKey(campaignKey, projectId);
  if (!campaign) throw new RedTeamNotFoundError(`Red-team campaign "${campaignKey}" not found`);

  const override = params.options?.agentVersion;
  if (override !== undefined && campaign.targetKind !== 'agent') {
    throw new AgentRevisionError(`Campaign "${campaign.key}" targets a model; agentVersion only applies to agent campaigns`);
  }
  // Before the revision check below, which says whether a version exists.
  if (campaign.targetKind === 'agent') await params.authorizeAgentRun?.();
  // An agent run records what it asked for; a missing agent or version fails
  // here rather than after a run row exists that could only fail.
  let requested: AgentRevision | undefined;
  if (campaign.targetKind === 'agent' && campaign.agentKey) {
    requested = override ?? storedAgentRevision(campaign.agentVersion);
    await assertAgentRevisionRunnable(tenantDbName, campaign.agentKey, projectId, requested);
  }

  const customProbes = await db.listRedTeamCustomProbes({ projectId });
  const { probes } = buildProbesLenient(resolveProbeKeys(campaign, params.options), customProbes);
  const probeCount = plannedAttempts(probes, targetCapabilities(campaign));

  // Insert first, then look: two requests that race both insert, both see both rows, and both agree that the
  // older one (oldest createdAt, then smallest id) goes on. The other removes its own row and reports the
  // conflict. Runs abandoned by a crashed worker do not count (the reaper ends them).
  const conflict = () => new RedTeamConflictError(
    `A run for campaign "${campaign.key}" is already in progress${requested !== undefined ? ` on ${agentRevisionLabel(requested)}` : ''}`,
  );
  // A scan already there is refused before a row is written; the check after the insert settles real races.
  const already = await listLiveRuns(db, { projectId, campaignKey: campaign.key }, Date.now());
  if (already.some((r) => overlapsRevision(r, requested))) throw conflict();
  const run = await db.createRedTeamRun({
    tenantId,
    projectId,
    campaignKey: campaign.key,
    targetKind: campaign.targetKind,
    targetRef: targetRef(campaign),
    status: 'pending',
    ...(requested !== undefined ? { agentRevision: { requested, agentKey: campaign.agentKey } } : {}),
    mode,
    progress: { total: probeCount, completed: 0, failed: 0 },
    attempts: [],
    attemptStore: 'collection',
    createdBy,
  });
  const ourId = runIdOf(run);
  try {
    const live = (await listLiveRuns(db, { projectId, campaignKey: campaign.key }, Date.now()))
      .filter((r) => runIdOf(r) === ourId || overlapsRevision(r, requested))
      .sort(byCreation);
    if (live.length > 0 && runIdOf(live[0]) !== ourId) {
      await db.deleteRedTeamRun(ourId);
      throw conflict();
    }
  } catch (err) {
    if (!(err instanceof RedTeamConflictError)) {
      // The check itself failed: a row nobody will start must not stay behind.
      await db.deleteRedTeamRun(ourId).catch(() => false);
    }
    throw err;
  }
  return { campaign, run };
}

/** Synchronous run (small campaigns, CI). Blocks until the scan finishes. */
export async function runCampaign(params: CreateRunParams, deps: RunCampaignDeps = {}): Promise<WithId<IRedTeamRun>> {
  const { campaign, run } = await createPendingRun(params, 'sync');
  return executeRun(
    { ...params, runId: toView(run).id, campaign },
    deps,
  );
}

/** Create a pending run and hand it to the caller to enqueue (see campaignJob). */
export async function createAsyncRun(params: CreateRunParams): Promise<{ campaign: IRedTeamCampaign; run: WithId<IRedTeamRun> }> {
  const { campaign, run } = await createPendingRun(params, 'async');
  return { campaign, run: toView(run) };
}

// ── Stopping and reaping runs ────────────────────────────────────────────────

/**
 * Stop a scan. A pending run is cancelled at once (nothing has started). A
 * running run is asked to stop: its worker sees the request at its next
 * heartbeat or attempt, ends the scan between attempts and finishes it as
 * `cancelled`, keeping what ran. A finished run cannot be stopped (conflict).
 * Returns null when the run does not exist.
 */
export async function cancelRun(
  tenantDbName: string,
  runId: string,
  userId: string,
): Promise<WithId<IRedTeamRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // A run can be claimed between the read and the write, so the states are tried again a few times.
  for (let i = 0; i < 3; i += 1) {
    const run = await db.findRedTeamRunById(runId);
    if (!run) return null;
    if (run.status === 'pending') {
      const now = new Date();
      const updated = await db.updateRedTeamRunIf(runId, { status: 'pending' }, {
        status: 'cancelled',
        cancelledAt: now,
        cancelRequestedBy: userId,
        finishedAt: now,
        aggregate: computeAggregate([]),
      });
      if (updated) return viewOf(db, updated);
    } else if (run.status === 'running') {
      const updated = await db.updateRedTeamRunIf(runId, { status: 'running' }, {
        cancelRequested: true,
        cancelRequestedBy: userId,
      });
      if (updated) return viewOf(db, updated);
    } else {
      throw new RedTeamConflictError(`The scan has already ${run.status}; there is nothing to stop`);
    }
  }
  throw new RedTeamConflictError('The scan changed state while it was being stopped; try again');
}

/**
 * End runs nobody is working on any more: a running run whose lease ran out (a
 * worker that crashed or was stopped), one recorded before leases that went
 * untouched too long, and a pending run that never reached a worker. Each is
 * ended with one compare-and-set against the state the reaper saw, so a run that
 * moved on in the meantime is not touched. Returns how many it ended.
 */
export async function reapStaleRuns(tenantDbName: string, now: Date = new Date()): Promise<number> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const stale = await db.listStaleRedTeamRuns({
    leaseExpiredBefore: now,
    legacyUpdatedBefore: new Date(now.getTime() - RUN_LIFECYCLE.legacyRunningTimeoutMs),
    pendingCreatedBefore: new Date(now.getTime() - RUN_LIFECYCLE.pendingTimeoutMs),
    limit: 50,
  });
  let reaped = 0;
  for (const run of stale) {
    try {
      const id = runIdOf(run);
      const attempts = run.attemptStore === 'collection' ? (await listAttemptRows(db, id)).map(attemptOfRow) : [];
      const ended = await db.updateRedTeamRunIf(
        id,
        { status: run.status, ...(run.updatedAt ? { updatedAt: run.updatedAt } : {}) },
        {
          status: 'failed',
          finishedAt: now,
          error: run.status === 'running' ? 'The scan stopped responding and was ended.' : 'The scan never started.',
          ...(attempts.length > 0 ? { aggregate: computeAggregate(attempts) } : {}),
        },
      );
      if (ended) {
        reaped += 1;
        logger.warn('Red-team run ended by the reaper', { runId: id, was: run.status });
      }
    } catch (err) {
      logger.error('Red-team reaper could not end a run', { runId: runIdOf(run), error: logError(err) });
    }
  }
  return reaped;
}

// ── Custom probes ────────────────────────────────────────────────────────────

export interface CustomProbeInput {
  name: string;
  description?: string;
  family?: string;
  category: string;
  severity: RedTeamSeverity;
  attempts: IRedTeamCustomAttempt[];
  detectors: IRedTeamCustomDetectors;
  enabled?: boolean;
  projectId?: string;
  polarity?: 'attack' | 'over-refusal';
  /** Set when the probe is a copy of a built-in (the key must be a built-in key). */
  clonedFrom?: { probeKey: string; version: number };
}

/** Generate a unique `custom:`-prefixed key from a desired name. */
async function generateUniqueProbeKey(desired: string, exists: (key: string) => Promise<boolean>): Promise<string> {
  const base = slugify(desired?.trim() || 'probe', SLUG_OPTIONS) || 'probe';
  let candidate = `${CUSTOM_PROBE_PREFIX}${base}`;
  let attempt = 0;
  while (attempt < MAX_KEY_ATTEMPTS) {
    if (!(await exists(candidate))) return candidate;
    attempt += 1;
    candidate = `${CUSTOM_PROBE_PREFIX}${base}-${attempt}`;
  }
  throw new Error(`Could not generate a unique key for "${desired}"`);
}

/** The 2025 key for a category a custom probe was given (a 2025 key or a legacy one). */
function customProbeCategory(category: string): string {
  if (!isKnownOwaspCategory(category)) {
    throw new CustomProbeError('category must be one of the OWASP Top 10 for LLM Applications (2025) categories');
  }
  return normalizeOwaspCategory(category);
}

/**
 * Attempt ids name an attempt inside its probe (and, with the probe key, inside a
 * run), so each must be a plain token and unique in the probe.
 */
function assertAttemptIds(attempts: IRedTeamCustomAttempt[]): void {
  const seen = new Set<string>();
  for (const a of attempts) {
    if (typeof a.id !== 'string' || !ATTEMPT_ID_PATTERN.test(a.id)) {
      throw new CustomProbeError(
        `attempt id "${String(a.id)}" must be 1-${CUSTOM_PROBE_LIMITS.maxAttemptIdLength} characters: letters, digits, ".", "_" or "-"`,
      );
    }
    if (seen.has(a.id)) throw new CustomProbeError(`attempt id "${a.id}" is used twice in this probe`);
    seen.add(a.id);
  }
}

export async function createCustomProbe(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CustomProbeInput,
): Promise<WithId<IRedTeamCustomProbe>> {
  // Fail loudly on an unrunnable definition before it reaches a campaign.
  const category = customProbeCategory(input.category);
  validateCustomProbe({ attempts: input.attempts, detectors: input.detectors });
  assertAttemptIds(input.attempts);
  validateCustomProbeDefinition({ category, attempts: input.attempts, detectors: input.detectors, polarity: input.polarity });
  validateCustomProbePatterns(input.attempts);
  if (input.clonedFrom && !getBuiltinProbeDefinition(input.clonedFrom.probeKey)) {
    throw new CustomProbeError('clonedFrom.probeKey must be the key of a built-in probe');
  }
  return storeCustomProbe(tenantDbName, tenantId, createdBy, input, category, input.clonedFrom ? 'clone' : 'manual');
}

async function storeCustomProbe(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CustomProbeInput,
  category: string,
  origin: 'manual' | 'clone' | 'import',
  source?: IRedTeamProbeSource,
): Promise<WithId<IRedTeamCustomProbe>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const probe = await createWithUniqueKey(
    () => generateUniqueProbeKey(input.name, async (k) => !!(await db.findRedTeamCustomProbeByKey(k, input.projectId))),
    (key) => db.createRedTeamCustomProbe({
      tenantId,
      projectId: input.projectId,
      key,
      name: input.name,
      description: input.description ?? '',
      family: input.family || DEFAULT_CUSTOM_PROBE_FAMILY,
      category,
      severity: input.severity,
      attempts: input.attempts,
      detectors: input.detectors,
      enabled: input.enabled ?? true,
      ...(input.polarity ? { polarity: input.polarity } : {}),
      origin,
      ...(origin === 'clone' && input.clonedFrom ? { clonedFrom: input.clonedFrom } : {}),
      ...(source ? { source } : {}),
      createdBy,
    }),
    'custom probe',
  );
  return toView(probe);
}

/** The code-defined definition of a built-in probe (attempts, detectors), or null for an unknown or custom key. */
export function getBuiltinProbeDefinition(key: string): BuiltinProbeDefinition | null {
  if (typeof key !== 'string' || key.startsWith(CUSTOM_PROBE_PREFIX)) return null;
  return builtinProbeDefinition(key);
}

export interface ImportCustomProbesInput {
  tenantId: string;
  projectId?: string;
  createdBy: string;
  drafts: ImportProbeDraft[];
}

function importSourceError(source: unknown): string | null {
  if (!source || typeof source !== 'object') return 'source is required';
  const src = source as Record<string, unknown>;
  if (typeof src.name !== 'string' || !src.name.trim()) return 'source.name is required';
  const limits: Array<[string, number]> = [
    ['name', IMPORT_LIMITS.maxSourceNameChars],
    ['license', IMPORT_LIMITS.maxSourceLicenseChars],
    ['attribution', IMPORT_LIMITS.maxSourceAttributionChars],
    ['format', IMPORT_LIMITS.maxSourceFormatChars],
    ['fileName', IMPORT_LIMITS.maxSourceFileNameChars],
    ['url', IMPORT_LIMITS.maxSourceUrlChars],
  ];
  for (const [field, max] of limits) {
    const value = src[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `source.${field} must be text`;
    if (value.length > max) return `source.${field} is longer than ${max} characters`;
  }
  if (typeof src.url === 'string' && src.url) {
    let protocol = '';
    try {
      protocol = new URL(src.url).protocol;
    } catch {
      protocol = '';
    }
    if (protocol !== 'http:' && protocol !== 'https:') return 'source.url must be an http or https link';
  }
  return null;
}

/** The stored source of an imported probe: the known fields only, whatever else the caller sent. */
function importedSource(source: IRedTeamProbeSource, importedAt: Date): IRedTeamProbeSource {
  const { name, format, license, attribution, url, fileName } = source;
  return {
    name,
    ...(format ? { format } : {}),
    ...(license ? { license } : {}),
    ...(attribution ? { attribution } : {}),
    ...(url ? { url } : {}),
    ...(fileName ? { fileName } : {}),
    importedAt,
  };
}

/**
 * Create custom probes from import drafts (built in the browser from a file). Every draft is
 * validated before the first one is stored, so a bad draft creates nothing.
 */
export async function importCustomProbes(
  tenantDbName: string,
  input: ImportCustomProbesInput,
): Promise<WithId<IRedTeamCustomProbe>[]> {
  const { drafts } = input;
  if (!Array.isArray(drafts) || drafts.length === 0) throw new RedTeamValidationError('probes must list at least one probe');
  if (drafts.length > IMPORT_LIMITS.maxProbesPerImport) {
    throw new RedTeamValidationError(`an import can create at most ${IMPORT_LIMITS.maxProbesPerImport} probes`);
  }
  const prepared = drafts.map((draft, index) => {
    const label = `probe ${index + 1}${typeof draft?.name === 'string' && draft.name ? ` ("${draft.name}")` : ''}`;
    try {
      if (!draft || typeof draft.name !== 'string' || !draft.name.trim()) throw new CustomProbeError('name is required');
      const sourceError = importSourceError(draft.source);
      if (sourceError) throw new CustomProbeError(sourceError);
      const category = customProbeCategory(draft.category);
      validateCustomProbe({ attempts: draft.attempts, detectors: draft.detectors });
      assertAttemptIds(draft.attempts);
      validateCustomProbeDefinition({ category, attempts: draft.attempts, detectors: draft.detectors, polarity: draft.polarity });
      validateCustomProbePatterns(draft.attempts);
      return { draft, category };
    } catch (err) {
      if (err instanceof CustomProbeError) throw new RedTeamValidationError(`${label}: ${err.message}`);
      throw err;
    }
  });
  const importedAt = new Date();
  const created: WithId<IRedTeamCustomProbe>[] = [];
  for (const { draft, category } of prepared) {
    created.push(
      await storeCustomProbe(
        tenantDbName,
        input.tenantId,
        input.createdBy,
        {
          name: draft.name.trim(),
          description: draft.description,
          family: draft.family,
          category,
          severity: draft.severity,
          attempts: draft.attempts,
          detectors: draft.detectors,
          enabled: true,
          projectId: input.projectId,
          polarity: draft.polarity,
        },
        category,
        'import',
        importedSource(draft.source, importedAt),
      ),
    );
  }
  return created;
}

export async function listCustomProbes(
  tenantDbName: string,
  filters?: { projectId?: string; search?: string },
): Promise<WithId<IRedTeamCustomProbe>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listRedTeamCustomProbes(filters)).map(toView);
}

export async function getCustomProbe(tenantDbName: string, id: string): Promise<WithId<IRedTeamCustomProbe> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findRedTeamCustomProbeById(id);
  return record ? toView(record) : null;
}

/**
 * A custom-probe PATCH: a key that is absent leaves the stored value alone
 * (never pass `undefined` for it). `null` for the description or the family
 * puts back what a create would have stored (an empty description, the
 * `custom` family): neither is ever stored as a null.
 */
export type UpdateCustomProbeInput = Partial<
  Pick<IRedTeamCustomProbe, 'name' | 'category' | 'severity' | 'attempts' | 'detectors' | 'enabled' | 'projectId' | 'polarity'>
> & {
  description?: string | null;
  family?: string | null;
};

export async function updateCustomProbe(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: UpdateCustomProbeInput,
): Promise<WithId<IRedTeamCustomProbe> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const category = data.category !== undefined ? customProbeCategory(data.category) : undefined;
  // Validate the resulting definition when the attempts / detectors change.
  if (data.attempts !== undefined || data.detectors !== undefined || data.polarity !== undefined) {
    const existing = await db.findRedTeamCustomProbeById(id);
    if (!existing) return null;
    const attempts = data.attempts ?? existing.attempts;
    const detectors = data.detectors ?? existing.detectors;
    validateCustomProbe({ attempts, detectors });
    if (data.attempts !== undefined) assertAttemptIds(data.attempts);
    validateCustomProbeDefinition({
      category: category ?? existing.category,
      attempts,
      detectors,
      polarity: data.polarity ?? existing.polarity,
    }, existing.attempts);
    if (data.attempts !== undefined) validateCustomProbePatterns(data.attempts, existing.attempts);
  }
  const { description, family, category: _category, ...rest } = data;
  void _category;
  const updated = await db.updateRedTeamCustomProbe(id, {
    ...rest,
    ...(category !== undefined ? { category } : {}),
    ...(description !== undefined ? { description: description ?? '' } : {}),
    ...(family !== undefined ? { family: family || DEFAULT_CUSTOM_PROBE_FAMILY } : {}),
    updatedBy,
  });
  return updated ? toView(updated) : null;
}

/**
 * Delete a custom probe. A probe that campaigns still select is kept (and the
 * campaigns are named) unless `force` is set; a campaign that keeps selecting a
 * deleted probe skips it with a warning on each run.
 */
export async function deleteCustomProbe(
  tenantDbName: string,
  id: string,
  opts: { force?: boolean } = {},
): Promise<{ deleted: boolean; usedBy: Array<{ id: string; key: string; name: string }> }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const probe = await db.findRedTeamCustomProbeById(id);
  if (!probe) return { deleted: false, usedBy: [] };
  const campaigns = await db.listRedTeamCampaigns({ projectId: probe.projectId });
  const usedBy = campaigns
    .filter((c) => (c.projectId ?? '') === (probe.projectId ?? '') && (c.probeKeys ?? []).includes(probe.key))
    .map((c) => ({ id: typeof c._id === 'string' ? c._id : String(c._id ?? ''), key: c.key, name: c.name }));
  if (usedBy.length > 0 && !opts.force) return { deleted: false, usedBy };
  return { deleted: await db.deleteRedTeamCustomProbe(id), usedBy };
}

export { CustomProbeError };

// ── HITL review ──────────────────────────────────────────────────────────────

/** Whether a viewer may read an attempt that handed on knowledge base passages not open to everyone (see restrictedKnowledgeRequest). */
export interface ReviewViewer {
  mayRead(tags: unknown, askers: ReadonlyArray<string | null | undefined>): Promise<boolean>;
}

/** Copy a legacy run's embedded attempts into attempt rows and point the run at them. Safe to repeat. */
async function migrateEmbeddedAttempts(db: Db, runId: string, first: IRedTeamRun): Promise<IRedTeamRun | null> {
  let run: IRedTeamRun | null = first;
  for (let i = 0; run && i < 3; i += 1) {
    if (run.attemptStore === 'collection') return run;
    const attempts = withUniqueKeys(run.attempts ?? []);
    await upsertRows(db, attempts.map((a, seq) => attemptRowOf(run!, runId, a, seq)));
    // A row upsert stores a review only when it inserts the row, so a legacy review (carried in the row)
    // never replaces one given after the attempt was migrated.
    const switched = await db.updateRedTeamRunIf(
      runId,
      run.updatedAt ? { updatedAt: run.updatedAt } : {},
      { attemptStore: 'collection', attempts: [] },
    );
    if (switched) return switched;
    // The run changed while its attempts were copied: look again (copying twice is harmless).
    run = await db.findRedTeamRunById(runId);
  }
  if (run && run.attemptStore === 'collection') return run;
  if (!run) return null;
  throw new RedTeamConflictError('The run changed while it was being prepared for review; try again');
}

const REVIEW_AGGREGATE_TRIES = 3;

/**
 * Record a human review of one attempt and refresh the run's aggregate.
 *
 * `attemptRef` is the attempt's key (`<probeKey>::<attemptId>`) or a bare attempt
 * id, which is accepted only when exactly one attempt of the run has it. A scan
 * still pending or running cannot be reviewed; neither can an attempt the target
 * never answered, nor one this viewer may not read (`viewer`: the route passes
 * the restricted-knowledge reader of its request). A run stored with embedded
 * attempts is moved to attempt rows here, the first time it is reviewed.
 * Returns null when the run does not exist.
 */
export async function reviewAttempt(
  tenantDbName: string,
  runId: string,
  attemptRef: string | { attemptKey?: string; attemptId?: string },
  review: { outcome: RedTeamOutcome; note?: string; reviewedBy: string },
  viewer?: ReviewViewer,
): Promise<WithId<IRedTeamRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const found = await db.findRedTeamRunById(runId);
  if (!found) return null;
  if (found.status === 'pending' || found.status === 'running') {
    throw new RedTeamConflictError('The scan has not finished; review its attempts once it has');
  }
  const run = await migrateEmbeddedAttempts(db, runId, found);
  if (!run) return null;

  // The route sends `{ attemptKey }` or `{ attemptId }`; a plain string is read the same way.
  const ref = typeof attemptRef === 'string'
    ? (parseAttemptKey(attemptRef) ? { attemptKey: attemptRef } : { attemptId: attemptRef })
    : attemptRef;
  let attemptKey: string;
  if (ref.attemptKey && parseAttemptKey(ref.attemptKey)) {
    attemptKey = ref.attemptKey;
  } else {
    const bareId = ref.attemptId ?? ref.attemptKey ?? '';
    const matches = (await listAttemptRows(db, runId)).filter((r) => r.attemptId === bareId);
    if (matches.length === 0) throw new RedTeamNotFoundError('Attempt not found');
    if (matches.length > 1) throw new RedTeamConflictError('ambiguous attempt id; send attemptKey');
    attemptKey = matches[0].attemptKey;
  }

  const row = await db.findRedTeamRunAttempt(runId, attemptKey);
  if (!row) throw new RedTeamNotFoundError('Attempt not found');
  if (isFailedAttempt(row)) {
    throw new RedTeamConflictError('The target never answered this attempt, so there is nothing to review');
  }
  if (viewer && row.kbRestricted?.length && !(await viewer.mayRead(row.kbRestricted, [run.createdBy]))) {
    throw new RedTeamForbiddenError('You cannot read this attempt, so you cannot review it');
  }

  const stored = await db.setRedTeamRunAttemptReview(runId, attemptKey, {
    outcome: review.outcome,
    note: review.note,
    reviewedBy: review.reviewedBy,
    reviewedAt: new Date(),
  });
  if (!stored) throw new RedTeamNotFoundError('Attempt not found');

  // Recomputed from the rows, so two reviews that land together both count.
  // The write is guarded by the run's updatedAt: a review that landed meanwhile makes it miss, and it is computed again.
  for (let tries = 0; tries < REVIEW_AGGREGATE_TRIES; tries += 1) {
    const current = await db.findRedTeamRunById(runId);
    if (!current) return null;
    const attempts = (await listAttemptRows(db, runId)).map(attemptOfRow);
    const aggregate = computeAggregate(attempts);
    const updated = await db.updateRedTeamRunIf(
      runId,
      current.updatedAt ? { updatedAt: current.updatedAt } : {},
      { aggregate },
    );
    if (updated) return { ...toView(updated), attempts };
  }
  // Still contended: write what the rows say now, so the stored aggregate is never older than the rows.
  const attempts = (await listAttemptRows(db, runId)).map(attemptOfRow);
  const updated = await db.updateRedTeamRun(runId, { aggregate: computeAggregate(attempts) });
  return updated ? { ...toView(updated), attempts } : null;
}
