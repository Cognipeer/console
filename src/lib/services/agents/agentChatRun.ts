/**
 * Agent chat run: the live (Responses-shaped) turn of an agent, from the quota gate and routing to the local run, plus the builder every local run goes through.
 */

import { getFlowsHost, FlowsUnavailableError, type FlowAgentTurnActivity } from '@/enterprise/flows';
import type { AgentFlowReplyMeta } from '@/lib/flows/agentTypes';
import {
    channelFromSource,
    getRoutingCaller,
    noteRoutingRun,
    runWithRoutingCaller,
    type RoutingCallerContext,
} from '@/lib/services/models/routingCallerContext';
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
import { getDatabase, runWithTenantScope, type DatabaseProvider, type AgentResponseFormat, type IAgent, type IAgentConfig, type IAgentConversation } from '@/lib/database';
import { KnowledgeExposure, kbReaderOfFollowUp, runWithKnowledgeExposure } from '@/lib/services/rag/access';
// Imported BY PATH because the barrel does not re-export it. `resolveBindings`
// is the ONE implementation of "which guardrails run on this hook"; a
// hand-rolled legacy fallback here would drift from the gateway's and produce a
// guardrail that silently stops running on one surface while the UI still shows
// it attached.
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import type { PluginMessageRewrite } from '@/lib/services/guardrail/sdkAdapter';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { consoleIdentityCallerOf, consoleIdentityPersonOf, type ConsoleIdentityCaller, type ConsoleIdentityPerson } from '@/lib/iam/consoleIdentity';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import { type TraceToolDefinition } from '@/lib/services/tracingToolDefinitions';
import { resolveRuntimeHeaders, type AgentRuntimeContext } from '@/lib/services/runtimeContext';
import { invokeExternalAgent } from './externalAgent';
import { normalizePlaygroundUsage } from './playgroundUsage';
import { createOutputLimitTap } from './outputLimitNotice';
import { createImageAwareTokenCounter } from './imageTokenCounter';
import { withSessionImages, type SessionImagesOptions } from './sessionImages';
import { createCompositeImageSource, createToolMediaStore, withToolMedia, type ToolMediaContext } from './toolMedia';
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
import { agentSpendSettler, assertAgentTurnSpendAllowed, resolveAgentSpendScope, type AgentSpendScope } from './agentSpendLimits';
import {
    activeSessionBudget,
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
    loadConversationState,
    saveConversationState,
    type AgentStopReason,
} from './agentTurnState';
import { toSessionStopReason, type SessionStopReason } from './sessionEvents';
import { startSessionTurnEvents, type SessionTurnEvents } from './sessionTurnEvents';
import { createTurnFlowTracker, subagentTargets } from './turnFlowTracker';
import { resolveAgentConfig } from './agentConfigResolution';
import { activeSubagentEntries } from './subagentRoster';
import {
    buildClientTools,
    checkEmbeddedClientTools,
    clientToolNeedsApproval,
    clientToolSurfaceOf,
    clientToolsOnSurface,
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
import { createHitlCallLog } from './agentHitlExceptions';
import { additionalModelKeys, applyAgentModelChoice, type AgentModelChoice } from './agentModelSelection';
import { agentReasoningForModel, agentShowsReasoning, applyModelToConfig } from './agentReasoning';
import type { NormalizedReasoning } from '@/lib/services/models/reasoning';
import {
    PAUSE_UNAVAILABLE_WARNING,
    pauseUnavailableOutcome,
    actionRequiredEventData,
    assertNoBlockingPending,
    cancelPendingForNewMessage,
    openPause,
    toMessagePendingAction,
    toPublicPendingAction,
    type OpenedPause,
    type PausedTurnOptions,
    type PublicPendingAction,
} from './agentPendingActions';
import { composeUserMessageWithVariables } from './agentVariables';
import { createAgentToolGuard, protectBuiltTool } from './agentToolGuard';
import {
    CALLER_ABORT_DETAIL,
    agentRelayOptions,
    agentRunCallerOf,
    bridgeCancellationCell,
    captureStreamedText,
    incompleteReason,
    isCancellationCellTripped,
    type AgentChatRequest,
    type AgentChatResponse,
} from './agentChatTypes';
import { budgetAwareOutcome, buildAgentCostEstimator, priceAgentTurn } from './agentCost';
import { KNOWLEDGE_FIRST_INSTRUCTION, bindKnowledgeExposure, buildAgentKnowledgeTools, knowledgeCallerOf } from './agentKnowledgeTools';
import {
    evaluateBoundGuardrails,
    warnUnservableStreamBinding,
    buildAgentGuardrailPlugins,
    MessageRewriteLedger,
    persistedUserTurn,
    warnUnservableExternalBindings,
    guardrailBlockedError,
} from './agentGuardrails';
import { buildTracingMetadata, reconcileTraceTotals, markTraceSessionFailed, createInternalTracingSink } from './agentTracing';
import { resolveAgentPrompt } from './agentPrompt';
import { deferredWarnings, settleInOrder, started } from './concurrentBuild';
import { assertOwnedAgentReachable, ownedAgentFlowTags, buildAgentSubagents } from './agentSubagents';
import { buildBoundTools, runBoundToolCleanup } from './agentBoundTools';
import { endRunsOfDroppedPause, buildAgentChatModel, describeRunOutcome } from './agentRecords';
import { answeredWithMetadata, createReasoningTap, liveStreamOptions, createTurnFlowSink, turnFlowRecord, turnReasoning } from './agentStreamTaps';
import { resolveMessageAttachments, assembleMessageAttachments, earlierAttachments, outputFileEvents, mergeSessionRuntimeContext } from './agentAttachments';
import { extractPlaygroundSteps, describeStructuredOutputError } from './agentPlaygroundSteps';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

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
export async function runExternalAgentTurn(input: {
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
export async function runFlowAgentTurn(input: {
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
export function flowActivityFields(
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
export async function buildLocalAgentRun(input: {
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
    // Bindings of a switched-off service (knowledge engine, MCP, tools, browser, web search, memory,
    // files, sandbox) are dropped here, so every builder below sees a config without them.
    const config = await applyServiceAvailability(tenantId, input.config, { agentKey });
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
    // Non-fatal failures during the run (memory, sandbox, sub-agents), reported with the answer.
    const warnings = new Set<string>();

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

    const filesCfg = resolveAttachmentsConfig(config.attachments);
    const sessionFilesScope = { tenantDbName, tenantId, projectId };
    const outputsOn = outputsAvailability(config);
    const sessionBudgetActive = Boolean(activeSessionBudget(input.conversation));
    // What the session allowed ahead of time: read by the approval gates of the run and of its sub-agents.
    const allowedTools = sessionAllowedTools(input.conversation?.metadata);
    let traceSessionId: string | undefined;
    // The run's usage rows name the trace session once it is open (its first streamed event).
    const callerRun = getRoutingCaller()?.run;
    const approvalSubagents = new Map<string, string>();

    // EVERYTHING BELOW THAT ONLY READS IS STARTED TOGETHER and awaited once (see `settleInOrder`): the model, the
    // prompt, the guardrails and every tool builder run side by side, so turn setup takes as long as its slowest
    // read instead of the sum of all of them. Three things stay exactly as they were when it was one chain of awaits:
    //  - the tools are pushed, and the warnings emitted, in the original order (the model sees that order, and it
    //    decides prompt-cache hits), because each builder only hands back its result;
    //  - the error that is thrown is the first of the original order, not the first to fail in time;
    //  - a builder that opened something (a browser session, a sandbox, a sub-agent's tools) has it closed when
    //    another builder fails, instead of leaving it open.
    // A builder that needs another one's result waits for it: the sub-agents are given the `read` tool and the
    // session's images, which come from the model, the sandbox and the session's files.
    const builtCleanups: Array<() => Promise<void>> = [];
    const sandboxWarnings = deferredWarnings(warnings);
    const subagentWarnings = deferredWarnings(warnings);
    const costWarnings = deferredWarnings(warnings);
    const sdkP = Promise.all([import('@cognipeer/agent-sdk'), import('zod')]);

    const modelP = buildAgentChatModel(tenantDbName, tenantId, projectId, config.modelKey, {
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
    const promptP = resolveAgentPrompt({ db, projectId, agentKey, config, systemPrompt: config.systemPrompt, variables: promptVariables });
    const pluginsP = buildAgentGuardrailPlugins({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        actorId,
        source,
        onMessageRewrite: input.onMessageRewrite,
    });
    // RAG retrieval tools (the instruction to use them first is added to the prompt below)
    const knowledgeP = hasKnowledgeConfigured(config)
        ? buildAgentKnowledgeTools(tenantDbName, tenantId, projectId, config, toolGuard, { caller: kbCaller })
        : undefined;

    // Bound tools from toolBindings (MCP, future sources)
    const boundP = sdkP.then(([{ createTool }, { z }]) => buildBoundTools(
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
    )).then((built) => {
        builtCleanups.push(...built.cleanupTasks);
        return built;
    });

    // What the session already holds, and whether the files bucket works: both only decide which file tools exist.
    const sessionFactsP: Promise<Awaited<ReturnType<typeof conversationFileFacts>>> = input.conversation && (agentTakesAttachments(config) || outputsOn.available)
        ? conversationFileFacts(db, String(input.conversation._id))
        : Promise.resolve({ any: false, images: false });
    const bucketP = input.conversation && outputsOn.available
        ? inspectFileBucket(db, tenantId, projectId, outputsOn.cfg.bucketKey).catch(() => null)
        : Promise.resolve(null);

    // Sandbox access (Enterprise). Provisioned on first use; cleaned up with
    // the other bound tools once the run is over. A conversation keeps a
    // persistent sandbox across its turns, a stateless call gets a throwaway one.
    const sandboxP = sdkP.then(([{ createTool }, { z }]) => buildAgentSandboxTools({
        sandbox: config.sandbox,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversation: input.conversation,
        createToolFn: createTool,
        zod: z,
        protect: (name, tool) => protectBuiltTool(toolGuard, { name, requestedName: tool.name }, tool),
        onWarning: sandboxWarnings.add,
        outputs: { agentConfig: config, actorId, ...(runtimeContext?.tokenId ? { tokenId: runtimeContext.tokenId } : {}) },
    })).then((built) => {
        builtCleanups.push(built.cleanup);
        return built;
    });

    // The model's view of files: the `read` tool (one tool for the sandbox's files and the conversation's, images, PDFs and
    // video included) and the images in this session's context, which are references (a session file, or a tool's image of
    // this run) whose bytes are read at the model call. Wrapped even for an agent that no longer takes files (its saved
    // state can still hold references) and for a stateless run, which still shows what its tools return.
    const mediaP = Promise.all([modelP, sdkP, sessionFactsP, sandboxP]).then(([{ model, chatModel }, [{ createTool }, { z }], sessionFacts, sandboxTools]) => {
        const modelTakesImages = resolveModelCapabilities(model).inputModalities.includes('image');
        // What this run's tools showed the model (screenshots, rendered pages): shared with its sub-agents.
        const toolMedia: ToolMediaContext = {
            store: createToolMediaStore(),
            modelTakesImages,
            maxImageBytes: Math.min(filesCfg.maxBytes, 5 * 1024 * 1024),
        };
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
        // Outermost: whatever the SDK sends the model passes through the image resolver first
        // (sessionImages.ts), so the SDK, the saved state and the traces only ever see references.
        // The model itself is a gateway call (gatewayChatModel.ts): usage, cost and the model's
        // own rules are the gateway's business, not this layer's.
        const sdkModel = sessionImages ? withSessionImages(chatModel, sessionImages) : chatModel;
        return { modelTakesImages, toolMedia, readSession, readTool, sessionImages, sdkModel };
    });

    const subagentsP = Promise.all([mediaP, sdkP]).then(([{ toolMedia, modelTakesImages, sessionImages }, [{ createTool }, { z }]]) => buildAgentSubagents({
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
        onWarning: subagentWarnings.add,
        approvals: { hitl, mode: hitlMode, run: { unattended: input.unattended, canPause: input.canPause }, allowedTools, log: hitlLog },
    })).then((built) => {
        builtCleanups.push(...built.cleanupTasks);
        return built;
    });

    // A skill whose access list keeps this run's person out is left out of the catalog (managed:access:*).
    const skillsP = buildAgentSkills(tenantDbName, projectId, config.skills, {
        tenantDbName,
        tenantId,
        caller: identity,
        source: runtimeContext?.source,
    }, agent._id ? String(agent._id) : undefined);
    // A hidden agent a flow owns is traced under its flow even when no flow run started the turn (the Build editor's playground).
    const ownerTagsP = !runtimeContext?.flow && agent.owner ? ownedAgentFlowTags(tenantDbName, agent) : Promise.resolve(undefined);

    const built = await settleInOrder([
        modelP, promptP, pluginsP, sdkP, knowledgeP, boundP, sessionFactsP, bucketP, sandboxP, mediaP, subagentsP, skillsP, ownerTagsP,
    ]);
    if (!built.ok) {
        await runBoundToolCleanup(builtCleanups, { agentKey, mode: source === 'agent' ? 'chat' : 'playground' });
        throw built.reason;
    }
    const [
        { model }, resolvedPrompt, guardrailPlugins, [{ createSmartAgent, createTool }, { z }], knowledgeTools, bound, sessionFacts, fileBucket,
        sandboxTools, media, subagentBuild, skills, ownerTags,
    ] = built.values;
    const { toolMedia, readTool, readSession, sdkModel } = media;
    // Prices the main model and every sub-agent's model; needs only those, so it runs while the tools are put together.
    const costEstimatorP = started(buildAgentCostEstimator(config, model, subagentBuild.models, sessionBudgetActive, costWarnings.add, tenantId));

    let systemPrompt = resolvedPrompt;
    const tools: AgentSdkToolInterface[] = [];
    const toolDefinitions: TraceToolDefinition[] = [];
    if (knowledgeTools) {
        tools.push(...knowledgeTools.tools);
        toolDefinitions.push(...knowledgeTools.toolDefinitions);
        systemPrompt = systemPrompt
            ? `${KNOWLEDGE_FIRST_INSTRUCTION}\n\n${systemPrompt}`
            : KNOWLEDGE_FIRST_INSTRUCTION;
    }

    const { cleanupTasks, tools: boundTools, definitions: boundToolDefinitions } = bound;
    tools.push(...boundTools);
    toolDefinitions.push(...boundToolDefinitions);

    // Memory as tools the model can actually call. The SDK gives it
    // neither: recall is pre-injected as a system message and writes only
    // happen at compaction, so an agent can neither look a fact up nor record
    // what it was just told. Built from the SAME store the SDK path reads, so
    // a tool write is visible to next turn's injection.
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
    if (input.conversation && sessionFacts.any) {
        tools.push(...buildSessionFileTools({
            createToolFn: createTool,
            zod: z,
            guard: toolGuard,
            scope: sessionFilesScope,
            conversationId: String(input.conversation._id),
        }));
        toolDefinitions.push(...sessionFileToolDefinitions());
    }

    // Files the agent writes itself (`session_files_create` / `_append`, no sandbox needed): offered to a run with a
    // session to attach them to and a files bucket that works. Built before the client tools so their name
    // reservation (`taken`, below) covers these too.
    let fileOutputs: FileOutputTools | undefined;
    if (input.conversation && outputsOn.available) {
        if (fileBucket?.usable) {
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

    // Sandbox warnings join the run's here, where the serial build used to emit them.
    sandboxWarnings.release();
    // Files the agent writes to /outputs/ are delivered after the turn; that needs a session to attach them to and a bucket.
    if (sandboxTools.tools.length > 0 && input.conversation && resolveAttachmentsConfig(config.attachments).bucketKey) {
        systemPrompt = withSandboxOutputsPrompt(systemPrompt);
    }
    tools.push(...sandboxTools.tools);
    toolDefinitions.push(...sandboxTools.definitions);
    cleanupTasks.push(sandboxTools.cleanup);
    // `read`: one tool for the sandbox's files and the conversation's (images, PDFs, video included).
    if (readTool) {
        tools.push(readTool);
        toolDefinitions.push(readToolDefinition({
            ...(sandboxTools.reader ? { sandbox: sandboxTools.reader } : {}),
            ...(readSession ? { session: readSession } : {}),
            media: { store: toolMedia.store },
        }));
    }
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

    // Sub-agent warnings, then the sub-agents' own cleanup, in the order the serial build produced them.
    subagentWarnings.release();
    const { subagents, cleanupTasks: subagentCleanupTasks } = subagentBuild;
    cleanupTasks.push(...subagentCleanupTasks);

    const outputSchema = resolveTurnOutputSchema(config, input.responseFormat);
    const skillPolicy = resolveAgentSkillPolicy(config);
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
    costWarnings.release();
    const costEstimator = await costEstimatorP;
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
export function firstTurnTitle(
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
export function sessionStopReason(
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

export function toAgentChatResponse(input: {
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

export async function executeAgentChatLocal(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    // The last stop for a turn that arrives without the entry above (a queue worker, a background run).
    await assertAgentsEnabled(request);
    const scope: { events?: SessionTurnEvents } = {};
    // One tenant scope for the whole turn, the failure path included.
    return runWithTenantScope(request.tenantDbName, async (db) => {
        try {
            return await runWithRoutingCaller(routingCallerOf(request), () => runWithKnowledgeExposure(new KnowledgeExposure(), () => runAgentChatTurn(request, scope, db)));
        } catch (error) {
            await scope.events?.fail(error).catch(() => undefined);
            throw error;
        }
    });
}

async function runAgentChatTurn(
    request: AgentChatRequest,
    scope: { events?: SessionTurnEvents },
    db: DatabaseProvider,
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
