/**
 * Message feedback: a person's thumbs up / down on an assistant message, with the
 * reasons and an optional comment.
 *
 * What it keeps (`agent_message_feedback`): one rating per person per message,
 * replaceable, withdrawn by rating `null`. What it tells the rest of the console
 * when a rating is recorded: a `feedback.recorded` webhook event (ids and small
 * fields only — never the comment), a `feedback` event on the tracing session of
 * the turn that wrote the message (so Studio's trace shows it), and an audit
 * entry. Studio reads the ratings back per session and per agent
 * ({@link listAgentFeedback}, {@link summarizeAgentFeedback}).
 *
 * A message is addressed by its stable id — derived from the conversation, its
 * place in the transcript and its timestamp ({@link messageIdOf}), so nothing has
 * to be written into the transcript to rate a message and a running turn is
 * never disturbed — or by its index.
 */

import { createHash, randomBytes } from 'node:crypto';
import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type {
    AgentFeedbackRating,
    AgentFeedbackReason,
    AgentMessageFeedbackFilter,
    AgentMessageFeedbackTotals,
    DatabaseProvider,
    IAgentConversation,
    IAgentMessageFeedback,
} from '@/lib/database';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';
import { recordAuditLog } from '@/lib/services/audit/auditService';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { runWithTenantDb } from './agentRunService';

const logger = createLogger('agents:feedback');

export const FEEDBACK_REASONS: readonly AgentFeedbackReason[] = ['inaccurate', 'incomplete', 'off_topic', 'too_long', 'unsafe', 'other'];
export const FEEDBACK_COMMENT_MAX = 1000;

export type FeedbackErrorCode =
    | 'session_not_found'
    | 'message_not_found'
    | 'not_an_answer'
    | 'invalid_rating'
    | 'invalid_reasons'
    | 'invalid_comment'
    | 'comment_too_long'
    | 'comments_disabled'
    | 'feedback_disabled';

/** A rating the session cannot take; `status` is the HTTP status a route answers with. */
export class FeedbackError extends Error {
    readonly status: number;
    readonly code: FeedbackErrorCode;

    constructor(status: number, code: FeedbackErrorCode, message: string) {
        super(message);
        this.name = 'FeedbackError';
        this.status = status;
        this.code = code;
    }
}

/**
 * The stable id of the message at `index`. An explicit `id` on the message wins;
 * otherwise it is derived from where and when the message was written — the same
 * for every reader, and different for a message that replaces it after a
 * regenerate (new timestamp).
 */
export function messageIdOf(conversationId: string, index: number, message: Pick<IAgentConversationMessage, 'id' | 'timestamp'> | undefined): string {
    if (message?.id) return message.id;
    const ms = message?.timestamp ? new Date(message.timestamp as unknown as string | Date).getTime() : 0;
    const digest = createHash('sha256').update(`${conversationId}|${index}|${Number.isFinite(ms) ? ms : 0}`).digest('hex').slice(0, 20);
    return `msg_${digest}`;
}

export type MessageRef = { id?: string; index?: number };

/** Finds the message a reference names: its index, id and the message itself. */
export function resolveMessageRef(
    conversation: Pick<IAgentConversation, '_id' | 'messages'>,
    ref: MessageRef,
): { index: number; id: string; message: IAgentConversationMessage } | null {
    const messages = conversation.messages ?? [];
    const conversationId = String(conversation._id);
    if (ref.id) {
        for (let index = 0; index < messages.length; index += 1) {
            if (messageIdOf(conversationId, index, messages[index]) === ref.id) {
                return { index, id: ref.id, message: messages[index] };
            }
        }
        return null;
    }
    if (ref.index !== undefined && Number.isInteger(ref.index) && ref.index >= 0 && ref.index < messages.length) {
        return { index: ref.index, id: messageIdOf(conversationId, ref.index, messages[ref.index]), message: messages[ref.index] };
    }
    return null;
}

// ── Reading what a person sent ──────────────────────────────────────────

/** Reasons from a request body: a list of known reasons, deduplicated. */
export function normalizeReasons(value: unknown): AgentFeedbackReason[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new FeedbackError(400, 'invalid_reasons', '`reasons` must be a list');
    const out: AgentFeedbackReason[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string' || !(FEEDBACK_REASONS as readonly string[]).includes(entry)) {
            throw new FeedbackError(400, 'invalid_reasons', `Unknown reason. Use one of: ${FEEDBACK_REASONS.join(', ')}`);
        }
        if (!out.includes(entry as AgentFeedbackReason)) out.push(entry as AgentFeedbackReason);
    }
    return out;
}

/** A comment from a request body: trimmed text without control characters, or undefined. */
export function normalizeComment(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new FeedbackError(400, 'invalid_comment', '`comment` must be text');
    const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (text.length > FEEDBACK_COMMENT_MAX) {
        throw new FeedbackError(400, 'comment_too_long', `The comment can be at most ${FEEDBACK_COMMENT_MAX} characters.`);
    }
    return text || undefined;
}

// ── Recording ─────────────────────────────────────────────────────────

export interface RecordFeedbackInput {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    conversationId: string;
    /** When set, the session must belong to this agent. */
    agentKey?: string;
    message: MessageRef;
    userId: string;
    email?: string;
    /** Where the rating comes from: `portal`, `embed`, `dashboard`, `api`… */
    channel: string;
    portalId?: string;
    /** `null` withdraws the person's rating. */
    rating: AgentFeedbackRating | null;
    reasons?: unknown;
    comment?: unknown;
    /** A surface that turned comments off (`experience.feedback.comments: false`) refuses one. Default true. */
    commentsAllowed?: boolean;
    audit?: { ipAddress?: string; userAgent?: string; requestId?: string };
}

export interface RecordFeedbackResult {
    /** The stored rating; null when it was withdrawn. */
    feedback: IAgentMessageFeedback | null;
    withdrawn: boolean;
    created: boolean;
    messageId: string;
    messageIndex: number;
}

/** Stores (or withdraws) a person's rating of an assistant message. */
export async function recordMessageFeedback(input: RecordFeedbackInput): Promise<RecordFeedbackResult> {
    if (input.rating !== null && input.rating !== 'up' && input.rating !== 'down') {
        throw new FeedbackError(400, 'invalid_rating', '`rating` must be "up", "down" or null');
    }
    const reasons = input.rating === 'down' ? normalizeReasons(input.reasons) : [];
    if (input.rating === 'up') normalizeReasons(input.reasons); // still refuse nonsense
    const comment = input.rating === null ? undefined : normalizeComment(input.comment);
    if (comment && input.commentsAllowed === false) {
        throw new FeedbackError(400, 'comments_disabled', 'Comments are turned off here.');
    }

    const outcome = await runWithTenantDb(input.tenantDbName, async (db) => {
        const conversation = await db.findAgentConversationById(input.conversationId).catch(() => null);
        if (!conversation || conversation.projectId !== input.projectId
            || (input.agentKey !== undefined && conversation.agentKey !== input.agentKey)) {
            throw new FeedbackError(404, 'session_not_found', 'Session not found.');
        }
        const found = resolveMessageRef(conversation, input.message);
        if (!found) throw new FeedbackError(404, 'message_not_found', 'That message is not in this session.');
        if (found.message.role !== 'assistant') throw new FeedbackError(400, 'not_an_answer', 'Only an answer can be rated.');

        if (input.rating === null) {
            const removed = await db.deleteAgentMessageFeedback(input.conversationId, found.id, input.userId);
            return { conversation, found, stored: null, created: false, removed };
        }
        const { feedback: stored, created } = await db.upsertAgentMessageFeedback({
            tenantId: input.tenantId,
            projectId: input.projectId,
            agentKey: conversation.agentKey,
            agentVersion: found.message.version ?? null,
            conversationId: input.conversationId,
            messageId: found.id,
            messageIndex: found.index,
            userId: input.userId,
            channel: input.channel,
            ...(input.portalId ? { portalId: input.portalId } : {}),
            rating: input.rating,
            reasons,
            ...(comment ? { comment } : {}),
        });
        return { conversation, found, stored, created, removed: false };
    });

    announceFeedback(input, outcome.conversation, outcome.found, outcome.stored, reasons, Boolean(comment));
    return {
        feedback: outcome.stored,
        withdrawn: input.rating === null,
        created: outcome.created,
        messageId: outcome.found.id,
        messageIndex: outcome.found.index,
    };
}

/** What other parts of the console learn from a rating. None of it may fail the rating. */
function announceFeedback(
    input: RecordFeedbackInput,
    conversation: IAgentConversation,
    found: { index: number; id: string; message: IAgentConversationMessage },
    stored: IAgentMessageFeedback | null,
    reasons: AgentFeedbackReason[],
    hasComment: boolean,
): void {
    const rating = input.rating;
    void publishWebhookEvent({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        type: 'feedback.recorded',
        data: {
            conversationId: input.conversationId,
            agentKey: conversation.agentKey,
            messageId: found.id,
            messageIndex: found.index,
            rating,
            reasons,
            hasComment,
            channel: input.channel,
            portalId: input.portalId ?? null,
            ...(rating === null ? { withdrawn: true } : {}),
        },
    }).catch((error) => logger.warn('Feedback webhook not published', { error: String(error) }));

    void recordFeedbackTraceEvent(input, found, rating, reasons, hasComment)
        .catch((error) => logger.warn('Feedback not added to the trace', { conversationId: input.conversationId, error: String(error) }));

    criticalFireAndForget('agent-feedback-audit', () => runWithTenantScope(input.tenantDbName, () => recordAuditLog(
        { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
        {
            projectId: input.projectId,
            action: 'write',
            actorType: 'user',
            actorUserId: input.userId,
            actorEmail: input.email,
            event: rating === null ? 'agent.message.feedback.withdraw' : 'agent.message.feedback',
            ipAddress: input.audit?.ipAddress,
            userAgent: input.audit?.userAgent,
            requestId: input.audit?.requestId,
            outcome: 'success',
            resourceType: 'agent_conversation',
            resourceId: input.conversationId,
            service: 'agents',
            metadata: {
                agentKey: conversation.agentKey,
                messageId: found.id,
                messageIndex: found.index,
                rating,
                reasons,
                hasComment,
                channel: input.channel,
                portalId: input.portalId ?? null,
                feedbackId: stored?._id ? String(stored._id) : null,
            },
        },
    )));
}

const newSpanId = () => randomBytes(8).toString('hex');

/**
 * Adds a `feedback` event to the trace of the turn that wrote the message: the
 * tracing session of the conversation's thread that started last before the
 * message was written. A conversation with no trace (tracing off) gets none.
 */
async function recordFeedbackTraceEvent(
    input: RecordFeedbackInput,
    found: { index: number; id: string; message: IAgentConversationMessage },
    rating: AgentFeedbackRating | null,
    reasons: AgentFeedbackReason[],
    hasComment: boolean,
): Promise<void> {
    await runWithTenantDb(input.tenantDbName, async (db) => {
        const { sessions } = await db.listAgentTracingSessions({ threadId: input.conversationId, limit: 100, includeTotal: false }, input.projectId);
        if (sessions.length === 0) return;
        const wroteAt = found.message.timestamp ? new Date(found.message.timestamp as unknown as string | Date).getTime() : Date.now();
        const startedMs = (session: (typeof sessions)[number]) => new Date(session.startedAt ?? session.createdAt ?? 0).getTime();
        // Newest first: the first one that began before the message was written is its turn.
        const turn = sessions.find((session) => startedMs(session) <= wroteAt + 1000) ?? sessions[sessions.length - 1];
        const data = {
            rating,
            reasons,
            hasComment,
            messageId: found.id,
            messageIndex: found.index,
            channel: input.channel,
            ...(input.portalId ? { portalId: input.portalId } : {}),
        };
        const label = rating === null ? 'Feedback withdrawn' : rating === 'up' ? 'Feedback: helpful' : 'Feedback: not helpful';
        await db.createAgentTracingEvent({
            sessionId: turn.sessionId,
            traceId: turn.traceId,
            spanId: newSpanId(),
            ...(turn.rootSpanId ? { parentSpanId: turn.rootSpanId } : {}),
            tenantId: input.tenantId,
            projectId: input.projectId,
            id: `feedback_${newSpanId()}`,
            type: 'feedback',
            label,
            sequence: (turn.totalEvents ?? 0) + 1,
            timestamp: new Date(),
            status: 'success',
            actor: { scope: 'user', name: 'feedback', role: 'feedback' },
            metadata: data,
            sections: [{ kind: 'metadata', label: 'Feedback', data }],
            modelNames: [],
        });
        await db.applyAgentTracingSessionEvent(turn.sessionId, { eventType: 'feedback' }, input.projectId);
    });
}

// ── Reading ───────────────────────────────────────────────────────────

/** One person's rating as the session view shows it. */
export interface SessionFeedbackView {
    messageId: string;
    messageIndex: number;
    rating: AgentFeedbackRating;
    reasons: AgentFeedbackReason[];
    comment?: string;
    userId: string;
    channel: string;
    portalId?: string;
    removed: boolean;
    createdAt: string;
    updatedAt: string;
}

export function toFeedbackView(row: IAgentMessageFeedback, options: { includeComment: boolean }): SessionFeedbackView {
    return {
        messageId: row.messageId,
        messageIndex: row.messageIndex,
        rating: row.rating,
        reasons: row.reasons ?? [],
        ...(options.includeComment && row.comment ? { comment: row.comment } : {}),
        userId: row.userId,
        channel: row.channel,
        ...(row.portalId ? { portalId: row.portalId } : {}),
        removed: Boolean(row.removedAt),
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
    };
}

/** Every rating of one session. `userId` narrows it to one person's own. */
export async function listSessionFeedback(input: {
    tenantDbName: string;
    projectId: string;
    conversationId: string;
    agentKey?: string;
    userId?: string;
}): Promise<IAgentMessageFeedback[]> {
    return runWithTenantDb(input.tenantDbName, async (db) => {
        const conversation = await db.findAgentConversationById(input.conversationId).catch(() => null);
        if (!conversation || conversation.projectId !== input.projectId
            || (input.agentKey !== undefined && conversation.agentKey !== input.agentKey)) {
            throw new FeedbackError(404, 'session_not_found', 'Session not found.');
        }
        return db.listAgentMessageFeedbackByConversation(input.conversationId, input.userId ? { userId: input.userId } : undefined);
    });
}

export interface AgentFeedbackPage {
    items: IAgentMessageFeedback[];
    total: number;
}

export async function listAgentFeedback(
    tenantDbName: string,
    filter: AgentMessageFeedbackFilter,
    options?: { limit?: number; skip?: number },
): Promise<AgentFeedbackPage> {
    return runWithTenantDb(tenantDbName, (db: DatabaseProvider) => db.listAgentMessageFeedback(filter, options));
}

export interface AgentFeedbackSummary extends AgentMessageFeedbackTotals {
    total: number;
    /** Share of ratings that are thumbs up, 0–1; null with no ratings. */
    positiveRate: number | null;
}

export async function summarizeAgentFeedback(tenantDbName: string, filter: AgentMessageFeedbackFilter): Promise<AgentFeedbackSummary> {
    const totals = await runWithTenantDb(tenantDbName, (db: DatabaseProvider) => db.aggregateAgentMessageFeedback(filter));
    const total = totals.up + totals.down;
    return { ...totals, total, positiveRate: total > 0 ? totals.up / total : null };
}
