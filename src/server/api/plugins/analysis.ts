import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getDatabase, runWithTenantScope } from '@/lib/database';
import type {
  IAnalysisDecision,
  IAnalysisFieldDef,
  IAnalysisItemResult,
  IAnalysisModes,
  IAnalysisResult,
  IAnalysisReviewSettings,
  IAnalysisSource,
  IAnalysisTranscriptMessage,
  AnalysisFieldType,
} from '@/lib/database';
import { getDataset } from '@/lib/services/evaluation/service';
import { getAgentByKey } from '@/lib/services/agents';
import { getModelByKey } from '@/lib/services/models/modelService';
import { createLogger } from '@/lib/core/logger';
import {
  createDefinition,
  deleteConversation,
  deleteDefinition,
  getConversation,
  getDefinition,
  getRun,
  ingestConversations,
  listConversations,
  listDefinitions,
  listRuns,
  updateDefinition,
  type CreateConversationInput,
  type RunDefinitionParams,
  type WithId,
} from '@/lib/services/analysis/service';
import {
  AnalysisReviewError,
  estimateRun,
  getCalibration,
  getResultDetail,
  listAgentSessionRows,
  listResults,
  saveResultReview,
  visibleRunItems,
  type AgentSessionRow,
  type AnalysisViewer,
} from '@/lib/services/analysis/results';
import { isDecisionField } from '@/lib/services/analysis/decision';
import { enqueueDefinitionRun } from '@/lib/services/analysis/analysisRunJob';
import { validateCron } from '@/lib/services/analysis/schedulePlanner';
import {
  readJsonBody,
  readJsonObjectBody,
  safeReadJsonBody,
  requireProjectContextForRequest,
  requireSessionContext,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';
import { SESSION_RESTRICTED_MESSAGE, sessionListScope, type SessionListScope } from './agent-session-access';
import { rowsWithHiddenContent } from '../restrictedKnowledgeRequest';
import type { RunSelection, RunSelectionStrategy } from '@/lib/services/analysis/service';

const logger = createLogger('api:analysis');

const VALID_FIELD_TYPES: AnalysisFieldType[] = ['string', 'number', 'boolean', 'enum', 'score'];

/** A request the caller got wrong; the handler answers it with `status` instead of a 500. */
class ApiInputError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = 'ApiInputError';
  }
}

function internalError(reply: FastifyReply, error: unknown) {
  if (error instanceof ApiInputError) return reply.code(error.status).send({ error: error.message });
  return (
    sendProjectContextError(reply, error)
    ?? reply.code(500).send({ error: error instanceof Error ? error.message : 'Internal error' })
  );
}

/**
 * Maps what the analysis services throw for a bad request: they signal by message
 * (not found / nothing to analyze / a run already going), so the routes that call
 * them share one mapping. Anything else is an internal error.
 */
function serviceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AnalysisReviewError) return reply.code(400).send({ error: error.message });
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('not found')) return reply.code(404).send({ error: error.message });
    if (
      message.includes('no conversations')
      || message.includes('does not analyze')
      || message.includes('is not analyzed by')
      || message.includes('invalid cursor')
    ) {
      return reply.code(400).send({ error: error.message });
    }
    if (message.includes('already in progress')) return reply.code(409).send({ error: error.message });
  }
  return internalError(reply, error);
}

/** Shapes the 400 for a body that is not JSON (readJsonBody throws a SyntaxError). */
function readBody(request: Parameters<typeof readJsonObjectBody>[0]): Record<string, unknown> {
  try {
    return readJsonObjectBody(request);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiInputError(400, 'Request body must be a JSON object');
    throw error;
  }
}

const MAX_LEVELS = 20;
const MAX_DECISION_FIELDS = 64;

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function sanitizeFieldSet(raw: unknown): IAnalysisFieldDef[] | null {
  if (!Array.isArray(raw)) return null;
  const fields: IAnalysisFieldDef[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key.trim()) return null;
    if (typeof e.type !== 'string' || !VALID_FIELD_TYPES.includes(e.type as AnalysisFieldType)) return null;
    if (e.type === 'enum' && (!Array.isArray(e.enumValues) || e.enumValues.length === 0)) return null;
    const key = e.key.trim();
    const field: IAnalysisFieldDef = {
      key,
      type: e.type as AnalysisFieldType,
      description: typeof e.description === 'string' ? e.description : undefined,
      enumValues: Array.isArray(e.enumValues) ? (e.enumValues as string[]).map(String) : undefined,
      required: typeof e.required === 'boolean' ? e.required : undefined,
    };
    if (field.type === 'enum' && field.enumValues?.some((v) => v.length > 128)) {
      throw new ApiInputError(400, `Field "${key}": enum values must be at most 128 characters`);
    }
    if (field.type === 'score') {
      // Ordered level labels, lowest first; the decision model scores each one.
      const levels = Array.isArray(e.levels) ? (e.levels as unknown[]).map((l) => (typeof l === 'string' ? l.trim() : '')) : [];
      const unique = new Set(levels.map((l) => l.toLowerCase()));
      if (levels.length < 2 || levels.length > MAX_LEVELS || levels.some((l) => !l || l.length > 64) || unique.size !== levels.length) {
        throw new ApiInputError(400, `Field "${key}": a score needs 2 to ${MAX_LEVELS} unique levels of at most 64 characters`);
      }
      field.levels = levels;
    }
    if (e.reviewBelow !== undefined && e.reviewBelow !== null) {
      const reviewBelow = numberInRange(e.reviewBelow, 0, 1);
      if (reviewBelow === null) throw new ApiInputError(400, `Field "${key}": reviewBelow must be a number between 0 and 1`);
      if (field.type === 'enum' || field.type === 'boolean' || field.type === 'score') field.reviewBelow = reviewBelow;
    }
    fields.push(field);
  }
  return fields;
}

/**
 * The fieldSet against the model keys it will run with: at most 64 decision
 * questions, and an extraction model whenever some field is answered by
 * extraction (no decision model, or Text/Number fields).
 */
function checkFieldRouting(fieldSet: IAnalysisFieldDef[], decisionModelKey?: string, extractionModelKey?: string): void {
  const spec = { useDecisionModel: !!decisionModelKey };
  if (decisionModelKey && fieldSet.filter((f) => isDecisionField(f, spec)).length > MAX_DECISION_FIELDS) {
    throw new ApiInputError(400, `A decision model answers at most ${MAX_DECISION_FIELDS} questions`);
  }
  if (!extractionModelKey && fieldSet.some((f) => !isDecisionField(f, spec))) {
    throw new ApiInputError(400, 'extractionModelKey is required for Text and Number fields');
  }
}

/** The key of a decision-category Model Hub model; anything else is a 400. */
async function resolveDecisionModelKey(
  raw: unknown,
  ctx: { tenantDbName: string; projectId: string },
): Promise<string | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new ApiInputError(400, 'decisionModelKey must be a string');
  const key = raw.trim();
  if (!key) return undefined;
  const model = await getModelByKey(ctx.tenantDbName, key, ctx.projectId);
  if (!model || model.category !== 'decision') throw new ApiInputError(400, 'decisionModelKey must name a decision model');
  return key;
}

function sanitizeReview(raw: unknown): IAnalysisReviewSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApiInputError(400, 'review must be an object');
  const r = raw as Record<string, unknown>;
  const review: IAnalysisReviewSettings = {};
  if (r.threshold !== undefined) {
    const threshold = numberInRange(r.threshold, 0, 1);
    if (threshold === null) throw new ApiInputError(400, 'review.threshold must be a number between 0 and 1');
    review.threshold = threshold;
  }
  if (r.spotCheckPct !== undefined) {
    const spotCheckPct = numberInRange(r.spotCheckPct, 0, 100);
    if (spotCheckPct === null) throw new ApiInputError(400, 'review.spotCheckPct must be a number between 0 and 100');
    review.spotCheckPct = spotCheckPct;
  }
  return review;
}

function integerInRange(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiInputError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Whether the caller may analyze sessions of every one of `agentKeys`: anyone
 * unrestricted, otherwise only the agents whose other-people sessions they may view.
 */
function canAnalyze(scope: SessionListScope, agentKeys: string[]): boolean {
  if (!scope.ownOnly) return true;
  const viewable = scope.ownOnly.viewableAgentKeys ?? [];
  return agentKeys.every((k) => viewable.includes(k));
}

async function callerScope(request: Parameters<typeof sessionListScope>[0], projectId: string, tenantDbName: string, userId: string) {
  return sessionListScope(request, { projectId, actor: { tenantDbName, projectId, userId } });
}

function assertCanAnalyze(scope: SessionListScope, agentKeys: string[]): void {
  for (const key of agentKeys) {
    if (!canAnalyze(scope, [key])) throw new ApiInputError(403, `You cannot analyze sessions of agent "${key}"`);
  }
}

/** A single trimmed query-string value; a repeated parameter (an array) or a blank one counts as absent. */
function queryText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The result visibility a restricted caller has (their own sessions + the agents they may view); undefined = all. */
function viewerOf(scope: SessionListScope): AnalysisViewer | undefined {
  return scope.ownOnly ? { userId: scope.ownOnly.userId, agentKeys: scope.ownOnly.viewableAgentKeys ?? [] } : undefined;
}

/**
 * A definition's source. `agent_sessions` needs 1..50 agents that exist in the
 * project (400) and that the caller may analyze (403).
 */
async function sanitizeSource(
  raw: unknown,
  ctx: { tenantDbName: string; projectId: string; scope: () => Promise<SessionListScope> },
): Promise<IAnalysisSource | undefined> {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ApiInputError(400, 'source must be an object');
  const r = raw as Record<string, unknown>;
  if (r.kind === 'conversations') return { kind: 'conversations' };
  if (r.kind !== 'agent_sessions') throw new ApiInputError(400, 'source.kind must be "conversations" or "agent_sessions"');

  if (!Array.isArray(r.agentKeys) || r.agentKeys.some((k) => typeof k !== 'string' || !k.trim())) {
    throw new ApiInputError(400, 'source.agentKeys must be an array of agent keys');
  }
  const agentKeys = [...new Set((r.agentKeys as string[]).map((k) => k.trim()))];
  if (agentKeys.length < 1 || agentKeys.length > 50) throw new ApiInputError(400, 'source.agentKeys must name 1 to 50 agents');
  const source: IAnalysisSource = {
    kind: 'agent_sessions',
    agentKeys,
    minMessages: integerInRange(r.minMessages, 'source.minMessages', 1, 1000),
    idleMinutes: integerInRange(r.idleMinutes, 'source.idleMinutes', 0, 10080),
    days: integerInRange(r.days, 'source.days', 1, 365),
  };
  // Unset options stay absent so the service's defaults apply.
  for (const k of ['minMessages', 'idleMinutes', 'days'] as const) if (source[k] === undefined) delete source[k];

  const agents = await Promise.all(agentKeys.map((k) => getAgentByKey(ctx.tenantDbName, k, ctx.projectId)));
  const missing = agentKeys.find((_, i) => !agents[i]);
  if (missing) throw new ApiInputError(400, `Agent "${missing}" not found`);
  assertCanAnalyze(await ctx.scope(), agentKeys);
  return source;
}

function sanitizeModes(raw: unknown): IAnalysisModes {
  const modes: IAnalysisModes = {};
  if (!raw || typeof raw !== 'object') return modes;
  const m = raw as Record<string, unknown>;
  if (m.store === true) modes.store = true;
  if (m.accuracy === true) modes.accuracy = true;
  if (m.judge && typeof m.judge === 'object') {
    const j = m.judge as Record<string, unknown>;
    if (typeof j.rubric === 'string' && j.rubric.trim()) {
      modes.judge = { rubric: j.rubric, threshold: typeof j.threshold === 'number' ? j.threshold : undefined };
    }
  }
  return modes;
}

function sanitizeSchedule(raw: unknown): { schedule?: { cron: string; enabled: boolean }; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') return { error: 'schedule must be an object' };
  const s = raw as Record<string, unknown>;
  if (typeof s.cron !== 'string') return { error: 'schedule.cron is required' };
  const cronError = validateCron(s.cron);
  if (cronError) return { error: cronError };
  return { schedule: { cron: s.cron, enabled: s.enabled !== false } };
}

function sanitizeTranscript(raw: unknown): IAnalysisTranscriptMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const messages: IAnalysisTranscriptMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || typeof e.content !== 'string') return null;
    messages.push({ role: e.role, content: e.content });
  }
  return messages;
}

function sanitizeTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tags = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  // de-dupe, preserve order
  const seen = new Set<string>();
  const unique = tags.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return unique.length > 0 ? unique : undefined;
}

function toConversationInput(raw: Record<string, unknown>, defaultTags?: string[]): CreateConversationInput | null {
  const transcript = sanitizeTranscript(raw.transcript);
  if (!transcript) return null;
  const ownTags = sanitizeTags(raw.tags);
  const merged = sanitizeTags([...(defaultTags ?? []), ...(ownTags ?? [])]);
  return {
    key: typeof raw.key === 'string' ? raw.key : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    transcript,
    source: raw.source === 'platform' || raw.source === 'manual' ? raw.source : 'imported',
    tags: merged,
    metadata: raw.metadata && typeof raw.metadata === 'object' ? (raw.metadata as Record<string, unknown>) : undefined,
    occurredAt: typeof raw.occurredAt === 'string' ? new Date(raw.occurredAt) : undefined,
    referenceFields: raw.referenceFields && typeof raw.referenceFields === 'object' ? (raw.referenceFields as Record<string, unknown>) : undefined,
  };
}

const VALID_SELECTION_STRATEGIES: RunSelectionStrategy[] = ['all', 'tag', 'random', 'unanalyzed', 'changed', 'keys'];
const MAX_SELECTION_KEYS = 5000;

function sanitizeSelection(raw: unknown): RunSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.strategy !== 'string' || !VALID_SELECTION_STRATEGIES.includes(s.strategy as RunSelectionStrategy)) return undefined;
  const conversationKeys = Array.isArray(s.conversationKeys)
    ? (s.conversationKeys as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  if (conversationKeys && conversationKeys.length > MAX_SELECTION_KEYS) {
    throw new ApiInputError(400, `conversationKeys is limited to ${MAX_SELECTION_KEYS} entries`);
  }
  const sampleSize = Number(s.sampleSize);
  return {
    strategy: s.strategy as RunSelectionStrategy,
    tag: typeof s.tag === 'string' && s.tag.trim() ? s.tag.trim() : undefined,
    sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? Math.floor(sampleSize) : undefined,
    conversationKeys,
  };
}

/**
 * What a run is asked to analyze: the conversation corpus, a definition's agent
 * sessions (the service fills in agents and window from the definition's source),
 * or an evaluation dataset (AI labeling; resolved + project-checked by the caller).
 */
type RequestedTarget =
  | { kind: 'conversations' }
  | { kind: 'agent_sessions'; days?: number }
  | { kind: 'dataset'; datasetId: string };

function sanitizeTarget(raw: unknown): RequestedTarget | undefined {
  if (raw === undefined || raw === null) return undefined;
  const bad = new ApiInputError(400, 'target must be { kind: "conversations" }, { kind: "agent_sessions", days? } or { kind: "dataset", datasetId }');
  if (typeof raw !== 'object') throw bad;
  const t = raw as Record<string, unknown>;
  if (t.kind === 'conversations') return { kind: 'conversations' };
  if (t.kind === 'agent_sessions') return { kind: 'agent_sessions', days: integerInRange(t.days, 'target.days', 1, 365) };
  if (t.kind === 'dataset' && typeof t.datasetId === 'string' && t.datasetId.trim()) {
    return { kind: 'dataset', datasetId: t.datasetId.trim() };
  }
  throw bad;
}

/**
 * The run request shared by run and estimate. Checks that the caller may analyze
 * the definition's agents (403), and resolves a dataset target here so a caller
 * can't point a run at another project's dataset by id.
 */
async function buildRunParams(
  request: Parameters<typeof sessionListScope>[0],
  ctx: { projectId: string; session: { tenantDbName: string; tenantId: string; userId: string } },
  definitionKey: string,
): Promise<RunDefinitionParams> {
  const { projectId, session } = ctx;
  // Body is optional (a bare "run everything" POST sends none), so use the
  // non-throwing reader — readJsonBody would 500 on an empty body.
  const parsed = safeReadJsonBody<Record<string, unknown> | null>(request);
  const body: Record<string, unknown> = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const selection = sanitizeSelection(body.selection);
  const conversationKeys = Array.isArray(body.conversationKeys)
    ? (body.conversationKeys as unknown[]).filter((k): k is string => typeof k === 'string')
    : undefined;
  const requested = sanitizeTarget(body.target);

  const db = await getDatabase();
  await db.switchToTenant(session.tenantDbName);
  const definition = await db.findAnalysisDefinitionByKey(definitionKey, projectId);
  if (!definition) throw new ApiInputError(404, `Analysis definition "${definitionKey}" not found`);
  if (definition.source?.kind === 'agent_sessions') {
    assertCanAnalyze(await callerScope(request, projectId, session.tenantDbName, session.userId), definition.source.agentKeys);
  }

  let target: RunDefinitionParams['target'];
  if (requested?.kind === 'dataset') {
    const dataset = await getDataset(session.tenantDbName, requested.datasetId);
    if (!dataset || (dataset.projectId && dataset.projectId !== projectId)) throw new ApiInputError(404, 'Dataset not found');
    target = { kind: 'dataset', datasetId: requested.datasetId, datasetKey: dataset.key, datasetName: dataset.name };
  } else if (requested) {
    target = requested.kind === 'agent_sessions'
      ? { kind: 'agent_sessions', ...(requested.days !== undefined ? { days: requested.days } : {}) }
      : requested;
  }
  return {
    tenantDbName: session.tenantDbName,
    tenantId: session.tenantId,
    projectId,
    createdBy: session.userId,
    definitionKey,
    selection,
    conversationKeys,
    target,
  };
}

// ── Views ───────────────────────────────────────────────────────────────────

const iso = (value: Date | string | undefined | null): string => (value ? new Date(value).toISOString() : '');

function decisionView(decision: IAnalysisDecision, withProbabilities: boolean) {
  const { probabilities, ...rest } = decision;
  return withProbabilities && probabilities ? { ...rest, probabilities } : rest;
}

function decisionsView(decisions: IAnalysisResult['decisions'] | undefined, withProbabilities: boolean) {
  return Object.fromEntries(Object.entries(decisions ?? {}).map(([k, d]) => [k, decisionView(d, withProbabilities)]));
}

/** A result for a list: no probabilities, no extraction detail. */
function resultRowView(result: WithId<IAnalysisResult>, withProbabilities = false) {
  return {
    id: result.id,
    definitionKey: result.definitionKey,
    sourceKind: result.sourceKind,
    sourceId: result.sourceId,
    title: result.title ?? null,
    agentKey: result.agentKey ?? null,
    needsReview: result.needsReview,
    reviewReason: result.reviewReason ?? null,
    reviewed: !!result.review,
    minConfidence: result.minConfidence,
    decisions: decisionsView(result.decisions, withProbabilities),
    analyzedAt: iso(result.analyzedAt),
    runId: result.runId,
  };
}

/** A result in full (the review screen): probabilities, extraction, judge and the human review. */
function resultView(result: WithId<IAnalysisResult>) {
  return {
    ...resultRowView(result, true),
    extractedFields: result.extractedFields ?? {},
    ...(result.judge ? { judge: { score: result.judge.score, passed: result.judge.passed, reasoning: result.judge.reasoning } } : {}),
    ...(result.accuracy ? { accuracy: { score: result.accuracy.score, comparedCount: result.accuracy.comparedCount } } : {}),
    ...(result.rationale ? { rationale: result.rationale } : {}),
    review: result.review ? { values: result.review.values, by: result.review.by, at: result.review.at } : null,
    ...(result.sourceVersion ? { sourceVersion: result.sourceVersion } : {}),
  };
}

function agentSessionRowView(row: AgentSessionRow) {
  return {
    id: row.id,
    title: row.title,
    agentKey: row.agentKey,
    messageCount: row.messageCount,
    updatedAt: iso(row.updatedAt),
    origin: row.origin,
    result: row.result
      ? {
          id: row.result.id,
          needsReview: row.result.needsReview,
          reviewed: row.result.reviewed,
          stale: row.result.stale,
          analyzedAt: iso(row.result.analyzedAt),
          decisions: decisionsView(row.result.decisions as IAnalysisResult['decisions'], false),
        }
      : null,
  };
}

/**
 * Results of agent sessions that hold passages of knowledge base documents not open to everyone, which the viewer
 * may not read (the session's owner and the administrators of those knowledge bases may). The session's live marks
 * count too: it can have drawn on such a document after it was analyzed.
 */
async function hiddenResults<T extends Pick<IAnalysisResult, 'sourceKind' | 'sourceId' | 'kbRestricted' | 'ownerId'>>(
  request: FastifyRequest,
  viewer: { tenantDbName: string; userId: string },
  results: ReadonlyArray<T>,
): Promise<Set<T>> {
  const sessionIds = results.filter((result) => result.sourceKind === 'agent_session').map((result) => result.sourceId);
  const live = new Map(
    (sessionIds.length > 0 ? await runWithTenantScope(viewer.tenantDbName, (db) => db.findRestrictedAgentConversations(sessionIds)) : [])
      .map((conversation) => [String(conversation._id), conversation] as const),
  );
  return rowsWithHiddenContent(request, { tenantDbName: viewer.tenantDbName, viewerUserId: viewer.userId }, results, (result) => {
    const conversation = result.sourceKind === 'agent_session' ? live.get(result.sourceId) : undefined;
    return {
      tags: [...(result.kbRestricted ?? []), ...(conversation?.kbRestricted ?? [])],
      askers: [result.ownerId, conversation?.createdBy],
    };
  });
}

/** A run's items of such sessions: still counted, without what the analysis made of them. */
async function withoutRestrictedItems(
  request: FastifyRequest,
  viewer: { tenantDbName: string; userId: string },
  items: IAnalysisItemResult[],
): Promise<Array<IAnalysisItemResult & { restricted?: true }>> {
  const hidden = await rowsWithHiddenContent(request, { tenantDbName: viewer.tenantDbName, viewerUserId: viewer.userId }, items, (item) => ({
    tags: item.restriction?.kbRestricted,
    askers: [item.restriction?.ownerId],
  }));
  if (hidden.size === 0) return items;
  return items.map((item) => (hidden.has(item)
    ? {
      conversationKey: item.conversationKey,
      extractedFields: {},
      missing: [],
      passed: item.passed,
      ...(item.needsReview ? { needsReview: true } : {}),
      ...(item.resultId ? { resultId: item.resultId } : {}),
      restricted: true as const,
    }
    : item));
}

function pageParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(n, max)) : fallback;
}

export const analysisApiPlugin: FastifyPluginAsync = async (app) => {
  // ── Definitions ────────────────────────────────────────────────────

  app.get('/analysis/definitions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const definitions = await listDefinitions(session.tenantDbName, { projectId, search: query.search });
      return reply.code(200).send({ definitions });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/analysis/definitions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }
      const fieldSet = sanitizeFieldSet(body.fieldSet);
      if (!fieldSet || fieldSet.length === 0) {
        return reply.code(400).send({ error: 'fieldSet must be a non-empty array of { key, type }' });
      }
      const modes = sanitizeModes(body.modes);
      if (modes.judge && typeof body.judgeModelKey !== 'string') {
        return reply.code(400).send({ error: 'judgeModelKey is required when the judge mode is enabled' });
      }
      const runConfig = body.runConfig && typeof body.runConfig === 'object'
        ? { concurrency: Number((body.runConfig as Record<string, unknown>).concurrency) || undefined }
        : undefined;
      const scheduleResult = sanitizeSchedule(body.schedule);
      if (scheduleResult.error) return reply.code(400).send({ error: scheduleResult.error });
      const decisionModelKey = await resolveDecisionModelKey(body.decisionModelKey, { tenantDbName: session.tenantDbName, projectId });
      const extractionModelKey = typeof body.extractionModelKey === 'string' && body.extractionModelKey.trim()
        ? body.extractionModelKey
        : undefined;
      checkFieldRouting(fieldSet, decisionModelKey, extractionModelKey);
      const source = await sanitizeSource(body.source, {
        tenantDbName: session.tenantDbName,
        projectId,
        scope: () => callerScope(request, projectId, session.tenantDbName, session.userId),
      });
      const review = sanitizeReview(body.review);
      const definition = await createDefinition(session.tenantDbName, session.tenantId, session.userId, {
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : undefined,
        fieldSet,
        extractionInstructions: typeof body.extractionInstructions === 'string' ? body.extractionInstructions : undefined,
        modes,
        extractionModelKey,
        judgeModelKey: typeof body.judgeModelKey === 'string' ? body.judgeModelKey : undefined,
        decisionModelKey,
        source,
        review,
        runConfig,
        schedule: scheduleResult.schedule,
        projectId,
      });
      return reply.code(201).send({ definition });
    } catch (error) {
      logger.error('Create analysis definition error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const definition = await getDefinition(session.tenantDbName, id);
      if (!definition) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ definition });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.patch('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const body = readJsonBody<Record<string, unknown>>(request);
      const fieldSet = body.fieldSet !== undefined ? sanitizeFieldSet(body.fieldSet) : undefined;
      if (body.fieldSet !== undefined && (!fieldSet || fieldSet.length === 0)) {
        return reply.code(400).send({ error: 'fieldSet must be a non-empty array of { key, type }' });
      }
      const scheduleResult = sanitizeSchedule(body.schedule);
      if (scheduleResult.error) return reply.code(400).send({ error: scheduleResult.error });

      const existing = await getDefinition(session.tenantDbName, id);
      if (!existing) return reply.code(404).send({ error: 'Definition not found' });
      const projectId = existing.projectId ?? '';
      // Changing what is asked of sessions is analyzing them: the caller must be allowed to.
      if (existing.source?.kind === 'agent_sessions') {
        assertCanAnalyze(await callerScope(request, projectId, session.tenantDbName, session.userId), existing.source.agentKeys);
      }

      // null (or '') clears the decision model; absent leaves it.
      const decisionModelKey = body.decisionModelKey !== undefined
        ? await resolveDecisionModelKey(body.decisionModelKey, { tenantDbName: session.tenantDbName, projectId })
        : existing.decisionModelKey;
      const extractionModelKey = body.extractionModelKey !== undefined
        ? (body.extractionModelKey as string | undefined)
        : existing.extractionModelKey;
      // Only a change to what decides the routing is re-checked, so an unrelated edit never trips on a legacy definition.
      if (body.fieldSet !== undefined || body.decisionModelKey !== undefined || body.extractionModelKey !== undefined) {
        checkFieldRouting(fieldSet ?? existing.fieldSet, decisionModelKey, extractionModelKey || undefined);
      }
      const source = await sanitizeSource(body.source, {
        tenantDbName: session.tenantDbName,
        projectId,
        scope: () => callerScope(request, projectId, session.tenantDbName, session.userId),
      });
      const review = sanitizeReview(body.review);
      // Only the keys the body names: the Mongo driver writes an undefined value as null, so a
      // partial PATCH (the calibration card sends just the fieldSet) must not carry the others.
      const definition = await updateDefinition(session.tenantDbName, id, session.userId, {
        ...(body.name !== undefined ? { name: body.name as string } : {}),
        ...(body.description !== undefined ? { description: body.description as string } : {}),
        ...(fieldSet ? { fieldSet } : {}),
        ...(body.extractionInstructions !== undefined ? { extractionInstructions: body.extractionInstructions as string } : {}),
        ...(body.modes !== undefined ? { modes: sanitizeModes(body.modes) } : {}),
        ...(body.extractionModelKey !== undefined ? { extractionModelKey: body.extractionModelKey as string } : {}),
        ...(body.judgeModelKey !== undefined ? { judgeModelKey: body.judgeModelKey as string } : {}),
        // Present with an undefined value (null or '' in the body) clears it.
        ...(body.decisionModelKey !== undefined ? { decisionModelKey } : {}),
        // null clears the source back to the corpus.
        ...(source ? { source } : body.source === null ? { source: { kind: 'conversations' as const } } : {}),
        ...(review ? { review } : {}),
        ...(body.schedule !== undefined ? { schedule: scheduleResult.schedule } : {}),
      });
      if (!definition) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ definition });
    } catch (error) {
      logger.error('Update analysis definition error', { error });
      return internalError(reply, error);
    }
  }));

  app.delete('/analysis/definitions/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const existing = await getDefinition(session.tenantDbName, id);
      if (!existing) return reply.code(404).send({ error: 'Definition not found' });
      // Deleting drops the session results and their reviews: same right as analyzing them.
      if (existing.source?.kind === 'agent_sessions') {
        const projectId = existing.projectId ?? '';
        assertCanAnalyze(await callerScope(request, projectId, session.tenantDbName, session.userId), existing.source.agentKeys);
      }
      const deleted = await deleteDefinition(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Conversations ──────────────────────────────────────────────────

  app.get('/analysis/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string; tag?: string; limit?: string; skip?: string };
      const conversations = await listConversations(session.tenantDbName, {
        projectId,
        search: query.search,
        tag: query.tag,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 10000) : 5000,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      return reply.code(200).send({ conversations });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.post('/analysis/conversations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);
      // Optional top-level `tags` applies to every conversation in the batch
      // (merged with any per-conversation tags) — handy for the ingest modal.
      const defaultTags = sanitizeTags(body.tags);
      const rawList = Array.isArray(body.conversations) ? body.conversations : [body];
      const inputs: CreateConversationInput[] = [];
      for (const raw of rawList) {
        const input = toConversationInput(raw as Record<string, unknown>, defaultTags);
        if (!input) {
          return reply.code(400).send({ error: 'each conversation needs a transcript array of { role, content }' });
        }
        inputs.push(input);
      }
      if (inputs.length === 0) {
        return reply.code(400).send({ error: 'no conversations to ingest' });
      }
      const conversations = await ingestConversations(session.tenantDbName, session.tenantId, session.userId, inputs, projectId);
      return reply.code(201).send({ conversations });
    } catch (error) {
      logger.error('Ingest analysis conversations error', { error });
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/conversations/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const conversation = await getConversation(session.tenantDbName, id);
      if (!conversation) return reply.code(404).send({ error: 'Conversation not found' });
      return reply.code(200).send({ conversation });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.delete('/analysis/conversations/:id', withApiRequestContext(async (request, reply) => {
    try {
      const session = requireSessionContext(request);
      const { id } = request.params as { id: string };
      const deleted = await deleteConversation(session.tenantDbName, id);
      if (!deleted) return reply.code(404).send({ error: 'Conversation not found' });
      return reply.code(200).send({ success: true });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Runs ───────────────────────────────────────────────────────────

  app.post('/analysis/definitions/:key/run', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const params = await buildRunParams(request, { projectId, session }, key);
      // Enqueue + return immediately (status 'pending'); the queue consumer runs
      // it in the background so the dashboard never blocks. The UI polls the run
      // detail endpoint to watch progress.
      const run = await enqueueDefinitionRun(params);
      return reply.code(202).send({ run });
    } catch (error) {
      logger.error('Run analysis definition error', { error });
      return serviceError(reply, error);
    }
  }));

  // What a run would cost, from the same selection the run would make.
  app.post('/analysis/definitions/:key/estimate', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const params = await buildRunParams(request, { projectId, session }, key);
      const estimate = await estimateRun(params);
      return reply.code(200).send({ estimate });
    } catch (error) {
      logger.error('Estimate analysis run error', { error });
      return serviceError(reply, error);
    }
  }));

  // How often the decision model agrees with the human reviews, per question.
  app.get('/analysis/definitions/:id/calibration', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const calibration = await getCalibration(session.tenantDbName, { projectId, definitionId: id });
      if (!calibration) return reply.code(404).send({ error: 'Definition not found' });
      return reply.code(200).send({ calibration });
    } catch (error) {
      return serviceError(reply, error);
    }
  }));

  app.get('/analysis/runs', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { definitionKey?: string; limit?: string; skip?: string };
      const runs = await listRuns(session.tenantDbName, {
        projectId,
        definitionKey: query.definitionKey,
        limit: query.limit ? Math.min(Number.parseInt(query.limit, 10), 200) : undefined,
        skip: query.skip ? Number.parseInt(query.skip, 10) : undefined,
      });
      // Agent-session items describe individual sessions: a restricted caller reads them on the
      // run page (filtered there), never in the list, which only needs the totals.
      const hasSessionRuns = runs.some((run) => run.target?.kind === 'agent_sessions');
      const viewer = hasSessionRuns ? viewerOf(await callerScope(request, projectId, session.tenantDbName, session.userId)) : undefined;
      if (viewer) {
        return reply.code(200).send({ runs: runs.map((run) => (run.target?.kind === 'agent_sessions' ? { ...run, items: [] } : run)) });
      }
      const shown = [];
      for (const run of runs) {
        shown.push(run.target?.kind === 'agent_sessions' ? { ...run, items: await withoutRestrictedItems(request, session, run.items) } : run);
      }
      return reply.code(200).send({ runs: shown });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/runs/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const run = await getRun(session.tenantDbName, id);
      if (!run || (run.projectId && run.projectId !== projectId)) return reply.code(404).send({ error: 'Run not found' });
      if (run.target?.kind === 'agent_sessions') {
        const viewer = viewerOf(await callerScope(request, projectId, session.tenantDbName, session.userId));
        const items = viewer ? await visibleRunItems(session.tenantDbName, run, viewer) : run.items;
        return reply.code(200).send({ run: { ...run, items: await withoutRestrictedItems(request, session, items) } });
      }
      return reply.code(200).send({ run });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // ── Agent sessions + results ───────────────────────────────────────

  // A definition's agent sessions with their analysis state (the picker of a run).
  app.get('/analysis/sources/agent-sessions', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { definitionKey?: string; agentKey?: string; days?: string; limit?: string; cursor?: string };
      if (typeof query.definitionKey !== 'string' || !query.definitionKey.trim()) {
        return reply.code(400).send({ error: 'definitionKey is required' });
      }
      let days: number | undefined;
      if (query.days !== undefined) {
        days = Number(query.days);
        if (!Number.isInteger(days) || days < 1 || days > 365) {
          return reply.code(400).send({ error: 'days must be an integer between 1 and 365' });
        }
      }
      // Rows are restricted inside the query exactly as the agent session lists are.
      const scope = await callerScope(request, projectId, session.tenantDbName, session.userId);
      const { rows, nextCursor } = await listAgentSessionRows(session.tenantDbName, {
        projectId,
        definitionKey: query.definitionKey.trim(),
        agentKey: queryText(query.agentKey),
        days,
        limit: pageParam(query.limit, 50, 1, 100),
        cursor: queryText(query.cursor),
        ownOnly: scope.ownOnly,
      });
      return reply.code(200).send({ rows: rows.map(agentSessionRowView), ...(nextCursor ? { nextCursor } : {}) });
    } catch (error) {
      return serviceError(reply, error);
    }
  }));

  app.get('/analysis/results', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { definitionKey?: string; needsReview?: string; sort?: string; limit?: string; skip?: string };
      const scope = await callerScope(request, projectId, session.tenantDbName, session.userId);
      const { results, total } = await listResults(session.tenantDbName, {
        projectId,
        definitionKey: queryText(query.definitionKey),
        needsReview: query.needsReview === 'true' ? true : query.needsReview === 'false' ? false : undefined,
        sort: query.sort === 'confidence' || query.sort === 'recent' ? query.sort : undefined,
        limit: pageParam(query.limit, 50, 1, 200),
        skip: pageParam(query.skip, 0, 0, Number.MAX_SAFE_INTEGER),
        viewer: viewerOf(scope),
      });
      const hidden = await hiddenResults(request, session, results);
      return reply.code(200).send({
        results: results.map((r) => (hidden.has(r) ? { ...resultRowView(r), title: null, decisions: {}, restricted: true } : resultRowView(r))),
        total,
      });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  app.get('/analysis/results/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const scope = await callerScope(request, projectId, session.tenantDbName, session.userId);
      const detail = await getResultDetail(session.tenantDbName, { projectId, id, viewer: viewerOf(scope) });
      if (!detail) return reply.code(404).send({ error: 'Result not found' });
      if ((await hiddenResults(request, session, [detail.result])).size > 0) {
        return reply.code(403).send({ error: SESSION_RESTRICTED_MESSAGE, code: 'session_restricted' });
      }
      return reply.code(200).send({ result: resultView(detail.result), definition: detail.definition, source: detail.source });
    } catch (error) {
      return internalError(reply, error);
    }
  }));

  // A human's answers replace the model's for calibration and for the report.
  app.post('/analysis/results/:id/review', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const body = readBody(request);
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        return reply.code(400).send({ error: 'values must be an object' });
      }
      const scope = await callerScope(request, projectId, session.tenantDbName, session.userId);
      // Reviewing a result is reading what it says of its session.
      const current = await runWithTenantScope(session.tenantDbName, (db) => db.findAnalysisResultById(id));
      if (current && (current.projectId ?? '') === projectId
        && (await hiddenResults(request, session, [current])).size > 0) {
        return reply.code(403).send({ error: SESSION_RESTRICTED_MESSAGE, code: 'session_restricted' });
      }
      const result = await saveResultReview(session.tenantDbName, {
        projectId,
        id,
        userId: session.userId,
        values: body.values as Record<string, unknown>,
        viewer: viewerOf(scope),
      });
      if (!result) return reply.code(404).send({ error: 'Result not found' });
      return reply.code(200).send({ result: resultView(result) });
    } catch (error) {
      logger.error('Review analysis result error', { error });
      return serviceError(reply, error);
    }
  }));
};
