/**
 * Red-team service — tenant-scoped CRUD over campaigns + runs, plus the run
 * orchestration that loads a campaign, builds live invokers, drives the pure
 * engine runner, and persists the attempts + aggregate.
 *
 * `executeRun` is shared by the synchronous path (`runCampaign`) and the async
 * queue job (see `campaignJob`), so both produce identical persisted results.
 * Target/judge invokers are injectable (RunCampaignDeps) for testability.
 */

import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type {
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamAttemptResult,
  IRedTeamAggregate,
  IRedTeamSignal,
  RedTeamOutcome,
  RedTeamSeverity,
  RedTeamTargetKind,
} from '@/lib/database';
import { runRedTeam } from './runner';
import { buildProbes } from './probes';
import {
  buildAttackerInvoker,
  buildJudgeInvoker,
  buildTargetInvoker,
  type RedTeamModelContext,
  type RedTeamTargetSpec,
} from './adapters';
import type { AttemptResult, DetectionSignal } from './types';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;
const SEVERITIES: RedTeamSeverity[] = ['low', 'medium', 'high', 'critical'];

export type WithId<T> = Omit<T, '_id'> & { id: string };

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
    family: a.family,
    category: a.category,
    severity: a.severity,
    outcome: a.outcome,
    decidedBy: a.verdict.decidedBy,
    confidence: a.verdict.confidence,
    transcript: a.transcript,
    signals: a.verdict.signals.map(mapSignal),
    latencyMs: a.latencyMs,
    error: a.error,
  };
}

/** Effective outcome for an attempt: a human review overrides the machine verdict. */
function effectiveOutcome(a: IRedTeamAttemptResult): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

/** Recompute the aggregate from attempts, honouring any HITL review overrides. */
export function computeAggregate(attempts: IRedTeamAttemptResult[]): IRedTeamAggregate {
  const total = attempts.length;
  const failed = attempts.filter((a) => a.error).length;
  const completed = total - failed;

  const vulnerable = attempts.filter((a) => effectiveOutcome(a) === 'vulnerable').length;
  const safe = attempts.filter((a) => effectiveOutcome(a) === 'safe').length;
  const needsReview = attempts.filter((a) => effectiveOutcome(a) === 'needs_review' && !a.error).length;

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<string, number>;
  const byCategory: IRedTeamAggregate['byCategory'] = {};
  for (const a of attempts) {
    const outcome = effectiveOutcome(a);
    if (outcome === 'vulnerable') bySeverity[a.severity] += 1;
    const bucket = (byCategory[a.category] ??= { total: 0, vulnerable: 0, needsReview: 0 });
    bucket.total += 1;
    if (outcome === 'vulnerable') bucket.vulnerable += 1;
    if (outcome === 'needs_review' && !a.error) bucket.needsReview += 1;
  }

  const latencies = attempts.map((a) => a.latencyMs).filter((v): v is number => typeof v === 'number');
  const avgLatencyMs = latencies.length ? latencies.reduce((x, y) => x + y, 0) / latencies.length : null;
  const attackSuccessRate = completed ? vulnerable / completed : 0;

  return {
    total,
    completed,
    failed,
    vulnerable,
    safe,
    needsReview,
    attackSuccessRate,
    resilienceScore: 1 - attackSuccessRate,
    bySeverity,
    byCategory,
    avgLatencyMs,
  };
}

// ── Campaign CRUD ────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  description?: string;
  targetKind: RedTeamTargetKind;
  agentKey?: string;
  modelKey?: string;
  probeKeys?: string[];
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  policy?: IRedTeamCampaign['policy'];
  schedule?: IRedTeamCampaign['schedule'];
  projectId?: string;
}

export async function createCampaign(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateCampaignInput,
): Promise<WithId<IRedTeamCampaign>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const key = await generateUniqueKey(input.name, async (k) => !!(await db.findRedTeamCampaignByKey(k, input.projectId)));
  const campaign = await db.createRedTeamCampaign({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    targetKind: input.targetKind,
    agentKey: input.agentKey,
    modelKey: input.modelKey,
    probeKeys: input.probeKeys ?? [],
    judgeModelKey: input.judgeModelKey,
    runConfig: input.runConfig,
    policy: input.policy,
    schedule: input.schedule,
    createdBy,
  });
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

export async function updateCampaign(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: Partial<Pick<IRedTeamCampaign, 'name' | 'description' | 'targetKind' | 'agentKey' | 'modelKey' | 'probeKeys' | 'judgeModelKey' | 'runConfig' | 'policy' | 'schedule' | 'projectId'>>,
): Promise<WithId<IRedTeamCampaign> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateRedTeamCampaign(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteCampaign(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteRedTeamCampaign(id);
}

// ── Runs ───────────────────────────────────────────────────────────────────

export async function listRuns(
  tenantDbName: string,
  filters?: { projectId?: string; campaignKey?: string; limit?: number; skip?: number },
): Promise<WithId<IRedTeamRun>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listRedTeamRuns(filters)).map(toView);
}

export async function getRun(tenantDbName: string, id: string): Promise<WithId<IRedTeamRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findRedTeamRunById(id);
  return record ? toView(record) : null;
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
  };
}

function targetRef(campaign: IRedTeamCampaign): string {
  return (campaign.targetKind === 'agent' ? campaign.agentKey : campaign.modelKey) ?? '';
}

/**
 * Execute an already-created run to completion: build invokers, drive the
 * engine, persist attempts + aggregate. Marks the run failed (and rethrows) on
 * a fatal error so the queue can record/retry. Per-attempt errors never abort.
 */
export async function executeRun(
  params: { tenantDbName: string; tenantId: string; projectId?: string; createdBy: string; runId: string; campaign: IRedTeamCampaign; options?: RunOptions },
  deps: RunCampaignDeps = {},
): Promise<WithId<IRedTeamRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, runId, campaign, options } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  try {
    const probes = buildProbes(resolveProbeKeys(campaign, options));
    const judgeModelKey = options?.judgeModelKey ?? campaign.judgeModelKey;
    const ctx: RedTeamModelContext = { tenantDbName, tenantId, projectId: projectId ?? '', userId: createdBy };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const makeAttacker = deps.buildAttackerInvoker ?? buildAttackerInvoker;
    // The judge model doubles as the attacker model that drives adaptive turns.
    const attackerModelKey = judgeModelKey;

    const total = probes.reduce((n, p) => n + p.generate().length, 0);
    await db.updateRedTeamRun(runId, { status: 'running', startedAt: new Date(), progress: { total, completed: 0, failed: 0 } });

    // Persist incremental progress so the polling run-detail page shows attempts
    // appear step by step (throttled to avoid hammering the DB on large scans).
    const partial: IRedTeamAttemptResult[] = [];
    let lastFlush = 0;
    const result = await runRedTeam({
      probes,
      invokeTarget: makeTarget(targetSpec(campaign), ctx),
      invokeJudge: judgeModelKey ? makeJudge(judgeModelKey, ctx) : undefined,
      invokeAttacker: attackerModelKey ? makeAttacker(attackerModelKey, ctx) : undefined,
      config: {
        concurrency: options?.concurrency ?? campaign.runConfig?.concurrency,
        policy: campaign.policy,
        maxTurns: options?.maxTurns,
      },
      onAttempt: (att) => {
        partial.push(mapAttempt(att));
        const now = Date.now();
        if (now - lastFlush >= 1500) {
          lastFlush = now;
          const completed = partial.filter((p) => !p.error).length;
          const failed = partial.filter((p) => p.error).length;
          void db
            .updateRedTeamRun(runId, { progress: { total, completed, failed }, attempts: [...partial] })
            .catch(() => undefined);
        }
      },
    });

    const attempts = result.attempts.map(mapAttempt);
    const updated = await db.updateRedTeamRun(runId, {
      status: 'completed',
      progress: {
        total: result.aggregate.total,
        completed: result.aggregate.completed,
        failed: result.aggregate.failed,
      },
      aggregate: result.aggregate,
      attempts,
      finishedAt: new Date(),
    });
    return toView(updated ?? (await db.findRedTeamRunById(runId))!);
  } catch (err) {
    await db.updateRedTeamRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      finishedAt: new Date(),
    });
    throw err;
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
}

export interface CreateRunParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  campaignKey: string;
  /** Per-run overrides; merged over campaign defaults. */
  options?: RunOptions;
}

/** Resolve the effective probe keys for a run (run override → campaign default). */
function resolveProbeKeys(campaign: IRedTeamCampaign, options?: RunOptions): string[] {
  return options?.probeKeys && options.probeKeys.length > 0 ? options.probeKeys : campaign.probeKeys;
}

/** Resolve a campaign, guard against a concurrent run, and create a pending run. */
async function createPendingRun(
  params: CreateRunParams,
  mode: IRedTeamRun['mode'],
): Promise<{ campaign: IRedTeamCampaign; run: IRedTeamRun }> {
  const { tenantDbName, tenantId, projectId, createdBy, campaignKey } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const campaign = await db.findRedTeamCampaignByKey(campaignKey, projectId);
  if (!campaign) throw new Error(`Red-team campaign "${campaignKey}" not found`);

  // Reject if a recent run is still in progress (stale >1h rows are ignored so
  // a campaign can never get permanently locked by a crashed worker).
  const inFlight = await db.listRedTeamRuns({ projectId, campaignKey: campaign.key, status: 'running', limit: 1 });
  const recentStart = inFlight[0]?.startedAt ? new Date(inFlight[0].startedAt).getTime() : 0;
  if (inFlight.length > 0 && Date.now() - recentStart < 60 * 60 * 1000) {
    throw new Error(`A run for campaign "${campaign.key}" is already in progress`);
  }

  const probeCount = buildProbes(resolveProbeKeys(campaign, params.options)).reduce((n, p) => n + p.generate().length, 0);
  const run = await db.createRedTeamRun({
    tenantId,
    projectId,
    campaignKey: campaign.key,
    targetKind: campaign.targetKind,
    targetRef: targetRef(campaign),
    status: 'pending',
    mode,
    progress: { total: probeCount, completed: 0, failed: 0 },
    attempts: [],
    createdBy,
  });
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

// ── HITL review ──────────────────────────────────────────────────────────────

export async function reviewAttempt(
  tenantDbName: string,
  runId: string,
  attemptId: string,
  review: { outcome: RedTeamOutcome; note?: string; reviewedBy: string },
): Promise<WithId<IRedTeamRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const run = await db.findRedTeamRunById(runId);
  if (!run) return null;

  const attempts = run.attempts.map((a) =>
    a.attemptId === attemptId
      ? { ...a, review: { outcome: review.outcome, note: review.note, reviewedBy: review.reviewedBy, reviewedAt: new Date() } }
      : a,
  );
  const updated = await db.updateRedTeamRun(runId, { attempts, aggregate: computeAggregate(attempts) });
  return updated ? toView(updated) : null;
}
