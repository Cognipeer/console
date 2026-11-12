import type { FastifyInstance } from 'fastify';
import type {
  IAgentTracingEvent,
  IAgentTracingSession,
} from '@/lib/database/provider/types.base';
import { fireAndForget } from '@/lib/core/asyncTask';
import { mergeContinuedSessionDoc, readTraceContinuationMarker } from '@/lib/services/tracingContinuation';
import { shouldRunTracingRetentionSweep } from '@/lib/services/tracingRetentionSweep';
import { getDatabase } from '@/lib/database';
import {
  checkPerRequestLimits,
  checkRateLimit,
  checkResourceQuota,
} from '@/lib/quota/quotaGuard';
import {
  createTraceModelPricerLoader,
  recordTracingSessionCreated,
  recordTraceModelUsage,
} from '@/lib/services/agentTracing';
import {
  buildEventFingerprint,
  isTerminalSessionStatus,
  recordAgentSessionOutcome,
  recordTraceEventMetrics,
} from '@/lib/services/tracing/traceEntityMetrics';
import { mapOtlpToInternalModels, type OtlpExportTraceServiceRequest } from '@/lib/services/otlpMapper';
import {
  isTruncatedFinishReason,
} from '@/lib/shared/finishReason';
import {
  countTraceErrors,
  deriveSessionStatus,
  isExplicitClientStatus,
} from '@/lib/shared/traceHealth';
import {
  getApiTokenContextForRequest,
  readJsonBody,
  withClientApiRequestContext,
} from '../../fastify-utils';

import type { TracingSessionPayload } from './payloadTypes';
import { toErrorRecord, toErrorList, getSummaryRecord, getSummaryEventCounts, getSummaryNumber } from './recordCoerce';
import { aggregateEvents, countNonSinkErrors, dedupeErrors } from './eventAggregation';
import { getMaxBodySizeBytes, getTracingQuotaContext } from './quota';
import {
  buildEventMetadata,
  collectEventToolNames,
  extractTraceDiagnostics,
  getEventSections,
  getEventToolDetails,
  normalizeToolName,
  resolveTraceEventUsage,
} from './eventSections';
import { sanitizeTracingMetadata } from './metadata';
import { logger } from './logger';

export const registerIngestRoutes = (app: FastifyInstance): void => {
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
        if (
          retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0
          && shouldRunTracingRetentionSweep(ctx.tenantDbName, ctx.projectId)
        ) {
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

        const endedSessionIds = new Set(mapped.endedSessionIds);
        for (const session of mapped.sessions) {
          const existing = await backgroundDb.findAgentTracingSessionById(
            session.sessionId,
            ctx.projectId,
          );
          const incomingEvents = eventsBySession.get(session.sessionId) || [];
          // Only identity fields are needed to dedupe, so the heavy payloads stay in the database (MongoDB honors the projection).
          const existingEvents = await backgroundDb.listAgentTracingEvents(
            session.sessionId,
            ctx.projectId,
            { projection: { sections: 0, metadata: 0, actor: 0 } },
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

          // Spans without `cognipeer.event.sequence` (gen_ai-only exports) are numbered by position in their request,
          // which restarts at 1 in the next one: continue after what the session already holds.
          const sequenceBase = existingEvents.reduce(
            (max, event) => (typeof event.sequence === 'number' && Number.isFinite(event.sequence) ? Math.max(max, event.sequence) : max),
            0,
          );
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
            if (mapped.positionalSequence.has(event) && typeof event.sequence === 'number') event.sequence += sequenceBase;
            await backgroundDb.createAgentTracingEvent(event);
            insertedEvents.push(event);
          }

          const allEvents = await backgroundDb.listAgentTracingEvents(
            session.sessionId,
            ctx.projectId,
            { projection: { sections: 0, metadata: 0 } },
          );
          const stats = aggregateEvents(allEvents);
          // Root-span exceptions (the mapper's eventId 'session') belong to the session, not to any event; keep the ones from earlier batches too.
          const rootErrors = [
            ...(session.errors ?? []),
            ...(existing?.errors ?? []),
          ].filter((error) => error?.eventId === 'session');
          const sessionErrors = dedupeErrors([...stats.errors, ...rootErrors]);
          const rootEnded = endedSessionIds.has(session.sessionId);
          const alreadyTerminal = isTerminalSessionStatus(existing?.status);
          const finished = rootEnded || alreadyTerminal;
          const sawError = stats.errorEvents > 0 || rootErrors.length > 0 || (rootEnded && session.status === 'error');
          // OTLP has no end signal: the root span only arrives once the run is over. Until then (and while no
          // earlier terminal status exists) the session stays in progress, errors included (they are counted per
          // event and in `errorEvents`); the finalizer closes it after a quiet window as success or error from
          // what was received. An error on a run that already finished flips it to error.
          const status = sawError && finished
            ? 'error'
            : deriveSessionStatus({
              clientStatus: rootEnded ? undefined : existing?.status,
              errorEvents: 0,
              nonSinkErrors: 0,
              ended: finished,
            });
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
            errorEvents: stats.errorEvents,
            errors: sessionErrors,
            eventCounts: stats.eventCounts,
            modelsUsed: stats.modelsUsed,
            aiErrors: stats.aiErrors,
            // A paused run's first leg has no root, so the mapper falls back to a child span; the real root arrives
            // with the batch that ends the session and must replace it.
            rootSpanId: rootEnded ? (session.rootSpanId || existing?.rootSpanId) : (existing?.rootSpanId || session.rootSpanId),
            source: existing?.source || session.source || 'otlp',
            startedAt: nextStartedAt,
            status,
            summary,
            toolErrors: stats.toolErrors,
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
          const pricerLoader = createTraceModelPricerLoader(ctx.tenantDbName, ctx.projectId, ctx.tenantId);
          await recordTraceModelUsage({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            agentName: mergedSession.agentName,
            metadata: mergedSession.metadata,
            events: insertedEvents,
            pricerLoader,
          });
          await recordTraceEventMetrics({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            agentName: mergedSession.agentName,
            events: insertedEvents,
            source: 'tracing',
            pricerLoader,
          });
          // The root span's arrival (or the finalizer's quiet-window close) ends an OTLP run, so only a run that
          // is finished, counted already, or terminal before this batch (legacy rows with no marker) is booked.
          if (isTerminalSessionStatus(status) && (rootEnded || existing?.metricsOutcome || alreadyTerminal)) {
            await recordAgentSessionOutcome({
              tenantDbName: ctx.tenantDbName,
              tenantId: ctx.tenantId,
              projectId: ctx.projectId,
              session: mergedSession,
              previousOutcome: existing?.metricsOutcome,
              source: 'tracing',
              events: allEvents,
              pricerLoader,
            });
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

      // Health counters come from the events themselves; the client's status stays authoritative when it sends one
      // (a recovered session it calls `success` is a success), and only an absent status is derived. A batch post is
      // the finished session unless the client says it is still running.
      const batchErrorCounts = countTraceErrors(events);
      const batchErrors = toErrorList(payload.errors);
      const batchStatus = deriveSessionStatus({
        clientStatus: payload.status,
        errorEvents: batchErrorCounts.errorEvents,
        nonSinkErrors: countNonSinkErrors(batchErrors),
        ended: String(payload.status ?? '').trim().toLowerCase() !== 'in_progress',
      });

      const sessionSummary = getSummaryRecord(payload.summary);
      const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
        agent: payload.agent || {},
        agentModel: payload.agent?.model ?? undefined,
        agentName: payload.agent?.name ?? undefined,
        agentVersion: payload.agent?.version ?? undefined,
        config: payload.config || {},
        durationMs: payload.durationMs
          ?? (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined),
        endedAt: payload.endedAt ? new Date(payload.endedAt) : undefined,
        errorEvents: batchErrorCounts.errorEvents,
        errors: batchErrors,
        eventCounts: getSummaryEventCounts(payload.summary),
        metadata: sanitizeTracingMetadata(payload.metadata),
        modelsUsed: Array.from(modelsUsed),
        projectId: ctx.projectId,
        rootSpanId: typeof payload.rootSpanId === 'string' ? payload.rootSpanId : undefined,
        sessionId,
        source: 'custom' as const,
        startedAt: payload.startedAt ? new Date(payload.startedAt) : new Date(),
        status: batchStatus,
        // A status the client supplied is never overridden by a late error event (only a derived one is).
        statusExplicit: isExplicitClientStatus(payload.status),
        summary: sessionSummary,
        tenantId: ctx.tenantId,
        threadId: typeof payload.threadId === 'string' && payload.threadId.trim()
          ? payload.threadId.trim()
          : undefined,
        aiErrors: batchErrorCounts.aiErrors,
        toolErrors: batchErrorCounts.toolErrors,
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
      // A later part of a session the SDK delivers in parts (a run resumed
      // after a pause): append its events instead of replacing the session's.
      const continuation = existing ? readTraceContinuationMarker(payload) : undefined;
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
        if (
          retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0
          && shouldRunTracingRetentionSweep(ctx.tenantDbName, ctx.projectId)
        ) {
          const cutoff = new Date(Date.now() - retentionDays * 86_400 * 1000);
          await backgroundDb.cleanupAgentTracingRetention({
            olderThan: cutoff,
            projectId: ctx.projectId,
          });
        }

        const storedEvents = continuation
          ? await backgroundDb.listAgentTracingEvents(sessionId, ctx.projectId, { projection: { sequence: 1 } })
          : [];
        const storedSequences = new Set(storedEvents.map((event) => event.sequence));
        // A retried part must not insert its events twice.
        const partEvents = continuation
          ? events.filter((event) => !storedSequences.has(event?.sequence ?? 0))
          : events;
        if (continuation && existing) {
          mergeContinuedSessionDoc(sessionDoc, existing, { storedEvents: storedEvents.length, newEvents: partEvents.length });
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
        // A continued part adds events: the earlier parts' tokens were
        // accounted when they arrived, so there is nothing to subtract.
        const previousEvents = continuation ? [] : await backgroundDb.listAgentTracingEvents(sessionId, ctx.projectId);
        if (!continuation) await backgroundDb.deleteAgentTracingEvents(sessionId, ctx.projectId);

        const createdEvents: Array<Omit<IAgentTracingEvent, '_id' | 'createdAt'>> = [];
        // Session totals come from the sender's native-basis summary; the events
        // below are stored inclusive, so the totals must follow them.
        let usageAdjusted = false;
        let inputAdjustment = 0;
        let outputAdjustment = 0;
        for (const event of partEvents) {
          const sections = getEventSections(event);
          const metadata = buildEventMetadata(event, sections);
          const toolDetails = getEventToolDetails(event, sections);
          const diagnostics = extractTraceDiagnostics(event);
          const normalized = resolveTraceEventUsage(event);
          const { inputTokens, outputTokens, cachedInputTokens, cachedWriteTokens } = normalized;
          if (normalized.adjusted) {
            usageAdjusted = true;
            inputAdjustment += normalized.inputDelta;
            outputAdjustment += normalized.outputDelta;
          }

          const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
            actor: event.actor || {},
            actorName: event.actor?.name ?? undefined,
            actorRole: event.actor?.role ?? event.actor?.scope ?? undefined,
            bytesIn: event.bytesIn ?? undefined,
            bytesOut: event.bytesOut ?? undefined,
            cachedInputTokens,
            cachedWriteTokens: cachedWriteTokens ?? 0,
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
            totalTokens: normalized.totalTokens,
            traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
            type: event.type ?? undefined,
          };

          await backgroundDb.createAgentTracingEvent(eventDoc);
          createdEvents.push(eventDoc);
        }

        // The sender's summary totals are native-basis; the stored events are
        // inclusive. Keep the larger of the summary plus this part's fold and what
        // the stored events add up to: a continuation's summary is cumulative over
        // parts whose folds are not in this payload (and a part with no flagged
        // event must not pull inclusive totals back to native), and a sender that
        // sent no summary totals would otherwise keep the fold alone.
        if (usageAdjusted || continuation) {
          const stats = aggregateEvents(continuation
            ? await backgroundDb.listAgentTracingEvents(sessionId, ctx.projectId, { projection: { sections: 0, metadata: 0 } })
            : createdEvents as IAgentTracingEvent[]);
          const totalInputTokens = Math.max((sessionDoc.totalInputTokens ?? 0) + inputAdjustment, stats.totalInputTokens);
          const totalOutputTokens = Math.max((sessionDoc.totalOutputTokens ?? 0) + outputAdjustment, stats.totalOutputTokens);
          if (totalInputTokens !== sessionDoc.totalInputTokens || totalOutputTokens !== sessionDoc.totalOutputTokens) {
            sessionDoc.totalInputTokens = totalInputTokens;
            sessionDoc.totalOutputTokens = totalOutputTokens;
            sessionDoc.summary = { ...(sessionDoc.summary ?? {}), totalInputTokens, totalOutputTokens };
            await backgroundDb.updateAgentTracingSession(sessionId, {
              summary: sessionDoc.summary,
              totalInputTokens,
              totalOutputTokens,
            }, ctx.projectId);
          }
        }

        const pricerLoader = createTraceModelPricerLoader(ctx.tenantDbName, ctx.projectId, ctx.tenantId);
        await recordTraceModelUsage({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentName: sessionDoc.agentName,
          metadata: sessionDoc.metadata,
          events: createdEvents,
          previousEvents,
          pricerLoader,
        });
        await recordTraceEventMetrics({
          tenantDbName: ctx.tenantDbName,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          agentName: sessionDoc.agentName,
          events: createdEvents,
          previousEvents,
          source: 'tracing',
          pricerLoader,
        });
        if (isTerminalSessionStatus(sessionDoc.status)) {
          await recordAgentSessionOutcome({
            tenantDbName: ctx.tenantDbName,
            tenantId: ctx.tenantId,
            projectId: ctx.projectId,
            session: sessionDoc,
            previousOutcome: existing?.metricsOutcome,
            source: 'tracing',
            events: createdEvents,
            pricerLoader,
          });
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
};
