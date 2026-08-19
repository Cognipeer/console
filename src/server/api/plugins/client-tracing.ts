import type { FastifyPluginAsync } from 'fastify';
import type {
  IAgentTracingEvent,
  IAgentTracingSession,
} from '@/lib/database/provider/types.base';
import { fireAndForget } from '@/lib/core/asyncTask';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import { AgentTracingService, recordTracingSessionCreated, recordTraceModelUsage } from '@/lib/services/agentTracing';
import { mapOtlpToInternalModels, type OtlpExportTraceServiceRequest } from '@/lib/services/otlpMapper';
import {
  buildResponseFormatSection,
  normalizeSectionListResponseFormat,
  RESPONSE_FORMAT_SECTION_KIND,
} from '@/lib/services/tracingResponseFormat';
import {
  buildToolDefinitionsSection,
  normalizeSectionListToolDefinitions,
  TOOL_DEFINITIONS_SECTION_KIND,
} from '@/lib/services/tracingToolDefinitions';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:client-tracing');

const getMaxBodySizeBytes = () => getConfig().limits.tracingMaxBodySizeMb * 1024 * 1024;

type TracingUsage = {
  cacheReadInputTokens?: number | null;
  cache_read_input_tokens?: number | null;
  cachedInputTokens?: number | null;
  cached_input_tokens?: number | null;
  inputTokens?: number | null;
  input_tokens?: number | null;
  outputTokens?: number | null;
  output_tokens?: number | null;
  /** Subset of the output count — recorded, never re-billed. */
  reasoningTokens?: number | null;
  reasoning_tokens?: number | null;
  /** OpenAI/Azure raw usage shape: reasoning tokens nested under a details bag. */
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  /** OTel GenAI convention's mirror of the same nested shape. */
  output_tokens_details?: { reasoning_tokens?: number | null } | null;
};

type TracingActorPayload = Record<string, unknown> & {
  name?: string | null;
  role?: string | null;
  scope?: string | null;
};

type TracingSummaryPayload = Record<string, unknown> & {
  eventCounts?: Record<string, number>;
  totalBytesIn?: number | null;
  totalBytesOut?: number | null;
  totalCachedInputTokens?: number | null;
  totalDurationMs?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
};

type TracingEventPayload = {
  actor?: TracingActorPayload;
  bytesIn?: number | null;
  bytesOut?: number | null;
  cachedInputTokens?: number | null;
  data?: Record<string, unknown> & {
    sections?: unknown[];
    toolDetails?: Record<string, unknown>;
  };
  durationMs?: number | null;
  error?: string | null;
  id?: string | null;
  inputTokens?: number | null;
  label?: string | null;
  metadata?: Record<string, unknown> & {
    finishReason?: string | null;
    /** Python-style SDKs that only wrote the snake_case field. */
    finish_reason?: string | null;
    /** Claude Agent SDK integration writes Anthropic's own vocabulary here. */
    stop_reason?: string | null;
    /** OTel exporter's plural form — a JSON array or comma-joined string. */
    finishReasons?: string[] | string | null;
    reasoningTokens?: number | null;
    modelName?: string | null;
    usage?: TracingUsage;
  };
  /** Why the model stopped: stop | tool_calls | length | content_filter | error. */
  finishReason?: string | null;
  /** Reasoning tokens billed inside `outputTokens` (a subset of it). */
  reasoningTokens?: number | null;
  model?: string | null;
  modelName?: string | null;
  modelNames?: string[];
  outputTokens?: number | null;
  parentSpanId?: string;
  requestBytes?: number | null;
  responseBytes?: number | null;
  sections?: unknown[];
  sequence?: number | null;
  spanId?: string;
  status?: string | null;
  timestamp?: string | Date;
  /** Structured-output contract sent with THIS call (OpenAI `response_format`
   *  shape, or the SDK's `{ response_format: … }` envelope) — normalized into a
   *  `response_format` section. Ignored silently when malformed. */
  responseFormat?: unknown;
  /** Tool menu offered to the model on THIS call — normalized into a
   *  `tool_definitions` section so SDK senders don't need to know the
   *  section encoding. Ignored silently when malformed. */
  toolDefinitions?: unknown;
  toolDetails?: Record<string, unknown>;
  toolExecutionId?: string | null;
  toolName?: string | null;
  totalTokens?: number | null;
  traceId?: string;
  type?: string | null;
  usage?: TracingUsage;
};

type TracingAgentPayload = Record<string, unknown> & {
  model?: string | null;
  name?: string | null;
  version?: string | null;
};

type TracingSessionPayload = {
  agent?: TracingAgentPayload;
  config?: Record<string, unknown>;
  durationMs?: number;
  endedAt?: string | Date;
  errors?: unknown[];
  events?: TracingEventPayload[];
  /** Free-form caller-supplied attribution tags (e.g. `{ complexity: 'complex' }`),
   *  sibling of `agent` — sanitized by `sanitizeTracingMetadata` before storage. */
  metadata?: Record<string, unknown>;
  rootSpanId?: string;
  sessionId?: string;
  startedAt?: string | Date;
  status?: string;
  summary?: TracingSummaryPayload;
  threadId?: string;
  traceId?: string;
};

type TracingStreamEventPayload = {
  event?: TracingEventPayload;
};

type TracingStreamEndPayload = {
  durationMs?: number;
  endedAt?: string | Date;
  errors?: unknown[];
  status?: string;
  summary?: TracingSummaryPayload;
};

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function buildEventFingerprint(event: {
  id?: string;
  label?: string;
  sequence?: number;
  spanId?: string;
  timestamp?: unknown;
  traceId?: string;
  type?: string;
}) {
  if (event.spanId) {
    return `span:${event.spanId}`;
  }
  if (event.id) {
    return `id:${event.id}`;
  }

  return [
    event.traceId || 'no-trace',
    event.type || 'no-type',
    event.label || 'no-label',
    String(event.sequence ?? -1),
    toIso(event.timestamp) || 'no-ts',
  ].join('|');
}

function aggregateEvents(events: IAgentTracingEvent[]) {
  const eventCounts: Record<string, number> = {};
  const modelsUsed = new Set<string>();
  const toolsUsed = new Set<string>();
  const errors: Array<Record<string, unknown>> = [];

  let totalBytesIn = 0;
  let totalBytesOut = 0;
  let totalCachedInputTokens = 0;
  let totalDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let truncatedEvents = 0;

  for (const event of events) {
    if (typeof event.type === 'string') {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
    }

    if (typeof event.model === 'string') {
      modelsUsed.add(event.model);
    }

    if (typeof event.toolName === 'string') {
      toolsUsed.add(event.toolName);
    }

    totalInputTokens += typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    totalOutputTokens += typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    totalCachedInputTokens += typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : 0;
    totalBytesIn += typeof event.requestBytes === 'number' ? event.requestBytes : 0;
    totalBytesOut += typeof event.responseBytes === 'number' ? event.responseBytes : 0;
    totalDurationMs += typeof event.durationMs === 'number' ? event.durationMs : 0;
    totalReasoningTokens += typeof event.reasoningTokens === 'number' ? event.reasoningTokens : 0;
    if (isTruncatedFinishReason(event.finishReason)) truncatedEvents += 1;

    if (event.status === 'error') {
      errors.push({
        eventId: typeof event.id === 'string' ? event.id : undefined,
        message: typeof event.error === 'string'
          ? event.error
          : (typeof event.label === 'string' ? event.label : 'Event error'),
        timestamp: toIso(event.timestamp),
        type: typeof event.type === 'string' ? event.type : undefined,
      });
    }
  }

  return {
    errors,
    eventCounts,
    modelsUsed: [...modelsUsed],
    toolsUsed: [...toolsUsed],
    totalBytesIn,
    totalBytesOut,
    totalCachedInputTokens,
    totalDurationMs,
    totalEvents: events.length,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    truncatedEvents,
  };
}

function getTracingQuotaContext(
  ctx: Awaited<ReturnType<typeof getApiTokenContextForRequest>>,
  resourceKey: string,
) {
  return {
    domain: 'tracing' as const,
    licenseType: ctx.tenant.licenseType as LicenseType,
    projectId: ctx.projectId,
    resourceKey,
    tenantDbName: ctx.tenantDbName,
    tenantId: ctx.tenantId,
    tokenId: ctx.tokenRecord._id?.toString() ?? ctx.token,
    userId: ctx.tokenRecord.userId,
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}

function toErrorRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return { message: value };
  }

  return toRecord(value);
}

function toErrorList(values: unknown[] | undefined): Array<Record<string, unknown>> {
  return (values || []).flatMap((value) => {
    const normalized = toErrorRecord(value);
    return normalized ? [normalized] : [];
  });
}

function getSummaryRecord(summary: unknown): Record<string, unknown> {
  return toRecord(summary) ?? {};
}

function getSummaryEventCounts(summary: unknown): Record<string, number> {
  const record = toRecord(getSummaryRecord(summary).eventCounts);
  if (!record) {
    return {};
  }

  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    const count = toNumber(value);
    if (count !== undefined) {
      counts[key] = count;
    }
  }

  return counts;
}

function getSummaryNumber(
  summary: unknown,
  key: keyof TracingSummaryPayload,
): number | undefined {
  return toNumber(getSummaryRecord(summary)[key]);
}

/**
 * Largest value a running total has reached, across the incoming payload, the
 * session's own summary and its denormalized column. Session totals accumulate
 * over the life of a sessionId, so a later write must never shrink them.
 */
function maxTotal(
  payloadSummary: unknown,
  sessionSummary: unknown,
  denormalized: number | undefined,
  key: keyof TracingSummaryPayload,
): number {
  const candidates = [
    getSummaryNumber(payloadSummary, key),
    getSummaryNumber(sessionSummary, key),
    toNumber(denormalized),
  ].filter((value): value is number => typeof value === 'number');

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function mergeUnique(...lists: Array<string[] | undefined>): string[] {
  return Array.from(new Set(lists.flatMap((list) => list ?? [])));
}

/** Drops repeats so a retried `end` cannot grow the session's error list. */
function dedupeErrors(errors: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();

  return errors.filter((error) => {
    const key = JSON.stringify(error);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getEventSections(event: TracingEventPayload): Array<Record<string, unknown>> {
  const rawSections = Array.isArray(event.sections)
    ? event.sections
    : (Array.isArray(event.data?.sections) ? event.data.sections : []);

  // tool_definitions and response_format sections get the shared cap/shape
  // treatment whether the sender encoded the section itself or used the
  // first-class `toolDefinitions` / `responseFormat` event field (the fields
  // are normalized into sections so SDK senders don't need to know the
  // encoding). Malformed input is ignored silently.
  let sections = normalizeSectionListResponseFormat(
    normalizeSectionListToolDefinitions(rawSections.flatMap((section) => {
      const normalized = toRecord(section);
      return normalized ? [normalized] : [];
    })),
  );

  const menuFromField = buildToolDefinitionsSection(event.toolDefinitions);
  if (menuFromField && !sections.some((section) => section.kind === TOOL_DEFINITIONS_SECTION_KIND)) {
    sections = [...sections, menuFromField];
  }

  const formatFromField = buildResponseFormatSection(event.responseFormat);
  if (formatFromField && !sections.some((section) => section.kind === RESPONSE_FORMAT_SECTION_KIND)) {
    sections = [...sections, formatFromField];
  }

  return sections;
}

function normalizeToolName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function getSectionToolName(section: Record<string, unknown>): string | undefined {
  return normalizeToolName(section.tool)
    || normalizeToolName(section.toolName)
    || normalizeToolName(section.name);
}

function getEventToolDetails(
  event: TracingEventPayload,
  sections: Array<Record<string, unknown>> = getEventSections(event),
): Record<string, unknown> | undefined {
  const candidates = [
    // Network payloads aren't trustworthy just because the TS type says
    // `toolDetails?: Record<string, unknown>` — a bad upstream serializer can
    // hand this the literal string "undefined" (see agent-sdk's
    // sanitizeTracePayload), and Boolean("undefined") is true, so an
    // unguarded string here survives `.find(Boolean)` and then gets
    // spread into single-character indexed keys below.
    toRecord(event.toolDetails),
    toRecord(event.metadata?.toolDetails),
    toRecord(event.data?.toolDetails),
    ...sections.map((section) => toRecord(section.toolDetails) || toRecord(section.details)),
  ];

  const details = candidates.find((candidate): candidate is Record<string, unknown> => Boolean(candidate));
  const name = normalizeToolName(details?.name)
    || normalizeToolName(event.toolName)
    || (event.actor?.scope === 'tool' ? normalizeToolName(event.actor?.name) : undefined)
    || sections.map(getSectionToolName).find(Boolean);

  if (!details && !name) {
    return undefined;
  }

  return {
    ...(details || {}),
    ...(name && !normalizeToolName(details?.name) ? { name } : {}),
  };
}

function collectEventToolNames(event: TracingEventPayload): string[] {
  const names = new Set<string>();
  const sections = getEventSections(event);
  const toolDetails = getEventToolDetails(event, sections);
  const directNames = [
    normalizeToolName(event.toolName),
    event.actor?.scope === 'tool' ? normalizeToolName(event.actor.name) : undefined,
    normalizeToolName(toolDetails?.name),
    ...sections.map(getSectionToolName),
  ];

  for (const name of directNames) {
    if (name) names.add(name);
  }

  return Array.from(names);
}

/**
 * Pull `finishReason` / `reasoningTokens` off a raw ingest event — they are
 * now first-class columns on `IAgentTracingEvent`, not metadata. Tolerant of
 * every shape a real producer SDK sends, because the fallbacks below each
 * correspond to one upstream integration that never populated the top-level
 * field:
 *   - `event.metadata.finish_reason` — Python-style SDKs that only ever wrote
 *     the snake_case form;
 *   - `event.metadata.stop_reason` — the Claude Agent SDK integration, which
 *     writes Anthropic's own vocabulary rather than normalizing it first;
 *   - `event.metadata.finishReasons` (plural) — the OTel exporter, which
 *     ships a JSON array or comma-joined string because a single export can
 *     bundle multiple choices; the first element wins;
 *   - `event.usage.completion_tokens_details.reasoning_tokens` /
 *     `.output_tokens_details.reasoning_tokens` — raw OpenAI/Azure and OTel
 *     GenAI usage payloads passed through verbatim instead of being
 *     flattened by the sender.
 */
export function extractTraceDiagnostics(event: TracingEventPayload): {
  finishReason?: string;
  reasoningTokens?: number;
} {
  const metadata = event.metadata;
  const usage = event.usage;

  const rawFinishReasons = metadata?.finishReasons;
  const firstOfFinishReasons = Array.isArray(rawFinishReasons)
    ? rawFinishReasons[0]
    : (typeof rawFinishReasons === 'string' ? rawFinishReasons.split(',')[0] : undefined);

  const finishReason = normalizeFinishReason(
    event.finishReason
      ?? metadata?.finishReason
      ?? metadata?.finish_reason
      ?? metadata?.stop_reason
      ?? firstOfFinishReasons,
  );

  const rawReasoningTokens = event.reasoningTokens
    ?? usage?.reasoningTokens
    ?? usage?.reasoning_tokens
    ?? usage?.completion_tokens_details?.reasoning_tokens
    ?? usage?.output_tokens_details?.reasoning_tokens
    ?? metadata?.reasoningTokens;
  const reasoningTokens = Number(rawReasoningTokens);

  return {
    finishReason,
    reasoningTokens: Number.isFinite(reasoningTokens) && reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

function buildEventMetadata(event: TracingEventPayload, sections: Array<Record<string, unknown>>): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...(event.metadata || {}) };
  // finishReason / reasoningTokens are now first-class columns (see
  // extractTraceDiagnostics above) — strip the keys this used to fold them
  // from so the same value never gets persisted twice.
  delete metadata.finishReason;
  delete metadata.finish_reason;
  delete metadata.stop_reason;
  delete metadata.finishReasons;
  delete metadata.reasoningTokens;

  const toolDetails = getEventToolDetails(event, sections);
  if (toolDetails) {
    metadata.toolDetails = toolDetails;
  }
  return metadata;
}

function getEventUsage(event: TracingEventPayload): TracingUsage {
  return event.usage || event.metadata?.usage || {};
}

/** Caller-supplied `metadata` key format — shared with the read-side
 *  `group_by`/`group_by_entity=metadata.<key>` validation (`usageBreakdown.ts`). */
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_]{1,40}$/;
const MAX_METADATA_KEYS = 10;
const MAX_METADATA_VALUE_LENGTH = 200;

/**
 * Sanitize the free-form `metadata` attribution bag callers attach to a
 * tracing session: plain string values only, bounded key count/length, safe
 * key charset (it later becomes a Mongo `metadata.<key>` dot-path / SQLite
 * JSON key in read queries — unsanitized keys would be an injection surface).
 * Drops offending entries rather than rejecting the whole ingest; logs once
 * per call when anything was dropped.
 */
function sanitizeTracingMetadata(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  let droppedCount = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(result).length >= MAX_METADATA_KEYS) {
      droppedCount += 1;
      continue;
    }
    if (
      !METADATA_KEY_PATTERN.test(key)
      || typeof value !== 'string'
      || value.length > MAX_METADATA_VALUE_LENGTH
    ) {
      droppedCount += 1;
      continue;
    }
    result[key] = value;
  }
  if (droppedCount > 0) {
    logger.warn('Tracing metadata: dropped invalid entries', { droppedCount });
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export const clientTracingApiPlugin: FastifyPluginAsync = async (app) => {
  app.post('/client/v1/traces', withClientApiRequestContext(async (request, reply) => {
    try {
      const maxBodySize = getMaxBodySizeBytes();
      const contentLength = Number.parseInt(String(request.headers['content-length'] ?? '0'), 10);
      if (!Number.isNaN(contentLength) && contentLength > maxBodySize) {
        return reply.code(413).send({
          error: `Payload too large. Max allowed: ${maxBodySize} bytes (${Math.round(maxBodySize / 1024 / 1024)}MB).`,
        });
      }

      const ctx = await getApiTokenContextForRequest(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);

      const payload = readJsonBody<OtlpExportTraceServiceRequest>(request);
      if (!payload?.resourceSpans || !Array.isArray(payload.resourceSpans)) {
        return reply.code(400).send({
          error: 'Invalid OTLP payload: resourceSpans array is required',
        });
      }

      let totalSpans = 0;
      for (const resourceSpan of payload.resourceSpans) {
        for (const scopeSpan of resourceSpan.scopeSpans || []) {
          totalSpans += scopeSpan.spans?.length || 0;
        }
      }

      if (totalSpans === 0) {
        return reply.code(400).send({ error: 'No spans found in payload' });
      }

      const mapped = mapOtlpToInternalModels(payload, ctx.tenantId, ctx.projectId);
      if (mapped.sessions.length === 0) {
        return reply.code(400).send({
          error: 'Could not derive any sessions from the OTLP payload',
        });
      }

      const firstSession = mapped.sessions[0];
      const resourceKey = firstSession.agentName || firstSession.sessionId;
      const quotaContext = getTracingQuotaContext(ctx, resourceKey);
      const quotaResult = await checkPerRequestLimits(quotaContext, {
        eventsPerSession: totalSpans,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({ error: quotaResult.reason || 'Quota exceeded' });
      }

      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const maxAgents = quotaResult.effectiveLimits.quotas?.maxAgents;
      for (const session of mapped.sessions) {
        const agentName = session.agentName?.trim();
        if (maxAgents === undefined || maxAgents === -1 || !agentName) {
          continue;
        }

        const alreadyExists = await db.agentTracingAgentExists(agentName, ctx.projectId);
        if (alreadyExists) {
          continue;
        }

        const currentAgents = await db.countAgentTracingDistinctAgents(ctx.projectId);
        if (currentAgents >= maxAgents) {
          return reply.code(429).send({
            error: `agents limit reached (${currentAgents}/${maxAgents})`,
          });
        }
      }

      const { total: existingSessionCount } = await db.listAgentTracingSessions(
        { limit: 0 },
        ctx.projectId,
      );
      const resourceCheck = await checkResourceQuota(
        quotaContext,
        'tracingSessions',
        existingSessionCount,
      );
      if (!resourceCheck.allowed) {
        return reply.code(429).send({
          error: resourceCheck.reason || 'Tracing session quota exceeded',
        });
      }

      fireAndForget('client-otlp-traces-ingest', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);

        const retentionDays = quotaResult.effectiveLimits.quotas?.maxTracingRetentionDays;
        if (retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0) {
          const cutoff = new Date(Date.now() - retentionDays * 86_400 * 1000);
          await backgroundDb.cleanupAgentTracingRetention({
            olderThan: cutoff,
            projectId: ctx.projectId,
          });
        }

        const eventsBySession = new Map<string, typeof mapped.events>();
        for (const event of mapped.events) {
          const current = eventsBySession.get(event.sessionId) || [];
          current.push(event);
          eventsBySession.set(event.sessionId, current);
        }

        for (const session of mapped.sessions) {
          const existing = await backgroundDb.findAgentTracingSessionById(
            session.sessionId,
            ctx.projectId,
          );
          const incomingEvents = eventsBySession.get(session.sessionId) || [];
          const existingEvents = await backgroundDb.listAgentTracingEvents(
            session.sessionId,
            ctx.projectId,
          );
          const seen = new Set(existingEvents.map((event) =>
            buildEventFingerprint({
              id: event.id,
              label: event.label,
              sequence: event.sequence,
              spanId: event.spanId,
              timestamp: event.timestamp,
              traceId: event.traceId,
              type: event.type,
            }),
          ));

          const insertedEvents: typeof incomingEvents = [];
          for (const event of incomingEvents) {
            const fingerprint = buildEventFingerprint({
              id: event.id,
              label: event.label,
              sequence: event.sequence,
              spanId: event.spanId,
              timestamp: event.timestamp,
              traceId: event.traceId,
              type: event.type,
            });
            if (seen.has(fingerprint)) {
              continue;
            }

            seen.add(fingerprint);
            await backgroundDb.createAgentTracingEvent(event);
            insertedEvents.push(event);
          }

          const allEvents = await backgroundDb.listAgentTracingEvents(session.sessionId, ctx.projectId);
          const stats = aggregateEvents(allEvents);
          const nextStartedAt = existing?.startedAt && session.startedAt
            ? new Date(Math.min(existing.startedAt.getTime(), session.startedAt.getTime()))
            : (existing?.startedAt || session.startedAt);
          const nextEndedAt = existing?.endedAt && session.endedAt
            ? new Date(Math.max(existing.endedAt.getTime(), session.endedAt.getTime()))
            : (existing?.endedAt || session.endedAt);
          const durationMs = nextStartedAt && nextEndedAt
            ? Math.max(0, nextEndedAt.getTime() - nextStartedAt.getTime())
            : session.durationMs;
          const summary = {
            eventCounts: stats.eventCounts,
            totalBytesIn: stats.totalBytesIn,
            totalBytesOut: stats.totalBytesOut,
            totalCachedInputTokens: stats.totalCachedInputTokens,
            totalDurationMs: stats.totalDurationMs,
            totalInputTokens: stats.totalInputTokens,
            totalOutputTokens: stats.totalOutputTokens,
            totalReasoningTokens: stats.totalReasoningTokens,
            truncatedEvents: stats.truncatedEvents,
          };
          const mergedSession = {
            ...session,
            durationMs,
            endedAt: nextEndedAt,
            error: undefined,
            errors: stats.errors,
            eventCounts: stats.eventCounts,
            modelsUsed: stats.modelsUsed,
            rootSpanId: existing?.rootSpanId || session.rootSpanId,
            source: existing?.source || session.source || 'otlp',
            startedAt: nextStartedAt,
            status: stats.errors.length > 0
              ? 'error'
              : (existing?.status || session.status || 'success'),
            summary,
            toolsUsed: stats.toolsUsed,
            totalBytesIn: stats.totalBytesIn,
            totalBytesOut: stats.totalBytesOut,
            totalCachedInputTokens: stats.totalCachedInputTokens,
            totalEvents: stats.totalEvents,
            totalInputTokens: stats.totalInputTokens,
            totalOutputTokens: stats.totalOutputTokens,
            totalReasoningTokens: stats.totalReasoningTokens,
            truncatedEvents: stats.truncatedEvents,
            traceId: existing?.traceId || session.traceId,
          };

          if (existing) {
            await backgroundDb.updateAgentTracingSession(
              session.sessionId,
              mergedSession,
              ctx.projectId,
            );
          } else {
            const attribution = recordTracingSessionCreated({
              tenantDbName: ctx.tenantDbName,
              tenantId: ctx.tenantId,
              projectId: ctx.projectId,
              agentName: mergedSession.agentName,
              metadata: mergedSession.metadata,
            });
            await backgroundDb.createAgentTracingSession({
              ...mergedSession,
              userId: attribution.userId,
              apiTokenId: attribution.apiTokenId,
              actorType: attribution.actorType,
            });
          }

          // Fingerprint-deduped, so each event is costed exactly once.
          await recordTraceModelUsage({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            agentName: mergedSession.agentName,
            metadata: mergedSession.metadata,
            events: insertedEvents,
          });
        }
      });

      return reply.code(200).send({
        eventsStored: mapped.events.length,
        sessionsIngested: mapped.sessions.length,
        spansProcessed: totalSpans,
        success: true,
      });
    } catch (error) {
      logger.error('Client OTLP traces ingest error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to ingest OTLP traces',
      });
    }
  }));

  app.post('/client/v1/tracing/sessions', withClientApiRequestContext(async (request, reply) => {
    try {
      const maxBodySize = getMaxBodySizeBytes();
      const contentLength = Number.parseInt(String(request.headers['content-length'] ?? '0'), 10);
      if (!Number.isNaN(contentLength) && contentLength > maxBodySize) {
        return reply.code(413).send({
          error: `Payload too large. Max allowed: ${maxBodySize} bytes (${Math.round(maxBodySize / 1024 / 1024)}MB). Configure via TRACING_MAX_BODY_SIZE_MB env variable.`,
        });
      }

      const ctx = await getApiTokenContextForRequest(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);

      const payload = readJsonBody<TracingSessionPayload>(request);
      if (!payload?.sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }

      const sessionId = payload.sessionId;
      const events = Array.isArray(payload.events) ? payload.events : [];
      const durationMs = typeof payload.durationMs === 'number'
        ? payload.durationMs
        : (payload.startedAt && payload.endedAt
          ? new Date(payload.endedAt).getTime() - new Date(payload.startedAt).getTime()
          : undefined);
      const resourceKey = payload?.agent?.name || sessionId;
      const quotaContext = getTracingQuotaContext(ctx, resourceKey);
      const quotaResult = await checkPerRequestLimits(quotaContext, {
        eventsPerSession: events.length,
        sessionDurationMs: durationMs,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({ error: quotaResult.reason || 'Quota exceeded' });
      }

      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const modelsUsed = new Set<string>();
      const toolsUsed = new Set<string>();
      // Rolled up here rather than read off `payload.summary`: the batch
      // endpoint trusts the sender for the other totals, but no producer SDK
      // reports these two yet, so a summary-only read would leave every
      // batch-ingested session at zero while the per-event columns say
      // otherwise.
      let batchReasoningTokens = 0;
      let batchTruncatedEvents = 0;
      events.forEach((event) => {
        if (event?.model) modelsUsed.add(event.model);
        if (event?.modelName) modelsUsed.add(event.modelName);
        if (event?.metadata?.modelName) modelsUsed.add(event.metadata.modelName);
        for (const toolName of collectEventToolNames(event)) {
          toolsUsed.add(toolName);
        }
        const diagnostics = extractTraceDiagnostics(event);
        batchReasoningTokens += diagnostics.reasoningTokens ?? 0;
        if (isTruncatedFinishReason(diagnostics.finishReason)) batchTruncatedEvents += 1;
      });

      if (payload?.agent?.model) {
        modelsUsed.add(payload.agent.model);
      }

      const sessionSummary = getSummaryRecord(payload.summary);
      const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
        agent: payload.agent || {},
        agentModel: payload.agent?.model ?? undefined,
        agentName: payload.agent?.name ?? undefined,
        agentVersion: payload.agent?.version ?? undefined,
        config: payload.config || {},
        durationMs: payload.durationMs ?? undefined,
        endedAt: payload.endedAt ? new Date(payload.endedAt) : undefined,
        errors: toErrorList(payload.errors),
        eventCounts: getSummaryEventCounts(payload.summary),
        metadata: sanitizeTracingMetadata(payload.metadata),
        modelsUsed: Array.from(modelsUsed),
        projectId: ctx.projectId,
        rootSpanId: typeof payload.rootSpanId === 'string' ? payload.rootSpanId : undefined,
        sessionId,
        source: 'custom' as const,
        startedAt: payload.startedAt ? new Date(payload.startedAt) : new Date(),
        status: payload.status || 'unknown',
        summary: sessionSummary,
        tenantId: ctx.tenantId,
        threadId: typeof payload.threadId === 'string' && payload.threadId.trim()
          ? payload.threadId.trim()
          : undefined,
        toolsUsed: Array.from(toolsUsed),
        totalBytesIn: getSummaryNumber(payload.summary, 'totalBytesIn'),
        totalBytesOut: getSummaryNumber(payload.summary, 'totalBytesOut'),
        totalCachedInputTokens: getSummaryNumber(payload.summary, 'totalCachedInputTokens') ?? 0,
        totalEvents: events.length,
        totalInputTokens: getSummaryNumber(payload.summary, 'totalInputTokens') ?? 0,
        totalOutputTokens: getSummaryNumber(payload.summary, 'totalOutputTokens') ?? 0,
        totalReasoningTokens:
          getSummaryNumber(payload.summary, 'totalReasoningTokens') ?? batchReasoningTokens,
        traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
        truncatedEvents:
          getSummaryNumber(payload.summary, 'truncatedEvents') ?? batchTruncatedEvents,
      };

      const existing = await db.findAgentTracingSessionById(sessionId, ctx.projectId);
      const agentName = typeof payload?.agent?.name === 'string' ? payload.agent.name.trim() : '';
      const maxAgents = quotaResult.effectiveLimits.quotas?.maxAgents;
      if (maxAgents !== undefined && maxAgents !== -1 && agentName) {
        const alreadyExists = await db.agentTracingAgentExists(agentName, ctx.projectId);
        if (!alreadyExists) {
          const currentAgents = await db.countAgentTracingDistinctAgents(ctx.projectId);
          if (currentAgents >= maxAgents) {
            return reply.code(429).send({
              error: `agents limit reached (${currentAgents}/${maxAgents})`,
            });
          }
        }
      }

      if (!existing) {
        const { total } = await db.listAgentTracingSessions(
          { limit: 0 },
          ctx.projectId,
        );
        const resourceCheck = await checkResourceQuota(
          quotaContext,
          'tracingSessions',
          total,
        );
        if (!resourceCheck.allowed) {
          return reply.code(429).send({
            error: resourceCheck.reason || 'Tracing session quota exceeded',
          });
        }
      }

      fireAndForget('client-tracing-ingest', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);

        const retentionDays = quotaResult.effectiveLimits.quotas?.maxTracingRetentionDays;
        if (retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0) {
          const cutoff = new Date(Date.now() - retentionDays * 86_400 * 1000);
          await backgroundDb.cleanupAgentTracingRetention({
            olderThan: cutoff,
            projectId: ctx.projectId,
          });
        }

        if (existing) {
          await backgroundDb.updateAgentTracingSession(sessionId, sessionDoc, ctx.projectId);
        } else {
          const attribution = recordTracingSessionCreated({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            agentName: sessionDoc.agentName,
            metadata: sessionDoc.metadata,
          });
          await backgroundDb.createAgentTracingSession({
            ...sessionDoc,
            userId: attribution.userId,
            apiTokenId: attribution.apiTokenId,
            actorType: attribution.actorType,
          });
        }

        // This path deletes + recreates all events, so cost accounting must
        // work on the DELTA: tokens in the new event set minus what the old
        // set already accounted — a re-posted session contributes zero.
        const previousEvents = await backgroundDb.listAgentTracingEvents(sessionId, ctx.projectId);
        await backgroundDb.deleteAgentTracingEvents(sessionId, ctx.projectId);

        const createdEvents: Array<Omit<IAgentTracingEvent, '_id' | 'createdAt'>> = [];
        for (const event of events) {
          const sections = getEventSections(event);
          const metadata = buildEventMetadata(event, sections);
          const toolDetails = getEventToolDetails(event, sections);
          const usage = getEventUsage(event);
          const diagnostics = extractTraceDiagnostics(event);
          const inputTokens =
            event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens ?? undefined;
          const outputTokens =
            event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens ?? undefined;
          const cachedInputTokens =
            event?.cachedInputTokens
            ?? usage?.cachedInputTokens
            ?? usage?.cached_input_tokens
            ?? usage?.cacheReadInputTokens
            ?? usage?.cache_read_input_tokens
            ?? undefined;

          const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
            actor: event.actor || {},
            actorName: event.actor?.name ?? undefined,
            actorRole: event.actor?.role ?? event.actor?.scope ?? undefined,
            bytesIn: event.bytesIn ?? undefined,
            bytesOut: event.bytesOut ?? undefined,
            cachedInputTokens,
            durationMs: event.durationMs ?? undefined,
            error: toErrorRecord(event.error),
            finishReason: diagnostics.finishReason,
            id: event.id ?? undefined,
            inputTokens,
            label: event.label ?? undefined,
            metadata,
            model: event.model ?? undefined,
            modelNames: event.modelNames || [],
            outputTokens,
            parentSpanId: typeof event.parentSpanId === 'string' ? event.parentSpanId : undefined,
            projectId: ctx.projectId,
            reasoningTokens: diagnostics.reasoningTokens,
            requestBytes: event.requestBytes ?? undefined,
            responseBytes: event.responseBytes ?? undefined,
            sections,
            sequence: event.sequence ?? 0,
            sessionId,
            spanId: typeof event.spanId === 'string' ? event.spanId : undefined,
            status: event.status ?? undefined,
            tenantId: ctx.tenantId,
            timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
            toolExecutionId: event.toolExecutionId ?? undefined,
            toolName: event.toolName
              || (event.actor?.scope === 'tool' ? event.actor?.name ?? undefined : undefined)
              || normalizeToolName(toolDetails?.name),
            totalTokens: event.totalTokens ?? undefined,
            traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
            type: event.type ?? undefined,
          };

          await backgroundDb.createAgentTracingEvent(eventDoc);
          createdEvents.push(eventDoc);
        }

        await recordTraceModelUsage({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentName: sessionDoc.agentName,
          metadata: sessionDoc.metadata,
          events: createdEvents,
          previousEvents,
        });
      });

      return reply.code(200).send({
        eventsStored: events.length,
        sessionId,
        success: true,
      });
    } catch (error) {
      logger.error('Client tracing ingest error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to ingest tracing data',
      });
    }
  }));

  app.post('/client/v1/tracing/sessions/stream/:sessionId/start', withClientApiRequestContext(async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }

      const ctx = await getApiTokenContextForRequest(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      const payload = readJsonBody<TracingSessionPayload>(request);
      const resourceKey = payload?.agent?.name || sessionId;
      const quotaContext = getTracingQuotaContext(ctx, resourceKey);
      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const existing = await db.findAgentTracingSessionById(sessionId, ctx.projectId);
      const agentName = typeof payload?.agent?.name === 'string' ? payload.agent.name.trim() : '';
      if (agentName && !existing) {
        const { total } = await db.listAgentTracingSessions(
          { limit: 0 },
          ctx.projectId,
        );
        const resourceCheck = await checkResourceQuota(
          quotaContext,
          'tracingSessions',
          total,
        );
        if (!resourceCheck.allowed) {
          return reply.code(429).send({
            error: resourceCheck.reason || 'Tracing session quota exceeded',
          });
        }
      }

      const startedAt = payload.startedAt ? new Date(payload.startedAt) : new Date();
      const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
        agent: payload.agent || {},
        agentModel: payload.agent?.model ?? undefined,
        agentName: payload.agent?.name ?? undefined,
        agentVersion: payload.agent?.version ?? undefined,
        config: payload.config || {},
        durationMs: undefined,
        endedAt: undefined,
        errors: [],
        eventCounts: {},
        metadata: sanitizeTracingMetadata(payload.metadata),
        modelsUsed: payload.agent?.model ? [payload.agent.model] : [],
        projectId: ctx.projectId,
        rootSpanId: typeof payload.rootSpanId === 'string' ? payload.rootSpanId : undefined,
        sessionId,
        source: 'custom' as const,
        startedAt,
        status: 'in_progress',
        summary: {
          eventCounts: {},
          totalBytesIn: 0,
          totalBytesOut: 0,
          totalCachedInputTokens: 0,
          totalDurationMs: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
        tenantId: ctx.tenantId,
        threadId: typeof payload.threadId === 'string' && payload.threadId.trim()
          ? payload.threadId.trim()
          : undefined,
        toolsUsed: [],
        totalBytesIn: undefined,
        totalBytesOut: undefined,
        totalCachedInputTokens: 0,
        totalEvents: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
      };

      // A caller may re-`/start` an id it already used: SDK agents create a trace
      // session per `invoke()`, so one logical run (summarization legs, tool-call
      // retries, approval/question resumes) posts several starts under one
      // caller-supplied sessionId. Writing the zeroed skeleton over a live row on
      // those later starts erased everything the earlier legs had accumulated, so
      // the session only ever reported its final leg. Reopen the row instead:
      // keep every running total and re-arm it for the incoming leg.
      const hasAgent = Object.keys(sessionDoc.agent ?? {}).length > 0;
      const hasConfig = Object.keys(sessionDoc.config ?? {}).length > 0;
      const hasMetadata = Object.keys(sessionDoc.metadata ?? {}).length > 0;
      const reopenDoc: Partial<IAgentTracingSession> = {
        // A re-start body is often empty. Writing `{}` over these would drop the
        // agent identity the reopen exists to preserve.
        ...(hasAgent ? { agent: sessionDoc.agent } : {}),
        ...(hasConfig ? { config: sessionDoc.config } : {}),
        ...(hasMetadata ? { metadata: sessionDoc.metadata } : {}),
        agentModel: sessionDoc.agentModel ?? existing?.agentModel,
        agentName: sessionDoc.agentName ?? existing?.agentName,
        agentVersion: sessionDoc.agentVersion ?? existing?.agentVersion,
        durationMs: undefined,
        endedAt: undefined,
        modelsUsed: mergeUnique(existing?.modelsUsed, sessionDoc.modelsUsed),
        status: 'in_progress',
        ...(sessionDoc.threadId ? { threadId: sessionDoc.threadId } : {}),
        ...(sessionDoc.traceId ? { traceId: sessionDoc.traceId } : {}),
        ...(sessionDoc.rootSpanId ? { rootSpanId: sessionDoc.rootSpanId } : {}),
      };

      fireAndForget('client-tracing-stream-start', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);
        if (existing) {
          await backgroundDb.updateAgentTracingSession(sessionId, reopenDoc, ctx.projectId);
        } else {
          const attribution = recordTracingSessionCreated({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            agentName: sessionDoc.agentName,
            metadata: sessionDoc.metadata,
          });
          await backgroundDb.createAgentTracingSession({
            ...sessionDoc,
            userId: attribution.userId,
            apiTokenId: attribution.apiTokenId,
            actorType: attribution.actorType,
          });
        }
      });

      return reply.code(200).send({
        sessionId,
        status: 'in_progress',
        success: true,
      });
    } catch (error) {
      logger.error('Client tracing session start error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to start tracing session',
      });
    }
  }));

  app.post('/client/v1/tracing/sessions/stream/:sessionId/events', withClientApiRequestContext(async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }

      const ctx = await getApiTokenContextForRequest(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      const payload = readJsonBody<TracingStreamEventPayload>(request);
      const event = payload.event;
      if (!event) {
        return reply.code(400).send({ error: 'event is required' });
      }

      const session = await db.findAgentTracingSessionById(sessionId, ctx.projectId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      const quotaContext = getTracingQuotaContext(ctx, session.agentName || sessionId);
      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const quotaResult = await checkPerRequestLimits(quotaContext, {
        eventsPerSession: (session.totalEvents || 0) + 1,
      });
      if (!quotaResult.allowed) {
        return reply.code(429).send({
          error: quotaResult.reason || 'Event quota exceeded',
        });
      }

      const sections = getEventSections(event);
      const metadata = buildEventMetadata(event, sections);
      const toolDetails = getEventToolDetails(event, sections);
      const usage = getEventUsage(event);
      const diagnostics = extractTraceDiagnostics(event);
      const inputTokens =
        event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens ?? undefined;
      const outputTokens =
        event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens ?? undefined;
      const cachedInputTokens =
        event?.cachedInputTokens
        ?? usage?.cachedInputTokens
        ?? usage?.cached_input_tokens
        ?? usage?.cacheReadInputTokens
        ?? usage?.cache_read_input_tokens
        ?? undefined;
      const newTotalEvents = (session.totalEvents || 0) + 1;
      const models = [event?.model, event?.modelName, event?.metadata?.modelName]
        .filter((name): name is string => typeof name === 'string' && name.length > 0);

      fireAndForget('client-tracing-stream-event', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);
        const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
          actor: event.actor || {},
          actorName: event.actor?.name ?? undefined,
          actorRole: event.actor?.role ?? event.actor?.scope ?? undefined,
          bytesIn: event.bytesIn ?? undefined,
          bytesOut: event.bytesOut ?? undefined,
          cachedInputTokens,
          durationMs: event.durationMs ?? undefined,
          error: toErrorRecord(event.error),
          finishReason: diagnostics.finishReason,
          id: event.id ?? undefined,
          inputTokens,
          label: event.label ?? undefined,
          metadata,
          model: event.model ?? undefined,
          modelNames: event.modelNames || [],
          outputTokens,
          parentSpanId: typeof event.parentSpanId === 'string' ? event.parentSpanId : undefined,
          projectId: ctx.projectId,
          reasoningTokens: diagnostics.reasoningTokens,
          requestBytes: event.requestBytes ?? undefined,
          responseBytes: event.responseBytes ?? undefined,
          sections,
          sequence: event.sequence || 0,
          sessionId,
          spanId: typeof event.spanId === 'string' ? event.spanId : undefined,
          status: event.status ?? undefined,
          tenantId: ctx.tenantId,
          timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
          toolExecutionId: event.toolExecutionId ?? undefined,
          toolName: event.toolName
            || (event.actor?.scope === 'tool' ? event.actor?.name ?? undefined : undefined)
            || normalizeToolName(toolDetails?.name),
          totalTokens: event.totalTokens ?? undefined,
          traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
          type: event.type ?? undefined,
        };

        await backgroundDb.createAgentTracingEvent(eventDoc);

        await recordTraceModelUsage({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentName: session.agentName,
          metadata: session.metadata,
          events: [eventDoc],
        });

        await backgroundDb.applyAgentTracingSessionEvent(sessionId, {
          cachedInputTokens,
          durationMs: event.durationMs ?? undefined,
          eventType: event.type ?? undefined,
          finishReason: diagnostics.finishReason,
          inputTokens,
          modelsUsed: models,
          outputTokens,
          reasoningTokens: diagnostics.reasoningTokens,
          toolsUsed: collectEventToolNames(event),
        }, ctx.projectId);
      });

      return reply.code(200).send({
        eventId: event.id,
        sessionId,
        success: true,
        totalEvents: newTotalEvents,
      });
    } catch (error) {
      logger.error('Client tracing event ingest error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to ingest tracing event',
      });
    }
  }));

  app.post('/client/v1/tracing/sessions/stream/:sessionId/end', withClientApiRequestContext(async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }

      const ctx = await getApiTokenContextForRequest(request);
      const db = await getDatabase();
      await db.switchToTenant(ctx.tenantDbName);
      const payload = readJsonBody<TracingStreamEndPayload>(request);
      const session = await db.findAgentTracingSessionById(sessionId, ctx.projectId);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }

      const quotaContext = getTracingQuotaContext(ctx, session.agentName || sessionId);
      const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
      if (!rateLimitResult.allowed) {
        return reply.code(429).send({
          error: rateLimitResult.reason || 'Rate limit exceeded',
        });
      }

      const endedAt = payload.endedAt ? new Date(payload.endedAt) : new Date();
      const status = payload.status || 'success';
      const sessionStartedAt = session.startedAt
        ? new Date(session.startedAt).getTime()
        : endedAt.getTime();
      const durationMs = payload.durationMs ?? (endedAt.getTime() - sessionStartedAt);
      const existingSummary = getSummaryRecord(session.summary);
      const payloadSummary = getSummaryRecord(payload.summary);
      const payloadEventCounts = getSummaryEventCounts(payload.summary);
      const existingEventCounts = getSummaryEventCounts(session.summary);
      const mergedSummary: Record<string, unknown> = {
        ...existingSummary,
        ...payloadSummary,
        eventCounts: Object.keys(payloadEventCounts).length > 0
          ? payloadEventCounts
          : (Object.keys(existingEventCounts).length > 0
            ? existingEventCounts
            : (session.eventCounts || {})),
        // `end` used to let the payload win outright. A session that spans several
        // SDK legs sends one `end` per leg carrying only that leg's summary, so the
        // last leg's numbers replaced the run's. Take the larger of what the session
        // already accumulated (from `/events`) and what this leg reports: totals can
        // only ever grow, which also makes a retried `end` idempotent.
        totalBytesIn: maxTotal(payload.summary, session.summary, session.totalBytesIn, 'totalBytesIn'),
        totalBytesOut: maxTotal(payload.summary, session.summary, session.totalBytesOut, 'totalBytesOut'),
        totalCachedInputTokens: maxTotal(
          payload.summary,
          session.summary,
          session.totalCachedInputTokens,
          'totalCachedInputTokens',
        ),
        // Monotonic like the token totals: one `end` per leg means the payload
        // only ever describes that leg's wall clock, so letting it win shrank a
        // multi-leg run's duration to its last leg.
        totalDurationMs: Math.max(
          maxTotal(payload.summary, session.summary, undefined, 'totalDurationMs'),
          durationMs,
        ),
        totalInputTokens: maxTotal(payload.summary, session.summary, session.totalInputTokens, 'totalInputTokens'),
        totalOutputTokens: maxTotal(payload.summary, session.summary, session.totalOutputTokens, 'totalOutputTokens'),
      };
      // A retried `end` resends the same errors. Appending blindly meant each
      // retry grew the list, so deduplicate on the serialized entry.
      const mergedErrors = dedupeErrors([
        ...(session.errors || []),
        ...toErrorList(payload.errors),
      ]);

      fireAndForget('client-tracing-stream-end', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);
        await backgroundDb.updateAgentTracingSession(sessionId, {
          durationMs,
          endedAt,
          errors: mergedErrors,
          status,
          summary: mergedSummary,
          totalBytesIn: getSummaryNumber(mergedSummary, 'totalBytesIn'),
          totalBytesOut: getSummaryNumber(mergedSummary, 'totalBytesOut'),
          totalCachedInputTokens: getSummaryNumber(mergedSummary, 'totalCachedInputTokens'),
          totalInputTokens: getSummaryNumber(mergedSummary, 'totalInputTokens'),
          totalOutputTokens: getSummaryNumber(mergedSummary, 'totalOutputTokens'),
        }, ctx.projectId);
      });

      return reply.code(200).send({
        durationMs,
        sessionId,
        status,
        success: true,
        totalEvents: session.totalEvents || 0,
      });
    } catch (error) {
      logger.error('Client tracing session end error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to end tracing session',
      });
    }
  }));

  // ── Read: list threads (grouped sessions) ──
  app.get('/client/v1/tracing/threads', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const query = request.query as {
        agent?: string; status?: string; threadId?: string;
        from?: string; to?: string; limit?: string; skip?: string;
      };

      const result = await AgentTracingService.listThreads(auth.tenantDbName, auth.projectId, {
        agent: query.agent,
        status: query.status,
        threadId: query.threadId,
        from: query.from,
        to: query.to,
        limit: query.limit || '50',
        skip: query.skip || '0',
      });

      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Client tracing threads list error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to list tracing threads',
      });
    }
  }));

  // ── Read: single thread detail ──
  app.get('/client/v1/tracing/threads/:threadId', withClientApiRequestContext(async (request, reply, auth) => {
    try {
      const { threadId } = request.params as { threadId: string };
      const result = await AgentTracingService.getThreadDetail(
        auth.tenantDbName,
        auth.projectId,
        threadId,
      );
      if (!result) {
        return reply.code(404).send({ error: 'Thread not found' });
      }
      return reply.code(200).send(result);
    } catch (error) {
      logger.error('Client tracing thread detail error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to get tracing thread',
      });
    }
  }));
};
