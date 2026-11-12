/**
 * Agent Service
 *
 * Business logic for agent CRUD and chat orchestration.
 * Uses agent-sdk for runtime execution with automatic tracing.
 */

import { getFlowsHost, FlowsUnavailableError, type FlowAgentTurnActivity } from '@/enterprise/flows';
import type { AgentFlowReplyMeta } from '@/lib/flows/agentTypes';
import { channelFromSource, getRoutingCaller, noteRoutingRun, runWithRoutingCaller, type RoutingCallerContext } from '@/lib/services/models/routingCallerContext';

import { createLogger } from '@/lib/core/logger';
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { agentEntityId } from './agentEntityId';
import type {
    AgentInvokeResult as AgentSdkInvokeResult,
    Message as AgentSdkMessage,
    SmartAgentEvent as AgentSdkEvent,
    ToolInterface as AgentSdkToolInterface,
} from '@cognipeer/agent-sdk';
import { resolveAgentRuntimeOptions, resolveAgentSkillPolicy, resolveTurnOutputSchema } from './agentRuntimeConfig';
import { buildAgentSkills } from './agentSkillService';
import { buildAgentMemoryOption } from './agentMemoryAdapter';
import { resolveAgentMemoryStore } from './agentMemoryStore';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';
import { buildPromptVariables } from './promptVariables';
import { hasKnowledgeConfigured } from './agentKnowledgeBindings';
import { applyServiceAvailability, assertAgentsEnabled } from './agentServiceAvailability';
import {
    getDatabase,
    type AgentResponseFormat,
    type IAgent,
    type IAgentConfig,
    type IAgentConversation,
    type IAgentMessageAttachment,
    type IAgentPendingAction,
    type IAgentPendingActionResolution,
} from '@/lib/database';
import { KnowledgeExposure, kbReaderOfFollowUp, runWithKnowledgeExposure } from '@/lib/services/rag/access';
// Imported BY PATH because the barrel does not re-export it. `resolveBindings`
// is the ONE implementation of "which guardrails run on this hook"; a
// hand-rolled legacy fallback here would drift from the gateway's and produce a
// guardrail that silently stops running on one surface while the UI still shows
// it attached.
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import type { PluginMessageRewrite } from '@/lib/services/guardrail/sdkAdapter';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { consoleIdentityCallerOf, consoleIdentityOfPausedTurn, consoleIdentityPersonOf, type ConsoleIdentityCaller, type ConsoleIdentityPerson } from '@/lib/iam/consoleIdentity';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import { type TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { resolveRuntimeHeaders, type AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { invokeExternalAgent } from './externalAgent';
import { addPlaygroundUsage, normalizePlaygroundUsage, pausedLegsUsage } from './playgroundUsage';
import { createOutputLimitTap } from './outputLimitNotice';
import { createImageAwareTokenCounter } from './imageTokenCounter';
import { withSessionImages, type SessionImagesOptions } from './sessionImages';
import {
    createCompositeImageSource,
    createToolMediaStore,
    withToolMedia,
    type ToolMediaContext,
} from './toolMedia';
import { buildReadTool, readToolDefinition, READ_TOOL } from './readTool';
import { buildMemoryTools, memoryToolDefinitions } from './agentMemoryTools';
import { annotateAgentRunError } from './agentErrors';
import { toClientOutputFiles, toClientPendingAction, toFileAnnotations } from './clientWire';
import {
    agentTakesAttachments,
    buildSessionFileTools,
    buildUserTurnContent,
    conversationFileFacts,
    createSessionImageSource,
    resolveAttachmentsConfig,
    sessionFileToolDefinitions,
} from './sessionFiles';
import { neutralizeAttachmentMarker } from './sessionAttachmentText';
import { resolveModelCapabilities } from '@/lib/services/models/modelCapabilities';
import {
    agentSpendSettler,
    assertAgentTurnSpendAllowed,
    resolveAgentSpendScope,
    type AgentSpendScope,
} from './agentSpendLimits';
import {
    activeSessionBudget,
    endsInAnswer,
    isSessionBudgetBreach,
    planSessionBudget,
    sessionBudgetInvokeOptions,
    startSessionSpendAccount,
    settleSessionBudget,
    type SessionBudgetSettlement,
} from './sessionBudget';
import { addSessionTurnSpend, recordSessionTurnSpend } from './sessionBudgetService';
import { enforceAgentRunQuota, settleAgentRun } from './agentQuota';
import { createRunUsageSink, runWithUsageSink } from './runUsage';
import { buildAgentSandboxTools } from './agentSandboxTools';
import { withSandboxOutputsPrompt } from './agentSandboxOutputs';
import { buildFileOutputTools, fileOutputsPrompt, mergeOutputCollectors, type FileOutputTools } from './agentFileOutputTools';
import { buildReminderTools, reminderApprovalMode, reminderNoteText, remindersPrompt, type ReminderTools, type ReminderWake } from './agentReminderTools';
import { resolveRemindersConfig } from './agentRemindersConfig';
import { getConfig } from '@/lib/core/config';
import { inspectFileBucket } from './sessionFilesBucket';
import { outputsAvailability } from './sessionFilesConfig';
import {
    buildTurnInputState,
    compactedToolResults,
    endedByCallerAbort,
    buildContinueInputState,
    loadConversationState,
    saveConversationState,
    type AgentStopReason,
    type AgentTurnOutcome,
} from './agentTurnState';
import { toSessionStopReason, type SessionStopReason } from './sessionEvents';
import { startSessionTurnEvents, type SessionTurnEvents } from './sessionTurnEvents';
import { delegatedSubagentName, delegationFailure, resumedDelegationIds } from './subagentEvents';
import { createTurnFlowTracker, subagentTargets } from './turnFlowTracker';
import { type AgentCompactionEvent, type AgentPlanEvent, type AgentSubagentEvent } from '@/lib/shared/agentTurnFlow';
import { resolveAgentConfig } from './agentConfigResolution';
import { activeSubagentEntries } from './subagentRoster';
import {
    buildClientTools,
    checkEmbeddedClientTools,
    clientToolErrorText,
    clientToolMeta,
    clientToolNeedsApproval,
    clientToolSurfaceOf,
    clientToolsOnSurface,
    clientToolOutputText,
    clientToolPolicyName,
    resolveClientToolState,
    type EmbeddedRunContext,
} from './agentClientTools';
import { messageIdOf } from './messageIds';
import {
    applyToolApprovals,
    applyToolBlocks,
    clientApprovalConfig,
    denyUnattendedTools,
    resolveHitlConfig,
    resolveHitlRunMode,
    sessionAllowedTools,
} from './agentHumanInTheLoop';
import { createHitlCallLog, type HitlCallLog } from './agentHitlExceptions';
import { additionalModelKeys, applyAgentModelChoice, type AgentModelChoice } from './agentModelSelection';
import {
    agentReasoningForModel,
    agentShowsReasoning,
    applyModelToConfig,
    migrateAgentReasoning,
} from './agentReasoning';
import type { NormalizedReasoning } from '@/lib/services/models/reasoning';
import {
    AgentResumeError,
    PAUSE_UNAVAILABLE_WARNING,
    pauseUnavailableOutcome,
    actionRequiredEventData,
    assertNoBlockingPending,
    cancelPendingForNewMessage,
    openPause,
    parsePausedState,
    toMessagePendingAction,
    toPublicPendingAction,
    toSdkAnswerSet,
    type OpenedPause,
    type PausedTurnOptions,
    type PublicPendingAction,
} from './agentPendingActions';
import { composeUserMessageWithVariables } from './agentVariables';
import { createAgentToolGuard, protectBuiltTool, type AgentToolGuard } from './agentToolGuard';
import { CALLER_ABORT_DETAIL, agentRelayOptions, agentRunCallerOf, bridgeCancellationCell, captureStreamedText, incompleteReason, isCancellationCellTripped, toToolCallEvent, type AgentChatRequest, type AgentChatResponse, type AgentPlaygroundChatRequest, type AgentPlaygroundChatResult, type AgentPlaygroundStep, type AgentRunCancellationCell, type AgentToolCallEvent } from './agentChatTypes';
import { budgetAwareOutcome, buildAgentCostEstimator, priceAgentTurn } from './agentCost';
import { KNOWLEDGE_FIRST_INSTRUCTION, bindKnowledgeExposure, buildAgentKnowledgeTools, knowledgeCallerOf } from './agentKnowledgeTools';
import { evaluateBoundGuardrails, warnUnservableStreamBinding, buildAgentGuardrailPlugins, MessageRewriteLedger, agentMessageText, persistedUserTurn, warnUnservableExternalBindings, guardrailDenial, guardrailBlockedError } from './agentGuardrails';
import { buildTracingMetadata, reconcileTraceTotals, markTraceSessionFailed, createInternalTracingSink } from './agentTracing';
import { resolveAgentPrompt } from './agentPrompt';
import { assertOwnedAgentReachable, ownedAgentFlowTags, buildAgentSubagents } from './agentSubagents';
import { buildBoundTools, runBoundToolCleanup } from './agentBoundTools';
import { endRunsOfDroppedPause, MAX_PREVIOUS_VERSIONS, buildAgentChatModel, describeRunOutcome } from './agentRecords';
import {
    answeredWithMetadata,
    textStreamOptions,
    createReasoningTap,
    liveStreamOptions,
    createTurnFlowSink,
    turnFlowRecord,
    turnReasoning,
} from './agentStreamTaps';
import { resolveMessageAttachments, assembleMessageAttachments, earlierAttachments, outputFileEvents, mergeSessionRuntimeContext } from './agentAttachments';
export { knowledgeCallerOf, buildAgentKnowledgeTools } from './agentKnowledgeTools';
export { incompleteReason, agentRelayCallbacks } from './agentChatTypes';
export type { AgentRunCancellationCell, AgentChatRequest, AgentToolCallEvent, AgentPlaygroundChatRequest, AgentPlaygroundStep, AgentPlaygroundChatResult, ResponseOutputText, ResponseOutputMessage, ResponseReasoningItem, ResponseOutputItem, ResponseUsage, AgentChatResponse } from './agentChatTypes';
export { createAgentToolGuard } from './agentToolGuard';
export { AgentGuardrailBlockedError } from './agentGuardrails';
export { extractAgentReasoning, buildTracingMetadata, reconcileTraceTotals, markTraceSessionFailed, createInternalTracingSink, extractInternalTraceDiagnostics } from './agentTracing';
export { assertOwnedAgentReachable, buildAgentSubagents, buildSubagentModel } from './agentSubagents';
export type { AgentModelCaller, SubagentOutputOptions } from './agentSubagents';
export { buildBoundTools } from './agentBoundTools';
export { createAgentRecord, updateAgentRecord, deleteAgentRecord, getAgentById, getAgentByKey, listAgents, publishAgent, getAgentVersion, listAgentVersions, resolveAgentVoiceVersion, buildAgentChatModel, checkAgentModel } from './agentRecords';
export type { AgentModelCheckResult, AgentModelCall } from './agentRecords';
export { createConversation, getConversationById, listConversations, deleteConversation } from './agentConversations';
export type { AgentConversationSource } from './agentConversations';
export { createReasoningTap } from './agentStreamTaps';

const logger = createLogger('agents');

/**
 * EXPORTED FOR TESTS ONLY. These are module-private helpers whose whole job is
 * to notice something the SDK does not announce, or to compose several keys'
 * plugins; they need coverage that does not require standing up a real agent
 * and a real model.
 */
export const __testables = {
    textStreamOptions,
    createTurnFlowSink,
    turnFlowRecord,
    guardrailDenial,
    guardrailBlockedError,
    buildAgentGuardrailPlugins,
    MessageRewriteLedger,
    persistedUserTurn,
    firstTurnTitle,
    toToolCallEvent,
    buildAgentCostEstimator,
    priceAgentTurn,
};

// Lives in agentConfigResolution.ts (the spend pre-flight and the sub-agent roster need it without
// importing this module); the name stays here for every caller.
export { resolveAgentConfig } from './agentConfigResolution';

// ── Agent Chat Execution ─────────────────────────────────────────────

export async function executeAgentChat(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    // Agent-run quota: refuse before any work, count the tokens after. This is
    // the one place every sync entry point passes (see agentQuota.ts); the
    // queue consumer and background worker call the Local variant instead, so
    // a run is never counted twice.
    const caller = agentRunCallerOf(request);
    await assertAgentsEnabled(request);
    await enforceAgentRunQuota(caller);

    // The callback and the signal cannot be serialized over the queue —
    // stripped from the payload, kept on the local fast path, and bridged by
    // the cluster stream relay when the run is routed.
    const payload = { ...request };
    delete payload.onTextChunk;
    delete payload.onReasoningChunk;
    delete payload.signal;
    // What the run's model calls spend is tallied as they happen, so a run that fails or
    // is aborted late is still charged (see runUsage.ts).
    const usage = createRunUsageSink();
    let response: AgentChatResponse;
    try {
        response = await runWithUsageSink(usage, () => routeInstanceCall(
            {
                entityType: 'agent',
                entityId: agentEntityId(request.tenantId, request.agentKey),
                jobName: 'chat',
            },
            payload as unknown as QueuePayload,
            () => executeAgentChatLocal(request),
            {
                relay: agentRelayOptions(request),
                // A routed turn with a ceiling waits exactly as long as the ceiling
                // allows and is never retried: the queue default (60s, 3 attempts)
                // cut long turns off early and could re-run a turn's tool calls.
                ...(request.cancellationCell?.deadlineAt !== undefined
                    ? { timeoutMs: Math.max(1_000, request.cancellationCell.deadlineAt - Date.now()), attempts: 1 }
                    : {}),
            },
        ));
    } catch (error) {
        settleAgentRun(caller, usage);
        throw error;
    }
    settleAgentRun(caller, usage, response.usage?.total_tokens);
    return response;
}

/**
 * One turn of a connected (external) agent: invoked over HTTP, no local runtime.
 *
 * THE TEXT HOOKS ARE THE WHOLE ENFORCEMENT SURFACE HERE, and that is a
 * property of the wire, not an omission: a connected agent runs on the far
 * side of one HTTP call — we send text and get text back. Its tools are
 * chosen, executed and returned by the remote runtime, so no tool name,
 * no argument object and no tool result ever crosses into this process and
 * there is nothing for `tool.pre` / `tool.post` to evaluate. That is why
 * `createAgentToolGuard` is deliberately NOT built on this branch, and why
 * a tool binding on a connected agent is warned about rather than quietly
 * dropped: silent non-enforcement is the failure this plane exists to end.
 *
 * STREAMING (`onTextChunk`). A connected agent WITHOUT an `output.pre`
 * binding that answers over SSE has its text handed to the caller as it
 * arrives (there is no output check it could bypass). An agent bound to
 * `output.pre` never streams (agentMayStreamAnswer): its answer is guarded
 * first and then emitted as a single chunk — the same path as an agent that
 * answers in one piece — so nothing unchecked reaches the caller.
 *
 * ABORT (`signal`). The turn resolves with `cancelled: true` and the text
 * already emitted. That partial answer is guarded only when `persistPartial`
 * says it is about to be written somewhere; otherwise it is returned as is —
 * it is exactly the text the caller has already received chunk by chunk
 * (nothing, for a guarded agent, which never streams).
 *
 * Returns the guarded user message (what went upstream), the moment it was
 * sent, and the guarded answer.
 */
async function runExternalAgentTurn(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    config: IAgentConfig;
    connection: NonNullable<IAgentConfig['connection']>;
    history: Array<{ role: string; content: string }>;
    userMessage: string;
    runtimeContext?: AgentRuntimeContext;
    /** A trigger run's accountable person: a connection set up for Console identity gets a token for them. */
    accountableUserId?: string;
    source: 'agent' | 'agent-playground';
    onTextChunk?: (text: string) => void;
    signal?: AbortSignal;
    persistPartial?: boolean;
}): Promise<{ userMessage: string; sentAt: Date; content: string; cancelled: boolean }> {
    const { tenantDbName, tenantId, projectId, agentKey, config, connection, source, onTextChunk } = input;
    warnUnservableExternalBindings(config, agentKey);

    const userMessage = await evaluateBoundGuardrails({
        tenantDbName, tenantId, projectId, config, hook: 'input.pre', text: input.userMessage, source,
    });
    const sentAt = new Date();
    const streamChunks = onTextChunk && agentMayStreamAnswer(config) ? onTextChunk : undefined;
    const reply = await invokeExternalAgent(
        connection,
        [...input.history, { role: 'user', content: userMessage }],
        {
            tenantDbName,
            tenantId,
            projectId,
            identity: consoleIdentityCallerOf(input.runtimeContext, {
                agentKey,
                projectId,
                accountableUserId: input.accountableUserId,
            }),
        },
        resolveRuntimeHeaders(input.runtimeContext, 'agent', agentKey, connection.runtimeHeaders),
        {
            ...(streamChunks ? { onTextChunk: streamChunks } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        },
    );
    const cancelled = reply.cancelled === true;
    if (cancelled && !input.persistPartial) {
        // A guarded agent emitted nothing, and its partial answer is unchecked.
        return { userMessage, sentAt, content: streamChunks ? reply.content : '', cancelled };
    }
    const content = await evaluateBoundGuardrails({
        tenantDbName, tenantId, projectId, config, hook: 'output.pre', text: reply.content, source,
    });
    if (onTextChunk && !reply.streamed && !cancelled && content) {
        try {
            onTextChunk(content);
        } catch (callbackError) {
            logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
        }
    }
    return { userMessage, sentAt, content, cancelled };
}

/**
 * One turn of a FlowBase agent (`kind: 'flow'`): the agent's flow answers, no model loop runs.
 *
 * Like a connected agent it has no model call of its own, so the user turn and the answer go
 * through the bound `input.pre` / `output.pre` guardrails here. The flow's tools are the flow's
 * business: they run as flow nodes (`flowRunService`), not through `createAgentToolGuard`.
 * `meta` is the run behind the reply (stored as `metadata.flow`), which the next turn reads
 * back to resume a waiting run and to deliver messages the run emitted since. `activity` is what
 * the flow did, stored with the reply (see `flowActivityFields`).
 *
 * Throws what the flows service throws (flow missing, not published, invalid input).
 */
async function runFlowAgentTurn(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    config: IAgentConfig;
    userMessage: string;
    /** Absent for a stateless playground call: every turn then starts the entry flow. */
    conversationId?: string;
    /** The Session's messages before this turn (the previous reply names the run to continue). */
    priorMessages?: ReadonlyArray<{ role: string; metadata?: { flow?: { runId: string; eventSeq?: number } } }>;
    runtimeContext?: AgentRuntimeContext;
    /** The signed-in person (default: the runtime context's caller). */
    userId?: string;
    accountableUserId?: string;
    unattended?: boolean;
    /** The trigger event behind the run (`AgentChatRequest.triggerData`). */
    triggerData?: Record<string, unknown>;
    source: 'agent' | 'agent-playground';
    onTextChunk?: (text: string) => void;
}): Promise<{
    userMessage: string;
    sentAt: Date;
    content: string;
    meta?: AgentFlowReplyMeta;
    activity?: FlowAgentTurnActivity;
}> {
    const { tenantDbName, tenantId, projectId, agentKey, config, source } = input;
    if (!config.flow?.entryFlowId) throw new Error('This FlowBase agent has no flow configured');

    const userMessage = await evaluateBoundGuardrails({
        tenantDbName, tenantId, projectId, config, hook: 'input.pre', text: input.userMessage, source,
    });
    const sentAt = new Date();
    const lastReply = [...(input.priorMessages ?? [])].reverse().find((message) => message.role === 'assistant');
    const previousFlow = lastReply?.metadata?.flow;
    const callerUserId = input.userId ?? input.runtimeContext?.userId;
    const flowsHost = getFlowsHost();
    if (!flowsHost) throw new FlowsUnavailableError('edition');
    const turn = await flowsHost.runAgentTurn({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        flow: config.flow,
        message: userMessage,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(callerUserId ? { userId: callerUserId } : {}),
        ...(input.runtimeContext?.tokenId ? { tokenId: input.runtimeContext.tokenId } : {}),
        ...(input.accountableUserId ? { accountableUserId: input.accountableUserId } : {}),
        ...(input.unattended !== undefined ? { unattended: input.unattended } : {}),
        ...(input.triggerData ? { triggerData: input.triggerData } : {}),
        ...(previousFlow ? { previous: { runId: previousFlow.runId, ...(previousFlow.eventSeq !== undefined ? { eventSeq: previousFlow.eventSeq } : {}) } } : {}),
    });
    const content = await evaluateBoundGuardrails({
        tenantDbName, tenantId, projectId, config, hook: 'output.pre', text: turn.content, source,
    });
    if (input.onTextChunk && content) {
        try {
            input.onTextChunk(content);
        } catch (callbackError) {
            logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
        }
    }
    return {
        userMessage,
        sentAt,
        content,
        ...(turn.meta ? { meta: turn.meta } : {}),
        ...(turn.activity ? { activity: turn.activity } : {}),
    };
}

/**
 * A FlowBase turn's activity as fields of its assistant message: agent steps as sub-agent runs,
 * the other steps as tool calls. The reasoning comes from the step agents (each one's own Show
 * reasoning already applied); `showReasoning` is the FlowBase agent's own, which can only hide it.
 */
function flowActivityFields(
    activity: FlowAgentTurnActivity | undefined,
    showReasoning: boolean,
): Pick<IAgentConversationMessage, 'reasoning' | 'steps' | 'subagentRuns' | 'subagentRunsDropped'> {
    if (!activity) return {};
    return {
        ...(showReasoning && activity.reasoning ? { reasoning: activity.reasoning } : {}),
        ...(activity.steps?.length ? { steps: activity.steps } : {}),
        ...(activity.subagentRuns?.length ? { subagentRuns: activity.subagentRuns } : {}),
        ...(activity.subagentRunsDropped ? { subagentRunsDropped: activity.subagentRunsDropped } : {}),
    };
}

/**
 * Everything a local agent turn needs before `invoke()`: the model, the
 * rendered system prompt, the guardrail plugins, every tool, and the SDK agent
 * itself. ONE builder for the live chat and the playground, on purpose: an
 * operator testing an agent in the playground has to be testing what
 * production will run. The two differ only in the inputs below.
 */
async function buildLocalAgentRun(input: {
    /** Which of the agent's models this run uses and why; tagged on the trace. */
    modelChoice?: AgentModelChoice;
    /** See `AgentChatRequest.requestReasoning`. */
    requestReasoning?: NormalizedReasoning;
    /** Operator view: the provider is asked for thought text even when the agent hides it from its API. */
    revealReasoning?: boolean;
    /** Thought text as it streams (live view only; see `AgentPlaygroundChatRequest.onReasoningChunk`). */
    onReasoningChunk?: (text: string) => void;
    db: Awaited<ReturnType<typeof getDatabase>>;
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    agent: IAgent;
    config: IAgentConfig;
    runtimeContext?: AgentRuntimeContext;
    /** The authenticated principal, or the agent itself — see `createAgentToolGuard`. */
    actorId: string;
    /** Evaluation-log `source`, so a rehearsal stays separate from production traffic. */
    source: 'agent' | 'agent-playground';
    route: 'agent.chat' | 'agent.playground';
    userId?: string;
    version?: number | null;
    /** The Session / API conversation — required for a persistent sandbox. */
    conversation: IAgentConversation | null;
    memoryConversationId?: string;
    threadId?: string;
    onMessageRewrite?: (rewrite: PluginMessageRewrite) => void;
    /**
     * No interactive user on this run (see `AgentChatRequest.unattended`). The
     * agent's `humanInTheLoop.unattended` setting then decides what a gated
     * tool call or a question does: deny it, pause for Studio, or run it.
     */
    unattended?: boolean;
    /** See `AgentChatRequest.answersClientTools`. */
    answersClientTools?: boolean;
    /**
     * False when there is no conversation to park a paused turn on (a stateless
     * playground call). `pause` cannot be honoured there, so it behaves as
     * `deny`.
     */
    canPause?: boolean;
    /** The host page this run is embedded in — its client tools are offered. See `AgentPlaygroundChatRequest.embedded`. */
    embedded?: EmbeddedRunContext;
    /**
     * Whose spend this run is: every model request it makes is debited to the
     * tenant's spend limits (agentSpendLimits.ts). Absent for a build that never
     * calls the model (reading a tool's schema).
     */
    spend?: AgentSpendScope;
    /** Per-request structured output: replaces `config.structuredOutput` for this turn. */
    responseFormat?: AgentResponseFormat;
    /** Validated agent variables of the turn, exposed as `{{variables.<name>}}` (see `variablesInPrompt`). */
    variables?: Record<string, unknown>;
    variablesInPrompt?: boolean;
    /** With `variablesInPrompt: false`: the names of `variables` that may still fill the prompt (`AgentChatRequest.literalVariables`). */
    literalVariables?: string[];
    /**
     * What the reminder tools need about this turn (agentReminderTools.ts): the run it is, whose it
     * is, the version a reminder runs on, the reminder that woke it, and whether it starts having
     * read outside content.
     */
    reminders?: {
        runId?: string;
        accountableUserId?: string;
        version?: number;
        usePublished?: boolean;
        wake?: ReminderWake;
        startsTainted?: boolean;
    };
    /** A trigger run's accountable person (its `userId` is synthetic): Console identity tokens are minted for them. */
    accountableUserId?: string;
    /** The person a continued pause is for (stored with the pause): replaces the runtime context's caller, who may be the approver. */
    identity?: ConsoleIdentityPerson;
}) {
    const { db, tenantDbName, tenantId, projectId, agentKey, agent, runtimeContext, actorId, source } = input;
    // Who MCP servers and connected agents set up for Console identity are told this run is for.
    const identity: ConsoleIdentityCaller = input.identity
        ? { ...input.identity, agentKey, projectId }
        : consoleIdentityCallerOf(runtimeContext, { agentKey, projectId, accountableUserId: input.accountableUserId });
    // Who the knowledge tools of this run, and of its sub-agents, read for.
    const kbCaller = knowledgeCallerOf({ identity: input.identity, runtimeContext });
    // Old `runtime.reasoning` becomes the main model's own selection (a stored draft or a
    // published snapshot may still carry it).
    // Bindings of a switched-off service (knowledge engine, MCP, tools, browser, web search, memory,
    // files, sandbox) are dropped here, so every builder below sees a config without them.
    const config = await applyServiceAvailability(tenantId, migrateAgentReasoning(input.config), { agentKey });
    const hitl = resolveHitlConfig(config.humanInTheLoop);
    const hitlMode = resolveHitlRunMode(hitl, { unattended: input.unattended, canPause: input.canPause });
    // What the approval gates decide during the run, read back when the turn is stored.
    const hitlLog = createHitlCallLog();

    // What this run's priced model requests add up to (sub-agent models too),
    // read by the caller to keep the session budget true even when the turn is
    // never persisted.
    let tappedUsd = 0;
    // The concrete model a Dynamic LLM routed this run's latest call to.
    let routedModelKey: string | undefined;
    const spend: AgentSpendScope | undefined = input.spend
        ? { ...input.spend, observe: (cost) => { if (Number.isFinite(cost.totalCost) && cost.totalCost > 0) tappedUsd += cost.totalCost; } }
        : undefined;

    if (!config.modelKey) throw new Error('Agent has no model configured');
    // How the main model's calls end at the output limit, read when the turn's outcome is described.
    const outputLimit = createOutputLimitTap();
    const { model, chatModel } = await buildAgentChatModel(tenantDbName, tenantId, projectId, config.modelKey, {
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.topP !== undefined ? { top_p: config.topP } : {}),
        ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
    }, agentReasoningForModel(config, config.modelKey), input.requestReasoning, {
        route: input.route,
        agentKey,
        ...(input.conversation?._id ? { sessionId: String(input.conversation._id) } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(config.piiProtection ? { piiProtection: config.piiProtection } : {}),
        onRouted: (key) => { routedModelKey = key; },
        // The operator's own views (playground, Compare versions) ask for the thinking text whatever the
        // agent publishes; every other surface follows the agent. Live deltas come from the SDK's reasoning
        // events (see the stream callbacks), so the gateway's own onReasoning hook is not wired here.
        ...(input.revealReasoning || agentShowsReasoning(config) || input.source === 'agent-playground' ? {} : { showReasoning: false }),
        ...(Number(config.runtime?.limits?.maxTotalOutputTokens) > 0
            ? { maxTotalOutputTokens: Number(config.runtime?.limits?.maxTotalOutputTokens) }
            : {}),
        ...(spend ? { onCost: agentSpendSettler(spend, config.modelKey) } : {}),
        outputLimitTap: outputLimit,
    });

    // System prompt
    const promptVariables = buildPromptVariables({
        config,
        agentKey,
        agentName: agent.name,
        version: input.version,
        runtimeContext,
        userId: input.userId,
        variables: input.variables,
        variablesInPrompt: input.variablesInPrompt,
        literalVariables: input.literalVariables,
    });
    let systemPrompt = await resolveAgentPrompt({ db, projectId, agentKey, config, systemPrompt: config.systemPrompt, variables: promptVariables });

    // Guardrails. One guard for the whole run — resolving the bindings once
    // keeps every tool this agent gets under the same policy, and a legacy
    // config (no `guardrails` array) resolves to the no-op guard.
    warnUnservableStreamBinding(config, agentKey);
    const toolGuard = createAgentToolGuard({ tenantDbName, tenantId, projectId, agentKey, config, actorId, source });

    // THE TEXT HOOKS NOW RUN INSIDE THE AGENT, not around it.
    //
    // `prompt.pre`, `input.pre` and `output.pre` are served by the SDK plugin
    // built here and handed to `createSmartAgent` below. The brackets that
    // used to sit on either side of `invoke()` are gone: they ran `input.pre`
    // once per TURN, where `preModelCall` runs it on every model call — which is
    // what `input.pre` has always meant on the gateway, and what an operator
    // binding it expects. `prompt.pre` is the once-per-turn hook, and it now
    // actually fires.
    //
    // Tool hooks stay on `toolGuard` above; see `AGENT_PLUGIN_HOOKS`.
    const guardrailPlugins = await buildAgentGuardrailPlugins({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        actorId,
        source,
        onMessageRewrite: input.onMessageRewrite,
    });

    const { createSmartAgent, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    // RAG retrieval tools, and the instruction to use them first
    const tools: AgentSdkToolInterface[] = [];
    const toolDefinitions: TraceToolDefinition[] = [];
    if (hasKnowledgeConfigured(config)) {
        const knowledgeTools = await buildAgentKnowledgeTools(
            tenantDbName, tenantId, projectId, config, toolGuard, { caller: kbCaller },
        );
        tools.push(...knowledgeTools.tools);
        toolDefinitions.push(...knowledgeTools.toolDefinitions);
        systemPrompt = systemPrompt
            ? `${KNOWLEDGE_FIRST_INSTRUCTION}\n\n${systemPrompt}`
            : KNOWLEDGE_FIRST_INSTRUCTION;
    }

    // Bound tools from toolBindings (MCP, future sources)
    const { cleanupTasks, tools: boundTools, definitions: boundToolDefinitions } = await buildBoundTools(
        tenantDbName,
        tenantId,
        projectId,
        config.toolBindings,
        createTool,
        z,
        toolGuard,
        runtimeContext,
        identity,
        {
            ...(input.conversation?._id ? { conversationId: String(input.conversation._id) } : {}),
            ...(input.unattended !== undefined ? { unattended: input.unattended } : {}),
            ...(input.accountableUserId ? { accountableUserId: input.accountableUserId } : {}),
        },
        agent._id ? String(agent._id) : undefined,
    );
    tools.push(...boundTools);
    toolDefinitions.push(...boundToolDefinitions);

    // Memory as tools the model can actually call. The SDK gives it
    // neither: recall is pre-injected as a system message and writes only
    // happen at compaction, so an agent can neither look a fact up nor record
    // what it was just told. Built from the SAME store the SDK path reads, so
    // a tool write is visible to next turn's injection.
    // Non-fatal failures during the run (memory today), reported with the answer.
    const warnings = new Set<string>();
    const memory = buildAgentMemoryOption(config.memory, {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId: input.memoryConversationId,
        userId: input.userId,
        onWarning: (message) => warnings.add(message),
    });
    const memoryToolMode = config.memory?.tools ?? 'readwrite';
    if (memory?.store && memoryToolMode !== 'off') {
        const allowWrites = memoryToolMode === 'readwrite' && !resolveAgentMemoryStore(config.memory)?.readOnly;
        tools.push(...buildMemoryTools({
            store: memory.store,
            // 'workspace' is the SDK's OWN default when a config names no
            // scope (every runtime profile sets `memory: { scope: 'workspace' }`).
            // Defaulting to 'session' here would have the tools write where the
            // SDK's injection never reads — a fact stored and then invisible.
            scope: memory.scope ?? 'workspace',
            createToolFn: createTool,
            zod: z,
            guard: toolGuard,
            allowWrites,
        }));
        toolDefinitions.push(...memoryToolDefinitions(allowWrites));
    }

    // Files attached to the session: the agent can list them (`session_files_list`) and read
    // them, images included, with `read` (built below next to the sandbox). Offered whenever the
    // conversation holds a file and the agent takes uploads or writes files (then they are its
    // own outputs).
    const modelTakesImages = resolveModelCapabilities(model).inputModalities.includes('image');
    const filesCfg = resolveAttachmentsConfig(config.attachments);
    const sessionFilesScope = { tenantDbName, tenantId, projectId };
    const outputsOn = outputsAvailability(config);
    // What this run's tools showed the model (screenshots, rendered pages): shared with its sub-agents.
    const toolMedia: ToolMediaContext = {
        store: createToolMediaStore(),
        modelTakesImages,
        maxImageBytes: Math.min(filesCfg.maxBytes, 5 * 1024 * 1024),
    };
    let sessionFacts: Awaited<ReturnType<typeof conversationFileFacts>> = { any: false, images: false };
    if (input.conversation) {
        const conversationId = String(input.conversation._id);
        sessionFacts = agentTakesAttachments(config) || outputsOn.available
            ? await conversationFileFacts(db, conversationId)
            : { any: false, images: false };
        if (sessionFacts.any) {
            tools.push(...buildSessionFileTools({
                createToolFn: createTool,
                zod: z,
                guard: toolGuard,
                scope: sessionFilesScope,
                conversationId,
            }));
            toolDefinitions.push(...sessionFileToolDefinitions());
        }
    }

    // Files the agent writes itself (`session_files_create` / `_append`, no sandbox needed): offered to a run with a
    // session to attach them to and a files bucket that works. Built before the client tools so their name
    // reservation (`taken`, below) covers these too.
    let fileOutputs: FileOutputTools | undefined;
    if (input.conversation && outputsOn.available) {
        const bucket = await inspectFileBucket(db, tenantId, projectId, outputsOn.cfg.bucketKey).catch(() => null);
        if (bucket?.usable) {
            fileOutputs = buildFileOutputTools({
                createToolFn: createTool,
                zod: z,
                guard: toolGuard,
                scope: sessionFilesScope,
                conversation: { _id: input.conversation._id, agentKey },
                agentConfig: config,
                actorId,
                ...(runtimeContext?.tokenId ? { tokenId: runtimeContext.tokenId } : {}),
                limits: outputsOn.outputs,
            });
            tools.push(...fileOutputs.tools);
            toolDefinitions.push(...fileOutputs.definitions);
            systemPrompt = systemPrompt
                ? `${systemPrompt}\n\n${fileOutputsPrompt(outputsOn.outputs)}`
                : fileOutputsPrompt(outputsOn.outputs);
        }
    }

    // Sandbox access (Enterprise). Provisioned on first use; cleaned up with
    // the other bound tools once the run is over. A conversation keeps a
    // persistent sandbox across its turns, a stateless call gets a throwaway one.
    const sandboxTools = await buildAgentSandboxTools({
        sandbox: config.sandbox,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversation: input.conversation,
        createToolFn: createTool,
        zod: z,
        protect: (name, tool) => protectBuiltTool(toolGuard, { name, requestedName: tool.name }, tool),
        onWarning: (message) => warnings.add(message),
        outputs: { agentConfig: config, actorId, ...(runtimeContext?.tokenId ? { tokenId: runtimeContext.tokenId } : {}) },
    });
    // Files the agent writes to /outputs/ are delivered after the turn; that needs a session to attach them to and a bucket.
    if (sandboxTools.tools.length > 0 && input.conversation && resolveAttachmentsConfig(config.attachments).bucketKey) {
        systemPrompt = withSandboxOutputsPrompt(systemPrompt);
    }
    tools.push(...sandboxTools.tools);
    toolDefinitions.push(...sandboxTools.definitions);
    cleanupTasks.push(sandboxTools.cleanup);
    // `read`: one tool for the sandbox's files and the conversation's (images, PDFs, video included).
    const readSession = input.conversation && sessionFacts.any
        ? { scope: sessionFilesScope, conversationId: String(input.conversation._id), readPageChars: filesCfg.readPageChars, maxImageBytes: filesCfg.maxBytes }
        : undefined;
    const readTool = buildReadTool({
        createToolFn: createTool,
        zod: z,
        guard: toolGuard,
        ...(sandboxTools.reader ? { sandbox: sandboxTools.reader } : {}),
        ...(readSession ? { session: readSession } : {}),
        media: { store: toolMedia.store },
        modelTakesImages,
    });
    if (readTool) {
        tools.push(readTool);
        toolDefinitions.push(readToolDefinition({
            ...(sandboxTools.reader ? { sandbox: sandboxTools.reader } : {}),
            ...(readSession ? { session: readSession } : {}),
            media: { store: toolMedia.store },
        }));
    }
    // Images in this session's context are references (a session file, or a tool's image of this run); the
    // bytes are read at the model call. Wrapped even for an agent that no longer takes files (its saved
    // state can still hold references) and for a stateless run, which still shows what its tools return.
    const sessionImages: SessionImagesOptions | undefined = input.conversation || modelTakesImages
        ? {
            source: createCompositeImageSource(
                toolMedia.store,
                input.conversation ? createSessionImageSource(sessionFilesScope, String(input.conversation._id)) : null,
            ),
            maxImages: filesCfg.maxImages,
            maxBytes: filesCfg.maxBytes,
            viewImageTool: Boolean(readTool),
            toolMedia: toolMedia.store,
        }
        : undefined;
    if (sandboxTools.promptNote) {
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${sandboxTools.promptNote}` : sandboxTools.promptNote;
    }

    // Reminders the agent sets itself (`reminder_set` / `_list` / `_cancel`): off unless the agent turns them on,
    // and only for a run with a session to come back to. Built last of the agent's own tools so the watch over the
    // others (outside content, see agentReminderTools.ts) covers all of them; before the client tools' name reservation.
    let reminderTools: ReminderTools | undefined;
    const remindersOn = resolveRemindersConfig(config.reminders, getConfig().agent.reminders);
    // A wake turn runs as a person (the owner checks need one): never offered to a run without one.
    if (input.conversation && remindersOn.available && input.userId) {
        // The wake reads no more than this turn: as no one, unless its own context reads as this turn's caller.
        const wakeReader = kbReaderOfFollowUp(kbCaller, { userId: input.userId, tokenId: runtimeContext?.tokenId, via: runtimeContext?.via });
        reminderTools = buildReminderTools({
            createToolFn: createTool,
            zod: z,
            guard: toolGuard,
            scope: { tenantDbName, tenantId, projectId },
            agentKey,
            conversationId: String(input.conversation._id),
            agentConfig: config,
            settings: remindersOn,
            creator: {
                userId: input.userId,
                ...(input.reminders?.accountableUserId ? { accountableUserId: input.reminders.accountableUserId } : {}),
                ...(runtimeContext?.tokenId ? { tokenId: runtimeContext.tokenId } : {}),
                ...(runtimeContext?.via ? { via: runtimeContext.via } : {}),
                ...(wakeReader ? { kbReader: wakeReader } : {}),
                ...(input.reminders?.runId ? { runId: input.reminders.runId } : {}),
                ...(input.reminders?.version != null ? { version: input.reminders.version } : {}),
                ...(input.reminders?.usePublished !== undefined ? { usePublished: input.reminders.usePublished } : {}),
            },
            ...(input.reminders?.wake ? { wake: input.reminders.wake } : {}),
            startsTainted: input.reminders?.startsTainted === true,
            approvalMode: reminderApprovalMode(hitl, { unattended: input.unattended, canPause: input.canPause }),
        });
        tools.push(...reminderTools.tools);
        toolDefinitions.push(...reminderTools.definitions);
        const note = remindersPrompt(remindersOn, input.reminders?.wake);
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${note}` : note;
    }

    // Tools the CALLER runs. Two sources: the ones the agent declares itself
    // (`config.clientTools` — any channel: a portal page, an API client answering on the
    // actions endpoint, or a backend answering the agent's callback) and the ones a portal
    // passes for the embedding page (`input.embedded`). Offered only to a run that can be
    // paused (a Session) and has someone to answer. What such a tool returns is typed in
    // the caller's environment, so it reaches the model as untrusted input. They are kept
    // out of the approval pass below, which only knows the tools built above; their own
    // approval follows the agent's policy (see `clientToolNeedsApproval`), unless the tool
    // is exempted by its declaration.
    const allowedTools = sessionAllowedTools(input.conversation?.metadata);
    let clientTools: AgentSdkToolInterface[] = [];
    // The agent's own declaration is offered on three surfaces, each switchable by the author
    // (`clientToolSurfaces`, all on by default): the client API (its caller answers on the actions
    // endpoint, from the agent's callback, or with a `tool` message), the dashboard playground, and
    // a portal embedded in a host page. Never on A2A, MCP, realtime, schedules, evaluations or a
    // non-embedded portal chat: nobody there can run a tool.
    const callerCanAnswer = clientToolsOnSurface(config.clientToolSurfaces, clientToolSurfaceOf({ source: input.runtimeContext?.source, embedded: input.embedded }));
    const ownClientTools = callerCanAnswer
        ? (config.clientTools ?? []).filter((tool) => tool.enabled !== false).map(({ enabled: _enabled, ...tool }) => tool as Omit<typeof tool, 'needsApproval'>)
        : [];
    const declaredClientTools = [...ownClientTools, ...(input.embedded?.clientTools ?? [])];
    // A caller's own tools are not covered by the "no choice made means ask" rule: only an explicit switch asks about them.
    const clientApprovalPolicy = clientApprovalConfig(hitl);
    if (declaredClientTools.length > 0) {
        if (input.canPause === false || (input.unattended && !input.answersClientTools) || !input.conversation) {
            logger.debug('Client tools not offered: the run has no session to pause or no person to answer', { agentKey });
            // Only the agent's own declaration warns: a portal's tools are simply not for this run.
            if (ownClientTools.length > 0) {
                warnings.add('Client tools were not offered: this call has no session to pause (use a session) or nobody to answer.');
            }
        } else {
            const { ASK_USER_TOOL_NAME, CONTROL_PLANE_TOOL_NAMES, DELEGATION_TOOL_NAMES } = await import('@cognipeer/agent-sdk');
            const taken = new Set<string>([
                ...tools.map((tool) => tool.name),
                ...(CONTROL_PLANE_TOOL_NAMES as readonly string[]),
                ...(DELEGATION_TOOL_NAMES as readonly string[]),
                ASK_USER_TOOL_NAME,
            ]);
            // The agent's own declaration wins over a portal's tool of the same name.
            const seen = new Set<string>();
            // An unattended caller that runs client tools (the chat completions bridge) cannot answer
            // an approval: a tool the policy would ask about is only offered where the agent says
            // unattended runs may go ahead (`allow`), and then without asking.
            const offered = declaredClientTools.filter((tool) => {
                if (taken.has(tool.name) || seen.has(tool.name)) return false;
                if (input.unattended && clientToolNeedsApproval(tool, clientApprovalPolicy) && hitl.unattended !== 'allow') {
                    warnings.add(`Client tool "${tool.name}" was not offered: it needs approval and this caller cannot answer one.`);
                    return false;
                }
                seen.add(tool.name);
                return true;
            });
            const checked = checkEmbeddedClientTools(offered);
            if (!checked.ok) {
                logger.warn('Client tools not offered: the declared list is invalid', { agentKey, problem: checked.errors[0] });
                warnings.add(`Client tools were not offered: ${checked.errors[0].field} ${checked.errors[0].message}`);
            } else {
                const built = buildClientTools({
                    declared: checked.tools,
                    createToolFn: createTool,
                    guard: toolGuard,
                    allowedTools,
                    // Nobody can be asked on an unattended run: what got this far was allowed to go ahead.
                    approvalPolicy: input.unattended ? { ...hitl, toolApprovalEnabled: false } : clientApprovalPolicy,
                    exceptions: hitl.toolApprovalEnabled ? { byTool: hitl.toolExceptions, log: hitlLog } : undefined,
                });
                clientTools = built.tools;
                toolDefinitions.push(...built.definitions);
            }
        }
    }

    // Outermost: whatever the SDK sends the model passes through the image resolver first
    // (sessionImages.ts), so the SDK, the saved state and the traces only ever see references.
    // The model itself is a gateway call (gatewayChatModel.ts): usage, cost and the model's
    // own rules are the gateway's business, not this layer's.
    const sdkModel = sessionImages ? withSessionImages(chatModel, sessionImages) : chatModel;
    let traceSessionId: string | undefined;
    // The run's usage rows name the trace session once it is open (its first streamed event).
    const callerRun = getRoutingCaller()?.run;
    const approvalSubagents = new Map<string, string>();

    const { subagents, cleanupTasks: subagentCleanupTasks, models: subagentModels } = await buildAgentSubagents({
        db,
        tenantDbName,
        tenantId,
        projectId,
        ...(agent._id ? { agentId: String(agent._id) } : {}),
        subagents: activeSubagentEntries(config),
        createToolFn: createTool,
        zod: z,
        guard: toolGuard,
        runtimeContext,
        identity,
        kbCaller,
        ...(spend ? { spend } : {}),
        ...(sessionImages ? { images: sessionImages } : {}),
        toolMedia,
        modelTakesImages,
        caller: {
            agentKey,
            ...(input.conversation?._id ? { sessionId: String(input.conversation._id) } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
            ...(config.piiProtection ? { piiProtection: config.piiProtection } : {}),
        },
        output: {
            ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
            ...(Number(config.runtime?.limits?.maxTotalOutputTokens) > 0
                ? { maxTotalOutputTokens: Number(config.runtime?.limits?.maxTotalOutputTokens) }
                : {}),
        },
        reasoning: { config, ...(input.requestReasoning ? { request: input.requestReasoning } : {}) },
        prompt: {
            parent: { config, variables: promptVariables },
            ...(input.variables ? { variables: input.variables } : {}),
            ...(input.variablesInPrompt !== undefined ? { variablesInPrompt: input.variablesInPrompt } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
        },
        onWarning: (message) => warnings.add(message),
        approvals: { hitl, mode: hitlMode, run: { unattended: input.unattended, canPause: input.canPause }, allowedTools, log: hitlLog },
    });
    cleanupTasks.push(...subagentCleanupTasks);

    // A skill whose access list keeps this run's person out is left out of the catalog (managed:access:*).
    const skills = await buildAgentSkills(tenantDbName, projectId, config.skills, {
        tenantDbName,
        tenantId,
        caller: identity,
        source: runtimeContext?.source,
    }, agent._id ? String(agent._id) : undefined);
    const outputSchema = resolveTurnOutputSchema(config, input.responseFormat);
    const skillPolicy = resolveAgentSkillPolicy(config);
    // A hidden agent a flow owns is traced under its flow even when no flow run started the turn (the Build editor's playground).
    const ownerTags = !runtimeContext?.flow && agent.owner ? await ownedAgentFlowTags(tenantDbName, agent) : undefined;
    const baseTracingMetadata = ownerTags || agent.owner
        // `flowOwned` marks the session as one of a hidden agent: it is listed under its flow, never as an agent of its own.
        ? { ...buildTracingMetadata(runtimeContext), ...ownerTags, ...(agent.owner ? { flowOwned: 'true' } : {}) }
        : buildTracingMetadata(runtimeContext);
    const tracingMetadata = input.modelChoice
        ? { ...baseTracingMetadata, agentModel: input.modelChoice.modelKey, agentModelReason: input.modelChoice.reason }
        : baseTracingMetadata;
    // The sink opens the trace session on the run's first event, so it is told what the SDK's session
    // file will say about the run: the session shows the agent, version and thread while the run is going.
    const tracingSink = await createInternalTracingSink(
        tenantDbName, tenantId, projectId, toolDefinitions, agentKey, (id) => { traceSessionId = id; if (callerRun) callerRun.traceSessionId = id; }, approvalSubagents,
        {
            ...(input.threadId ? { threadId: input.threadId } : {}),
            agent: {
                name: agent.name,
                ...(input.version != null ? { version: String(input.version) } : {}),
                ...(input.modelChoice ? { model: input.modelChoice.modelKey } : {}),
            },
            ...(tracingMetadata ? { metadata: tracingMetadata } : {}),
        },
    );
    const sessionBudgetActive = Boolean(activeSessionBudget(input.conversation));
    const costEstimator = await buildAgentCostEstimator(config, model, subagentModels, sessionBudgetActive, (message) => warnings.add(message), tenantId);
    if (sessionBudgetActive && !costEstimator) {
        // A budget nothing can measure would let the session spend without
        // limit, so the turn is refused rather than run unmetered.
        await runBoundToolCleanup(cleanupTasks, { agentKey, mode: source === 'agent' ? 'chat' : 'playground' });
        throw new Error('Session budget cannot be enforced: the agent model has no pricing set. Set the model pricing or remove the session budget.');
    }

    // Tool approval: the SDK pauses a call whose tool carries `needsApproval`.
    // Only the tools built above are gated — the SDK's own (todo, context,
    // delegation, skills…) are not in this list. A run nobody can answer either
    // pauses like any other (`ask`), refuses the gated calls (`deny`: the model
    // gets an error result, the tool never runs) or runs them as they are
    // (`allow`, the owner's explicit choice).
    // `read` is exempt from approval by name, so no other tool may carry it (an MCP/custom tool called
    // `read` could be state-changing): the built-in wins and the other is left out.
    const approvable = tools.filter((tool) => {
        const clash = tool !== readTool && (tool as { name?: unknown }).name === READ_TOOL;
        if (clash) warnings.add(`A tool named "${READ_TOOL}" was left out: the name is reserved for the built-in read tool.`);
        return !clash;
    });
    const ownTools = reminderTools ? reminderTools.watchTools(approvable) : approvable;
    const policyGated = hitlMode === 'ask'
        ? applyToolApprovals(ownTools, hitl, allowedTools, hitlLog)
        : hitlMode === 'deny'
            ? denyUnattendedTools(ownTools, hitl, allowedTools, hitlLog)
            : applyToolBlocks(ownTools, hitl, hitlLog);
    const gatedTools = reminderTools ? reminderTools.gate(policyGated) : policyGated;
    if (reminderTools) clientTools = reminderTools.watchTools(clientTools);

    const sdkAgent = createSmartAgent({
        name: agent.name,
        version: input.version != null ? String(input.version) : undefined,
        model: sdkModel,
        ...(gatedTools.length + clientTools.length > 0 ? { tools: [...gatedTools.map((tool) => withToolMedia(tool, toolMedia)), ...clientTools] } : {}),
        // Nobody to ask in the other modes, so the question tool is not offered.
        ...(hitlMode === 'ask' && hitl.askUserEnabled ? { humanInTheLoop: { askUser: { allowFreeText: hitl.allowFreeText } } } : {}),
        // Omitted entirely when empty: an empty array and no key mean the same
        // thing to the host, and the shorter option object is what every other
        // conditional field here does.
        ...(guardrailPlugins.length > 0 ? { plugins: guardrailPlugins } : {}),
        // Carries the module defaults for every knob an operator left untouched
        // — see `agentRuntimeConfig.CONSOLE_AGENT_DEFAULTS`.
        ...resolveAgentRuntimeOptions(config),
        ...(outputSchema ? { outputSchema } : {}),
        ...(subagents.length > 0 ? { subagents } : {}),
        ...(skills.length > 0 ? { skills } : {}),
        ...(skillPolicy ? { skillPolicy } : {}),
        ...(memory ? { memory } : {}),
        ...(costEstimator ? { costEstimator } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        // An image counts as an image, not as the characters of its bytes — the SDK would
        // otherwise compact a conversation on the strength of one photo.
        tokenCounter: createImageAwareTokenCounter(),
        tracing: {
            enabled: true,
            mode: 'batched',
            sink: tracingSink,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(tracingMetadata ? { metadata: tracingMetadata } : {}),
        },
    });

    return {
        sdkAgent, model, systemPrompt, cleanupTasks, warnings, hitl, tools: [...gatedTools, ...clientTools], costEstimator, toolGuard,
        /** What the approval gates decided: why a pause waits, which calls an exception let through or refused. */
        hitlLog,
        /** Who the run's Console identity tokens are for; a pause stores it for its continuation. */
        identity,
        // Files of both kinds ride on the answer: what the agent left in the sandbox's /outputs/ and what it wrote with the file tools.
        collectOutputs: mergeOutputCollectors(sandboxTools.collectOutputs, ...(fileOutputs ? [fileOutputs.collectOutputs] : [])),
        tappedUsd: () => tappedUsd,
        routedModel: () => routedModelKey,
        /** How the main model's last call ended at its output limit (`describeRunOutcome`). */
        outputLimit,
        /** After the turn: the trace session's totals take in the sub-agents' calls (see `reconcileTraceTotals`). */
        /** Feed every SDK event: a child's approval / question is remembered so its trace step can name the child. */
        noteSdkEvent: (event: AgentSdkEvent) => {
            reminderTools?.noteSdkEvent(event);
            const e = event as { type?: string; id?: unknown; subagentName?: unknown };
            if ((e.type === 'tool_approval' || e.type === 'user_question') && typeof e.id === 'string' && typeof e.subagentName === 'string') {
                approvalSubagents.set(e.id, e.subagentName);
            }
        },
        reconcileTrace: (usage: Parameters<typeof reconcileTraceTotals>[3]) => reconcileTraceTotals(tenantDbName, projectId, traceSessionId, usage),
        /** The SDK closed the trace as `paused`, but the console cannot continue the run: the trace says it failed, and why. */
        failTrace: (detail: string) => markTraceSessionFailed(tenantDbName, projectId, traceSessionId, detail),
    };
}

/**
 * Whether an agent's answer may reach `onTextChunk` while it is generated.
 *
 * `output.pre` only ever sees the COMPLETE answer, and it can rewrite it
 * (PII redaction) or block it. Streaming hands every token to the caller
 * before that check runs — a voice session would speak the raw card number,
 * an SSE client would receive it — while only the persisted copy is guarded.
 * So an agent bound to `output.pre` answers in one piece: nothing reaches
 * `onTextChunk` during the run and callers deliver the guarded
 * `result.content` (a connected agent emits it as one chunk, see
 * runExternalAgentTurn). Agents without an output guardrail stream as usual.
 */
export function agentMayStreamAnswer(config: GuardrailBindingSource): boolean {
    return resolveBindings(config, 'output.pre').length === 0;
}

/**
 * The first exchange of a "New conversation" names it after what was asked — or,
 * when the message is files alone, after the first file. A message with neither
 * leaves the title as it was (an empty title would read as a broken session).
 */
function firstTurnTitle(
    conversation: Pick<IAgentConversation, 'title'>,
    messageCount: number,
    userText: string,
    attachments?: ReadonlyArray<{ name: string }>,
): string | undefined {
    const untitled = !conversation.title || conversation.title === 'New conversation';
    if (!untitled || messageCount > 2) return conversation.title;
    if (userText.trim()) return userText.substring(0, 80);
    const fileName = attachments?.find((file) => file.name.trim())?.name.trim();
    return fileName ? fileName.substring(0, 80) : conversation.title;
}

/**
 * The session stop reason of a turn. A pause that could be opened is
 * `requires_action`; one that could not (state too large to keep) has nothing to
 * wait on, so the session is not left "waiting".
 */
function sessionStopReason(
    outcome: AgentStopReason,
    pause: OpenedPause | null | undefined,
    settlement?: SessionBudgetSettlement,
): SessionStopReason {
    if (settlement?.reached) return 'budget_reached';
    // A pause that could not be opened is reported as `error` by the outcome itself
    // (`pauseUnavailableOutcome`); this fallback only guards a caller that did not.
    if (outcome === 'paused') return pause ? 'requires_action' : 'error';
    return toSessionStopReason(outcome);
}

/** What a continuation must apply again: the turn's own structured output and variables, and who the turn is for. */
function pausedTurnOptions(
    request: Pick<AgentChatRequest, 'responseFormat' | 'variables' | 'variablesInPrompt' | 'literalVariables'>,
    identity?: ConsoleIdentityCaller,
): PausedTurnOptions | undefined {
    const person = consoleIdentityPersonOf(identity);
    if (!request.responseFormat && !request.variables && request.variablesInPrompt !== false && !person) return undefined;
    return {
        ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
        ...(request.variables ? { variables: request.variables } : {}),
        ...(request.variablesInPrompt === false ? { variablesInPrompt: false } : {}),
        ...(request.variablesInPrompt === false && request.literalVariables?.length ? { literalVariables: request.literalVariables } : {}),
        ...(person ? { identity: person } : {}),
    };
}

function toAgentChatResponse(input: {
    conversationId: string;
    priorMessageCount: number;
    agentName: string;
    version: number | null;
    content: string;
    messages: IAgentConversation['messages'];
    reasoning?: string;
    outcome?: { stopReason: AgentStopReason | 'budget_reached'; stopDetail?: string };
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
    outputParsed?: unknown;
    outputError?: string;
    warnings?: ReadonlySet<string>;
    /** The approvals / questions the turn paused on — makes the response `requires_action`. */
    pendingActions?: PublicPendingAction[];
}): AgentChatResponse {
    const { reasoning, outcome, usage } = input;
    const requiresAction = (input.pendingActions?.length ?? 0) > 0;
    const responseId = `resp_${input.conversationId}`;
    // The id of the answer is the id a client rates it by (`PUT .../messages/{id}/feedback`): the stored message's own.
    const answerIndex = input.messages.map((message) => message.role).lastIndexOf('assistant');
    const msgId = answerIndex >= 0
        ? messageIdOf(input.conversationId, answerIndex, input.messages[answerIndex])
        : `msg_${Date.now().toString(36)}`;
    const reasoningId = `rs_${Date.now().toString(36)}`;
    const stopped = outcome && outcome.stopReason !== 'completed' ? outcome : undefined;
    const outputFiles = answerIndex >= 0 ? toClientOutputFiles(input.conversationId, input.messages[answerIndex]?.attachments) : [];

    return {
        id: responseId,
        object: 'response',
        model: input.agentName,
        output: [
            // OpenAI Responses convention: reasoning item precedes the message.
            ...(reasoning
                ? [{ id: reasoningId, type: 'reasoning' as const, summary: [{ type: 'summary_text' as const, text: reasoning }] }]
                : []),
            { id: msgId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: input.content, ...(outputFiles.length > 0 ? { annotations: toFileAnnotations(outputFiles) } : {}) }] },
        ],
        status: requiresAction ? 'requires_action' : stopped ? (stopped.stopReason === 'error' ? 'failed' : 'incomplete') : 'completed',
        ...(requiresAction
            ? {
                stop_reason: 'requires_action' as const,
                required_action: { type: 'agent_actions' as const, actions: input.pendingActions!.map(toClientPendingAction) },
            }
            : stopped
            ? {
                // OpenAI Responses convention: a `failed` response carries `error`, an `incomplete` one `incomplete_details`.
                ...(stopped.stopReason === 'error'
                    ? { error: { code: 'run_failed', message: stopped.stopDetail ?? 'The run failed.' } }
                    : { incomplete_details: { reason: incompleteReason(stopped.stopReason, stopped.stopDetail) } }),
                stop_reason: stopped.stopReason,
                ...(stopped.stopDetail ? { stop_detail: stopped.stopDetail } : {}),
            }
            : outcome ? { stop_reason: 'completed' as const } : {}),
        usage: {
            input_tokens: usage?.inputTokens ?? 0,
            output_tokens: usage?.outputTokens ?? 0,
            total_tokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
            input_tokens_details: { cached_tokens: usage?.cachedInputTokens ?? 0 },
            output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
        },
        created_at: Math.floor(Date.now() / 1000),
        previous_response_id: input.priorMessageCount > 0 ? responseId : null,
        version: input.version,
        ...(input.outputParsed !== undefined ? { output_parsed: input.outputParsed } : {}),
        ...(input.outputError ? { output_error: input.outputError } : {}),
        ...(outputFiles.length > 0 ? { output_files: outputFiles } : {}),
        ...(input.warnings && input.warnings.size > 0 ? { warnings: [...input.warnings] } : {}),
        _conversation_messages: input.messages,
    };
}

/**
 * Local (non-routed) implementation. Exported so the queue consumer can call it.
 *
 * Wraps the turn so a throw — from anywhere in it — is recorded as a
 * `session.error` on the conversation's event log before it propagates.
 */
/** The caller identity a run's model calls carry (Dynamic LLM caller conditions). */
export function routingCallerOf(request: AgentChatRequest): RoutingCallerContext {
    const synthetic = !request.userId || request.userId.startsWith('system:') || request.userId === 'a2a-public';
    const runtime = request.runtimeContext;
    return {
        channel: channelFromSource(runtime?.source) ?? (request.unattended ? 'api' : 'dashboard'),
        agentKey: request.agentKey,
        projectId: request.projectId,
        ...(synthetic ? {} : { userId: request.userId }),
        ...(runtime?.tokenId ? { apiTokenId: runtime.tokenId } : {}),
        ...Object.fromEntries(Object.entries(request.callerContext ?? {}).filter(([, v]) => v !== undefined)),
        // The run's attribution, stamped on every usage row; the turn and trace ids are noted once known.
        run: { conversationId: request.conversationId, ...(request.runId ? { runId: request.runId } : {}) },
    };
}

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

export async function executeAgentChatLocal(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    // The last stop for a turn that arrives without the entry above (a queue worker, a background run).
    await assertAgentsEnabled(request);
    const scope: { events?: SessionTurnEvents } = {};
    try {
        return await runWithRoutingCaller(routingCallerOf(request), () => runWithKnowledgeExposure(new KnowledgeExposure(), () => runAgentChatTurn(request, scope)));
    } catch (error) {
        await scope.events?.fail(error).catch(() => undefined);
        throw error;
    }
}

async function runAgentChatTurn(
    request: AgentChatRequest,
    scope: { events?: SessionTurnEvents },
): Promise<AgentChatResponse> {
    const {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId,
    } = request;
    // The block that separates the person's words from what the turn adds for
    // attached files must not be something the person can type: the transcript
    // is cut at it (`persistedUserTurn`).
    // The Variables block (and, for external content, its closing line) belongs to the
    // user turn like the words themselves: it is what the model reads, what the
    // transcript stores and what a resume replays.
    const userMessage = neutralizeAttachmentMarker(
        composeUserMessageWithVariables(
            request.reminder ? reminderNoteText(request.reminder) : request.userMessage,
            request.variables,
            { externalContent: request.externalContent },
        ),
    );
    // A reminder's wake turn: screens show the note itself, not the framing the model reads.
    const reminderMeta = request.reminder
        ? { origin: 'reminder' as const, reminder: { runId: request.reminder.runId, message: request.reminder.message, setAt: request.reminder.setAt } }
        : undefined;

    // 1. Load agent config (use published version for API/SDK calls)
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    let resolvedVersion: number | null = null;
    let agent: IAgent;
    let config: IAgentConfig;

    if (request.usePublished || request.version !== undefined) {
        // Resolve from published version
        const resolved = await resolveAgentConfig(
            tenantDbName,
            agentKey,
            projectId,
            request.version,
        );
        agent = resolved.agent;
        config = resolved.config;
        resolvedVersion = resolved.resolvedVersion;
    } else {
        // Playground-style: use current draft config
        const foundAgent = await db.findAgentByKey(agentKey, projectId);
        if (!foundAgent) throw new Error(`Agent "${agentKey}" not found`);
        agent = foundAgent;
        config = foundAgent.config;
    }
    assertOwnedAgentReachable(agent, request.runtimeContext);

    // 2. Load conversation
    let conversation = await db.findAgentConversationById(conversationId);
    // findAgentConversationById resolves purely by _id — it has no projectId
    // parameter — so without this check, any caller who can produce another
    // project's conversationId (a previous_response_id / A2A contextId / any
    // future caller of this function) gets that project's message history
    // read back as context AND appended to, regardless of which project the
    // agent above was resolved from. This is the actual execution chokepoint
    // shared by every caller, so the check belongs here, not only at each
    // call site's own pre-check.
    if (!conversation || conversation.projectId !== projectId) {
        throw new Error(`Conversation "${conversationId}" not found`);
    }

    // Which model this turn runs on (the agent's additional models). Recorded only for agents that offer
    // some; the config the rest of the turn reads then names that model as its own.
    const offersModels = config.kind !== 'external' && config.kind !== 'flow' && additionalModelKeys(config).length > 0;
    const modelChoice: AgentModelChoice | undefined = offersModels
        ? applyAgentModelChoice(config, { chosen: request.modelKey, sessionMetadata: conversation.metadata, background: Boolean(request.runId) })
        : undefined;
    if (modelChoice && modelChoice.modelKey !== config.modelKey) config = applyModelToConfig(config, modelChoice.modelKey);
    // Attachments are judged from this config below, before the agent is built.
    config = await applyServiceAvailability(tenantId, config, { agentKey });

    // A message that arrives while the session waits on an approval or a
    // question is refused (or cancels the request) per the agent's own setting.
    // Checked before the event log opens: a refusal must not mark the session
    // idle or write an error into it.
    const hitlSettings = resolveHitlConfig(config.humanInTheLoop);
    await assertNoBlockingPending(db, conversation, hitlSettings);

    // The files this message attaches must be files of this session.
    const attachedRecords = await resolveMessageAttachments({
        tenantDbName, tenantId, projectId, conversation, config, fileIds: request.attachments,
    });

    // A context given when the session was created (`POST /client/v1/agents/sessions`) applies to its API turns too.
    const turnRuntimeContext = mergeSessionRuntimeContext(conversation, request.runtimeContext);

    // The session's own budget and the tenant's spend limit, for a turn that
    // calls a model (a connected agent spends nothing here). Refused before the
    // event log opens, like the check above.
    const callsModel = !(config.kind === 'external' && config.connection) && config.kind !== 'flow';
    const budgetPlan = callsModel ? planSessionBudget(conversation, config.runtime?.limits?.maxCostUsd) : null;
    // Every turn adds its spend to the session's total — with a budget or without one.
    const spendAccount = budgetPlan ?? startSessionSpendAccount(conversation);
    const spend = callsModel && config.modelKey
        ? await resolveAgentSpendScope({ tenantDbName, tenantId, projectId, userId: request.accountableUserId ?? request.userId })
        : undefined;
    if (spend) await assertAgentTurnSpendAllowed(spend, config);

    // The session event log for this turn. The ledger collects what `input.pre`
    // rewrote on the wire: step 6 persists the redacted user turn rather than
    // the raw one, and the log's `user.message` carries the same text.
    const rewriteLedger = new MessageRewriteLedger();
    const turnEvents = startSessionTurnEvents({
        db,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId,
        ...(request.runId ? { runId: request.runId } : {}),
        userMessage: () => rewriteLedger.resolve(userMessage),
        trigger: request.reminder ? 'reminder' : 'message',
        ...(reminderMeta ? { userMessageData: reminderMeta } : {}),
        ...(modelChoice ? { model: modelChoice } : {}),
        superseded: () => request.cancellationCell?.abandoned === true,
    });
    scope.events = turnEvents;
    noteRoutingRun({ conversationId, turnId: turnEvents.turnId });
    await bindKnowledgeExposure(db, conversation);
    if (hitlSettings.onUserMessageWhilePending === 'cancel_pending' && conversation.runtimeStatus === 'requires_action') {
        conversation = await cancelPendingForNewMessage(db, conversation, turnEvents.emit);
        await endRunsOfDroppedPause(db, { tenantId, projectId, conversationId });
    }
    // Text deltas ride the caller's own stream callback: a caller that did not
    // ask for text must not switch the model call into streaming mode.
    const onTextChunk = request.onTextChunk
        ? (text: string) => {
            turnEvents.onText(text);
            request.onTextChunk?.(text);
        }
        : undefined;
    // Same for the thinking: live to the caller and to a session follower, never stored as an event.
    const onReasoningChunk = request.onReasoningChunk
        ? (text: string) => {
            turnEvents.onReasoning(text);
            request.onReasoningChunk?.(text);
        }
        : undefined;

    // 2b. Connected (external) agent — see `runExternalAgentTurn`.
    if (config.kind === 'external' && config.connection) {
        // Both texts are the GUARDED ones: the user turn is what went upstream,
        // what is persisted and what the title is cut from; the answer is
        // guarded BEFORE `updatedMessages` is built, because that one array is
        // both the persisted history and the returned payload. Redacting only
        // the response would leave the raw answer in the conversation — where
        // the next turn reads it back and sends it upstream as history.
        const turn = await runExternalAgentTurn({
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            config,
            connection: config.connection,
            history: (conversation.messages || []).map((m) => ({ role: m.role, content: m.content })),
            userMessage,
            runtimeContext: turnRuntimeContext,
            ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
            source: 'agent',
            onTextChunk,
            signal: request.signal,
            // A cancelled turn is still written to the conversation below.
            persistPartial: true,
        });
        const externalOutcome = turn.cancelled
            ? { stopReason: 'cancelled' as const, stopDetail: CALLER_ABORT_DETAIL }
            : undefined;

        const updatedMessages: IAgentConversation['messages'] = [
            ...(conversation.messages || []),
            { role: 'user', content: turn.userMessage, timestamp: turn.sentAt },
            { role: 'assistant', content: turn.content, ...(externalOutcome ?? {}), timestamp: new Date() },
        ];
        // §12.12: a deadline/cancel decision made about this turn while the
        // external HTTP call was in flight must not be overwritten by a late
        // write once it finally returns.
        const externalSuperseded = isCancellationCellTripped(request.cancellationCell);
        if (!externalSuperseded) {
            await db.updateAgentConversation(conversationId, {
                messages: updatedMessages,
                title: firstTurnTitle(conversation, updatedMessages.length, turn.userMessage),
            });
        }
        await turnEvents.finish({
            stopReason: toSessionStopReason(turn.cancelled || externalSuperseded ? 'cancelled' : 'completed'),
            content: turn.content,
            messageIndex: updatedMessages.length - 1,
            userMessage: turn.userMessage,
            ...(externalOutcome?.stopDetail ? { detail: externalOutcome.stopDetail } : {}),
        });

        return toAgentChatResponse({
            conversationId,
            priorMessageCount: conversation.messages?.length ?? 0,
            agentName: agent.name,
            version: resolvedVersion,
            content: turn.content,
            messages: updatedMessages,
            ...(externalOutcome ? { outcome: externalOutcome } : {}),
        });
    }

    // 2c. FlowBase agent — see `runFlowAgentTurn`. No model loop: the agent's flow answers, and its
    // reply is stored with the run behind it (`metadata.flow`) so the next message can resume it.
    if (config.kind === 'flow') {
        const flowTurn = await runFlowAgentTurn({
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            config,
            userMessage,
            conversationId,
            priorMessages: conversation.messages || [],
            runtimeContext: turnRuntimeContext,
            userId: request.userId,
            ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
            unattended: request.unattended,
            ...(request.triggerData ? { triggerData: request.triggerData } : {}),
            source: 'agent',
            onTextChunk,
        });
        const flowMessages: IAgentConversation['messages'] = [
            ...(conversation.messages || []),
            { role: 'user', content: flowTurn.userMessage, timestamp: flowTurn.sentAt },
            {
                role: 'assistant',
                content: flowTurn.content,
                ...flowActivityFields(flowTurn.activity, agentShowsReasoning(config)),
                ...(flowTurn.meta ? { metadata: { flow: flowTurn.meta } } : {}),
                timestamp: new Date(),
            },
        ];
        const flowSuperseded = isCancellationCellTripped(request.cancellationCell);
        if (!flowSuperseded) {
            await db.updateAgentConversation(conversationId, {
                messages: flowMessages,
                title: firstTurnTitle(conversation, flowMessages.length, flowTurn.userMessage),
            });
        }
        await turnEvents.finish({
            stopReason: toSessionStopReason(flowSuperseded ? 'cancelled' : 'completed'),
            content: flowTurn.content,
            messageIndex: flowMessages.length - 1,
            userMessage: flowTurn.userMessage,
        });

        return toAgentChatResponse({
            conversationId,
            priorMessageCount: conversation.messages?.length ?? 0,
            agentName: agent.name,
            version: resolvedVersion,
            content: flowTurn.content,
            messages: flowMessages,
        });
    }

    // 3. Model, prompt, guardrails and tools — see `buildLocalAgentRun`.
    const { sdkAgent, model, cleanupTasks, warnings, hitl, costEstimator, tappedUsd, routedModel, outputLimit, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity, hitlLog } = await buildLocalAgentRun({
        db,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        agent,
        config,
        runtimeContext: turnRuntimeContext,
        actorId: request.userId,
        source: 'agent',
        route: 'agent.chat',
        userId: request.userId,
        ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
        version: resolvedVersion,
        conversation,
        memoryConversationId: conversationId,
        threadId: conversationId,
        onMessageRewrite: (rewrite) => rewriteLedger.record(rewrite),
        unattended: request.unattended,
        ...(request.answersClientTools ? { answersClientTools: true } : {}),
        ...(spend ? { spend } : {}),
        ...(modelChoice ? { modelChoice } : {}),
        ...(request.requestReasoning ? { requestReasoning: request.requestReasoning } : {}),
        ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
        ...(request.variables ? { variables: request.variables } : {}),
        ...(request.variablesInPrompt === false ? { variablesInPrompt: false } : {}),
        ...(request.literalVariables ? { literalVariables: request.literalVariables } : {}),
        reminders: {
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.accountableUserId ? { accountableUserId: request.accountableUserId } : {}),
            ...(request.version !== undefined ? { version: request.version } : {}),
            ...(request.usePublished !== undefined ? { usePublished: request.usePublished } : {}),
            ...(request.reminder ? { wake: request.reminder } : {}),
            startsTainted: request.externalContent === true,
        },
    });

    // 4. What the agent resumes from: the state the conversation's last turn
    // ended in (its tool calls and results, summaries, plan), or the text
    // transcript when there is none — see agentTurnState.ts.
    const now = new Date();
    const carried = await loadConversationState(db, conversation);
    const attached = await assembleMessageAttachments({
        tenantDbName, tenantId, projectId, records: attachedRecords, config, model, warnings,
    });
    const inputState = buildTurnInputState({
        carried,
        transcript: conversation.messages || [],
        userMessage,
        userContent: buildUserTurnContent(userMessage, attached),
        attachments: await earlierAttachments({ db, conversation, config, model }),
    });
    const userTurnIndex = inputState.messages.length - 1;
    // Tool calls the carried state already holds belong to earlier turns.
    const priorExecutionIds = new Set(
        (carried?.toolHistory ?? [])
            .map((entry) => (entry as { executionId?: unknown }).executionId)
            .filter((id): id is string => typeof id === 'string'),
    );

    try {
        // 5. Invoke
        const flow = createTurnFlowTracker({ targets: subagentTargets(activeSubagentEntries(config)) });
        const flowSink = createTurnFlowSink({ tracker: flow, turnEvents, agentKey });
        const cancellationBridge = bridgeCancellationCell(request.cancellationCell, request.signal);
        const streamed = captureStreamedText(onTextChunk);
        const reasoningTap = createReasoningTap(onReasoningChunk, agentKey, agentShowsReasoning(config));
        const liveInvokeConfig = {
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
        };

        const settled: AgentSdkInvokeResult | null = await runWithTurnSignal(cancellationBridge.signal, () => sdkAgent.invoke(inputState, liveInvokeConfig))
            .catch((error: unknown) => {
                // The caller aborted and the in-flight model call threw for
                // it: an aborted turn resolves with what it had streamed.
                if (request.signal?.aborted) return null;
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            })
            .finally(() => cancellationBridge.stop());

        if (!settled) {
            // No result means no final state and no `result.messages` to read a
            // `prompt.pre` redaction of the user turn back from — so nothing is
            // persisted (the conversation keeps its previous state, as for a
            // superseded turn). The caller gets the text it already streamed.
            const outcome = { stopReason: 'cancelled' as const, stopDetail: CALLER_ABORT_DETAIL };
            const partialMessages: IAgentConversation['messages'] = [
                ...(conversation.messages || []),
                { role: 'user', content: rewriteLedger.resolve(userMessage), ...(reminderMeta ? { metadata: reminderMeta } : {}), timestamp: now },
                { role: 'assistant', content: streamed.text(), ...outcome, timestamp: new Date() },
            ];
            logger.info('Agent chat aborted by caller mid-call (not persisted)', { agentKey, conversationId });
            await turnEvents.finish({
                stopReason: 'cancelled',
                content: streamed.text(),
                detail: outcome.stopDetail,
                userMessage: rewriteLedger.resolve(userMessage),
            });
            return toAgentChatResponse({
                conversationId,
                priorMessageCount: conversation.messages?.length ?? 0,
                agentName: agent.name,
                version: resolvedVersion,
                content: streamed.text(),
                messages: partialMessages,
                outcome,
            });
        }
        const result = settled;

        const blocked = guardrailBlockedError(result);
        if (blocked) throw blocked;

        // THE REWRITTEN USER TURN, not `userMessage`. A `prompt.pre` redaction
        // sits in `result.messages`; an `input.pre` redaction sits in the
        // ledger; the raw request text is only the fallback. Persisting the raw
        // text would store the PII the guardrail just removed and replay it as
        // history on every later turn, where no hook re-scans it.
        const persistedUserMessage = persistedUserTurn({
            result,
            index: userTurnIndex,
            fallback: userMessage,
            ledger: rewriteLedger,
        });

        // `config.showReasoning: false` keeps the thinking text out of the API response, the
        // stored session message and Studio chat. The tokens were spent and are counted regardless.
        const assistantReasoning = agentShowsReasoning(config) ? turnReasoning(result, reasoningTap) : undefined;

        // 5b. Output guardrail: `output.pre` ran inside the agent on
        // `postModelCall`, so a redaction is already in `result.content` and a
        // block was turned into a throw by `guardrailBlockedError` above.
        // Reasoning is not gated.
        //
        // A run a limit or a cancellation cut short has no final answer; the
        // outcome carries why, and the last text the agent did write.
        const turnOutcome = endedByCallerAbort(describeRunOutcome(result, inputState.messages.length, outputLimit), request.signal);
        const usage = normalizePlaygroundUsage(result.metadata?.usage)?.usage;
        await reconcileTrace(usage);
        // What the turn cost: kept on the message (the session's running total
        // is the sum of these) and, with a session budget, checked against it.
        const turnCostUsd = usage
            ? await priceAgentTurn({ plan: budgetPlan, result, costEstimator, pricing: model.pricing, model, usage })
            : undefined;
        if (usage && turnCostUsd !== undefined) usage.costUsd = turnCostUsd;
        const budget = budgetPlan
            ? settleSessionBudget(budgetPlan, turnCostUsd, isSessionBudgetBreach(budgetPlan, turnOutcome), turnOutcome.stopReason)
            : undefined;
        let outcome = budgetAwareOutcome(turnOutcome, budget);
        const outputParsed = result.output;
        const outputError = result.outputError ? describeStructuredOutputError(result.outputError) : undefined;
        const flowRecord = turnFlowRecord(flow, () => compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined));
        // The same per-call detail a dashboard session stores, so a conversation
        // started over the API shows its tool calls when it is opened there.
        const steps = extractPlaygroundSteps(result, priorExecutionIds, hitlLog);

        // §12.12: the deadline (sync ceiling, §5) or an async cancel flag
        // (background mode, §7 step 6) may have already decided this turn's
        // outcome while `sdkAgent.invoke()` was in flight — a late-arriving
        // result here must never overwrite that decision by persisting
        // anyway, however complete the answer looks.
        const supersededByDeadlineOrCancel = isCancellationCellTripped(request.cancellationCell);

        // Files the agent left in the sandbox's /outputs/ ride on the answer (never fails the turn).
        const outputFiles = supersededByDeadlineOrCancel ? { attachments: [], warnings: [] } : await collectOutputs();
        for (const warning of outputFiles.warnings) warnings.add(warning);

        // The run stopped for a person: keep what it needs to continue.
        let pause: OpenedPause | null = null;
        if (outcome.stopReason === 'paused' && !supersededByDeadlineOrCancel) {
            pause = await openPause(db, {
                state: result.state,
                source: 'agent',
                tenantId,
                projectId,
                agentKey,
                conversationId,
                ...(request.runId ? { runId: request.runId } : {}),
                hitl,
                approvalLog: hitlLog,
                agentVersion: resolvedVersion,
                usePublished: Boolean(request.usePublished || request.version !== undefined),
                turn: pausedTurnOptions(request, identity),
                createdBy: request.userId,
            });
            if (!pause) {
                // The run cannot be continued: it failed, and says so — not a quiet end of turn.
                warnings.add(PAUSE_UNAVAILABLE_WARNING);
                outcome = pauseUnavailableOutcome(outcome);
                await failTrace(PAUSE_UNAVAILABLE_WARNING);
            }
        }

        // 6. Update conversation with new messages — the REWRITTEN user turn,
        // and the title cut from the same string.
        const updatedMessages: IAgentConversation['messages'] = [
            ...(conversation.messages || []),
            {
                role: 'user',
                content: persistedUserMessage,
                ...(attached.attachments.length > 0 ? { attachments: attached.attachments } : {}),
                ...(reminderMeta ? { metadata: reminderMeta } : {}),
                timestamp: now,
            },
            {
                role: 'assistant',
                content: outcome.content,
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
                ...(outputParsed !== undefined ? { output: outputParsed } : {}),
                ...(outputError ? { outputError } : {}),
                ...answeredWithMetadata(model.key, Boolean(modelChoice), routedModel()),
                timestamp: new Date(),
            },
        ];

        if (!supersededByDeadlineOrCancel) {
            await db.updateAgentConversation(conversationId, {
                messages: updatedMessages,
                title: firstTurnTitle(conversation, updatedMessages.length, persistedUserMessage, attached.attachments),
            });
            // The turn's cost joins the session total; added, not set, so a turn
            // that overlaps this one cannot erase it (see `addSessionTurnSpend`).
            await addSessionTurnSpend({ db, conversationId, plan: spendAccount, spentUsd: budget?.turnCostUsd ?? turnCostUsd ?? 0 });
            await saveConversationState(db, {
                conversationId,
                tenantId,
                projectId,
                agentKey,
                state: result.state,
                messageCount: updatedMessages.length,
                ...(pause ? { pausedSnapshot: pause.snapshot } : {}),
            });
        }

        logger.info(supersededByDeadlineOrCancel ? 'Agent chat completed but superseded (not persisted)' : 'Agent chat completed', {
            agentKey,
            conversationId,
            messageCount: updatedMessages.length,
            persisted: !supersededByDeadlineOrCancel,
            ...(outcome.stopReason !== 'completed' ? { stopReason: outcome.stopReason, stopDetail: outcome.stopDetail } : {}),
        });

        for (const event of outputFileEvents(conversationId, outputFiles.attachments)) turnEvents.emitInTurn('agent.output_file', event);
        for (const action of pause?.actions ?? []) turnEvents.emitInTurn('action.required', actionRequiredEventData(action));
        await turnEvents.finish({
            // A turn the deadline or an async cancel already decided was not
            // persisted; the log says what the caller was told.
            stopReason: supersededByDeadlineOrCancel ? 'cancelled' : sessionStopReason(outcome.stopReason, pause, budget),
            ...(pause ? { pendingActionIds: pause.actions.map((action) => String(action._id)) } : {}),
            content: outcome.content,
            messageIndex: updatedMessages.length - 1,
            userMessage: persistedUserMessage,
            ...(usage ? { usage: { ...usage } } : {}),
            ...(outcome.stopDetail ? { detail: outcome.stopDetail } : {}),
            ...(budget && !supersededByDeadlineOrCancel ? { budget } : {}),
        });

        return toAgentChatResponse({
            conversationId,
            priorMessageCount: conversation.messages?.length ?? 0,
            agentName: agent.name,
            version: resolvedVersion,
            content: outcome.content,
            messages: updatedMessages,
            reasoning: assistantReasoning,
            outcome: budget?.reached ? { stopReason: 'budget_reached', stopDetail: outcome.stopDetail } : outcome,
            usage,
            outputParsed,
            outputError,
            warnings,
            ...(pause ? { pendingActions: pause.actions.map(toPublicPendingAction) } : {}),
        });
    } finally {
        await recordSessionTurnSpend({ db, conversationId, plan: spendAccount, tappedUsd: tappedUsd() });
        await runBoundToolCleanup(cleanupTasks, { agentKey, mode: 'chat' });
    }
}

/**
 * Ephemeral playground chat — runs agent without DB conversation storage.
 * History is passed in-memory from the client. Tracing still fires.
 */
export async function executePlaygroundChat(
    request: AgentPlaygroundChatRequest,
): Promise<AgentPlaygroundChatResult> {
    // Agent-run quota (domain `agent`): this is the entry the dashboard chat,
    // portals and realtime voice share; the caller is the one the server
    // stamped into the runtime context. See agentQuota.ts.
    const caller = agentRunCallerOf(request);
    await assertAgentsEnabled(request);
    await enforceAgentRunQuota(caller);

    // Callbacks and the signal can't serialize over the queue — kept out of
    // the payload (the local fast path still receives the full request) and
    // bridged by the cluster stream relay when the run is routed.
    const payload = { ...request };
    delete payload.onToolEvent;
    delete payload.onTextChunk;
    delete payload.onReasoningChunk;
    delete payload.onCompaction;
    delete payload.onPlan;
    delete payload.onSubagent;
    delete payload.signal;
    const usage = createRunUsageSink();
    let result: AgentPlaygroundChatResult;
    try {
        result = await runWithUsageSink(usage, () => routeInstanceCall(
            {
                entityType: 'agent',
                entityId: agentEntityId(request.tenantId, request.agentKey),
                jobName: 'playground',
            },
            payload as unknown as QueuePayload,
            () => executePlaygroundChatLocal(request),
            { relay: agentRelayOptions(request) },
        ));
    } catch (error) {
        settleAgentRun(caller, usage);
        throw error;
    }
    settleAgentRun(caller, usage, result.usage?.totalTokens);
    return result;
}

/**
 * Flattens the SDK's tool history into the playground's step list.
 *
 * Reads `state.toolHistory` rather than the event stream: the history survives
 * summarization (the archived entry keeps its `executionId`), so a long run
 * still shows every call it made instead of only the ones after the last
 * compaction.
 *
 * Carries the whole entry, not just name/args/output. Two of those fields
 * change what the playground is actually showing you:
 *
 *  - `output` is what the MODEL saw, which under the console's default
 *    `summarize_archive` retention can be a compaction of the real result.
 *    `rawOutput` is the result itself, kept whenever the two differ, so
 *    "what did this tool return" and "what did the model get to read" stop
 *    being the same question with one answer.
 *  - `status` is the SDK's own verdict. Inferring it by sniffing the output
 *    for an `error` key — what this did before — both missed a guardrail
 *    `rejected` call and flagged any tool whose successful result happens to
 *    carry a field called `error`.
 */
/** EXPORTED FOR TESTS — see the failure rules above. */
export function extractPlaygroundSteps(
    result: AgentSdkInvokeResult,
    /**
     * Execution ids the run STARTED with. A turn resumed from a stored state
     * carries the earlier turns' tool history; those calls belong to the turns
     * that made them, not to this one.
     */
    priorExecutionIds?: ReadonlySet<string>,
    /** What the approval gates decided: a call an exception let through or refused names the rule. */
    hitlLog?: Pick<HitlCallLog, 'ruleFor'>,
): AgentPlaygroundStep[] {
    const history = (result.state as { toolHistory?: Array<Record<string, unknown>> } | undefined)?.toolHistory;
    if (!Array.isArray(history)) return [];

    // Calls an approval answered "deny" (the SDK marks the approval `rejected` and the call
    // `rejected` too): a decision, not a failure. A call a guardrail blocked is also `rejected`
    // in the history but has no approval behind it.
    const deniedCallIds = new Set<string>();
    const approvals = (result.state as { pendingApprovals?: Array<{ toolCallId?: unknown; metadata?: { resolution?: unknown } }> } | undefined)?.pendingApprovals;
    for (const approval of Array.isArray(approvals) ? approvals : []) {
        if (approval?.metadata?.resolution === 'rejected' && typeof approval.toolCallId === 'string') deniedCallIds.add(approval.toolCallId);
    }

    // tool_call_id → the text of the assistant message that issued it.
    const narrations = new Map<string, string>();
    const messages = (result.state as { messages?: unknown[] } | undefined)?.messages;
    for (const message of Array.isArray(messages) ? messages : []) {
        const m = message as { role?: unknown; _getType?: () => string; content?: unknown; tool_calls?: Array<{ id?: unknown }> };
        const role = typeof m?.role === 'string' ? m.role : m?._getType?.();
        if ((role !== 'assistant' && role !== 'ai') || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
        const text = agentMessageText(m.content).trim();
        const firstId = m.tool_calls[0]?.id;
        if (text && typeof firstId === 'string') narrations.set(firstId, text);
    }

    return history
        .filter((entry) => !(priorExecutionIds && typeof entry.executionId === 'string' && priorExecutionIds.has(entry.executionId)))
        .map((entry) => {
        const output = entry.output;
        const status = typeof entry.status === 'string'
            ? entry.status as AgentPlaygroundStep['status']
            : undefined;
        // The SDK records `status: 'error'` only when a tool THROWS. A tool
        // that catches its own failure and returns `{ ok: false, error }`
        // instead — `web_search` does — is recorded as a success, so status
        // alone would show a failed search as a green tick. The payload check
        // therefore SUPPLEMENTS status rather than being its fallback.
        //
        // Narrow on purpose: a truthy `error`, or an explicit `ok: false`. An
        // `error: null` field, which plenty of successful results carry, is
        // not a failure, and treating it as one is what made sniffing
        // untrustworthy in the first place.
        const record = output !== null && typeof output === 'object'
            ? output as Record<string, unknown>
            : undefined;
        const delegationError = delegationFailure(typeof entry.toolName === 'string' ? entry.toolName : undefined, output);
        const sniffedError = Boolean(record?.error) || record?.ok === false || Boolean(delegationError);
        const deniedByUser = status === 'rejected' && (
            (typeof entry.tool_call_id === 'string' && deniedCallIds.has(entry.tool_call_id))
            // The SDK words a reviewer's refusal `Rejected: <comment>`; a policy block carries its own reason.
            || (typeof output === 'string' && output.startsWith('Rejected: ') && entry.rawOutput === null)
        );
        const failed = !deniedByUser && (status === 'error' || status === 'rejected' || sniffedError);
        const errorText = failed
            ? (status === 'rejected' ? 'Blocked before the tool ran.' : undefined)
                ?? (record?.error ? String(record.error) : undefined)
                ?? delegationError
                ?? 'The tool call failed.'
            : undefined;

        // The history entry names no child; the delegation call's own result does.
        const subagentOf = typeof entry.subagent === 'string'
            ? entry.subagent
            : delegatedSubagentName(typeof entry.toolName === 'string' ? entry.toolName : undefined, entry.args, output);

        const rawOutput = entry.rawOutput;
        const rawDiffers = rawOutput !== undefined && rawOutput !== output;

        // A step is named by the call the model made (`tool_call_id`, the id on the live events), not by the
        // SDK's random `executionId`: the plan versions, sub-agent runs and summarization passes of the turn
        // anchor on the call id, and a step that carried another id would match none of them.
        const callId = typeof entry.tool_call_id === 'string' && entry.tool_call_id ? entry.tool_call_id : undefined;
        const approvalRule = hitlLog?.ruleFor(typeof entry.toolName === 'string' ? entry.toolName : undefined, entry.args);
        // A blocked call reports the rule, not a generic failure.
        const blockedText = approvalRule?.action === 'deny' && typeof output === 'string'
            ? output.replace(/^Error executing tool:\s*/, '')
            : undefined;

        return {
            id: callId ?? (typeof entry.executionId === 'string' ? entry.executionId : undefined),
            name: typeof entry.toolName === 'string' ? entry.toolName : 'tool',
            args: entry.args,
            output,
            ...(rawDiffers ? { rawOutput } : {}),
            ...(errorText ? { error: blockedText ?? errorText } : {}),
            ...(subagentOf ? { subagent: subagentOf } : {}),
            ...(approvalRule ? { approvalRule } : {}),
            // Reported as an error even when the SDK called it a success,
            // so the transcript, the Events tab and the per-tool failure
            // count all agree with the error text above.
            ...(failed ? { status: 'error' as const } : status ? { status } : {}),
            ...(deniedByUser ? { deniedByUser: true } : {}),
            ...(entry.fromCache === true ? { fromCache: true } : {}),
            ...(entry.summarized === true ? { summarized: true } : {}),
            ...(typeof entry.originalTokenCount === 'number'
                ? { originalTokenCount: entry.originalTokenCount }
                : {}),
            ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
            ...(typeof entry.tool_call_id === 'string' && narrations.has(entry.tool_call_id)
                ? { narration: narrations.get(entry.tool_call_id) }
                : {}),
        };
    });
}

function describeStructuredOutputError(error: unknown): string {
    if (typeof error === 'string') return error;
    const record = error as { message?: unknown; issues?: unknown } | null;
    if (record && typeof record.message === 'string') return record.message;
    return JSON.stringify(error);
}

/**
 * Local (non-routed) implementation. Exported so the queue consumer can call it.
 * A Session turn (one with a `conversationId`) is recorded in the conversation's
 * event log; a throw from anywhere in it becomes a `session.error` there.
 */
export async function executePlaygroundChatLocal(
    request: AgentPlaygroundChatRequest,
): Promise<AgentPlaygroundChatResult> {
    await assertAgentsEnabled(request);
    const scope: { events?: SessionTurnEvents } = {};
    try {
        const runtime = request.runtimeContext;
        const caller: RoutingCallerContext = {
            channel: channelFromSource(runtime?.source) ?? 'playground',
            agentKey: request.agentKey,
            projectId: request.projectId,
            ...(runtime?.userId ? { userId: runtime.userId } : {}),
            ...(runtime?.tokenId ? { apiTokenId: runtime.tokenId } : {}),
            ...Object.fromEntries(Object.entries(request.callerContext ?? {}).filter(([, v]) => v !== undefined)),
            run: {},
        };
        return await runWithRoutingCaller(caller, () => runWithKnowledgeExposure(new KnowledgeExposure(), () => runPlaygroundChatTurn(request, scope)));
    } catch (error) {
        await scope.events?.fail(error).catch(() => undefined);
        throw error;
    }
}

async function runPlaygroundChatTurn(
    request: AgentPlaygroundChatRequest,
    scope: { events?: SessionTurnEvents },
): Promise<AgentPlaygroundChatResult> {
    const { tenantDbName, tenantId, projectId, agentKey, userMessage } = request;

    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentByKey(agentKey, projectId);
    if (!agent) throw new Error(`Agent "${agentKey}" not found`);
    assertOwnedAgentReachable(agent, request.runtimeContext);

    // A real Session: load its history from storage rather than trusting
    // whatever the caller sent, and remember the row so the exchange can be
    // written back once the run finishes. Scoped to this agent+project — a
    // conversation id for a DIFFERENT agent must 404, not quietly attach.
    let sessionConversation: IAgentConversation | null = null;
    if (request.conversationId) {
        const found = await db.findAgentConversationById(request.conversationId);
        if (!found || found.agentKey !== agentKey || found.projectId !== projectId) {
            throw new Error(`Session "${request.conversationId}" not found`);
        }
        sessionConversation = found;
    }
    // The draft unless a version is asked for. Reading the published snapshot
    // is what makes "does my change actually help?" answerable in one screen.
    let config = agent.config;
    let ranVersion: number | null = null;
    if (typeof request.version === 'number') {
        const snapshot = await db.findAgentVersion(String(agent._id), request.version);
        if (!snapshot) throw new Error(`Version ${request.version} not found for agent "${agentKey}"`);
        config = snapshot.snapshot.config;
        ranVersion = request.version;
    }
    const offersModels = config.kind !== 'external' && config.kind !== 'flow' && additionalModelKeys(config).length > 0;
    const modelChoice: AgentModelChoice | undefined = offersModels
        ? applyAgentModelChoice(config, { chosen: request.modelKey, sessionMetadata: sessionConversation?.metadata })
        : undefined;
    if (modelChoice && modelChoice.modelKey !== config.modelKey) config = applyModelToConfig(config, modelChoice.modelKey);
    // Attachments are judged from this config below, before the agent is built.
    config = await applyServiceAvailability(tenantId, config, { agentKey });

    // A message that arrives while the session waits on an approval or a
    // question is refused (or cancels the request) per the agent's own setting.
    // Checked before the event log opens: a refusal must not mark the session
    // idle or write an error into it.
    const hitlSettings = resolveHitlConfig(config.humanInTheLoop);
    if (sessionConversation) await assertNoBlockingPending(db, sessionConversation, hitlSettings);

    // The files this message attaches must be files of this session.
    const attachedRecords = await resolveMessageAttachments({
        tenantDbName, tenantId, projectId, conversation: sessionConversation, config, fileIds: request.attachments,
    });

    // The session's own budget (a Session only — a stateless call has none) and
    // the tenant's spend limit, for a turn that calls a model. Refused before the
    // event log opens, like the check above.
    const callsModel = !(config.kind === 'external' && config.connection) && config.kind !== 'flow';
    const budgetPlan = callsModel && sessionConversation
        ? planSessionBudget(sessionConversation, config.runtime?.limits?.maxCostUsd)
        : null;
    // Every turn of a Session adds its spend to the session's total — with a budget or without one.
    const spendAccount = sessionConversation ? (budgetPlan ?? startSessionSpendAccount(sessionConversation)) : null;
    const spend = callsModel && config.modelKey
        ? await resolveAgentSpendScope({
            tenantDbName, tenantId, projectId,
            userId: request.runtimeContext?.userId ?? (sessionConversation ? String(sessionConversation.createdBy) : undefined),
        })
        : undefined;
    if (spend) await assertAgentTurnSpendAllowed(spend, config);
    // Keeps each message's `attachments`: a replay of the transcript shows the model the files again.
    const history = sessionConversation
        ? sessionConversation.messages.map((m) => ({
            role: m.role,
            content: m.content ?? '',
            ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        }))
        : request.history;
    // Only a persisted Session has an event log; a stateless call has nowhere to put one.
    const turnEvents = sessionConversation
        ? startSessionTurnEvents({
            db,
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            conversationId: String(sessionConversation._id),
            userMessage,
            trigger: 'message',
            ...(modelChoice ? { model: modelChoice } : {}),
        })
        : undefined;
    scope.events = turnEvents;
    if (turnEvents && sessionConversation) noteRoutingRun({ conversationId: String(sessionConversation._id), turnId: turnEvents.turnId });
    if (sessionConversation) await bindKnowledgeExposure(db, sessionConversation);
    if (sessionConversation && hitlSettings.onUserMessageWhilePending === 'cancel_pending'
        && sessionConversation.runtimeStatus === 'requires_action') {
        sessionConversation = await cancelPendingForNewMessage(db, sessionConversation, turnEvents?.emit);
        await endRunsOfDroppedPause(db, { tenantId, projectId, conversationId: String(sessionConversation._id) });
    }
    // Text deltas ride the caller's own stream callback (see `runAgentChatTurn`).
    const onTextChunk = turnEvents && request.onTextChunk
        ? (text: string) => {
            turnEvents.onText(text);
            request.onTextChunk?.(text);
        }
        : request.onTextChunk;
    const onReasoningChunk = turnEvents && request.onReasoningChunk
        ? (text: string) => {
            turnEvents.onReasoning(text);
            request.onReasoningChunk?.(text);
        }
        : request.onReasoningChunk;
    // A Session resumes from the state its last turn ended in (tool results,
    // summaries, plan) — the text transcript alone lost all of that. A
    // stateless call has only the history it was handed.
    const carried = sessionConversation ? await loadConversationState(db, sessionConversation) : null;

    // Context entered when the session was started applies to every turn in it.
    // Merged UNDER the request's own context so a per-message override still
    // wins — and merged per-key rather than wholesale, or setting one header on
    // one turn would silently drop the session's whole context for that turn.
    const runtimeContext = mergeSessionRuntimeContext(sessionConversation, request.runtimeContext);

    // Connected (external) agent — see `runExternalAgentTurn`. `content` is
    // the guarded answer: the only copy for a stateless call, and what a
    // Session persists — never the raw upstream reply.
    if (config.kind === 'external' && config.connection) {
        const externalStartedAt = Date.now();
        const { content, cancelled } = await runExternalAgentTurn({
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            config,
            connection: config.connection,
            history: history || [],
            userMessage,
            runtimeContext,
            source: 'agent-playground',
            onTextChunk,
            signal: request.signal,
            persistPartial: Boolean(sessionConversation),
        });

        const externalResult: AgentPlaygroundChatResult = {
            content,
            version: ranVersion,
            ...(cancelled
                ? { stopReason: 'cancelled' as const, stopDetail: CALLER_ABORT_DETAIL, latencyMs: Date.now() - externalStartedAt }
                : {}),
        };
        if (sessionConversation) {
            const messageCount = await persistSessionTurn(db, sessionConversation, userMessage, externalResult);
            await turnEvents?.finish({
                stopReason: toSessionStopReason(cancelled ? 'cancelled' : 'completed'),
                content,
                ...(messageCount !== undefined ? { messageIndex: messageCount - 1 } : {}),
                ...(externalResult.stopDetail ? { detail: externalResult.stopDetail } : {}),
            });
        }

        logger.info('Connected agent playground chat completed', { agentKey });
        return externalResult;
    }

    // FlowBase agent — see `runFlowAgentTurn`. The reply carries the run behind it as `metadata.flow`,
    // which a Session stores so the next message resumes a waiting run.
    if (config.kind === 'flow') {
        const flowStartedAt = Date.now();
        const flowTurn = await runFlowAgentTurn({
            tenantDbName,
            tenantId,
            projectId,
            agentKey,
            config,
            userMessage,
            ...(sessionConversation ? { conversationId: String(sessionConversation._id) } : {}),
            priorMessages: sessionConversation?.messages ?? [],
            runtimeContext,
            source: 'agent-playground',
            onTextChunk,
        });
        // The operator's view gets the step agents' reasoning; the Session stores it only when this agent shows it.
        const flowResult: AgentPlaygroundChatResult = {
            content: flowTurn.content,
            version: ranVersion,
            latencyMs: Date.now() - flowStartedAt,
            ...flowActivityFields(flowTurn.activity, true),
            ...(flowTurn.meta ? { metadata: { flow: flowTurn.meta } } : {}),
        };
        if (sessionConversation) {
            const stored = agentShowsReasoning(config) ? flowResult : { ...flowResult, reasoning: undefined };
            const messageCount = await persistSessionTurn(db, sessionConversation, flowTurn.userMessage, stored);
            await turnEvents?.finish({
                stopReason: toSessionStopReason('completed'),
                content: flowTurn.content,
                ...(messageCount !== undefined ? { messageIndex: messageCount - 1 } : {}),
            });
        }

        logger.info('FlowBase agent playground chat completed', { agentKey });
        return flowResult;
    }

    const { sdkAgent, model, systemPrompt, cleanupTasks, warnings, hitl, costEstimator, tappedUsd, routedModel, outputLimit, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity, hitlLog } = await buildLocalAgentRun({
        db,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        agent,
        config,
        runtimeContext,
        // The playground carries no authenticated principal down to here, so
        // the agent stands in for itself. `roles` is `['agent']` either way,
        // which is what `tool_access.allowedRoles` matches on — so a policy
        // verified here behaves the same in production.
        actorId: `agent:${agentKey}`,
        source: 'agent-playground',
        route: 'agent.playground',
        userId: runtimeContext?.userId,
        conversation: sessionConversation,
        memoryConversationId: sessionConversation ? String(sessionConversation._id) : undefined,
        // A session's turns group under one Observability thread, the same way
        // API turns do — the agent Sessions drawer renders that thread.
        threadId: request.conversationId,
        // A stateless call has nowhere to park a paused turn.
        canPause: Boolean(sessionConversation),
        ...(request.embedded ? { embedded: request.embedded } : {}),
        ...(spend ? { spend } : {}),
        ...(modelChoice ? { modelChoice } : {}),
        ...(request.requestReasoning ? { requestReasoning: request.requestReasoning } : {}),
        ...(request.revealReasoning ? { revealReasoning: true } : {}),
        ...(request.onReasoningChunk ? { onReasoningChunk: request.onReasoningChunk } : {}),
        // A reminder set here wakes the session on the config this turn ran: the draft, or the version picked.
        reminders: ranVersion !== null ? { version: ranVersion, usePublished: true } : { usePublished: false },
    });

    const attached = await assembleMessageAttachments({
        tenantDbName, tenantId, projectId, records: attachedRecords, config, model, warnings,
    });
    const inputState = buildTurnInputState({
        carried,
        transcript: history || [],
        userMessage,
        userContent: buildUserTurnContent(userMessage, attached),
        systemPrompt,
        attachments: await earlierAttachments({ db, conversation: sessionConversation, config, model }),
    });
    const priorExecutionIds = new Set(
        (carried?.toolHistory ?? [])
            .map((entry) => (entry as { executionId?: unknown }).executionId)
            .filter((id): id is string => typeof id === 'string'),
    );

    // Surface progress to the caller (best-effort; never fails the run).
    const { onToolEvent, onCompaction, onPlan, onSubagent, signal } = request;
    // The plan, the sub-agents and the summarization passes of the turn are recorded either way;
    // forwarded live so a session shows each as it happens.
    const flow = createTurnFlowTracker({ targets: subagentTargets(activeSubagentEntries(config)) });
    const flowSink = createTurnFlowSink({ tracker: flow, turnEvents, agentKey, onToolEvent, onCompaction, onPlan, onSubagent });
    const streamed = captureStreamedText(onTextChunk);
    // The operator's playground always sees the thinking the model produced.
    const reasoningTap = createReasoningTap(onReasoningChunk, agentKey);
    const invokeConfig = {
        onEvent: (event: AgentSdkEvent) => {
            reasoningTap.onEvent(event);
            noteSdkEvent(event);
            flowSink(event);
        },
        ...liveStreamOptions(agentMayStreamAnswer(config) ? streamed.onTextChunk : undefined, reasoningTap, agentKey),
        // The SDK checks it between steps and hands it to the model call.
        ...(signal ? { cancellationToken: signal } : {}),
        ...sessionBudgetInvokeOptions(budgetPlan),
    };

    const invokeStartedAt = Date.now();
    try {
        const settled: AgentSdkInvokeResult | null = await runWithTurnSignal(signal, () => sdkAgent.invoke(inputState, invokeConfig))
            .catch((error: unknown) => {
                // The caller aborted and the in-flight model call threw for
                // it: an aborted turn resolves with what it had streamed.
                if (signal?.aborted) return null;
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            });

        if (!settled) {
            const aborted: AgentPlaygroundChatResult = {
                content: streamed.text(),
                latencyMs: Date.now() - invokeStartedAt,
                version: ranVersion,
                stopReason: 'cancelled',
                stopDetail: CALLER_ABORT_DETAIL,
                ...turnFlowRecord(flow, () => []),
                ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
            };
            logger.info('Playground chat aborted by caller mid-call', { agentKey });
            if (sessionConversation) {
                // The streamed text never reached the SDK's post-model check;
                // it is guarded before it becomes stored history. No state is
                // saved — the next turn replays the transcript instead.
                aborted.content = await evaluateBoundGuardrails({
                    tenantDbName, tenantId, projectId, config, hook: 'output.pre', text: aborted.content,
                    source: 'agent-playground',
                });
                const messageCount = await persistSessionTurn(db, sessionConversation, userMessage, aborted, attached.attachments);
                await turnEvents?.finish({
                    stopReason: 'cancelled',
                    content: aborted.content,
                    ...(messageCount !== undefined ? { messageIndex: messageCount - 1 } : {}),
                    detail: CALLER_ABORT_DETAIL,
                });
            }
            return aborted;
        }
        const result = settled;

        const blocked = guardrailBlockedError(result);
        if (blocked) throw blocked;

        const assistantReasoning = turnReasoning(result, reasoningTap);

        // Already adjudicated by the plugin's `postModelCall`; see the live path.
        //
        // A run a limit or a cancellation cut short has no final answer; the
        // outcome carries why, and the last text the agent did write.
        const turnOutcome = endedByCallerAbort(describeRunOutcome(result, inputState.messages.length, outputLimit), signal);
        const flowRecord = turnFlowRecord(flow, () => compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined));

        // Priced below; the session budget (if any) is settled once the cost is known.
        let outcome: AgentTurnOutcome = turnOutcome;

        logger.info('Playground chat completed', {
            agentKey,
            ...(outcome.stopReason !== 'completed' ? { stopReason: outcome.stopReason, stopDetail: outcome.stopDetail } : {}),
        });

        // Files the agent left in the sandbox's /outputs/ ride on the answer (never fails the turn).
        const outputFiles = sessionConversation ? await collectOutputs() : { attachments: [], warnings: [] };
        for (const warning of outputFiles.warnings) warnings.add(warning);

        await reconcileTrace(normalizePlaygroundUsage(result.metadata?.usage)?.usage);
        const playgroundResult: AgentPlaygroundChatResult = {
            content: outcome.content,
            ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
            ...(result.output !== undefined ? { output: result.output } : {}),
            ...(result.outputError
                ? { outputError: describeStructuredOutputError(result.outputError) }
                : {}),
            ...(normalizePlaygroundUsage(result.metadata?.usage) ?? {}),
            latencyMs: Date.now() - invokeStartedAt,
            steps: extractPlaygroundSteps(result, priorExecutionIds, hitlLog),
            ...(outputFiles.attachments.length > 0 ? { attachments: outputFiles.attachments } : {}),
            version: ranVersion,
            ...answeredWithMetadata(model.key, Boolean(modelChoice), routedModel()),
            ...(outcome.stopReason !== 'completed'
                ? { stopReason: outcome.stopReason, ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}) }
                : {}),
            ...flowRecord,
            ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
            ...(request.previousVersions?.length ? { previousVersions: request.previousVersions.slice(-MAX_PREVIOUS_VERSIONS) } : {}),
        };

        const costUsd = await priceAgentTurn({
            plan: budgetPlan, result, costEstimator, pricing: model.pricing, model, usage: playgroundResult.usage,
        });
        if (costUsd !== undefined && playgroundResult.usage) {
            playgroundResult.usage.costUsd = costUsd;
        }
        const budget = budgetPlan
            ? settleSessionBudget(budgetPlan, costUsd, isSessionBudgetBreach(budgetPlan, turnOutcome), turnOutcome.stopReason)
            : undefined;
        if (budget?.reached) {
            outcome = budgetAwareOutcome(turnOutcome, budget);
            // A turn that finished on its own keeps its answer unmarked: the
            // session (stop reason, status, events) says the budget was reached.
            if (outcome.stopReason !== 'completed') playgroundResult.stopDetail = outcome.stopDetail;
        }

        if (sessionConversation) {
            // The run stopped for a person: keep what it needs to continue.
            let pause: OpenedPause | null = null;
            if (outcome.stopReason === 'paused') {
                const pausedFor = consoleIdentityPersonOf(identity);
                pause = await openPause(db, {
                    state: result.state,
                    source: 'agent-playground',
                    tenantId,
                    projectId,
                    agentKey,
                    conversationId: String(sessionConversation._id),
                    hitl,
                    approvalLog: hitlLog,
                    agentVersion: ranVersion,
                    usePublished: ranVersion !== null,
                    ...(pausedFor ? { turn: { identity: pausedFor } } : {}),
                    createdBy: runtimeContext?.userId ?? String(sessionConversation.createdBy),
                });
                if (pause) playgroundResult.pendingActions = pause.actions.map(toMessagePendingAction);
                else {
                    // The run cannot be continued: it failed, and says so — not a quiet end of turn.
                    playgroundResult.warnings = [...(playgroundResult.warnings ?? []), PAUSE_UNAVAILABLE_WARNING];
                    const failed = pauseUnavailableOutcome(outcome);
                    outcome = failed;
                    playgroundResult.stopReason = failed.stopReason;
                    playgroundResult.stopDetail = failed.stopDetail;
                    await failTrace(PAUSE_UNAVAILABLE_WARNING);
                }
            }
            // The operator's playground view always gets the thinking text; what is STORED on the
            // session (and read back through the session API) follows the agent's setting.
            const messageCount = await persistSessionTurn(
                db,
                sessionConversation,
                userMessage,
                agentShowsReasoning(config) ? playgroundResult : { ...playgroundResult, reasoning: undefined },
                attached.attachments,
            );
            if (messageCount !== undefined) {
                await addSessionTurnSpend({
                    db, conversationId: String(sessionConversation._id), plan: spendAccount, spentUsd: budget?.turnCostUsd ?? costUsd ?? 0,
                });
                await saveConversationState(db, {
                    conversationId: String(sessionConversation._id),
                    tenantId,
                    projectId,
                    agentKey,
                    state: result.state,
                    messageCount,
                    ...(pause ? { pausedSnapshot: pause.snapshot } : {}),
                });
            }
            for (const event of outputFileEvents(String(sessionConversation._id), outputFiles.attachments)) turnEvents?.emitInTurn('agent.output_file', event);
            for (const action of pause?.actions ?? []) turnEvents?.emitInTurn('action.required', actionRequiredEventData(action));
            await turnEvents?.finish({
                stopReason: sessionStopReason(outcome.stopReason, pause, budget),
                ...(pause ? { pendingActionIds: pause.actions.map((action) => String(action._id)) } : {}),
                content: playgroundResult.content,
                ...(messageCount !== undefined ? { messageIndex: messageCount - 1 } : {}),
                ...(playgroundResult.usage ? { usage: { ...playgroundResult.usage } } : {}),
                ...(outcome.stopDetail ? { detail: outcome.stopDetail } : {}),
                ...(budget ? { budget } : {}),
            });
        }

        return playgroundResult;
    } finally {
        if (sessionConversation) {
            await recordSessionTurnSpend({ db, conversationId: String(sessionConversation._id), plan: spendAccount, tappedUsd: tappedUsd() });
        }
        await runBoundToolCleanup(cleanupTasks, { agentKey, mode: 'playground' });
    }
}

/**
 * Appends one exchange (user turn + the rich assistant turn) to a Session's
 * conversation record.
 *
 * Best-effort by design: a persistence failure must not turn a successful
 * model run into an error the caller sees as "the agent failed" — it already
 * answered. The turn is simply missing on reload, which is recoverable
 * (retype the question) in a way a lost answer to a guardrail-approved,
 * already-billed model call is not.
 */
async function persistSessionTurn(
    db: Awaited<ReturnType<typeof getDatabase>>,
    conversation: IAgentConversation,
    userMessage: string,
    result: AgentPlaygroundChatResult,
    /** Files the user message attaches. */
    attachments?: IAgentMessageAttachment[],
): Promise<number | undefined> {
    try {
        const now = new Date();
        const messages: IAgentConversation['messages'] = [
            ...conversation.messages,
            {
                role: 'user',
                content: userMessage,
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
                timestamp: now,
            },
            {
                role: 'assistant',
                content: result.content,
                timestamp: now,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                ...(result.steps && result.steps.length > 0 ? { steps: result.steps } : {}),
                ...(result.attachments && result.attachments.length > 0 ? { attachments: result.attachments } : {}),
                ...(result.output !== undefined ? { output: result.output } : {}),
                ...(result.outputError ? { outputError: result.outputError } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
                ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
                ...(result.metadata ? { metadata: result.metadata } : {}),
                ...(result.stopReason ? { stopReason: result.stopReason } : {}),
                ...(result.stopDetail ? { stopDetail: result.stopDetail } : {}),
                ...(result.compactions?.length ? { compactions: result.compactions } : {}),
                ...(result.compactedTools?.length ? { compactedTools: result.compactedTools } : {}),
                // An empty list is kept: it says the turn recorded its plan versions (and wrote none).
                ...(Array.isArray(result.plans) ? { plans: result.plans } : {}),
                ...(result.subagentRuns?.length ? { subagentRuns: result.subagentRuns } : {}),
                ...(result.subagentRunsDropped ? { subagentRunsDropped: result.subagentRunsDropped } : {}),
                ...(result.warnings?.length ? { warnings: result.warnings } : {}),
                ...(result.pendingActions?.length ? { pendingActions: result.pendingActions } : {}),
                ...(result.previousVersions?.length ? { previousVersions: result.previousVersions } : {}),
                version: result.version ?? null,
            },
        ];
        await db.updateAgentConversation(String(conversation._id), {
            messages,
            // First exchange in a freshly-created "New session" names itself
            // after what was actually asked, same convention the live chat
            // path already uses for its conversation titles.
            title: firstTurnTitle(conversation, messages.length, userMessage, attachments),
        });
        return messages.length;
    } catch (error) {
        logger.error('Failed to persist session turn', {
            conversationId: String(conversation._id),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}


// ── Continuing a paused turn ────────────────────────────────────────────

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
    };
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

    let agent: IAgent;
    let config: IAgentConfig;
    let version: number | null = null;
    if (continuation.usePublished || continuation.version !== undefined) {
        const resolved = await resolveAgentConfig(request.tenantDbName, request.agentKey, request.projectId, continuation.version);
        agent = resolved.agent;
        config = resolved.config;
        version = resolved.resolvedVersion;
    } else {
        const found = await db.findAgentByKey(request.agentKey, request.projectId);
        if (!found) throw new Error(`Agent "${request.agentKey}" not found`);
        agent = found;
        config = found.config;
    }
    return { conversation, agent, config, version, carried };
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
        const messages = [...(conversation.messages ?? []), assistantMessage];

        if (!superseded) {
            await db.updateAgentConversation(conversationId, { messages });
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
