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
import { buildJudgeInvoker, buildTargetInvoker, type EvaluationModelContext } from './adapters';

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
  data: Partial<Pick<IEvaluationDataset, 'name' | 'description' | 'source' | 'items' | 'projectId'>>,
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
  data: Partial<Pick<IEvaluationSuite, 'name' | 'description' | 'targetKey' | 'datasetKey' | 'scorers' | 'judgeModelKey' | 'runConfig' | 'projectId'>>,
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
}

export async function runSuite(
  params: { tenantDbName: string; tenantId: string; projectId?: string; createdBy: string; suiteKey: string },
  deps: RunSuiteDeps = {},
): Promise<WithId<IEvaluationRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, suiteKey } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

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

  const run = await db.createEvaluationRun({
    tenantId,
    projectId,
    suiteKey: suite.key,
    targetKey: target.key,
    datasetKey: dataset.key,
    status: 'running',
    mode: 'sync',
    progress: { total: items.length, completed: 0, failed: 0 },
    items: [],
    createdBy,
    startedAt: new Date(),
  });
  const runId = toView(run).id;

  try {
    const ctx: EvaluationModelContext = { tenantDbName, tenantId, projectId: projectId ?? '' };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const needJudge = scorers.some((s) => s.type === 'llm-judge');

    const result = await runEvaluation({
      items,
      scorers,
      invokeTarget: makeTarget(target, ctx),
      invokeJudge: needJudge ? makeJudge(suite.judgeModelKey, ctx) : undefined,
      config: { concurrency: suite.runConfig?.concurrency },
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
    return toView(updated ?? run);
  } catch (err) {
    await db.updateEvaluationRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      finishedAt: new Date(),
    });
    throw err;
  }
}
