/**
 * Cutting a session's transcript back, and running a message again.
 *
 * Three things a chat surface offers on top of "send a message":
 *  - go back to an earlier point (`truncateSessionAfterMessage`);
 *  - regenerate the last answer: the user message is run again;
 *  - edit a message you sent: everything after it is dropped and the edited
 *    text is run in its place.
 *
 * The runtime's part is the same for all three: the later messages go, any
 * request still open on them is cancelled, the agent's carried state is
 * dropped (the next turn rebuilds it from the transcript — the same fallback a
 * session without state uses), the ratings of the removed messages are marked,
 * and `session.truncated` is written to the event log. A re-run is then an
 * ordinary turn (`executePlaygroundChat`) that appends the user message and
 * its new answer; `rerunSessionTurn` strings the two together and puts the old
 * transcript back if the new turn cannot even start.
 *
 * The caller holds the conversation's run slot (`reserveConversationForSyncTurn`)
 * around all of it, exactly as for a message.
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { DatabaseProvider, IAgentConversation, IAgentMessageVersion } from '@/lib/database';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';
import { recordAuditLog } from '@/lib/services/audit/auditService';
import { cancelPendingForNewMessage } from './agentPendingActions';
import { runWithTenantDb } from './agentRunService';
import { createSessionEventWriter } from './sessionEvents';
import { normalizeStaleRunningStatus } from './sessionRuntime';

const logger = createLogger('agents:session-truncate');

/** How many replaced answers a regenerated message remembers. */
export const MAX_PREVIOUS_VERSIONS = 5;
/** How many file ids a conversation remembers as "already sent" after cutting messages away. */
const MAX_REMEMBERED_FILE_IDS = 500;

export type SessionEditErrorCode =
    | 'session_not_found'
    | 'conversation_busy'
    | 'message_not_found'
    | 'not_latest_answer'
    | 'not_a_user_message'
    | 'not_an_assistant_message'
    | 'empty_message';

/** A cut or a re-run the session cannot take; `status` is the HTTP status a route answers with. */
export class SessionEditError extends Error {
    readonly status: number;
    readonly code: SessionEditErrorCode;

    constructor(status: number, code: SessionEditErrorCode, message: string) {
        super(message);
        this.name = 'SessionEditError';
        this.status = status;
        this.code = code;
    }
}

export interface SessionEditActor {
    userId: string;
    /** Where the request came from: `portal`, `embed`, `dashboard`, `api`… */
    channel: string;
    email?: string;
}

export interface SessionEditScope {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    conversationId: string;
    /** When set, the session must belong to this agent. */
    agentKey?: string;
}

export interface TruncateSessionInput extends SessionEditScope {
    /** The messages up to and including this index stay; -1 removes every message. */
    keepThrough: number;
    actor: SessionEditActor;
    reason?: 'truncate' | 'regenerate' | 'edit';
    audit?: { ipAddress?: string; userAgent?: string; requestId?: string };
    /** Mark the ratings of the removed messages now (default). A re-run defers it until its new turn has run. */
    markFeedback?: boolean;
}

export interface TruncateSessionResult {
    /** The transcript as it stands now. */
    kept: IAgentConversationMessage[];
    /** What was cut away, oldest first. */
    removed: IAgentConversationMessage[];
    /** Open approvals / questions / client tool calls that went with them. */
    cancelledActions: number;
    /** The transcript before the cut — what `rollback` writes back. */
    original: IAgentConversationMessage[];
}

const timestampMs = (value: unknown): number => {
    const ms = value ? new Date(value as string | Date).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
};

async function loadEditableSession(db: DatabaseProvider, scope: SessionEditScope): Promise<IAgentConversation> {
    const found = await db.findAgentConversationById(scope.conversationId).catch(() => null);
    if (!found || found.projectId !== scope.projectId || (scope.agentKey !== undefined && found.agentKey !== scope.agentKey)) {
        throw new SessionEditError(404, 'session_not_found', 'Session not found.');
    }
    const conversation = await normalizeStaleRunningStatus(db, found);
    if (conversation.runtimeStatus === 'running') {
        throw new SessionEditError(409, 'conversation_busy', 'This session is still answering. Wait for it to finish.');
    }
    return conversation;
}

/**
 * Keeps the messages up to and including `keepThrough` and removes the rest.
 * Nothing is removed (and nothing logged) when the transcript already ends there.
 */
export async function truncateSessionAfterMessage(input: TruncateSessionInput): Promise<TruncateSessionResult> {
    return runWithTenantDb(input.tenantDbName, async (db) => {
        const conversation = await loadEditableSession(db, input);
        const original = conversation.messages ?? [];
        if (!Number.isInteger(input.keepThrough) || input.keepThrough < -1 || input.keepThrough >= original.length) {
            throw new SessionEditError(404, 'message_not_found', 'That message is not in this session.');
        }
        const removed = original.slice(input.keepThrough + 1);
        if (removed.length === 0) return { kept: original, removed, cancelledActions: 0, original };

        const conversationId = String(conversation._id);
        const writer = createSessionEventWriter({
            db,
            tenantId: input.tenantId,
            projectId: input.projectId,
            agentKey: conversation.agentKey,
            conversationId,
            tenantDbName: input.tenantDbName,
        });

        // Requests still open on the messages that are going: cancelled with the paused state. A kept
        // message that carried one shows it cancelled.
        let working: IAgentConversation = conversation;
        let cancelledActions = 0;
        if (conversation.runtimeStatus === 'requires_action') {
            const open = await db.listAgentPendingActions(conversationId, { status: 'pending' });
            cancelledActions = open.length;
            working = await cancelPendingForNewMessage(db, conversation, writer.emit, 'system:truncate');
            await db.updateAgentConversationRuntime(conversationId, {
                runtimeStatus: 'idle', stopReason: 'cancelled', pendingActionIds: [],
            });
        }
        const kept = (working.messages ?? []).slice(0, input.keepThrough + 1);

        // Files the removed messages carried were sent to the model; they must not ride along on the next message.
        const sent = new Set<string>(Array.isArray(conversation.metadata?.sentFileIds)
            ? (conversation.metadata.sentFileIds as unknown[]).filter((id): id is string => typeof id === 'string')
            : []);
        for (const message of removed) for (const file of message.attachments ?? []) sent.add(file.fileId);
        const metadata = { ...(conversation.metadata ?? {}), sentFileIds: [...sent].slice(-MAX_REMEMBERED_FILE_IDS) };

        await db.updateAgentConversation(conversationId, { messages: kept, metadata });
        // The carried agent state describes the removed turns; the transcript is the truth now.
        await db.deleteAgentConversationState(conversationId);
        if (input.markFeedback !== false) {
            await db.markAgentMessageFeedbackRemoved(conversationId, input.keepThrough + 1).catch((error) => {
                logger.warn('Could not mark the ratings of the removed messages', { conversationId, error: String(error) });
            });
        }

        writer.emit('session.truncated', {
            reason: input.reason ?? 'truncate',
            keptMessages: kept.length,
            removedMessages: removed.length,
            removedFrom: input.keepThrough + 1,
            cancelledActions,
            by: input.actor.userId,
            channel: input.actor.channel,
        });
        await writer.close();

        auditTruncation(input, conversation.agentKey, kept.length, removed.length);
        return { kept, removed, cancelledActions, original };
    });
}

/** Puts the transcript back as it was, if nothing has been written to it since the cut. */
export async function rollbackTruncation(scope: SessionEditScope, result: Pick<TruncateSessionResult, 'kept' | 'original' | 'removed'>): Promise<boolean> {
    if (result.removed.length === 0) return false;
    return runWithTenantDb(scope.tenantDbName, async (db) => {
        const current = await db.findAgentConversationById(scope.conversationId).catch(() => null);
        if (!current || current.projectId !== scope.projectId) return false;
        // Another write after the cut (the failed turn got far enough to save something): leave it.
        if ((current.messages ?? []).length !== result.kept.length) return false;
        await db.updateAgentConversation(scope.conversationId, { messages: result.original });
        return true;
    });
}

function auditTruncation(input: TruncateSessionInput, agentKey: string, kept: number, removed: number): void {
    const { actor } = input;
    criticalFireAndForget('agent-session-truncate-audit', () => runWithTenantScope(input.tenantDbName, () => recordAuditLog(
        { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
        {
            projectId: input.projectId,
            action: 'write',
            actorType: 'user',
            actorUserId: actor.userId,
            actorEmail: actor.email,
            event: `agent.session.${input.reason ?? 'truncate'}`,
            ipAddress: input.audit?.ipAddress,
            userAgent: input.audit?.userAgent,
            requestId: input.audit?.requestId,
            outcome: 'success',
            resourceType: 'agent_conversation',
            resourceId: input.conversationId,
            service: 'agents',
            metadata: { agentKey, channel: actor.channel, keptMessages: kept, removedMessages: removed },
        },
    )));
}

// ── Re-running a message ───────────────────────────────────────────────

export type RerunMode = 'regenerate' | 'edit';

export interface PreparedRerun {
    mode: RerunMode;
    /** The user message to run (the stored text for a regenerate, the new text for an edit). */
    userMessage: string;
    /** The session files the message carries. */
    fileIds: string[];
    /** The answer this one replaces (a regenerate only), for `executePlaygroundChat({ previousVersions })`. */
    previousVersions: IAgentMessageVersion[];
    /** Index the re-run user message will have. */
    userIndex: number;
}

export interface RerunTarget {
    mode: RerunMode;
    /** `regenerate`: the assistant message (must be the latest). `edit`: the user message. */
    messageIndex: number;
    /** `edit`: the new text. */
    content?: string;
    /** `edit`: the files of the edited message; omitted keeps the original's. */
    fileIds?: string[];
}

/** Works out what to run again, and where the cut goes, without changing anything. */
export function planRerun(messages: readonly IAgentConversationMessage[], target: RerunTarget): PreparedRerun {
    const message = messages[target.messageIndex];
    if (!Number.isInteger(target.messageIndex) || !message) {
        throw new SessionEditError(404, 'message_not_found', 'That message is not in this session.');
    }
    if (target.mode === 'edit') {
        if (message.role !== 'user') throw new SessionEditError(400, 'not_a_user_message', 'Only a message you sent can be edited.');
        const content = (target.content ?? '').trim();
        const fileIds = target.fileIds ?? (message.attachments ?? []).map((file) => file.fileId);
        if (!content && fileIds.length === 0) throw new SessionEditError(400, 'empty_message', 'The edited message is empty.');
        return { mode: 'edit', userMessage: content, fileIds, previousVersions: [], userIndex: target.messageIndex };
    }

    if (message.role !== 'assistant') {
        throw new SessionEditError(400, 'not_an_assistant_message', 'Only an answer can be regenerated.');
    }
    if (target.messageIndex !== messages.length - 1) {
        throw new SessionEditError(409, 'not_latest_answer', 'Only the latest answer can be regenerated.');
    }
    let userIndex = target.messageIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) throw new SessionEditError(404, 'message_not_found', 'There is no message to run again.');
    const user = messages[userIndex];
    const replaced: IAgentMessageVersion = {
        content: message.content,
        timestamp: new Date(timestampMs(message.timestamp) || Date.now()),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.usage
            ? {
                usage: {
                    ...(message.usage.inputTokens !== undefined ? { inputTokens: message.usage.inputTokens } : {}),
                    ...(message.usage.outputTokens !== undefined ? { outputTokens: message.usage.outputTokens } : {}),
                    ...(message.usage.totalTokens !== undefined ? { totalTokens: message.usage.totalTokens } : {}),
                    ...(message.usage.costUsd !== undefined ? { costUsd: message.usage.costUsd } : {}),
                },
            }
            : {}),
    };
    return {
        mode: 'regenerate',
        userMessage: user.content,
        fileIds: (user.attachments ?? []).map((file) => file.fileId),
        previousVersions: [...(message.previousVersions ?? []), replaced].slice(-MAX_PREVIOUS_VERSIONS),
        userIndex,
    };
}

export interface RerunSessionInput<T> extends SessionEditScope {
    target: RerunTarget;
    actor: SessionEditActor;
    audit?: TruncateSessionInput['audit'];
    /**
     * Runs the new turn — `executePlaygroundChat` with the prepared message, its
     * files and `previousVersions`, under the host's own callbacks and context.
     */
    run: (prepared: PreparedRerun) => Promise<T>;
}

/**
 * Cuts the session back to just before the message being run again, runs it
 * with `run`, and — if the turn throws — restores the transcript so a failed
 * regenerate does not cost the answer that was there. The ratings of the
 * replaced messages are marked once the new turn has run.
 */
export async function rerunSessionTurn<T>(input: RerunSessionInput<T>): Promise<T> {
    const messages = await runWithTenantDb(input.tenantDbName, async (db) => (await loadEditableSession(db, input)).messages ?? []);
    const prepared = planRerun(messages, input.target);
    const cut = await truncateSessionAfterMessage({
        ...input,
        keepThrough: prepared.userIndex - 1,
        reason: prepared.mode,
        markFeedback: false,
    });
    let result: T;
    try {
        result = await input.run(prepared);
    } catch (error) {
        await rollbackTruncation(input, cut).catch((rollbackError) => {
            logger.warn('Could not put the transcript back after a failed re-run', {
                conversationId: input.conversationId, error: String(rollbackError),
            });
        });
        throw error;
    }
    await runWithTenantDb(input.tenantDbName, (db) => db.markAgentMessageFeedbackRemoved(input.conversationId, prepared.userIndex)).catch((error) => {
        logger.warn('Could not mark the ratings of the replaced messages', { conversationId: input.conversationId, error: String(error) });
    });
    return result;
}
