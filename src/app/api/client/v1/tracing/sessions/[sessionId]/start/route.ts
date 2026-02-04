import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';

export const runtime = 'nodejs';

/**
 * POST /api/client/v1/tracing/sessions/:sessionId/start
 * 
 * Start a streaming tracing session. Creates the session record with in_progress status.
 * Events will be sent separately via the /events endpoint.
 */
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ sessionId: string }> }
) {
    try {
        const { sessionId } = await params;
        const auth = await requireApiToken(request);
        const db = await getDatabase();
        await db.switchToTenant(auth.tenantDbName);

        const payload = await request.json();

        if (!sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
        }

        const tokenId = auth.tokenRecord._id?.toString() ?? auth.token;
        const resourceKey = payload?.agent?.name || sessionId;
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

        // Check if session already exists
        const existing = await db.findAgentTracingSessionById(sessionId, auth.projectId);

        // Check agent limit
        const agentName = typeof payload?.agent?.name === 'string' ? payload.agent.name.trim() : '';
        if (agentName && !existing) {
            const alreadyExists = await db.agentTracingAgentExists(agentName, auth.projectId);
            if (!alreadyExists) {
                // We need to check the limit - get policies
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
        }

        const now = new Date();
        const startedAt = payload.startedAt ? new Date(payload.startedAt) : now;

        const sessionDoc = {
            sessionId,
            tenantId: auth.tenantId,
            projectId: auth.projectId,
            agent: payload.agent || {},
            agentName: payload.agent?.name || null,
            agentVersion: payload.agent?.version || null,
            agentModel: payload.agent?.model || null,
            config: payload.config || {},
            summary: {
                totalDurationMs: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCachedInputTokens: 0,
                totalBytesIn: 0,
                totalBytesOut: 0,
                eventCounts: {},
            },
            status: 'in_progress',
            startedAt,
            endedAt: undefined,
            durationMs: undefined,
            errors: [],
            modelsUsed: payload.agent?.model ? [payload.agent.model] : [],
            toolsUsed: [],
            eventCounts: {},
            totalEvents: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedInputTokens: 0,
            totalBytesIn: undefined,
            totalBytesOut: undefined,
        };

        if (existing) {
            // Session already started, update it
            await db.updateAgentTracingSession(sessionId, sessionDoc, auth.projectId);
        } else {
            await db.createAgentTracingSession(sessionDoc);
        }

        return NextResponse.json({
            success: true,
            sessionId,
            status: 'in_progress',
        });
    } catch (error: unknown) {
        console.error('Tracing session start error:', error);

        if (error instanceof ApiTokenAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }

        const message =
            error instanceof Error ? error.message : 'Failed to start tracing session';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
