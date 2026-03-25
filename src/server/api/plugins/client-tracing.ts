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
import { mapOtlpToInternalModels, type OtlpExportTraceServiceRequest } from '@/lib/services/otlpMapper';
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
  };
  durationMs?: number | null;
  error?: string | null;
  id?: string | null;
  inputTokens?: number | null;
  label?: string | null;
  metadata?: Record<string, unknown> & {
    modelName?: string | null;
    usage?: TracingUsage;
  };
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

function getEventSections(event: TracingEventPayload): Array<Record<string, unknown>> {
  const rawSections = Array.isArray(event.sections)
    ? event.sections
    : (Array.isArray(event.data?.sections) ? event.data.sections : []);

  return rawSections.flatMap((section) => {
    const normalized = toRecord(section);
    return normalized ? [normalized] : [];
  });
}

function getEventUsage(event: TracingEventPayload): TracingUsage {
  return event.usage || event.metadata?.usage || {};
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

      const { total: existingSessionCount } = await db.listAgentTracingSessions({}, ctx.projectId);
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
            traceId: existing?.traceId || session.traceId,
          };

          if (existing) {
            await backgroundDb.updateAgentTracingSession(
              session.sessionId,
              mergedSession,
              ctx.projectId,
            );
          } else {
            await backgroundDb.createAgentTracingSession(mergedSession);
          }
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
      events.forEach((event) => {
        if (event?.model) modelsUsed.add(event.model);
        if (event?.modelName) modelsUsed.add(event.modelName);
        if (event?.metadata?.modelName) modelsUsed.add(event.metadata.modelName);
        if (event?.toolName) toolsUsed.add(event.toolName);
        if (event?.actor?.scope === 'tool' && event?.actor?.name) {
          toolsUsed.add(event.actor.name);
        }
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
        traceId: typeof payload.traceId === 'string' ? payload.traceId : undefined,
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
        const { total } = await db.listAgentTracingSessions({}, ctx.projectId);
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
          await backgroundDb.createAgentTracingSession(sessionDoc);
        }

        await backgroundDb.deleteAgentTracingEvents(sessionId, ctx.projectId);

        for (const event of events) {
          const sections = getEventSections(event);
          const usage = getEventUsage(event);
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
            id: event.id ?? undefined,
            inputTokens,
            label: event.label ?? undefined,
            metadata: event.metadata || {},
            model: event.model ?? undefined,
            modelNames: event.modelNames || [],
            outputTokens,
            parentSpanId: typeof event.parentSpanId === 'string' ? event.parentSpanId : undefined,
            projectId: ctx.projectId,
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
              || (event.actor?.scope === 'tool' ? event.actor?.name ?? undefined : undefined),
            totalTokens: event.totalTokens ?? undefined,
            traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
            type: event.type ?? undefined,
          };

          await backgroundDb.createAgentTracingEvent(eventDoc);
        }
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
        const { total } = await db.listAgentTracingSessions({}, ctx.projectId);
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

      fireAndForget('client-tracing-stream-start', async () => {
        const backgroundDb = await getDatabase();
        await backgroundDb.switchToTenant(ctx.tenantDbName);
        if (existing) {
          await backgroundDb.updateAgentTracingSession(sessionId, sessionDoc, ctx.projectId);
        } else {
          await backgroundDb.createAgentTracingSession(sessionDoc);
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
      const usage = getEventUsage(event);
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
      const newInputTokens = (session.totalInputTokens || 0) + (inputTokens || 0);
      const newOutputTokens = (session.totalOutputTokens || 0) + (outputTokens || 0);
      const newCachedTokens = (session.totalCachedInputTokens || 0) + (cachedInputTokens || 0);
      const modelsUsed = new Set<string>(session.modelsUsed || []);
      const toolsUsed = new Set<string>(session.toolsUsed || []);
      if (event?.model) modelsUsed.add(event.model);
      if (event?.modelName) modelsUsed.add(event.modelName);
      if (event?.metadata?.modelName) modelsUsed.add(event.metadata.modelName);
      if (event?.toolName) toolsUsed.add(event.toolName);
      if (event?.actor?.scope === 'tool' && event?.actor?.name) {
        toolsUsed.add(event.actor.name);
      }

      const eventCounts = { ...(session.eventCounts || {}) };
      if (event.type) {
        eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
      }

      const currentSummary = getSummaryRecord(session.summary);
      const summary: Record<string, unknown> = { ...currentSummary };
      summary.totalInputTokens = newInputTokens;
      summary.totalOutputTokens = newOutputTokens;
      summary.totalCachedInputTokens = newCachedTokens;
      summary.eventCounts = eventCounts;
      if (event.durationMs) {
        summary.totalDurationMs = (getSummaryNumber(session.summary, 'totalDurationMs') ?? 0) + event.durationMs;
      }

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
          id: event.id ?? undefined,
          inputTokens,
          label: event.label ?? undefined,
          metadata: event.metadata || {},
          model: event.model ?? undefined,
          modelNames: event.modelNames || [],
          outputTokens,
          parentSpanId: typeof event.parentSpanId === 'string' ? event.parentSpanId : undefined,
          projectId: ctx.projectId,
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
            || (event.actor?.scope === 'tool' ? event.actor?.name ?? undefined : undefined),
          totalTokens: event.totalTokens ?? undefined,
          traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
          type: event.type ?? undefined,
        };

        await backgroundDb.createAgentTracingEvent(eventDoc);

        await backgroundDb.updateAgentTracingSession(sessionId, {
          eventCounts,
          modelsUsed: Array.from(modelsUsed),
          summary,
          toolsUsed: Array.from(toolsUsed),
          totalCachedInputTokens: newCachedTokens,
          totalEvents: newTotalEvents,
          totalInputTokens: newInputTokens,
          totalOutputTokens: newOutputTokens,
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
        totalBytesIn: getSummaryNumber(payload.summary, 'totalBytesIn')
          ?? getSummaryNumber(session.summary, 'totalBytesIn')
          ?? session.totalBytesIn
          ?? 0,
        totalBytesOut: getSummaryNumber(payload.summary, 'totalBytesOut')
          ?? getSummaryNumber(session.summary, 'totalBytesOut')
          ?? session.totalBytesOut
          ?? 0,
        totalCachedInputTokens: getSummaryNumber(payload.summary, 'totalCachedInputTokens')
          ?? getSummaryNumber(session.summary, 'totalCachedInputTokens')
          ?? session.totalCachedInputTokens
          ?? 0,
        totalDurationMs: getSummaryNumber(payload.summary, 'totalDurationMs')
          ?? getSummaryNumber(session.summary, 'totalDurationMs')
          ?? durationMs,
        totalInputTokens: getSummaryNumber(payload.summary, 'totalInputTokens')
          ?? getSummaryNumber(session.summary, 'totalInputTokens')
          ?? session.totalInputTokens
          ?? 0,
        totalOutputTokens: getSummaryNumber(payload.summary, 'totalOutputTokens')
          ?? getSummaryNumber(session.summary, 'totalOutputTokens')
          ?? session.totalOutputTokens
          ?? 0,
      };
      const mergedErrors = [
        ...(session.errors || []),
        ...toErrorList(payload.errors),
      ];

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
};
