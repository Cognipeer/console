/**
 * Evaluation service — tenant-scoped CRUD over targets / datasets / suites /
 * runs, plus `runSuite` which loads a suite, builds live invokers, drives the
 * pure engine runner, and persists the run + aggregate.
 *
 * Target/judge invokers are injectable (RunSuiteDeps) so the orchestration is
 * testable without live model calls.
 */

import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type {
  IEvaluationTarget,
  IEvaluationDataset,
  IEvaluationDatasetItem,
  IEvaluationSuite,
  IEvaluationScorerConfig,
  IEvaluationRun,
  IEvaluationRunItem,
  EvaluationTargetKind,
  EvaluationDatasetSource,
} from '@/lib/database';
import { runEvaluation } from './runner';
import type { DatasetItem, RunItemResult, ScorerConfig } from './types';
import { buildEmbedInvoker, buildJudgeInvoker, buildTargetInvoker, type EvaluationModelContext } from './adapters';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

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
  const base = slugify(desired?.trim() || 'item', SLUG_OPTIONS) || 'item';
  let candidate = base;
  let attempt = 0;
  while (attempt < MAX_KEY_ATTEMPTS) {
    if (!(await exists(candidate))) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
  throw new Error(`Could not generate a unique key for "${desired}"`);
}

function mapScorer(config: IEvaluationScorerConfig): ScorerConfig {
  if (config.type === 'llm-judge') {
    return { type: 'llm-judge', weight: config.weight, rubric: config.rubric ?? '', threshold: config.threshold };
  }
  if (config.type === 'semantic') {
    return { type: 'semantic', weight: config.weight, threshold: config.threshold };
  }
  return { type: 'assertion', weight: config.weight };
}

function toRunItem(result: RunItemResult): IEvaluationRunItem {
  return {
    itemId: result.itemId,
    output: result.output ? { text: result.output.text, latencyMs: result.output.latencyMs } : undefined,
    scores: result.scores.map((s) => ({
      scorerType: s.scorerType,
      score: s.score,
      passed: s.passed,
      weight: s.weight,
      detail: s.detail,
      error: s.error,
    })),
    score: result.score,
    passed: result.passed,
    latencyMs: result.latencyMs,
    error: result.error,
  };
}

// ── Targets ────────────────────────────────────────────────────────────────

export interface CreateTargetInput {
  name: string;
  description?: string;
  kind: EvaluationTargetKind;
  agentKey?: string;
  modelKey?: string;
  external?: IEvaluationTarget['external'];
  defaultParams?: Record<string, unknown>;
  projectId?: string;
}

export async function createTarget(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateTargetInput,
): Promise<WithId<IEvaluationTarget>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const key = await generateUniqueKey(input.name, async (k) => !!(await db.findEvaluationTargetByKey(k, input.projectId)));
  const target = await db.createEvaluationTarget({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    kind: input.kind,
    agentKey: input.agentKey,
    modelKey: input.modelKey,
    external: input.external,
    defaultParams: input.defaultParams,
    createdBy,
  });
  return toView(target);
}

export async function listTargets(
  tenantDbName: string,
  filters?: { projectId?: string; kind?: EvaluationTargetKind; search?: string },
): Promise<WithId<IEvaluationTarget>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listEvaluationTargets(filters)).map(toView);
}

export async function getTarget(tenantDbName: string, id: string): Promise<WithId<IEvaluationTarget> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationTargetById(id);
  return record ? toView(record) : null;
}

export async function updateTarget(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: Partial<Omit<IEvaluationTarget, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt' | 'updatedAt'>>,
): Promise<WithId<IEvaluationTarget> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateEvaluationTarget(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteTarget(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteEvaluationTarget(id);
}

// ── Datasets ───────────────────────────────────────────────────────────────

export interface CreateDatasetInput {
  name: string;
  description?: string;
  source?: EvaluationDatasetSource;
  items?: IEvaluationDatasetItem[];
  projectId?: string;
  metadata?: Record<string, unknown>;
}

export async function createDataset(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateDatasetInput,
): Promise<WithId<IEvaluationDataset>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const key = await generateUniqueKey(input.name, async (k) => !!(await db.findEvaluationDatasetByKey(k, input.projectId)));
  const dataset = await db.createEvaluationDataset({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    source: input.source ?? 'manual',
    items: input.items ?? [],
    metadata: input.metadata,
    createdBy,
  });
  return toView(dataset);
}

export async function listDatasets(
  tenantDbName: string,
  filters?: { projectId?: string; source?: EvaluationDatasetSource; search?: string },
): Promise<WithId<IEvaluationDataset>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listEvaluationDatasets(filters)).map(toView);
}

export async function getDataset(tenantDbName: string, id: string): Promise<WithId<IEvaluationDataset> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationDatasetById(id);
  return record ? toView(record) : null;
}

export async function updateDataset(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: Partial<Pick<IEvaluationDataset, 'name' | 'description' | 'source' | 'items' | 'projectId' | 'metadata'>>,
): Promise<WithId<IEvaluationDataset> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateEvaluationDataset(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteDataset(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteEvaluationDataset(id);
}

// ── Suites ─────────────────────────────────────────────────────────────────

export interface CreateSuiteInput {
  name: string;
  description?: string;
  targetKey: string;
  datasetKey: string;
  scorers: IEvaluationScorerConfig[];
  judgeModelKey?: string;
  embeddingModelKey?: string;
  runConfig?: { concurrency?: number };
  projectId?: string;
}

export async function createSuite(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateSuiteInput,
): Promise<WithId<IEvaluationSuite>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const key = await generateUniqueKey(input.name, async (k) => !!(await db.findEvaluationSuiteByKey(k, input.projectId)));
  const suite = await db.createEvaluationSuite({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    targetKey: input.targetKey,
    datasetKey: input.datasetKey,
    scorers: input.scorers,
    judgeModelKey: input.judgeModelKey,
    embeddingModelKey: input.embeddingModelKey,
    runConfig: input.runConfig,
    createdBy,
  });
  return toView(suite);
}

export async function listSuites(
  tenantDbName: string,
  filters?: { projectId?: string; targetKey?: string; datasetKey?: string; search?: string },
): Promise<WithId<IEvaluationSuite>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listEvaluationSuites(filters)).map(toView);
}

export async function getSuite(tenantDbName: string, id: string): Promise<WithId<IEvaluationSuite> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationSuiteById(id);
  return record ? toView(record) : null;
}

export async function updateSuite(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: Partial<Pick<IEvaluationSuite, 'name' | 'description' | 'targetKey' | 'datasetKey' | 'scorers' | 'judgeModelKey' | 'embeddingModelKey' | 'runConfig' | 'projectId'>>,
): Promise<WithId<IEvaluationSuite> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateEvaluationSuite(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteSuite(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteEvaluationSuite(id);
}

// ── Runs ───────────────────────────────────────────────────────────────────

export async function listRuns(
  tenantDbName: string,
  filters?: { projectId?: string; suiteKey?: string; limit?: number; skip?: number },
): Promise<WithId<IEvaluationRun>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listEvaluationRuns(filters)).map(toView);
}

export async function getRun(tenantDbName: string, id: string): Promise<WithId<IEvaluationRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationRunById(id);
  return record ? toView(record) : null;
}

export interface RunSuiteDeps {
  buildTargetInvoker?: typeof buildTargetInvoker;
  buildJudgeInvoker?: typeof buildJudgeInvoker;
  buildEmbedInvoker?: typeof buildEmbedInvoker;
}

export interface RunSuiteParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  suiteKey: string;
}

/** Resolve suite/target/dataset, guard against a concurrent run, create a pending run. */
async function createPendingRun(params: RunSuiteParams, mode: IEvaluationRun['mode']): Promise<WithId<IEvaluationRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, suiteKey } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const suite = await db.findEvaluationSuiteByKey(suiteKey, projectId);
  if (!suite) throw new Error(`Evaluation suite "${suiteKey}" not found`);
  const target = await db.findEvaluationTargetByKey(suite.targetKey, projectId);
  if (!target) throw new Error(`Evaluation target "${suite.targetKey}" not found`);
  const dataset = await db.findEvaluationDatasetByKey(suite.datasetKey, projectId);
  if (!dataset) throw new Error(`Evaluation dataset "${suite.datasetKey}" not found`);

  // Guard against duplicate/concurrent runs of the same suite. Reject if a
  // recent run is still in progress; stale 'running' rows (>1h, from a hard
  // crash) are ignored so a suite can never get permanently locked.
  const inFlight = await db.listEvaluationRuns({ projectId, suiteKey: suite.key, status: 'running', limit: 1 });
  const recentStart = inFlight[0]?.startedAt ? new Date(inFlight[0].startedAt).getTime() : 0;
  if (inFlight.length > 0 && Date.now() - recentStart < 60 * 60 * 1000) {
    throw new Error(`A run for suite "${suite.key}" is already in progress`);
  }

  const run = await db.createEvaluationRun({
    tenantId,
    projectId,
    suiteKey: suite.key,
    targetKey: target.key,
    datasetKey: dataset.key,
    status: 'pending',
    mode,
    progress: { total: dataset.items.length, completed: 0, failed: 0 },
    items: [],
    createdBy,
  });
  return toView(run);
}

/**
 * Execute an already-created run to completion. Loads suite/target/dataset
 * fresh (so the queue payload stays tiny), marks the run running, drives the
 * engine, and persists the result. Throws on a fatal error so the queue can
 * record/retry; per-item errors never abort.
 */
export async function executeRun(
  params: RunSuiteParams & { runId: string },
  deps: RunSuiteDeps = {},
): Promise<WithId<IEvaluationRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, suiteKey, runId } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  try {
    const suite = await db.findEvaluationSuiteByKey(suiteKey, projectId);
    if (!suite) throw new Error(`Evaluation suite "${suiteKey}" not found`);
    const target = await db.findEvaluationTargetByKey(suite.targetKey, projectId);
    if (!target) throw new Error(`Evaluation target "${suite.targetKey}" not found`);
    const dataset = await db.findEvaluationDatasetByKey(suite.datasetKey, projectId);
    if (!dataset) throw new Error(`Evaluation dataset "${suite.datasetKey}" not found`);

    const items: DatasetItem[] = dataset.items.map((it) => ({
      id: it.id,
      input: it.input,
      expected: it.expected as DatasetItem['expected'],
      tags: it.tags,
    }));
    const scorers: ScorerConfig[] = suite.scorers.map(mapScorer);

    await db.updateEvaluationRun(runId, { status: 'running', startedAt: new Date() });

    const ctx: EvaluationModelContext = { tenantDbName, tenantId, projectId: projectId ?? '', userId: createdBy };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const makeEmbed = deps.buildEmbedInvoker ?? buildEmbedInvoker;
    const needJudge = scorers.some((s) => s.type === 'llm-judge');
    const needEmbed = scorers.some((s) => s.type === 'semantic');

    // Persist incremental progress so the dashboard can show step-by-step
    // results live (throttled to avoid hammering the DB on large datasets).
    const partial: RunItemResult[] = [];
    let lastFlush = 0;
    const result = await runEvaluation({
      items,
      scorers,
      invokeTarget: makeTarget(target, ctx),
      invokeJudge: needJudge ? makeJudge(suite.judgeModelKey, ctx) : undefined,
      invokeEmbed: needEmbed ? makeEmbed(suite.embeddingModelKey, ctx) : undefined,
      config: { concurrency: suite.runConfig?.concurrency },
      onItem: (item) => {
        partial.push(item);
        const now = Date.now();
        if (now - lastFlush >= 1500) {
          lastFlush = now;
          const completed = partial.filter((p) => !p.error).length;
          const failed = partial.filter((p) => p.error).length;
          void db
            .updateEvaluationRun(runId, {
              progress: { total: items.length, completed, failed },
              items: partial.map(toRunItem),
            })
            .catch(() => {});
        }
      },
    });

    const updated = await db.updateEvaluationRun(runId, {
      status: 'completed',
      progress: {
        total: result.aggregate.total,
        completed: result.aggregate.completed,
        failed: result.aggregate.failed,
      },
      aggregate: result.aggregate,
      items: result.items.map(toRunItem),
      finishedAt: new Date(),
    });
    return toView(updated ?? (await db.findEvaluationRunById(runId))!);
  } catch (err) {
    await db.updateEvaluationRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      finishedAt: new Date(),
    });
    throw err;
  }
}

/** Synchronous run (tests / client API): create + execute, blocks to completion. */
export async function runSuite(params: RunSuiteParams, deps: RunSuiteDeps = {}): Promise<WithId<IEvaluationRun>> {
  const run = await createPendingRun(params, 'sync');
  return executeRun({ ...params, runId: run.id }, deps);
}

/** Create a pending run and return it immediately for the caller to enqueue. */
export async function createAsyncRun(params: RunSuiteParams): Promise<WithId<IEvaluationRun>> {
  return createPendingRun(params, 'async');
}
