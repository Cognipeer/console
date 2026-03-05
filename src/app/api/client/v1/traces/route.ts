/**
 * OTLP/HTTP JSON Trace Ingestion Endpoint
 *
 * POST /api/client/v1/traces
 *
 * Accepts OpenTelemetry ExportTraceServiceRequest (JSON) and maps it to
 * the internal tracing model. This allows any OTel-compatible agent SDK,
 * LangChain, CrewAI, AutoGen etc. to send traces to Cognipeer.
 *
 * Authentication: API Token (Bearer)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { withRequestContext } from '@/lib/api/withRequestContext';
import type { IAgentTracingEvent } from '@/lib/database/provider/types.base';
import {
  mapOtlpToInternalModels,
  type OtlpExportTraceServiceRequest,
} from '@/lib/services/otlpMapper';

export const runtime = 'nodejs';

const logger = createLogger('client-otlp-traces');

/** Max request body size in bytes. Reuses TRACING_MAX_BODY_SIZE_MB config. */
const getMaxBodySizeBytes = () => getConfig().limits.tracingMaxBodySizeMb * 1024 * 1024;

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

function buildEventFingerprint(event: {
  spanId?: string;
  id?: string;
  traceId?: string;
  type?: string;
  label?: string;
  timestamp?: unknown;
  sequence?: number;
}): string {
  if (event.spanId) return `span:${event.spanId}`;
  if (event.id) return `id:${event.id}`;
  const ts = toIso(event.timestamp) || 'no-ts';
  return [
    event.traceId || 'no-trace',
    event.type || 'no-type',
    event.label || 'no-label',
    String(event.sequence ?? -1),
    ts,
  ].join('|');
}

function aggregateEvents(events: IAgentTracingEvent[]) {
  const eventCounts: Record<string, number> = {};
  const modelsUsed = new Set<string>();
  const toolsUsed = new Set<string>();
  const errors: Array<Record<string, unknown>> = [];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalBytesIn = 0;
  let totalBytesOut = 0;
  let totalDurationMs = 0;

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (type) eventCounts[type] = (eventCounts[type] || 0) + 1;

    const model = typeof event.model === 'string' ? event.model : undefined;
    if (model) modelsUsed.add(model);

    const toolName = typeof event.toolName === 'string' ? event.toolName : undefined;
    if (toolName) toolsUsed.add(toolName);

    const inputTokens = typeof event.inputTokens === 'number' ? event.inputTokens : 0;
    const outputTokens = typeof event.outputTokens === 'number' ? event.outputTokens : 0;
    const cachedInputTokens = typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : 0;
    const requestBytes = typeof event.requestBytes === 'number' ? event.requestBytes : 0;
    const responseBytes = typeof event.responseBytes === 'number' ? event.responseBytes : 0;
    const durationMs = typeof event.durationMs === 'number' ? event.durationMs : 0;

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCachedInputTokens += cachedInputTokens;
    totalBytesIn += requestBytes;
    totalBytesOut += responseBytes;
    totalDurationMs += durationMs;

    const status = typeof event.status === 'string' ? event.status : undefined;
    if (status === 'error') {
      errors.push({
        eventId: typeof event.id === 'string' ? event.id : undefined,
        type,
        message:
          (typeof event.error === 'string' ? event.error : undefined) ||
          (typeof event.label === 'string' ? event.label : 'Event error'),
        timestamp: toIso(event.timestamp),
      });
    }
  }

  return {
    totalEvents: events.length,
    totalInputTokens,
    totalOutputTokens,
    totalCachedInputTokens,
    totalBytesIn,
    totalBytesOut,
    totalDurationMs,
    eventCounts,
    modelsUsed: [...modelsUsed],
    toolsUsed: [...toolsUsed],
    errors,
  };
}

const _POST = async (request: NextRequest) => {
  try {
    // ── Size guard ──────────────────────────────────────────────────
    const maxBodySize = getMaxBodySizeBytes();
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > maxBodySize) {
      return NextResponse.json(
        {
          error: `Payload too large. Max allowed: ${maxBodySize} bytes (${Math.round(
            maxBodySize / 1024 / 1024
          )}MB).`,
        },
        { status: 413 }
      );
    }

    // ── Auth ────────────────────────────────────────────────────────
    const auth = await requireApiToken(request);
    const db = await getDatabase();
    await db.switchToTenant(auth.tenantDbName);

    // ── Parse OTLP payload ──────────────────────────────────────────
    const payload: OtlpExportTraceServiceRequest = await request.json();

    if (!payload?.resourceSpans || !Array.isArray(payload.resourceSpans)) {
      return NextResponse.json(
        { error: 'Invalid OTLP payload: resourceSpans array is required' },
        { status: 400 }
      );
    }

    // Count total spans for quota checks
    let totalSpans = 0;
    for (const rs of payload.resourceSpans) {
      for (const ss of rs.scopeSpans || []) {
        totalSpans += ss.spans?.length || 0;
      }
    }

    if (totalSpans === 0) {
      return NextResponse.json(
        { error: 'No spans found in payload' },
        { status: 400 }
      );
    }

    // ── Map to internal model ──────────────────────────────────────
    const mapped = mapOtlpToInternalModels(
      payload,
      auth.tenantId,
      auth.projectId
    );

    if (mapped.sessions.length === 0) {
      return NextResponse.json(
        { error: 'Could not derive any sessions from the OTLP payload' },
        { status: 400 }
      );
    }

    // ── Quota checks ───────────────────────────────────────────────
    const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
    const firstSession = mapped.sessions[0];
    const resourceKey = firstSession.agentName || firstSession.sessionId;
    const quotaContext = {
      tenantDbName: auth.tenantDbName,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      licenseType: auth.tenant.licenseType as LicenseType,
      userId: auth.tokenRecord.userId,
      tokenId,
      domain: 'tracing' as const,
      resourceKey,
    };

    const quotaResult = await checkPerRequestLimits(quotaContext, {
      eventsPerSession: totalSpans,
    });

    if (!quotaResult.allowed) {
      return NextResponse.json(
        { error: quotaResult.reason || 'Quota exceeded' },
        { status: 429 }
      );
    }

    const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: rateLimitResult.reason || 'Rate limit exceeded' },
        { status: 429 }
      );
    }

    // ── Agent count guard ──────────────────────────────────────────
    const maxAgents = quotaResult.effectiveLimits.quotas?.maxAgents;
    for (const session of mapped.sessions) {
      const agentName = session.agentName?.trim();
      if (maxAgents !== undefined && maxAgents !== -1 && agentName) {
        const alreadyExists = await db.agentTracingAgentExists(agentName, auth.projectId);
        if (!alreadyExists) {
          const currentAgents = await db.countAgentTracingDistinctAgents(auth.projectId);
          if (currentAgents >= maxAgents) {
            return NextResponse.json(
              { error: `agents limit reached (${currentAgents}/${maxAgents})` },
              { status: 429 }
            );
          }
        }
      }
    }

    // ── Resource quota check (total sessions) ──────────────────────
    const { total: existingSessionCount } = await db.listAgentTracingSessions({}, auth.projectId);
    const resourceCheck = await checkResourceQuota(
      quotaContext,
      'tracingSessions',
      existingSessionCount
    );
    if (!resourceCheck.allowed) {
      return NextResponse.json(
        { error: resourceCheck.reason || 'Tracing session quota exceeded' },
        { status: 429 }
      );
    }

    // ── Async DB writes (fire-and-forget) ──────────────────────────
    fireAndForget('otlp-traces-ingest', async () => {
      const bgDb = await getDatabase();
      await bgDb.switchToTenant(auth.tenantDbName);

      // Retention cleanup
      const retentionDays = quotaResult.effectiveLimits.quotas?.maxTracingRetentionDays;
      if (retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0) {
        const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
        await bgDb.cleanupAgentTracingRetention({
          projectId: auth.projectId,
          olderThan: cutoff,
        });
      }

      const eventsBySession = new Map<string, typeof mapped.events>();
      for (const event of mapped.events) {
        const list = eventsBySession.get(event.sessionId) || [];
        list.push(event);
        eventsBySession.set(event.sessionId, list);
      }

      for (const session of mapped.sessions) {
        const existing = await bgDb.findAgentTracingSessionById(
          session.sessionId,
          auth.projectId
        );

        const incomingEvents = eventsBySession.get(session.sessionId) || [];
        const existingEvents = await bgDb.listAgentTracingEvents(session.sessionId, auth.projectId);
        const seen = new Set(
          existingEvents.map((event) =>
            buildEventFingerprint({
              spanId: event.spanId,
              id: event.id,
              traceId: event.traceId,
              type: event.type,
              label: event.label,
              timestamp: event.timestamp,
              sequence: event.sequence,
            })
          )
        );

        for (const event of incomingEvents) {
          const fingerprint = buildEventFingerprint({
            spanId: event.spanId,
            id: event.id,
            traceId: event.traceId,
            type: event.type,
            label: event.label,
            timestamp: event.timestamp,
            sequence: event.sequence,
          });
          if (seen.has(fingerprint)) continue;
          seen.add(fingerprint);
          await bgDb.createAgentTracingEvent(event);
        }

        const allEvents = await bgDb.listAgentTracingEvents(session.sessionId, auth.projectId);
        const stats = aggregateEvents(allEvents);

        const existingStartedAt = existing?.startedAt;
        const nextStartedAt =
          existingStartedAt && session.startedAt
            ? new Date(Math.min(existingStartedAt.getTime(), session.startedAt.getTime()))
            : existingStartedAt || session.startedAt;

        const existingEndedAt = existing?.endedAt;
        const nextEndedAt =
          existingEndedAt && session.endedAt
            ? new Date(Math.max(existingEndedAt.getTime(), session.endedAt.getTime()))
            : existingEndedAt || session.endedAt;

        const durationMs =
          nextStartedAt && nextEndedAt
            ? Math.max(0, nextEndedAt.getTime() - nextStartedAt.getTime())
            : session.durationMs;

        const mergedStatus =
          stats.errors.length > 0 ? 'error' : (existing?.status || session.status || 'success');

        const summary = {
          totalDurationMs: stats.totalDurationMs,
          totalInputTokens: stats.totalInputTokens,
          totalOutputTokens: stats.totalOutputTokens,
          totalCachedInputTokens: stats.totalCachedInputTokens,
          totalBytesIn: stats.totalBytesIn,
          totalBytesOut: stats.totalBytesOut,
          eventCounts: stats.eventCounts,
        };

        const mergedSession = {
          ...session,
          traceId: existing?.traceId || session.traceId,
          rootSpanId: existing?.rootSpanId || session.rootSpanId,
          source: existing?.source || session.source || 'otlp',
          startedAt: nextStartedAt,
          endedAt: nextEndedAt,
          durationMs,
          status: mergedStatus,
          summary,
          totalEvents: stats.totalEvents,
          totalInputTokens: stats.totalInputTokens,
          totalOutputTokens: stats.totalOutputTokens,
          totalCachedInputTokens: stats.totalCachedInputTokens,
          totalBytesIn: stats.totalBytesIn,
          totalBytesOut: stats.totalBytesOut,
          modelsUsed: stats.modelsUsed,
          toolsUsed: stats.toolsUsed,
          eventCounts: stats.eventCounts,
          errors: stats.errors,
        };

        if (existing) {
          await bgDb.updateAgentTracingSession(session.sessionId, mergedSession, auth.projectId);
        } else {
          await bgDb.createAgentTracingSession(mergedSession);
        }
      }

      logger.info('OTLP traces persisted', {
        sessions: mapped.sessions.length,
        events: mapped.events.length,
      });
    });

    return NextResponse.json({
      success: true,
      sessionsIngested: mapped.sessions.length,
      spansProcessed: totalSpans,
      eventsStored: mapped.events.length,
    });
  } catch (error: unknown) {
    logger.error('OTLP traces ingest error', { error });

    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const message =
      error instanceof Error ? error.message : 'Failed to ingest OTLP traces';
    return NextResponse.json({ error: message }, { status: 500 });
  }
};

export const POST = withRequestContext(_POST);
