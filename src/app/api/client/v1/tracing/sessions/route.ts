import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

export const runtime = 'nodejs';

/** Max request body size in bytes. Default 10 MB, configurable via TRACING_MAX_BODY_SIZE_MB */
const MAX_BODY_SIZE_BYTES = (
    parseInt(process.env.TRACING_MAX_BODY_SIZE_MB || '10', 10) || 10
) * 1024 * 1024;

export async function POST(request: NextRequest) {
    try {
        // Check content-length before parsing body
        const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
        if (contentLength > MAX_BODY_SIZE_BYTES) {
            return NextResponse.json(
                { error: `Payload too large. Max allowed: ${MAX_BODY_SIZE_BYTES} bytes (${Math.round(MAX_BODY_SIZE_BYTES / 1024 / 1024)}MB). Configure via TRACING_MAX_BODY_SIZE_MB env variable.` },
                { status: 413 },
            );
        }

        const auth = await requireApiToken(request);
        const db = await getDatabase();
        await db.switchToTenant(auth.tenantDbName);

        const payload = await request.json();

        if (!payload?.sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
        }

        const events = Array.isArray(payload.events) ? payload.events : [];
        const durationMs =
            typeof payload.durationMs === 'number'
                ? payload.durationMs
                : payload.startedAt && payload.endedAt
                    ? new Date(payload.endedAt).getTime() - new Date(payload.startedAt).getTime()
                    : undefined;

        const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
        const resourceKey = payload?.agent?.name || payload.sessionId;
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
            eventsPerSession: events.length,
            sessionDurationMs: durationMs,
        });

        if (!quotaResult.allowed) {
            return NextResponse.json(
                { error: quotaResult.reason || 'Quota exceeded' },
                { status: 429 },
            );
        }

        const rateLimitResult = await checkRateLimit(quotaContext, { requests: 1 });
        if (!rateLimitResult.allowed) {
            return NextResponse.json(
                { error: rateLimitResult.reason || 'Rate limit exceeded' },
                { status: 429 },
            );
        }

        const retentionDays = quotaResult.effectiveLimits.quotas?.maxTracingRetentionDays;
        if (retentionDays !== undefined && retentionDays !== -1 && retentionDays >= 0) {
            const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);
            await db.cleanupAgentTracingRetention({
                projectId: auth.projectId,
                olderThan: cutoff,
            });
        }

        const modelsUsed = new Set<string>();
        const toolsUsed = new Set<string>();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events.forEach((event: any) => {
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

        const totalEvents = events.length;
        const totalInputTokens = payload.summary?.totalInputTokens || 0;
        const totalOutputTokens = payload.summary?.totalOutputTokens || 0;
        const totalCachedInputTokens = payload.summary?.totalCachedInputTokens || 0;

        const sessionDoc = {
            sessionId: payload.sessionId,
            tenantId: auth.tenantId,
            projectId: auth.projectId,
            agent: payload.agent || {},
            agentName: payload.agent?.name || null,
            agentVersion: payload.agent?.version || null,
            agentModel: payload.agent?.model || null,
            config: payload.config || {},
            summary: payload.summary || {},
            status: payload.status || 'unknown',
            startedAt: payload.startedAt ? new Date(payload.startedAt) : new Date(),
            endedAt: payload.endedAt ? new Date(payload.endedAt) : undefined,
            durationMs: payload.durationMs || null,
            errors: payload.errors || [],
            modelsUsed: Array.from(modelsUsed),
            toolsUsed: Array.from(toolsUsed),
            eventCounts: payload.summary?.eventCounts || {},
            totalEvents,
            totalInputTokens,
            totalOutputTokens,
            totalCachedInputTokens,
            totalBytesIn: payload.summary?.totalBytesIn || null,
            totalBytesOut: payload.summary?.totalBytesOut || null,
        };

        const existing = await db.findAgentTracingSessionById(
            payload.sessionId,
            auth.projectId,
        );

        const agentName = typeof payload?.agent?.name === 'string' ? payload.agent.name.trim() : '';
        const maxAgents = quotaResult.effectiveLimits.quotas?.maxAgents;
        if (maxAgents !== undefined && maxAgents !== -1 && agentName) {
            const alreadyExists = await db.agentTracingAgentExists(agentName, auth.projectId);
            if (!alreadyExists) {
                const currentAgents = await db.countAgentTracingDistinctAgents(auth.projectId);
                if (currentAgents >= maxAgents) {
                    return NextResponse.json(
                        { error: `agents limit reached (${currentAgents}/${maxAgents})` },
                        { status: 429 },
                    );
                }
            }
        }

        if (!existing) {
            const { total } = await db.listAgentTracingSessions({}, auth.projectId);
            const resourceCheck = await checkResourceQuota(
                quotaContext,
                'tracingSessions',
                total,
            );
            if (!resourceCheck.allowed) {
                return NextResponse.json(
                    { error: resourceCheck.reason || 'Tracing session quota exceeded' },
                    { status: 429 },
                );
            }
        }

        if (existing) {
            await db.updateAgentTracingSession(payload.sessionId, sessionDoc, auth.projectId);
        } else {
            await db.createAgentTracingSession(sessionDoc);
        }

        await db.deleteAgentTracingEvents(payload.sessionId, auth.projectId);

        if (events.length > 0) {
            for (const event of events) {
                const sections = Array.isArray(event?.sections)
                    ? event.sections
                    : Array.isArray(event?.data?.sections)
                        ? event.data.sections
                        : [];

                const usage = event?.usage || event?.metadata?.usage || {};

                const inputTokens =
                    event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens ?? null;

                const outputTokens =
                    event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens ?? null;

                const cachedInputTokens =
                    event?.cachedInputTokens ??
                    usage?.cachedInputTokens ??
                    usage?.cached_input_tokens ??
                    usage?.cacheReadInputTokens ??
                    usage?.cache_read_input_tokens ??
                    null;

                await db.createAgentTracingEvent({
                    sessionId: payload.sessionId,
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
                    durationMs: event.durationMs || null,
                    actorName: event.actor?.name || null,
                    actorRole: event.actor?.role || event.actor?.scope || null,
                    toolName:
                        event.toolName ||
                        (event.actor?.scope === 'tool' ? event.actor?.name : null),
                    toolExecutionId: event.toolExecutionId || null,
                    inputTokens,
                    outputTokens,
                    cachedInputTokens,
                    totalTokens: event.totalTokens || null,
                    bytesIn: event.bytesIn || null,
                    bytesOut: event.bytesOut || null,
                    requestBytes: event.requestBytes || null,
                    responseBytes: event.responseBytes || null,
                });
            }
        }

        return NextResponse.json({
            success: true,
            sessionId: payload.sessionId,
            eventsStored: events.length,
        });
    } catch (error: unknown) {
        console.error('Tracing ingest error:', error);

        if (error instanceof ApiTokenAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }

        const message =
            error instanceof Error ? error.message : 'Failed to ingest tracing data';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
