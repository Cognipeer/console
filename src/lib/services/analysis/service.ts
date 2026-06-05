/**
 * Analysis service — tenant-scoped CRUD over definitions / conversations /
 * runs, plus `runDefinition` which loads a definition and a set of
 * conversations, builds live model invokers, drives the pure engine runner, and
 * persists the run + aggregate. When the definition's `store` mode is on, the
 * latest extracted fields are written back onto each conversation.
 *
 * Model invokers are injectable (RunDefinitionDeps) so orchestration is
 * testable without live model calls.
 */

import slugify from 'slugify';
import { getDatabase } from '@/lib/database';
import type {
  IAnalysisDefinition,
  IAnalysisFieldDef,
  IAnalysisModes,
  IAnalysisConversation,
  IAnalysisTranscriptMessage,
  IAnalysisItemResult,
  IAnalysisRun,
  AnalysisConversationSource,
} from '@/lib/database';
import { runAnalysis } from './runner';
import type { AnalysisConversation, AnalysisItemResult, AnalysisSpec } from './types';
import { buildModelInvoker, type AnalysisModelContext } from './adapters';
import { isDue } from './schedulePlanner';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;
/**
 * Hard ceiling on how many conversations a single run may cover. Configurable
 * via ANALYSIS_MAX_RUN_CONVERSATIONS (default 5000) — a high-but-bounded cap so
 * one run can't accidentally fan out an unbounded number of model calls.
 */
const MAX_RUN_CONVERSATIONS = Math.max(1, Number(process.env.ANALYSIS_MAX_RUN_CONVERSATIONS ?? 5000) || 5000);

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

function toRunItem(result: AnalysisItemResult): IAnalysisItemResult {
  return {
    conversationKey: result.conversationId,
    extractedFields: result.extractedFields,
    missing: result.missing,
    judge: result.judge,
    accuracy: result.accuracy,
    passed: result.passed,
    error: result.error,
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
  data: Partial<Pick<IAnalysisDefinition, 'name' | 'description' | 'fieldSet' | 'extractionInstructions' | 'modes' | 'extractionModelKey' | 'judgeModelKey' | 'runConfig' | 'schedule' | 'projectId'>>,
): Promise<WithId<IAnalysisDefinition> | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const updated = await db.updateAnalysisDefinition(id, { ...data, updatedBy });
  return updated ? toView(updated) : null;
}

export async function deleteDefinition(tenantDbName: string, id: string): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db.deleteAnalysisDefinition(id);
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
}

/**
 * How a run picks which conversations to cover:
 *   - all        : the recent corpus (optionally filtered by tag)
 *   - tag        : conversations carrying a given tag
 *   - random     : a random sample of `sampleSize` from the corpus (optionally tag-filtered)
 *   - unanalyzed : only conversations never analyzed yet (lastAnalyzedAt unset)
 *   - keys       : an explicit list of conversation keys
 */
export type RunSelectionStrategy = 'all' | 'tag' | 'random' | 'unanalyzed' | 'keys';

export interface RunSelection {
  strategy: RunSelectionStrategy;
  tag?: string;
  sampleSize?: number;
  conversationKeys?: string[];
}

export interface RunDefinitionParams {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  createdBy: string;
  definitionKey: string;
  /** @deprecated prefer `selection`; kept for back-compat (treated as a keys selection). */
  conversationKeys?: string[];
  selection?: RunSelection;
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

/** Resolve the conversations a run will cover from its selection strategy. */
async function selectConversations(
  db: Awaited<ReturnType<typeof getDatabase>>,
  projectId: string | undefined,
  selection: RunSelection | undefined,
  legacyKeys: string[] | undefined,
): Promise<IAnalysisConversation[]> {
  // Back-compat: an explicit key list (old callers) maps to a keys selection.
  const sel: RunSelection = selection ?? (legacyKeys && legacyKeys.length > 0
    ? { strategy: 'keys', conversationKeys: legacyKeys }
    : { strategy: 'all' });

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

  // 'all' or 'tag'
  return db.listAnalysisConversations({ projectId, tag: sel.tag, limit: MAX_RUN_CONVERSATIONS });
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
  const { tenantDbName, tenantId, projectId, createdBy, definitionKey, conversationKeys, selection } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
  if (!definition) throw new Error(`Analysis definition "${definitionKey}" not found`);

  const convos = await selectConversations(db, projectId, selection, conversationKeys);
  if (convos.length === 0) {
    throw new Error('No conversations to analyze — ingest conversations first (Conversations tab → Ingest).');
  }

  // Guard against duplicate/concurrent runs. Both 'pending' (enqueued, not yet
  // started) and recently-'running' rows count — a pending run with no
  // startedAt is treated as fresh so two near-simultaneous triggers can't both
  // pass the guard.
  const [running, pending] = await Promise.all([
    db.listAnalysisRuns({ projectId, definitionKey: definition.key, status: 'running', limit: 1 }),
    db.listAnalysisRuns({ projectId, definitionKey: definition.key, status: 'pending', limit: 1 }),
  ]);
  const recentStart = running[0]?.startedAt ? new Date(running[0].startedAt).getTime() : 0;
  const runningInFlight = running.length > 0 && Date.now() - recentStart < 60 * 60 * 1000;
  const pendingInFlight = pending.length > 0 && Date.now() - new Date(pending[0].createdAt ?? Date.now()).getTime() < 60 * 60 * 1000;
  if (runningInFlight || pendingInFlight) {
    throw new Error(`A run for definition "${definition.key}" is already in progress`);
  }

  const run = await db.createAnalysisRun({
    tenantId,
    projectId,
    definitionKey: definition.key,
    status: 'pending',
    mode,
    progress: { total: convos.length, completed: 0, failed: 0 },
    items: [],
    createdBy,
  });
  return { run: toView(run), conversationKeys: convos.map((c) => c.key) };
}

/** Execute an already-created analysis run to completion. Throws on fatal error. */
export async function executeRun(
  params: RunDefinitionParams & { runId: string },
  deps: RunDefinitionDeps = {},
): Promise<WithId<IAnalysisRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, definitionKey, conversationKeys, selection, runId } = params;
  void createdBy;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  try {
    const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
    if (!definition) throw new Error(`Analysis definition "${definitionKey}" not found`);
    const convos = await selectConversations(db, projectId, selection, conversationKeys);

    await db.updateAnalysisRun(runId, { status: 'running', startedAt: new Date() });

    const ctx: AnalysisModelContext = { tenantDbName, tenantId, projectId: projectId ?? '' };
    const makeInvoker = deps.buildModelInvoker ?? buildModelInvoker;

    const spec: AnalysisSpec = {
      fieldSet: definition.fieldSet,
      extractionInstructions: definition.extractionInstructions,
      modes: definition.modes,
    };
    const conversations: AnalysisConversation[] = convos.map((c) => ({
      id: c.key,
      transcript: c.transcript,
      referenceFields: c.referenceFields,
      occurredAt: c.occurredAt?.toISOString(),
    }));

    // Persist incremental progress so the dashboard can show step-by-step
    // results live (throttled to avoid hammering the DB on large corpora).
    const partial: AnalysisItemResult[] = [];
    let lastFlush = 0;
    const result = await runAnalysis({
      conversations,
      spec,
      invokeExtraction: makeInvoker(definition.extractionModelKey, ctx, 'extraction'),
      invokeJudge: definition.modes.judge ? makeInvoker(definition.judgeModelKey, ctx, 'judge') : undefined,
      config: { concurrency: definition.runConfig?.concurrency },
      onItem: (item) => {
        partial.push(item);
        const now = Date.now();
        if (now - lastFlush >= 1500) {
          lastFlush = now;
          const completed = partial.filter((p) => !p.error).length;
          const failed = partial.filter((p) => p.error).length;
          void db
            .updateAnalysisRun(runId, {
              progress: { total: conversations.length, completed, failed },
              items: partial.map(toRunItem),
            })
            .catch(() => {});
        }
      },
    });

    const updated = await db.updateAnalysisRun(runId, {
      status: 'completed',
      progress: { total: result.aggregate.total, completed: result.aggregate.completed, failed: result.aggregate.failed },
      aggregate: result.aggregate,
      items: result.items.map(toRunItem),
      finishedAt: new Date(),
    });

    // Store mode: persist the latest extracted fields back onto conversations.
    if (definition.modes.store) {
      const idByKey = new Map(convos.map((c) => [c.key, toView(c).id]));
      const now = new Date();
      await Promise.all(
        result.items
          .filter((item) => !item.error)
          .map((item) => {
            const id = idByKey.get(item.conversationId);
            return id
              ? db.updateAnalysisConversation(id, { extractedFields: item.extractedFields, lastAnalyzedAt: now })
              : Promise.resolve(null);
          }),
      );
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
 * Run every definition in a tenant whose cron schedule is due. "Due" is decided
 * against the most recent run's timestamp so each slot fires at most once.
 * Used by the background analysis scheduler; deps are injectable for tests.
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
    const recent = await db.listAnalysisRuns({ definitionKey: def.key, limit: 1 });
    const last = recent[0]?.startedAt ?? recent[0]?.createdAt ?? null;
    if (!isDue(def.schedule, last ? new Date(last) : null, now)) continue;
    try {
      await runDefinition(
        { tenantDbName, tenantId, projectId: def.projectId, createdBy: 'system', definitionKey: def.key },
        deps,
      );
      fired.push(def.key);
    } catch (err) {
      errors.push(`${def.key}: ${(err as Error).message}`);
    }
  }
  return { fired, errors };
}
