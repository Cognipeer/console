import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

/**
 * POST /api/client/tracing/sessions
 * Ingest agent tracing session data from SDK or HTTP client
 * Requires API token authentication
 */
export async function POST(request: NextRequest) {
    try {
        // Get API token from header
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return NextResponse.json({ error: 'Missing or invalid authorization header' }, { status: 401 });
        }

        const token = authHeader.substring(7);

        // Validate token and get tenant
        const db = await getDatabase();
        const apiToken = await db.findApiTokenByToken(token);

        if (!apiToken) {
            return NextResponse.json({ error: 'Invalid API token' }, { status: 401 });
        }

        // Update token last used
        await db.updateTokenLastUsed(token);

        // Parse request body
        const payload = await request.json();

        if (!payload?.sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
        }

        // Switch to tenant database
        const tenant = await db.findTenantById(apiToken.tenantId);
        if (!tenant) {
            return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
        }

        await db.switchToTenant(tenant.dbName);

        // Extract models and tools
        const events = payload.events || [];
        const modelsUsed = new Set<string>();
        const toolsUsed = new Set<string>();

        // Extract models from events
        events.forEach((event: any) => {
            if (event?.model) modelsUsed.add(event.model);
            if (event?.modelName) modelsUsed.add(event.modelName);
            if (event?.metadata?.modelName) modelsUsed.add(event.metadata.modelName);

            // Extract tool names
            if (event?.toolName) toolsUsed.add(event.toolName);
            if (event?.actor?.scope === 'tool' && event?.actor?.name) {
                toolsUsed.add(event.actor.name);
            }
        });

        // Add agent model if present
        if (payload?.agent?.model) {
            modelsUsed.add(payload.agent.model);
        }

        // Calculate totals
        const totalEvents = events.length;
        const totalInputTokens = payload.summary?.totalInputTokens || 0;
    const totalOutputTokens = payload.summary?.totalOutputTokens || 0;
    const totalCachedInputTokens = payload.summary?.totalCachedInputTokens || 0;

        // Prepare session document
        const sessionDoc = {
            sessionId: payload.sessionId,
            tenantId: apiToken.tenantId,
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

        // Check if session exists
        const existing = await db.findAgentTracingSessionById(payload.sessionId);

        let storedSession;
        if (existing) {
            // Update existing session
            storedSession = await db.updateAgentTracingSession(payload.sessionId, sessionDoc);
        } else {
            // Create new session
            storedSession = await db.createAgentTracingSession(sessionDoc);
        }

        // Replace events to keep payload in sync with stored data
        await db.deleteAgentTracingEvents(payload.sessionId);

        if (events.length > 0) {
            for (const event of events) {
                const sections = Array.isArray(event?.sections)
                    ? event.sections
                    : Array.isArray(event?.data?.sections)
                        ? event.data.sections
                        : [];

                const usage = event?.usage || event?.metadata?.usage || {};

                const inputTokens = event?.inputTokens
                    ?? usage?.inputTokens
                    ?? usage?.input_tokens
                    ?? null;

                const outputTokens = event?.outputTokens
                    ?? usage?.outputTokens
                    ?? usage?.output_tokens
                    ?? null;

                const cachedInputTokens = event?.cachedInputTokens
                    ?? usage?.cachedInputTokens
                    ?? usage?.cached_input_tokens
                    ?? usage?.cacheReadInputTokens
                    ?? usage?.cache_read_input_tokens
                    ?? null;

                await db.createAgentTracingEvent({
                    sessionId: payload.sessionId,
                    tenantId: apiToken.tenantId,
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
                    toolName: event.toolName || (event.actor?.scope === 'tool' ? event.actor?.name : null),
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
            eventsStored: events.length
        });

    } catch (error: any) {
        console.error('Tracing ingest error:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to ingest tracing data' },
            { status: 500 }
        );
    }
}
