/**
 * Agent Tracing Service
 * Business logic for agent tracing operations
 */

import { getDatabase, type IAgentTracingEvent } from '@/lib/database';
import type { IAgentTracingSession } from '@/lib/database/provider/types.base';
import { createLogger } from '@/lib/core/logger';
import { deriveEnterpriseAgentInsights } from '@/enterprise/registry';
import {
  recordUsageEvent,
  type UsageAttribution,
} from '@/lib/services/usage/usageEvents';
import { calculateCost } from '@/lib/services/models/usageLogger';
import { resolveExternalPricingForDay } from '@/lib/services/modelPriceCatalog/externalPricing';
import { toUtcDay } from '@/lib/services/usage/usageBreakdown';
import { normalizeFinishReason } from '@/lib/shared/finishReason';
import dayjs from 'dayjs';

const logger = createLogger('agent-tracing');

/**
 * Usage accounting for one newly created tracing session. Call ONLY when a
 * session is created (not on merge/update ingests) and stamp the returned
 * attribution onto the session doc. No tokens — trace token counts are
 * accounted separately per model by `recordTraceModelUsage`.
 */
export function recordTracingSessionCreated(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  agentName?: string;
  /** Free-form caller-supplied attribution tags (tracing `metadata`). */
  metadata?: Record<string, string>;
}): UsageAttribution {
  return recordUsageEvent({
    tenantDbName: params.tenantDbName,
    tenantId: params.tenantId,
    projectId: params.projectId,
    service: 'tracing',
    refKey: params.agentName ?? '',
    metadata: params.metadata,
    status: 'success',
  });
}

// ── Trace-derived model usage / cost accounting ────────────────────────────
//
// Agents frequently call model providers DIRECTLY (not through the gateway)
// and only report what happened via tracing. Those tokens never hit the
// models service, so spend reports would miss them entirely. This block
// derives per-model usage from trace events, prices it with Model Hub
// pricing, and rolls it into `usage_daily` as
//   (service 'models', source 'tracing', agentKey = agentName)
// rows — separable from gateway-served rows (source 'api') in every report.
//
// DOUBLE-COUNT CONTRACT: a trace event describing a model call that DID go
// through this gateway must carry one of the markers below in its metadata;
// such events are skipped here because the models service already accounted
// them at serving time.

/** Metadata keys that mark a trace event as gateway-served (already billed). */
const GATEWAY_MARKER_KEYS = ['gatewayRequestId', 'consoleRequestId'] as const;

/** Loose event shape accepted from any ingestion path (OTLP / JSON / stream). */
export interface TraceUsageEventLike {
  model?: string;
  modelNames?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  /** Subset of `outputTokens` (e.g. OpenAI `completion_tokens_details.reasoning_tokens`);
   *  never added into `totalTokens` or any cost arithmetic. */
  reasoningTokens?: number;
  /** Model-call wall time — feeds the rollup's latency counters so latency
   *  optimization works for direct-to-provider (on-prem) traffic too. */
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

interface ModelTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  calls: number;
  /** Sum of durationMs over the calls that reported one. */
  durationMsSum: number;
  /** How many calls reported a durationMs. */
  durationSamples: number;
}

function isGatewayServed(event: TraceUsageEventLike): boolean {
  const metadata = event.metadata;
  if (!metadata) return false;
  if (metadata.gateway === true) return true;
  return GATEWAY_MARKER_KEYS.some(
    (key) => typeof metadata[key] === 'string' && (metadata[key] as string).length > 0,
  );
}

function eventModelName(event: TraceUsageEventLike): string | undefined {
  if (typeof event.model === 'string' && event.model.length > 0) return event.model;
  const fromList = event.modelNames?.find((name) => typeof name === 'string' && name.length > 0);
  return fromList;
}

/** Sum tokens per model name across events, skipping gateway-served ones. */
function sumTokensByModel(events: TraceUsageEventLike[]): Map<string, ModelTokenTotals> {
  const byModel = new Map<string, ModelTokenTotals>();
  for (const event of events) {
    const model = eventModelName(event);
    if (!model || isGatewayServed(event)) continue;
    const inputTokens = typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    const outputTokens = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    const cachedInputTokens =
      typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : 0;
    const reasoningTokens =
      typeof event.reasoningTokens === 'number' ? event.reasoningTokens : 0;
    if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) continue;
    const totals = byModel.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      calls: 0,
      durationMsSum: 0,
      durationSamples: 0,
    };
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cachedInputTokens += cachedInputTokens;
    totals.reasoningTokens += reasoningTokens;
    totals.calls += 1;
    if (typeof event.durationMs === 'number' && event.durationMs > 0) {
      totals.durationMsSum += event.durationMs;
      totals.durationSamples += 1;
    }
    byModel.set(model, totals);
  }
  return byModel;
}

/**
 * Record trace-derived model usage into the usage rollup.
 *
 * `events` are the events this ingest added; `previousEvents` (JSON session
 * re-posts, which delete + recreate all events) are subtracted per model so a
 * replayed session contributes zero delta. Pricing resolves against the Model
 * Hub by hub `key` first, then provider `modelId`, then the tenant's external
 * model pricing catalog (all case-insensitive) — an unmatched model still
 * records tokens with cost 0 so the Cost page can surface it as "unpriced"
 * instead of silently dropping it.
 *
 * Never throws — cost accounting must not break trace ingestion.
 */
export async function recordTraceModelUsage(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  agentName?: string;
  /** Free-form caller-supplied attribution tags (tracing `metadata`). */
  metadata?: Record<string, string>;
  events: TraceUsageEventLike[];
  previousEvents?: TraceUsageEventLike[];
}): Promise<void> {
  try {
    const current = sumTokensByModel(params.events);
    if (current.size === 0) return;
    const previous = params.previousEvents?.length
      ? sumTokensByModel(params.previousEvents)
      : undefined;

    const db = await getDatabase();
    await db.switchToTenant(params.tenantDbName);
    const models = await db.listModels({ projectId: params.projectId });
    const byKey = new Map(models.map((model) => [model.key.toLowerCase(), model]));
    const byModelId = new Map(models.map((model) => [model.modelId.toLowerCase(), model]));
    const externalEntries = await db.listExternalModelPricing(params.projectId);
    // Project-scoped entries win over tenant-wide ('') ones for the same name.
    const externalByName = new Map(
      externalEntries
        .sort((a, b) => (a.projectId === '' ? -1 : 1) - (b.projectId === '' ? -1 : 1))
        .map((entry) => [entry.normalizedName, entry]),
    );
    const today = toUtcDay(new Date());

    for (const [modelName, totals] of current) {
      const prior = previous?.get(modelName);
      const inputTokens = Math.max(0, totals.inputTokens - (prior?.inputTokens ?? 0));
      const outputTokens = Math.max(0, totals.outputTokens - (prior?.outputTokens ?? 0));
      const cachedInputTokens = Math.max(
        0,
        totals.cachedInputTokens - (prior?.cachedInputTokens ?? 0),
      );
      const reasoningTokens = Math.max(
        0,
        totals.reasoningTokens - (prior?.reasoningTokens ?? 0),
      );
      const calls = Math.max(0, totals.calls - (prior?.calls ?? 0));
      const durationMsSum = Math.max(0, totals.durationMsSum - (prior?.durationMsSum ?? 0));
      const durationSamples = Math.max(0, totals.durationSamples - (prior?.durationSamples ?? 0));
      if (inputTokens === 0 && outputTokens === 0 && cachedInputTokens === 0) continue;

      const lookup = modelName.toLowerCase();
      const hubModel = byKey.get(lookup) ?? byModelId.get(lookup);
      const externalEntry = externalByName.get(lookup);
      const pricing = hubModel?.pricing
        ?? (externalEntry ? resolveExternalPricingForDay(externalEntry, today) : undefined);
      const costUsd = pricing
        ? calculateCost(pricing, { inputTokens, outputTokens, cachedInputTokens }).totalCost
        : 0;

      recordUsageEvent({
        tenantDbName: params.tenantDbName,
        tenantId: params.tenantId,
        projectId: params.projectId,
        service: 'models',
        refKey: hubModel?.key ?? modelName,
        agentKey: params.agentName ?? '',
        metadata: params.metadata,
        source: 'tracing',
        status: 'success',
        inputTokens,
        outputTokens,
        cachedInputTokens,
        // reasoningTokens is a SUBSET of outputTokens — never add it into
        // totalTokens or cost arithmetic (mirrors cachedInputTokens handling).
        reasoningTokens,
        totalTokens: inputTokens + outputTokens + cachedInputTokens,
        costUsd,
        // Latency: aggregate model-call durations, weighted by sample count —
        // the on-prem optimization objective needs latency on tracing rows.
        ...(durationMsSum > 0 && durationSamples > 0
          ? { latencyMs: durationMsSum, latencySamples: durationSamples }
          : {}),
        units: { modelCalls: calls },
      });
    }
  } catch (error) {
    logger.warn('Trace-derived model usage accounting failed', {
      agentName: params.agentName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type SessionListQuery = Record<string, unknown> & {
  agentName?: string;
  agentNameExact?: string;
  from?: string;
  to?: string;
  includeTotal?: boolean;
  projection?: Record<string, 0 | 1>;
  limit?: number | string;
  skip?: number | string;
};

const THREAD_SESSION_PROJECTION = {
  sessionId: 1,
  agentName: 1,
  agentVersion: 1,
  status: 1,
  startedAt: 1,
  endedAt: 1,
  durationMs: 1,
  totalEvents: 1,
  totalInputTokens: 1,
  totalOutputTokens: 1,
  totalCachedInputTokens: 1,
  modelsUsed: 1,
  toolsUsed: 1,
} as const;

const AGENT_OVERVIEW_SESSION_PROJECTION = {
  sessionId: 1,
  threadId: 1,
  status: 1,
  startedAt: 1,
  durationMs: 1,
  totalEvents: 1,
  totalInputTokens: 1,
  totalOutputTokens: 1,
  totalCachedInputTokens: 1,
  agentVersion: 1,
  modelsUsed: 1,
  toolsUsed: 1,
  errors: 1,
} as const;

/** Model overview additionally needs the owning agent per session. */
const MODEL_OVERVIEW_SESSION_PROJECTION = {
  ...AGENT_OVERVIEW_SESSION_PROJECTION,
  agentName: 1,
} as const;

/** Agent directory (sub-nav) — the bare minimum per session. */
const AGENT_DIRECTORY_SESSION_PROJECTION = {
  agentName: 1,
  startedAt: 1,
  status: 1,
} as const;


const SESSION_LIST_PROJECTION = {
  sessionId: 1,
  threadId: 1,
  agentName: 1,
  status: 1,
  startedAt: 1,
  endedAt: 1,
  durationMs: 1,
  totalEvents: 1,
  totalInputTokens: 1,
  totalOutputTokens: 1,
  totalCachedInputTokens: 1,
  totalReasoningTokens: 1,
  truncatedEvents: 1,
  metadata: 1,
} as const;

// A field missing from this projection is invisible in the timeline list on
// Mongo (which honors projections) while SQLite (which ignores them and
// always returns full rows) still returns it — a silent provider-dependent
// difference. finishReason/reasoningTokens are listed here for that reason.
const SESSION_EVENT_SUMMARY_PROJECTION = {
  id: 1,
  sequence: 1,
  type: 1,
  label: 1,
  timestamp: 1,
  status: 1,
  durationMs: 1,
  toolName: 1,
  model: 1,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 1,
  cachedInputTokens: 1,
  reasoningTokens: 1,
  finishReason: 1,
  spanId: 1,
  parentSpanId: 1,
  // Per-turn tool menu, names only: sections survive as {kind} shells except
  // tool_definitions, which keeps tools[].name — a few bytes per event, so
  // the timeline can show "which tools were offered on this call" without
  // shipping message/tool payloads. (SQLite ignores projections and always
  // returns full sections; the summary mapper extracts the same names.)
  'sections.kind': 1,
  'sections.tools.name': 1,
} as const;

/**
 * True for an object that is really a string somebody spread into a record:
 * `{...'undefined'}` produces `{0:'u',1:'n',…}`.
 *
 * agent-sdk's `sanitizeTracePayload` answered an absent payload with the
 * literal string `"undefined"` until 0.9.5, and the ingest that ran before
 * the guard landed spread it into exactly this shape — so it is already
 * persisted on every session captured in between, and no migration can be
 * assumed. Matched on shape rather than on the word "undefined": keys are
 * exactly 0..n-1 and every value is a single character, which no genuine
 * tool-details or tool-definitions record ever looks like.
 */
function isSpreadStringRecord(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every((key, index) => key === String(index))
    && Object.values(value).every((entry) => typeof entry === 'string' && entry.length === 1);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return isSpreadStringRecord(record) ? undefined : record;
}

/**
 * Drop stored metadata entries that are spread-string wreckage (see
 * `isSpreadStringRecord`). The raw metadata bag is rendered verbatim in the
 * event detail's Metadata tab, so without this the same `{0:'u',…}` noise the
 * Tool Details panel now hides is still on screen one tab over.
 */
function stripSpreadStringValues(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const entries = Object.entries(metadata).filter(([, entry]) => !(
    entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && isSpreadStringRecord(entry as Record<string, unknown>)
  ));
  return entries.length === Object.keys(metadata).length
    ? metadata
    : Object.fromEntries(entries);
}

function getSectionToolName(section: Record<string, unknown>): string | undefined {
  const value = typeof section.tool === 'string'
    ? section.tool
    : (typeof section.toolName === 'string' ? section.toolName : undefined);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

function getStoredToolDetails(event: IAgentTracingEvent): Record<string, unknown> | undefined {
  const metadata = toRecord(event.metadata);
  const candidates = [
    toRecord(metadata?.toolDetails),
    ...(event.sections || []).map((section) => toRecord(section.toolDetails) || toRecord(section.details)),
  ];
  const details = candidates.find((candidate): candidate is Record<string, unknown> => Boolean(candidate));
  const name = typeof details?.name === 'string' && details.name.trim().length > 0
    ? details.name.trim()
    : event.toolName || (event.sections || []).map(getSectionToolName).find(Boolean);

  if (!details && !name) {
    return undefined;
  }

  return {
    ...(details || {}),
    ...(name && typeof details?.name !== 'string' ? { name } : {}),
  };
}

/** Cap on tool names surfaced per event summary (full menu in the detail). */
const SUMMARY_TOOL_NAME_CAP = 32;

/**
 * Names from the event's `tool_definitions` section — the tool menu the model
 * was offered on THIS call. Surfaced on summaries so the timeline can answer
 * "which tools were sent on this turn?" without opening every event. `count`
 * is the FULL menu size (names may be capped for payload discipline).
 */
function getToolDefinitionNames(
  event: IAgentTracingEvent,
): { names: string[]; count: number } | undefined {
  const section = (event.sections || []).find(
    (candidate) => toRecord(candidate)?.kind === 'tool_definitions',
  );
  const tools = toRecord(section)?.tools;
  if (!Array.isArray(tools)) return undefined;
  const names = tools
    .map((tool) => toRecord(tool)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (names.length === 0) return undefined;
  return { names: names.slice(0, SUMMARY_TOOL_NAME_CAP), count: names.length };
}

/**
 * `finishReason`/`reasoningTokens` became first-class columns on
 * `IAgentTracingEvent`; rows written before that migration only carry them
 * inside `metadata`. Fall back to the legacy location so old and new rows
 * compare equal — this fallback can be dropped once the backfill has run
 * everywhere.
 */
function legacyEventFinishReason(event: IAgentTracingEvent): string | undefined {
  const direct = normalizeFinishReason(event.finishReason);
  if (direct) return direct;
  return normalizeFinishReason(
    typeof event.metadata?.finishReason === 'string' ? event.metadata.finishReason : undefined,
  );
}

function legacyEventReasoningTokens(event: IAgentTracingEvent): number | undefined {
  if (typeof event.reasoningTokens === 'number') return event.reasoningTokens;
  return typeof event.metadata?.reasoningTokens === 'number'
    ? event.metadata.reasoningTokens
    : undefined;
}

function mapTracingEventSummary(event: IAgentTracingEvent) {
  const toolMenu = getToolDefinitionNames(event);
  return {
    id: event.id || event._id,
    sequence: event.sequence,
    type: event.type,
    label: event.label,
    timestamp: event.timestamp,
    status: event.status,
    durationMs: event.durationMs,
    toolName: event.toolName,
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    cachedInputTokens: event.cachedInputTokens,
    reasoningTokens: legacyEventReasoningTokens(event),
    finishReason: legacyEventFinishReason(event),
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    ...(toolMenu
      ? { toolDefinitionNames: toolMenu.names, toolDefinitionCount: toolMenu.count }
      : {}),
  };
}

function mapTracingEventDetail(event: IAgentTracingEvent) {
  return {
    id: event.id || event._id,
    sequence: event.sequence,
    type: event.type,
    label: event.label,
    timestamp: event.timestamp,
    status: event.status,
    actor: event.actor,
    metadata: stripSpreadStringValues(event.metadata),
    sections: event.sections,
    model: event.model,
    error: event.error,
    durationMs: event.durationMs,
    toolName: event.toolName,
    toolDetails: getStoredToolDetails(event),
    toolExecutionId: event.toolExecutionId,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    cachedInputTokens: event.cachedInputTokens,
    reasoningTokens: legacyEventReasoningTokens(event),
    finishReason: legacyEventFinishReason(event),
    requestBytes: event.requestBytes,
    responseBytes: event.responseBytes,
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    actorName: event.actorName,
    actorRole: event.actorRole,
  };
}

export interface AgentTracingSessionSummary {
  sessionId: string;
  agentName?: string;
  status?: string;
  startedAt?: Date;
  durationMs?: number;
  totalEvents?: number;
  totalTokens: number;
}

export interface AgentTracingTokenSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  averageInputTokensPerSession: number;
  averageOutputTokensPerSession: number;
  averageCachedInputTokensPerSession: number;
  averageTokensPerSession: number;
}

export interface AgentTracingAggregateTotals extends AgentTracingTokenSummary {
  sessionsCount: number;
  totalEvents: number;
  totalDurationMs: number;
  averageDurationMs: number;
}

export interface AgentTracingAgentSummary extends AgentTracingTokenSummary {
  name: string;
  label: string;
  latestSessionAt?: Date;
  latestStatus?: string;
  sessionsCount: number;
  totalEvents: number;
  averageDurationMs: number;
}

export interface DashboardOverview {
  recentSessions: AgentTracingSessionSummary[];
  recentAgents: AgentTracingAgentSummary[];
  recentAgentsTotal: number;
  analytics: {
    totals: AgentTracingAggregateTotals;
    tools: {
      totals: {
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{
      status: string;
      count: number;
    }>;
    models: Array<{
      model: string;
      sessionsCount: number;
    }>;
    agents: AgentTracingAgentSummary[];
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      averageDurationMs: number;
    }>;
  };
}

type SessionMetricsSource = {
  totalEvents?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedInputTokens?: number;
  durationMs?: number;
};

type AggregateTotalsAccumulator = {
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
};

function getSessionTokenSummary(session: SessionMetricsSource) {
  const totalInputTokens = session.totalInputTokens || 0;
  const totalOutputTokens = session.totalOutputTokens || 0;
  const totalCachedInputTokens = session.totalCachedInputTokens || 0;

  return {
    totalEvents: session.totalEvents || 0,
    totalInputTokens,
    totalOutputTokens,
    totalCachedInputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalDurationMs: session.durationMs || 0,
  };
}

function buildAggregateTotals(sessions: SessionMetricsSource[]): AgentTracingAggregateTotals {
  const totals = sessions.reduce<AggregateTotalsAccumulator>(
    (aggregate, session) => {
      const sessionSummary = getSessionTokenSummary(session);

      aggregate.totalEvents += sessionSummary.totalEvents;
      aggregate.totalInputTokens += sessionSummary.totalInputTokens;
      aggregate.totalOutputTokens += sessionSummary.totalOutputTokens;
      aggregate.totalCachedInputTokens += sessionSummary.totalCachedInputTokens;
      aggregate.totalTokens += sessionSummary.totalTokens;
      aggregate.totalDurationMs += sessionSummary.totalDurationMs;

      return aggregate;
    },
    {
      totalEvents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      totalTokens: 0,
      totalDurationMs: 0,
    },
  );

  const sessionsCount = sessions.length;

  return {
    sessionsCount,
    totalEvents: totals.totalEvents,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCachedInputTokens: totals.totalCachedInputTokens,
    totalTokens: totals.totalTokens,
    totalDurationMs: totals.totalDurationMs,
    averageInputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalInputTokens / sessionsCount) : 0,
    averageOutputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalOutputTokens / sessionsCount) : 0,
    averageCachedInputTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalCachedInputTokens / sessionsCount) : 0,
    averageTokensPerSession:
      sessionsCount > 0 ? Math.round(totals.totalTokens / sessionsCount) : 0,
    averageDurationMs:
      sessionsCount > 0 ? Math.round(totals.totalDurationMs / sessionsCount) : 0,
  };
}

const SESSION_ANALYTICS_BATCH_SIZE = 1000;
const SESSION_ANALYTICS_HARD_CAP = 100_000;

async function fetchAllSessionsBatched(
  db: Awaited<ReturnType<typeof getDatabase>>,
  projectId: string,
  baseQuery: SessionListQuery,
  projection: Record<string, 0 | 1>,
): Promise<IAgentTracingSession[]> {
  const all: IAgentTracingSession[] = [];
  let skip = 0;
  // Loop in batches until we drain the result set or hit the safety cap.
  while (skip < SESSION_ANALYTICS_HARD_CAP) {
    const { sessions } = await db.listAgentTracingSessions({
      ...baseQuery,
      includeTotal: false,
      limit: SESSION_ANALYTICS_BATCH_SIZE,
      skip,
      projection,
    }, projectId);

    if (!sessions || sessions.length === 0) {
      break;
    }

    all.push(...(sessions as IAgentTracingSession[]));

    if (sessions.length < SESSION_ANALYTICS_BATCH_SIZE) {
      break;
    }

    skip += sessions.length;
  }

  if (skip >= SESSION_ANALYTICS_HARD_CAP) {
    logger.warn('Session analytics hit session hard cap', {
      projectId,
      cap: SESSION_ANALYTICS_HARD_CAP,
    });
  }

  return all;
}

export class AgentTracingService {
  /**
   * List threads (grouped sessions by threadId)
   */
  static async listThreads(
    tenantDbName: string,
    projectId: string,
    filters?: {
      threadId?: string;
      agent?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: string;
      skip?: string;
      metadataKey?: string;
      metadataValue?: string;
    },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const result = await db.listAgentTracingThreads({
      threadId: filters?.threadId,
      agentName: filters?.agent,
      status: filters?.status,
      from: filters?.from,
      to: filters?.to,
      limit: filters?.limit || '50',
      skip: filters?.skip || '0',
      metadataKey: filters?.metadataKey,
      metadataValue: filters?.metadataValue,
    }, projectId);

    return result;
  }

  /**
   * Get thread detail - all sessions belonging to a threadId, with aggregated stats
   */
  static async getThreadDetail(
    tenantDbName: string,
    projectId: string,
    threadId: string,
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const { sessions } = await db.listAgentTracingSessions({
      includeTotal: false,
      threadId,
      limit: 1000,
      projection: THREAD_SESSION_PROJECTION,
    }, projectId);

    if (sessions.length === 0) {
      return null;
    }

    const sorted = sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(a.startedAt || 0).getTime() -
          new Date(b.startedAt || 0).getTime(),
      );

    const agents = [...new Set(sorted.map((s) => s.agentName).filter(Boolean))] as string[];
    const statuses = sorted.map((s) => s.status || 'unknown');
    const hasError = statuses.includes('error');
    const allDone = statuses.every((s) => s === 'success' || s === 'error' || s === 'completed');
    const overallStatus = hasError ? 'error' : allDone ? 'success' : 'in_progress';

    const totalInputTokens = sorted.reduce((sum, s) => sum + (s.totalInputTokens || 0), 0);
    const totalOutputTokens = sorted.reduce((sum, s) => sum + (s.totalOutputTokens || 0), 0);
    const totalCachedInputTokens = sorted.reduce((sum, s) => sum + (s.totalCachedInputTokens || 0), 0);
    const totalEvents = sorted.reduce((sum, s) => sum + (s.totalEvents || 0), 0);
    const totalDurationMs = sorted.reduce((sum, s) => sum + (s.durationMs || 0), 0);
    const modelsUsed = [...new Set(sorted.flatMap((s) => s.modelsUsed || []))];
    const toolsUsed = [...new Set(sorted.flatMap((s) => s.toolsUsed || []))];

    return {
      threadId,
      status: overallStatus,
      agents,
      sessionsCount: sorted.length,
      startedAt: sorted[0]?.startedAt,
      endedAt: sorted[sorted.length - 1]?.endedAt,
      totalDurationMs,
      totalEvents,
      totalInputTokens,
      totalOutputTokens,
      totalCachedInputTokens,
      modelsUsed,
      toolsUsed,
      sessions: sorted.map((s) => ({
        sessionId: s.sessionId,
        agentName: s.agentName,
        agentVersion: s.agentVersion,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        totalEvents: s.totalEvents,
        totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        modelsUsed: s.modelsUsed,
        toolsUsed: s.toolsUsed,
      })),
    };
  }

  /**
   * Get dashboard overview with analytics
   */
  static async getDashboardOverview(
    tenantDbName: string,
    projectId: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ): Promise<DashboardOverview> {
    try {
      logger.debug('Getting dashboard overview', { tenantDbName, filters });

      const db = await getDatabase();
      await db.switchToTenant(tenantDbName);

      return await db.aggregateAgentTracingDashboard(filters, projectId);
    } catch (error) {
      logger.error('Error in getDashboardOverview', { error });
      throw error;
    }
  }

  /**
   * List sessions with filters
   */
  static async listSessions(
    tenantDbName: string,
    projectId: string,
    filters?: {
      query?: string;
      agent?: string;
      status?: string;
      from?: string;
      to?: string;
      limit?: string;
      skip?: string;
      metadataKey?: string;
      metadataValue?: string;
      /** Only sessions with `truncatedEvents > 0`. */
      truncated?: boolean;
    },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const result = await db.listAgentTracingSessions({
      agentName: filters?.agent,
      query: filters?.query,
      projection: SESSION_LIST_PROJECTION,
      status: filters?.status,
      from: filters?.from,
      to: filters?.to,
      limit: filters?.limit || '50',
      skip: filters?.skip || '0',
      metadataKey: filters?.metadataKey,
      metadataValue: filters?.metadataValue,
      truncated: filters?.truncated,
    }, projectId);

    return {
      sessions: result.sessions.map((s) => ({
        sessionId: s.sessionId,
        threadId: s.threadId,
        agentName: s.agentName,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        totalEvents: s.totalEvents,
        totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
        totalInputTokens: s.totalInputTokens,
        totalOutputTokens: s.totalOutputTokens,
        totalCachedInputTokens: s.totalCachedInputTokens,
        totalReasoningTokens: s.totalReasoningTokens,
        truncatedEvents: s.truncatedEvents,
        metadata: s.metadata,
      })),
      total: result.total,
    };
  }

  /**
   * Get session detail with events
   */
  static async getSessionDetail(
    tenantDbName: string,
    projectId: string,
    sessionId: string,
    options?: { includeEventContent?: boolean },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const session = await db.findAgentTracingSessionById(sessionId, projectId);
    if (!session) {
      return null;
    }

    const events = await db.listAgentTracingEvents(
      sessionId,
      projectId,
      options?.includeEventContent === false
        ? { projection: SESSION_EVENT_SUMMARY_PROJECTION }
        : undefined,
    );

    return {
      session: {
        sessionId: session.sessionId,
        threadId: session.threadId,
        traceId: session.traceId,
        rootSpanId: session.rootSpanId,
        source: session.source,
        agentName: session.agentName,
        agentVersion: session.agentVersion,
        agentModel: session.agentModel,
        metadata: session.metadata,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        totalEvents: session.totalEvents,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        totalCachedInputTokens: session.totalCachedInputTokens,
        totalReasoningTokens: session.totalReasoningTokens,
        truncatedEvents: session.truncatedEvents,
        totalBytesIn: session.totalBytesIn,
        totalBytesOut: session.totalBytesOut,
        summary: session.summary,
        modelsUsed: session.modelsUsed,
        toolsUsed: session.toolsUsed,
        eventCounts: session.eventCounts,
        errors: session.errors,
      },
      events: events.map((e) => (
        options?.includeEventContent === false
          ? mapTracingEventSummary(e)
          : mapTracingEventDetail(e)
      )),
    };
  }

  static async getSessionEventDetail(
    tenantDbName: string,
    projectId: string,
    sessionId: string,
    eventId: string,
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const event = await db.findAgentTracingEventById(sessionId, eventId, projectId);
    if (!event) {
      return null;
    }

    return {
      event: mapTracingEventDetail(event),
    };
  }

  /**
   * Get agent overview with analytics
   */
  static async getAgentOverview(
    tenantDbName: string,
    projectId: string,
    agentName: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const query: SessionListQuery = {
      agentNameExact: agentName,
    };
    if (filters?.from || filters?.to) {
      query.from = filters.from;
      query.to = filters.to;
    }

    const sessions = await fetchAllSessionsBatched(
      db,
      projectId,
      query,
      AGENT_OVERVIEW_SESSION_PROJECTION,
    );

    if (sessions.length === 0) {
      return {
        agent: {
          name: agentName,
          label: agentName,
          latestStatus: null,
          latestVersion: null,
          latestSessionAt: null,
          versions: [],
          sessionsCount: 0,
        },
        recentSessions: [],
        analytics: {
          totals: {
            sessionsCount: 0,
            totalEvents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedInputTokens: 0,
            totalTokens: 0,
            totalDurationMs: 0,
            averageInputTokensPerSession: 0,
            averageOutputTokensPerSession: 0,
            averageCachedInputTokensPerSession: 0,
            averageTokensPerSession: 0,
            averageDurationMs: 0,
          },
          tools: {
            totals: {
              totalCalls: 0,
              errorCalls: 0,
              successCalls: 0,
              errorRate: 0,
            },
            items: [],
          },
          statuses: [],
          models: [],
          versions: [],
          daily: [],
          insights: null,
        },
      };
    }

    const sortedSessions = sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(b.startedAt || 0).getTime() -
          new Date(a.startedAt || 0).getTime(),
      );

    const insights = await deriveEnterpriseAgentInsights(
      db,
      projectId,
      sortedSessions as unknown as Array<Record<string, unknown>>,
    );

    const totals = buildAggregateTotals(sessions);

    const recentSessions = sortedSessions.slice(0, 10).map((s) => ({
      sessionId: s.sessionId,
      threadId: s.threadId,
      status: s.status,
      startedAt: s.startedAt,
      durationMs: s.durationMs,
      totalEvents: s.totalEvents,
      totalTokens: (s.totalInputTokens || 0) + (s.totalOutputTokens || 0),
    }));

    // Agent info
    const latestSession = sortedSessions[0];
    const agent = {
      name: agentName,
      label: agentName,
      latestStatus: latestSession?.status || null,
      latestVersion: latestSession?.agentVersion || null,
      latestSessionAt: latestSession?.startedAt || null,
      versions: Array.from(
        new Set(sortedSessions.map((s) => s.agentVersion).filter(Boolean)),
      ),
      sessionsCount: sessions.length,
    };

    // Status breakdown
    const statusMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const status = session.status || 'unknown';
      statusMap.set(status, (statusMap.get(status) || 0) + 1);
    });
    const statuses = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    // Versions breakdown
    const versionMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const version = session.agentVersion || 'unknown';
      versionMap.set(version, (versionMap.get(version) || 0) + 1);
    });
    const versions = Array.from(versionMap.entries())
      .map(([version, sessionsCount]) => ({
        version: version === 'unknown' ? null : version,
        sessionsCount,
      }))
      .sort((a, b) => b.sessionsCount - a.sessionsCount);

    // Model usage
    const modelMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      (session.modelsUsed || []).forEach((model) => {
        modelMap.set(model, (modelMap.get(model) || 0) + 1);
      });
    });
    const models = Array.from(modelMap.entries())
      .map(([model, sessionsCount]) => ({ model, sessionsCount }))
      .sort((a, b) => b.sessionsCount - a.sessionsCount);

    // Tool analytics
    const toolMap = new Map<
      string,
      { totalCalls: number; errorCalls: number; successCalls: number }
    >();
    sortedSessions.forEach((session) => {
      (session.toolsUsed || []).forEach((tool) => {
        if (!toolMap.has(tool)) {
          toolMap.set(tool, { totalCalls: 0, errorCalls: 0, successCalls: 0 });
        }
        const toolStats = toolMap.get(tool)!;
        toolStats.totalCalls++;
        if (session.status === 'error') {
          toolStats.errorCalls++;
        } else {
          toolStats.successCalls++;
        }
      });
    });

    const toolItems = Array.from(toolMap.entries())
      .map(([toolName, stats]) => ({
        toolName,
        ...stats,
        errorRate:
          stats.totalCalls > 0 ? stats.errorCalls / stats.totalCalls : 0,
      }))
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const toolTotals = {
      totalCalls: toolItems.reduce((sum, t) => sum + t.totalCalls, 0),
      errorCalls: toolItems.reduce((sum, t) => sum + t.errorCalls, 0),
      successCalls: toolItems.reduce((sum, t) => sum + t.successCalls, 0),
      errorRate: 0,
    };
    if (toolTotals.totalCalls > 0) {
      toolTotals.errorRate = toolTotals.errorCalls / toolTotals.totalCalls;
    }

    // Daily trend
    const dailyMap = new Map<
      string,
      {
        sessionsCount: number;
        totalEvents: number;
        totalTokens: number;
        totalDurationMs: number;
      }
    >();
    sortedSessions.forEach((session) => {
      if (!session.startedAt) {
        return;
      }
      const dateKey = dayjs(session.startedAt).format('YYYY-MM-DD');
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          sessionsCount: 0,
          totalEvents: 0,
          totalTokens: 0,
          totalDurationMs: 0,
        });
      }
      const entry = dailyMap.get(dateKey)!;
      entry.sessionsCount += 1;
      entry.totalEvents += session.totalEvents || 0;
      entry.totalTokens +=
        (session.totalInputTokens || 0) + (session.totalOutputTokens || 0);
      entry.totalDurationMs += session.durationMs || 0;
    });

    const daily = Array.from(dailyMap.entries())
      .sort((a, b) => dayjs(a[0]).valueOf() - dayjs(b[0]).valueOf())
      .map(([date, stats]) => ({
        date,
        sessionsCount: stats.sessionsCount,
        totalEvents: stats.totalEvents,
        totalTokens: stats.totalTokens,
        averageDurationMs:
          stats.sessionsCount > 0
            ? Math.round(stats.totalDurationMs / stats.sessionsCount)
            : 0,
      }))
      .slice(-30);

    // ── Deterministic insights (bounded event sample of recent sessions) ──

    return {
      agent,
      recentSessions,
      analytics: {
        totals,
        tools: {
          totals: toolTotals,
          items: toolItems,
        },
        statuses,
        models,
        versions,
        daily,
        insights,
      },
    };
  }

  /**
   * Lightweight agent directory for navigation: distinct agent names in the
   * window with session count, latest activity, and latest status — no
   * event reads, minimal projection.
   */
  static async listRecentAgents(
    tenantDbName: string,
    projectId: string,
    filters?: { from?: string; to?: string; limit?: number },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const query: SessionListQuery = {};
    if (filters?.from) query.from = filters.from;
    if (filters?.to) query.to = filters.to;

    const sessions = await fetchAllSessionsBatched(
      db,
      projectId,
      query,
      AGENT_DIRECTORY_SESSION_PROJECTION,
    );

    const byAgent = new Map<
      string,
      { name: string; sessionsCount: number; latestSessionAt: string | null; latestStatus: string | null }
    >();
    for (const session of sessions) {
      const name = session.agentName;
      if (!name) continue;
      const entry = byAgent.get(name) ?? {
        name,
        sessionsCount: 0,
        latestSessionAt: null,
        latestStatus: null,
      };
      entry.sessionsCount += 1;
      const at = session.startedAt ? new Date(session.startedAt).toISOString() : null;
      if (at && (!entry.latestSessionAt || at > entry.latestSessionAt)) {
        entry.latestSessionAt = at;
        entry.latestStatus = session.status ?? null;
      }
      byAgent.set(name, entry);
    }

    const agents = [...byAgent.values()].sort((a, b) =>
      (b.latestSessionAt ?? '').localeCompare(a.latestSessionAt ?? ''),
    );
    const limit = filters?.limit && filters.limit > 0 ? filters.limit : 50;
    return { agents: agents.slice(0, limit), total: agents.length };
  }

  /**
   * Model overview — the model-dimension twin of `getAgentOverview`. Window
   * totals cover sessions that USED the model (session token totals include
   * every model in the session — labeled as such in the UI); the insight
   * sample narrows ai_call metrics to this model's events exactly.
   */
  static async getModelOverview(
    tenantDbName: string,
    projectId: string,
    modelName: string,
    filters?: { from?: string; to?: string; timezone?: string },
  ) {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const query: SessionListQuery = {};
    if (filters?.from || filters?.to) {
      query.from = filters.from;
      query.to = filters.to;
    }

    const allSessions = await fetchAllSessionsBatched(
      db,
      projectId,
      query,
      MODEL_OVERVIEW_SESSION_PROJECTION,
    );
    const sessions = allSessions.filter((s) => (s.modelsUsed || []).includes(modelName));

    if (sessions.length === 0) {
      return {
        model: {
          name: modelName,
          sessionsCount: 0,
          agentsCount: 0,
          latestSessionAt: null,
          latestStatus: null,
        },
        analytics: {
          totals: buildAggregateTotals([]),
          statuses: [],
          agents: [],
          insights: null,
        },
      };
    }

    const sortedSessions = sessions
      .slice()
      .sort(
        (a, b) =>
          new Date(b.startedAt || 0).getTime() -
          new Date(a.startedAt || 0).getTime(),
      );

    const totals = buildAggregateTotals(sessions);

    const statusMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const status = session.status || 'unknown';
      statusMap.set(status, (statusMap.get(status) || 0) + 1);
    });
    const statuses = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);

    const agentMap = new Map<string, number>();
    sortedSessions.forEach((session) => {
      const name = session.agentName || 'unknown';
      agentMap.set(name, (agentMap.get(name) || 0) + 1);
    });
    const agents = Array.from(agentMap.entries())
      .map(([name, sessionsCount]) => ({ name, sessionsCount }))
      .sort((a, b) => b.sessionsCount - a.sessionsCount);

    const latestSession = sortedSessions[0];

    const insights = await deriveEnterpriseAgentInsights(
      db,
      projectId,
      sortedSessions as unknown as Array<Record<string, unknown>>,
      { modelName },
    );

    return {
      model: {
        name: modelName,
        sessionsCount: sessions.length,
        agentsCount: agents.length,
        latestSessionAt: latestSession?.startedAt || null,
        latestStatus: latestSession?.status || null,
      },
      analytics: {
        totals,
        statuses,
        agents,
        insights,
      },
    };
  }
}
