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
const MAX_RUN_CONVERSATIONS = 500;

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
  filters?: { projectId?: string; source?: AnalysisConversationSource; search?: string; limit?: number; skip?: number },
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

export async function runDefinition(
  params: { tenantDbName: string; tenantId: string; projectId?: string; createdBy: string; definitionKey: string; conversationKeys?: string[] },
  deps: RunDefinitionDeps = {},
): Promise<WithId<IAnalysisRun>> {
  const { tenantDbName, tenantId, projectId, createdBy, definitionKey, conversationKeys } = params;
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
  if (!definition) throw new Error(`Analysis definition "${definitionKey}" not found`);

  // Select conversations: explicit keys, or the most recent corpus.
  let convos: IAnalysisConversation[];
  if (conversationKeys && conversationKeys.length > 0) {
    const found = await Promise.all(conversationKeys.map((k) => db.findAnalysisConversationByKey(k, projectId)));
    convos = found.filter((c): c is IAnalysisConversation => c !== null);
  } else {
    convos = await db.listAnalysisConversations({ projectId, limit: MAX_RUN_CONVERSATIONS });
  }

  const run = await db.createAnalysisRun({
    tenantId,
    projectId,
    definitionKey: definition.key,
    status: 'running',
    mode: 'sync',
    progress: { total: convos.length, completed: 0, failed: 0 },
    items: [],
    createdBy,
    startedAt: new Date(),
  });
  const runId = toView(run).id;

  try {
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

    const result = await runAnalysis({
      conversations,
      spec,
      invokeExtraction: makeInvoker(definition.extractionModelKey, ctx, 'extraction'),
      invokeJudge: definition.modes.judge ? makeInvoker(definition.judgeModelKey, ctx, 'judge') : undefined,
      config: { concurrency: definition.runConfig?.concurrency },
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

    return toView(updated ?? run);
  } catch (err) {
    await db.updateAnalysisRun(runId, {
      status: 'failed',
      error: (err as Error).message,
      finishedAt: new Date(),
    });
    throw err;
  }
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
