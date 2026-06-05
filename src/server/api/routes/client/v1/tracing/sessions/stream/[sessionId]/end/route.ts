import { NextResponse, type NextRequest } from '@/server/api/http';
import { getDatabase } from '@/lib/database';
import type { LicenseType } from '@/lib/license/license-manager';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import { checkRateLimit } from '@/lib/quota/quotaGuard';
import { createLogger } from '@/lib/core/logger';
import { fireAndForget } from '@/lib/core/asyncTask';
import { withRequestContext } from '@/lib/api/withRequestContext';

const logger = createLogger('client-tracing');

/**
 * POST /api/client/v1/tracing/sessions/:sessionId/end
 * 
 * End a streaming tracing session. Updates the session with final status,
 * summary, and errors.
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

        if (!sessionId) {
            return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
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

        const endedAt = payload.endedAt ? new Date(payload.endedAt) : new Date();
        const status = payload.status || 'success';
        const sessionStartedAt = session.startedAt ? new Date(session.startedAt).getTime() : endedAt.getTime();
        const durationMs = payload.durationMs ?? (endedAt.getTime() - sessionStartedAt);

        // Merge summary from payload with existing session summary
        const existingSummary = session.summary || {};
        const payloadSummary = payload.summary || {};
        
        const mergedSummary = {
            totalDurationMs: payloadSummary.totalDurationMs ?? existingSummary.totalDurationMs ?? durationMs,
            totalInputTokens: payloadSummary.totalInputTokens ?? existingSummary.totalInputTokens ?? session.totalInputTokens ?? 0,
            totalOutputTokens: payloadSummary.totalOutputTokens ?? existingSummary.totalOutputTokens ?? session.totalOutputTokens ?? 0,
            totalCachedInputTokens: payloadSummary.totalCachedInputTokens ?? existingSummary.totalCachedInputTokens ?? session.totalCachedInputTokens ?? 0,
            totalBytesIn: payloadSummary.totalBytesIn ?? existingSummary.totalBytesIn ?? session.totalBytesIn ?? 0,
            totalBytesOut: payloadSummary.totalBytesOut ?? existingSummary.totalBytesOut ?? session.totalBytesOut ?? 0,
            eventCounts: payloadSummary.eventCounts ?? existingSummary.eventCounts ?? session.eventCounts ?? {},
        };

        // Merge errors
        const existingErrors = session.errors || [];
        const payloadErrors = payload.errors || [];
        const mergedErrors = [...existingErrors, ...payloadErrors];

        // Fire-and-forget: persist final session state in background
        fireAndForget('tracing-stream-end', async () => {
            const bgDb = await getDatabase();
            await bgDb.switchToTenant(auth.tenantDbName);
            await bgDb.updateAgentTracingSession(sessionId, {
                status,
                endedAt,
                durationMs,
                summary: mergedSummary,
                errors: mergedErrors,
                totalInputTokens: mergedSummary.totalInputTokens,
                totalOutputTokens: mergedSummary.totalOutputTokens,
                totalCachedInputTokens: mergedSummary.totalCachedInputTokens,
                totalBytesIn: mergedSummary.totalBytesIn,
                totalBytesOut: mergedSummary.totalBytesOut,
            }, auth.projectId);
        });

        return NextResponse.json({
            success: true,
            sessionId,
            status,
            durationMs,
            totalEvents: session.totalEvents || 0,
        });
    } catch (error: unknown) {
        logger.error('Tracing session end error', { error });

        if (error instanceof ApiTokenAuthError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
        }

        const message =
            error instanceof Error ? error.message : 'Failed to end tracing session';
        return NextResponse.json({ error: message }, { status: 500 });
    }
};

export const POST = withRequestContext(_POST);
