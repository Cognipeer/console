/**
 * Pending actions: the tool approvals and questions an agent turn pauses on.
 *
 * When the SDK stops a run for a human (`ctx.__awaitingApproval` /
 * `__awaitingUserQuestion`), this module
 *  - turns the pending entries of the SDK state into `agent_pending_actions`
 *    rows (one per approval / question),
 *  - builds the PAUSED STATE — the full resumable SDK state, stored beside the
 *    conversation (`IAgentConversationState.pausedSnapshot`) so the same turn
 *    can continue once every action is answered, and
 *  - keeps the copies that ride on the assistant message and the session event
 *    log in step.
 *
 * Resolving the actions and continuing the turn is `agentActionResolution.ts`.
 */

import type {
    Message as AgentSdkMessage,
    SmartState as AgentSdkSmartState,
    UserQuestionAnswerSet,
    UserQuestionItem,
} from '@cognipeer/agent-sdk';
import { createLogger } from '@/lib/core/logger';
import type {
    DatabaseProvider,
    IAgentConversation,
    IAgentMessagePendingAction,
    IAgentPendingAction,
    IAgentPendingActionResolution,
    IAgentUserQuestion,
} from '@/lib/database';
import { AgentPendingActionError } from './agentErrors';
import { CLIENT_TOOL_SERVER_GRACE_SECONDS, clientToolMeta } from './agentClientTools';
import { MAX_STATE_BYTES, serializeCarriedState, toPlainMessage } from './agentTurnState';
import type { ResolvedHitlConfig } from './agentHumanInTheLoop';
import type { SessionEventWriter } from './sessionEvents';

const logger = createLogger('agents:pending-actions');

// ── Public shape ────────────────────────────────────────────────────────

/** A pending action as clients see it — never the SDK's internal ids or who started the turn. */
export interface PublicPendingAction {
    id: string;
    kind: IAgentPendingAction['kind'];
    toolName?: string;
    args?: unknown;
    questions?: IAgentPendingAction['questions'];
    allowFreeText?: boolean;
    /** `client_tool`: how long the host page may take. */
    timeoutSeconds?: number;
    status: IAgentPendingAction['status'];
    expiresAt?: string;
    requestedAt: string;
}

export function toPublicPendingAction(action: IAgentPendingAction): PublicPendingAction {
    return {
        id: String(action._id),
        kind: action.kind,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.args !== undefined ? { args: action.args } : {}),
        ...(action.questions ? { questions: action.questions } : {}),
        ...(action.allowFreeText !== undefined ? { allowFreeText: action.allowFreeText } : {}),
        ...(action.clientTool ? { timeoutSeconds: action.clientTool.timeoutSeconds } : {}),
        status: action.status,
        ...(action.expiresAt ? { expiresAt: new Date(action.expiresAt).toISOString() } : {}),
        requestedAt: new Date(action.requestedAt).toISOString(),
    };
}

/** The copy of an action carried on the assistant message (history rendering). */
export function toMessagePendingAction(action: IAgentPendingAction): IAgentMessagePendingAction {
    return {
        id: String(action._id),
        kind: action.kind,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.args !== undefined ? { args: action.args } : {}),
        ...(action.questions ? { questions: action.questions } : {}),
        ...(action.allowFreeText !== undefined ? { allowFreeText: action.allowFreeText } : {}),
        ...(action.clientTool ? { timeoutSeconds: action.clientTool.timeoutSeconds } : {}),
        status: action.status,
        ...(action.resolution ? { resolution: action.resolution } : {}),
    };
}

/** Data of the `action.required` event. */
export function actionRequiredEventData(action: IAgentPendingAction): Record<string, unknown> {
    return {
        actionId: String(action._id),
        kind: action.kind,
        ...(action.toolName ? { toolName: action.toolName } : {}),
        ...(action.args !== undefined ? { args: action.args } : {}),
        ...(action.questions ? { questions: action.questions } : {}),
        ...(action.allowFreeText !== undefined ? { allowFreeText: action.allowFreeText } : {}),
        ...(action.clientTool ? { timeoutSeconds: action.clientTool.timeoutSeconds } : {}),
        ...(action.expiresAt ? { expiresAt: new Date(action.expiresAt).toISOString() } : {}),
    };
}

// ── The paused state ───────────────────────────────────────────────────

/** Which entry point paused, so the continuation runs with the same source / route. */
export type PauseSource = 'agent' | 'agent-playground';

/**
 * The ctx keys the SDK needs to continue a paused run. Everything else in
 * `ctx` is per-run (live handles, one-run verdicts) and must not be stored.
 */
const RESUME_CTX_KEYS = ['__awaitingApproval', '__awaitingUserQuestion', '__resumeStage', '__subagentPending'] as const;

interface PausedEnvelope {
    v: 1;
    source: PauseSource;
    state: Record<string, unknown>;
}

/**
 * The state fields a continuation needs. Messages are plain-ified (the SDK's
 * LangChain-flavoured objects carry dead weight) but NOT repaired: the unanswered
 * tool call the pause is waiting on has to stay in the transcript.
 */
const PAUSED_STATE_FIELDS = [
    'toolHistory',
    'toolHistoryArchived',
    'summaries',
    'summaryRecords',
    'plan',
    'planVersion',
    'pendingApprovals',
    'pendingUserQuestions',
] as const;

/**
 * Serializes the state of a paused run, or null when it does not fit in
 * `maxBytes` — the caller then does not pause (see `openPause`). The paused
 * copy shares a document with the normal snapshot, so `openPause` passes what
 * is left of `MAX_STATE_BYTES` after that one.
 */
export function serializePausedState(
    state: AgentSdkSmartState | undefined,
    source: PauseSource,
    maxBytes: number = MAX_STATE_BYTES,
): string | null {
    if (!state) return null;
    const raw = state as unknown as Record<string, unknown>;
    const stored: Record<string, unknown> = {
        // The system prompt is rebuilt from the config on resume.
        messages: ((raw.messages as unknown[]) ?? [])
            .map(toPlainMessage)
            .filter((message): message is AgentSdkMessage => message !== null && message.role !== 'system'),
    };
    for (const field of PAUSED_STATE_FIELDS) {
        if (raw[field] !== undefined) stored[field] = raw[field];
    }
    const ctx = (raw.ctx ?? {}) as Record<string, unknown>;
    const resumeCtx: Record<string, unknown> = {};
    for (const key of RESUME_CTX_KEYS) {
        if (ctx[key] !== undefined) resumeCtx[key] = ctx[key];
    }
    stored.ctx = resumeCtx;

    const text = JSON.stringify({ v: 1, source, state: stored } satisfies PausedEnvelope);
    return text.length <= maxBytes ? text : null;
}

export function parsePausedState(text: string): { source: PauseSource; state: AgentSdkSmartState } | null {
    try {
        const parsed = JSON.parse(text) as PausedEnvelope;
        if (!parsed || parsed.v !== 1 || typeof parsed.state !== 'object' || !parsed.state) return null;
        return {
            source: parsed.source === 'agent-playground' ? 'agent-playground' : 'agent',
            state: parsed.state as unknown as AgentSdkSmartState,
        };
    } catch {
        return null;
    }
}

// ── Pending entries → rows ────────────────────────────────────────────

interface PauseEntry {
    kind: IAgentPendingAction['kind'];
    sdkId: string;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    questions?: IAgentUserQuestion[];
    allowFreeText?: boolean;
    /** `client_tool`: how long the host page may take. */
    timeoutSeconds?: number;
}

/** The approvals, questions and client tool calls the SDK state is waiting on. */
export function collectPauseEntries(state: AgentSdkSmartState | undefined): PauseEntry[] {
    const entries: PauseEntry[] = [];
    for (const approval of state?.pendingApprovals ?? []) {
        if (approval.status !== 'pending') continue;
        entries.push({
            kind: 'tool_approval',
            sdkId: approval.id,
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            args: approval.args,
        });
    }
    for (const question of state?.pendingUserQuestions ?? []) {
        if (question.status !== 'pending') continue;
        // A tool the embedding page runs: its call, not a question, waits for the answer.
        const clientTool = clientToolMeta(question as { metadata?: Record<string, unknown> });
        if (clientTool) {
            entries.push({
                kind: 'client_tool',
                sdkId: question.id,
                toolCallId: question.toolCallId,
                toolName: clientTool.name,
                args: clientTool.args,
                timeoutSeconds: clientTool.timeoutSeconds,
            });
            continue;
        }
        entries.push({
            kind: 'user_question',
            sdkId: question.id,
            toolCallId: question.toolCallId,
            toolName: question.toolName,
            questions: question.questions as unknown as IAgentUserQuestion[],
            allowFreeText: question.allowFreeText,
        });
    }
    return entries;
}

type PendingDb = Pick<DatabaseProvider, 'createAgentPendingActions'>;

export interface OpenPauseInput {
    state: AgentSdkSmartState | undefined;
    source: PauseSource;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    runId?: string;
    hitl: ResolvedHitlConfig;
    /** The version the paused turn ran (null = the draft), so the continuation rebuilds the same agent. */
    agentVersion: number | null;
    usePublished: boolean;
    /** Who started the turn. */
    createdBy: string;
}

export interface OpenedPause {
    /** The paused state, to store as `pausedSnapshot`. */
    snapshot: string;
    actions: IAgentPendingAction[];
}

/** Why a pause could not be opened — shown as a warning on the message. */
export const PAUSE_UNAVAILABLE_WARNING =
    'The run stopped for a human but its state is too large to keep, so it cannot be continued.';

/**
 * Creates one `agent_pending_actions` row per pending SDK approval / question
 * and returns them with the paused state to store. Null — nothing is created —
 * when the run cannot be continued: the state does not fit, or the SDK stopped
 * for a reason that has no action to answer. The caller then keeps today's
 * behaviour (a message that says it stopped).
 */
export async function openPause(db: PendingDb, input: OpenPauseInput): Promise<OpenedPause | null> {
    const entries = collectPauseEntries(input.state);
    if (entries.length === 0) return null;
    // Both copies are stored in one document capped at MAX_STATE_BYTES. A normal
    // snapshot that does not fit is deleted on save, which would drop the paused
    // copy too — so neither case may leave approval cards that cannot be resumed.
    const normal = serializeCarriedState(input.state);
    const snapshot = normal === null
        ? null
        : serializePausedState(input.state, input.source, MAX_STATE_BYTES - normal.length);
    if (!snapshot) {
        logger.warn('Paused run state is too large to store; not pausing', { conversationId: input.conversationId });
        return null;
    }
    const now = new Date();
    const expiresAt = input.hitl.timeoutMinutes > 0
        ? new Date(now.getTime() + input.hitl.timeoutMinutes * 60_000)
        : null;
    const actions = await db.createAgentPendingActions(entries.map((entry) => ({
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentKey: input.agentKey,
        conversationId: input.conversationId,
        ...(input.runId ? { runId: input.runId } : {}),
        kind: entry.kind,
        sdkId: entry.sdkId,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        ...(entry.questions ? { questions: entry.questions } : {}),
        ...(entry.allowFreeText !== undefined ? { allowFreeText: entry.allowFreeText } : {}),
        status: 'pending' as const,
        requestedAt: now,
        // A page gets its own tool's timeout (plus a little for the round trip), not the approvals' one.
        expiresAt: entry.kind === 'client_tool' && entry.timeoutSeconds !== undefined
            ? new Date(now.getTime() + (entry.timeoutSeconds + CLIENT_TOOL_SERVER_GRACE_SECONDS) * 1000)
            : expiresAt,
        ...(entry.kind === 'client_tool' && entry.timeoutSeconds !== undefined ? { clientTool: { timeoutSeconds: entry.timeoutSeconds } } : {}),
        agentVersion: input.agentVersion,
        usePublished: input.usePublished,
        createdBy: input.createdBy,
    })));
    return { snapshot, actions };
}

// ── Answers ─────────────────────────────────────────────────────────────

/**
 * The public answer body (`{ "<question text>": "value" | ["v1", "v2"] }`) in
 * the SDK's shape. A value that names one of the question's options is a
 * selection; anything else is the user's own words (`freeText`), which the SDK
 * accepts or refuses according to the question's `allowFreeText`.
 */
export function toSdkAnswerSet(
    questions: UserQuestionItem[],
    answers: Record<string, string | string[]> | undefined,
): UserQuestionAnswerSet {
    const out: UserQuestionAnswerSet = {};
    for (const question of questions) {
        const raw = answers?.[question.question] ?? (question.header ? answers?.[question.header] : undefined);
        if (raw === undefined || raw === null) continue;
        const given = (Array.isArray(raw) ? raw : [raw]).map(String).filter((value) => value.trim() !== '');
        if (given.length === 0) continue;
        const allowed = new Set((question.options ?? []).map((option) => option.value ?? option.label));
        const picked = given.filter((value) => allowed.has(value));
        const typed = given.filter((value) => !allowed.has(value));
        out[question.question] = { values: picked, ...(typed.length > 0 ? { freeText: typed.join('\n') } : {}) };
    }
    return out;
}

/** A paused run could not be continued (its state is gone, or not every action is answered). */
export class AgentResumeError extends Error {
    readonly status: number;
    /** The stored state is gone for good, so the session is not waiting for anything any more. */
    readonly stateLost: boolean;

    constructor(message: string, status = 409, options: { stateLost?: boolean } = {}) {
        super(message);
        this.name = 'AgentResumeError';
        this.status = status;
        this.stateLost = options.stateLost === true;
    }
}

// ── New message while an action is open ───────────────────────────────

type PolicyDb = Pick<DatabaseProvider, 'listAgentPendingActions'>;

/**
 * The still-open actions that block a new message under `reject`. Empty when
 * the conversation is not waiting on anything — including a conversation whose
 * status says `requires_action` but whose actions are all answered (a
 * continuation that never ran must not lock the session forever).
 */
export async function blockingPendingActions(
    db: PolicyDb,
    conversation: Pick<IAgentConversation, '_id' | 'runtimeStatus'>,
): Promise<IAgentPendingAction[]> {
    if (conversation.runtimeStatus !== 'requires_action') return [];
    return db.listAgentPendingActions(String(conversation._id), { status: 'pending' });
}

/** Throws `AgentPendingActionError` when the agent's policy rejects a message while an action is open. */
export async function assertNoBlockingPending(
    db: PolicyDb,
    conversation: Pick<IAgentConversation, '_id' | 'runtimeStatus'>,
    hitl: ResolvedHitlConfig,
): Promise<void> {
    if (hitl.onUserMessageWhilePending !== 'reject') return;
    const open = await blockingPendingActions(db, conversation);
    if (open.length > 0) throw new AgentPendingActionError(open.map((action) => String(action._id)));
}

// ── Message-snapshot + row bookkeeping shared by resolve / cancel / expire ──

/** The assistant messages' `pendingActions` copies, with `id`'s status / resolution updated. */
export function updateMessageSnapshots(
    messages: IAgentConversation['messages'],
    updates: Map<string, { status: IAgentPendingAction['status']; resolution?: IAgentPendingActionResolution }>,
): IAgentConversation['messages'] {
    return messages.map((message) => {
        if (!message.pendingActions?.some((action) => updates.has(action.id))) return message;
        return {
            ...message,
            pendingActions: message.pendingActions.map((action) => {
                const update = updates.get(action.id);
                return update
                    ? { ...action, status: update.status, ...(update.resolution ? { resolution: update.resolution } : {}) }
                    : action;
            }),
        };
    });
}

/** Data of an `action.resolved` event. */
export function actionResolvedEventData(
    action: IAgentPendingAction,
    detail: {
        decision?: 'allow' | 'deny';
        cancelled?: boolean;
        expired?: boolean;
        /** `client_tool`: the page answered with a result (true) or an error / nothing (false). */
        ok?: boolean;
        durationMs?: number;
        timedOut?: boolean;
        resolvedBy: string;
        channel: string;
    },
): Record<string, unknown> {
    return {
        actionId: String(action._id),
        kind: action.kind,
        ...(action.kind === 'client_tool' && action.toolName ? { toolName: action.toolName } : {}),
        ...(detail.decision ? { decision: detail.decision } : {}),
        ...(detail.cancelled ? { cancelled: true } : {}),
        ...(detail.expired ? { expired: true } : {}),
        ...(detail.ok !== undefined ? { ok: detail.ok } : {}),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
        ...(detail.timedOut ? { timedOut: true } : {}),
        resolvedBy: detail.resolvedBy,
        channel: detail.channel,
    };
}

/** Who cancelled the open actions, for the row and the `action.resolved` event. */
const NEW_MESSAGE_CANCEL = 'system:new_message';

/**
 * Cancels every open action of the conversation because a new message arrives
 * (`onUserMessageWhilePending: 'cancel_pending'`) — or, with `resolvedBy`, for
 * another system reason (the background run that was waiting on them was
 * cancelled): rows → `cancelled`, the message copies updated, the paused state
 * dropped. The normal (repaired) snapshot stays, so the next turn simply loses
 * the unanswered call.
 *
 * Returns the conversation with its messages as they now read.
 */
export async function cancelPendingForNewMessage(
    db: Pick<DatabaseProvider,
        'listAgentPendingActions' | 'updateAgentPendingAction' | 'updateAgentConversation'
        | 'findAgentConversationState' | 'saveAgentConversationState'>,
    conversation: IAgentConversation,
    emit?: SessionEventWriter['emit'],
    resolvedBy: string = NEW_MESSAGE_CANCEL,
): Promise<IAgentConversation> {
    if (conversation.runtimeStatus !== 'requires_action') return conversation;
    const conversationId = String(conversation._id);
    const open = await db.listAgentPendingActions(conversationId, { status: 'pending' });

    const updates = new Map<string, { status: IAgentPendingAction['status']; resolution?: IAgentPendingActionResolution }>();
    for (const action of open) {
        const cancelled = await db.updateAgentPendingAction(String(action._id), {
            status: 'cancelled',
            resolvedAt: new Date(),
            resolvedBy,
            resolution: { cancelled: true },
        });
        if (!cancelled) continue;
        updates.set(String(action._id), { status: 'cancelled', resolution: { cancelled: true } });
        emit?.('action.resolved', actionResolvedEventData(action, {
            cancelled: true,
            resolvedBy,
            channel: 'system',
        }));
    }

    let current = conversation;
    if (updates.size > 0) {
        const messages = updateMessageSnapshots(conversation.messages ?? [], updates);
        await db.updateAgentConversation(conversationId, { messages });
        current = { ...conversation, messages };
    }
    await dropPausedSnapshot(db, conversationId);
    return current;
}

/** Removes the paused state, keeping the normal snapshot. */
export async function dropPausedSnapshot(
    db: Pick<DatabaseProvider, 'findAgentConversationState' | 'saveAgentConversationState'>,
    conversationId: string,
): Promise<void> {
    try {
        const stored = await db.findAgentConversationState(conversationId);
        if (!stored?.pausedSnapshot) return;
        const { pausedSnapshot: _dropped, _id, createdAt: _c, updatedAt: _u, ...rest } = stored;
        void _dropped; void _id; void _c; void _u;
        await db.saveAgentConversationState(rest);
    } catch (error) {
        logger.warn('Could not drop the paused state', { conversationId, error: error instanceof Error ? error.message : String(error) });
    }
}
