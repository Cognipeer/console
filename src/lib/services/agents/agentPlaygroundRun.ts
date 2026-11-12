/**
 * Agent playground run: the dashboard-only chat turn and the persistence of a Session turn.
 */

import { channelFromSource, noteRoutingRun, runWithRoutingCaller, type RoutingCallerContext } from '@/lib/services/models/routingCallerContext';
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { agentEntityId } from './agentEntityId';
import type { AgentInvokeResult as AgentSdkInvokeResult, Message as AgentSdkMessage, SmartAgentEvent as AgentSdkEvent } from '@cognipeer/agent-sdk';
import { applyServiceAvailability, assertAgentsEnabled } from './agentServiceAvailability';
import { getDatabase, type IAgentConversation, type IAgentMessageAttachment } from '@/lib/database';
import { KnowledgeExposure, runWithKnowledgeExposure } from '@/lib/services/rag/access';
import { consoleIdentityPersonOf } from '@/lib/iam/consoleIdentity';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import { normalizePlaygroundUsage } from './playgroundUsage';
import { annotateAgentRunError } from './agentErrors';
import { buildUserTurnContent } from './sessionFiles';
import { assertAgentTurnSpendAllowed, resolveAgentSpendScope } from './agentSpendLimits';
import { isSessionBudgetBreach, planSessionBudget, sessionBudgetInvokeOptions, startSessionSpendAccount, settleSessionBudget } from './sessionBudget';
import { addSessionTurnSpend, recordSessionTurnSpend } from './sessionBudgetService';
import { enforceAgentRunQuota, settleAgentRun } from './agentQuota';
import { createRunUsageSink, runWithUsageSink } from './runUsage';
import {
    buildTurnInputState,
    compactedToolResults,
    endedByCallerAbort,
    loadConversationState,
    saveConversationState,
    type AgentTurnOutcome,
} from './agentTurnState';
import { toSessionStopReason } from './sessionEvents';
import { startSessionTurnEvents, type SessionTurnEvents } from './sessionTurnEvents';
import { createTurnFlowTracker, subagentTargets } from './turnFlowTracker';
import { activeSubagentEntries } from './subagentRoster';
import { resolveHitlConfig } from './agentHumanInTheLoop';
import { additionalModelKeys, applyAgentModelChoice, type AgentModelChoice } from './agentModelSelection';
import { agentShowsReasoning, applyModelToConfig } from './agentReasoning';
import {
    PAUSE_UNAVAILABLE_WARNING,
    pauseUnavailableOutcome,
    actionRequiredEventData,
    assertNoBlockingPending,
    cancelPendingForNewMessage,
    openPause,
    toMessagePendingAction,
    type OpenedPause,
} from './agentPendingActions';
import {
    CALLER_ABORT_DETAIL,
    agentRelayOptions,
    agentRunCallerOf,
    captureStreamedText,
    type AgentPlaygroundChatRequest,
    type AgentPlaygroundChatResult,
} from './agentChatTypes';
import { budgetAwareOutcome, priceAgentTurn } from './agentCost';
import { bindKnowledgeExposure } from './agentKnowledgeTools';
import { evaluateBoundGuardrails, guardrailBlockedError } from './agentGuardrails';
import { assertOwnedAgentReachable } from './agentSubagents';
import { runBoundToolCleanup } from './agentBoundTools';
import { endRunsOfDroppedPause, MAX_PREVIOUS_VERSIONS, describeRunOutcome } from './agentRecords';
import { answeredWithMetadata, createReasoningTap, liveStreamOptions, createTurnFlowSink, turnFlowRecord, turnReasoning } from './agentStreamTaps';
import { resolveMessageAttachments, assembleMessageAttachments, earlierAttachments, outputFileEvents, mergeSessionRuntimeContext } from './agentAttachments';
import { runExternalAgentTurn, runFlowAgentTurn, flowActivityFields, buildLocalAgentRun, agentMayStreamAnswer, firstTurnTitle, sessionStopReason } from './agentChatRun';
import { extractPlaygroundSteps, describeStructuredOutputError } from './agentPlaygroundSteps';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

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
