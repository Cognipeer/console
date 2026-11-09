/**
 * Evaluation service — tenant-scoped CRUD over targets / datasets / suites /
 * runs, plus `runSuite` which loads a suite, builds live invokers, drives the
 * pure engine runner, and persists the run + aggregate.
 *
 * Target/judge invokers are injectable (RunSuiteDeps) so the orchestration is
 * testable without live model calls.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
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
  AgentRevision,
  IAgentRunRevision,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { runEvaluation } from './runner';
import { EvaluationConflictError, EvaluationInputError } from './errors';
import { KnowledgeExposure, runWithKnowledgeExposure } from '@/lib/services/rag/access/exposure';
import { EMBEDDING_SCORERS, JUDGE_SCORERS } from './scorers';
import { compareEvaluationRuns, type EvalComparison } from './compare';
import type { DatasetItem, RunItemResult, ScorerConfig } from './types';
import { buildEmbedInvoker, buildJudgeInvoker, buildTargetInvoker, type EvaluationModelContext } from './adapters';
import { sameAgentRevision, agentRevisionLabel, storedAgentRevision } from '@/lib/shared/agentRevision';
import {
  AgentRevisionError,
  assertAgentRevisionRunnable,
  startAgentRevision,
  type StartedAgentRevision,
} from '@/lib/services/agents/agentRevision';

const logger = createLogger('evaluation:service');

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
  // Optional keys are spread only when present: a stored scorer written before
  // `applyWhen` existed (or read back from Mongo with a null) means "always applies".
  const base = config.applyWhen ? { applyWhen: config.applyWhen } : {};
  if (config.type === 'llm-judge') {
    return { type: 'llm-judge', weight: config.weight, rubric: config.rubric ?? '', threshold: config.threshold, ...base };
  }
  if (config.type === 'semantic') {
    return { type: 'semantic', weight: config.weight, threshold: config.threshold, ...base };
  }
  if (config.type === 'tool-call') {
    return {
      type: 'tool-call',
      weight: config.weight,
      threshold: config.threshold,
      selectionWeight: config.selectionWeight,
      sequenceWeight: config.sequenceWeight,
      argsWeight: config.argsWeight,
      ...(typeof config.allowExtraCalls === 'boolean' ? { allowExtraCalls: config.allowExtraCalls } : {}),
      ...base,
    };
  }
  if (config.type === 'json-shape') {
    // Without this branch a json-shape scorer fell through to `assertion` and
    // silently graded something else.
    return {
      type: 'json-shape',
      weight: config.weight,
      threshold: config.threshold,
      ...(typeof config.strict === 'boolean' ? { strict: config.strict } : {}),
      ...base,
    };
  }
  if (config.type === 'context-recall') {
    return { type: 'context-recall', weight: config.weight, threshold: config.threshold, ...base };
  }
  if (config.type === 'context-precision') {
    return { type: 'context-precision', weight: config.weight, threshold: config.threshold, ...base };
  }
  if (config.type === 'groundedness') {
    return { type: 'groundedness', weight: config.weight, threshold: config.threshold, ...base };
  }
  return { type: 'assertion', weight: config.weight, ...base };
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

// Persistence caps (spec F). They apply ONLY when a result is written to the
// run document, never inside `runEvaluation`: the in-memory result stays whole
// (the EE optimizer reads it).
const EVAL_RUN_TEXT_CAP = 20000;
const EVAL_RUN_ERROR_CAP = 2000;
const EVAL_RUN_DETAIL_CAP = 4096;
const EVAL_RUN_REASONING_CAP = 2000;
const EVAL_RUN_REASON_CAP = 500;
const EVAL_RUN_TOOL_CALLS_CAP = 32;
const EVAL_RUN_TOOL_ARGS_CAP = 4096;
const EVAL_RUN_TOOL_ARGS_PREVIEW = 500;
/** Whole-run guard: serialized items above this are degraded before the write (Mongo's limit is 16MB). */
const EVAL_RUN_ITEMS_BYTES_CAP = 8 * 1024 * 1024;
/** After the guard strips output text, this much of it is kept. */
const EVAL_RUN_DEGRADED_TEXT_CAP = 1000;

/** A running run whose last sign of life is older than this no longer blocks a new one. */
const EVAL_RUN_RUNNING_GUARD_MS = 60 * 60 * 1000;
/** Progress counts are flushed at most this often; the items array less often still. */
const EVAL_RUN_PROGRESS_FLUSH_MS = 1_500;
const EVAL_RUN_ITEMS_FLUSH_MS = 5_000;

/** `EVALUATION_RUN_CANCEL_POLL_MS` (default 5 s) is how often a running executor looks for a cancel request. */
function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A copy of `value` without its `undefined` members (a store would persist them as null). */
function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/** A pending run older than this is treated as lost (the reconciler fails it). */
export const EVAL_RUN_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function capString(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/** Serialized length, or Infinity when the value cannot be serialized (a cycle, a BigInt). */
function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Stored tool calls: at most 32, each `args` at most 4 KB serialized (else a marker object with a preview). */
export function capToolCalls(
  calls: ReadonlyArray<{ name: string; args?: Record<string, unknown> | null }> | undefined,
): Array<{ name: string; args: Record<string, unknown> }> {
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, EVAL_RUN_TOOL_CALLS_CAP).map((call) => {
    const args = call.args ?? {};
    if (serializedSize(args) <= EVAL_RUN_TOOL_ARGS_CAP) return { name: call.name, args };
    let preview = '';
    try {
      preview = (JSON.stringify(args) ?? '').slice(0, EVAL_RUN_TOOL_ARGS_PREVIEW);
    } catch {
      preview = '';
    }
    return { name: call.name, args: { __truncated: true, preview } };
  });
}

/**
 * The part of a score detail that survives shrinking: the judge's reasoning
 * (capped), the verdict inputs, and every numeric field. Chunk lists, per-call
 * breakdowns and the like are what make a detail large.
 */
function whitelistScoreDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value;
  }
  if (typeof detail.reasoning === 'string') kept.reasoning = detail.reasoning.slice(0, EVAL_RUN_REASONING_CAP);
  if (typeof detail.reason === 'string') kept.reason = detail.reason.slice(0, EVAL_RUN_REASON_CAP);
  if (typeof detail.judgePassed === 'boolean') kept.judgePassed = detail.judgePassed;
  kept.truncated = true;
  return kept;
}

/** A score detail as stored: untouched while it fits ~4 KB, otherwise its whitelisted core plus `truncated: true`. */
export function capScoreDetail(detail: Record<string, unknown> | undefined | null): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object') return undefined;
  return serializedSize(detail) <= EVAL_RUN_DETAIL_CAP ? detail : whitelistScoreDetail(detail);
}

/** The run item as stored — optional keys are present only when they have a value (Mongo turns `undefined` into null). */
export function toRunItem(result: RunItemResult): IEvaluationRunItem {
  const output = result.output;
  const error = capString(result.error, EVAL_RUN_ERROR_CAP);
  return {
    itemId: result.itemId,
    ...(output
      ? {
          output: {
            text:
              capString(output.text ?? '', output.retrieved ? EVAL_RUN_RETRIEVAL_TEXT_CAP : EVAL_RUN_TEXT_CAP) ?? '',
            ...(output.latencyMs !== undefined ? { latencyMs: output.latencyMs } : {}),
            ...(Array.isArray(output.toolCalls) ? { toolCalls: capToolCalls(output.toolCalls) } : {}),
            ...(output.truncated ? { truncated: true } : {}),
            // A run is ONE document; a long conversation replayed per turn would
            // otherwise put unbounded transcript on every item.
            ...(output.turns?.length
              ? {
                  turns: output.turns.slice(0, EVAL_RUN_TURNS_CAP).map((turn) => ({
                    index: turn.index,
                    question: turn.question,
                    text: turn.text.slice(0, EVAL_RUN_TURN_TEXT_CAP),
                    ...(turn.toolCalls?.length ? { toolCalls: capToolCalls(turn.toolCalls) } : {}),
                    ...(turn.latencyMs !== undefined ? { latencyMs: turn.latencyMs } : {}),
                    ...(turn.usage ? { usage: turn.usage } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
    scores: result.scores.map((s) => {
      const detail = capScoreDetail(s.detail);
      const scoreError = capString(s.error, EVAL_RUN_ERROR_CAP);
      return {
        scorerType: s.scorerType,
        score: s.score,
        passed: s.passed,
        weight: s.weight,
        ...(detail ? { detail } : {}),
        ...(scoreError ? { error: scoreError } : {}),
        ...(s.skipped ? { skipped: true } : {}),
        ...(s.usage ? { usage: s.usage } : {}),
      };
    }),
    score: result.score,
    passed: result.passed,
    ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    ...(error ? { error } : {}),
    ...(result.skipped ? { skipped: true } : {}),
    ...(result.scoringUsage ? { scoringUsage: result.scoringUsage } : {}),
    ...(result.kbRestricted?.length ? { kbRestricted: result.kbRestricted } : {}),
  };
}

/**
 * Whole-run guard before a write: a run is one document, and items past ~8 MB
 * would make the write fail and lose the run's spend. Degrade in steps — score
 * details down to their whitelisted core, then output text to 1000 chars with
 * the turns dropped, then no items at all — and say so through `degraded`
 * (stored as `itemsTruncated`). The aggregate is never touched.
 */
export function fitRunItems(items: IEvaluationRunItem[]): { items: IEvaluationRunItem[]; degraded: boolean } {
  if (serializedSize(items) <= EVAL_RUN_ITEMS_BYTES_CAP) return { items, degraded: false };

  const slim = items.map((item) => ({
    ...item,
    scores: item.scores.map((s) => (s.detail ? { ...s, detail: whitelistScoreDetail(s.detail) } : s)),
  }));
  if (serializedSize(slim) <= EVAL_RUN_ITEMS_BYTES_CAP) return { items: slim, degraded: true };

  const minimal = slim.map((item) => {
    if (!item.output) return item;
    const rest = { ...item.output };
    delete rest.turns;
    return { ...item, output: { ...rest, text: rest.text.slice(0, EVAL_RUN_DEGRADED_TEXT_CAP) } };
  });
  if (serializedSize(minimal) <= EVAL_RUN_ITEMS_BYTES_CAP) return { items: minimal, degraded: true };

  return { items: [], degraded: true };
}

// ── Targets ────────────────────────────────────────────────────────────────

export interface CreateTargetInput {
  name: string;
  description?: string;
  kind: EvaluationTargetKind;
  agentKey?: string;
  /** Default revision of an agent target: a published version, the saved draft, or absent/null to follow the published one. */
  agentVersion?: number | 'draft' | null;
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
    // Agent targets only, and only a real pin: absent already means "follow the published version".
    ...(input.kind === 'agent' && input.agentVersion != null ? { agentVersion: input.agentVersion } : {}),
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

/** Target fields a PATCH may clear by sending `null`. */
type ClearableTargetField =
  | 'description'
  | 'retrievalTopK'
  | 'retrievalMinScore'
  | 'systemPrompt'
  | 'promptKey'
  | 'promptVersion'
  | 'responseFormat'
  | 'maxTokens'
  | 'defaultParams';

/**
 * A target PATCH: a key that is absent leaves the stored value alone (never
 * pass `undefined` for it), and `null` clears an optional one. Both providers
 * read it that way.
 */
export type UpdateTargetInput = Partial<
  Omit<IEvaluationTarget, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt' | 'updatedAt' | ClearableTargetField>
> & { [K in ClearableTargetField]?: IEvaluationTarget[K] | null };

export async function updateTarget(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: UpdateTargetInput,
): Promise<WithId<IEvaluationTarget> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // The provider type has no `null` for an optional field, but both mixins store one as a cleared value.
  const updated = await db.updateEvaluationTarget(id, { ...data, updatedBy } as Parameters<typeof db.updateEvaluationTarget>[1]);
  return updated ? toView(updated) : null;
}

/** Suites of the same project that name `key` through `field`. */
async function suitesReferencing(
  db: Awaited<ReturnType<typeof getDatabase>>,
  owner: { projectId?: string | null; key: string },
  field: 'targetKey' | 'datasetKey',
): Promise<IEvaluationSuite[]> {
  const suites = await db.listEvaluationSuites({ [field]: owner.key });
  return suites.filter(
    (suite) => suite[field] === owner.key && (suite.projectId ?? null) === (owner.projectId ?? null),
  );
}

function referencedByMessage(kind: 'target' | 'dataset', key: string, suites: IEvaluationSuite[]): string {
  const names = suites.slice(0, 5).map((suite) => `"${suite.key}"`).join(', ');
  const more = suites.length > 5 ? ` and ${suites.length - 5} more` : '';
  return `The ${kind} "${key}" is still used by ${suites.length === 1 ? 'suite' : 'suites'} ${names}${more}; change or delete ${suites.length === 1 ? 'it' : 'them'} first`;
}

export async function deleteTarget(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const target = await db.findEvaluationTargetById(id);
  if (target) {
    const suites = await suitesReferencing(db, target, 'targetKey');
    if (suites.length > 0) throw new EvaluationConflictError(referencedByMessage('target', target.key, suites));
  }
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

/**
 * Merge top-level metadata blocks into a dataset atomically (a value of
 * `undefined` unsets that block). Used where a writer owns ONE block
 * (`labeling`, `generation`, `parity`, ...): replacing the whole `metadata`
 * would erase what a concurrent writer put in another block.
 */
export async function patchDatasetMetadata(
  tenantDbName: string,
  id: string,
  patch: Record<string, unknown>,
  opts?: { unlessParityStatusIn?: string[] },
): Promise<WithId<IEvaluationDataset> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.patchEvaluationDatasetMetadata(id, patch, opts);
  return updated ? toView(updated) : null;
}

export async function deleteDataset(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const dataset = await db.findEvaluationDatasetById(id);
  if (dataset) {
    const suites = await suitesReferencing(db, dataset, 'datasetKey');
    if (suites.length > 0) throw new EvaluationConflictError(referencedByMessage('dataset', dataset.key, suites));
  }
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

/**
 * A suite PATCH: a key that is absent leaves the stored value alone (never pass
 * `undefined` for it), and `null` clears the description or a model key.
 */
export type UpdateSuiteInput = Partial<
  Pick<IEvaluationSuite, 'name' | 'targetKey' | 'datasetKey' | 'scorers' | 'runConfig' | 'projectId'>
> & {
  description?: string | null;
  judgeModelKey?: string | null;
  embeddingModelKey?: string | null;
};

export async function updateSuite(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: UpdateSuiteInput,
): Promise<WithId<IEvaluationSuite> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  // The provider type has no `null` for an optional field, but both mixins store one as a cleared value.
  const updated = await db.updateEvaluationSuite(id, { ...data, updatedBy } as Parameters<typeof db.updateEvaluationSuite>[1]);
  return updated ? toView(updated) : null;
}

export async function deleteSuite(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const suite = await db.findEvaluationSuiteById(id);
  if (suite) {
    // Deleting under a live run would leave it failing on "suite not found" halfway through.
    const active = await db.listEvaluationRuns({
      projectId: suite.projectId,
      suiteKey: suite.key,
      statuses: ['pending', 'running'],
      limit: 1,
    });
    if (active.length > 0) {
      throw new EvaluationConflictError(
        `Suite "${suite.key}" has a run in progress; cancel it or wait for it to finish before deleting the suite`,
      );
    }
  }
  return db.deleteEvaluationSuite(id);
}

// ── Runs ───────────────────────────────────────────────────────────────────

export async function listRuns(
  tenantDbName: string,
  filters?: { projectId?: string; suiteKey?: string; status?: IEvaluationRun['status']; limit?: number; skip?: number },
): Promise<WithId<IEvaluationRun>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listEvaluationRuns(filters)).map(toView);
}

/**
 * One page of runs WITHOUT their items (a run is one document and its items are
 * the bulk of it) plus the total for the same filter, so a list view can page.
 */
export async function listRunSummaries(
  tenantDbName: string,
  filters: { projectId?: string; suiteKey?: string; status?: IEvaluationRun['status']; limit?: number; skip?: number },
): Promise<{ runs: WithId<IEvaluationRun>[]; total: number }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const { limit: _limit, skip: _skip, ...countFilters } = filters;
  const [runs, total] = await Promise.all([
    db.listEvaluationRunSummaries(filters),
    db.countEvaluationRuns(countFilters),
  ]);
  return { runs: runs.map(toView), total };
}

export async function getRun(tenantDbName: string, id: string): Promise<WithId<IEvaluationRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findEvaluationRunById(id);
  return record ? toView(record) : null;
}

export type CancelRunOutcome = 'cancelled' | 'cancel_requested' | 'already_finished';

/**
 * Cancel a run. A pending run is cancelled at once (its queued job then fails
 * the claim and does nothing); a running one only records the request — the
 * executing node sees it on its next heartbeat, stops dispatching items, and
 * finalises the run as `cancelled` with what it had. A finished run is
 * returned unchanged. `null` when the run is missing or belongs to another project.
 */
export async function cancelRun(
  tenantDbName: string,
  id: string,
  projectId?: string,
): Promise<{ run: WithId<IEvaluationRun>; outcome: CancelRunOutcome } | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const existing = await db.findEvaluationRunById(id);
  if (!existing) return null;
  if (existing.projectId && existing.projectId !== projectId) return null;

  const updated = await db.requestEvaluationRunCancel(id, new Date());
  if (!updated) return null;

  let outcome: CancelRunOutcome;
  if (updated.status === 'running') outcome = 'cancel_requested';
  else if (updated.status === 'cancelled' && existing.status === 'pending') outcome = 'cancelled';
  else outcome = 'already_finished';
  return { run: toView(updated), outcome };
}

/** Record a run as failed outside the executor (a job that could not be queued). Unconditional: the run has not started. */
export async function markRunFailed(tenantDbName: string, id: string, message: string): Promise<void> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  await db.updateEvaluationRun(id, { status: 'failed', error: capString(message, EVAL_RUN_ERROR_CAP), finishedAt: new Date() });
}

/**
 * Diff a run against a baseline run (typically an earlier run of the same
 * suite). Returns null if either run is missing. Two runs only compare when
 * both finished and graded the same dataset: a pending run has no items, and
 * different datasets share no item ids, so every row would read "added/removed".
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
  for (const [label, run] of [['run', current], ['baseline run', baseline]] as const) {
    if (run.status !== 'completed') {
      throw new EvaluationConflictError(`The ${label} is ${run.status}; only completed runs can be compared`);
    }
  }
  if (current.datasetKey !== baseline.datasetKey) {
    throw new EvaluationConflictError(
      `The runs used different datasets ("${baseline.datasetKey}" and "${current.datasetKey}") and cannot be compared`,
    );
  }
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
  /** The API token a client API call starts the run with: its targets read knowledge bases as the token. */
  apiTokenId?: string;
  suiteKey: string;
  /**
   * Agent targets: run this revision instead of the target's default
   * (`agentVersion`). Refused for any other kind of target.
   */
  agentVersion?: AgentRevision;
  /**
   * Asked once the suite's target is known to be an agent, before anything
   * about the agent is looked at and before a run row is written; it throws to
   * refuse. Only the request that starts a run can answer for its caller, so
   * this is never queued (a scheduler has no caller to ask).
   */
  authorizeAgentRun?: () => Promise<void>;
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
  await assertServiceEnabled({ tenantDbName: params.tenantDbName, tenantId: params.tenantId }, 'evaluations');
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
  // Before the revision check below, which says whether a version exists.
  if (target.kind === 'agent') await params.authorizeAgentRun?.();

  // A run's own request wins over the target's default. Resolved before the
  // guard below, which compares revisions, and checked now so that a version
  // that was never published refuses the run instead of failing every item.
  let agentRevision: IAgentRunRevision | undefined;
  if (target.kind === 'agent' && target.agentKey) {
    const requested = params.agentVersion ?? storedAgentRevision(target.agentVersion);
    await assertAgentRevisionRunnable(tenantDbName, target.agentKey, projectId, requested);
    agentRevision = { requested, agentKey: target.agentKey };
  } else if (params.agentVersion !== undefined && target.kind !== 'agent') {
    throw new AgentRevisionError(
      `Evaluation target "${target.key}" is not an agent target, so a run cannot ask for an agent version`,
    );
  }

  // Guard against duplicate/concurrent runs of the same suite. A run that is
  // pending (queued, within the last 24 h) or running counts. A running row
  // counts while its heartbeat (or start) is under an hour old, so a hard crash
  // can never lock a suite for good. Runs that test different revisions of the
  // agent are not duplicates — comparing the draft with the published version
  // is the point of asking for one — but a run with no recorded revision could
  // be testing anything, so it blocks.
  const suiteKey2 = suite.key;
  const conflicts = (other: IEvaluationRun): boolean => {
    if (other.status === 'running') {
      const alive = Math.max(
        other.heartbeatAt ? new Date(other.heartbeatAt).getTime() : 0,
        other.startedAt ? new Date(other.startedAt).getTime() : 0,
      );
      if (Date.now() - alive >= EVAL_RUN_RUNNING_GUARD_MS) return false;
    } else if (other.status === 'pending') {
      const created = other.createdAt ? new Date(other.createdAt).getTime() : 0;
      if (Date.now() - created >= EVAL_RUN_PENDING_MAX_AGE_MS) return false;
    } else {
      return false;
    }
    return !other.agentRevision || !agentRevision || sameAgentRevision(other.agentRevision.requested, agentRevision.requested);
  };
  const duplicateMessage = `A run for suite "${suiteKey2}" is already in progress${agentRevision ? ` on ${agentRevisionLabel(agentRevision.requested)}` : ''}`;
  const listInFlight = () =>
    db.listEvaluationRuns({ projectId, suiteKey: suiteKey2, statuses: ['pending', 'running'], limit: 50 });
  if ((await listInFlight()).some(conflicts)) throw new EvaluationConflictError(duplicateMessage);

  const total = dataset.itemCount || (await db.countEvaluationDatasetItems(String(dataset._id)));
  if (!total) throw new EvaluationInputError(`Dataset "${dataset.key}" has no items to evaluate`);

  const run = await db.createEvaluationRun({
    tenantId,
    projectId,
    suiteKey: suite.key,
    targetKey: target.key,
    datasetKey: dataset.key,
    status: 'pending',
    mode,
    progress: { total, completed: 0, failed: 0 },
    items: [],
    ...(agentRevision ? { agentRevision } : {}),
    createdBy,
  });

  // The check above and this insert are not one atomic step: two requests can
  // both pass it. Re-read after inserting; of two racing runs the OLDER one
  // (ties broken by id) stays and the newer one withdraws, so exactly one runs.
  const runId = String(run._id);
  const runCreated = run.createdAt ? new Date(run.createdAt).getTime() : Date.now();
  const older = (await listInFlight()).some((other) => {
    const otherId = String(other._id);
    if (otherId === runId || !conflicts(other)) return false;
    // A row without createdAt predates this check: treat it as the older one.
    const otherCreated = other.createdAt ? new Date(other.createdAt).getTime() : 0;
    return otherCreated < runCreated || (otherCreated === runCreated && otherId < runId);
  });
  if (older) {
    await db.updateEvaluationRun(runId, { status: 'failed', error: duplicateMessage, finishedAt: new Date() });
    throw new EvaluationConflictError(duplicateMessage);
  }
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

  // Only one executor may own a run. A duplicate delivery, a run cancelled
  // while it waited, or one the reconciler already failed is left alone — and
  // not thrown, so the queue does not retry it.
  const claimed = await db.claimEvaluationRun(runId, new Date());
  if (!claimed) {
    const stored = await db.findEvaluationRunById(runId);
    if (!stored) throw new Error(`Evaluation run "${runId}" not found`);
    logger.info('Evaluation run not executed: it is not pending', { runId, status: stored.status });
    return toView(stored);
  }

  const heartbeatMs = envMs('EVALUATION_RUN_HEARTBEAT_MS', 30_000);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let cancelTimer: ReturnType<typeof setInterval> | undefined;
  let stopRequested = false;

  try {
    // Inside the try so the run is recorded as failed rather than left running
    // when the service has been switched off since it was queued.
    await assertServiceEnabled({ tenantDbName, tenantId }, 'evaluations');
    const suite = await db.findEvaluationSuiteByKey(suiteKey, projectId);
    if (!suite) throw new Error(`Evaluation suite "${suiteKey}" not found`);
    const target = await db.findEvaluationTargetByKey(suite.targetKey, projectId);
    if (!target) throw new Error(`Evaluation target "${suite.targetKey}" not found`);
    // A run was authorized for the target its suite named when the run was
    // created (an agent target needs Write on Agents, asked then). A suite
    // pointed elsewhere while the run waited would run a target nobody was
    // asked about, so the run stops instead.
    if (claimed.targetKey !== target.key) {
      throw new Error(
        `Suite "${suite.key}" now points at target "${target.key}", not at "${claimed.targetKey}" this run was started for; start the run again`,
      );
    }
    const dataset = await db.findEvaluationDatasetByKey(suite.datasetKey, projectId);
    if (!dataset) throw new Error(`Evaluation dataset "${suite.datasetKey}" not found`);
    // Re-checked here and not only at enqueue time: a queued run reloads the
    // suite, so an edit made while it waited must not slip past the guard.
    assertTurnModeSupported(target, suite.runConfig?.turnMode);

    const datasetItems = await loadAllDatasetItems(db, String(dataset._id));
    if (datasetItems.length === 0) {
      throw new EvaluationInputError(`Dataset "${dataset.key}" has no items to evaluate`);
    }
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

    // Pinned once, as the run starts: `published` becomes the version published
    // right now, so every item runs one config even if someone publishes midway.
    let started: StartedAgentRevision | undefined;
    if (target.kind === 'agent' && target.agentKey) {
      const requested = claimed.agentRevision?.requested ?? params.agentVersion ?? storedAgentRevision(target.agentVersion);
      started = await startAgentRevision(tenantDbName, target.agentKey, projectId, requested);
    }
    if (started) await db.updateEvaluationRun(runId, { agentRevision: started.revision });

    // Liveness + cancellation. The heartbeat tells the reconciler this node is
    // alive; the poll reads `cancelRequestedAt` through the item-less summary
    // listing, so it does not drag a large run document over the wire.
    const suiteKeyForPoll = suite.key;
    heartbeatTimer = setInterval(() => {
      void db.touchEvaluationRun(runId, new Date()).catch(() => {});
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    cancelTimer = setInterval(() => {
      void db
        .listEvaluationRunSummaries({ projectId, suiteKey: suiteKeyForPoll, status: 'running', limit: 50 })
        .then((rows) => {
          if (rows.some((row) => String(row._id) === runId && row.cancelRequestedAt)) stopRequested = true;
        })
        .catch(() => {});
    }, envMs('EVALUATION_RUN_CANCEL_POLL_MS', 5_000));
    cancelTimer.unref?.();

    const ctx: EvaluationModelContext = {
      tenantDbName,
      tenantId,
      projectId: projectId ?? '',
      userId: createdBy,
      ...(params.apiTokenId ? { tokenId: params.apiTokenId } : {}),
    };
    const makeTarget = deps.buildTargetInvoker ?? buildTargetInvoker;
    const makeJudge = deps.buildJudgeInvoker ?? buildJudgeInvoker;
    const makeEmbed = deps.buildEmbedInvoker ?? buildEmbedInvoker;
    // Asked of the scorer registry, never of a hardcoded list: an
    // embedding-backed scorer left out of it runs with `invokeEmbed:
    // undefined` and scores every item 0 with 'no embed invoker configured'.
    const needJudge = scorers.some((s) => JUDGE_SCORERS.includes(s.type));
    const needEmbed = scorers.some((s) => EMBEDDING_SCORERS.includes(s.type));

    // Persist incremental progress so the dashboard can show step-by-step
    // results live. Flushes are serialised — one in flight at a time, so a slow
    // write can never land after a newer one or after the final write — and the
    // (large) items array is rewritten at most every ~5 s.
    const partial: RunItemResult[] = [];
    let lastFlush = 0;
    let lastItemsFlush = 0;
    let flushChain: Promise<void> | null = null;
    const flush = (): Promise<void> => {
      const now = Date.now();
      const withItems = now - lastItemsFlush >= EVAL_RUN_ITEMS_FLUSH_MS;
      lastFlush = now;
      if (withItems) lastItemsFlush = now;
      const snapshot = partial.slice();
      const completed = snapshot.filter((p) => !p.error).length;
      const failed = snapshot.length - completed;
      const fitted = withItems ? fitRunItems(snapshot.map(toRunItem)) : undefined;
      return db
        .updateEvaluationRun(runId, {
          progress: { total: items.length, completed, failed },
          ...(fitted ? { items: fitted.items, ...(fitted.degraded ? { itemsTruncated: true } : {}) } : {}),
        })
        .then(() => undefined)
        .catch(() => undefined);
    };
    const result = await runEvaluation({
      items,
      scorers,
      invokeTarget: makeTarget(target, ctx, started ? { agentRun: started.selector } : {}),
      invokeJudge: needJudge ? makeJudge(suite.judgeModelKey, ctx) : undefined,
      invokeEmbed: needEmbed ? makeEmbed(suite.embeddingModelKey, ctx) : undefined,
      config: { concurrency: suite.runConfig?.concurrency, turnMode: suite.runConfig?.turnMode },
      shouldStop: () => stopRequested,
      // Each item's work (target and scorers) in its own exposure: its stored copy and its model calls are marked
      // with what it handed on of documents not open to everyone.
      scope: async (_item, run) => {
        const exposure = new KnowledgeExposure({ parent: null });
        const result = await runWithKnowledgeExposure(exposure, run);
        return exposure.restricted ? { ...result, kbRestricted: exposure.list() } : result;
      },
      onItem: (item) => {
        partial.push(item);
        if (flushChain || Date.now() - lastFlush < EVAL_RUN_PROGRESS_FLUSH_MS) return;
        flushChain = flush().finally(() => {
          flushChain = null;
        });
      },
    });
    // The final write must not race a flush still in flight.
    if (flushChain) await flushChain;
    clearInterval(heartbeatTimer);
    clearInterval(cancelTimer);
    heartbeatTimer = undefined;
    cancelTimer = undefined;

    // A draft is read afresh by every item, so a save during the run means the
    // later items may have run a different config than the earlier ones.
    const draftChanged = started?.revision.version === null && (await started.draftChanged());

    const cancelled = result.stopped === true;
    const fitted = fitRunItems(result.items.map(toRunItem));
    const aggregate = withoutUndefined(result.aggregate as unknown as Record<string, unknown>) as unknown as NonNullable<
      IEvaluationRun['aggregate']
    >;
    const finalData: Parameters<typeof db.updateEvaluationRun>[1] = {
      status: cancelled ? 'cancelled' : 'completed',
      // '' clears a failure message a reaper may have written while this worker was silent (the write
      // below lands anyway); an empty error reads as "no error" everywhere.
      error: cancelled ? 'Cancelled while running' : '',
      progress: {
        total: cancelled ? items.length : result.aggregate.total,
        completed: result.aggregate.completed,
        failed: result.aggregate.failed,
      },
      aggregate,
      items: fitted.items,
      ...(fitted.degraded ? { itemsTruncated: true } : {}),
      ...(started && draftChanged ? { agentRevision: { ...started.revision, draftChanged: true } } : {}),
      finishedAt: new Date(),
    };
    // Unconditional: the run's spend must reach the row even if a reaper
    // failed it meanwhile. If the document is still too large for the store,
    // keep the aggregate and drop the items rather than losing the run.
    let updated: IEvaluationRun | null;
    try {
      updated = await db.updateEvaluationRun(runId, finalData);
    } catch (writeError) {
      logger.warn('Final evaluation run write failed; retrying without items', {
        runId,
        error: writeError instanceof Error ? writeError.message : String(writeError),
      });
      updated = await db.updateEvaluationRun(runId, { ...finalData, items: [], itemsTruncated: true });
    }
    return toView(updated ?? (await db.findEvaluationRunById(runId))!);
  } catch (err) {
    await db.updateEvaluationRun(runId, {
      status: 'failed',
      error: capString((err as Error).message, EVAL_RUN_ERROR_CAP),
      finishedAt: new Date(),
    });
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancelTimer) clearInterval(cancelTimer);
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
