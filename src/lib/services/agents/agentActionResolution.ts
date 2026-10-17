/**
 * Answering a pending action — and what follows from it.
 *
 * `resolveAgentPendingAction` is the one entry point the dashboard, the client
 * API and the portal all call. It checks who may answer (the caller's
 * `authorize`, asked by the route that has the principal: the policy engine's
 * `agent.approve` decision for a tool approval; for a QUESTION the ownership of
 * the session - its owner always, anybody else needs `agent.session_manage_others`),
 * records the answer, and —
 * once every action of the pause is answered — continues the SAME turn: the
 * agent is rebuilt, the stored state restored, the answers applied with the SDK
 * and the loop invoked again (`executeAgentResumeLocal`). The continuation can
 * finish, or pause again.
 *
 * `sweepExpiredPendingActions` is the timeout side: the reconciler calls it,
 * and an agent's `onTimeout` decides between dropping the request and denying
 * it so the agent carries on (as a background job — nobody is waiting on it).
 */

import { isDeepStrictEqual } from 'node:util';
import { resolveUserQuestionState } from '@cognipeer/agent-sdk';
import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type {
    DatabaseProvider,
    IAgentConfig,
    IAgentConversation,
    IAgentPendingAction,
    IAgentPendingActionResolution,
    IAgentRun,
} from '@/lib/database';
import { recordAuditLog } from '@/lib/services/audit/auditService';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';
import {
    executeAgentResumeLocal,
    validateApprovedArgs,
    type AgentChatResponse,
    type AgentPlaygroundChatResult,
    type AgentResumeResult,
    type AgentRunCancellationCell,
    type AgentToolCallEvent,
} from './agentService';
import {
    RESUME_TIMEOUT_ACTOR,
    queueAgentRunResume,
    reserveConversationForSyncTurn,
    runWithTenantDb,
    settlePausedAgentRuns,
} from './agentRunService';
import { watchTurnCancellation } from './turnWatch';
import { resolveHitlConfig, type ResolvedHitlConfig } from './agentHumanInTheLoop';
import {
    CLIENT_TOOL_UNANSWERED_MESSAGE,
    digestForAudit,
    parseClientToolAnswer,
    type EmbeddedRunContext,
} from './agentClientTools';
import {
    actionResolvedEventData,
    AgentResumeError,
    blockingPendingActions,
    dropPausedSnapshot,
    toPublicPendingAction,
    toSdkAnswerSet,
    updateMessageSnapshots,
    type PublicPendingAction,
} from './agentPendingActions';
import { createSessionEventWriter, type SessionStopReason } from './sessionEvents';
import type { IAgentTurnCompaction } from '@/lib/database';

const logger = createLogger('agents:action-resolution');

// ── Who is answering ───────────────────────────────────────────────────

export interface ResolveActor {
    userId: string;
    /** Where the answer came from; it rides on the `action.resolved` event and the audit entry. */
    channel: 'dashboard' | 'api' | 'portal';
    email?: string;
    role?: string;
    apiTokenId?: string;
}

/**
 * What the policy engine is asked when somebody answers: the session (who started it), the request (a tool
 * approval or a question - they are governed differently) and the agent's own "who can approve" setting as the
 * paused turn ran with it (the agent version the request was raised under). The engine decides; this is only
 * the question.
 */
export interface ApprovalRequest {
    conversation: Pick<IAgentConversation, '_id' | 'agentKey' | 'projectId' | 'createdBy'>;
    /** `kind` absent = a tool approval (an authorizer written before questions were told apart). */
    action: Pick<IAgentPendingAction, '_id' | 'agentKey' | 'projectId' | 'createdBy'> & Partial<Pick<IAgentPendingAction, 'kind'>>;
    approvers: ResolvedHitlConfig['approvers'];
}

/**
 * `decisionId`: the code of the engine's refusal (also in the audit trail), for the caller to quote.
 * `unavailable`: the engine could not decide - nobody was refused on merit, the caller answers 503.
 */
export type ApprovalVerdict =
    | { allowed: true }
    | { allowed: false; message?: string; decisionId?: string; unavailable?: boolean };

/**
 * May the caller answer this request? Supplied by the route (or the portal), the only place that has the
 * principal. A tool approval asks `agent.approve` of the engine (allow, deny, edited arguments, remember for
 * the session); a question asks the ownership of the session (`agent.session_manage_others` for anybody but
 * its owner). A refusal is `{ allowed: false }`; when the engine cannot decide at all the verdict says
 * `unavailable` - an outage is never read as an answer, and never as a "no" either (the resolve outcome is
 * `unavailable`, a 503). An authorizer that THROWS its 503 instead (an `ApprovalUnavailableError`, or any
 * error carrying the code `authorization_unavailable`) is read the same way.
 */
export type ApprovalAuthorizer = (request: ApprovalRequest) => Promise<ApprovalVerdict>;

const FORBIDDEN_MESSAGE = 'You are not allowed to answer this request.';

/** Who a request the timeout sweep ended is recorded as answered by (`resolvedBy`, the audit trail's actor). */
const SYSTEM_TIMEOUT_ACTOR = 'system:timeout';

export interface ResolveAgentActionInput {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    conversationId: string;
    actionId: string;
    /** When the route names the agent, the action must belong to it. */
    agentKey?: string;
    /** The request body: `{decision, comment?, approvedArgs?, rememberForSession?}`, `{answers, cancelled?}` or, for a client tool, `{output}` / `{error}`. */
    body: Record<string, unknown>;
    actor: ResolveActor;
    /** The policy engine's decision on `agent.approve` for this caller (see `ApprovalAuthorizer`). */
    authorize: ApprovalAuthorizer;
    /** `background`: queue the continuation as a run instead of running it inline. */
    mode: 'sync' | 'background';
    runtimeContext?: AgentRuntimeContext;
    /**
     * The host page this answer comes from, when the chat is embedded in one: its
     * declared client tools stay on offer to the continuation (it may call another).
     * Only a host that knows the embedding sets this — never a client request.
     */
    embedded?: EmbeddedRunContext;
    /** The caller cannot answer approvals but runs the agent's client tools (the chat completions bridge). */
    unattended?: boolean;
    answersClientTools?: boolean;
    /** Live callbacks for `?stream=1`. */
    stream?: {
        onToolEvent?: (event: AgentToolCallEvent) => void;
        onTextChunk?: (text: string) => void;
        onReasoningChunk?: (text: string) => void;
        onCompaction?: (compaction: IAgentTurnCompaction) => void;
        signal?: AbortSignal;
    };
    /** Deadline / cancel reference for a continuation that runs under a ceiling. */
    cancellationCell?: AgentRunCancellationCell;
    audit?: { ipAddress?: string; userAgent?: string; requestId?: string };
}

export type ResolveOutcome =
    | { kind: 'not_found' }
    | { kind: 'not_pending'; status: IAgentPendingAction['status'] }
    | { kind: 'expired' }
    | { kind: 'forbidden'; message: string; decisionId?: string }
    /** The engine could not decide who may answer: 503, never a 403 - and nothing was recorded. */
    | { kind: 'unavailable'; decisionId?: string }
    | { kind: 'invalid'; message: string }
    | { kind: 'busy' }
    /** Recorded; other requests of the same pause are still open. */
    | { kind: 'pending'; pendingActions: PublicPendingAction[] }
    /** Recorded, and the turn continued inline. */
    | { kind: 'resumed'; result: AgentPlaygroundChatResult; response: AgentChatResponse; stopReason: SessionStopReason }
    /** Recorded, and the continuation is queued as a background run. */
    | { kind: 'queued'; run: IAgentRun };

/**
 * A page's result goes into the model's context as a tool result, so it is the
 * word of whoever answers. Only the person the chat belongs to — the page they
 * are looking at — or an API token that passed the approval policy may supply it; an administrator or another project member
 * (whom `approvers` lets approve a tool) may only give the call up, with an
 * error. Without this, anyone allowed to approve could put words in the model's
 * mouth in somebody else's session.
 *
 * That makes the owner the only author of the answer, not a trusted one: the
 * owner controls their own browser, so the result still reaches the model marked
 * as untrusted user input (`markClientToolContent`).
 */
export function mayAnswerClientTool(
    actor: Pick<ResolveActor, 'userId'> & Partial<Pick<ResolveActor, 'channel' | 'apiTokenId'>>,
    conversation: Pick<IAgentConversation, 'createdBy'>,
    action: Pick<IAgentPendingAction, 'createdBy'>,
    resolution: IAgentPendingActionResolution,
): boolean {
    if (resolution.error !== undefined) return true;
    // An API client answers for a tool the agent declared: the integrating backend (or the
    // agent's callback receiver) runs it under its own token, which need not be the
    // token that started the session. The token already passed the approval policy
    // (`agent.approve`) before this check, and the result is still marked untrusted.
    if (actor.channel === 'api' && actor.apiTokenId) return true;
    return Boolean(actor.userId)
        && (actor.userId === String(conversation.createdBy) || actor.userId === action.createdBy);
}

const CLIENT_TOOL_OWNER_ONLY = 'Only the person this chat belongs to can answer for the page. You can give the call up instead.';

// ── Reading the request ───────────────────────────────────────────────

type Parsed =
    | { ok: true; resolution: IAgentPendingActionResolution }
    | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request body as a resolution — or the 400 message. */
export function parseResolution(action: IAgentPendingAction, body: Record<string, unknown>): Parsed {
    if (action.kind === 'client_tool') return parseClientToolAnswer(body);
    if (action.kind === 'tool_approval') {
        const decision = body.decision;
        if (decision !== 'allow' && decision !== 'deny') return { ok: false, message: '`decision` must be "allow" or "deny"' };
        if (body.comment !== undefined && typeof body.comment !== 'string') return { ok: false, message: '`comment` must be a string' };
        if (body.rememberForSession !== undefined && typeof body.rememberForSession !== 'boolean') {
            return { ok: false, message: '`rememberForSession` must be a boolean' };
        }
        if (body.approvedArgs !== undefined) {
            if (!isPlainObject(body.approvedArgs)) return { ok: false, message: '`approvedArgs` must be a JSON object' };
            if (decision === 'deny') return { ok: false, message: '`approvedArgs` only applies to an approval' };
        }
        return {
            ok: true,
            resolution: {
                decision,
                ...(typeof body.comment === 'string' && body.comment ? { comment: body.comment } : {}),
                ...(isPlainObject(body.approvedArgs) ? { approvedArgs: body.approvedArgs } : {}),
                ...(body.rememberForSession === true && decision === 'allow' ? { rememberForSession: true } : {}),
            },
        };
    }

    const cancelled = body.cancelled === true;
    if (body.cancelled !== undefined && typeof body.cancelled !== 'boolean') return { ok: false, message: '`cancelled` must be a boolean' };
    if (cancelled) return { ok: true, resolution: { cancelled: true } };
    if (!isPlainObject(body.answers)) return { ok: false, message: '`answers` must be an object keyed by question' };
    const answers: Record<string, string | string[]> = {};
    for (const [question, value] of Object.entries(body.answers)) {
        if (typeof value === 'string') answers[question] = value;
        else if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) answers[question] = value as string[];
        else return { ok: false, message: `The answer to "${question}" must be a string or a list of strings` };
    }
    return { ok: true, resolution: { answers } };
}

/** Would the SDK accept these answers? Checked here so a bad answer is a 400, not a failed resume. */
function checkAnswers(action: IAgentPendingAction, resolution: IAgentPendingActionResolution): string | null {
    if (action.kind !== 'user_question' || resolution.cancelled) return null;
    try {
        resolveUserQuestionState(
            {
                messages: [],
                pendingUserQuestions: [{
                    id: action.sdkId,
                    toolCallId: action.toolCallId ?? action.sdkId,
                    toolName: 'ask_user_question',
                    questions: (action.questions ?? []) as never,
                    status: 'pending',
                    requestedAt: new Date(action.requestedAt).toISOString(),
                    allowFreeText: action.allowFreeText !== false,
                }],
            },
            {
                id: action.sdkId,
                answers: toSdkAnswerSet((action.questions ?? []) as never, resolution.answers),
            },
        );
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : 'The answers are not valid';
    }
}

// ── Shared bookkeeping ───────────────────────────────────────────────

/** The refusal for a caller the engine does not let answer (or the engine's outage). */
function forbidden(verdict: Extract<ApprovalVerdict, { allowed: false }>): ResolveOutcome {
    if (verdict.unavailable) return { kind: 'unavailable', ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}) };
    return { kind: 'forbidden', message: verdict.message ?? FORBIDDEN_MESSAGE, ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}) };
}

/** An error an authorizer threw that says "the engine could not decide" (the portal's, a gate's 503). */
function unavailableCause(error: unknown): { decisionId?: string } | null {
    if (!error || typeof error !== 'object') return null;
    const candidate = error as { code?: unknown; status?: unknown; body?: { code?: unknown; decisionId?: unknown }; decisionId?: unknown };
    const isUnavailable = candidate.code === 'authorization_unavailable'
        || candidate.body?.code === 'authorization_unavailable'
        || candidate.status === 503;
    if (!isUnavailable) return null;
    const decisionId = typeof candidate.decisionId === 'string' ? candidate.decisionId
        : typeof candidate.body?.decisionId === 'string' ? candidate.body.decisionId : undefined;
    return decisionId ? { decisionId } : {};
}

/** Asks the caller's authorizer; its outage - returned or thrown - is the `unavailable` verdict. Anything else it throws is a bug and propagates. */
async function askAuthorizer(authorize: ApprovalAuthorizer, request: ApprovalRequest): Promise<ApprovalVerdict> {
    try {
        return await authorize(request);
    } catch (error) {
        const cause = unavailableCause(error);
        if (!cause) throw error;
        return { allowed: false, unavailable: true, ...cause };
    }
}

/**
 * The settings of the config the paused turn ran with: the agent VERSION the request was raised under (a
 * published version is frozen, so editing the agent later does not change who may answer an open request),
 * else the live config. Readable even when the agent was deleted since (the defaults then apply).
 */
export async function hitlSettingsFor(db: DatabaseProvider, action: IAgentPendingAction): Promise<ResolvedHitlConfig> {
    const agent = await db.findAgentByKey(action.agentKey, action.projectId);
    let config: IAgentConfig | undefined = agent?.config;
    if (agent && action.agentVersion != null) {
        const snapshot = await db.findAgentVersion(String(agent._id), action.agentVersion);
        if (snapshot) config = snapshot.snapshot.config;
    }
    return resolveHitlConfig(config?.humanInTheLoop);
}

/** Writes events to the conversation's log and waits until they are stored (and published). */
async function writeSessionEvents(
    db: DatabaseProvider,
    scope: { tenantId: string; projectId: string; agentKey: string; conversationId: string; tenantDbName?: string },
    events: Array<{ type: 'action.resolved' | 'session.status_idle' | 'agent.tool_result'; data: Record<string, unknown> }>,
): Promise<void> {
    if (events.length === 0) return;
    const writer = createSessionEventWriter({ db, ...scope });
    for (const event of events) writer.emit(event.type, event.data);
    await writer.close();
}

function auditResolution(
    input: ResolveAgentActionInput,
    action: IAgentPendingAction,
    resolution: IAgentPendingActionResolution,
    edited: boolean,
): void {
    const { actor } = input;
    criticalFireAndForget('agent-action-audit', () => runWithTenantScope(input.tenantDbName, () => recordAuditLog(
        { tenantDbName: input.tenantDbName, tenantId: input.tenantId },
        {
            projectId: input.projectId,
            action: 'write',
            actorType: actor.apiTokenId ? 'api_token' : 'user',
            actorUserId: actor.userId,
            actorEmail: actor.email,
            actorRole: actor.role,
            apiTokenId: actor.apiTokenId,
            event: action.kind === 'tool_approval'
                ? 'agent.tool_approval.resolve'
                : action.kind === 'client_tool' ? 'agent.client_tool.resolve' : 'agent.question.resolve',
            ipAddress: input.audit?.ipAddress,
            userAgent: input.audit?.userAgent,
            requestId: input.audit?.requestId,
            outcome: 'success',
            resourceType: 'agent_pending_action',
            resourceId: String(action._id),
            service: 'agents',
            metadata: {
                agentKey: action.agentKey,
                conversationId: action.conversationId,
                kind: action.kind,
                toolName: action.toolName ?? null,
                decision: resolution.decision ?? null,
                cancelled: resolution.cancelled === true,
                argumentsEdited: edited,
                rememberForSession: resolution.rememberForSession === true,
                channel: actor.channel,
                // A client tool's arguments and result are the page's data: the trail keeps a digest, not the content.
                ...(action.kind === 'client_tool'
                    ? {
                        ok: resolution.error === undefined,
                        timedOut: resolution.timedOut === true,
                        durationMs: resolution.durationMs ?? null,
                        args: digestForAudit(action.args),
                        ...(resolution.error === undefined ? { output: digestForAudit(resolution.output) } : {}),
                    }
                    : {}),
            },
        },
    )));
}

/**
 * The timeout sweep answers (or drops) a request by itself: no person, no principal, outside the policy engine
 * (`agent.approve` is about people). It is audited as the system - `actorType: 'system'`, `system:timeout` - so
 * the trail says who ended the request and why.
 */
function auditSystemResolution(
    tenantDbName: string,
    action: IAgentPendingAction,
    outcome: { status: IAgentPendingAction['status']; resolution: IAgentPendingActionResolution },
): void {
    criticalFireAndForget('agent-action-timeout-audit', () => runWithTenantScope(tenantDbName, () => recordAuditLog(
        { tenantDbName, tenantId: action.tenantId },
        {
            projectId: action.projectId,
            action: 'write',
            actorType: 'system',
            actorUserId: SYSTEM_TIMEOUT_ACTOR,
            event: action.kind === 'tool_approval' ? 'agent.tool_approval.timeout' : 'agent.question.timeout',
            outcome: 'success',
            resourceType: 'agent_pending_action',
            resourceId: String(action._id),
            service: 'agents',
            metadata: {
                agentKey: action.agentKey,
                conversationId: action.conversationId,
                kind: action.kind,
                toolName: action.toolName ?? null,
                status: outcome.status,
                decision: outcome.resolution.decision ?? null,
                cancelled: outcome.resolution.cancelled === true,
                channel: 'timeout',
            },
        },
    )));
}

/** The tool's result in the session log, as the SDK would have written it for a tool that ran in the server. */
function clientToolResultEvent(
    action: IAgentPendingAction,
    resolution: IAgentPendingActionResolution,
): { type: 'agent.tool_result'; data: Record<string, unknown> } {
    return {
        type: 'agent.tool_result',
        data: {
            toolCallId: action.toolCallId ?? action.sdkId,
            name: action.toolName ?? 'client_tool',
            ok: resolution.error === undefined,
            ...(resolution.durationMs !== undefined ? { durationMs: resolution.durationMs } : {}),
            ...(resolution.error !== undefined ? { error: resolution.error } : {}),
            source: 'client',
        },
    };
}

/** Puts a just-recorded answer back to `pending` (the continuation could not start). */
async function undoResolution(
    db: DatabaseProvider,
    action: IAgentPendingAction,
    conversation: IAgentConversation,
): Promise<void> {
    await db.updateAgentPendingAction(String(action._id), {
        status: 'pending',
        resolvedAt: null,
        // null, not undefined: both providers skip or null-coerce undefined differently.
        resolvedBy: null as unknown as undefined,
        resolution: null as unknown as undefined,
    }, { onlyIfStatus: 'resolved' }).catch(() => undefined);
    // The message copy was updated with the answer; restore the original wording.
    const messages = updateMessageSnapshots(conversation.messages ?? [], new Map([[String(action._id), { status: 'pending' as const }]]));
    await db.updateAgentConversation(String(conversation._id), { messages }).catch(() => undefined);
}

// ── A new message while something is open ──────────────────────────────

/**
 * The ids of the requests that stop a new message from being accepted, or null
 * when it may go ahead. Lets a route answer 409 before it reserves the session;
 * the turn itself enforces the same rule (`assertNoBlockingPending`).
 */
export async function pendingActionsBlockingMessage(
    tenantDbName: string,
    conversation: Pick<IAgentConversation, '_id' | 'runtimeStatus'> | null | undefined,
    config: IAgentConfig | undefined,
): Promise<string[] | null> {
    if (!conversation || conversation.runtimeStatus !== 'requires_action') return null;
    if (resolveHitlConfig(config?.humanInTheLoop).onUserMessageWhilePending !== 'reject') return null;
    const open = await runWithTenantDb(tenantDbName, (db) => blockingPendingActions(db, conversation));
    return open.length > 0 ? open.map((action) => String(action._id)) : null;
}

/**
 * The read-only part of the resolve flow: would this answer be refused, and why?
 * Null when it would go ahead. Changes nothing, so a caller that streams can refuse
 * before it announces anything.
 */
export async function checkAgentPendingActionResolution(
    input: Pick<ResolveAgentActionInput, 'tenantDbName' | 'tenantId' | 'projectId' | 'conversationId' | 'actionId' | 'agentKey' | 'body' | 'authorize' | 'actor'>,
): Promise<ResolveOutcome | null> {
    const { tenantDbName, tenantId, projectId, conversationId, actor } = input;
    return runWithTenantDb(tenantDbName, async (db) => {
        const action = await db.findAgentPendingActionById(input.actionId).catch(() => null);
        if (!action
            || action.tenantId !== tenantId
            || action.projectId !== projectId
            || action.conversationId !== conversationId
            || (input.agentKey !== undefined && action.agentKey !== input.agentKey)) {
            return { kind: 'not_found' };
        }
        if (action.status === 'expired') return { kind: 'expired' };
        if (action.status !== 'pending') return { kind: 'not_pending', status: action.status };
        if (action.expiresAt && new Date(action.expiresAt).getTime() <= Date.now()) return { kind: 'expired' };

        const conversation = await db.findAgentConversationById(conversationId);
        if (!conversation || conversation.projectId !== projectId) return { kind: 'not_found' };

        const verdict = await askAuthorizer(input.authorize, { conversation, action, approvers: (await hitlSettingsFor(db, action)).approvers });
        if (!verdict.allowed) return forbidden(verdict);

        const parsed = parseResolution(action, input.body);
        if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
        if (action.kind === 'client_tool' && !mayAnswerClientTool(actor, conversation, action, parsed.resolution)) {
            return { kind: 'forbidden', message: CLIENT_TOOL_OWNER_ONLY };
        }
        const answersProblem = checkAnswers(action, parsed.resolution);
        return answersProblem ? { kind: 'invalid', message: answersProblem } : null;
    });
}

// ── The resolve flow ─────────────────────────────────────────────────

export async function resolveAgentPendingAction(input: ResolveAgentActionInput): Promise<ResolveOutcome> {
    const { tenantDbName, tenantId, projectId, conversationId, actor } = input;
    return runWithTenantDb(tenantDbName, async (db) => {
        // 1. Is there such an action, here, still open?
        const action = await db.findAgentPendingActionById(input.actionId).catch(() => null);
        if (!action
            || action.tenantId !== tenantId
            || action.projectId !== projectId
            || action.conversationId !== conversationId
            || (input.agentKey !== undefined && action.agentKey !== input.agentKey)) {
            return { kind: 'not_found' };
        }
        if (action.status === 'expired') return { kind: 'expired' };
        if (action.status !== 'pending') return { kind: 'not_pending', status: action.status };
        if (action.expiresAt && new Date(action.expiresAt).getTime() <= Date.now()) return { kind: 'expired' };

        const conversation = await db.findAgentConversationById(conversationId);
        if (!conversation || conversation.projectId !== projectId) return { kind: 'not_found' };

        // 2. Who may answer: the policy engine's decision, asked by the caller (it has the principal).
        const verdict = await askAuthorizer(input.authorize, { conversation, action, approvers: (await hitlSettingsFor(db, action)).approvers });
        if (!verdict.allowed) return forbidden(verdict);

        // 3. What they answered.
        const parsed = parseResolution(action, input.body);
        if (!parsed.ok) return { kind: 'invalid', message: parsed.message };
        const { resolution } = parsed;
        if (action.kind === 'client_tool' && !mayAnswerClientTool(actor, conversation, action, resolution)) {
            return { kind: 'forbidden', message: CLIENT_TOOL_OWNER_ONLY };
        }
        const answersProblem = checkAnswers(action, resolution);
        if (answersProblem) return { kind: 'invalid', message: answersProblem };
        // How long the page took, from the moment the call was asked of it.
        if (action.kind === 'client_tool') {
            resolution.durationMs = Math.max(0, Date.now() - new Date(action.requestedAt).getTime());
        }
        const edited = Boolean(resolution.approvedArgs && !isDeepStrictEqual(resolution.approvedArgs, action.args));
        if (edited && action.toolName) {
            const checked = await validateApprovedArgs({
                tenantDbName,
                tenantId,
                projectId,
                agentKey: action.agentKey,
                conversationId,
                userId: actor.userId,
                toolName: action.toolName,
                approvedArgs: resolution.approvedArgs!,
            });
            if (!checked.ok) return { kind: 'invalid', message: `The edited arguments are not valid: ${checked.message}` };
        }

        // 4. The conversation's slot, for an inline continuation. A background
        // continuation takes it when it is queued.
        const reservation = input.mode === 'sync'
            ? await reserveConversationForSyncTurn(db, {
                tenantId,
                tenantDbName,
                projectId,
                agentKey: action.agentKey,
                conversationId,
                userMessage: '',
                userId: actor.userId,
            })
            : undefined;
        if (reservation === null) return { kind: 'busy' };

        try {
            // 5. Record the answer (compare-and-set: two reviewers cannot both win).
            const recorded = await db.updateAgentPendingAction(String(action._id), {
                status: 'resolved',
                resolvedAt: new Date(),
                resolvedBy: actor.userId,
                resolution,
            });
            if (!recorded) {
                const current = await db.findAgentPendingActionById(String(action._id));
                return { kind: 'not_pending', status: current?.status ?? 'resolved' };
            }

            const snapshots = new Map([[String(action._id), { status: 'resolved' as const, resolution }]]);
            const metadata = resolution.rememberForSession && action.toolName
                ? {
                    ...(conversation.metadata ?? {}),
                    hitlAllowedTools: [...new Set([
                        ...(Array.isArray(conversation.metadata?.hitlAllowedTools) ? conversation.metadata.hitlAllowedTools as string[] : []),
                        action.toolName,
                    ])],
                }
                : undefined;
            const messages = updateMessageSnapshots(conversation.messages ?? [], snapshots);
            await db.updateAgentConversation(conversationId, { messages, ...(metadata ? { metadata } : {}) });

            await writeSessionEvents(db, { tenantId, projectId, agentKey: action.agentKey, conversationId }, [
                ...(action.kind === 'client_tool' ? [clientToolResultEvent(action, resolution)] : []),
                {
                    type: 'action.resolved' as const,
                    data: actionResolvedEventData(action, {
                        ...(resolution.decision ? { decision: resolution.decision } : {}),
                        ...(resolution.cancelled ? { cancelled: true } : {}),
                        ...(action.kind === 'client_tool'
                            ? { ok: resolution.error === undefined, durationMs: resolution.durationMs, ...(resolution.timedOut ? { timedOut: true } : {}) }
                            : {}),
                        resolvedBy: actor.userId,
                        channel: actor.channel,
                    }),
                },
            ]);
            auditResolution(input, action, resolution, edited);

            // 6. Other requests of the same pause still open: wait for them.
            const open = await db.listAgentPendingActions(conversationId, { status: 'pending' });
            if (open.length > 0) {
                await db.updateAgentConversationRuntime(conversationId, {
                    pendingActionIds: open.map((entry) => String(entry._id)),
                }).catch(() => undefined);
                return { kind: 'pending', pendingActions: open.map(toPublicPendingAction) };
            }

            // 7. Everything is answered: continue the turn.
            if (input.mode === 'background') {
                const queued = await queueAgentRunResume({
                    tenantDbName,
                    tenantId,
                    projectId,
                    agentKey: action.agentKey,
                    conversationId,
                    userId: actor.userId,
                    resumeActionIds: await answeredActionIds(db, conversationId),
                    ...(actor.apiTokenId ? { apiTokenId: actor.apiTokenId } : {}),
                    actorType: actor.apiTokenId ? 'api_token' : 'user',
                });
                if (queued.kind === 'conflict') {
                    await undoResolution(db, action, { ...conversation, messages });
                    return { kind: 'busy' };
                }
                return { kind: 'queued', run: queued.run };
            }

            // Once the SDK invoke starts, the approval is spent; a failure before
            // that (agent or model missing, a transient 5xx) re-opens the answers
            // so the reviewer can retry instead of getting 409 not_pending.
            let invoking = false;
            let resumed: AgentResumeResult;
            // A person answered, so the continuation runs attended — but inputs that came
            // from an external payload stay out of the system prompt (§2.4a).
            const [pausedRun] = await db.listAgentRuns({
                tenantId, projectId, conversationId, status: ['requires_action'], mode: ['background', 'inline'], limit: 1,
            }).catch(() => [] as IAgentRun[]);
            // A Stop on the conversation ends the continuation like any other turn.
            const watch = reservation
                ? watchTurnCancellation({
                    tenantDbName, tenantId, projectId, conversationId,
                    runId: String(reservation.run._id),
                    parent: input.stream?.signal,
                })
                : undefined;
            try {
                resumed = await executeAgentResumeLocal({
                    tenantDbName,
                    tenantId,
                    projectId,
                    agentKey: action.agentKey,
                    conversationId,
                    userId: actor.userId,
                    trigger: 'resume',
                    runtimeContext: input.runtimeContext,
                    ...(input.embedded ? { embedded: input.embedded } : {}),
                    ...(input.unattended ? { unattended: true } : {}),
                    ...(input.answersClientTools ? { answersClientTools: true } : {}),
                    ...(pausedRun?.externalContent ? { inputsAsPromptVariables: false } : {}),
                    ...(input.cancellationCell ? { cancellationCell: input.cancellationCell } : {}),
                    ...(input.stream?.onToolEvent ? { onToolEvent: input.stream.onToolEvent } : {}),
                    ...(input.stream?.onTextChunk ? { onTextChunk: input.stream.onTextChunk } : {}),
                    ...(input.stream?.onReasoningChunk ? { onReasoningChunk: input.stream.onReasoningChunk } : {}),
                    ...(input.stream?.onCompaction ? { onCompaction: input.stream.onCompaction } : {}),
                    ...(watch ? { signal: watch.signal } : input.stream?.signal ? { signal: input.stream.signal } : {}),
                    onInvokeStart: () => { invoking = true; },
                });
            } catch (error) {
                const stateLost = error instanceof AgentResumeError && error.stateLost;
                if (!invoking && !stateLost) await reopenAnsweredActions(db, conversationId);
                throw error;
            } finally {
                watch?.stop();
            }
            // A background run that was paused on this turn is settled by it.
            await settlePausedAgentRuns(tenantDbName, { tenantId, projectId, conversationId }, resumed.response)
                .catch((error) => {
                    logger.warn('Could not settle the paused run after an inline continuation', {
                        conversationId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                });
            return { kind: 'resumed', result: resumed.result, response: resumed.response, stopReason: resumed.stopReason };
        } finally {
            await reservation?.release();
        }
    });
}

/** Puts every answered action of the current pause back to `pending`. */
async function reopenAnsweredActions(db: DatabaseProvider, conversationId: string): Promise<void> {
    try {
        const answered = await db.listAgentPendingActions(conversationId, { status: 'resolved' });
        for (const entry of answered) {
            const conversation = await db.findAgentConversationById(conversationId);
            if (!conversation) return;
            await undoResolution(db, entry, conversation);
        }
    } catch (error) {
        logger.warn('Could not re-open the answers of a continuation that failed to start', {
            conversationId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** The answered actions of the conversation's current pause. */
async function answeredActionIds(db: DatabaseProvider, conversationId: string): Promise<string[]> {
    const all = await db.listAgentPendingActions(conversationId, { status: 'resolved' });
    return all.map((entry) => String(entry._id));
}

// ── Timeouts ─────────────────────────────────────────────────────────

export interface ExpiredSweepResult {
    expired: number;
    denied: number;
    continued: number;
}

/**
 * Handles the requests whose time ran out (`status = pending AND expiresAt <
 * now`), per the agent's `onTimeout`:
 *  - `cancel`: the request expires; the session is idle again.
 *  - `deny`: the request is answered as a refusal and, once nothing else is
 *    open, the agent continues — as a background job, nobody is waiting on it.
 */
export async function sweepExpiredPendingActions(
    db: DatabaseProvider,
    tenantDbName: string,
    now: Date,
    limit = 100,
): Promise<ExpiredSweepResult> {
    const result: ExpiredSweepResult = { expired: 0, denied: 0, continued: 0 };
    const due = await db.listExpiredAgentPendingActions(now, limit);
    const byConversation = new Map<string, IAgentPendingAction[]>();
    for (const action of due) {
        const list = byConversation.get(action.conversationId) ?? [];
        list.push(action);
        byConversation.set(action.conversationId, list);
    }

    for (const [conversationId, actions] of byConversation) {
        try {
            const first = actions[0];
            const conversation = await db.findAgentConversationById(conversationId);
            if (!conversation || conversation.runtimeStatus !== 'requires_action') {
                // The session moved on (a new message cancelled it, or it was deleted).
                for (const action of actions) {
                    await db.updateAgentPendingAction(String(action._id), { status: 'cancelled', resolvedAt: now, resolvedBy: 'system:timeout' });
                }
                continue;
            }
            const hitl = await hitlSettingsFor(db, first);
            const scope = { tenantDbName, tenantId: first.tenantId, projectId: first.projectId, agentKey: first.agentKey, conversationId };
            const events: Array<{ type: 'action.resolved' | 'session.status_idle' | 'agent.tool_result'; data: Record<string, unknown> }> = [];
            const snapshots = new Map<string, { status: IAgentPendingAction['status']; resolution?: IAgentPendingActionResolution }>();
            // A page that never answered is a failed tool call the model reads and goes on from, whatever
            // the agent's `onTimeout` says about approvals: the answer is spent, so `cancel` does not apply.
            let resolvedAny = false;

            for (const action of actions) {
                if (hitl.onTimeout === 'cancel' && action.kind !== 'client_tool') {
                    const updated = await db.updateAgentPendingAction(String(action._id), {
                        status: 'expired', resolvedAt: now, resolvedBy: 'system:timeout', resolution: { cancelled: true },
                    });
                    if (!updated) continue;
                    result.expired += 1;
                    auditSystemResolution(tenantDbName, action, { status: 'expired', resolution: { cancelled: true } });
                    snapshots.set(String(action._id), { status: 'expired', resolution: { cancelled: true } });
                    events.push({
                        type: 'action.resolved',
                        data: actionResolvedEventData(action, { expired: true, cancelled: true, resolvedBy: 'system:timeout', channel: 'timeout' }),
                    });
                    continue;
                }
                const resolution: IAgentPendingActionResolution = action.kind === 'tool_approval'
                    ? { decision: 'deny', comment: 'timed out' }
                    : action.kind === 'client_tool'
                        ? {
                            error: CLIENT_TOOL_UNANSWERED_MESSAGE,
                            timedOut: true,
                            durationMs: Math.max(0, now.getTime() - new Date(action.requestedAt).getTime()),
                        }
                        : { cancelled: true };
                const updated = await db.updateAgentPendingAction(String(action._id), {
                    status: 'resolved', resolvedAt: now, resolvedBy: 'system:timeout', resolution,
                });
                if (!updated) continue;
                result.denied += 1;
                auditSystemResolution(tenantDbName, action, { status: 'resolved', resolution });
                resolvedAny = true;
                snapshots.set(String(action._id), { status: 'resolved', resolution });
                if (action.kind === 'client_tool') events.push(clientToolResultEvent(action, resolution));
                events.push({
                    type: 'action.resolved',
                    data: actionResolvedEventData(action, {
                        ...(resolution.decision ? { decision: resolution.decision } : {}),
                        ...(resolution.cancelled ? { cancelled: true } : {}),
                        ...(action.kind === 'client_tool' ? { ok: false, durationMs: resolution.durationMs, timedOut: true } : {}),
                        expired: true,
                        resolvedBy: 'system:timeout',
                        channel: 'timeout',
                    }),
                });
            }
            if (snapshots.size === 0) continue;

            const messages = updateMessageSnapshots(conversation.messages ?? [], snapshots);
            await db.updateAgentConversation(conversationId, { messages });

            const open = await db.listAgentPendingActions(conversationId, { status: 'pending' });
            if (open.length > 0) {
                await db.updateAgentConversationRuntime(conversationId, { pendingActionIds: open.map((entry) => String(entry._id)) });
                await writeSessionEvents(db, scope, events);
                continue;
            }

            if (hitl.onTimeout === 'cancel' && !resolvedAny) {
                await dropPausedSnapshot(db, conversationId, {
                    outcome: 'expired',
                    resolvedBy: 'system:timeout',
                    actions: actions.filter((action) => snapshots.get(String(action._id))?.status === 'expired'),
                    projectId: first.projectId,
                    tenantId: first.tenantId,
                    tenantDbName,
                });
                await db.updateAgentConversationRuntime(conversationId, {
                    runtimeStatus: 'idle', stopReason: 'cancelled', pendingActionIds: [],
                });
                events.push({ type: 'session.status_idle', data: { stopReason: 'cancelled' } });
                await writeSessionEvents(db, scope, events);
                await closePausedRuns(db, first);
                continue;
            }

            await writeSessionEvents(db, scope, events);
            const queued = await queueAgentRunResume({
                tenantDbName,
                tenantId: first.tenantId,
                projectId: first.projectId,
                agentKey: first.agentKey,
                conversationId,
                userId: RESUME_TIMEOUT_ACTOR,
                resumeActionIds: await answeredActionIds(db, conversationId),
                actorType: 'system',
            });
            if (queued.kind === 'queued') result.continued += 1;
            else logger.warn('Could not continue a timed-out turn: the conversation is busy', { conversationId });
        } catch (error) {
            logger.warn('Could not handle an expired pending action', {
                conversationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return result;
}

/** A timeout cancelled the request: a background run waiting on it ends as cancelled. */
async function closePausedRuns(db: DatabaseProvider, action: IAgentPendingAction): Promise<void> {
    const paused = await db.listAgentRuns({
        tenantId: action.tenantId,
        projectId: action.projectId,
        conversationId: action.conversationId,
        status: ['requires_action'],
        limit: 5,
    });
    for (const run of paused) {
        await db.finalizeAgentRun(String(run._id), action.tenantId, {
            status: 'canceled',
            errorReason: 'canceled_by_caller',
            stopReason: 'cancelled',
            completedAt: new Date(),
            runtimeContext: null,
        });
    }
}
