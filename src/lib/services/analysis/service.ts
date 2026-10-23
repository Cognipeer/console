/**
 * Analysis service — tenant-scoped CRUD over definitions / conversations /
 * runs, plus `runDefinition` which loads a definition and a set of
 * conversations, builds live model invokers, drives the pure engine runner, and
 * persists the run + aggregate. When the definition's `store` mode is on, the
 * latest extracted fields are written back onto each conversation.
 *
 * A run has a TARGET: the conversation corpus (default), the platform's own
 * agent sessions (read in place, see agentSessions.ts) or an evaluation
 * dataset. With a dataset target the same engine becomes an AI labeler —
 * extracted fields land on each item as `labels` (see datasetLabeling.ts), so
 * traffic captured into a dataset can be sliced by segment afterwards.
 *
 * Corpus and agent-session runs also write one `analysis_results` row per
 * conversation (the latest answer, flags and the human review); results.ts reads
 * and reviews them.
 *
 * Model invokers are injectable (RunDefinitionDeps) so orchestration is
 * testable without live model calls.
 */

import { assertServiceEnabled } from '@/lib/services/availability/serviceAvailability';
import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type {
  IAnalysisDefinition,
  IAnalysisFieldDef,
  IAnalysisModes,
  IAnalysisConversation,
  IAnalysisTranscriptMessage,
  IAnalysisItemResult,
  IAnalysisResult,
  IAnalysisRun,
  IAnalysisRunTarget,
  IAnalysisSource,
  IAnalysisReviewSettings,
  IEvaluationDatasetItem,
  AnalysisConversationSource,
  AnalysisResultSourceKind,
} from '@/lib/database';
import { aggregateItems, runAnalysis } from './runner';
import { isDecisionField } from './decision';
import type { AnalysisConversation, AnalysisItemResult, AnalysisSpec, DecisionInvoker, ModelInvoker } from './types';
import { buildDecisionInvoker, buildModelInvoker, type AnalysisModelContext } from './adapters';
import {
  agentConversationToAnalysis,
  buildAgentSessionTarget,
  conversationId,
  loadResultsBySource,
  sameVersion,
  selectAgentSessionIds,
  sourceVersionOf,
  type SourceVersion,
} from './agentSessions';
import { datasetItemToConversation, isHumanLabeled } from './datasetLabeling';
import { isDue } from './schedulePlanner';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;
/**
 * Hard ceiling on how many conversations a single run may cover. Configurable
 * via ANALYSIS_MAX_RUN_CONVERSATIONS (default 5000) — a high-but-bounded cap so
 * one run can't accidentally fan out an unbounded number of model calls.
 */
const MAX_RUN_CONVERSATIONS = Math.max(1, Number(process.env.ANALYSIS_MAX_RUN_CONVERSATIONS ?? 5000) || 5000);
/** Parallel write-back updates. Bounded so a 5k-item run can't storm the DB. */
const WRITE_BACK_CONCURRENCY = 20;

/** Run tasks with a bounded number in flight, preserving input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type WithId<T> = Omit<T, '_id'> & { id: string };

export function toView<T extends { _id?: string | object }>(record: T): WithId<T> {
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

/** Decision answers without their probabilities: run items stay small (a run holds up to 5,000). */
export function stripProbabilities<T extends { probabilities?: unknown }>(decisions: Record<string, T>): Record<string, Omit<T, 'probabilities'>> {
  const out: Record<string, Omit<T, 'probabilities'>> = {};
  for (const [key, decision] of Object.entries(decisions)) {
    const copy = { ...decision };
    delete copy.probabilities;
    out[key] = copy;
  }
  return out;
}

function toRunItem(result: AnalysisItemResult, resultId?: string): IAnalysisItemResult {
  const decisions = result.decisions ? stripProbabilities(result.decisions) : undefined;
  return {
    conversationKey: result.conversationId,
    extractedFields: result.extractedFields,
    missing: result.missing,
    judge: result.judge,
    accuracy: result.accuracy,
    passed: result.passed,
    error: result.error,
    ...(decisions ? { decisions } : {}),
    ...(result.needsReview ? { needsReview: true, reviewReason: result.reviewReason } : {}),
    ...(resultId ? { resultId } : {}),
  };
}

// ── Definitions ──────────────────────────────────────────────────────────────

export interface CreateDefinitionInput {
  name: string;
  description?: string;
  fieldSet: IAnalysisFieldDef[];
  extractionInstructions?: string;
  modes: IAnalysisModes;
  extractionModelKey?: string;
  judgeModelKey?: string;
  /** Model Hub `decision` model that answers the Yes/No, Choice and Score fields. */
  decisionModelKey?: string;
  /** Absent = the imported conversation corpus. */
  source?: IAnalysisSource;
  review?: IAnalysisReviewSettings;
  runConfig?: { concurrency?: number };
  schedule?: { cron: string; enabled: boolean };
  projectId?: string;
}

export async function createDefinition(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateDefinitionInput,
): Promise<WithId<IAnalysisDefinition>> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const key = await generateUniqueKey(input.name, async (k) => !!(await db.findAnalysisDefinitionByKey(k, input.projectId)));
  const definition = await db.createAnalysisDefinition({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    fieldSet: input.fieldSet,
    extractionInstructions: input.extractionInstructions,
    modes: input.modes,
    extractionModelKey: input.extractionModelKey,
    judgeModelKey: input.judgeModelKey,
    ...(input.decisionModelKey ? { decisionModelKey: input.decisionModelKey } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.review ? { review: input.review } : {}),
    runConfig: input.runConfig,
    schedule: input.schedule,
    createdBy,
  });
  return toView(definition);
}

export async function listDefinitions(
  tenantDbName: string,
  filters?: { projectId?: string; search?: string },
): Promise<WithId<IAnalysisDefinition>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listAnalysisDefinitions(filters)).map(toView);
}

export async function getDefinition(tenantDbName: string, id: string): Promise<WithId<IAnalysisDefinition> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findAnalysisDefinitionById(id);
  return record ? toView(record) : null;
}

export async function updateDefinition(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  data: Partial<Pick<IAnalysisDefinition, 'name' | 'description' | 'fieldSet' | 'extractionInstructions' | 'modes' | 'extractionModelKey' | 'judgeModelKey' | 'decisionModelKey' | 'source' | 'review' | 'runConfig' | 'schedule' | 'projectId'>>,
): Promise<WithId<IAnalysisDefinition> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateAnalysisDefinition(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteDefinition(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const definition = await db.findAnalysisDefinitionById(id);
  const deleted = await db.deleteAnalysisDefinition(id);
  // Results belong to their definition: drop them with it (reviews included).
  if (deleted && definition) await db.deleteAnalysisResultsForDefinition(definition.projectId ?? '', definition.key);
  return deleted;
}

// ── Conversations ────────────────────────────────────────────────────────────

export interface CreateConversationInput {
  key?: string;
  name?: string;
  description?: string;
  transcript: IAnalysisTranscriptMessage[];
  source?: AnalysisConversationSource;
  tags?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  referenceFields?: Record<string, unknown>;
  projectId?: string;
}

async function createOneConversation(
  db: Awaited<ReturnType<typeof getDatabase>>,
  tenantId: string,
  createdBy: string,
  input: CreateConversationInput,
): Promise<IAnalysisConversation> {
  const desired = input.key || input.name || 'conversation';
  const key = await generateUniqueKey(desired, async (k) => !!(await db.findAnalysisConversationByKey(k, input.projectId)));
  return db.createAnalysisConversation({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    transcript: input.transcript,
    source: input.source ?? 'imported',
    tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    referenceFields: input.referenceFields,
    createdBy,
  });
}

/** Bulk-ingest conversations (from an external export or platform traffic). */
export async function ingestConversations(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  inputs: CreateConversationInput[],
  projectId?: string,
): Promise<WithId<IAnalysisConversation>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const created: IAnalysisConversation[] = [];
  for (const input of inputs) {
    created.push(await createOneConversation(db, tenantId, createdBy, { ...input, projectId: input.projectId ?? projectId }));
  }
  return created.map(toView);
}

export async function listConversations(
  tenantDbName: string,
  filters?: { projectId?: string; source?: AnalysisConversationSource; tag?: string; search?: string; limit?: number; skip?: number },
): Promise<WithId<IAnalysisConversation>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listAnalysisConversations(filters)).map(toView);
}

export async function getConversation(tenantDbName: string, id: string): Promise<WithId<IAnalysisConversation> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findAnalysisConversationById(id);
  return record ? toView(record) : null;
}

export async function deleteConversation(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteAnalysisConversation(id);
}

// ── Runs ───────────────────────────────────────────────────────────────────

export async function listRuns(
  tenantDbName: string,
  filters?: { projectId?: string; definitionKey?: string; limit?: number; skip?: number },
): Promise<WithId<IAnalysisRun>[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return (await db.listAnalysisRuns(filters)).map(toView);
}

export async function getRun(tenantDbName: string, id: string): Promise<WithId<IAnalysisRun> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findAnalysisRunById(id);
  return record ? toView(record) : null;
}

export interface RunDefinitionDeps {
  buildModelInvoker?: typeof buildModelInvoker;
  buildDecisionInvoker?: typeof buildDecisionInvoker;
}

/**
 * How a run picks which conversations to cover:
 *   - all        : the recent corpus (optionally filtered by tag)
 *   - tag        : conversations carrying a given tag
 *   - random     : a random sample of `sampleSize` from the corpus (optionally tag-filtered)
 *   - unanalyzed : only conversations never analyzed yet (lastAnalyzedAt unset)
 *   - changed    : only what has no result yet (imported) or is new/changed since its result (agent sessions)
 *   - keys       : an explicit list of conversation keys (agent sessions: session ids)
 */
export type RunSelectionStrategy = 'all' | 'tag' | 'random' | 'unanalyzed' | 'changed' | 'keys';

export interface RunSelection {
  strategy: RunSelectionStrategy;
  tag?: string;
  sampleSize?: number;
  conversationKeys?: string[];
}

/** What a caller may ask for to analyze agent sessions: the rest comes from the definition's source. */
export interface AgentSessionTargetRequest {
  kind: 'agent_sessions';
  /** Look-back in days; defaults to the source's. */
  days?: number;
}

type AgentSessionTarget = Extract<IAnalysisRunTarget, { kind: 'agent_sessions' }>;

export interface RunDefinitionParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  definitionKey: string;
  /** @deprecated prefer `selection`; kept for back-compat (treated as a keys selection). */
  conversationKeys?: string[];
  selection?: RunSelection;
  /**
   * What to analyze. Defaults to what the definition's source says: the
   * conversation corpus, or its agent sessions.
   */
  target?: IAnalysisRunTarget | AgentSessionTargetRequest;
}

/**
 * One unit of work for a run, independent of where it came from. `key` is what
 * the run's items are keyed by (conversation key / dataset item id) and
 * `writeBack` persists the result for that source.
 */
export interface RunSourceItem {
  key: string;
  conversation: AnalysisConversation;
  /** Provider id used by the write-back (conversation `_id`; unused for items). */
  recordId: string;
  /** Dataset items only: labels are human-owned, so an AI run must not clobber them. */
  humanLabeled?: boolean;
  /** Imported conversations: the display title of the result row. */
  title?: string;
}

type Db = Awaited<ReturnType<typeof getDatabase>>;

function isDatasetTarget(target?: { kind: string }): target is Extract<IAnalysisRunTarget, { kind: 'dataset' }> {
  return target?.kind === 'dataset';
}

/** Two runs collide only if they cover the same target. */
function sameTarget(a?: IAnalysisRunTarget, b?: IAnalysisRunTarget): boolean {
  if ((a?.kind ?? 'conversations') !== (b?.kind ?? 'conversations')) return false;
  if (isDatasetTarget(a) && isDatasetTarget(b)) return a.datasetId === b.datasetId;
  return true;
}

/**
 * Turn what a caller asked for into a concrete target. Without one, the
 * definition's source decides; an agent-session target needs a definition that
 * has an agent-session source (the agents, thresholds and window live there).
 */
function resolveRunTarget(
  definition: IAnalysisDefinition,
  target: RunDefinitionParams['target'],
  now: Date,
): IAnalysisRunTarget | undefined {
  const source = definition.source?.kind === 'agent_sessions' ? definition.source : undefined;
  if (!target) return source ? buildAgentSessionTarget(source, now) : undefined;
  if (target.kind !== 'agent_sessions') return target;
  if ('agentKeys' in target) return target;
  if (!source) throw new Error('This definition does not analyze agent sessions');
  return buildAgentSessionTarget(source, now, target.days);
}

/** Deterministic-free shuffle (app code, not a workflow) — Fisher–Yates. */
function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Normalise the selection, folding the legacy explicit-key list into it. */
function resolveSelection(selection: RunSelection | undefined, legacyKeys: string[] | undefined): RunSelection {
  return selection ?? (legacyKeys && legacyKeys.length > 0
    ? { strategy: 'keys', conversationKeys: legacyKeys }
    : { strategy: 'all' });
}

/** Resolve the conversations a run will cover from its selection strategy. */
async function selectConversations(
  db: Db,
  projectId: string | undefined,
  definitionKey: string,
  selection: RunSelection | undefined,
  legacyKeys: string[] | undefined,
): Promise<IAnalysisConversation[]> {
  const sel = resolveSelection(selection, legacyKeys);

  if (sel.strategy === 'keys') {
    const keys = sel.conversationKeys ?? [];
    const found = await Promise.all(keys.map((k) => db.findAnalysisConversationByKey(k, projectId)));
    return found.filter((c): c is IAnalysisConversation => c !== null).slice(0, MAX_RUN_CONVERSATIONS);
  }

  if (sel.strategy === 'random') {
    const candidates = await db.listAnalysisConversations({ projectId, tag: sel.tag, limit: MAX_RUN_CONVERSATIONS });
    const size = Math.max(1, Math.min(sel.sampleSize ?? candidates.length, candidates.length));
    return shuffle(candidates).slice(0, size);
  }

  if (sel.strategy === 'unanalyzed') {
    const candidates = await db.listAnalysisConversations({ projectId, tag: sel.tag, limit: MAX_RUN_CONVERSATIONS });
    return candidates.filter((c) => !c.lastAnalyzedAt).slice(0, MAX_RUN_CONVERSATIONS);
  }

  if (sel.strategy === 'changed') {
    // An imported conversation never changes, so "changed" is "no result by this definition yet".
    const candidates = await db.listAnalysisConversations({ projectId, tag: sel.tag, limit: MAX_RUN_CONVERSATIONS });
    const existing = await loadResultsBySource(db, projectId ?? '', definitionKey, 'conversation', candidates.map((c) => c.key));
    return candidates.filter((c) => !existing.has(c.key));
  }

  // 'all' or 'tag'
  return db.listAnalysisConversations({ projectId, tag: sel.tag, limit: MAX_RUN_CONVERSATIONS });
}

/** Page through a dataset's items, applying the label filter server-side. */
async function loadDatasetItems(
  db: Db,
  datasetId: string,
  onlyUnlabeled: boolean,
): Promise<IEvaluationDatasetItem[]> {
  const pageSize = 500;
  const all: IEvaluationDatasetItem[] = [];
  for (let skip = 0; all.length < MAX_RUN_CONVERSATIONS; skip += pageSize) {
    const page = await db.listEvaluationDatasetItems(datasetId, {
      skip,
      limit: pageSize,
      ...(onlyUnlabeled ? { labeled: false } : {}),
    });
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all.slice(0, MAX_RUN_CONVERSATIONS);
}

/**
 * Resolve the dataset items a labeling run will cover.
 *
 * `unanalyzed` means "not labeled yet" (the incremental mode) and is pushed
 * down to the provider; the other strategies filter an already-loaded page set,
 * which stays bounded by MAX_RUN_CONVERSATIONS. Human-labeled items are kept in
 * `all`/`keys` on purpose: with accuracy mode on they are what scores the
 * labeler, and the write-back leaves their labels untouched.
 */
async function selectDatasetItems(
  db: Db,
  datasetId: string,
  selection: RunSelection | undefined,
  legacyKeys: string[] | undefined,
): Promise<IEvaluationDatasetItem[]> {
  const sel = resolveSelection(selection, legacyKeys);
  const items = await loadDatasetItems(db, datasetId, sel.strategy === 'unanalyzed');

  if (sel.strategy === 'keys') {
    const wanted = new Set(sel.conversationKeys ?? []);
    return items.filter((item) => wanted.has(item.id));
  }
  const byTag = sel.tag ? items.filter((item) => (item.tags ?? []).includes(sel.tag as string)) : items;
  if (sel.strategy === 'random') {
    const size = Math.max(1, Math.min(sel.sampleSize ?? byTag.length, byTag.length));
    return shuffle(byTag).slice(0, size);
  }
  return byTag;
}

/** Resolve the work a run will cover for the corpus or a dataset (agent sessions are resolved by id). */
async function selectRunItems(
  db: Db,
  projectId: string | undefined,
  definitionKey: string,
  params: Pick<RunDefinitionParams, 'selection' | 'conversationKeys'> & { target?: IAnalysisRunTarget },
): Promise<RunSourceItem[]> {
  if (isDatasetTarget(params.target)) {
    const items = await selectDatasetItems(db, params.target.datasetId, params.selection, params.conversationKeys);
    return items.map((item) => ({
      key: item.id,
      recordId: item.id,
      conversation: datasetItemToConversation(item),
      humanLabeled: isHumanLabeled(item),
    }));
  }
  const convos = await selectConversations(db, projectId, definitionKey, params.selection, params.conversationKeys);
  return convos.map((c) => ({
    key: c.key,
    recordId: toView(c).id,
    title: c.name || c.key,
    conversation: {
      id: c.key,
      transcript: c.transcript,
      referenceFields: c.referenceFields,
      occurredAt: c.occurredAt?.toISOString(),
    },
  }));
}

/** What a run would cover, resolved the way a real run resolves it (no run row is created). */
export type ResolvedRun =
  | { kind: 'agent_sessions'; target: AgentSessionTarget; ids: string[] }
  | { kind: 'items'; target?: IAnalysisRunTarget; items: RunSourceItem[] };

/**
 * Resolve a run's target and selection. Agent sessions resolve to ids only (the
 * transcripts are loaded chunk by chunk at execution); the corpus and datasets
 * resolve to their loaded items.
 */
export async function resolveRun(
  db: Db,
  definition: IAnalysisDefinition,
  params: RunDefinitionParams,
  now: Date = new Date(),
): Promise<ResolvedRun> {
  const target = resolveRunTarget(definition, params.target, now);
  if (target?.kind === 'agent_sessions') {
    if (definition.source?.kind !== 'agent_sessions') throw new Error('This definition does not analyze agent sessions');
    const ids = await selectAgentSessionIds(db, {
      projectId: params.projectId ?? '',
      definitionKey: definition.key,
      target,
      selection: params.selection,
      legacyKeys: params.conversationKeys,
      max: MAX_RUN_CONVERSATIONS,
    });
    return { kind: 'agent_sessions', target, ids };
  }
  const items = await selectRunItems(db, params.projectId, definition.key, { ...params, target });
  return { kind: 'items', ...(target ? { target } : {}), items };
}

/**
 * Resolve definition + conversations, guard against a concurrent run, create a
 * pending run. Returns the run AND the concrete conversation keys it resolved —
 * the caller must run exactly those (so a `random`/`unanalyzed` selection is
 * sampled once, not re-sampled at execution time).
 */
async function createPendingRun(
  params: RunDefinitionParams,
  mode: IAnalysisRun['mode'],
): Promise<{ run: WithId<IAnalysisRun>; conversationKeys: string[] }> {
  await assertServiceEnabled({ tenantDbName: params.tenantDbName, tenantId: params.tenantId }, 'analysis');
  const { tenantDbName, tenantId, projectId, createdBy, definitionKey } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
  if (!definition) throw new Error(`Analysis definition "${definitionKey}" not found`);

  const resolved = await resolveRun(db, definition, params);
  const target = resolved.target;
  const conversationKeys = resolved.kind === 'agent_sessions' ? resolved.ids : resolved.items.map((s) => s.key);
  if (conversationKeys.length === 0) {
    throw new Error(
      isDatasetTarget(target)
        ? 'No dataset items to label with this selection.'
        : target?.kind === 'agent_sessions'
          ? (params.selection?.strategy ?? 'changed') === 'changed'
            ? 'No conversations to analyze: no agent session is new or changed since its last analysis.'
            : 'No conversations to analyze with this selection.'
          : 'No conversations to analyze — ingest conversations first (Conversations tab → Ingest).',
    );
  }

  // Guard against duplicate/concurrent runs OF THE SAME TARGET. Both 'pending'
  // (enqueued, not yet started) and recently-'running' rows count — a pending
  // run with no startedAt is treated as fresh so two near-simultaneous triggers
  // can't both pass the guard. Runs of one definition over different datasets
  // are independent and must not block each other, hence the target check.
  const [running, pending] = await Promise.all([
    db.listAnalysisRuns({ projectId, definitionKey: definition.key, status: 'running', limit: 10 }),
    db.listAnalysisRuns({ projectId, definitionKey: definition.key, status: 'pending', limit: 10 }),
  ]);
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const runningInFlight = running.some(
    (r) => sameTarget(r.target, target) && new Date(r.startedAt ?? 0).getTime() > hourAgo,
  );
  const pendingInFlight = pending.some(
    (r) => sameTarget(r.target, target) && new Date(r.createdAt ?? Date.now()).getTime() > hourAgo,
  );
  if (runningInFlight || pendingInFlight) {
    throw new Error(`A run for definition "${definition.key}" is already in progress`);
  }

  const run = await db.createAnalysisRun({
    tenantId,
    projectId,
    definitionKey: definition.key,
    ...(target ? { target } : {}),
    status: 'pending',
    mode,
    progress: { total: conversationKeys.length, completed: 0, failed: 0 },
    items: [],
    createdBy,
  });
  return { run: toView(run), conversationKeys };
}

/** The engine spec and live invokers of a definition's run. Invokers are only built where a field needs them. */
function buildRunEngine(
  definition: IAnalysisDefinition,
  ctx: AnalysisModelContext,
  deps: RunDefinitionDeps,
): {
  spec: AnalysisSpec;
  invokeExtraction?: ModelInvoker;
  invokeDecision?: DecisionInvoker;
  invokeJudge?: ModelInvoker;
} {
  const makeInvoker = deps.buildModelInvoker ?? buildModelInvoker;
  const makeDecision = deps.buildDecisionInvoker ?? buildDecisionInvoker;
  const spec: AnalysisSpec = {
    fieldSet: definition.fieldSet,
    extractionInstructions: definition.extractionInstructions,
    modes: definition.modes,
    useDecisionModel: !!definition.decisionModelKey,
    review: definition.review,
    spotCheckSalt: definition.key,
  };
  // Without a decision model every field is extracted, exactly as before. With
  // one, the extraction model is only needed when some field is not a decision field.
  const needsExtraction = !definition.decisionModelKey || definition.fieldSet.some((f) => !isDecisionField(f, spec));
  return {
    spec,
    invokeExtraction: needsExtraction ? makeInvoker(definition.extractionModelKey, ctx, 'extraction') : undefined,
    invokeDecision: definition.decisionModelKey ? makeDecision(definition.decisionModelKey, ctx) : undefined,
    invokeJudge: definition.modes.judge ? makeInvoker(definition.judgeModelKey, ctx, 'judge') : undefined,
  };
}

interface ResultEntry {
  item: AnalysisItemResult;
  sourceKind: AnalysisResultSourceKind;
  sourceId: string;
  title?: string;
  agentKey?: string;
  ownerId?: string;
  sourceVersion?: SourceVersion;
}

/**
 * Write the latest result of each analyzed conversation (errored items are not
 * written: the previous result stays). A human review is carried over while it
 * still describes what was analyzed: always for an imported conversation, and
 * for a session only while it has not changed since. A carried review clears
 * the review flag, on the row and on the engine item (so the run's count matches
 * the queue); a changed session starts over.
 * Returns the written row id per source id.
 */
async function writeResults(
  db: Db,
  base: { tenantId: string; projectId: string; definitionKey: string; runId: string },
  sourceKind: AnalysisResultSourceKind,
  entries: ResultEntry[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const analyzedAt = new Date();
  const writable = entries.filter((e) => !e.item.error);
  // Read the rows right before writing, not before the model calls: a review
  // saved while they ran must not be overwritten.
  const existing = await loadResultsBySource(db, base.projectId, base.definitionKey, sourceKind, writable.map((e) => e.sourceId));
  await mapLimit(
    writable,
    WRITE_BACK_CONCURRENCY,
    async ({ item, sourceId, title, agentKey, ownerId, sourceVersion }) => {
      const prev = existing.get(sourceId);
      const keep = !!prev && (sourceKind === 'conversation' || sameVersion(prev.sourceVersion, sourceVersion));
      const review = keep && prev?.review ? prev.review : null;
      const reviewReason = item.reviewReason ?? (review ? prev?.reviewReason : undefined);
      if (review) item.needsReview = false;
      const saved = await db.upsertAnalysisResult({
        tenantId: base.tenantId,
        projectId: base.projectId,
        definitionKey: base.definitionKey,
        sourceKind,
        sourceId,
        ...(title ? { title } : {}),
        ...(agentKey ? { agentKey } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(sourceVersion ? { sourceVersion } : {}),
        runId: base.runId,
        decisions: item.decisions ?? {},
        extractedFields: item.extractedFields,
        ...(item.judge ? { judge: item.judge } : {}),
        ...(item.accuracy ? { accuracy: item.accuracy } : {}),
        ...(item.rationale ? { rationale: item.rationale } : {}),
        needsReview: review ? false : (item.needsReview ?? false),
        ...(reviewReason ? { reviewReason } : {}),
        minConfidence: item.minConfidence ?? 1,
        review,
        analyzedAt,
      });
      ids.set(sourceId, String(saved._id ?? ''));
    },
  );
  return ids;
}

/** Throttled progress writer shared by both execution paths. */
function progressFlusher(db: Db, runId: string, total: number) {
  const partial: AnalysisItemResult[] = [];
  let lastFlush = 0;
  return {
    onItem(item: AnalysisItemResult): void {
      partial.push(item);
      const now = Date.now();
      if (now - lastFlush >= 1500) {
        lastFlush = now;
        const completed = partial.filter((p) => !p.error).length;
        const failed = partial.filter((p) => p.error).length;
        void db
          .updateAnalysisRun(runId, {
            progress: { total, completed, failed },
            items: partial.map((p) => toRunItem(p)),
          })
          .catch(() => {});
      }
    },
  };
}

/** Sessions are loaded and analyzed in chunks of this size so a 5,000-session run never holds all transcripts. */
const SESSION_CHUNK = 100;

/**
 * Run a definition over its agent sessions: the pinned session ids are loaded
 * chunk by chunk, analyzed, and each result is upserted (with the session's
 * version, so a later run can tell it changed).
 */
async function executeAgentSessionRun(
  db: Db,
  params: RunDefinitionParams & { runId: string },
  definition: IAnalysisDefinition,
  target: AgentSessionTarget,
  deps: RunDefinitionDeps,
): Promise<WithId<IAnalysisRun>> {
  const { tenantDbName, tenantId, projectId, runId } = params;
  const pid = projectId ?? '';
  const ids =
    params.conversationKeys ??
    (await selectAgentSessionIds(db, {
      projectId: pid,
      definitionKey: definition.key,
      target,
      selection: params.selection,
      max: MAX_RUN_CONVERSATIONS,
    }));

  await db.updateAnalysisRun(runId, { status: 'running', startedAt: new Date() });

  const ctx: AnalysisModelContext = { tenantDbName, tenantId, projectId: pid };
  const { spec, invokeExtraction, invokeDecision, invokeJudge } = buildRunEngine(definition, ctx, deps);
  const flusher = progressFlusher(db, runId, ids.length);
  const allItems: AnalysisItemResult[] = [];
  const runItems: IAnalysisItemResult[] = [];

  for (let i = 0; i < ids.length; i += SESSION_CHUNK) {
    const chunk = ids.slice(i, i + SESSION_CHUNK);
    const sessions = await db.listAgentConversationsForAnalysis({
      projectId: pid,
      agentKeys: target.agentKeys,
      ids: chunk,
      limit: chunk.length,
      fields: 'full',
    });
    if (sessions.length === 0) continue;
    const existing = await loadResultsBySource(db, pid, definition.key, 'agent_session', chunk);
    const sessionById = new Map(sessions.map((s) => [conversationId(s), s]));
    // A review is a reference only for the transcript it was given on: a session
    // that changed since is scored without it (and loses it when written).
    const conversations = sessions.map((s) => {
      const prev = existing.get(conversationId(s));
      const reviewed = prev && sameVersion(prev.sourceVersion, sourceVersionOf(s)) ? prev.review?.values : undefined;
      return agentConversationToAnalysis(s, reviewed);
    });

    const result = await runAnalysis({
      conversations,
      spec,
      invokeExtraction,
      invokeDecision,
      invokeJudge,
      config: { concurrency: definition.runConfig?.concurrency },
      onItem: (item) => flusher.onItem(item),
    });

    const entries: ResultEntry[] = result.items.map((item) => {
      const session = sessionById.get(item.conversationId)!;
      return {
        item,
        sourceKind: 'agent_session',
        sourceId: item.conversationId,
        title: session.title,
        agentKey: session.agentKey,
        ownerId: session.createdBy,
        sourceVersion: sourceVersionOf(session),
      };
    });
    const written = await writeResults(
      db,
      { tenantId, projectId: pid, definitionKey: definition.key, runId },
      'agent_session',
      entries,
    );
    for (const item of result.items) {
      allItems.push(item);
      runItems.push(toRunItem(item, written.get(item.conversationId)));
    }
  }

  const aggregate = aggregateItems(allItems, definition.fieldSet, spec);
  const updated = await db.updateAnalysisRun(runId, {
    status: 'completed',
    progress: { total: aggregate.total, completed: aggregate.completed, failed: aggregate.failed },
    aggregate,
    items: runItems,
    finishedAt: new Date(),
  });
  return toView(updated ?? (await db.findAnalysisRunById(runId))!);
}

/** Execute an already-created analysis run to completion. Throws on fatal error. */
export async function executeRun(
  params: RunDefinitionParams & { runId: string },
  deps: RunDefinitionDeps = {},
): Promise<WithId<IAnalysisRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, definitionKey, runId } = params;
  void createdBy;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  try {
    // Inside the try so the run is recorded as failed rather than left pending
    // when the service has been switched off since it was queued.
    await assertServiceEnabled({ tenantDbName, tenantId }, 'analysis');
    const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
    if (!definition) throw new Error(`Analysis definition "${definitionKey}" not found`);

    // The run row holds the resolved target (a queued job may only carry the
    // caller's request, e.g. "agent sessions, 30 days").
    const stored = await db.findAnalysisRunById(runId);
    const target = stored?.target ?? resolveRunTarget(definition, params.target, new Date());
    if (target?.kind === 'agent_sessions') {
      return await executeAgentSessionRun(db, params, definition, target, deps);
    }

    const sources = await selectRunItems(db, projectId, definition.key, { ...params, target });

    await db.updateAnalysisRun(runId, { status: 'running', startedAt: new Date() });

    const ctx: AnalysisModelContext = { tenantDbName, tenantId, projectId: projectId ?? '' };
    const { spec, invokeExtraction, invokeDecision, invokeJudge } = buildRunEngine(definition, ctx, deps);
    const isDataset = isDatasetTarget(target);
    const resultProjectId = projectId ?? '';

    // A human review of an earlier run is the best reference there is: accuracy
    // mode scores against it. (Datasets keep their own labels and have no results.)
    const existing = isDataset
      ? new Map<string, IAnalysisResult>()
      : await loadResultsBySource(db, resultProjectId, definition.key, 'conversation', sources.map((s) => s.key));
    const conversations: AnalysisConversation[] = sources.map((s) => {
      const reviewed = existing.get(s.key)?.review?.values;
      return reviewed && Object.keys(reviewed).length > 0
        ? { ...s.conversation, referenceFields: { ...s.conversation.referenceFields, ...reviewed } }
        : s.conversation;
    });

    // Persist incremental progress so the dashboard can show step-by-step
    // results live (throttled to avoid hammering the DB on large corpora).
    const flusher = progressFlusher(db, runId, conversations.length);
    const result = await runAnalysis({
      conversations,
      spec,
      invokeExtraction,
      invokeDecision,
      invokeJudge,
      config: { concurrency: definition.runConfig?.concurrency },
      onItem: (item) => flusher.onItem(item),
    });

    const sourceByKey = new Map(sources.map((s) => [s.key, s]));
    const succeeded = result.items.filter((item) => !item.error);

    // Datasets keep labels, not results. For the corpus, record the latest result of each conversation.
    const written = isDataset
      ? new Map<string, string>()
      : await writeResults(
          db,
          { tenantId, projectId: resultProjectId, definitionKey: definition.key, runId },
          'conversation',
          result.items.map((item) => ({
            item,
            sourceKind: 'conversation' as const,
            sourceId: item.conversationId,
            title: sourceByKey.get(item.conversationId)?.title,
          })),
        );
    // Carried reviews cleared some review flags: count what the queue will show.
    const aggregate = isDataset ? result.aggregate : aggregateItems(result.items, definition.fieldSet, spec);

    const updated = await db.updateAnalysisRun(runId, {
      status: 'completed',
      progress: { total: aggregate.total, completed: aggregate.completed, failed: aggregate.failed },
      aggregate,
      items: result.items.map((item) => toRunItem(item, written.get(item.conversationId))),
      finishedAt: new Date(),
    });

    if (isDatasetTarget(target)) {
      // Labeling: extracted fields ARE the labels, so they are always written
      // back (that is the point of the run) — except onto items a human has
      // labeled, whose corrections outrank the model's.
      const datasetId = target.datasetId;
      const labeledAt = new Date().toISOString();
      const writable = succeeded.filter((item) => !sourceByKey.get(item.conversationId)?.humanLabeled);
      await mapLimit(writable, WRITE_BACK_CONCURRENCY, async (item) => {
        await db.updateEvaluationDatasetItem(datasetId, item.conversationId, {
          labels: item.extractedFields,
          labelMeta: {
            source: 'ai',
            definitionKey: definition.key,
            runId,
            modelKey: definition.extractionModelKey,
            ...(item.judge ? { judge: { score: item.judge.score, passed: item.judge.passed, reasoning: item.judge.reasoning } } : {}),
            labeledAt,
          },
        });
      });
    } else if (definition.modes.store) {
      // Store mode: persist the latest extracted fields back onto conversations.
      const now = new Date();
      await mapLimit(succeeded, WRITE_BACK_CONCURRENCY, async (item) => {
        const id = sourceByKey.get(item.conversationId)?.recordId;
        if (!id) return;
        await db.updateAnalysisConversation(id, { extractedFields: item.extractedFields, lastAnalyzedAt: now });
      });
    }

    return toView(updated ?? (await db.findAnalysisRunById(runId))!);
  } catch (err) {
    await db.updateAnalysisRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      finishedAt: new Date(),
    });
    throw err;
  }
}

/** Synchronous run (tests / scheduler / CI): create + execute, blocks to completion. */
export async function runDefinition(params: RunDefinitionParams, deps: RunDefinitionDeps = {}): Promise<WithId<IAnalysisRun>> {
  const { run, conversationKeys } = await createPendingRun(params, 'sync');
  // Execute exactly the resolved keys (selection already sampled once).
  return executeRun({ ...params, selection: undefined, conversationKeys, runId: run.id }, deps);
}

/**
 * Create a pending run and return it immediately for the caller to enqueue.
 * Also returns the resolved conversation keys so the queued job executes
 * exactly those (a `random` sample is fixed at enqueue time, not re-sampled).
 */
export async function createAsyncRun(
  params: RunDefinitionParams,
): Promise<{ run: WithId<IAnalysisRun>; conversationKeys: string[] }> {
  return createPendingRun(params, 'async');
}

/**
 * When an agent-session schedule last fired with nothing new to analyze. Such a
 * slot creates no run, so without this it would stay due and fire again on every
 * tick of the day; it counts as fired instead (per process: after a restart the
 * slot is checked once more, which is harmless).
 */
const emptyScheduleSlots = new Map<string, number>();

/**
 * Run every definition in a tenant whose cron schedule is due. "Due" is decided
 * against the most recent run's timestamp so each slot fires at most once.
 * Used by the background analysis scheduler; deps are injectable for tests.
 *
 * A definition with an agent-session source analyzes the sessions that are new
 * or changed since their last result. When there are none no run is created
 * (not an error) and the slot still counts as fired.
 */
export async function runScheduledAnalyses(
  tenantDbName: string,
  tenantId: string,
  now: Date = new Date(),
  deps: RunDefinitionDeps = {},
): Promise<{ fired: string[]; errors: string[] }> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const definitions = await db.listAnalysisDefinitions();
  const fired: string[] = [];
  const errors: string[] = [];
  for (const def of definitions) {
    if (!def.schedule?.enabled) continue;
    const agentSource = def.source?.kind === 'agent_sessions' ? def.source : undefined;
    const slotKey = `${tenantDbName}:${def.projectId ?? ''}:${def.key}`;
    const recent = await db.listAnalysisRuns({ definitionKey: def.key, limit: 1 });
    const lastRun = recent[0]?.startedAt ?? recent[0]?.createdAt ?? null;
    const lastFired = Math.max(lastRun ? new Date(lastRun).getTime() : -Infinity, emptyScheduleSlots.get(slotKey) ?? -Infinity);
    if (!isDue(def.schedule, Number.isFinite(lastFired) ? new Date(lastFired) : null, now)) continue;
    try {
      await runDefinition(
        {
          tenantDbName,
          tenantId,
          projectId: def.projectId,
          createdBy: 'system',
          definitionKey: def.key,
          ...(agentSource
            ? { target: buildAgentSessionTarget(agentSource, now), selection: { strategy: 'changed' as const } }
            : {}),
        },
        deps,
      );
      emptyScheduleSlots.delete(slotKey);
      fired.push(def.key);
    } catch (err) {
      const message = (err as Error).message;
      if (agentSource && /no conversations to analyze/i.test(message)) {
        emptyScheduleSlots.set(slotKey, now.getTime());
        continue;
      }
      errors.push(`${def.key}: ${message}`);
    }
  }
  return { fired, errors };
}
