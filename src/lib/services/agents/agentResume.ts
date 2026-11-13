/**
 * Agent resume: continuing a paused turn (approvals and questions answered) or a budget-stopped session.
 */

import { channelFromSource, noteRoutingRun, runWithRoutingCaller, type RoutingCallerContext } from '@/lib/services/models/routingCallerContext';
import type { AgentInvokeResult as AgentSdkInvokeResult, Message as AgentSdkMessage, SmartAgentEvent as AgentSdkEvent } from '@cognipeer/agent-sdk';
import { assertAgentsEnabled } from './agentServiceAvailability';
import {
    getDatabase,
    type AgentResponseFormat,
    type IAgent,
    type IAgentConfig,
    type IAgentConversation,
    type IAgentPendingAction,
    type IAgentPendingActionResolution,
} from '@/lib/database';
import { KnowledgeExposure, runWithKnowledgeExposure } from '@/lib/services/rag/access';
import { consoleIdentityOfPausedTurn, consoleIdentityPersonOf } from '@/lib/iam/consoleIdentity';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import { type AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { addPlaygroundUsage, normalizePlaygroundUsage, pausedLegsUsage } from './playgroundUsage';
import { annotateAgentRunError } from './agentErrors';
import { assertAgentTurnSpendAllowed, resolveAgentSpendScope } from './agentSpendLimits';
import {
    endsInAnswer,
    isSessionBudgetBreach,
    planSessionBudget,
    sessionBudgetInvokeOptions,
    startSessionSpendAccount,
    settleSessionBudget,
} from './sessionBudget';
import { addSessionTurnSpend, recordSessionTurnSpend } from './sessionBudgetService';
import { compactedToolResults, endedByCallerAbort, buildContinueInputState, loadConversationState, saveConversationState } from './agentTurnState';
import { type SessionStopReason } from './sessionEvents';
import { startSessionTurnEvents, type SessionTurnEvents } from './sessionTurnEvents';
import { resumedDelegationIds } from './subagentEvents';
import { createTurnFlowTracker, subagentTargets } from './turnFlowTracker';
import { type AgentCompactionEvent, type AgentPlanEvent, type AgentSubagentEvent } from '@/lib/shared/agentTurnFlow';
import { resolveAgentConfig } from './agentConfigResolution';
import { activeSubagentEntries } from './subagentRoster';
import {
    clientToolErrorText,
    clientToolMeta,
    clientToolOutputText,
    clientToolPolicyName,
    resolveClientToolState,
    type EmbeddedRunContext,
} from './agentClientTools';
import { additionalModelKeys, applyAgentModelChoice } from './agentModelSelection';
import { agentShowsReasoning, applyModelToConfig } from './agentReasoning';
import {
    AgentResumeError,
    PAUSE_UNAVAILABLE_WARNING,
    pauseUnavailableOutcome,
    actionRequiredEventData,
    openPause,
    parsePausedState,
    toMessagePendingAction,
    toPublicPendingAction,
    toSdkAnswerSet,
    type OpenedPause,
    type PausedTurnOptions,
} from './agentPendingActions';
import { type AgentToolGuard } from './agentToolGuard';
import {
    CALLER_ABORT_DETAIL,
    bridgeCancellationCell,
    captureStreamedText,
    isCancellationCellTripped,
    type AgentChatResponse,
    type AgentPlaygroundChatResult,
    type AgentRunCancellationCell,
    type AgentToolCallEvent,
} from './agentChatTypes';
import { budgetAwareOutcome, priceAgentTurn } from './agentCost';
import { bindKnowledgeExposure } from './agentKnowledgeTools';
import { guardrailBlockedError } from './agentGuardrails';
import { runBoundToolCleanup } from './agentBoundTools';
import { describeRunOutcome } from './agentRecords';
import { answeredWithMetadata, createReasoningTap, liveStreamOptions, createTurnFlowSink, turnFlowRecord, turnReasoning } from './agentStreamTaps';
import { outputFileEvents, mergeSessionRuntimeContext } from './agentAttachments';
import { buildLocalAgentRun, agentMayStreamAnswer, firstTurnTitle, sessionStopReason, toAgentChatResponse } from './agentChatRun';
import { createRunCheckpointer, settleInterruptedToolCalls, stampRunTurn, type CheckpointTurn, type DurableTurn, type LoadedCheckpoint } from './runCheckpoint';
import { stepsOfTurnInProgress } from './agentRuntimeConfig';
import { extractPlaygroundSteps, describeStructuredOutputError } from './agentPlaygroundSteps';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';

const logger = createLogger('agents');

// ── Continuing a paused turn ────────────────────────────────────────────

/** The resumed leg of a run: the same scope as the turn that paused (see `routingCallerOf`). */
function resumeCallerOf(request: AgentResumeRequest): RoutingCallerContext {
    const synthetic = !request.userId || request.userId.startsWith('system:') || request.userId === 'a2a-public';
    const runtime = request.runtimeContext;
    return {
        channel: channelFromSource(runtime?.source) ?? (request.unattended ? 'api' : 'dashboard'),
        agentKey: request.agentKey,
        projectId: request.projectId,
        ...(synthetic ? {} : { userId: request.userId }),
        ...(runtime?.tokenId ? { apiTokenId: runtime.tokenId } : {}),
        run: { conversationId: request.conversationId, ...(request.runId ? { runId: request.runId } : {}) },
    };
}

export interface AgentResumeRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    /** Who drives the continuation (the approver, or the turn's owner for a timeout). */
    userId: string;
    /** Whose spend limits the continuation counts against when the turn's owner is synthetic (a trigger run). */
    accountableUserId?: string;
    trigger: 'resume' | 'timeout';
    /** The background run executing this continuation, when there is one. */
    runId?: string;
    runtimeContext?: AgentRuntimeContext;
    /**
     * The turn's per-request structured output / variables (the run row's, for a queued
     * continuation). A paused turn carries its own with the paused state, which
     * wins when this is absent; a budget continuation has only these.
     */
    responseFormat?: AgentResponseFormat;
    variables?: Record<string, unknown>;
    variablesInPrompt?: boolean;
    /** With `variablesInPrompt: false`: the names of `variables` that may still fill the prompt (see `AgentChatRequest`). */
    literalVariables?: string[];
    cancellationCell?: AgentRunCancellationCell;
    signal?: AbortSignal;
    onToolEvent?: (event: AgentToolCallEvent) => void;
    onTextChunk?: (text: string) => void;
    onReasoningChunk?: (text: string) => void;
    onCompaction?: (compaction: AgentCompactionEvent) => void;
    onPlan?: (plan: AgentPlanEvent) => void;
    onSubagent?: (event: AgentSubagentEvent) => void;
    /** Called right before the SDK loop is invoked — after this the answers are spent. */
    onInvokeStart?: () => void;
    /** The host page this continuation answers for, when the chat is embedded — see `AgentPlaygroundChatRequest.embedded`. */
    embedded?: EmbeddedRunContext;
    /** The continuation of an unattended caller (see `AgentChatRequest.unattended` / `answersClientTools`). */
    unattended?: boolean;
    answersClientTools?: boolean;
    /**
     * Set to continue a session that stopped on its spend budget rather than on
     * a pause: there are no answers to apply and no new user message — the loop
     * is invoked on the state the session ended in and the model carries on from
     * its last tool results. `source` is the surface it belongs to (the
     * dashboard's playground or the live API); `usePublished` / `version` pick
     * the config the way a normal turn does.
     */
    continuation?: {
        source: 'agent' | 'agent-playground';
        usePublished?: boolean;
        version?: number;
        /**
         * Durable runs: continue a turn that was cut off on another node, from its
         * checkpoint instead of the stored conversation state. The session is still
         * marked running (that turn never ended) and the transcript does not have
         * the turn yet: a chat turn's user message is written with the answer.
         */
        recovery?: LoadedCheckpoint;
    };
    /** Durable runs: set for a run that writes checkpoints (see runCheckpoint.ts). */
    durable?: DurableTurn;
}

export interface AgentResumeResult {
    /** The new assistant message, in the dashboard playground's shape. */
    result: AgentPlaygroundChatResult;
    /** The same turn in the Responses shape (`requires_action` when it paused again). */
    response: AgentChatResponse;
    stopReason: SessionStopReason;
}

/** What a continuation reads back about the pause it continues. */
async function loadPausedRun(
    db: Awaited<ReturnType<typeof getDatabase>>,
    request: Pick<AgentResumeRequest, 'projectId' | 'agentKey' | 'conversationId'>,
) {
    const conversation = await db.findAgentConversationById(request.conversationId);
    if (!conversation || conversation.projectId !== request.projectId || conversation.agentKey !== request.agentKey) {
        throw new Error(`Conversation "${request.conversationId}" not found`);
    }
    const stored = await db.findAgentConversationState(request.conversationId);
    const paused = stored?.pausedSnapshot ? parsePausedState(stored.pausedSnapshot) : null;
    if (!paused) {
        throw new AgentResumeError('This run can no longer be continued: its paused state was not found.', 409, { stateLost: true });
    }
    const actions = await db.listAgentPendingActions(request.conversationId);
    const bySdkId = new Map(actions.map((action) => [action.sdkId, action]));
    const approvals = (paused.state.pendingApprovals ?? []).filter((entry) => entry.status === 'pending');
    const questions = (paused.state.pendingUserQuestions ?? []).filter((entry) => entry.status === 'pending');
    if (approvals.length + questions.length === 0) {
        throw new AgentResumeError('This run is not waiting for anything.', 409, { stateLost: true });
    }
    const open = [...approvals, ...questions].filter((entry) => bySdkId.get(entry.id)?.status !== 'resolved');
    if (open.length > 0) throw new AgentResumeError('Not every pending action has been answered yet.');
    const anchor = bySdkId.get(approvals[0]?.id ?? questions[0].id)!;

    const agent = await db.findAgentByKey(request.agentKey, request.projectId);
    if (!agent) throw new Error(`Agent "${request.agentKey}" not found`);
    // The same agent the paused turn ran: its pinned version, or the draft.
    let config: IAgentConfig = agent.config;
    const version = anchor.agentVersion ?? null;
    if (version !== null) {
        const snapshot = await db.findAgentVersion(String(agent._id), version);
        if (!snapshot) throw new Error(`Version ${version} not found for agent "${request.agentKey}"`);
        config = snapshot.snapshot.config;
    }
    return { conversation, agent, config, version, paused, approvals, questions, bySdkId };
}

/**
 * What continuing a budget-stopped session reads back: the conversation, the
 * config the continuation runs with, and the state the session ended in. Refuses
 * (409) a session that did not stop on its budget, is waiting for a person, or
 * has no stored state to carry on from.
 */
async function loadContinuationRun(
    db: Awaited<ReturnType<typeof getDatabase>>,
    request: Pick<AgentResumeRequest, 'tenantDbName' | 'projectId' | 'agentKey' | 'conversationId'>,
    continuation: NonNullable<AgentResumeRequest['continuation']>,
) {
    const conversation = await db.findAgentConversationById(request.conversationId);
    if (!conversation || conversation.projectId !== request.projectId || conversation.agentKey !== request.agentKey) {
        throw new Error(`Conversation "${request.conversationId}" not found`);
    }
    // A recovered turn never ended: the session still says it is running, and the
    // state to go on from is the turn's checkpoint, not the session's last state.
    const recovery = continuation.recovery;
    if (recovery) {
        const { agent, config, version } = await continuationConfig(db, request, continuation);
        const settled = settleInterruptedToolCalls((recovery.carried.messages ?? []) as AgentSdkMessage[]);
        if (settled.interrupted.length > 0) {
            logger.info('Recovered turn: tool calls with an unknown outcome', {
                conversationId: request.conversationId,
                tools: settled.interrupted,
            });
        }
        return {
            conversation,
            agent,
            config,
            version,
            carried: { ...recovery.carried, messages: settled.messages },
            recoveredTurn: recovery.turn,
        };
    }
    if (conversation.runtimeStatus === 'requires_action') {
        throw new AgentResumeError('This session is waiting for an approval or an answer. Resolve it first.');
    }
    if (conversation.runtimeStatus === 'running') {
        throw new AgentResumeError('This session is running a turn right now.');
    }
    // `error`: an earlier attempt to continue failed — the stored state is untouched, so try again.
    if (conversation.stopReason !== 'budget_reached' && conversation.stopReason !== 'error') {
        throw new AgentResumeError('This session did not stop on its budget, so there is nothing to continue.');
    }
    const carried = await loadConversationState(db, conversation);
    if (!carried || !carried.messages?.length) {
        throw new AgentResumeError('This session can no longer be continued: its stored state was not found.');
    }
    // A transcript that already ends in the agent's own answer has nothing left to do
    // (the turn that crossed the budget can have finished with it).
    if (endsInAnswer(carried)) {
        throw new AgentResumeError('This session already ended with an answer, so there is nothing to continue.');
    }

    const { agent, config, version } = await continuationConfig(db, request, continuation);
    return { conversation, agent, config, version, carried, recoveredTurn: undefined as CheckpointTurn | undefined };
}

/** The agent and the config a continuation runs with: the published version asked for, else the draft. */
async function continuationConfig(
    db: Awaited<ReturnType<typeof getDatabase>>,
    request: Pick<AgentResumeRequest, 'tenantDbName' | 'projectId' | 'agentKey'>,
    continuation: NonNullable<AgentResumeRequest['continuation']>,
): Promise<{ agent: IAgent; config: IAgentConfig; version: number | null }> {
    if (continuation.usePublished || continuation.version !== undefined) {
        const resolved = await resolveAgentConfig(request.tenantDbName, request.agentKey, request.projectId, continuation.version);
        return { agent: resolved.agent, config: resolved.config, version: resolved.resolvedVersion };
    }
    const found = await db.findAgentByKey(request.agentKey, request.projectId);
    if (!found) throw new Error(`Agent "${request.agentKey}" not found`);
    return { agent: found, config: found.config, version: null };
}

/**
 * Do reviewer-edited arguments satisfy the tool's own schema? Checked before a
 * resolution is recorded (the caller answers 400), because the SDK itself would
 * only notice at execution. Builds the agent to read the tool's schema, so it
 * runs only when a reviewer actually changed the arguments.
 */
export async function validateApprovedArgs(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    userId: string;
    toolName: string;
    approvedArgs: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
    const db = await getDatabase();
    await db.switchToTenant(input.tenantDbName);
    const conversation = await db.findAgentConversationById(input.conversationId);
    if (!conversation || conversation.projectId !== input.projectId) throw new Error(`Conversation "${input.conversationId}" not found`);
    const agent = await db.findAgentByKey(input.agentKey, input.projectId);
    if (!agent) throw new Error(`Agent "${input.agentKey}" not found`);

    const built = await buildLocalAgentRun({
        db,
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentKey: input.agentKey,
        agent,
        config: agent.config,
        actorId: input.userId,
        source: 'agent',
        route: 'agent.chat',
        userId: input.userId,
        conversation,
        memoryConversationId: input.conversationId,
        threadId: input.conversationId,
    });
    try {
        const tool = built.tools.find((candidate) => candidate.name === input.toolName);
        // A tool this agent no longer has cannot be validated; the resume reports it.
        if (!tool) return { ok: true };
        const { validateToolArgs } = await import('@cognipeer/agent-sdk');
        const checked = validateToolArgs(tool, input.approvedArgs);
        return checked.ok ? { ok: true } : { ok: false, message: checked.message };
    } finally {
        await runBoundToolCleanup(built.cleanupTasks, { agentKey: input.agentKey, mode: 'chat' });
    }
}

/**
 * Continues a session that stopped on its spend budget, after the budget was
 * raised: the same smart loop, invoked on the state the session ended in with no
 * new user message. The result is a NEW assistant message, like a resume.
 */
export function executeAgentContinueLocal(
    request: Omit<AgentResumeRequest, 'trigger' | 'continuation'> & {
        continuation: NonNullable<AgentResumeRequest['continuation']>;
    },
): Promise<AgentResumeResult> {
    return executeAgentResumeLocal({ ...request, trigger: 'resume' });
}

/**
 * Continues a paused turn once every pending action is answered: the agent is
 * rebuilt from the config the paused turn used, the stored state is restored,
 * each resolution is applied with the SDK (`resolveToolApproval` /
 * `resolveUserQuestion`) and the same smart loop is invoked again — so an
 * approved tool runs, a denied one reaches the model as a refusal, and the
 * turn can finish or pause again. The result is a NEW assistant message; there
 * is no new user message.
 */
export async function executeAgentResumeLocal(request: AgentResumeRequest): Promise<AgentResumeResult> {
    await assertAgentsEnabled(request);
    const scope: { events?: SessionTurnEvents } = {};
    try {
        return await runWithRoutingCaller(resumeCallerOf(request), () => runWithKnowledgeExposure(new KnowledgeExposure(), () => runAgentResumeTurn(request, scope)));
    } catch (error) {
        await scope.events?.fail(error).catch(() => undefined);
        throw error;
    }
}

/**
 * What the model reads as the result of a client tool: the page's output as
 * text, run through the agent's `tool.post` guardrails like any tool result
 * (the page's data is user input, so it is no more trusted than a connector's),
 * or the error line when the page could not do it. A result that cannot be
 * checked is withheld. The untrusted notice is added where the answer is applied
 * (`resolveClientToolState`), after the guardrails have seen the plain text.
 */
async function clientToolContent(
    guard: Pick<AgentToolGuard, 'protect'>,
    call: { name: string; args: unknown },
    resolution: IAgentPendingActionResolution,
): Promise<string> {
    if (resolution.error !== undefined) return clientToolErrorText(resolution.error);
    const text = clientToolOutputText(resolution.output);
    try {
        const screened = await guard.protect<Record<string, unknown>, string>(
            { name: clientToolPolicyName(call.name), requestedName: call.name },
            async () => text,
        )((call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>);
        return typeof screened === 'string' ? screened : clientToolOutputText(screened);
    } catch (error) {
        logger.warn('A client tool result could not be checked and was withheld', {
            tool: call.name,
            error: error instanceof Error ? error.message : String(error),
        });
        return clientToolErrorText('The result could not be checked and was withheld.');
    }
}

async function runAgentResumeTurn(
    request: AgentResumeRequest,
    scope: { events?: SessionTurnEvents },
): Promise<AgentResumeResult> {
    const { tenantDbName, tenantId, projectId, agentKey, conversationId } = request;
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    // A pause to continue — or, for a budget-stopped session, the state it ended in.
    let pausedRun: Awaited<ReturnType<typeof loadPausedRun>> | null = null;
    let continued: Awaited<ReturnType<typeof loadContinuationRun>> | null = null;
    if (request.continuation) {
        continued = await loadContinuationRun(db, request, request.continuation);
    } else {
        try {
            pausedRun = await loadPausedRun(db, request);
        } catch (error) {
            // The state this run would continue from is gone: the session is not
            // waiting for anything any more, so it must not keep saying it is.
            if (error instanceof AgentResumeError && error.stateLost) {
                await db.updateAgentConversationRuntime(conversationId, {
                    runtimeStatus: 'idle', stopReason: 'error', pendingActionIds: [],
                }).catch(() => undefined);
            }
            throw error;
        }
    }
    const loaded = (pausedRun ?? continued)!;
    const { conversation, agent, version } = loaded;
    const recoveredTurn = continued?.recoveredTurn;
    // A turn that paused resumes on the model it ran with (stored on the session when the request was authorized).
    const config: IAgentConfig = additionalModelKeys(loaded.config).length > 0
        ? applyModelToConfig(loaded.config, applyAgentModelChoice(loaded.config, { sessionMetadata: conversation.metadata, background: true }).modelKey)
        : loaded.config;
    const paused = pausedRun?.paused ?? null;
    const approvals = pausedRun?.approvals ?? [];
    const questions = pausedRun?.questions ?? [];
    const bySdkId = pausedRun?.bySdkId ?? new Map<string, IAgentPendingAction>();
    const source: 'agent' | 'agent-playground' = paused?.source ?? request.continuation!.source;
    // The turn's own structured output and variables: the request's, else the ones the pause stored.
    const turnOptions: PausedTurnOptions = {
        ...(paused?.turn ?? {}),
        ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
        ...(request.variables ? { variables: request.variables } : {}),
        ...(request.variablesInPrompt === false ? { variablesInPrompt: false } : {}),
        ...(request.literalVariables ? { literalVariables: request.literalVariables } : {}),
    };
    const startedAt = Date.now();

    // The session's own budget and the tenant's spend limit, before the model is
    // called. A refusal here comes before `onInvokeStart`, so a pause's answers
    // are not spent and can be given again once the limit is lifted.
    const budgetPlan = planSessionBudget(conversation, config.runtime?.limits?.maxCostUsd);
    const spendAccount = budgetPlan ?? startSessionSpendAccount(conversation);
    // A continued pause is the spend of whoever started the turn, not of the approver.
    const anchorAction = bySdkId.get(approvals[0]?.id ?? questions[0]?.id ?? '');
    const spend = config.modelKey
        ? await resolveAgentSpendScope({
            tenantDbName, tenantId, projectId, userId: request.accountableUserId ?? anchorAction?.createdBy ?? request.userId,
        })
        : undefined;
    if (spend) await assertAgentTurnSpendAllowed(spend, config);

    // Same merge as a playground turn: the session's context under the caller's.
    const runtimeContext = mergeSessionRuntimeContext(conversation, request.runtimeContext);
    // A continued pause calls MCP servers and connected agents for the person whose turn it is, never for whoever answered it.
    const pausedFor = paused
        ? consoleIdentityOfPausedTurn({
            stored: paused.turn?.identity,
            ...(anchorAction?.createdBy ? { startedBy: anchorAction.createdBy } : {}),
            ...(runtimeContext?.source ? { source: runtimeContext.source } : {}),
            ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
        })
        : undefined;

    // Durable runs: the continuation checkpoints itself like a first turn (runCheckpoint.ts).
    // A recovered chat turn keeps recording the user message it still owes the transcript.
    const checkpointer = request.durable && request.runId
        ? createRunCheckpointer({
            db,
            runId: request.runId,
            tenantId,
            conversationId,
            generation: request.durable.generation,
            deadlineAt: request.cancellationCell?.deadlineAt ?? Date.now() + getConfig().agent.backgroundMaxDurationMs,
            intervalMs: getConfig().agent.checkpointIntervalMs,
            turn: () => recoveredTurn ?? { kind: 'resume' },
            onFenced: () => {
                if (request.cancellationCell) request.cancellationCell.cancelled = true;
            },
        })
        : undefined;
    if (checkpointer && request.cancellationCell) request.cancellationCell.checkpointer = checkpointer;

    const { sdkAgent, model, systemPrompt, cleanupTasks, warnings, hitl, costEstimator, toolGuard, tappedUsd, routedModel, outputLimit, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity, hitlLog } = await buildLocalAgentRun({
        db,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        agent,
        config,
        runtimeContext,
        ...(request.embedded ? { embedded: request.embedded } : {}),
        ...(request.unattended ? { unattended: true } : {}),
        ...(request.answersClientTools ? { answersClientTools: true } : {}),
        actorId: source === 'agent' ? request.userId : `agent:${agentKey}`,
        source,
        route: source === 'agent' ? 'agent.chat' : 'agent.playground',
        userId: request.userId,
        ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
        ...(pausedFor ? { identity: pausedFor } : {}),
        version,
        conversation,
        memoryConversationId: conversationId,
        threadId: conversationId,
        ...(spend ? { spend } : {}),
        ...(turnOptions.responseFormat ? { responseFormat: turnOptions.responseFormat } : {}),
        ...(turnOptions.variables ? { variables: turnOptions.variables } : {}),
        ...(turnOptions.variablesInPrompt === false ? { variablesInPrompt: false } : {}),
        ...(turnOptions.literalVariables ? { literalVariables: turnOptions.literalVariables } : {}),
        ...(checkpointer ? { checkpointer } : {}),
        ...(recoveredTurn && continued ? { recoveredTurnSteps: stepsOfTurnInProgress(continued.carried.messages ?? []) } : {}),
        // A continued turn already holds tool results and answers from outside.
        reminders: {
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
            ...(version != null ? { version, usePublished: true } : { usePublished: false }),
            startsTainted: true,
        },
    });

    try {
        const turnEvents = startSessionTurnEvents({
            db,
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            conversationId,
            ...(request.runId ? { runId: request.runId } : {}),
            trigger: request.trigger,
            superseded: () => request.cancellationCell?.abandoned === true,
        });
        scope.events = turnEvents;
        noteRoutingRun({ conversationId, turnId: turnEvents.turnId });
        await bindKnowledgeExposure(db, conversation);
        const onTextChunk = request.onTextChunk
            ? (text: string) => {
                turnEvents.onText(text);
                request.onTextChunk?.(text);
            }
            : undefined;
        const onReasoningChunk = request.onReasoningChunk
            ? (text: string) => {
                turnEvents.onReasoning(text);
                request.onReasoningChunk?.(text);
            }
            : undefined;

        // Apply every answer with the SDK, then run the loop again. A budget-stopped
        // session has no answers: it carries on from the state it ended in.
        let state = paused
            ? paused.state
            : buildContinueInputState({
                carried: continued!.carried,
                // The dashboard playground hands the agent its prompt as a message.
                ...(source === 'agent-playground' && systemPrompt ? { systemPrompt } : {}),
            });
        // The calls the state held BEFORE the answers went in: a client tool's step is written by
        // the answer (below), and belongs to the message this continuation writes.
        const priorExecutionIds = new Set(
            (state.toolHistory ?? [])
                .map((entry) => (entry as { executionId?: unknown }).executionId)
                .filter((id): id is string => typeof id === 'string'),
        );
        try {
            for (const entry of approvals) {
                const action = bySdkId.get(entry.id)!;
                const resolution = action.resolution ?? {};
                state = sdkAgent.resolveToolApproval(state, {
                    id: entry.id,
                    approved: resolution.decision === 'allow',
                    ...(resolution.approvedArgs ? { approvedArgs: resolution.approvedArgs } : {}),
                    ...(action.resolvedBy ? { decidedBy: action.resolvedBy } : {}),
                    ...(resolution.comment ? { comment: resolution.comment } : {}),
                });
            }
            for (const entry of questions) {
                const action = bySdkId.get(entry.id)!;
                const resolution = action.resolution ?? {};
                const clientTool = clientToolMeta(entry as { metadata?: Record<string, unknown> });
                if (clientTool) {
                    // A tool the host page ran: its result (or its failure) is the tool's result.
                    state = resolveClientToolState(state, {
                        sdkId: entry.id,
                        ...(resolution.error !== undefined ? { error: resolution.error } : { output: resolution.output }),
                        content: await clientToolContent(toolGuard, clientTool, resolution),
                        ...(resolution.durationMs !== undefined ? { durationMs: resolution.durationMs } : {}),
                        ...(action.resolvedBy ? { answeredBy: action.resolvedBy } : {}),
                    });
                    continue;
                }
                state = sdkAgent.resolveUserQuestion(state, {
                    id: entry.id,
                    answers: toSdkAnswerSet(entry.questions, resolution.answers),
                    cancelled: resolution.cancelled === true,
                    ...(action.resolvedBy ? { answeredBy: action.resolvedBy } : {}),
                });
            }
        } catch (error) {
            throw new AgentResumeError(error instanceof Error ? error.message : 'The answers could not be applied.', 400);
        }

        // Read now: the SDK deletes each entry as its delegation completes.
        const reEntered = resumedDelegationIds(state);
        const inputMessageCount = (state.messages ?? []).length;
        const flow = createTurnFlowTracker({ resumedDelegationIds: reEntered, targets: subagentTargets(activeSubagentEntries(config)) });
        const flowSink = createTurnFlowSink({
            tracker: flow,
            turnEvents,
            agentKey,
            resumedCalls: reEntered,
            onToolEvent: request.onToolEvent,
            onCompaction: request.onCompaction,
            onPlan: request.onPlan,
            onSubagent: request.onSubagent,
        });
        const streamed = captureStreamedText(onTextChunk);
        const reasoningTap = createReasoningTap(onReasoningChunk, agentKey, agentShowsReasoning(config) || source === 'agent-playground');
        const cancellationBridge = bridgeCancellationCell(request.cancellationCell, request.signal);
        const invokeConfig = {
            onEvent: (event: AgentSdkEvent) => {
                reasoningTap.onEvent(event);
                noteSdkEvent(event);
                flowSink(event);
            },
            ...liveStreamOptions(agentMayStreamAnswer(config) ? streamed.onTextChunk : undefined, reasoningTap, agentKey),
            ...(cancellationBridge.signal ? { cancellationToken: cancellationBridge.signal } : {}),
            ...(request.cancellationCell?.deadlineAt !== undefined
                ? { timeoutMs: Math.max(0, request.cancellationCell.deadlineAt - Date.now()) }
                : {}),
            ...sessionBudgetInvokeOptions(budgetPlan),
            ...(checkpointer ? { onStateChange: checkpointer.onStateChange } : {}),
        };

        request.onInvokeStart?.();
        const settled: AgentSdkInvokeResult | null = await runWithTurnSignal(cancellationBridge.signal, () => sdkAgent.invoke(state, invokeConfig))
            .catch((error: unknown) => {
                if (request.signal?.aborted) return null;
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            })
            .finally(() => cancellationBridge.stop());

        const messageCountBefore = conversation.messages?.length ?? 0;
        if (!settled) {
            const aborted: AgentPlaygroundChatResult = {
                content: streamed.text(),
                latencyMs: Date.now() - startedAt,
                version,
                stopReason: 'cancelled',
                stopDetail: CALLER_ABORT_DETAIL,
                ...turnFlowRecord(flow, () => []),
            };
            await turnEvents.finish({ stopReason: 'cancelled', content: aborted.content, detail: CALLER_ABORT_DETAIL });
            return {
                result: aborted,
                response: toAgentChatResponse({
                    conversationId,
                    priorMessageCount: messageCountBefore,
                    agentName: agent.name,
                    version,
                    content: aborted.content,
                    messages: conversation.messages ?? [],
                    outcome: { stopReason: 'cancelled', stopDetail: CALLER_ABORT_DETAIL },
                }),
                stopReason: 'cancelled',
            };
        }
        const result = settled;

        const blocked = guardrailBlockedError(result);
        if (blocked) throw blocked;

        // `config.showReasoning: false` keeps the thinking text out of the API response, the
        // stored session message and Studio chat. The tokens were spent and are counted regardless.
        const assistantReasoning = agentShowsReasoning(config) ? turnReasoning(result, reasoningTap) : undefined;
        const turnOutcome = endedByCallerAbort(describeRunOutcome(result, inputMessageCount, outputLimit), request.signal);
        const usage = normalizePlaygroundUsage(result.metadata?.usage)?.usage;
        const flowRecord = turnFlowRecord(flow, () => compactedToolResults(state.messages as AgentSdkMessage[], result.state?.messages as AgentSdkMessage[] | undefined));
        const steps = extractPlaygroundSteps(result, priorExecutionIds, hitlLog);
        const costUsd = await priceAgentTurn({ plan: budgetPlan, result, costEstimator, pricing: model.pricing, model, usage });
        if (costUsd !== undefined && usage) usage.costUsd = costUsd;
        // The usage the turn reports (response, run result, `agent.message` event) is every leg of it —
        // the SDK counts only the leg it just ran. The stored message keeps its own leg.
        const earlierLegs = pausedRun ? pausedLegsUsage(conversation.messages ?? []) : undefined;
        const turnUsage = earlierLegs ? (usage ? addPlaygroundUsage(earlierLegs, usage) : earlierLegs) : usage;
        // The trace session spans every leg of the turn, so it is reconciled with all of them.
        await reconcileTrace(turnUsage);
        const budget = budgetPlan
            ? settleSessionBudget(budgetPlan, costUsd, isSessionBudgetBreach(budgetPlan, turnOutcome), turnOutcome.stopReason)
            : undefined;
        let outcome = budgetAwareOutcome(turnOutcome, budget);

        const superseded = isCancellationCellTripped(request.cancellationCell);
        let pause: OpenedPause | null = null;
        if (outcome.stopReason === 'paused' && !superseded) {
            const firstAction = anchorAction;
            const repausedFor = consoleIdentityPersonOf(identity);
            const repauseTurn: PausedTurnOptions = { ...turnOptions, ...(repausedFor ? { identity: repausedFor } : {}) };
            pause = await openPause(db, {
                state: result.state,
                source,
                tenantId,
                projectId,
                agentKey,
                conversationId,
                ...(request.runId ? { runId: request.runId } : {}),
                hitl,
                approvalLog: hitlLog,
                agentVersion: version,
                usePublished: firstAction?.usePublished ?? request.continuation?.usePublished ?? false,
                ...(Object.keys(repauseTurn).length > 0 ? { turn: repauseTurn } : {}),
                createdBy: firstAction?.createdBy ?? request.userId,
            });
            if (!pause) {
                // The run cannot be continued: it failed, and says so — not a quiet end of turn.
                warnings.add(PAUSE_UNAVAILABLE_WARNING);
                outcome = pauseUnavailableOutcome(outcome);
                await failTrace(PAUSE_UNAVAILABLE_WARNING);
            }
        }

        // Files the agent left in /outputs/ while the run continued (never fails the turn).
        const outputFiles = superseded ? { attachments: [], warnings: [] } : await collectOutputs();
        for (const warning of outputFiles.warnings) warnings.add(warning);

        const assistantMessage: IAgentConversation['messages'][number] = {
            role: 'assistant',
            content: outcome.content,
            timestamp: new Date(),
            ...answeredWithMetadata(model.key, additionalModelKeys(config).length > 0, routedModel()),
            ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
            ...(steps.length > 0 ? { steps } : {}),
            ...(outputFiles.attachments.length > 0 ? { attachments: outputFiles.attachments } : {}),
            ...(outcome.stopReason !== 'completed'
                ? { stopReason: outcome.stopReason, ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}) }
                : {}),
            ...flowRecord,
            ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
            ...(pause ? { pendingActions: pause.actions.map(toMessagePendingAction) } : {}),
            ...(usage ? { usage } : {}),
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.outputError ? { outputError: describeStructuredOutputError(result.outputError) } : {}),
            latencyMs: Date.now() - startedAt,
            version,
        };
        // A recovered chat turn writes the user message its first execution never got to write.
        const recoveredUser = recoveredTurn?.kind === 'chat' && recoveredTurn.userMessage
            ? [{ ...recoveredTurn.userMessage, timestamp: new Date(recoveredTurn.userMessage.timestamp ?? Date.now()) }]
            : [];
        if (request.durable) stampRunTurn(assistantMessage, request.durable.turnKey);
        const messages = [...(conversation.messages ?? []), ...recoveredUser, assistantMessage];

        if (!superseded) {
            const title = recoveredUser.length > 0
                ? firstTurnTitle(conversation, messages.length, recoveredUser[0].content, recoveredUser[0].attachments)
                : undefined;
            await db.updateAgentConversation(conversationId, { messages, ...(title ? { title } : {}) });
            await addSessionTurnSpend({ db, conversationId, plan: spendAccount, spentUsd: budget?.turnCostUsd ?? costUsd ?? 0 });
            await saveConversationState(db, {
                conversationId,
                tenantId,
                projectId,
                agentKey,
                state: result.state,
                messageCount: messages.length,
                ...(pause ? { pausedSnapshot: pause.snapshot } : {}),
            });
        }
        logger.info(superseded ? 'Agent resume completed but superseded (not persisted)' : 'Agent resume completed', {
            agentKey,
            conversationId,
            persisted: !superseded,
            ...(outcome.stopReason !== 'completed' ? { stopReason: outcome.stopReason, stopDetail: outcome.stopDetail } : {}),
        });

        for (const event of outputFileEvents(conversationId, outputFiles.attachments)) turnEvents.emitInTurn('agent.output_file', event);
        for (const action of pause?.actions ?? []) turnEvents.emitInTurn('action.required', actionRequiredEventData(action));
        const stopReason: SessionStopReason = superseded ? 'cancelled' : sessionStopReason(outcome.stopReason, pause, budget);
        await turnEvents.finish({
            stopReason,
            ...(pause ? { pendingActionIds: pause.actions.map((action) => String(action._id)) } : {}),
            content: outcome.content,
            messageIndex: messages.length - 1,
            ...(turnUsage ? { usage: { ...turnUsage } } : {}),
            ...(outcome.stopDetail ? { detail: outcome.stopDetail } : {}),
            ...(budget && !superseded ? { budget } : {}),
        });

        const { timestamp: _timestamp, role: _role, ...playground } = assistantMessage;
        void _timestamp; void _role;
        return {
            result: playground,
            response: toAgentChatResponse({
                conversationId,
                priorMessageCount: messageCountBefore,
                agentName: agent.name,
                version,
                content: outcome.content,
                messages,
                reasoning: assistantReasoning,
                outcome: budget?.reached ? { stopReason: 'budget_reached', stopDetail: outcome.stopDetail } : outcome,
                usage: turnUsage,
                outputParsed: result.output,
                outputError: result.outputError ? describeStructuredOutputError(result.outputError) : undefined,
                warnings,
                ...(pause ? { pendingActions: pause.actions.map(toPublicPendingAction) } : {}),
            }),
            stopReason,
        };
    } finally {
        await recordSessionTurnSpend({ db, conversationId, plan: spendAccount, tappedUsd: tappedUsd() });
        await runBoundToolCleanup(cleanupTasks, { agentKey, mode: source === 'agent' ? 'chat' : 'playground' });
    }
}
