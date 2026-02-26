import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { checkRateLimit, checkPerRequestLimits } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-tracing');

export const runtime = 'nodejs';

/**
 * POST /api/client/v1/tracing/sessions/:sessionId/events
 * 
 * Add a single event to an existing streaming session.
 * The session must have been started via /start endpoint.
 */
const _POST = async (
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) => {
    try {
        const { sessionId } = await params;
        const auth = await requireApiToken(request);
        const db = await getDatabase();
        await db.switchToTenant(auth.tenantDbName);

        const payload = await request.json();
        const event = payload.event;

        if (!sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
        }

        if (!event) {
            return NextResponse.json({ error: 'event is required' }, { status: 400 });
        }

        // Check if session exists
        const session = await db.findAgentTracingSessionById(sessionId, auth.projectId);
        if (!session) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }

        const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
        const resourceKey = session.agentName || sessionId;
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

        const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
        if (!rateLimitResult.allowed) {
            return NextResponse.json(
                { error: rateLimitResult.reason || 'Rate limit exceeded' },
                { status: 429 },
            );
        }

        // Check per-request limits
        const quotaResult = await checkPerRequestLimits(quotaContext, {
            eventsPerSession: (session.totalEvents || 0) + 1,
        });
        if (!quotaResult.allowed) {
            return NextResponse.json(
                { error: quotaResult.reason || 'Event quota exceeded' },
                { status: 429 },
            );
        }

        // Extract sections
        const sections = Array.isArray(event?.sections)
            ? event.sections
            : Array.isArray(event?.data?.sections)
                ? event.data.sections
                : [];

        // Extract usage
        const usage = event?.usage || event?.metadata?.usage || {};
        const inputTokens =
            event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens ?? undefined;
        const outputTokens =
            event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens ?? undefined;
        const cachedInputTokens =
            event?.cachedInputTokens ??
            usage?.cachedInputTokens ??
            usage?.cached_input_tokens ??
            usage?.cacheReadInputTokens ??
            usage?.cache_read_input_tokens ??
            undefined;

        // Compute summary updates synchronously for the response
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

        const summary = { ...(session.summary || {}) };
        summary.totalInputTokens = newInputTokens;
        summary.totalOutputTokens = newOutputTokens;
        summary.totalCachedInputTokens = newCachedTokens;
        summary.eventCounts = eventCounts;
        if (event.durationMs) {
            summary.totalDurationMs = (summary.totalDurationMs || 0) + event.durationMs;
        }

        // Fire-and-forget: persist event + session update in background
        fireAndForget('tracing-stream-event', async () => {
            const bgDb = await getDatabase();
            await bgDb.switchToTenant(auth.tenantDbName);

            await bgDb.createAgentTracingEvent({
                sessionId,
                tenantId: auth.tenantId,
                projectId: auth.projectId,
                id: event.id || null,
                type: event.type || null,
                label: event.label || null,
                sequence: event.sequence || 0,
                timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
                status: event.status || null,
                actor: event.actor || {},
                metadata: event.metadata || {},
                sections,
                modelNames: event.modelNames || [],
                model: event.model || null,
                error: event.error || null,
                durationMs: event.durationMs,
                actorName: event.actor?.name || null,
                actorRole: event.actor?.role || event.actor?.scope || null,
                toolName:
                    event.toolName ||
                    (event.actor?.scope === 'tool' ? event.actor?.name : null),
                toolExecutionId: event.toolExecutionId || null,
                inputTokens,
                outputTokens,
                cachedInputTokens,
                totalTokens: event.totalTokens,
                bytesIn: event.bytesIn,
                bytesOut: event.bytesOut,
                requestBytes: event.requestBytes,
                responseBytes: event.responseBytes,
            });

            await bgDb.updateAgentTracingSession(sessionId, {
                totalEvents: newTotalEvents,
                totalInputTokens: newInputTokens,
                totalOutputTokens: newOutputTokens,
                totalCachedInputTokens: newCachedTokens,
                modelsUsed: Array.from(modelsUsed),
                toolsUsed: Array.from(toolsUsed),
                eventCounts,
                summary,
            }, auth.projectId);
        });

        return NextResponse.json({
            success: true,
            sessionId,
            eventId: event.id,
            totalEvents: newTotalEvents,
        });
    } catch (error: unknown) {
        logger.error('Tracing event ingest error', { error });

        if (error instanceof ApiTokenAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }

        const message =
            error instanceof Error ? error.message : 'Failed to ingest tracing event';
        return NextResponse.json({ error: message }, { status: 500 });
    }
};

export const POST = withRequestContext(_POST);
