/**
 * Closes the trace session of a paused run that will never resume.
 *
 * A run that pauses for a tool approval, a question or a client tool leaves
 * its trace session `paused` (agent-sdk ≥ 0.14) and hands the resumed invoke a
 * continuation, so the answer and the rest of the turn land in the same
 * session. When the wait ends without a resume — a new message cancels it, the
 * user stops the turn, the request times out under `onTimeout: cancel` — no
 * invoke will ever finish that session. This appends the step that ended it
 * and gives the session a final status, so it does not read "paused" forever.
 */

import type { DatabaseProvider, IAgentPendingAction } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('pausedTraceClosure');

export type PausedTraceDb = Pick<
    DatabaseProvider,
    'findAgentTracingSessionById' | 'updateAgentTracingSession' | 'createAgentTracingEvent'
>;

export interface PausedTraceClosure {
    outcome: 'cancelled' | 'expired';
    /** Who or what ended the wait (`user:…`, `system:timeout`, …). */
    resolvedBy?: string;
    /** The pending actions the run was waiting on. */
    actions: IAgentPendingAction[];
}

interface ContinuationRef {
    sessionId: string;
    nextSequence: number;
    traceId?: string;
    rootSpanId?: string;
}

function readContinuation(ctx: unknown): ContinuationRef | undefined {
    const raw = (ctx as { __traceContinuation?: Record<string, unknown> } | undefined)?.__traceContinuation;
    if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string') return undefined;
    const nextSequence = Number(raw.nextSequence);
    if (!Number.isInteger(nextSequence) || nextSequence < 1) return undefined;
    return {
        sessionId: raw.sessionId,
        nextSequence,
        traceId: typeof raw.traceId === 'string' ? raw.traceId : undefined,
        rootSpanId: typeof raw.rootSpanId === 'string' ? raw.rootSpanId : undefined,
    };
}

const EVENT_TYPE: Record<string, string> = {
    tool_approval: 'tool_approval',
    user_question: 'user_question',
    client_tool: 'tool_call',
};

function stepLabel(action: IAgentPendingAction, outcome: PausedTraceClosure['outcome']): string {
    const verb = outcome === 'expired' ? 'Expired' : 'Cancelled';
    if (action.kind === 'user_question') return `Question ${verb.toLowerCase()}`;
    if (action.kind === 'client_tool') return `Tool Execution - ${action.toolName ?? 'tool'} (client) ${verb.toLowerCase()}`;
    return `${verb} · ${action.toolName ?? 'tool'}`;
}

export async function closePausedTrace(
    db: PausedTraceDb,
    input: { projectId: string; tenantId: string; pausedCtx: unknown; closure: PausedTraceClosure },
): Promise<void> {
    const continuation = readContinuation(input.pausedCtx);
    if (!continuation) return;
    try {
        const session = await db.findAgentTracingSessionById(continuation.sessionId, input.projectId);
        // Only a session still waiting: a resume that raced this one finished it.
        if (!session || session.status !== 'paused') return;

        const now = new Date();
        const eventCounts = { ...((session.eventCounts as Record<string, number> | undefined) ?? {}) };
        let sequence = continuation.nextSequence;
        for (const action of input.closure.actions) {
            const type = EVENT_TYPE[action.kind] ?? 'tool_approval';
            const requestedAt = action.requestedAt ? new Date(action.requestedAt) : undefined;
            await db.createAgentTracingEvent({
                sessionId: continuation.sessionId,
                traceId: continuation.traceId,
                parentSpanId: continuation.rootSpanId,
                tenantId: input.tenantId,
                projectId: input.projectId,
                id: `evt_${String(sequence).padStart(4, '0')}_closed`,
                type,
                label: `${stepLabel(action, input.closure.outcome)} #${sequence}`,
                sequence,
                timestamp: now,
                status: 'skipped',
                actor: { scope: 'system', name: input.closure.resolvedBy ?? 'system', role: 'approver' },
                metadata: {},
                sections: [{
                    kind: 'metadata',
                    label: 'Decision',
                    data: {
                        ...(action.kind === 'tool_approval' ? { approvalId: action.sdkId } : { questionId: action.sdkId }),
                        toolCallId: action.toolCallId,
                        decision: input.closure.outcome,
                        ...(input.closure.resolvedBy ? { decidedBy: input.closure.resolvedBy } : {}),
                        ...(requestedAt ? { requestedAt: requestedAt.toISOString(), waitedMs: Math.max(0, now.getTime() - requestedAt.getTime()) } : {}),
                        decidedAt: now.toISOString(),
                    },
                }],
                toolName: action.kind === 'client_tool' ? action.toolName : undefined,
                durationMs: requestedAt ? Math.max(0, now.getTime() - requestedAt.getTime()) : undefined,
            });
            eventCounts[type] = (eventCounts[type] ?? 0) + 1;
            sequence += 1;
        }

        const startedAt = session.startedAt ? new Date(session.startedAt) : undefined;
        await db.updateAgentTracingSession(continuation.sessionId, {
            status: input.closure.outcome,
            endedAt: now,
            ...(startedAt ? { durationMs: now.getTime() - startedAt.getTime() } : {}),
            eventCounts,
            totalEvents: (session.totalEvents ?? 0) + input.closure.actions.length,
        }, input.projectId);
    } catch (error) {
        logger.warn('Could not close the trace of a paused run', {
            sessionId: continuation.sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
