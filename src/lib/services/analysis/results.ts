/**
 * Analysis results — reading, reviewing and judging them.
 *
 * `analysis_results` holds the latest answer per conversation and definition
 * (written by runs in service.ts). This module serves them to the dashboard:
 * the review queue, a result with its source transcript, the human review,
 * per-question calibration, a cost estimate before a run, and the agent-session
 * browser (sessions joined with their results).
 *
 * Visibility: an agent-session result is visible to a restricted viewer only
 * when it belongs to one of the agents they may view or to a session they
 * started. Imported-conversation results carry no such restriction.
 */

import { getDatabase } from '@/lib/database';
import type {
  IAnalysisDecision,
  IAnalysisDefinition,
  IAnalysisFieldDef,
  IAnalysisItemResult,
  IAnalysisResult,
  IAnalysisReviewSettings,
  IAnalysisResultReview,
  IAnalysisRun,
} from '@/lib/database';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { getModelByKey } from '@/lib/services/models/modelService';
import { computeCalibration, type CalibrationReport } from './calibration';
import { buildDecisionQuestions, isDecisionField, MAX_DECISION_INPUT_CHARS, DEFAULT_REVIEW_THRESHOLD } from './decision';
import {
  agentConversationToAnalysis,
  conversationId,
  isExcludedOrigin,
  loadResultsBySource,
  originOf,
  sameVersion,
  sourceVersionOf,
} from './agentSessions';
import { resolveRun, stripProbabilities, toView, type RunDefinitionParams, type WithId } from './service';
import type { AnalysisMessage } from './types';

/** A restricted viewer's scope over agent sessions; `undefined` where it is taken means unrestricted. */
export interface AnalysisViewer {
  userId: string;
  /** Agents whose sessions the viewer may see (besides their own). */
  agentKeys: string[];
}

/** Thrown for a review the caller got wrong (the route answers 400). */
export class AnalysisReviewError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisReviewError';
  }
}

const DECISION_TYPES = new Set(['enum', 'boolean', 'score']);
/** sourceIds per results query (the providers' IN-list cap). */
const ID_CHUNK = 500;

function isVisible(result: Pick<IAnalysisResult, 'sourceKind' | 'agentKey' | 'ownerId'>, viewer?: AnalysisViewer): boolean {
  if (!viewer || result.sourceKind !== 'agent_session') return true;
  return (!!result.agentKey && viewer.agentKeys.includes(result.agentKey)) || result.ownerId === viewer.userId;
}

async function tenantDb(tenantDbName: string) {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

// ── Listing ──────────────────────────────────────────────────────────────────

/** Results of a project, newest first or least confident first (the review queue). */
/**
 * The items of an agent-session run a restricted viewer may see: those whose
 * session result is visible to them (their own sessions, or sessions of agents
 * whose sessions they may view). Items without a result row (errored) stay hidden.
 */
export async function visibleRunItems(
  tenantDbName: string,
  run: Pick<IAnalysisRun, 'projectId' | 'definitionKey' | 'items'>,
  viewer: AnalysisViewer,
): Promise<IAnalysisItemResult[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const keys = run.items.map((item) => item.conversationKey);
  const visible = new Set<string>();
  for (let i = 0; i < keys.length; i += ID_CHUNK) {
    const chunk = keys.slice(i, i + ID_CHUNK);
    const rows = await db.listAnalysisResults({
      projectId: run.projectId ?? '',
      definitionKey: run.definitionKey,
      sourceKind: 'agent_session',
      sourceIds: chunk,
      viewer,
      limit: chunk.length,
    });
    for (const row of rows) visible.add(row.sourceId);
  }
  return run.items.filter((item) => visible.has(item.conversationKey));
}

export async function listResults(
  tenantDbName: string,
  params: {
    projectId: string;
    definitionKey?: string;
    needsReview?: boolean;
    sort?: 'recent' | 'confidence';
    limit?: number;
    skip?: number;
    viewer?: AnalysisViewer;
  },
): Promise<{ results: WithId<IAnalysisResult>[]; total: number }> {
  const db = await tenantDb(tenantDbName);
  const filter = {
    projectId: params.projectId,
    definitionKey: params.definitionKey,
    needsReview: params.needsReview,
    viewer: params.viewer,
  };
  const [results, total] = await Promise.all([
    db.listAnalysisResults({ ...filter, sort: params.sort, limit: params.limit, skip: params.skip }),
    db.countAnalysisResults(filter),
  ]);
  return { results: results.map(toView), total };
}

// ── Detail ───────────────────────────────────────────────────────────────────

/** The conversation behind a result, as the reviewer reads it. */
export interface ResultSource {
  kind: 'conversation' | 'agent_session';
  id: string;
  /** False when the conversation is gone (deleted, or moved out of the project). */
  available: boolean;
  title: string | null;
  agentKey?: string;
  /** Dashboard path to the source (omitted when it cannot be opened). */
  href?: string;
  messageCount?: number;
  transcript: AnalysisMessage[];
}

export interface ResultDetail {
  result: WithId<IAnalysisResult>;
  definition: {
    id: string;
    key: string;
    name: string;
    fieldSet: IAnalysisFieldDef[];
    decisionModelKey?: string;
    review?: IAnalysisReviewSettings;
  };
  source: ResultSource;
}

async function loadSource(
  db: Awaited<ReturnType<typeof tenantDb>>,
  result: IAnalysisResult,
  projectId: string,
): Promise<ResultSource> {
  if (result.sourceKind === 'agent_session') {
    const missing: ResultSource = {
      kind: 'agent_session',
      id: result.sourceId,
      available: false,
      title: result.title ?? null,
      ...(result.agentKey ? { agentKey: result.agentKey } : {}),
      transcript: [],
    };
    const conv = await db.findAgentConversationById(result.sourceId);
    if (!conv || conv.projectId !== projectId) return missing;
    const agent = await db.findAgentByKey(conv.agentKey, projectId);
    const agentId = agent ? String(agent._id ?? '') : '';
    return {
      kind: 'agent_session',
      id: result.sourceId,
      available: true,
      title: conv.title ?? result.title ?? null,
      agentKey: conv.agentKey,
      ...(agentId ? { href: `/dashboard/agents/${agentId}/sessions/${result.sourceId}` } : {}),
      messageCount: conv.messages?.length ?? 0,
      transcript: agentConversationToAnalysis(conv).transcript,
    };
  }

  const conv = await db.findAnalysisConversationByKey(result.sourceId, projectId || undefined);
  if (!conv) {
    return { kind: 'conversation', id: result.sourceId, available: false, title: result.title ?? null, transcript: [] };
  }
  return {
    kind: 'conversation',
    id: result.sourceId,
    available: true,
    title: conv.name || conv.key,
    href: `/dashboard/analysis/conversations/${toView(conv).id}`,
    messageCount: conv.transcript.length,
    transcript: conv.transcript.map((m) => ({ role: m.role, content: m.content })),
  };
}

/**
 * One result with its definition and source transcript. Null when it does not
 * exist, belongs to another project, or the viewer may not see it.
 */
export async function getResultDetail(
  tenantDbName: string,
  params: { projectId: string; id: string; viewer?: AnalysisViewer },
): Promise<ResultDetail | null> {
  const db = await tenantDb(tenantDbName);
  const result = await db.findAnalysisResultById(params.id);
  if (!result || result.projectId !== params.projectId || !isVisible(result, params.viewer)) return null;
  const definition = await db.findAnalysisDefinitionByKey(result.definitionKey, params.projectId || undefined);
  if (!definition) return null;
  const source = await loadSource(db, result, params.projectId);
  return {
    result: toView(result),
    definition: {
      id: toView(definition).id,
      key: definition.key,
      name: definition.name,
      fieldSet: definition.fieldSet,
      ...(definition.decisionModelKey ? { decisionModelKey: definition.decisionModelKey } : {}),
      ...(definition.review ? { review: definition.review } : {}),
    },
    source,
  };
}

// ── Review ───────────────────────────────────────────────────────────────────

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}

/** Match a human value against an allowed list, ignoring case; returns the canonical label. */
function matchLabel(value: unknown, allowed: string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const wanted = value.trim().toLowerCase();
  return (allowed ?? []).find((a) => a.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Save a human review: the correct answer per decision question. A question
 * not named in `values` is confirmed as the model answered it. Replaces an
 * earlier review. Returns null when the result is missing or not visible;
 * throws AnalysisReviewError for values that do not fit the definition.
 */
export async function saveResultReview(
  tenantDbName: string,
  params: { projectId: string; id: string; userId: string; values: Record<string, unknown>; viewer?: AnalysisViewer },
): Promise<WithId<IAnalysisResult> | null> {
  const db = await tenantDb(tenantDbName);
  const result = await db.findAnalysisResultById(params.id);
  if (!result || result.projectId !== params.projectId || !isVisible(result, params.viewer)) return null;
  const definition = await db.findAnalysisDefinitionByKey(result.definitionKey, params.projectId || undefined);
  if (!definition) return null;

  const values = params.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new AnalysisReviewError('values must be an object');
  }
  const decisionFields = definition.fieldSet.filter((f) => DECISION_TYPES.has(f.type));
  const known = new Set(decisionFields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new AnalysisReviewError(`Unknown question "${key}"`);
  }

  const reviewed: Record<string, unknown> = {};
  for (const field of decisionFields) {
    const given = values[field.key];
    if (given === undefined || given === null) {
      // Not corrected: the reviewer agrees with the model (nothing to confirm when it refused).
      const answer = result.decisions?.[field.key]?.answer;
      if (answer !== undefined) reviewed[field.key] = answer;
      continue;
    }
    if (field.type === 'boolean') {
      const bool = parseBoolean(given);
      if (bool === null) throw new AnalysisReviewError(`"${field.key}" must be yes or no`);
      reviewed[field.key] = bool;
    } else {
      const label = matchLabel(given, field.type === 'enum' ? field.enumValues : field.levels);
      if (label === null) {
        throw new AnalysisReviewError(
          `"${field.key}" must be one of: ${(field.type === 'enum' ? field.enumValues : field.levels)?.join(', ') ?? ''}`,
        );
      }
      reviewed[field.key] = label;
    }
  }

  const review: IAnalysisResultReview = { values: reviewed, by: params.userId, at: new Date().toISOString() };
  const updated = await db.updateAnalysisResultReview(params.id, review);
  return updated ? toView(updated) : null;
}

// ── Calibration ──────────────────────────────────────────────────────────────

/** How often the decision model agrees with the human reviews, per question. Null when the definition is not in the project. */
export async function getCalibration(
  tenantDbName: string,
  params: { projectId: string; definitionId: string },
): Promise<(CalibrationReport & { definitionKey: string }) | null> {
  const db = await tenantDb(tenantDbName);
  const definition = await db.findAnalysisDefinitionById(params.definitionId);
  if (!definition || (definition.projectId ?? '') !== params.projectId) return null;
  const reviewed = await db.listAnalysisResults({
    projectId: params.projectId,
    definitionKey: definition.key,
    reviewed: true,
    limit: 5000,
  });
  const report = computeCalibration(reviewed, definition.fieldSet, {
    defaultThreshold: definition.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD,
  });
  return { ...report, definitionKey: definition.key };
}

// ── Estimate ─────────────────────────────────────────────────────────────────

export interface RunEstimate {
  /** Conversations the run would cover. */
  conversations: number;
  /** How many of them the averages were measured on. */
  sampled: number;
  avgChars: number;
  inputTokens: number;
  outputTokens: number;
  cost: {
    /** Per role; null when the role is not used or its model has no price on record. */
    decision: number | null;
    extraction: number | null;
    judge: number | null;
    /** Null when a used role has no price (the estimate is then incomplete). */
    total: number | null;
    currency: string;
  };
}

/** Sessions measured for the average length (the rest of a big run is assumed alike). */
const ESTIMATE_SESSION_SAMPLE = 30;

function charsOf(transcript: AnalysisMessage[]): number {
  return transcript.reduce((sum, m) => sum + m.content.length, 0);
}

function optionCount(field: IAnalysisFieldDef): number {
  if (field.type === 'enum') return field.enumValues?.length ?? 0;
  if (field.type === 'score') return field.levels?.length ?? 0;
  return 2;
}

/**
 * Estimate a run's tokens and cost from the selection a run would make. A
 * rough guide (4 characters a token, fixed prompt overheads), not a quote.
 */
export async function estimateRun(params: RunDefinitionParams): Promise<RunEstimate> {
  const db = await tenantDb(params.tenantDbName);
  const definition = await db.findAnalysisDefinitionByKey(params.definitionKey, params.projectId);
  if (!definition) throw new Error(`Analysis definition "${params.definitionKey}" not found`);
  const resolved = await resolveRun(db, definition, params);

  let conversations: number;
  let sampled: number;
  let totalChars: number;
  if (resolved.kind === 'agent_sessions') {
    conversations = resolved.ids.length;
    const sample = await db.listAgentConversationsForAnalysis({
      projectId: params.projectId ?? '',
      agentKeys: resolved.target.agentKeys,
      ids: resolved.ids.slice(0, ESTIMATE_SESSION_SAMPLE),
      limit: ESTIMATE_SESSION_SAMPLE,
      fields: 'full',
    });
    sampled = sample.length;
    totalChars = sample.reduce((sum, s) => sum + charsOf(agentConversationToAnalysis(s).transcript), 0);
  } else {
    conversations = resolved.items.length;
    sampled = conversations;
    totalChars = resolved.items.reduce((sum, i) => sum + charsOf(i.conversation.transcript), 0);
  }
  const avgChars = sampled > 0 ? Math.round(totalChars / sampled) : 0;
  const t = Math.ceil(Math.min(avgChars, MAX_DECISION_INPUT_CHARS) / 4);

  const spec = { useDecisionModel: !!definition.decisionModelKey };
  const decisionFields = definition.fieldSet.filter((f) => isDecisionField(f, spec));
  const extractionFields = definition.fieldSet.filter((f) => !isDecisionField(f, spec));

  const perConversation = { decision: { in: 0, out: 0 }, extraction: { in: 0, out: 0 }, judge: { in: 0, out: 0 } };
  if (decisionFields.length > 0) {
    const questionChars = JSON.stringify(buildDecisionQuestions(decisionFields)).length;
    perConversation.decision = {
      in: t + Math.ceil(questionChars / 4) + 300,
      out: 15 * decisionFields.reduce((sum, f) => sum + optionCount(f), 0) + 120,
    };
  }
  const usesExtraction = extractionFields.length > 0 || !definition.decisionModelKey;
  if (usesExtraction) perConversation.extraction = { in: t + 400, out: 30 * extractionFields.length };
  const usesJudge = !!definition.modes.judge;
  if (usesJudge) perConversation.judge = { in: t + 300, out: 150 };

  const roles: Array<{ role: 'decision' | 'extraction' | 'judge'; used: boolean; modelKey?: string }> = [
    { role: 'decision', used: decisionFields.length > 0, modelKey: definition.decisionModelKey },
    { role: 'extraction', used: usesExtraction, modelKey: definition.extractionModelKey },
    { role: 'judge', used: usesJudge, modelKey: definition.judgeModelKey },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let currency: string | undefined;
  const cost: RunEstimate['cost'] = { decision: null, extraction: null, judge: null, total: null, currency: 'USD' };
  let complete = true;
  let total = 0;
  for (const { role, used, modelKey } of roles) {
    if (!used) continue;
    const input = perConversation[role].in * conversations;
    const output = perConversation[role].out * conversations;
    inputTokens += input;
    outputTokens += output;
    const model = modelKey ? await getModelByKey(params.tenantDbName, modelKey, params.projectId ?? '').catch(() => null) : null;
    if (!model?.pricing) {
      complete = false;
      continue;
    }
    const priced = calculateCost(model.pricing, { inputTokens: input, outputTokens: output });
    cost[role] = Math.round(priced.totalCost * 1e6) / 1e6;
    total += priced.totalCost;
    currency ??= priced.currency;
  }
  cost.total = complete ? Math.round(total * 1e6) / 1e6 : null;
  cost.currency = currency ?? 'USD';

  return { conversations, sampled, avgChars, inputTokens, outputTokens, cost };
}

// ── Agent session browser ────────────────────────────────────────────────────

export interface AgentSessionRow {
  id: string;
  title: string | null;
  agentKey: string;
  messageCount: number;
  updatedAt: Date;
  /** `metadata.source` of the session (console, api, trigger, ...). */
  origin: string | null;
  /** Its latest analysis by the definition; null = not analyzed yet. */
  result: null | {
    id: string;
    needsReview: boolean;
    reviewed: boolean;
    /** The session has changed since this analysis. */
    stale: boolean;
    analyzedAt: Date;
    decisions: Record<string, Omit<IAnalysisDecision, 'probabilities'>>;
  };
}

const SESSION_PAGE = 200;
/** Sessions one browse request may read before it returns a short page. */
const MAX_BROWSE_SCAN = 5_000;

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): { updatedAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = raw.indexOf('|');
  const updatedAt = new Date(raw.slice(0, split));
  if (split < 0 || Number.isNaN(updatedAt.getTime())) throw new Error('Invalid cursor');
  return { updatedAt, id: raw.slice(split + 1) };
}

/**
 * A definition's agent sessions (newest first) with their analysis state, for
 * picking sessions to analyze. `ownOnly` restricts a viewer exactly as the
 * agent session lists do (applied inside the query, so pages are never short
 * because of visibility).
 */
export async function listAgentSessionRows(
  tenantDbName: string,
  params: {
    projectId: string;
    definitionKey: string;
    agentKey?: string;
    days?: number;
    limit?: number;
    cursor?: string;
    ownOnly?: { userId: string; viewableAgentKeys?: string[] };
  },
): Promise<{ rows: AgentSessionRow[]; nextCursor?: string }> {
  const db = await tenantDb(tenantDbName);
  const definition: IAnalysisDefinition | null = await db.findAnalysisDefinitionByKey(params.definitionKey, params.projectId);
  if (!definition) throw new Error(`Analysis definition "${params.definitionKey}" not found`);
  const source = definition.source?.kind === 'agent_sessions' ? definition.source : undefined;
  if (!source) throw new Error('This definition does not analyze agent sessions');
  if (params.agentKey && !source.agentKeys.includes(params.agentKey)) {
    throw new Error(`Agent "${params.agentKey}" is not analyzed by this definition`);
  }

  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  const agentKeys = params.agentKey ? [params.agentKey] : source.agentKeys;
  const updatedFrom = new Date(Date.now() - (params.days ?? source.days ?? 7) * 24 * 60 * 60 * 1000);

  // Page until `limit + 1` real sessions: synthetic ones (evaluation, red-team) are dropped after the query.
  // The scan is capped so a window full of synthetic sessions cannot make one request read them all:
  // a capped page comes back short, with a cursor where the scan stopped.
  const sessions: Awaited<ReturnType<typeof db.listAgentConversationsForAnalysis>> = [];
  let before = decodeCursor(params.cursor);
  let scanned = 0;
  let capped = false;
  while (sessions.length <= limit) {
    const page = await db.listAgentConversationsForAnalysis({
      projectId: params.projectId,
      agentKeys,
      updatedFrom,
      ownOnly: params.ownOnly,
      before,
      limit: SESSION_PAGE,
      fields: 'meta',
    });
    scanned += page.length;
    sessions.push(...page.filter((s) => !isExcludedOrigin(s)));
    if (page.length < SESSION_PAGE) break;
    const last = page[page.length - 1];
    before = { updatedAt: new Date(last.updatedAt ?? 0), id: conversationId(last) };
    if (scanned >= MAX_BROWSE_SCAN && sessions.length <= limit) {
      capped = true;
      break;
    }
  }

  const pageRows = sessions.slice(0, limit);
  const existing = await loadResultsBySource(db, params.projectId, definition.key, 'agent_session', pageRows.map(conversationId));
  const rows: AgentSessionRow[] = pageRows.map((session) => {
    const id = conversationId(session);
    const result = existing.get(id);
    return {
      id,
      title: session.title ?? null,
      agentKey: session.agentKey,
      messageCount: session.messages?.length ?? 0,
      updatedAt: new Date(session.updatedAt ?? 0),
      origin: originOf(session),
      result: result
        ? {
            id: String(result._id ?? ''),
            needsReview: result.needsReview,
            reviewed: !!result.review,
            stale: !sameVersion(result.sourceVersion, sourceVersionOf(session)),
            analyzedAt: result.analyzedAt,
            decisions: stripProbabilities(result.decisions),
          }
        : null,
    };
  });

  const more = sessions.length > limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = more && last
    ? encodeCursor(new Date(last.updatedAt ?? 0), conversationId(last))
    : capped && before ? encodeCursor(before.updatedAt, before.id) : undefined;
  return { rows, ...(nextCursor ? { nextCursor } : {}) };
}
