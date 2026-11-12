import type { FastifyInstance } from 'fastify';
import type {
  IAgentTracingEvent,
  IAgentTracingSession,
} from '@/lib/database/provider/types.base';
import { fireAndForget } from '@/lib/core/asyncTask';
import { runWithTenantScope } from '@/lib/database';
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
  isTerminalSessionStatus,
  recordAgentSessionOutcome,
  recordTraceEventMetrics,
} from '@/lib/services/tracing/traceEntityMetrics';
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

import type { TracingSessionPayload, TracingStreamEventPayload, TracingStreamEndPayload } from './payloadTypes';
import { toErrorRecord, toErrorList, getSummaryRecord, getSummaryEventCounts, getSummaryNumber } from './recordCoerce';
import { countNonSinkErrors, maxTotal, mergeUnique, dedupeErrors } from './eventAggregation';
import { getTracingQuotaContext } from './quota';
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

export const registerStreamRoutes = (app: FastifyInstance): void => {
  app.post('/client/v1/tracing/sessions/stream/:sessionId/start', withClientApiRequestContext(async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      if (!sessionId) {
        return reply.code(400).send({ error: 'sessionId is required' });
      }

      const ctx = await getApiTokenContextForRequest(request);
      return await runWithTenantScope(ctx.tenantDbName, async (db) => {
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
          // Error counters start at zero for a NEW session only: a re-started id (`reopenDoc` below) keeps what its earlier legs counted.
          errorEvents: 0,
          toolErrors: 0,
          aiErrors: 0,
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
          // The run is open again: an earlier leg's client end status no longer describes it.
          statusExplicit: false,
          ...(sessionDoc.threadId ? { threadId: sessionDoc.threadId } : {}),
          ...(sessionDoc.traceId ? { traceId: sessionDoc.traceId } : {}),
          ...(sessionDoc.rootSpanId ? { rootSpanId: sessionDoc.rootSpanId } : {}),
        };

        fireAndForget('client-tracing-stream-start', async () => {
          await runWithTenantScope(ctx.tenantDbName, async (backgroundDb) => {
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
        });

        return reply.code(200).send({
          sessionId,
          status: 'in_progress',
          success: true,
        });
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
      return await runWithTenantScope(ctx.tenantDbName, async (db) => {
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
        const diagnostics = extractTraceDiagnostics(event);
        // Normalized (inclusive) usage feeds the event doc AND the session
        // accumulator, so accumulated totals stay in the canonical basis.
        const normalized = resolveTraceEventUsage(event);
        const { inputTokens, outputTokens, cachedInputTokens, cachedWriteTokens } = normalized;
        const newTotalEvents = (session.totalEvents || 0) + 1;
        const models = [event?.model, event?.modelName, event?.metadata?.modelName]
          .filter((name): name is string => typeof name === 'string' && name.length > 0);

        fireAndForget('client-tracing-stream-event', async () => {
          await runWithTenantScope(ctx.tenantDbName, async (backgroundDb) => {
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
              totalTokens: normalized.totalTokens,
              traceId: typeof event.traceId === 'string' ? event.traceId : undefined,
              type: event.type ?? undefined,
            };

            await backgroundDb.createAgentTracingEvent(eventDoc);

            const pricerLoader = createTraceModelPricerLoader(ctx.tenantDbName, ctx.projectId, ctx.tenantId);
            await recordTraceModelUsage({
              tenantDbName: ctx.tenantDbName,
              tenantId: ctx.tenantId,
              projectId: ctx.projectId,
              agentName: session.agentName,
              metadata: session.metadata,
              events: [eventDoc],
              pricerLoader,
            });
            await recordTraceEventMetrics({
              tenantDbName: ctx.tenantDbName,
              tenantId: ctx.tenantId,
              projectId: ctx.projectId,
              agentName: session.agentName,
              events: [eventDoc],
              source: 'tracing',
              pricerLoader,
            });

            const errorCounts = countTraceErrors([eventDoc]);
            await backgroundDb.applyAgentTracingSessionEvent(sessionId, {
              aiErrors: errorCounts.aiErrors,
              cachedInputTokens,
              durationMs: event.durationMs ?? undefined,
              errorEvents: errorCounts.errorEvents,
              eventType: event.type ?? undefined,
              finishReason: diagnostics.finishReason,
              inputTokens,
              modelsUsed: models,
              outputTokens,
              reasoningTokens: diagnostics.reasoningTokens,
              toolErrors: errorCounts.toolErrors,
              toolsUsed: collectEventToolNames(event),
            }, ctx.projectId);

            // An error that lands after the session finished flips it to 'error' in the database; book the
            // difference. No `metricsOutcome` precondition: /end may still be pricing the session (it has not
            // persisted its marker yet), and the SDK does not wait for /events. The outcome bookkeeping runs
            // under a per-session lock, re-reads the stored status and marker, and is idempotent, so this call
            // either waits for /end's booking and corrects it, or books the (already flipped) status itself.
            if (errorCounts.errorEvents > 0) {
              const after = await backgroundDb.findAgentTracingSessionById(sessionId, ctx.projectId);
              if (after && isTerminalSessionStatus(after.status)) {
                await recordAgentSessionOutcome({
                  tenantDbName: ctx.tenantDbName,
                  tenantId: ctx.tenantId,
                  projectId: ctx.projectId,
                  session: after,
                  previousOutcome: after.metricsOutcome,
                  source: 'tracing',
                  pricerLoader,
                });
              }
            }
          });
        });

        return reply.code(200).send({
          eventId: event.id,
          sessionId,
          success: true,
          totalEvents: newTotalEvents,
        });
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
      return await runWithTenantScope(ctx.tenantDbName, async (db) => {
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
        const sessionStartedAt = session.startedAt
          ? new Date(session.startedAt).getTime()
          : endedAt.getTime();
        const durationMs = payload.durationMs ?? (endedAt.getTime() - sessionStartedAt);
        // Built from a session snapshot: once for the reply, and again from a fresh read inside the background write,
        // so events persisted since the request (the SDK does not wait for `/events` before `/end`) are not overwritten.
        // Token totals: the SDK's summary is native-basis, while the totals accumulated by `/events` are
        // inclusive (normalized at ingest) and therefore >= the native ones, so `maxTotal` keeps the inclusive value.
        const mergeEnd = (source: IAgentTracingSession) => {
          const existingSummary = getSummaryRecord(source.summary);
          const payloadSummary = getSummaryRecord(payload.summary);
          const payloadEventCounts = getSummaryEventCounts(payload.summary);
          const existingEventCounts = getSummaryEventCounts(source.summary);
          const mergedSummary: Record<string, unknown> = {
            ...existingSummary,
            ...payloadSummary,
            eventCounts: Object.keys(payloadEventCounts).length > 0
              ? payloadEventCounts
              : (Object.keys(existingEventCounts).length > 0
                ? existingEventCounts
                : (source.eventCounts || {})),
            // `end` used to let the payload win outright. A session that spans several
            // SDK legs sends one `end` per leg carrying only that leg's summary, so the
            // last leg's numbers replaced the run's. Take the larger of what the session
            // already accumulated (from `/events`) and what this leg reports: totals can
            // only ever grow, which also makes a retried `end` idempotent.
            totalBytesIn: maxTotal(payload.summary, source.summary, source.totalBytesIn, 'totalBytesIn'),
            totalBytesOut: maxTotal(payload.summary, source.summary, source.totalBytesOut, 'totalBytesOut'),
            totalCachedInputTokens: maxTotal(
              payload.summary,
              source.summary,
              source.totalCachedInputTokens,
              'totalCachedInputTokens',
            ),
            // Monotonic like the token totals: one `end` per leg means the payload
            // only ever describes that leg's wall clock, so letting it win shrank a
            // multi-leg run's duration to its last leg.
            totalDurationMs: Math.max(
              maxTotal(payload.summary, source.summary, undefined, 'totalDurationMs'),
              durationMs,
            ),
            totalInputTokens: maxTotal(payload.summary, source.summary, source.totalInputTokens, 'totalInputTokens'),
            totalOutputTokens: maxTotal(payload.summary, source.summary, source.totalOutputTokens, 'totalOutputTokens'),
          };
          // A retried `end` resends the same errors. Appending blindly meant each
          // retry grew the list, so deduplicate on the serialized entry.
          const mergedErrors = dedupeErrors([
            ...(source.errors || []),
            ...toErrorList(payload.errors),
          ]);
          // The client's status wins when it sends one; otherwise the session's own error counters decide.
          const status = deriveSessionStatus({
            clientStatus: payload.status,
            errorEvents: source.errorEvents ?? 0,
            nonSinkErrors: countNonSinkErrors(mergedErrors),
            ended: true,
          });
          // Remembered with the status: a late error event flips a derived status but never a client-supplied one.
          const statusExplicit = isExplicitClientStatus(payload.status);
          return { mergedSummary, mergedErrors, status, statusExplicit };
        };
        const { status } = mergeEnd(session);

        fireAndForget('client-tracing-stream-end', async () => {
          await runWithTenantScope(ctx.tenantDbName, async (backgroundDb) => {
            const fresh = (await backgroundDb.findAgentTracingSessionById(sessionId, ctx.projectId)) ?? session;
            const merged = mergeEnd(fresh);
            const updated = await backgroundDb.updateAgentTracingSession(sessionId, {
              durationMs,
              endedAt,
              errors: merged.mergedErrors,
              status: merged.status,
              statusExplicit: merged.statusExplicit,
              summary: merged.mergedSummary,
              totalBytesIn: getSummaryNumber(merged.mergedSummary, 'totalBytesIn'),
              totalBytesOut: getSummaryNumber(merged.mergedSummary, 'totalBytesOut'),
              totalCachedInputTokens: getSummaryNumber(merged.mergedSummary, 'totalCachedInputTokens'),
              totalInputTokens: getSummaryNumber(merged.mergedSummary, 'totalInputTokens'),
              totalOutputTokens: getSummaryNumber(merged.mergedSummary, 'totalOutputTokens'),
            }, ctx.projectId);

            if (updated && isTerminalSessionStatus(updated.status)) {
              await recordAgentSessionOutcome({
                tenantDbName: ctx.tenantDbName,
                tenantId: ctx.tenantId,
                projectId: ctx.projectId,
                session: updated,
                previousOutcome: fresh.metricsOutcome,
                source: 'tracing',
              });
            }
          });
        });

        return reply.code(200).send({
          durationMs,
          sessionId,
          status,
          success: true,
          totalEvents: session.totalEvents || 0,
        });
      });
    } catch (error) {
      logger.error('Client tracing session end error', { error });
      return reply.code(500).send({
        error: error instanceof Error ? error.message : 'Failed to end tracing session',
      });
    }
  }));
};
