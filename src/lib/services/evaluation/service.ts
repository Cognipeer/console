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
  IEvaluationDatasetItemRecord,
  IEvaluationSuite,
  IEvaluationScorerConfig,
  IEvaluationRun,
  IEvaluationRunItem,
  EvaluationTargetKind,
  EvaluationDatasetSource,
  EvaluationTurnMode,
  EvaluationDatasetItemQuery,
} from '@/lib/database';
import { runEvaluation } from './runner';
import { EMBEDDING_SCORERS, JUDGE_SCORERS } from './scorers';
import { compareEvaluationRuns, type EvalComparison } from './compare';
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
  if (config.type === 'tool-call') {
    return {
      type: 'tool-call',
      weight: config.weight,
      threshold: config.threshold,
      selectionWeight: config.selectionWeight,
      sequenceWeight: config.sequenceWeight,
      argsWeight: config.argsWeight,
    };
  }
  if (config.type === 'context-recall') {
    return { type: 'context-recall', weight: config.weight, threshold: config.threshold };
  }
  if (config.type === 'context-precision') {
    return { type: 'context-precision', weight: config.weight, threshold: config.threshold };
  }
  if (config.type === 'groundedness') {
    return { type: 'groundedness', weight: config.weight, threshold: config.threshold };
  }
  return { type: 'assertion', weight: config.weight };
}

/** Turn evidence kept per item on a `perTurn` run (a run is one document). */
const EVAL_RUN_TURNS_CAP = 20;
const EVAL_RUN_TURN_TEXT_CAP = 4000;

/**
 * Persisted output text for a RETRIEVAL item. A model answer is bounded by the
 * provider's output limit; a concatenation of topK chunks is bounded by
 * nothing, and a run is ONE document — a few hundred items of unbounded
 * context is how a run hits the 16MB ceiling and fails to save at all. The
 * chunk ids and scores behind the number survive on each score's `detail`.
 */
const EVAL_RUN_RETRIEVAL_TEXT_CAP = 8000;

function toRunItem(result: RunItemResult): IEvaluationRunItem {
  return {
    itemId: result.itemId,
    output: result.output
      ? {
          text: result.output.retrieved
            ? result.output.text.slice(0, EVAL_RUN_RETRIEVAL_TEXT_CAP)
            : result.output.text,
          latencyMs: result.output.latencyMs,
          toolCalls: result.output.toolCalls,
          // A run is ONE document; a long conversation replayed per turn would
          // otherwise put unbounded transcript on every item.
          ...(result.output.turns?.length
            ? {
                turns: result.output.turns.slice(0, EVAL_RUN_TURNS_CAP).map((turn) => ({
                  index: turn.index,
                  question: turn.question,
                  text: turn.text.slice(0, EVAL_RUN_TURN_TEXT_CAP),
                  ...(turn.toolCalls?.length ? { toolCalls: turn.toolCalls } : {}),
                  ...(turn.latencyMs !== undefined ? { latencyMs: turn.latencyMs } : {}),
                })),
              }
            : {}),
        }
      : undefined,
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
    usage: result.usage,
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
  /** `rag` targets: which Knowledge Engine module to retrieve from, and how much. */
  ragModuleKey?: string;
  retrievalTopK?: number;
  retrievalMinScore?: number;
  /** System-prompt override (model targets only) — see IEvaluationTarget. */
  systemPrompt?: string;
  promptKey?: string;
  promptVersion?: number;
  responseFormat?: Record<string, unknown>;
  maxTokens?: number;
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
    ragModuleKey: input.ragModuleKey,
    retrievalTopK: input.retrievalTopK,
    retrievalMinScore: input.retrievalMinScore,
    systemPrompt: input.systemPrompt,
    promptKey: input.promptKey,
    promptVersion: input.promptVersion,
    responseFormat: input.responseFormat,
    maxTokens: input.maxTokens,
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

/**
 * Which items a clone carries over. Everything here is a filter on labels or
 * expectations, because those are the axes that decide whether a slice is
 * worth testing against — see `cloneDataset`.
 */
export interface CloneDatasetFilter {
  /** Keep items carrying this label; omit `value` to mean "has the key at all". */
  label?: { key: string; value?: string };
  /** true → only labeled items; false → only unlabeled ones. */
  labeled?: boolean;
  /**
   * Who labeled the item. `human` is the golden-set filter: an AI labeling run
   * is a hypothesis, a reviewer's correction is ground truth.
   */
  labelSource?: 'human' | 'ai';
  /** Keep items carrying ALL of these free-form tags. */
  tags?: string[];
  /**
   * Keep only items that carry a reference output or expectations. A golden
   * set exists to be graded against, and an item with nothing to compare to
   * scores 0 for every reference-based scorer — silently dragging the suite's
   * pass rate down rather than being excluded.
   */
  requireExpected?: boolean;
  /** Cap on cloned items (also bounded by CLONE_MAX_ITEMS). */
  limit?: number;
}

export interface CloneDatasetInput {
  name: string;
  description?: string;
  projectId?: string;
  filter?: CloneDatasetFilter;
  /** Extra tags stamped on every cloned item, e.g. `['golden']`. */
  tags?: string[];
}

export interface CloneDatasetResult {
  dataset: WithId<IEvaluationDataset>;
  /** Items in the source dataset that were scanned. */
  scanned: number;
  /** Items that passed the filter and were copied. */
  copied: number;
  /** True when the scan stopped at the cap — `scanned` is a lower bound. */
  truncated: boolean;
}

/** Hard ceiling on a clone, so one call cannot copy an unbounded corpus. */
const CLONE_MAX_ITEMS = 5000;

/**
 * Copy a filtered slice of a dataset into a NEW dataset.
 *
 * This is what turns labeling into leverage. An analysis run labels a captured
 * corpus by segment (intent, complexity, language); a reviewer corrects the
 * labels that matter. Cloning the reviewed slice produces a **golden set** — a
 * small, trustworthy dataset that a suite can be run against on every change,
 * without re-running the labeler or hand-curating items.
 *
 * A copy, not a view, and deliberately so: a golden set has to be STABLE. If it
 * tracked the source dataset, tomorrow's traffic capture would silently change
 * what "the regression suite" means, and two runs a week apart would not be
 * comparable. Provenance (source dataset + the exact filter) is recorded in
 * metadata so the slice can be reproduced or refreshed on purpose.
 *
 * Item ids are preserved, so a cloned item can be traced back to its source and
 * compared run to run.
 */
export async function cloneDataset(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  sourceDatasetId: string,
  input: CloneDatasetInput,
): Promise<CloneDatasetResult> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const source = await db.findEvaluationDatasetById(sourceDatasetId);
  if (!source) throw new Error('Dataset not found');

  const filter = input.filter ?? {};
  const limit = Math.min(filter.limit ?? CLONE_MAX_ITEMS, CLONE_MAX_ITEMS);
  const extraTags = (input.tags ?? []).filter((tag) => typeof tag === 'string' && tag.trim() !== '');

  // Label filters push down to the provider; the rest are applied here, since
  // neither backend indexes tags or expectations.
  const query = {
    ...(filter.label ? { label: filter.label } : {}),
    ...(filter.labeled !== undefined ? { labeled: filter.labeled } : {}),
  };

  const items: IEvaluationDatasetItem[] = [];
  let scanned = 0;
  let truncated = false;
  for (let skip = 0; items.length < limit; skip += DATASET_ITEM_PAGE_SIZE) {
    if (scanned >= CLONE_MAX_ITEMS) { truncated = true; break; }
    const page = await db.listEvaluationDatasetItems(sourceDatasetId, {
      ...query,
      skip,
      limit: DATASET_ITEM_PAGE_SIZE,
    });
    scanned += page.length;
    for (const record of page) {
      if (items.length >= limit) break;
      if (!matchesCloneFilter(record, filter)) continue;
      const item = toDatasetItemView(record);
      items.push(
        extraTags.length > 0
          ? { ...item, tags: Array.from(new Set([...(item.tags ?? []), ...extraTags])) }
          : item,
      );
    }
    if (page.length < DATASET_ITEM_PAGE_SIZE) break;
  }

  if (items.length === 0) {
    throw new Error('No items matched the clone filter — nothing to copy.');
  }

  const dataset = await createDataset(tenantDbName, tenantId, createdBy, {
    name: input.name,
    description: input.description,
    // 'imported' rather than 'generated': nothing was synthesized here, the
    // items came from an existing dataset.
    source: 'imported',
    items,
    projectId: input.projectId ?? source.projectId,
    metadata: {
      clonedFrom: {
        datasetId: sourceDatasetId,
        datasetKey: source.key,
        datasetName: source.name,
        filter,
        clonedAt: new Date().toISOString(),
      },
    },
  });

  return { dataset, scanned, copied: items.length, truncated };
}

/** The clone filters the providers do not index: tags, label source, expectations. */
function matchesCloneFilter(item: IEvaluationDatasetItem, filter: CloneDatasetFilter): boolean {
  if (filter.labelSource && item.labelMeta?.source !== filter.labelSource) return false;
  if (filter.tags && filter.tags.length > 0) {
    const tags = new Set(item.tags ?? []);
    if (!filter.tags.every((tag) => tags.has(tag))) return false;
  }
  if (filter.requireExpected) {
    const expected = item.expected as Record<string, unknown> | undefined;
    if (!expected || Object.keys(expected).length === 0) return false;
  }
  return true;
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

// ── Dataset items ──────────────────────────────────────────────────────────

/** Page size used when the engine needs every item of a dataset. */
const DATASET_ITEM_PAGE_SIZE = 200;

/** One page of dataset items plus the dataset's total item count. */
export async function listDatasetItems(
  tenantDbName: string,
  datasetId: string,
  options?: EvaluationDatasetItemQuery,
): Promise<{ items: IEvaluationDatasetItem[]; total: number }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const [records, total] = await Promise.all([
    db.listEvaluationDatasetItems(datasetId, options),
    db.countEvaluationDatasetItems(datasetId, options?.search, {
      label: options?.label,
      labeled: options?.labeled,
    }),
  ]);
  return { items: records.map(toDatasetItemView), total };
}

/** Append items to a dataset. Rejects duplicate item ids. */
export async function appendDatasetItems(
  tenantDbName: string,
  datasetId: string,
  items: IEvaluationDatasetItem[],
): Promise<{ added: number; total: number }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const added = await db.createEvaluationDatasetItems(datasetId, items);
  const total = await db.countEvaluationDatasetItems(datasetId);
  return { added, total };
}

export async function getDatasetItem(
  tenantDbName: string,
  datasetId: string,
  itemId: string,
): Promise<IEvaluationDatasetItem | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationDatasetItem(datasetId, itemId);
  return record ? toDatasetItemView(record) : null;
}

/** Update one dataset item in place (item id itself is immutable). */
export async function updateDatasetItem(
  tenantDbName: string,
  datasetId: string,
  itemId: string,
  data: Partial<Omit<IEvaluationDatasetItem, 'id'>>,
): Promise<IEvaluationDatasetItem | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateEvaluationDatasetItem(datasetId, itemId, data);
  return updated ? toDatasetItemView(updated) : null;
}

export async function deleteDatasetItem(
  tenantDbName: string,
  datasetId: string,
  itemId: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteEvaluationDatasetItem(datasetId, itemId);
}

/** Strip storage fields off an item record for API/engine consumption. */
function toDatasetItemView(record: IEvaluationDatasetItemRecord): IEvaluationDatasetItem {
  return {
    id: record.id,
    input: record.input,
    ...(record.expected != null ? { expected: record.expected } : {}),
    ...(record.tools != null ? { tools: record.tools } : {}),
    ...(record.toolResults != null ? { toolResults: record.toolResults } : {}),
    ...(record.responseFormat != null ? { responseFormat: record.responseFormat } : {}),
    ...(record.tags != null ? { tags: record.tags } : {}),
    ...(record.labels != null ? { labels: record.labels } : {}),
    ...(record.labelMeta != null ? { labelMeta: record.labelMeta } : {}),
  };
}

/** Load EVERY item of a dataset, paging through the item collection. */
async function loadAllDatasetItems(
  db: Awaited<ReturnType<typeof getDatabase>>,
  datasetId: string,
): Promise<IEvaluationDatasetItem[]> {
  const all: IEvaluationDatasetItem[] = [];
  for (let skip = 0; ; skip += DATASET_ITEM_PAGE_SIZE) {
    const page = await db.listEvaluationDatasetItems(datasetId, { skip, limit: DATASET_ITEM_PAGE_SIZE });
    all.push(...page.map(toDatasetItemView));
    if (page.length < DATASET_ITEM_PAGE_SIZE) return all;
  }
}

/**
 * Label-only projection of every item, for the distribution summary. Transcripts
 * dominate an item's size and the summary never looks at them, so each page is
 * reduced to its label fields before being accumulated — scanning a large
 * dataset costs a few hundred bytes per item instead of the whole corpus.
 */
export async function listAllDatasetItemLabels(
  tenantDbName: string,
  datasetId: string,
  max = Number.POSITIVE_INFINITY,
): Promise<Array<Pick<IEvaluationDatasetItem, 'id' | 'labels' | 'labelMeta'>>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const all: Array<Pick<IEvaluationDatasetItem, 'id' | 'labels' | 'labelMeta'>> = [];
  for (let skip = 0; all.length < max; skip += DATASET_ITEM_PAGE_SIZE) {
    const page = await db.listEvaluationDatasetItems(datasetId, { skip, limit: DATASET_ITEM_PAGE_SIZE });
    for (const record of page) {
      all.push({
        id: record.id,
        ...(record.labels != null ? { labels: record.labels } : {}),
        ...(record.labelMeta != null ? { labelMeta: record.labelMeta } : {}),
      });
    }
    if (page.length < DATASET_ITEM_PAGE_SIZE) break;
  }
  return all.length > max ? all.slice(0, max) : all;
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
  runConfig?: { concurrency?: number; turnMode?: EvaluationTurnMode };
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

/**
 * Diff a run against a baseline run (typically an earlier run of the same
 * suite). Returns null if either run is missing.
 */
export async function compareRuns(
  tenantDbName: string,
  runId: string,
  baselineRunId: string,
): Promise<EvalComparison | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const [current, baseline] = await Promise.all([
    db.findEvaluationRunById(runId),
    db.findEvaluationRunById(baselineRunId),
  ]);
  if (!current || !baseline) return null;
  return compareEvaluationRuns(baseline, current);
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

/**
 * `perTurn` walks a conversation, feeds the model its own answers back, and
 * grades the LAST one. Retrieval has no conversation to walk: the mode would
 * fire one query per user turn, throw away every result but the final one, and
 * report a score that says nothing about the turns it paid for. Refuse the
 * combination instead of quietly producing that number.
 */
function assertTurnModeSupported(target: IEvaluationTarget, turnMode: EvaluationTurnMode | undefined): void {
  if (target.kind === 'rag' && turnMode === 'perTurn') {
    throw new Error(
      `Evaluation target "${target.key}" retrieves, which the "perTurn" replay mode does not support — retrieval answers one query per item. Set the suite's replay mode to "single".`,
    );
  }
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
  assertTurnModeSupported(target, suite.runConfig?.turnMode);

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
    progress: {
      total: dataset.itemCount ?? (await db.countEvaluationDatasetItems(String(dataset._id))),
      completed: 0,
      failed: 0,
    },
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
    // Re-checked here and not only at enqueue time: a queued run reloads the
    // suite, so an edit made while it waited must not slip past the guard.
    assertTurnModeSupported(target, suite.runConfig?.turnMode);

    const datasetItems = await loadAllDatasetItems(db, String(dataset._id));
    const items: DatasetItem[] = datasetItems.map((it) => ({
      id: it.id,
      input: it.input,
      expected: it.expected as DatasetItem['expected'],
      tools: it.tools,
      toolResults: it.toolResults,
      responseFormat: it.responseFormat,
      tags: it.tags,
    }));
    const scorers: ScorerConfig[] = suite.scorers.map(mapScorer);

    await db.updateEvaluationRun(runId, { status: 'running', startedAt: new Date() });

    const ctx: EvaluationModelContext = { tenantDbName, tenantId, projectId: projectId ?? '', userId: createdBy };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const makeEmbed = deps.buildEmbedInvoker ?? buildEmbedInvoker;
    // Asked of the scorer registry, never of a hardcoded list: an
    // embedding-backed scorer left out of it runs with `invokeEmbed:
    // undefined` and scores every item 0 with 'no embed invoker configured'.
    const needJudge = scorers.some((s) => JUDGE_SCORERS.includes(s.type));
    const needEmbed = scorers.some((s) => EMBEDDING_SCORERS.includes(s.type));

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
      config: { concurrency: suite.runConfig?.concurrency, turnMode: suite.runConfig?.turnMode },
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
