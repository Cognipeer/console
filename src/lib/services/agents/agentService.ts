/**
 * Agent Service
 *
 * Business logic for agent CRUD and chat orchestration.
 * Uses agent-sdk for runtime execution with automatic tracing.
 */

import { channelFromSource, runWithRoutingCaller, type RoutingCallerContext } from '@/lib/services/models/routingCallerContext';
import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/core/logger';
import { routeInstanceCall, type RelayCallerOptions, type WorkerRelay } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { agentEntityId } from './agentEntityId';
import type {
    AgentInvokeResult as AgentSdkInvokeResult,
    Message as AgentSdkMessage,
    SmartAgentEvent as AgentSdkEvent,
    SubagentDef as AgentSdkSubagentDef,
    ToolInterface as AgentSdkToolInterface,
    TraceSessionFile,
} from '@cognipeer/agent-sdk';
import {
    jsonSchemaToZod,
    toolInputSchemaToZod,
    resolveAgentRuntimeOptions,
    resolveAgentSkillPolicy,
    resolveTurnOutputSchema,
} from './agentRuntimeConfig';
import { buildAgentSkills } from './agentSkillService';
import { buildAgentMemoryOption, buildMountedMemoryStores } from './agentMemoryAdapter';
import { buildMemoryPromptSection } from './agentMemoryMounts';
import type { IAgentConversationMessage, IAgentConversationStep, IAgentMessageVersion, IAgentSubagent } from '@/lib/database/provider/types.domain';
import {
    buildPromptVariables,
    renderPromptTemplate,
    shouldRenderInlinePrompt,
    type RenderedPrompt,
    type ResolvedPromptVariables,
} from './promptVariables';
import type { IAgentKnowledgeBinding } from '@/lib/database/provider/types.domain';
import {
    hasKnowledgeConfigured,
    knowledgeKeySlug,
    formatKnowledgeHit,
    mergeKnowledgeHits,
    normalizeKnowledgeBindings,
    type KnowledgeBindingSource,
    type KnowledgeHit,
} from './agentKnowledgeBindings';
import { applyServiceAvailability, assertAgentsEnabled, filterChildSources } from './agentServiceAvailability';
import { getDisabledServices } from '@/lib/services/availability/serviceAvailability';
import { getDatabase, runWithTenantScope, type AgentResponseFormat, type IAgent, type IAgentConfig, type IAgentConversation, type IAgentMessageAttachment, type IAgentPendingAction, type IAgentPendingActionResolution, type IFileRecord, type IAgentSessionBudget, type IAgentTracingEvent, type IAgentTracingSession, type IAgentTurnCompaction, type IAgentVersion, type IModelPricing } from '@/lib/database';
import { getModelByKey } from '@/lib/services/models/modelService';
import {
    getRagDocument,
    getRagDocumentFullText,
    getRagDocumentTextLines,
    getRagModule,
    queryRag,
} from '@/lib/services/rag/ragService';
import {
    GUARDRAIL_CONTRACT_VERSION,
    GuardrailEnforcementError,
    evaluateGuardrail,
    runHook,
    toolCallSubject,
    toolResultSubject,
} from '@/lib/services/guardrail';
import type { HookId, HookScope, HookVerdict } from '@/lib/services/guardrail';
// Imported BY PATH because the barrel does not re-export it. `resolveBindings`
// is the ONE implementation of "which guardrails run on this hook"; a
// hand-rolled legacy fallback here would drift from the gateway's and produce a
// guardrail that silently stops running on one surface while the UI still shows
// it attached.
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
// `resolveGuardrail` is deliberately not on the barrel either; it is read here
// only to learn a guardrail's `failMode` when its plugin could not be compiled.
import { resolveGuardrail } from '@/lib/services/guardrail/hooks/engine';
import {
    CONSOLE_HOOK_MAP,
    SdkPluginLayerUnavailableError,
    consoleGuardrailPlugins,
    denyingSdkPlugin,
    toAgentPlugin,
} from '@/lib/services/guardrail/sdkAdapter';
import type { PluginMessageRewrite } from '@/lib/services/guardrail/sdkAdapter';
import type { AgentPlugin as AgentSdkPlugin, BaseChatModel } from '@cognipeer/agent-sdk';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { getMcpServerByKey, executeMcpTool, isMcpToolEnabled } from '@/lib/services/mcp';
import { consoleIdentityCallerOf, consoleIdentityOfPausedTurn, consoleIdentityPersonOf, type ConsoleIdentityCaller, type ConsoleIdentityPerson } from '@/lib/iam/consoleIdentity';
// By path: the barrel does not export it, and it is the ONE reader of a
// server's `guardrail` / legacy `aegis` columns (`mcpService.ts`).
import { resolveMcpGuardrailBinding } from '@/lib/services/mcp/mcpService';
import { currentTurnSignal, runWithTurnSignal } from '@/lib/core/turnSignal';
import { executeToolAction, logToolRequest, toolRequestSecretValues } from '@/lib/services/tools';
import {
    resolveAgentBindingMcpServer,
    resolveAgentBindingTool,
    resolveAgentKnowledgeModule,
} from './bindingResolution';
import { resolveBrowser, createBrowserSession, buildBrowserAgentTools, closeBrowserSession } from '@/lib/services/browser';
import { buildWebSearchAgentTools } from '@/lib/services/webSearch';
import { buildWebFetchAgentTools } from '@/lib/services/crawler';
import { recordTracingSessionCreated } from '@/lib/services/agentTracing';
import {
    isTerminalSessionStatus,
    recordAgentSessionOutcome,
    recordTraceEventMetrics,
} from '@/lib/services/tracing/traceEntityMetrics';
import { countTraceErrors, deriveSessionStatus, isExplicitClientStatus } from '@/lib/shared/traceHealth';
import {
    buildToolDefinitionsSection,
    TOOL_DEFINITIONS_SECTION_KIND,
    type TraceToolDefinition,
} from '@/lib/services/tracingToolDefinitions';
import { normalizeSectionListResponseFormat } from '@/lib/services/tracingResponseFormat';
import {
    describeRuntimeAuth,
    resolveRuntimeHeaders,
    runtimeHeaderPolicyFromMetadata,
    type AgentRuntimeContext,
} from '@/lib/services/runtimeContext';
import { invokeExternalAgent } from './externalAgent';
import { addPlaygroundUsage, normalizePlaygroundUsage, pausedLegsUsage } from './playgroundUsage';
import { buildGatewayChatModel, isDynamicModel, type NativeAgentReasoning } from './gatewayChatModel';
import { createImageAwareTokenCounter } from './imageTokenCounter';
import { withSessionImages, type SessionImagesOptions } from './sessionImages';
import {
    createCompositeImageSource,
    createToolMediaStore,
    withToolMedia,
    type ToolMediaContext,
} from './toolMedia';
import { buildReadTool, readToolDefinition, READ_TOOL } from './readTool';
import { isToolOutput } from '@/lib/services/tools/toolOutput';
import { buildMemoryTools, memoryToolDefinitions } from './agentMemoryTools';
import { AgentAttachmentError, annotateAgentRunError, classifyAgentRunError } from './agentErrors';
import { outputFileEventData, toClientOutputFiles, toClientPendingAction, toFileAnnotations, type ClientFileAnnotation, type ClientOutputFile, type ClientPendingAction } from './clientWire';
import {
    agentTakesAttachments,
    assembleTurnAttachments,
    attachmentsAvailability,
    attachmentsUnavailableMessage,
    buildSessionFileTools,
    buildUserTurnContent,
    conversationFileFacts,
    createSessionImageSource,
    deleteConversationFiles,
    findUnsentSessionFiles,
    resolveAttachmentsConfig,
    resolveTurnAttachments,
    sessionFileToolDefinitions,
    stripAttachmentBlock,
    NO_ATTACHMENTS,
    type AssembledAttachments,
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
    agentSessionBudget,
    budgetStopDetail,
    endsInAnswer,
    isSessionBudgetBreach,
    planSessionBudget,
    sessionBudgetInvokeOptions,
    startSessionSpendAccount,
    withSessionSpend,
    settleSessionBudget,
    type SessionBudgetPlan,
    type SessionBudgetSettlement,
} from './sessionBudget';
import { addSessionTurnSpend, recordSessionTurnSpend } from './sessionBudgetService';
import { enforceAgentRunQuota, settleAgentRun, type AgentRunCaller } from './agentQuota';
import { createRunUsageSink, runWithUsageSink } from './runUsage';
import { buildAgentSandboxTools, destroyConversationSandbox } from './agentSandboxTools';
import { withSandboxOutputsPrompt } from './agentSandboxOutputs';
import { buildFileOutputTools, fileOutputsPrompt, mergeOutputCollectors, type FileOutputTools } from './agentFileOutputTools';
import { buildReminderTools, reminderApprovalMode, reminderNoteText, remindersPrompt, type ReminderTools, type ReminderWake } from './agentReminderTools';
import { resolveRemindersConfig } from './agentRemindersConfig';
import { getConfig } from '@/lib/core/config';
import { inspectFileBucket } from './sessionFilesBucket';
import { outputsAvailability } from './sessionFilesConfig';
import { sealAgentConfigSecrets } from './agentSandboxSecrets';
import { stripLegacyExecutionConfig } from './agentCallbackConfig';
import {
    buildCostEstimator,
    buildTurnInputState,
    compactedToolResults,
    compactionFromEvent,
    describeTurnOutcome,
    endedByCallerAbort,
    buildContinueInputState,
    loadConversationState,
    saveConversationState,
    type AgentStopReason,
    type AgentTurnOutcome,
} from './agentTurnState';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';
import { toSessionStopReason, type SessionStopReason } from './sessionEvents';
import { startSessionTurnEvents, type SessionTurnEvents } from './sessionTurnEvents';
import { delegatedSubagentName, delegationFailure, isDelegationTool, isSubagentEvent, nameSubagentOnApprovalStep, resumedDelegationIds, subagentStampOf } from './subagentEvents';
import { resolveAgentConfig } from './agentConfigResolution';
import { activeSubagentEntries, resolveSubagentTarget } from './subagentRoster';
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
    denyUnattendedTools,
    gateChildTools,
    resolveHitlConfig,
    resolveHitlRunMode,
    sessionAllowedTools,
    type ChildApprovalSide,
    type HitlRunMode,
    type ResolvedHitlConfig,
} from './agentHumanInTheLoop';
import { additionalModelKeys, applyAgentModelChoice, type AgentModelChoice } from './agentModelSelection';
import {
    agentReasoningForModel,
    agentShowsReasoning,
    applyModelToConfig,
    migrateAgentReasoning,
} from './agentReasoning';
import type { NormalizedReasoning } from '@/lib/services/models/reasoning';
import { normalizeStaleRunningStatus, normalizeStaleRunningStatuses } from './sessionRuntime';
import { mergeContinuedSessionDoc, readTraceContinuationMarker } from '@/lib/services/tracingContinuation';
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
import { composeUserMessageWithVariables, delegatedVariableValues } from './agentVariables';

const logger = createLogger('agents');

/**
 * A new message dropped the session's pause (`cancel_pending`): the run that
 * waited on it ends `canceled`, with its notifications, instead of staying
 * `requires_action` for good. Never fails the turn.
 */
async function endRunsOfDroppedPause(
    db: Awaited<ReturnType<typeof getDatabase>>,
    scope: { tenantId: string; projectId: string; conversationId: string },
): Promise<void> {
    try {
        // Loaded here: agentRunService imports this module.
        const { cancelPausedAgentRuns } = await import('./agentRunService');
        await cancelPausedAgentRuns(db, scope);
    } catch (error) {
        logger.warn('Could not end the paused run of a dropped pause', {
            conversationId: scope.conversationId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** How many replaced answers a regenerated message remembers. */
const MAX_PREVIOUS_VERSIONS = 5;

const CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION =
    'PRIMARY retrieval tool. For factual, product, policy, API, docs, or troubleshooting questions, call this tool BEFORE drafting the final answer. Use the user question (or a focused rewrite) as query. If results are empty/insufficient, then answer briefly with uncertainty. Each match carries a documentId — pass it to knowledge_read_document or knowledge_read_document_lines when the question needs more of that file than the matched passage.';

const CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION =
    'Returns the whole extracted text of one knowledge-base document, given the documentId from a knowledge_search result. Use this when the question is about the document as a whole (e.g. "summarize this file") and the file is not huge. The response is truncated past a size limit — when it is, switch to knowledge_read_document_lines to read the rest.';

const CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION =
    'Returns one line range of a knowledge-base document, given the documentId from a knowledge_search result. Use this for long documents, to page through a file, or to jump to a specific part of it. Call again with a later offset to continue reading.';

/** Prepended to the system prompt of an agent with a knowledge engine bound. */
const KNOWLEDGE_FIRST_INSTRUCTION = [
    'Knowledge-base-first policy:',
    '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
    '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
    '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
].join('\n');

/**
 * Description of the optional `filter` argument, listing the metadata keys the
 * Knowledge Engine module exposes. Omitted entirely when the module declares
 * none, so the model is never invited to guess at metadata names.
 */
function knowledgeSearchFilterDescription(filterableFields: string[]): string {
    return (
        'Optional metadata filter narrowing the search. Filterable fields: '
        + `${filterableFields.join(', ')}. `
        + 'Use { "field": value } for equality, or operators $eq, $ne, $gt, $gte, $lt, $lte, '
        + '$in, $nin, $exists combined with $and / $or / $not.'
    );
}

/** Trace menu entry mirroring the zod schema `knowledge_search` is bound with. */
function knowledgeSearchToolDefinition(filterableFields: string[]): TraceToolDefinition {
    const properties: Record<string, unknown> = {
        query: { type: 'string', description: 'The search query' },
    };
    if (filterableFields.length > 0) {
        properties.filter = {
            type: 'object',
            description: knowledgeSearchFilterDescription(filterableFields),
        };
    }
    return {
        name: 'knowledge_search',
        description: CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION,
        parameters: {
            type: 'object',
            properties,
            required: ['query'],
        },
    };
}

/** Trace menu entry mirroring the zod schema `knowledge_read_document` is bound with. */
function knowledgeReadToolDefinition(): TraceToolDefinition {
    return {
        name: 'knowledge_read_document',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'documentId from a knowledge_search result' },
            },
            required: ['documentId'],
        },
    };
}

/** Trace menu entry mirroring the zod schema `knowledge_read_document_lines` is bound with. */
function knowledgeReadLinesToolDefinition(): TraceToolDefinition {
    return {
        name: 'knowledge_read_document_lines',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                documentId: { type: 'string', description: 'documentId from a knowledge_search result' },
                offset: { type: 'number', description: '1-indexed line to start from (default 1)' },
                limit: { type: 'number', description: 'Number of lines to return (default 200, max 1000)' },
            },
            required: ['documentId'],
        },
    };
}

// ── Guardrail binding ────────────────────────────────────────────────
//
// Two things live here: the TEXT hooks (`input.pre` / `output.pre`) an agent
// has always had, now resolved through `resolveBindings` so several guardrails
// compose; and the TOOL hooks (`tool.pre` / `tool.post`), which the agent's own
// tools never had at all — its MCP tools were guarded downstream in
// `executeMcpToolLocal` while its action, knowledge and browser tools ran
// unevaluated, so `tool_access` was bypassable by moving a capability out of
// MCP and into the unified tool system.

/**
 * CANONICAL, POLICY-VISIBLE TOOL NAMES.
 *
 * `tool_access` matches `allow` / `deny` / `sideEffects` / `allowedRoles` /
 * `argumentSchemas` on this string (exact key first, then `*` globs), so it has
 * to be STABLE across renames and unique across sources. The convention is the
 * sandbox toolbox's, transposed: a fixed surface root, then the SOURCE, then
 * the identity of the thing being called — every segment a stored KEY rather
 * than a display name, which is the agent's equivalent of "route pattern with
 * params stripped".
 *
 *   agent.knowledge.search                 the three Knowledge Engine tools,
 *   agent.knowledge.read_document          named for what they do rather than
 *   agent.knowledge.read_document_lines    for the module they happen to read
 *   agent.tool.<toolKey>.<actionKey>       unified tool-system actions
 *   agent.browser.<toolName>               the browser_use system tools
 *   agent.websearch.<toolName>             the web_search system tool
 *   agent.crawler.<toolName>               the web_fetch system tool
 *
 * The browser/websearch segment is the tool's own name VERBATIM (`agent.browser.
 * browser_navigate`, `agent.websearch.web_search`), redundant prefix and all.
 * Stripping it would read better and buy nothing: the prefix is part of the
 * name the model calls, so keeping it means a policy author can copy what
 * they see in a trace.
 *
 * Names, not keys, are what the MODEL sees, and an operator editing an action's
 * `name` must not silently disarm the policy written against it — hence
 * `action.key`/`toolRecord.key` here and `action.name` in `requestedName`.
 * `tool_access` matches a DENY against either spelling and an ALLOW against the
 * canonical one only, so both directions of that pair fail safe.
 *
 * MCP tools are deliberately absent: they are named `<serverKey>/<toolName>` by
 * `mcpHook`, one layer down, and must not be renamed or re-evaluated here.
 */
function agentToolPolicyName(...segments: readonly string[]): string {
    return ['agent', ...segments].join('.');
}

/** What one guarded tool call needs to identify itself to policy. */
interface AgentToolSpec {
    /** Canonical policy name — see `agentToolPolicyName`. */
    name: string;
    /** The name the model actually called, before any canonicalisation. */
    requestedName: string;
}

/**
 * Wraps a tool's executor with `tool.pre` / `tool.post`.
 *
 * `protect` returns a drop-in replacement for the executor. On a block it
 * resolves to a STRING — the policy message, delivered to the model as the tool
 * RESULT — instead of rejecting; see `blockedToolResult` for why that is not the
 * same as throwing.
 *
 * Whatever the SDK passes after the arguments reaches the executor unchanged:
 * from agent-sdk 0.15 that is the call's context (`toolCallId`, the
 * cancellation token and the abort signal), which a long-running tool reads to
 * stop when the run is cancelled.
 */
interface AgentToolGuard {
    protect<A extends Record<string, unknown>, R>(
        spec: AgentToolSpec,
        execute: (safeArgs: A, ...rest: unknown[]) => Promise<R>,
    ): (args: A, ...rest: unknown[]) => Promise<R | string>;
}

/**
 * The no-op guard, returned when NOTHING is bound to either tool hook.
 *
 * This is not merely an optimisation, it is the compatibility guarantee.
 * `executeEnforcedTool` — the sandbox toolbox's boundary — materialises the
 * tenant's DEFAULT tool guardrail when its key list is empty, which is right
 * there (its caller names no policy at all) and wrong here: a legacy agent
 * config has no `guardrails` array, `resolveBindings` deliberately binds
 * nothing legacy to the tool hooks, and arming those calls against a policy
 * nobody wrote would start blocking tool calls that worked yesterday.
 */
const UNGUARDED_AGENT_TOOLS: AgentToolGuard = {
    protect: (_spec, execute) => execute,
};

/**
 * The message a blocked tool call returns TO THE MODEL, in place of a result.
 *
 * WHY NOT THROW. The SDK does catch a tool throw (it pushes
 * `Error executing tool: <message>` as the tool message), so throwing would not
 * take the agent down — but it would be wrong in three ways: the model reads
 * "Error executing tool" as transient and retries; `markToolFailure` counts the
 * block against the tool's retry budget and circuit breaker, so a policy
 * decision eventually disables a working tool; and the trace records status
 * 'error', mixing policy decisions into the tool-failure metrics. A guardrail
 * is a decision, not a fault.
 *
 * The pre/post distinction is load-bearing for the model: at `tool.pre` nothing
 * ran and rephrasing may be legitimate, at `tool.post` the side effect ALREADY
 * happened and repeating the call would repeat it.
 *
 * `verdict.message.body` is the operator-authored, deliberately vague rendered
 * message; its template variables are a closed set that excludes the matched
 * value, so it is safe to hand to the model. Raw finding messages are the
 * fallback only because a block with no explanation at all is worse — the same
 * trade `sdkAdapter.verdictToRuleResult` makes.
 */
function blockedToolResult(spec: AgentToolSpec, verdict: HookVerdict): string {
    // Blocking findings first: a warn-level message from another check would
    // explain the wrong thing.
    const blocking = verdict.findings.filter((finding) => finding.block).map((finding) => finding.message);
    const anyFinding = blocking.length > 0 ? blocking : verdict.findings.map((finding) => finding.message);
    const detail = verdict.message?.body
        || [...new Set(anyFinding.filter(Boolean))].join('; ')
        || verdict.codes.join(', ')
        || 'No further detail is available.';

    return verdict.hook === 'tool.post'
        ? `The result of \`${spec.requestedName}\` was withheld by a guardrail policy. `
            + `The call DID run, so do not repeat it; tell the user the result cannot be shown. ${detail}`
        : `\`${spec.requestedName}\` was blocked by a guardrail policy and did not run. `
            + `Do not retry the same call. ${detail}`;
}

/**
 * Build the tool guard for ONE agent run.
 *
 * `runHook` is called directly rather than through `executeEnforcedTool`, and
 * the reason is the binding layer itself:
 *
 *  · `executeEnforcedTool` takes ONE `guardrailKeys` list for BOTH hooks, but
 *    `resolveBindings` is per-hook by signature — a binding written as
 *    `{ key, hooks: ['tool.post'] }` would otherwise also be evaluated (logged,
 *    and for the model-backed families billed) at `tool.pre`, which is exactly
 *    the double-run the array shape exists to prevent.
 *  · its empty-list fallback to the tenant default tool guardrail is wrong for
 *    a legacy agent — see `UNGUARDED_AGENT_TOOLS`.
 *
 * Everything else is shared rather than re-implemented: the subject builders,
 * `GuardrailEnforcementError` and the contract version all come from the hook
 * plane, so only the three-step ladder is local.
 *
 * EXPORTED FOR TESTS. Both agent entry points build it internally; nothing
 * outside this module should construct one, but `agent-tool-guardrail.test.ts`
 * pins the ladder directly rather than through a whole mocked SDK invoke.
 */
export function createAgentToolGuard(input: {
    tenantDbName: string;
    tenantId: string;
    projectId?: string;
    agentKey: string;
    config: GuardrailBindingSource;
    /**
     * The authenticated principal when the surface has one, otherwise the agent
     * itself. Audit only: `tool_access.allowedRoles` matches on `roles`, which
     * is `['agent']` on BOTH paths — so a policy verified in the playground
     * behaves identically in production.
     */
    actorId: string;
    /** Persisted as `source` on the evaluation log — 'agent' | 'agent-playground'. */
    source: string;
}): AgentToolGuard {
    const preKeys = resolveBindings(input.config, 'tool.pre');
    const postKeys = resolveBindings(input.config, 'tool.post');
    if (preKeys.length === 0 && postKeys.length === 0) return UNGUARDED_AGENT_TOOLS;

    const providerRef = `agent:${input.agentKey}`;

    // One scope per TOOL CALL, not per run: `traceId` correlates the `tool.pre`
    // and `tool.post` rows of a single call, so sharing one across a whole
    // multi-tool run would make the evaluation log unreadable.
    const scopeForCall = (): HookScope => ({
        tenantId: input.tenantId,
        tenantDbName: input.tenantDbName,
        projectId: input.projectId,
        actor: { id: input.actorId, kind: 'agent', roles: ['agent'] },
        surface: 'agent',
        source: input.source,
        traceId: randomUUID(),
    });

    return {
        // Declared generic here rather than inferred from `AgentToolGuard`: a
        // contextually-typed method body cannot NAME the interface's type
        // parameters, and both `A` and `R` are needed below to restore the
        // types the subject builders erase.
        protect<A extends Record<string, unknown>, R>(
            spec: AgentToolSpec,
            execute: (safeArgs: A, ...rest: unknown[]) => Promise<R>,
        ): (args: A, ...rest: unknown[]) => Promise<R | string> {
            return async (args: A, ...rest: unknown[]) => {
                const scope = scopeForCall();
                try {
                    let safeArgs = args;

                    if (preKeys.length > 0) {
                        const pre = await runHook({
                            contractVersion: GUARDRAIL_CONTRACT_VERSION,
                            hook: 'tool.pre',
                            subject: toolCallSubject({
                                toolName: spec.name,
                                requestedName: spec.requestedName,
                                args,
                                providerRef,
                            }),
                            scope,
                            guardrailKeys: preKeys,
                        });
                        // `decision` is ALREADY the effective decision — the
                        // engine neutralises it to 'allow' outside enforce mode
                        // — so there is deliberately no `enforced` guard here.
                        if (pre.decision === 'block') throw new GuardrailEnforcementError('blocked', pre);
                        if (pre.subject?.kind === 'tool_call') {
                            // `applyMutations` clones containers and rewrites
                            // STRING LEAVES only, so the redacted arguments have
                            // the same shape — and therefore still satisfy the
                            // schema the tool declared. `enforce.ts` makes the
                            // identical restoration on the result path for the
                            // same reason; the alternative is widening every
                            // tool's own argument type and re-narrowing by hand.
                            safeArgs = pre.subject.args as A;
                        }
                    }

                    const result = await execute(safeArgs, ...rest);
                    if (postKeys.length === 0) return result;

                    const post = await runHook({
                        contractVersion: GUARDRAIL_CONTRACT_VERSION,
                        hook: 'tool.post',
                        subject: toolResultSubject({
                            toolName: spec.name,
                            args: safeArgs,
                            result,
                            providerRef,
                        }),
                        scope,
                        guardrailKeys: postKeys,
                    });
                    if (post.decision === 'block') throw new GuardrailEnforcementError('blocked', post);
                    return post.subject?.kind === 'tool_result' ? (post.subject.result as R) : result;
                } catch (error) {
                    // ONLY an enforcement decision becomes a tool result. Anything
                    // else — an executor failure, or the engine defect that
                    // `runHook`'s "never throws" contract says cannot happen —
                    // propagates, and the SDK turns it into a tool error message.
                    // Swallowing those would be indistinguishable from running
                    // the tool unguarded.
                    if (error instanceof GuardrailEnforcementError) {
                        logger.info('Agent tool call blocked by guardrail', {
                            agentKey: input.agentKey,
                            tool: spec.name,
                            hook: error.verdict.hook,
                            guardrailKey: error.verdict.guardrailKey,
                            traceId: error.verdict.traceId,
                        });
                        return blockedToolResult(spec, error.verdict);
                    }
                    throw error;
                }
            };
        },
    };
}

/**
 * Guard a tool this module did NOT build.
 *
 * The browser tools arrive from `buildBrowserAgentTools` as finished
 * `ToolInterface` records, so there is no `func` to wrap on the way in and the
 * executor has to be replaced after the fact.
 *
 * ALL FOUR ALIASES ARE REPLACED, and that is not belt-and-braces: `createTool`
 * assigns the same closure to `invoke`, `call`, `run` AND `func`
 * (agent-sdk/dist/index.mjs:370-379), and the SDK's executor resolution walks
 * them in order (`:114-117`, `:183-187`). Replacing only `invoke` would leave
 * three unguarded aliases, and the first SDK release that reorders that walk
 * would silently disarm the guard.
 *
 * Returns the tool UNCHANGED when it exposes no callable at all — a tool nobody
 * can execute needs no policy, and fabricating one would only hide the defect.
 */
function protectBuiltTool(
    guard: AgentToolGuard,
    spec: AgentToolSpec,
    tool: AgentSdkToolInterface,
): AgentSdkToolInterface {
    // Read through `unknown` rather than the record's index signature, which
    // would otherwise hand these back as `any`.
    const aliases: unknown[] = [tool.invoke, tool.call, tool.func, tool.run];
    const original = aliases.find(
        (alias): alias is (input: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown> =>
            typeof alias === 'function',
    );
    if (!original) {
        logger.warn('Tool exposes no callable; left unguarded', { tool: tool.name });
        return tool;
    }

    // The SDK's second argument (the call's context) goes on to the tool: a
    // guarded tool that stops on the run's abort signal must still see it.
    const guarded = guard.protect<Record<string, unknown>, unknown>(
        spec,
        async (safeArgs, ...rest) => original(safeArgs, ...rest),
    );
    // Spread, not mutate: the record belongs to its builder, and the agent may
    // hold the original elsewhere (the trace definitions read `tool.name` off
    // the array it was pushed into).
    return { ...tool, invoke: guarded, call: guarded, run: guarded, func: guarded };
}

/**
 * Evaluate every guardrail bound to a TEXT hook, in binding order, and return
 * the text to carry forward.
 *
 * Used by `runExternalAgentTurn`; a local agent runs these hooks as SDK plugins.
 *
 * Redactions CHAIN: guardrail N+1 sees what guardrail N rewrote, so a redaction
 * cannot be undone by a later evaluation and the text that reaches the model
 * (or the user) is the one every bound guardrail agreed on.
 *
 * Throws on a block. The message strings are unchanged from the single-slot
 * implementation because operator runbooks grep for them.
 */
async function evaluateBoundGuardrails(input: {
    tenantDbName: string;
    tenantId: string;
    projectId?: string;
    config: GuardrailBindingSource;
    hook: Extract<HookId, 'input.pre' | 'output.pre'>;
    text: string;
    source: string;
}): Promise<string> {
    const keys = resolveBindings(input.config, input.hook);
    if (keys.length === 0 || !input.text) return input.text;

    const phase = input.hook === 'input.pre' ? 'input' : 'output';
    const label = phase === 'input' ? 'Input' : 'Output';
    let text = input.text;

    for (const guardrailKey of keys) {
        const result = await evaluateGuardrail({
            tenantDbName: input.tenantDbName,
            tenantId: input.tenantId,
            projectId: input.projectId,
            guardrailKey,
            text,
            phase,
            source: input.source,
        });
        // `blocked` is the Mode-neutralised decision; `passed` is the
        // counterfactual and stays false in monitor mode. See the note on
        // `GuardrailEvaluationResult.blocked`.
        if (result.blocked) {
            const reasons = result.findings.map((finding) => finding.category || finding.type).join(', ');
            // Same message as before (runbooks grep for it), now TYPED so the
            // HTTP layer answers 4xx with the gateway's `guardrail_block`
            // envelope instead of reporting a policy decision as a server fault.
            throw new AgentGuardrailBlockedError(
                `${label} blocked by guardrail: ${reasons}`,
                { guardrailKey: result.guardrailKey || guardrailKey, reason: reasons, hook: input.hook },
            );
        }
        if (result.redactedText !== undefined) text = result.redactedText;
    }

    return text;
}

/**
 * A guardrail refused the turn.
 *
 * Typed — rather than a bare `Error` — because a policy decision is not a
 * server fault: `plugins/agents.ts` and `plugins/client-agents.ts` map this to
 * HTTP 400 with the same `{ error: { type: 'guardrail_block', … } }` envelope
 * the inference routes send for `GuardrailBlockError`, so an SDK client can
 * branch on `type` regardless of whether it called a model or an agent. Before
 * this it surfaced as a 500 whose body, on the client API, was
 * `Internal server error` — no reason, no key, no way to tell it from an outage.
 *
 * `hook` is the console hook id when it is known (`prompt.pre` for a
 * `userPromptSubmit` denial, `input.pre`/`output.pre` for the model-call gates,
 * the text hook for a connected agent) and undefined when the SDK's denial
 * record did not say.
 */
export class AgentGuardrailBlockedError extends Error {
    readonly guardrailKey: string | undefined;
    readonly reason: string;
    readonly hook: HookId | undefined;

    constructor(
        message: string,
        detail: { guardrailKey?: string; reason: string; hook?: HookId },
    ) {
        super(message);
        this.name = 'AgentGuardrailBlockedError';
        this.guardrailKey = detail.guardrailKey;
        this.reason = detail.reason;
        this.hook = detail.hook;
    }

    /** The status the gateway uses for `GuardrailBlockError`; kept identical on purpose. */
    get status(): number {
        return 400;
    }
}

/**
 * AGENT-SIDE STREAM GATING IS BLOCKED ON AN SDK CAPABILITY — verified, not
 * assumed, against the installed `@cognipeer/agent-sdk`:
 *
 *   · `InvokeConfig.onStream?: (chunk: StreamChunk) => void` (dist/index.d.ts).
 *     Synchronous and void-returning: the SDK neither awaits a decision nor
 *     offers a return channel to withhold a chunk, so there is no point at
 *     which `createStreamGate` could hold bytes back.
 *   · When a caller passes `onTextChunk`, `onStream` is forwarded only as a
 *     fire-and-forget copy of the deltas (`textStreamOptions`), so there is
 *     still no point at which a chunk can be withheld. That is why an agent
 *     bound to `output.pre` does not stream at all (agentMayStreamAnswer):
 *     its caller gets the guarded answer in one piece.
 *
 * So nothing on this path can gate a chunk, and claiming otherwise would be
 * the one failure the hook plane exists to prevent: a verdict claiming
 * enforcement it did not deliver. Streaming IS enforced on the gateway, which
 * owns its socket (`inferenceService`, `output.stream.delta`).
 *
 * A legacy `outputGuardrailKey` projects onto `output.stream.delta` as well as
 * `output.pre`, so it is still fully enforced here by the post-hoc check. Only
 * a binding scoped to the stream hook ALONE would silently do nothing — which
 * is what this warns about, once per run.
 */
function warnUnservableStreamBinding(config: GuardrailBindingSource, agentKey: string): void {
    const streamOnly = resolveBindings(config, 'output.stream.delta')
        .filter((key) => !resolveBindings(config, 'output.pre').includes(key));
    if (streamOnly.length === 0) return;
    logger.warn(
        'Guardrail bound only to output.stream.delta will not run on this agent: '
        + 'the agent SDK has no awaitable stream hook. Bind it to output.pre as well.',
        { agentKey, guardrailKeys: streamOnly },
    );
}

/**
 * THE TEXT HOOKS RUN AS AN SDK PLUGIN; THE TOOL HOOKS DO NOT. Both halves of
 * that sentence are load-bearing.
 *
 * agent-sdk 0.10.0 finally has a real plugin layer, so `prompt.pre`,
 * `input.pre` and `output.pre` can be served by the host itself instead of by
 * the brackets this module used to put around `sdkAgent.invoke`. That is a
 * straight win: `userPromptSubmit` fires exactly once for a user turn, which is
 * what `prompt.pre` has always meant and what no console surface could emit
 * before.
 *
 * The TOOL hooks deliberately stay on `createAgentToolGuard`, and moving them
 * would be a silent data-loss bug rather than a refactor. The plugin sees the
 * name the MODEL called (`payload.name`); the guard names the same call
 * `agent.tool.<toolKey>.<actionKey>` — the canonical, key-based spelling
 * documented at the top of this file, and the spelling every stored
 * `tool_access` policy is written in. `tool_access` matches a DENY against
 * either spelling but an ALLOW against the canonical one only, so switching
 * planes would leave deny lists working and disarm every allow list, which is
 * the failure that looks like nothing at all. Porting the tool hooks means
 * carrying the name map (and the withheld-result messages) into the plugin;
 * that is its own change, not a passenger on this one.
 *
 * MCP tools stay out of BOTH when their SERVER carries a guardrail binding:
 * `executeMcpToolLocal` guards them against that binding, one layer down, and
 * also covers the surfaces that have no agent at all. A server with NO binding
 * evaluates nothing there, so for that case — and only that case — the agent's
 * own tool guard wraps the tool under the MCP canonical name; see
 * `buildBoundTools`.
 */
const AGENT_PLUGIN_HOOKS: readonly HookId[] = ['prompt.pre', 'input.pre', 'output.pre'];

/**
 * Which way a guardrail whose plugin could NOT be compiled should fail.
 *
 * The record's own `failMode` decides, exactly as it would have inside the
 * plugin (`failureMode` is written from it). The console default is OPEN, so a
 * readable record with no `failMode` fails open. A record that cannot be READ
 * — deleted, or the tenant database did not answer — fails CLOSED: "the binding
 * points at nothing" is the one case where no operator intent is recoverable,
 * and it is also what the connected-agent branch does (`evaluateGuardrail`
 * throws on an unknown key), so the two branches agree.
 */
async function agentGuardrailFailMode(
    input: { tenantDbName: string; projectId: string },
    guardrailKey: string,
): Promise<'open' | 'closed'> {
    try {
        const record = await resolveGuardrail(input.tenantDbName, guardrailKey, input.projectId);
        if (!record) return 'closed';
        return record.failMode === 'closed' ? 'closed' : 'open';
    } catch {
        return 'closed';
    }
}

/**
 * Compile this agent's bound guardrails into SDK plugins.
 *
 * Returns [] when nothing is bound, which is the same thing as "no plugins" to
 * the SDK.
 *
 * PER KEY, NOT ALL-OR-NOTHING. The first version awaited every compile with
 * `Promise.all` inside one try/catch, so ONE key that failed to compile — a
 * colleague deleted the guardrail, the probe answered `unknown`, a transient
 * tenant-DB error — threw away every other key's plugin too, and the record's
 * `failMode` never got a say because the plugin that would have honoured it
 * was never built. Now each key settles on its own:
 *
 *   · compiled        → its plugins are used;
 *   · failed, CLOSED  → an inert plugin that DENIES every hook the binding
 *                       asked for stands in (`denyingSdkPlugin`), so the outage
 *                       is a visible block, not a silent pass;
 *   · failed, OPEN    → skipped with a warning naming the key and the error.
 *
 * The one failure that still refuses the whole run is a missing plugin layer
 * (`SdkPluginLayerUnavailableError`): with no host to run them, a denying plugin
 * would enforce nothing either, and an agent whose guardrails cannot run at all
 * must not start looking guarded.
 */
async function buildAgentGuardrailPlugins(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    config: GuardrailBindingSource;
    actorId?: string;
    /** 'agent' on the live path, 'agent-playground' for a rehearsal. */
    source?: string;
    /** Receives every `preModelCall` message rewrite; see `MessageRewriteLedger`. */
    onMessageRewrite?: (rewrite: PluginMessageRewrite) => void;
}): Promise<AgentSdkPlugin[]> {
    // PER GUARDRAIL, its OWN hooks — not the union.
    //
    // The first version collected the keys across all three hooks and compiled
    // every key with all three enabled. Measured end-to-end, that over-enforces:
    // a guardrail an operator bound only to `output.pre` also ran on
    // `prompt.pre`, because the compiler asks the POLICY which hooks it serves
    // and the caller had said "all of them". The operator sees an evaluation
    // they did not ask for, pays for it, and can be blocked by it.
    const byKey = new Map<string, Set<HookId>>();
    for (const hook of AGENT_PLUGIN_HOOKS) {
        for (const key of resolveBindings(input.config, hook)) {
            const set = byKey.get(key) ?? new Set<HookId>();
            set.add(hook);
            byKey.set(key, set);
        }
    }
    if (byKey.size === 0) return [];
    const entries = [...byKey];
    const keys = entries.map(([key]) => key);

    // ONE traceId for the run's text hooks, unlike the tool guard's one-per-call:
    // `prompt.pre`, `input.pre` and `output.pre` are three moments of the SAME
    // turn, so correlating them is the point. The tool guard splits per call
    // because a multi-tool run would otherwise collapse into one unreadable id.
    const traceId = randomUUID();
    const scope: HookScope = {
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        // `surface: 'agent'` so this run's text decisions land in the same
        // bucket as its tool decisions. The old bracket logged them under
        // 'api', which split one run across two surfaces.
        surface: 'agent',
        source: input.source ?? 'agent',
        // Identical to `createAgentToolGuard`'s actor, so the text and tool
        // decisions of one run agree about who acted.
        actor: { id: input.actorId ?? 'agent', kind: 'agent', roles: ['agent'] },
        traceId,
    };

    const settled = await Promise.allSettled(entries.map(([key, hooks]) => consoleGuardrailPlugins({
        scope,
        guardrailKeys: [key],
        hooks: [...hooks],
        onMessageRewrite: input.onMessageRewrite,
    })));

    // Flattened in binding order, so a rewrite chain over several guardrails is
    // reproducible rather than dependent on Map iteration.
    const plugins: AgentSdkPlugin[] = [];
    for (let index = 0; index < entries.length; index += 1) {
        const [key, hooks] = entries[index];
        const outcome = settled[index];
        if (outcome.status === 'fulfilled') {
            plugins.push(...outcome.value.map(toAgentPlugin));
            continue;
        }

        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);

        if (outcome.reason instanceof SdkPluginLayerUnavailableError) {
            // No plugin layer means NOTHING here can run — not the compiled
            // keys, not a denying stand-in. This repo's lockfile pins 0.10.1,
            // but the dependency is a caret range, so a self-hosted build that
            // resolves it differently would otherwise disarm every agent
            // guardrail with no signal at all. Refusing the run is the honest
            // outcome: the caller sees an error naming the keys and why.
            logger.error('Failed to compile agent guardrail plugins; refusing the run', {
                agentKey: input.agentKey,
                guardrailKeys: keys,
                error: message,
            });
            throw new Error(
                `Agent "${input.agentKey}" has guardrails bound (${keys.join(', ')}) that could not be `
                + `compiled, so the run was refused rather than executed unchecked: ${message}`,
            );
        }

        const failMode = await agentGuardrailFailMode(input, key);
        if (failMode === 'closed') {
            logger.error('Agent guardrail could not be compiled; denying its hooks (fail closed)', {
                agentKey: input.agentKey,
                guardrailKey: key,
                hooks: [...hooks],
                error: message,
            });
            plugins.push(toAgentPlugin(denyingSdkPlugin({
                guardrailKey: key,
                hooks: [...hooks],
                reason: message,
                priority: index,
            })));
            continue;
        }

        logger.warn('Agent guardrail could not be compiled; skipped (fail open)', {
            agentKey: input.agentKey,
            guardrailKey: key,
            hooks: [...hooks],
            error: message,
        });
    }
    return plugins;
}

/**
 * The text a `preModelCall` redaction produced for each message it rewrote, so
 * the console can PERSIST what the model saw.
 *
 * The host applies that rewrite to the wire transcript only and leaves
 * `state.messages` — and therefore `result.messages` — carrying the original
 * (`SdkGuardrailContext.onMessageRewrite` explains the mechanics). Without this
 * ledger the raw user turn would be written to the conversation and replayed as
 * history on every later turn, where neither `userPromptSubmit` (tail message
 * only) nor `preModelCall` (high-water mark) re-scans it.
 *
 * Keyed by content rather than by index because wire indices and persisted
 * indices differ (the system prompt sits at wire index 0). Rewrites CHAIN across
 * guardrails — A turns X into Y, B turns Y into Z — so `resolve` follows the
 * chain, bounded so a pathological cycle cannot spin.
 */
class MessageRewriteLedger {
    private readonly byBefore = new Map<string, string>();

    record(rewrite: PluginMessageRewrite): void {
        if (rewrite.before === rewrite.after) return;
        this.byBefore.set(rewrite.before, rewrite.after);
    }

    resolve(text: string): string {
        let current = text;
        for (let hops = 0; hops < 8; hops += 1) {
            const next = this.byBefore.get(current);
            if (next === undefined || next === current) break;
            current = next;
        }
        return current;
    }

    get size(): number {
        return this.byBefore.size;
    }
}

/** Flattened text of a message's content — a string, or the text parts joined. */
function agentMessageText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => {
            const text = (part as { text?: unknown } | null | undefined)?.text;
            return typeof text === 'string' ? text : '';
        })
        .filter(Boolean)
        .join('\n');
}

/**
 * The user turn to PERSIST and to cut the title from: the rewritten one, never
 * the raw request text.
 *
 * Two rewrite channels compose here. A `prompt.pre` (`userPromptSubmit`)
 * redaction is written by the host into `state.messages` in place, so it is read
 * back from `result.messages` at the index the turn was appended at. An
 * `input.pre` (`preModelCall`) redaction never reaches `state.messages` and is
 * read from the ledger instead, matched by content — which also covers the case
 * where both fired (the ledger's `before` is then the prompt-rewritten text).
 * Falls back to the raw message when the result no longer holds a user turn at
 * that index (a compaction mid-run), and the ledger still applies to it.
 */
function persistedUserTurn(input: {
    result: { messages?: Array<{ role?: string; content?: unknown }> };
    /** Index the user turn was appended at in the invoke input. */
    index: number;
    fallback: string;
    ledger: MessageRewriteLedger;
}): string {
    const entry = input.result.messages?.[input.index];
    const fromResult = entry?.role === 'user' ? agentMessageText(entry.content) : '';
    // What the turn added for attached files (sessionFiles.ts) is not the person's text.
    return stripAttachmentBlock(input.ledger.resolve(fromResult || input.fallback));
}

/**
 * The connected-agent counterpart, warning once per run about every binding
 * this surface cannot serve.
 *
 * A connected agent is reached over ONE HTTP call that carries text in and text
 * out (`invokeExternalAgent`). Its tools run inside the remote agent: we never
 * see a tool name, its arguments or its result, so `tool.pre` / `tool.post`
 * have no subject to evaluate and no tool guard is built for that branch. A
 * binding an operator wrote against those hooks is therefore unservable — and
 * unservable-and-silent is exactly the failure the hook plane exists to end, so
 * it is said out loud.
 *
 * The STREAM case is delegated — no agent surface serves it, the remedy is the
 * same, and two copies of that message would drift.
 *
 * `prompt.pre` is warned about HERE and no longer on the local path, because
 * since agent-sdk 0.10.0 the two surfaces genuinely differ: the local agent
 * serves the hook through the plugin layer's `userPromptSubmit`, while a
 * connected agent still cannot — the remote runtime owns the loop, so only it
 * knows which model call opens a turn, and all this process sees is one HTTP
 * round trip. The remedy differs too: on a connected agent the operator either
 * binds `input.pre` as well, or moves enforcement into the remote runtime with
 * the SDK's own `cognipeerGuardrail` preset, which POSTs to
 * `/api/client/v1/guardrails/hooks/evaluate`.
 */
function warnUnservableExternalBindings(config: GuardrailBindingSource, agentKey: string): void {
    warnUnservableStreamBinding(config, agentKey);

    const promptOnly = resolveBindings(config, 'prompt.pre')
        .filter((key) => !resolveBindings(config, 'input.pre').includes(key));
    if (promptOnly.length > 0) {
        logger.warn(
            'Guardrail bound only to prompt.pre will not run on this connected agent: the '
            + 'remote runtime owns the turn, so the console cannot emit prompt.pre for it. '
            + 'Bind it to input.pre as well, or enforce inside the remote runtime through '
            + 'POST /api/client/v1/guardrails/hooks/evaluate.',
            { agentKey, guardrailKeys: promptOnly },
        );
    }

    // Both tool hooks in one warning: an operator who bound a guardrail to
    // `tool.pre` and `tool.post` has one mistake, not two.
    const toolKeys = [...new Set([
        ...resolveBindings(config, 'tool.pre'),
        ...resolveBindings(config, 'tool.post'),
    ])];
    if (toolKeys.length === 0) return;
    logger.warn(
        'Guardrail bound to tool.pre/tool.post will not run on this connected agent: '
        + 'its tools execute on the remote endpoint and are never visible here. '
        + 'Only input.pre and output.pre are enforceable on a connected agent.',
        { agentKey, guardrailKeys: toolKeys },
    );
}

/**
 * The three Knowledge Engine tools an agent gets when it has a knowledgeEngineKey
 * configured: search, then two ways to read a match's source document further
 * than the matched passage. Shared by the live chat and playground chat paths,
 * which otherwise built the same tools twice and would drift on the next change.
 */
async function buildKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    ragModuleKey: string,
    guard: AgentToolGuard,
    opts: KnowledgeToolOptions = {},
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const sfx = opts.suffix ? `_${opts.suffix}` : '';
    const searchName = `knowledge_search${sfx}`;
    const readName = `knowledge_read_document${sfx}`;
    const readLinesName = `knowledge_read_document_lines${sfx}`;
    const renamed = (text: string) => (sfx
        ? text
            .replace(/knowledge_search/g, searchName)
            .replace(/knowledge_read_document_lines/g, readLinesName)
            .replace(/knowledge_read_document(?!_)/g, readName)
        : text);
    const searchDescription = withDirective(renamed(CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION), opts.description);
    const { z } = await import('zod');

    const knowledgeModule = await resolveAgentKnowledgeModule(tenantDbName, ragModuleKey, projectId);
    if (!knowledgeModule) {
        logger.warn('Skipping knowledge engine not visible to the agent\'s project', { key: ragModuleKey, projectId });
        return { tools: [], toolDefinitions: [] };
    }
    if (knowledgeModule.status !== 'active') {
        logger.warn('Skipping knowledge engine that is switched off', { key: ragModuleKey, projectId });
        return { tools: [], toolDefinitions: [] };
    }
    // Every later read re-resolves the module by key; pinning the scope it was
    // found in keeps those reads on this same row ('' = tenant-wide only).
    const moduleScope = knowledgeModule.projectId ? String(knowledgeModule.projectId) : '';
    const filterableFields = knowledgeModule.filterableFields ?? [];

    const searchTool = createTool({
        name: searchName,
        description: searchDescription,
        schema: filterableFields.length > 0
            ? z.object({
                query: z.string().describe('The search query'),
                filter: z.record(z.unknown()).optional()
                    .describe(knowledgeSearchFilterDescription(filterableFields)),
            })
            : z.object({ query: z.string().describe('The search query') }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'search'), requestedName: searchName },
            async (args: { query: string; filter?: Record<string, unknown> }) => {
                const result = await queryRag(tenantDbName, tenantId, moduleScope, {
                    ragModuleKey,
                    query: args.query,
                    topK: opts.topK ?? (opts.suffix ? undefined : 5),
                    ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
                    filter: mergeKnowledgeFilters(opts.filter, args.filter),
                }, { signal: currentTurnSignal() });
                return result.matches
                    .filter((m) => m.content)
                    .map((m) => {
                        const tag = m.documentId
                            ? `[documentId: ${m.documentId}${m.fileName ? `, file: ${m.fileName}` : ''}]\n`
                            : '';
                        return `${tag}${m.content}`;
                    })
                    .join('\n\n---\n\n');
            },
        ),
    });

    // documentId is trusted to be one this tenant's search just returned, but a
    // model can pass any string — checking ragModuleKey keeps a read call scoped
    // to the same knowledge base the agent was actually bound to.
    async function resolveOwnedDocument(documentId: string) {
        const document = await getRagDocument(tenantDbName, documentId);
        if (!document || document.ragModuleKey !== ragModuleKey) return undefined;
        if (moduleScope && document.projectId && String(document.projectId) !== moduleScope) return undefined;
        return document;
    }

    const readTool = createTool({
        name: readName,
        description: sfx ? withDirective(renamed(CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION), opts.description) : CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document'),
                requestedName: readName,
            },
            async (args: { documentId: string }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentFullText(tenantDbName, tenantId, moduleScope, document);
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const notice = result.truncated
                    ? `\n\n[Truncated at ${result.text.length} of ${result.totalChars} characters `
                        + `(${result.totalLines} lines total). Use knowledge_read_document_lines to read the rest.]`
                    : '';
                return `# ${result.fileName}\n\n${result.text}${notice}`;
            },
        ),
    });

    const readLinesTool = createTool({
        name: readLinesName,
        description: renamed(CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION),
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from (default 1)'),
            limit: z.number().int().min(1).max(1000).optional()
                .describe('Number of lines to return (default 200, max 1000)'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document_lines'),
                requestedName: readLinesName,
            },
            async (args: { documentId: string; offset?: number; limit?: number }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentTextLines(tenantDbName, tenantId, moduleScope, document, {
                    offset: args.offset,
                    limit: args.limit,
                });
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const more = result.hasMore
                    ? `\n\n[Lines ${result.startLine}-${result.endLine} of ${result.totalLines}. `
                        + `Call again with offset: ${result.endLine + 1} to continue.]`
                    : '';
                return `# ${result.fileName} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`
                    + `${result.lines}${more}`;
            },
        ),
    });

    return {
        tools: [searchTool, readTool, readLinesTool],
        toolDefinitions: [
            { ...knowledgeSearchToolDefinition(filterableFields), name: searchName, description: searchDescription },
            { ...knowledgeReadToolDefinition(), name: readName },
            { ...knowledgeReadLinesToolDefinition(), name: readLinesName },
        ],
    };
}

interface KnowledgeToolOptions {
    /** Tool-name suffix (separate mode). Unset = the legacy un-suffixed tools. */
    suffix?: string;
    description?: string;
    topK?: number;
    minScore?: number;
    filter?: Record<string, unknown>;
}

function withDirective(base: string, description?: string): string {
    const text = description?.trim();
    return text ? `${base}\n\nUse for: ${text}` : base;
}

/** Binding filter AND-ed with whatever filter the model supplied. */
function mergeKnowledgeFilters(
    fixed?: Record<string, unknown>,
    asked?: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const hasFixed = fixed && Object.keys(fixed).length > 0;
    if (!hasFixed) return asked;
    if (!asked || Object.keys(asked).length === 0) return fixed;
    return { $and: [fixed, asked] };
}

/**
 * Knowledge tools for an agent config. One legacy key keeps the historical
 * tools; several bindings become either one combined tool set or one set per KB.
 */
export async function buildAgentKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    source: KnowledgeBindingSource,
    guard: AgentToolGuard,
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const bindings = normalizeKnowledgeBindings(source);
    if (bindings.length === 0) return { tools: [], toolDefinitions: [] };
    const plain = bindings[0];
    if (bindings.length === 1 && !plain.description && plain.topK === undefined
        && plain.minScore === undefined && !plain.filter) {
        return buildKnowledgeTools(tenantDbName, tenantId, projectId, plain.key, guard);
    }
    if (source.knowledgeToolMode === 'separate') {
        const tools: AgentSdkToolInterface[] = [];
        const toolDefinitions: TraceToolDefinition[] = [];
        for (const binding of bindings) {
            const built = await buildKnowledgeTools(tenantDbName, tenantId, projectId, binding.key, guard, {
                suffix: knowledgeKeySlug(binding.key),
                description: binding.description,
                topK: binding.topK,
                minScore: binding.minScore,
                filter: binding.filter,
            });
            tools.push(...built.tools);
            toolDefinitions.push(...built.toolDefinitions);
        }
        return { tools, toolDefinitions };
    }
    return buildCombinedKnowledgeTools(tenantDbName, tenantId, projectId, bindings, guard);
}

async function buildCombinedKnowledgeTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bindings: IAgentKnowledgeBinding[],
    guard: AgentToolGuard,
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    const visible: Array<{ binding: IAgentKnowledgeBinding; scope: string }> = [];
    for (const binding of bindings) {
        const mod = await resolveAgentKnowledgeModule(tenantDbName, binding.key, projectId);
        if (!mod) {
            logger.warn('Skipping knowledge engine not visible to the agent\'s project', { key: binding.key, projectId });
            continue;
        }
        if (mod.status !== 'active') {
            logger.warn('Skipping knowledge engine that is switched off', { key: binding.key, projectId });
            continue;
        }
        visible.push({ binding, scope: mod.projectId ? String(mod.projectId) : '' });
    }
    if (visible.length === 0) return { tools: [], toolDefinitions: [] };
    const byKey = new Map(visible.map((v) => [v.binding.key, v]));
    const keys = visible.map((v) => v.binding.key);

    const catalog = visible
        .map((v) => `- ${v.binding.key}${v.binding.description?.trim() ? `: ${v.binding.description.trim()}` : ''}`)
        .join('\n');
    const searchDescription = `${CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION}\n\nThis searches ALL of these knowledge bases at once; each match is tagged with its kb:\n${catalog}`;
    const readHint = ' Pass `kb` (the kb tag of the match) when more than one knowledge base is bound.';
    const searchSchema = z.object({ query: z.string().describe('The search query') });
    const kbArg = z.string().optional().describe(`Knowledge base key from the search result. One of: ${keys.join(', ')}`);

    // The bound KB a read targets: explicit `kb`, or the only one, else ambiguous.
    async function resolveOwned(documentId: string, kb?: string) {
        const candidates = kb ? (byKey.has(kb) ? [byKey.get(kb)!] : []) : visible;
        if (kb && candidates.length === 0) return { error: `Unknown knowledge base "${kb}". Use one of: ${keys.join(', ')}.` };
        const document = await getRagDocument(tenantDbName, documentId);
        if (!document) return { error: 'Document not found in the bound knowledge bases.' };
        const owner = candidates.find((c) => c.binding.key === document.ragModuleKey
            && !(c.scope && document.projectId && String(document.projectId) !== c.scope));
        if (!owner) return { error: 'Document not found in the bound knowledge bases.' };
        return { document, scope: owner.scope };
    }

    const searchTool = createTool({
        name: 'knowledge_search',
        description: searchDescription,
        schema: searchSchema,
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'search'), requestedName: 'knowledge_search' },
            async (args: { query: string }) => {
                const lists = await Promise.all(visible.map(async ({ binding, scope }) => {
                    const result = await queryRag(tenantDbName, tenantId, scope, {
                        ragModuleKey: binding.key,
                        query: args.query,
                        topK: binding.topK,
                        ...(binding.minScore !== undefined ? { minScore: binding.minScore } : {}),
                        filter: binding.filter,
                    }, { signal: currentTurnSignal() });
                    return result.matches.filter((m) => m.content).map((m): KnowledgeHit => ({
                        kb: binding.key,
                        documentId: m.documentId,
                        fileName: m.fileName,
                        score: m.score ?? 0,
                        content: m.content ?? '',
                    }));
                }));
                return mergeKnowledgeHits(lists.flat()).map(formatKnowledgeHit).join('\n\n---\n\n');
            },
        ),
    });

    const readTool = createTool({
        name: 'knowledge_read_document',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION + readHint,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            kb: kbArg,
        }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'read_document'), requestedName: 'knowledge_read_document' },
            async (args: { documentId: string; kb?: string }) => {
                const owned = await resolveOwned(args.documentId, args.kb);
                if ('error' in owned) return owned.error;
                const result = await getRagDocumentFullText(tenantDbName, tenantId, owned.scope, owned.document);
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const notice = result.truncated
                    ? `\n\n[Truncated at ${result.text.length} of ${result.totalChars} characters `
                        + `(${result.totalLines} lines total). Use knowledge_read_document_lines to read the rest.]`
                    : '';
                return `# ${result.fileName}\n\n${result.text}${notice}`;
            },
        ),
    });

    const readLinesTool = createTool({
        name: 'knowledge_read_document_lines',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION + readHint,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            kb: kbArg,
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from (default 1)'),
            limit: z.number().int().min(1).max(1000).optional()
                .describe('Number of lines to return (default 200, max 1000)'),
        }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'read_document_lines'), requestedName: 'knowledge_read_document_lines' },
            async (args: { documentId: string; kb?: string; offset?: number; limit?: number }) => {
                const owned = await resolveOwned(args.documentId, args.kb);
                if ('error' in owned) return owned.error;
                const result = await getRagDocumentTextLines(tenantDbName, tenantId, owned.scope, owned.document, {
                    offset: args.offset,
                    limit: args.limit,
                });
                if (!result) return 'Source text is not available for this document; it may need to be re-ingested.';
                const more = result.hasMore
                    ? `\n\n[Lines ${result.startLine}-${result.endLine} of ${result.totalLines}. `
                        + `Call again with offset: ${result.endLine + 1} to continue.]`
                    : '';
                return `# ${result.fileName} (lines ${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`
                    + `${result.lines}${more}`;
            },
        ),
    });

    return {
        tools: [searchTool, readTool, readLinesTool],
        toolDefinitions: [
            {
                name: 'knowledge_search',
                description: searchDescription,
                parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'] },
            },
            { ...knowledgeReadToolDefinition(), description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION + readHint },
            { ...knowledgeReadLinesToolDefinition(), description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION + readHint },
        ],
    };
}

type InternalTraceEvent = TraceSessionFile['events'][number] & {
    toolName?: string;
    usage?: Record<string, unknown>;
    metadata?: Record<string, unknown> & { usage?: Record<string, unknown> };
    finishReason?: string;
    reasoningTokens?: number;
    sections?: unknown[];
    data?: { sections?: unknown[] };
    modelNames?: string[];
    bytesIn?: number | null;
    bytesOut?: number | null;
};

type InternalTraceSession = Omit<TraceSessionFile, 'events'> & {
    events: InternalTraceEvent[];
    metadata?: Record<string, string>;
};

/**
 * A guardrail DENY on the plugin plane is not a thrown error — and the console
 * has to turn it back into one.
 *
 * When a plugin denies, agent-sdk does not reject `invoke()`. It appends an
 * assistant message carrying the reason, sets `state.ctx.__guardrailBlocked`,
 * and resolves normally. Left alone that would be a silent contract change on
 * this deploy: the brackets this replaced THREW, every caller of
 * `executeAgentChatLocal` is written against a throw, and a blocked run would
 * instead have been persisted and returned as a perfectly ordinary answer.
 *
 * The reason also needs cleaning. The host prefixes every denial with the
 * plugin's own name (`dist/index.mjs:6744`, `${entry.plugin}: ${output.reason}`)
 * with no way to opt out, and our plugins are named
 * `cognipeer-guardrail:<guardrailKey>` — so the raw string would show an
 * internal key to whoever typed the message. The prefix is stripped here rather
 * than by renaming the plugin, because that name is also `deniedBy`, the key in
 * every plugin log line, and what `childPlugins()` matches on.
 */
/** The shape both detectors read; `AgentInvokeResult` satisfies it structurally. */
interface DeniableInvokeResult {
    state?: unknown;
    messages?: Array<{ role?: string; name?: string; content?: unknown; metadata?: unknown }>;
}

/** What the SDK records about a denial, on `ctx.__guardrailBlocked.incident` and on the marker message's `metadata.plugin`. */
interface SdkDenialIncident {
    reason?: string;
    deniedBy?: string;
    hook?: string;
}

function denialIncident(result: DeniableInvokeResult): SdkDenialIncident | undefined {
    const ctx = (result.state as { ctx?: Record<string, unknown> } | undefined)?.ctx;
    const blocked = ctx?.__guardrailBlocked as { incident?: SdkDenialIncident } | undefined;
    return blocked?.incident;
}

function guardrailDenial(result: DeniableInvokeResult): string | undefined {
    const incident = denialIncident(result);

    // TWO DETECTORS, kept deliberately.
    //
    // `ctx.__guardrailBlocked` is set for a denial at `preModelCall` and
    // `postModelCall` (dist/index.mjs:4074, :4201) and — since agent-sdk 0.10.1
    // — for a `userPromptSubmit` denial on BOTH `createAgent` (:7619) and
    // `createSmartAgent` (:10325), the one `buildLocalAgentRun` creates. On
    // 0.10.0 the smart-agent prompt branch returned the blocked state WITHOUT
    // the ctx marker, measured end-to-end: a guardrail bound to `prompt.pre`
    // decided `block`, the evaluation log recorded `decision: "block"`, and the
    // run completed normally because nothing here could see it.
    //
    // The trailing assistant message the SDK names `guardrail` is set by every
    // denial path on every 0.10.x build, so it stays as the fallback: the
    // dependency is a caret range, and a self-hosted build resolving 0.10.0
    // would otherwise bring the silent pass back. Detecting the block is not
    // optional: without it a denied prompt is persisted and returned as an
    // ordinary answer.
    const tail = result.messages?.[result.messages.length - 1];
    const messageMarker = tail?.role === 'assistant' && tail?.name === 'guardrail'
        ? (typeof tail.content === 'string' ? tail.content : '')
        : undefined;

    if (!incident && messageMarker === undefined) return undefined;

    const raw = incident?.reason ?? messageMarker ?? '';
    const deniedBy = incident?.deniedBy;
    // Strip only OUR prefix, and only from the front: a reason that happens to
    // contain the plugin name later on is the operator's own message text.
    // With `deniedBy` known, strip exactly that prefix. Without it — the
    // message-marker path carries no `deniedBy` — fall back to the shape the
    // host always writes, `cognipeer-guardrail:<key>: `, anchored at the front
    // so a reason that merely mentions the name later is left alone.
    const cleaned = deniedBy && raw.startsWith(`${deniedBy}: `)
        ? raw.slice(deniedBy.length + 2)
        : raw.replace(/^cognipeer-guardrail:[^\s:]+:\s*/, '');
    return cleaned.trim() || 'Blocked by a guardrail policy.';
}

/** Plugin name -> console guardrail key; `undefined` for a plugin that is not ours. */
const GUARDRAIL_PLUGIN_PREFIX = 'cognipeer-guardrail:';

/** SDK plugin hook name -> console hook id, the inverse of `CONSOLE_HOOK_MAP`. */
function consoleHookFor(sdkHook: string | undefined): HookId | undefined {
    if (!sdkHook) return undefined;
    for (const [hook, mapped] of Object.entries(CONSOLE_HOOK_MAP) as Array<[HookId, string | null]>) {
        if (mapped === sdkHook) return hook;
    }
    return undefined;
}

/**
 * `guardrailDenial`, as the typed error the callers throw.
 *
 * The key and hook come from the SDK's incident record when it carries them
 * (`deniedBy` is our plugin name; `hook` is the SDK hook that denied) and from
 * the marker message's `metadata.plugin` otherwise; both are absent on the
 * message-only path, and the error then carries the reason alone.
 */
function guardrailBlockedError(result: DeniableInvokeResult): AgentGuardrailBlockedError | undefined {
    const reason = guardrailDenial(result);
    if (reason === undefined) return undefined;

    const incident = denialIncident(result);
    const tail = result.messages?.[result.messages.length - 1];
    const markerPlugin = (tail?.metadata as { plugin?: SdkDenialIncident } | undefined)?.plugin;
    const deniedBy = incident?.deniedBy ?? markerPlugin?.deniedBy;
    const guardrailKey = deniedBy?.startsWith(GUARDRAIL_PLUGIN_PREFIX)
        ? deniedBy.slice(GUARDRAIL_PLUGIN_PREFIX.length)
        : undefined;

    const hook = consoleHookFor(incident?.hook ?? markerPlugin?.hook);
    // Which side was refused: the prompt (`input.*`) or the answer.
    const side = hook?.startsWith('input.') ? 'input' : 'response';
    return new AgentGuardrailBlockedError(`Agent ${side} blocked by guardrail: ${reason}`, {
        guardrailKey,
        reason,
        hook,
    });
}

/**
 * EXPORTED FOR TESTS ONLY. These are module-private helpers whose whole job is
 * to notice something the SDK does not announce, or to compose several keys'
 * plugins; they need coverage that does not require standing up a real agent
 * and a real model.
 */
export const __testables = {
    textStreamOptions,
    noteTurnCompaction,
    guardrailDenial,
    guardrailBlockedError,
    buildAgentGuardrailPlugins,
    MessageRewriteLedger,
    persistedUserTurn,
    firstTurnTitle,
    toToolCallEvent,
};

/**
 * `limits.maxCostUsd` is enforced by the SDK only through a `costEstimator`;
 * without one the limit did nothing at all. Built when the limit is set — or
 * the session has a spend budget, which rides on the same SDK limit — and also
 * whenever a sub-agent runs on a model of its own: the SDK's per-request usage
 * carries the delegated calls too (each tagged with its sub-agent), and pricing
 * them takes their model's rates, not the parent's. Priced from the agent's
 * model and every model a sub-agent was given, so a delegated call spends from
 * the same budget at its own price.
 */
async function buildAgentCostEstimator(
    config: IAgentConfig,
    primary: PricedModel,
    subagentModels: PricedModel[],
    sessionBudgetActive = false,
    onWarning?: (message: string) => void,
): Promise<ReturnType<typeof buildCostEstimator>> {
    const limited = sessionBudgetActive || Number(config.runtime?.limits?.maxCostUsd) > 0;
    if (!limited && subagentModels.length === 0) return undefined;
    const { calculateCost } = await import('@/lib/services/models/usageLogger');
    const models: Parameters<typeof buildCostEstimator>[0] = [
        { names: [primary.key, primary.modelId], pricing: primary.pricing },
    ];
    for (const child of subagentModels) {
        if (child.key && child.key === primary.key) continue;
        models.push({ names: [child.key, child.modelId], pricing: child.pricing, noFallback: true });
        if (limited && !(((child.pricing?.inputTokenPer1M ?? 0) > 0) || ((child.pricing?.outputTokenPer1M ?? 0) > 0))) {
            onWarning?.(`Sub-agent model "${child.key}" has no pricing, so its calls are not counted against the cost limit or the session budget.`);
        }
    }
    const estimator = buildCostEstimator(models, primary.pricing, calculateCost);
    if (!estimator && limited) {
        logger.warn('A cost limit is set but the agent model has no pricing; the cost limit cannot be enforced', {
            modelKey: primary.key,
        });
    }
    return estimator;
}

/**
 * Reasoning ("thinking") models expose their chain-of-thought separately from the
 * final answer. A native provider puts it on the assistant message as
 * `reasoning.summary` (OpenAI-compatible `reasoning_content` / `reasoning`,
 * Anthropic thinking, Gemini thoughts, Bedrock reasoningContent all land there).
 * Pull the trace from the final assistant message so callers can surface it
 * alongside the answer. A turn saved before the native providers kept it on
 * `additional_kwargs.reasoning_content`; that is still read.
 */
export function extractAgentReasoning(result: AgentSdkInvokeResult): string | undefined {
    const messages = (result.messages ?? []) as Array<{
        role?: string;
        getType?: () => string;
        _getType?: () => string;
        reasoning?: { summary?: unknown };
        additional_kwargs?: Record<string, unknown>;
    }>;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        const type = msg?.role ?? msg?.getType?.() ?? msg?._getType?.();
        if (type && type !== 'assistant' && type !== 'ai') continue;
        const summary = msg?.reasoning?.summary;
        if (typeof summary === 'string' && summary.length > 0) return summary;
        const legacy = msg?.additional_kwargs?.['reasoning_content'];
        if (typeof legacy === 'string' && legacy.length > 0) return legacy;
        if (type) break;
    }
    return undefined;
}

/**
 * Reduces `runtimeContext` into the flat string map the trace session's own
 * `metadata` field accepts.
 *
 * These attribution tags are separate from prompt variables. They are what
 * lets a scheduled fire, a live API call, and a playground run show up
 * distinguishably in the existing Traces/Observability views instead of
 * needing a parallel "run" record: `?metadataKey=scheduleId&metadataValue=<id>`
 * on the tracing list finds every fire of one schedule, and
 * `schedule.lastConversationId` already equals the trace's `threadId`, so a
 * single fire is one click away without any new API surface.
 *
 * Deliberately narrow: `source` and `trigger`/`scheduleId`/`scheduleName` (the
 * fields the scheduler stamps into `metadata` for prompt variables) are worth
 * attribution — they are exactly what `?metadataKey=…&metadataValue=…` on the
 * tracing list is for. The rest of a caller's free-form metadata is left out;
 * it was sent for prompt rendering, not for a tracing filter, and object/array
 * values would need a shape decision this call site should not make silently.
 */
export function buildTracingMetadata(runtimeContext: AgentRuntimeContext | undefined): Record<string, string> | undefined {
    if (!runtimeContext) return undefined;
    const out: Record<string, string> = {};
    if (runtimeContext.source) out.source = runtimeContext.source;
    // An application's token acted for the person: the tags let the Traces views filter calls made on someone's behalf.
    if (runtimeContext.via) {
        out.via = runtimeContext.via.kind;
        out.viaIssuer = runtimeContext.via.issuer;
    }
    if (runtimeContext.trigger) {
        out.triggerId = runtimeContext.trigger.id;
        out.trigger = runtimeContext.trigger.type;
    }
    const meta = runtimeContext.metadata;
    for (const key of ['trigger', 'scheduleId', 'scheduleName']) {
        const value = meta?.[key];
        if (typeof value === 'string' && value) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Logs which prompt placeholders came from the caller and which nobody filled.
 *
 * An unfilled placeholder renders empty, which is exactly the failure this
 * whole module exists to make visible: the prompt still "works", it just quietly
 * says less than its author wrote. A warn line is the cheapest way for an
 * operator to find that from a trace.
 */
function reportPromptVariables(
    rendered: RenderedPrompt,
    context: { agentKey: string; promptKey?: string },
): void {
    if (rendered.unresolved.length > 0) {
        logger.warn('Prompt has unresolved variables; they rendered empty', {
            ...context,
            unresolved: rendered.unresolved,
        });
    }
    if (rendered.fromCaller.length > 0) {
        logger.debug('Prompt variables filled from caller runtime context', {
            ...context,
            variables: rendered.fromCaller,
        });
    }
}

/**
 * The system prompt an agent runs with: its own text (or the one the caller
 * hands in), else the Prompts-module template its `promptKey` names, rendered
 * with the run's prompt variables. An inline prompt is rendered only when the
 * agent opted in or the text references a built-in (`shouldRenderInlinePrompt`),
 * so a literal `{{` in an existing prompt is left alone. Used for the agent's own
 * run and, with the referenced agent's own config, for a sub-agent that is
 * another agent: the same text it would run with on its own.
 */
async function resolveAgentPrompt(input: {
    db: Pick<Awaited<ReturnType<typeof getDatabase>>, 'findPromptByKey'>;
    projectId: string;
    agentKey: string;
    config: IAgentConfig;
    systemPrompt: string | undefined;
    variables: ResolvedPromptVariables;
}): Promise<string | undefined> {
    const { config, agentKey } = input;
    let systemPrompt = input.systemPrompt;
    if (!systemPrompt && config.promptKey) {
        const prompt = await input.db.findPromptByKey(config.promptKey, input.projectId);
        if (prompt) {
            const rendered = renderPromptTemplate(prompt.template, input.variables);
            systemPrompt = rendered.text;
            reportPromptVariables(rendered, { agentKey, promptKey: config.promptKey });
        }
    } else if (systemPrompt && shouldRenderInlinePrompt(config, systemPrompt)) {
        const rendered = renderPromptTemplate(systemPrompt, input.variables);
        systemPrompt = rendered.text;
        reportPromptVariables(rendered, { agentKey });
    }
    return systemPrompt;
}

// ── Sub-agent registry ──────────────────────────────────────────────

/** Who a model call is made for: rides on its usage row and its Dynamic LLM caller conditions. */
export interface AgentModelCaller {
    agentKey?: string;
    /** The Session / API conversation. */
    sessionId?: string;
    userId?: string;
}

type BuildSubagentsInput = {
    db: Awaited<ReturnType<typeof getDatabase>>;
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    /** The entries that can run (`activeSubagentEntries`): a roster switched off is never built. */
    subagents: IAgentSubagent[];
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool;
    zod: typeof import('zod').z;
    guard: AgentToolGuard;
    runtimeContext?: AgentRuntimeContext;
    /** Who the run is for (Console identity); a referenced child acts under its own agent key. */
    identity?: ConsoleIdentityCaller;
    /** Who a sub-agent model's spend is attributed to (tenant spend limits). */
    spend?: AgentSpendScope;
    /** The session's images, read at a sub-agent's own model call (see `sessionImages.ts`). */
    images?: SessionImagesOptions;
    /** The run's tool-image store: a child's tools show their images the same way (judged by the child's own model). */
    toolMedia?: ToolMediaContext;
    /** The parent's model takes images: what a child without a model of its own runs on. */
    modelTakesImages?: boolean;
    /** Whose run this is, for the usage rows of a sub-agent's model calls. */
    caller?: AgentModelCaller;
    /**
     * Reasoning of a sub-agent's model: the parent's selection for the same
     * model (when it is one the parent picked), then Model Hub, then the request.
     */
    reasoning?: { config: IAgentConfig; request?: NormalizedReasoning };
    /** What a child's system prompt is rendered from. */
    prompt: {
        /** The parent's config and prompt variables: a prompt written in its config (an inline child's) renders as the parent's own does. */
        parent: { config: IAgentConfig; variables: ResolvedPromptVariables };
        /** The parent run's validated agent variables: a referenced agent's variables of the same name take their values. */
        variables?: Record<string, unknown>;
        variablesInPrompt?: boolean;
        userId?: string;
    };
    /** Reports, once, a child that was skipped or runs short of what its author set up. */
    onWarning?: (message: string) => void;
    /**
     * How the delegating run answers tool approvals, so a child's tools are gated like the parent's own:
     * the parent's settings and mode, and (for a `ref` child) its agent's settings under the same run.
     */
    approvals?: {
        hitl: ResolvedHitlConfig;
        mode: HitlRunMode;
        run: { unattended?: boolean; canPause?: boolean };
        allowedTools: ReadonlySet<string>;
    };
};

/**
 * Turns `config.subagents` into the SDK's sub-agent registry.
 *
 * `inline` children are defined entirely in the parent's config. `ref` children
 * borrow another console agent's prompt, model and tools — resolved from that
 * agent's PUBLISHED config unless a version is pinned, so editing a draft can
 * never change what a parent delegates to mid-flight.
 *
 * A `ref` child's own sub-agents are deliberately dropped: the SDK already
 * enforces a depth budget, and expanding a reference tree here would let one
 * edit in a leaf agent silently multiply every parent's tool surface. Nesting
 * beyond one level is expressed with the SDK's own `maxDepth`, not by inlining.
 */
export async function buildAgentSubagents(
    input: BuildSubagentsInput,
): Promise<{ subagents: AgentSdkSubagentDef[]; cleanupTasks: Array<() => Promise<void>>; models: PricedModel[] }> {
    const entries = input.subagents;
    if (entries.length === 0) return { subagents: [], cleanupTasks: [], models: [] };
    // A child is an agent run of the same tenant: refused with the agents service,
    // and its own knowledge and tools lose what a switched-off service provided.
    await assertAgentsEnabled({ tenantId: input.tenantId, tenantDbName: input.tenantDbName });
    const disabledServices = await getDisabledServices(input.tenantId);

    const subagents: AgentSdkSubagentDef[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    // The models the children were given, as the turn's cost estimator needs them.
    const models: PricedModel[] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        if (!entry.name || seen.has(entry.name)) {
            const message = entry.name
                ? `Sub-agent name "${entry.name}" is used more than once: only the first one is available.`
                : 'A sub-agent has no name, so it was skipped.';
            logger.warn(message, { name: entry.name });
            input.onWarning?.(message);
            continue;
        }

        let systemPrompt: string | undefined;
        let toolBindings = entry.toolBindings;
        let knowledgeSource: KnowledgeBindingSource = { knowledgeEngineKey: entry.knowledgeEngineKey };
        let modelKey = entry.modelKey;
        let targetHitl: ResolvedHitlConfig | undefined;

        if (entry.kind === 'ref') {
            const target = await resolveSubagentTarget(input.tenantDbName, input.projectId, entry);
            if (!target.ok) {
                logger.warn(target.message, { name: entry.name, agentKey: entry.agentKey, reason: target.reason });
                input.onWarning?.(target.message);
                continue;
            }
            systemPrompt = await resolveChildPrompt(input, entry, target);
            toolBindings = target.config.toolBindings;
            knowledgeSource = {
                knowledgeEngineKey: target.config.knowledgeEngineKey,
                knowledgeBindings: target.config.knowledgeBindings,
                knowledgeToolMode: target.config.knowledgeToolMode,
            };
            modelKey = entry.modelKey ?? target.config.modelKey;
            targetHitl = resolveHitlConfig(target.config.humanInTheLoop);
        }

        if (entry.kind !== 'ref') systemPrompt = await resolveChildPrompt(input, entry);

        // A child nobody gave instructions runs as its name and header say, which is what the SDK
        // would make of it too (older SDKs left it the generic base prompt), and the owner is told.
        if (!systemPrompt?.trim()) {
            systemPrompt = `You are ${entry.title || entry.name}. ${entry.header || entry.title || entry.name}`;
            input.onWarning?.(`Sub-agent "${entry.name}" has no instructions of its own${
                entry.kind === 'ref' ? ` ("${entry.agentKey}" has no system prompt, or its prompt could not be found)` : ''
            }, so it runs on its name and header alone.`);
        }

        const childTools: AgentSdkToolInterface[] = [];
        ({ knowledge: knowledgeSource, toolBindings } = filterChildSources(knowledgeSource, toolBindings, disabledServices));
        if (hasKnowledgeConfigured(knowledgeSource)) {
            const knowledge = await buildAgentKnowledgeTools(
                input.tenantDbName,
                input.tenantId,
                input.projectId,
                knowledgeSource,
                input.guard,
            );
            childTools.push(...knowledge.tools);
        }
        if (toolBindings && toolBindings.length > 0) {
            const bound = await buildBoundTools(
                input.tenantDbName,
                input.tenantId,
                input.projectId,
                toolBindings,
                input.createToolFn,
                input.zod,
                input.guard,
                input.runtimeContext,
                input.identity && entry.kind === 'ref' && entry.agentKey
                    ? { ...input.identity, agentKey: entry.agentKey }
                    : input.identity,
            );
            childTools.push(...bound.tools);
            cleanupTasks.push(...bound.cleanupTasks);
        }

        if (input.approvals && childTools.length > 0) {
            const { hitl, mode, run, allowedTools } = input.approvals;
            const sides: ChildApprovalSide[] = [{ hitl, mode }];
            if (targetHitl) sides.push({ hitl: targetHitl, mode: resolveHitlRunMode(targetHitl, run) });
            childTools.splice(0, childTools.length, ...gateChildTools(childTools, sides, allowedTools));
        }

        let childModel: unknown;
        let childTakesImages = input.modelTakesImages === true;
        if (modelKey) {
            const built = await buildSubagentModel(input.tenantDbName, input.tenantId, input.projectId, modelKey, input.spend, input.images, input.reasoning, input.caller);
            if (built.ok) {
                childModel = built.chatModel;
                // Its model is only wrapped to resolve image references when the run has image options.
                childTakesImages = built.takesImages && Boolean(input.images);
                models.push(built.model);
            } else {
                input.onWarning?.(`Sub-agent "${entry.name}" runs on this agent's model: ${built.message}.`);
            }
        }

        // Taken only now that the entry will be built: a reference that could not run must not
        // make a later, working one of the same name look like the duplicate.
        seen.add(entry.name);
        subagents.push({
            name: entry.name,
            ...(entry.title ? { title: entry.title } : {}),
            header: entry.header || entry.title || entry.name,
            systemPrompt,
            ...(childTools.length > 0
                ? { tools: input.toolMedia ? childTools.map((tool) => withToolMedia(tool, { ...input.toolMedia!, modelTakesImages: childTakesImages })) : childTools }
                : {}),
            ...(childModel ? { model: childModel } : {}),
            ...(entry.limits ? { limits: entry.limits } : {}),
            ...(entry.childContextPolicy ? { childContextPolicy: entry.childContextPolicy } : {}),
            ...(entry.outputSchema
                ? { outputSchema: jsonSchemaToZod(entry.outputSchema) }
                : {}),
            metadata: { kind: entry.kind, ...(entry.agentKey ? { agentKey: entry.agentKey } : {}) },
        });
    }

    return { subagents, cleanupTasks, models };
}

/**
 * The system prompt a sub-agent runs with, resolved the way its own agent's run
 * would resolve it. A `ref` entry that sets no prompt of its own runs the prompt
 * of the agent it points at: that agent's `promptKey` template, or its inline
 * text, rendered with ITS prompt variables (identity, defaults, and the delegating
 * run's values for the variables it declares). A prompt written in the delegating
 * agent's own config — an inline child's, or a `ref` entry's override — renders the
 * way that agent's own prompt does. Undefined when there is none.
 */
async function resolveChildPrompt(
    input: BuildSubagentsInput,
    entry: IAgentSubagent,
    target?: Extract<Awaited<ReturnType<typeof resolveSubagentTarget>>, { ok: true }>,
): Promise<string | undefined> {
    const { parent } = input.prompt;
    const authored = entry.systemPrompt?.trim() ? entry.systemPrompt : undefined;
    if (authored || !target) {
        if (!authored) return undefined;
        if (!shouldRenderInlinePrompt(parent.config, authored)) return authored;
        const rendered = renderPromptTemplate(authored, parent.variables);
        reportPromptVariables(rendered, { agentKey: input.caller?.agentKey ?? '' });
        return rendered.text;
    }
    const agentKey = entry.agentKey ?? '';
    return resolveAgentPrompt({
        db: input.db,
        projectId: input.projectId,
        agentKey,
        config: target.config,
        systemPrompt: target.config.systemPrompt,
        variables: buildPromptVariables({
            config: target.config,
            agentKey,
            agentName: target.agent.name,
            version: target.resolvedVersion,
            runtimeContext: input.runtimeContext,
            userId: input.prompt.userId,
            variables: delegatedVariableValues(target.config.variables, input.prompt.variables),
            variablesInPrompt: input.prompt.variablesInPrompt,
        }),
    });
}

/** What the cost estimator needs of a model: the names its requests are reported under, and its prices. */
type PricedModel = { key?: string; modelId?: string; pricing?: IModelPricing | null };

/**
 * Builds the gateway chat model for a sub-agent's model override. Answers why
 * when the key no longer resolves (or the model cannot be set up), which makes
 * the child fall back to the parent's model rather than failing the whole run;
 * the caller reports it.
 *
 * Like every agent model it is a call into the gateway (gatewayChatModel.ts), so the
 * model's own guardrails, cache, pool and routing apply to the child too, and its
 * usage row (`agent.subagent`) lands on ITS model.
 */
async function buildSubagentModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
    spend?: AgentSpendScope,
    images?: SessionImagesOptions,
    reasoning?: BuildSubagentsInput['reasoning'],
    caller?: AgentModelCaller,
): Promise<{ ok: true; chatModel: unknown; model: PricedModel; takesImages: boolean } | { ok: false; message: string }> {
    try {
        const model = await getModelByKey(tenantDbName, modelKey, projectId);
        if (!model || model.category !== 'llm') {
            logger.warn('Sub-agent model override is not a chat model of this project; falling back to parent model', { modelKey });
            return { ok: false, message: `model "${modelKey}" does not exist in this project or is not a chat model` };
        }
        const agentPick = agentReasoningForModel(reasoning?.config, modelKey);
        const chatModel = await buildGatewayChatModel({
            tenantDbName,
            tenantId,
            projectId,
            model,
            route: 'agent.subagent',
            ...(caller?.agentKey ? { agentKey: caller.agentKey } : {}),
            ...(caller?.sessionId ? { sessionId: caller.sessionId } : {}),
            ...(caller?.userId ? { userId: caller.userId } : {}),
            ...(agentPick ? { reasoning: agentPick } : {}),
            ...(reasoning?.request ? { requestReasoning: reasoning.request } : {}),
            ...(reasoning?.config && !agentShowsReasoning(reasoning.config) ? { showReasoning: false } : {}),
            ...(spend ? { onCost: agentSpendSettler(spend, model.key) } : {}),
        });
        // A sub-agent can be handed the parent's context, image references included.
        return {
            ok: true,
            chatModel: images ? withSessionImages(chatModel, images) : chatModel,
            model: { key: model.key, modelId: model.modelId, pricing: model.pricing },
            takesImages: resolveModelCapabilities(model).inputModalities.includes('image'),
        };
    } catch (error) {
        logger.warn('Sub-agent model override could not be built; falling back to parent model', {
            modelKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, message: `model "${modelKey}" could not be set up` };
    }
}

// ── Tool Bridge ─────────────────────────────────────────────────────

/**
 * Converts IAgentToolBinding entries into agent-sdk ToolInterface instances.
 * Supports two source types:
 *   - 'tool'  – unified tool system (OpenAPI / MCP sources)
 *   - 'mcp'   – legacy direct MCP server bindings (backward compat)
 *
 * Also returns trace `definitions` for the bound tools — the menu recorded on
 * each model-call event's `tool_definitions` section. `parameters` carries the
 * source JSON schema (action/MCP inputSchema), and the SDK binding is built
 * from that same schema (`toolInputSchemaToZod`), so the trace and the model
 * see one contract.
 *
 * ── WHERE `tool.pre` / `tool.post` FIRE, AND WHERE THEY MUST NOT ───────────
 * `guard` wraps the 'tool' and 'system' branches. It deliberately does NOT
 * wrap the 'mcp' branch: `executeMcpTool` routes to `executeMcpToolLocal`,
 * which fires both hooks itself around the dispatch
 * (`mcpService.ts` — `guardrail.beforeToolCall` / `guardrail.afterToolCall`,
 * bound to the SERVER's own guardrail via `resolveMcpGuardrailBinding`).
 * Wrapping here as well would evaluate every MCP call twice, write two
 * evaluation-log rows per hook, and bill the model-backed families twice — and
 * the second evaluation would carry a DIFFERENT tool name, since the MCP layer
 * names the call `<serverKey>/<toolName>` after resolving any rename override.
 * One call, one name, one evaluation.
 *
 * THE EXCEPTION is a server with NO binding at all (`resolveMcpGuardrailBinding`
 * answers `mode: 'off'`, the default for a server nobody configured): the MCP
 * layer then evaluates nothing, so the agent's own `tool.pre`/`tool.post`
 * bindings would be bypassed by the simple act of attaching such a server. For
 * that case — and only that case — the 'mcp' branch wraps the tool with `guard`
 * under the SAME canonical name the MCP layer would have used, so it is still
 * one call, one name, one evaluation. Which layer evaluates is decided per
 * server, never both.
 *
 * EXPORTED FOR TESTS — see `createAgentToolGuard`.
 */
export async function buildBoundTools(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    bindings: { source: string; sourceKey: string; toolNames: string[]; config?: Record<string, unknown> }[] | undefined,
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool,
    zod: typeof import('zod').z,
    guard: AgentToolGuard,
    runtimeContext?: AgentRuntimeContext,
    /** Who the run is for, as MCP servers set up for Console identity are told (default: from `runtimeContext`). */
    identity?: ConsoleIdentityCaller,
): Promise<{
    cleanupTasks: Array<() => Promise<void>>;
    tools: AgentSdkToolInterface[];
    definitions: TraceToolDefinition[];
}> {
    if (!bindings || bindings.length === 0) return { cleanupTasks: [], tools: [], definitions: [] };
    const mcpIdentity = identity ?? consoleIdentityCallerOf(runtimeContext, { projectId });

    const tools: AgentSdkToolInterface[] = [];
    const definitions: TraceToolDefinition[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];

    for (const binding of bindings) {
        if (binding.source === 'tool') {
            // ── Unified tool system ──────────────────────────────
            const toolRecord = await resolveAgentBindingTool(tenantDbName, binding.sourceKey, projectId);
            if (!toolRecord || toolRecord.status !== 'active') {
                logger.warn('Skipping inactive/missing tool', { key: binding.sourceKey });
                continue;
            }

            const toolRuntimeHeaders = resolveRuntimeHeaders(
                runtimeContext,
                'tool',
                toolRecord.key,
                runtimeHeaderPolicyFromMetadata(toolRecord.metadata),
            );
            const toolRuntimeAuth = describeRuntimeAuth(runtimeContext, toolRuntimeHeaders);
            const toolSecretValues = toolRequestSecretValues(toolRecord, toolRuntimeHeaders);

            for (const actionName of binding.toolNames) {
                const action = toolRecord.actions.find(
                    (a) => a.key === actionName || a.name === actionName,
                );
                if (!action) {
                    logger.warn('Tool action not found, skipping', {
                        tool: binding.sourceKey,
                        action: actionName,
                    });
                    continue;
                }

                const description = action.description || `Call ${action.name} on ${toolRecord.name}`;
                const log = (
                    status: 'success' | 'error',
                    latencyMs: number,
                    args: Record<string, unknown>,
                    response?: Record<string, unknown>,
                    error?: string,
                ) => logToolRequest(
                    tenantDbName, tenantId, toolRecord.projectId,
                    toolRecord.key, action.key, action.name,
                    status, latencyMs, args, response, error,
                    'agent', runtimeContext?.tokenId, toolRuntimeAuth, toolSecretValues,
                );
                const tool = createToolFn({
                    name: action.name,
                    description,
                    // The action's real input schema, not an empty passthrough —
                    // see toolInputSchemaToZod.
                    schema: toolInputSchemaToZod(action.inputSchema),
                    // The guard wraps the WHOLE executor, tool-request logging
                    // included, so a `tool.pre` redaction reaches the upstream
                    // call and the request log identically, and `tool.post`
                    // sees the exact string that will reach the model rather
                    // than the object graph behind it.
                    //
                    // A blocked call therefore writes NO tool-request log. That
                    // is deliberate: the log's status vocabulary is
                    // success | error, and recording a policy decision as an
                    // 'error' would corrupt this tool's failure rate. The
                    // guardrail evaluation log is where a block is recorded.
                    func: guard.protect(
                        {
                            name: agentToolPolicyName('tool', toolRecord.key, action.key),
                            requestedName: action.name,
                        },
                        async (args: Record<string, unknown>) => {
                            try {
                                const { result, latencyMs, isError } = await executeToolAction(
                                    toolRecord, action.key, args, toolRuntimeHeaders,
                                );
                                // An MCP `isError` result is a failed call: logged as one, the text still reaches the model.
                                log(
                                    isError ? 'error' : 'success', latencyMs, args,
                                    typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
                                    isError ? (typeof result === 'string' ? result : 'Tool reported an error') : undefined,
                                );
                                // A result with media stays an object: `withToolMedia` shows its images to the model.
                                if (isToolOutput(result)) return result;
                                return typeof result === 'string' ? result : JSON.stringify(result);
                            } catch (execError) {
                                const errorMessage = execError instanceof Error ? execError.message : 'Failed to execute tool action';
                                log('error', 0, args, undefined, errorMessage);
                                throw execError;
                            }
                        },
                    ),
                });
                tools.push(tool);
                definitions.push({ name: action.name, description, parameters: action.inputSchema });
            }
        } else if (binding.source === 'mcp') {
            // ── Legacy MCP server bindings ───────────────────────
            const server = await resolveAgentBindingMcpServer(tenantDbName, binding.sourceKey, projectId);
            if (!server || server.status !== 'active') {
                logger.warn('Skipping inactive/missing MCP server', { key: binding.sourceKey });
                continue;
            }

            const mcpRuntimeHeaders = resolveRuntimeHeaders(
                runtimeContext,
                'mcp',
                server.key,
                runtimeHeaderPolicyFromMetadata(server.metadata),
            );

            // WHO GUARDS THIS SERVER'S TOOLS. A server with its own binding is
            // guarded one layer down by `executeMcpToolLocal` (see the note on
            // this function), and wrapping it here too would double-evaluate.
            // A server with NO binding (`mode: 'off'` — the default for a server
            // an operator never configured) evaluates NOTHING down there, so the
            // agent's own `tool.pre`/`tool.post` bindings would be walked around
            // simply by attaching an MCP server: the model calls
            // `<server>/delete_records`, no hook fires, the allow-list is
            // bypassed and the log shows nothing. For that case the agent's
            // guard wraps the tool under the MCP CANONICAL spelling
            // `<serverKey>/<toolName>` — the name `mcpHook` would have used —
            // so a stored `tool_access` policy matches it the same way on
            // either layer. `guard` is the no-op when the agent binds nothing.
            const mcpBinding = resolveMcpGuardrailBinding(server);
            const guardAtAgent = mcpBinding.mode === 'off';

            for (const toolName of binding.toolNames) {
                const mcpToolDef = server.tools.find((t) => t.name === toolName);
                if (!mcpToolDef) {
                    logger.warn('MCP tool not found, skipping', {
                        server: binding.sourceKey,
                        tool: toolName,
                    });
                    continue;
                }
                if (!isMcpToolEnabled(server, toolName)) {
                    logger.warn('MCP tool disabled on server, skipping', {
                        server: binding.sourceKey,
                        tool: toolName,
                    });
                    continue;
                }

                const dispatch = async (args: Record<string, unknown>) => {
                    const { result } = await executeMcpTool(server, toolName, args, mcpRuntimeHeaders, mcpIdentity);
                    if (isToolOutput(result)) return result;
                    return typeof result === 'string' ? result : JSON.stringify(result);
                };
                const description = mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`;
                const tool = createToolFn({
                    name: mcpToolDef.name,
                    description,
                    schema: toolInputSchemaToZod(mcpToolDef.inputSchema),
                    // Wrapped in `guard` ONLY when the server has no binding of
                    // its own; otherwise `executeMcpTool` -> `executeMcpToolLocal`
                    // already fires `tool.pre` and `tool.post` around the dispatch
                    // and a second wrap would double-evaluate. See `guardAtAgent`.
                    func: guardAtAgent
                        ? guard.protect(
                            { name: `${server.key}/${toolName}`, requestedName: mcpToolDef.name },
                            dispatch,
                        )
                        : dispatch,
                });
                tools.push(tool);
                definitions.push({ name: mcpToolDef.name, description, parameters: mcpToolDef.inputSchema });
            }
        } else if (binding.source === 'system' && binding.sourceKey === 'browser_use') {
            // ── System tool: Browser Use ───────────────────────
            const browserId = typeof binding.config?.browserId === 'string'
                ? (binding.config.browserId as string)
                : undefined;
            if (!browserId) {
                logger.warn('browser_use binding missing browserId, skipping');
                continue;
            }
            try {
                const browser = await resolveBrowser(
                    { tenantDbName, tenantId, projectId },
                    browserId,
                );
                if (!browser || browser.status !== 'active') {
                    logger.warn('browser_use binding refers to inactive/missing browser', { browserId });
                    continue;
                }
                const session = await createBrowserSession(
                    { tenantDbName, tenantId, projectId },
                    {
                        browserId: String(browser._id ?? ''),
                        createdBy: 'agent-runtime',
                        metadata: { source: 'agent-system-tool', binding: 'browser_use' },
                    },
                );
                const browserTools = adoptBuiltTools(guard, 'browser', buildBrowserAgentTools({
                    tenantDbName,
                    tenantId,
                    projectId,
                    sessionKey: session.sessionKey,
                    createdBy: 'agent-runtime',
                }));
                tools.push(...browserTools.tools);
                definitions.push(...browserTools.definitions);
                cleanupTasks.push(async () => {
                    await closeBrowserSession(
                        { tenantDbName, tenantId, projectId },
                        session.sessionKey,
                    ).catch(() => undefined);
                });
            } catch (err) {
                logger.error('Failed to bind browser_use system tool', {
                    browserId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        } else if (binding.source === 'system' && binding.sourceKey === 'web_search') {
            // ── System tool: Web Search ─────────────────────────
            // No session to open ahead of time — `runWebSearch` resolves the
            // instance (pinned or the project's single active one) per call.
            const providerKey = typeof binding.config?.providerKey === 'string'
                ? (binding.config.providerKey as string)
                : undefined;
            const webSearchTools = adoptBuiltTools(guard, 'websearch', buildWebSearchAgentTools({
                tenantDbName,
                tenantId,
                projectId,
                providerKey,
            }));
            tools.push(...webSearchTools.tools);
            definitions.push(...webSearchTools.definitions);
        } else if (binding.source === 'system' && binding.sourceKey === 'crawler') {
            // ── System tool: Web Fetch (single page through a crawler) ──
            // Stateless like web_search; the crawler is loaded per call so an
            // edit or deactivation takes effect without rebinding.
            const crawlerKey = typeof binding.config?.crawlerKey === 'string'
                ? (binding.config.crawlerKey as string)
                : undefined;
            if (!crawlerKey) {
                logger.warn('crawler binding missing crawlerKey, skipping');
                continue;
            }
            const webFetchTools = adoptBuiltTools(guard, 'crawler', buildWebFetchAgentTools({
                tenantDbName,
                tenantId,
                projectId,
                crawlerKey,
            }));
            tools.push(...webFetchTools.tools);
            definitions.push(...webFetchTools.definitions);
        }
    }

    return { cleanupTasks, tools, definitions };
}

/**
 * Guards system tools built elsewhere (browser, web search, web fetch) after the fact,
 * under `agent.<surface>.<toolName>`. The browser tools are the agent's only
 * tools that navigate and type into a live browser, i.e. the surface
 * `tool_access.sideEffects` most wants to name.
 *
 * These tools carry zod schemas only, so their trace entries record name +
 * description and no parameters.
 */
function adoptBuiltTools(
    guard: AgentToolGuard,
    surface: 'browser' | 'websearch' | 'crawler',
    built: readonly unknown[],
): { tools: AgentSdkToolInterface[]; definitions: TraceToolDefinition[] } {
    const tools = (built as AgentSdkToolInterface[]).map((tool) => protectBuiltTool(
        guard,
        { name: agentToolPolicyName(surface, tool.name), requestedName: tool.name },
        tool,
    ));
    const definitions = tools.map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description ? { description: tool.description } : {}),
    }));
    return { tools, definitions };
}

async function runBoundToolCleanup(
    cleanupTasks: Array<() => Promise<void>>,
    context: { agentKey: string; mode: 'chat' | 'playground' },
): Promise<void> {
    if (cleanupTasks.length === 0) return;

    const results = await Promise.allSettled(cleanupTasks.map((task) => task()));
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures > 0) {
        logger.warn('Bound tool cleanup completed with failures', {
            agentKey: context.agentKey,
            failures,
            mode: context.mode,
        });
    }
}

// ── Internal Tracing Sink ────────────────────────────────────────────

/**
 * Raises a trace session's token totals to the turn's usage. The SDK sums the
 * trace's own model-call events, which leave out the calls a sub-agent made
 * (they sit in the turn's usage ledger, tagged `subagent`, but add no trace
 * steps), so a turn that delegated would otherwise show less than it used.
 * Totals only grow here: a session already at or above the turn's usage is kept.
 */
export async function reconcileTraceTotals(
    tenantDbName: string,
    projectId: string,
    sessionId: string | undefined,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } | undefined,
): Promise<void> {
    if (!sessionId || !usage) return;
    try {
        const db = await getDatabase();
        await db.switchToTenant(tenantDbName);
        const session = await db.findAgentTracingSessionById(sessionId, projectId);
        if (!session) return;
        const patch: Partial<IAgentTracingSession> = {};
        const fields = [
            ['totalInputTokens', usage.inputTokens],
            ['totalOutputTokens', usage.outputTokens],
            ['totalCachedInputTokens', usage.cachedInputTokens],
        ] as const;
        for (const [field, value] of fields) {
            if (typeof value === 'number' && Number.isFinite(value) && value > (session[field] ?? 0)) patch[field] = Math.ceil(value);
        }
        if (Object.keys(patch).length === 0) return;
        await db.updateAgentTracingSession(sessionId, patch, projectId);
    } catch (error) {
        logger.warn('Could not reconcile the trace totals with the turn usage', { sessionId, error: String(error) });
    }
}

/**
 * Marks a trace session failed for a reason the SDK could not know: it closed
 * the session as `paused`, but the console could not keep what the pause needs
 * (the state was too large to store), so the run is over. Without this the
 * session stays `paused` forever in the tracing views. Best-effort.
 */
export async function markTraceSessionFailed(
    tenantDbName: string,
    projectId: string,
    sessionId: string | undefined,
    detail: string,
): Promise<void> {
    if (!sessionId) return;
    try {
        const db = await getDatabase();
        await db.switchToTenant(tenantDbName);
        const session = await db.findAgentTracingSessionById(sessionId, projectId);
        if (!session) return;
        await db.updateAgentTracingSession(sessionId, {
            status: 'error',
            statusExplicit: true,
            errors: [
                ...(session.errors ?? []),
                { eventId: 'console', type: 'session', message: detail, timestamp: new Date().toISOString() },
            ],
        }, projectId);
    } catch (error) {
        logger.warn('Could not mark the trace session failed', { sessionId, error: String(error) });
    }
}

/**
 * Creates a customSink that saves trace sessions directly to the database,
 * bypassing the HTTP tracing endpoint and its API-token authentication.
 * This is used for internal agent executions (dashboard playground & client API chat).
 *
 * `toolDefinitions` is the tool menu bound for THIS invocation: every model-
 * call event ('ai_call') gets a `tool_definitions` section carrying it.
 * Capture is per event, never per session — the SDK binds one menu per
 * invoke, but a session/thread spans invocations whose menus can differ, so
 * each call must record the menu it actually saw.
 *
 * Exported so the ingest tests can drive `onSession` directly.
 */
export async function createInternalTracingSink(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    toolDefinitions?: TraceToolDefinition[],
    /** Stable key of the hosted agent, stamped into the session `metadata.agentKey` (the session's `agentName` is the display name). */
    agentKey?: string,
    /** Told the id of each session the sink saves, so the turn can reconcile its totals afterwards. */
    onSessionSaved?: (sessionId: string) => void,
    /** SDK approval / question id → the sub-agent it came from, learned from the child's forwarded events. */
    approvalSubagents: ReadonlyMap<string, string> = new Map(),
) {
    const { customSink } = await import('@cognipeer/agent-sdk');
    const toolDefinitionsSection = toolDefinitions && toolDefinitions.length > 0
        ? buildToolDefinitionsSection(toolDefinitions)
        : undefined;

    return customSink({
        onSession: async (session: InternalTraceSession) => {
            try {
                const db = await getDatabase();
                await db.switchToTenant(tenantDbName);

                // A run that paused (tool approval, question, client tool)
                // and resumed sends its session in parts: the later parts
                // carry only their own events and are APPENDED, while the
                // session-level totals they carry already cover every part.
                const continuation = readTraceContinuationMarker(session);
                const existing = await db.findAgentTracingSessionById(session.sessionId, projectId);
                const stored = continuation && existing
                    ? await db.listAgentTracingEvents(session.sessionId, projectId, { projection: { sequence: 1 } })
                    : [];
                const storedSequences = new Set(stored.map((event) => event.sequence));
                const allEvents = Array.isArray(session.events) ? session.events : [];
                // A retried part must not insert its events twice.
                const events = continuation && existing
                    ? allEvents.filter((event) => !storedSequences.has(event?.sequence ?? 0))
                    : allEvents;

                // Extract models and tools used, plus the diagnostic rollups
                // (`totalReasoningTokens` / `truncatedEvents`) mirroring what
                // `applyAgentTracingSessionEvent` would accumulate incrementally
                // — this sink instead computes the whole session doc in one
                // pass, so the sums are taken up front over `events`.
                const modelsUsed = new Set<string>();
                const toolsUsed = new Set<string>();
                let totalReasoningTokens = 0;
                let truncatedEvents = 0;
                for (const event of events) {
                    if (event?.model) modelsUsed.add(event.model);
                    if (event?.toolName) toolsUsed.add(event.toolName);
                    if (event?.actor?.scope === 'tool' && event?.actor?.name) {
                        toolsUsed.add(event.actor.name);
                    }
                    const diagnostics = extractInternalTraceDiagnostics(event);
                    if (diagnostics.reasoningTokens !== undefined) {
                        totalReasoningTokens += diagnostics.reasoningTokens;
                    }
                    if (isTruncatedFinishReason(diagnostics.finishReason)) {
                        truncatedEvents += 1;
                    }
                }
                if (session?.agent?.model) modelsUsed.add(session.agent.model);

                // Same health rule as the HTTP ingest: the SDK's own status stays authoritative; counters and a
                // derived status fill in when it is absent. SDK sink failures are not run failures.
                const errorCounts = countTraceErrors(events);
                const sessionErrors = session.errors ?? [];
                const nonSinkErrors = sessionErrors.filter((error) => (error as Record<string, unknown> | null)?.type !== 'sink').length;
                const sessionStatus = deriveSessionStatus({
                    clientStatus: session.status,
                    errorEvents: errorCounts.errorEvents,
                    nonSinkErrors,
                    ended: String(session.status ?? '').trim().toLowerCase() !== 'in_progress',
                });
                // A turn the caller stopped ends its session as the SDK sees an ordinary end ("success");
                // the sink runs inside the invoke, so the turn's own signal says it was cancelled. A run
                // that failed keeps its error. What the aborted model call used is only known when the
                // gateway settled it (runUsage); the trace's token totals are the SDK's, so they may miss it.
                const cancelledByCaller = currentTurnSignal()?.aborted === true
                    && sessionStatus !== 'error' && sessionStatus !== 'paused' && sessionStatus !== 'in_progress';

                const agentTriggerId = (session.metadata as Record<string, unknown> | undefined)?.source === 'trigger'
                    && typeof (session.metadata as Record<string, unknown>).triggerId === 'string';
                const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
                    sessionId: session.sessionId,
                    traceId: session.traceId,
                    rootSpanId: session.rootSpanId,
                    threadId: session.threadId,
                    tenantId,
                    projectId,
                    source: agentTriggerId ? 'trigger' : 'custom',
                    agent: session.agent ?? {},
                    agentName: session.agent?.name ?? undefined,
                    agentVersion: session.agent?.version ?? undefined,
                    agentModel: session.agent?.model ?? undefined,
                    config: session.config ?? {},
                    metadata: { ...(session.metadata ?? {}), ...(agentKey ? { agentKey } : {}) },
                    summary: session.summary ?? {},
                    status: cancelledByCaller ? 'cancelled' : sessionStatus,
                    // An SDK-supplied status is never overridden by a late error event (only a derived one is).
                    statusExplicit: cancelledByCaller || isExplicitClientStatus(session.status),
                    startedAt: session.startedAt ? new Date(session.startedAt) : new Date(),
                    endedAt: session.endedAt ? new Date(session.endedAt) : undefined,
                    durationMs: session.durationMs ?? undefined,
                    errorEvents: errorCounts.errorEvents,
                    toolErrors: errorCounts.toolErrors,
                    aiErrors: errorCounts.aiErrors,
                    errors: sessionErrors,
                    modelsUsed: Array.from(modelsUsed),
                    toolsUsed: Array.from(toolsUsed),
                    eventCounts: session.summary?.eventCounts ?? {},
                    totalEvents: events.length,
                    totalInputTokens: session.summary?.totalInputTokens ?? 0,
                    totalOutputTokens: session.summary?.totalOutputTokens ?? 0,
                    totalCachedInputTokens: session.summary?.totalCachedInputTokens ?? 0,
                    totalReasoningTokens,
                    truncatedEvents,
                    totalBytesIn: session.summary?.totalBytesIn ?? undefined,
                    totalBytesOut: session.summary?.totalBytesOut ?? undefined,
                };

                if (continuation && existing) {
                    mergeContinuedSessionDoc(sessionDoc, existing, {
                        storedEvents: stored.length,
                        newEvents: events.length,
                    });
                }

                onSessionSaved?.(session.sessionId);
                // Upsert session
                if (existing) {
                    await db.updateAgentTracingSession(session.sessionId, sessionDoc, projectId);
                } else {
                    const attribution = recordTracingSessionCreated({
                        tenantDbName,
                        tenantId,
                        projectId,
                        agentName: sessionDoc.agentName,
                        metadata: sessionDoc.metadata,
                    });
                    await db.createAgentTracingSession({
                        ...sessionDoc,
                        userId: attribution.userId,
                        apiTokenId: attribution.apiTokenId,
                        actorType: attribution.actorType,
                    });
                }

                // Replace events — or, for a continued session, add this part's.
                // A replaced post's previous events are subtracted from the health
                // counters; an appended part only adds its own events.
                const appending = Boolean(continuation && existing);
                const previousEvents = existing && !appending
                    ? await db.listAgentTracingEvents(session.sessionId, projectId, { projection: { sections: 0, metadata: 0 } })
                    : [];
                if (!appending) {
                    await db.deleteAgentTracingEvents(session.sessionId, projectId);
                }
                const eventDocs: Array<Omit<IAgentTracingEvent, '_id' | 'createdAt'>> = [];
                for (const event of events) {
                    let sections = (Array.isArray(event?.sections)
                        ? event.sections
                        : Array.isArray(event?.data?.sections)
                            ? event.data.sections
                            : []) as Array<Record<string, unknown>>;

                    // Attach the bound tool menu to each model-call event
                    // (skipped if the SDK ever emits its own section).
                    if (
                        toolDefinitionsSection
                        && event.type === 'ai_call'
                        && !sections.some((section) => section?.kind === TOOL_DEFINITIONS_SECTION_KIND)
                    ) {
                        sections = [...sections, toolDefinitionsSection];
                    }
                    // Same cap/shape treatment the HTTP ingest gives an SDK
                    // sender's own sections. The two paths write to the same
                    // collection and are read by the same UI, so a section
                    // shaped one way here and another way there is a bug
                    // waiting to be found by whoever reads a mixed session.
                    sections = normalizeSectionListResponseFormat(sections);

                    const usage = event?.usage || event?.metadata?.usage || {};
                        const inputTokens = toOptionalNumber(
                            event?.inputTokens ?? usage?.inputTokens ?? usage?.input_tokens,
                        );
                        const outputTokens = toOptionalNumber(
                            event?.outputTokens ?? usage?.outputTokens ?? usage?.output_tokens,
                        );
                        const cachedInputTokens = toOptionalNumber(
                            event?.cachedInputTokens ??
                            usage?.cachedInputTokens ??
                            usage?.cached_input_tokens ??
                            usage?.cacheReadInputTokens ??
                            usage?.cache_read_input_tokens,
                        );
                        const diagnostics = extractInternalTraceDiagnostics(event);
                        // Strip the keys `extractInternalTraceDiagnostics` already
                        // consumed so the same value never lands in both the
                        // column and the metadata blob.
                        const restMetadata = { ...(event.metadata ?? {}) } as Record<string, unknown>;
                        delete restMetadata.finishReason;
                        delete restMetadata.stop_reason;
                        delete restMetadata.reasoningTokens;

                    const named = nameSubagentOnApprovalStep(
                        { type: event.type, label: event.label, sequence: event.sequence, metadata: restMetadata, sections },
                        approvalSubagents,
                    );
                    const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
                        sessionId: session.sessionId,
                        traceId: event.traceId ?? undefined,
                        spanId: event.spanId ?? undefined,
                        parentSpanId: event.parentSpanId ?? undefined,
                        tenantId,
                        projectId,
                        id: event.id ?? undefined,
                        type: event.type ?? undefined,
                        label: named.label ?? undefined,
                        sequence: event.sequence ?? 0,
                        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
                        status: event.status ?? undefined,
                        actor: event.actor ?? {},
                        // `finishReason` / `reasoningTokens` are real columns now
                        // (see `extractInternalTraceDiagnostics`), mirroring the
                        // HTTP ingest's sibling `extractTraceDiagnostics`
                        // (client-tracing.ts). Without this an agent hosted BY
                        // the console would be the only source missing them,
                        // which is the worst place for a gap: it is the path we
                        // control end to end.
                        metadata: named.metadata,
                        sections,
                        modelNames: event.modelNames ?? [],
                        model: event.model ?? undefined,
                        error: event.error ?? undefined,
                        durationMs: event.durationMs ?? undefined,
                        actorName: event.actor?.name ?? undefined,
                        actorRole: event.actor?.role ?? event.actor?.scope ?? undefined,
                        toolName:
                            event.toolName ??
                            (event.actor?.scope === 'tool' ? event.actor?.name : undefined),
                        toolExecutionId: event.toolExecutionId ?? undefined,
                        inputTokens,
                        outputTokens,
                        cachedInputTokens,
                        totalTokens: event.totalTokens ?? undefined,
                        finishReason: diagnostics.finishReason,
                        reasoningTokens: diagnostics.reasoningTokens,
                        bytesIn: event.bytesIn ?? undefined,
                        bytesOut: event.bytesOut ?? undefined,
                        requestBytes: event.requestBytes ?? undefined,
                        responseBytes: event.responseBytes ?? undefined,
                    };

                    await db.createAgentTracingEvent(eventDoc);
                    eventDocs.push(eventDoc);
                }

                // Hosted runs feed agent health only: their model and tool calls are counted where they execute.
                await recordTraceEventMetrics({
                    tenantDbName,
                    tenantId,
                    projectId,
                    agentName: sessionDoc.agentName,
                    events: eventDocs,
                    previousEvents,
                    source: 'hosted',
                });
                if (isTerminalSessionStatus(sessionDoc.status)) {
                    await recordAgentSessionOutcome({
                        tenantDbName,
                        tenantId,
                        projectId,
                        session: sessionDoc,
                        previousOutcome: existing?.metricsOutcome,
                        source: 'hosted',
                        events: eventDocs,
                    });
                }

                logger.info('Internal tracing session saved', {
                    sessionId: session.sessionId,
                    agentName: session.agent?.name,
                    eventsCount: events.length,
                });
            } catch (err) {
                logger.error('Failed to save internal tracing session', { error: err });
            }
        },
    });
}

/**
 * Pull the SDK's top-level diagnostic fields off a raw trace event so they can
 * be persisted as real `finishReason` / `reasoningTokens` columns instead of
 * being buried in the `metadata` JSON blob.
 *
 * This is the internal-sink twin of the HTTP ingest's `extractTraceDiagnostics`
 * (`src/server/api/plugins/client-tracing.ts`) — both paths write to the same
 * `agentTracingEvents` table read by the same UI, so they must stay in
 * lockstep: a value read from `finishReason` here but from `metadata` there
 * (or vice versa) would make one trace source silently poorer than the other.
 *
 * `finishReason` explains a truncated answer (`length` is the usual cause of
 * unparseable JSON); `reasoningTokens` is a SUBSET of `outputTokens`, recorded
 * for attribution and deliberately never added to the bill.
 */
export function extractInternalTraceDiagnostics(event: InternalTraceEvent): {
    finishReason?: string;
    reasoningTokens?: number;
} {
    const metadata = event.metadata ?? {};
    const finishReason = normalizeFinishReason(
        event.finishReason ?? metadata.finishReason ?? metadata.stop_reason,
    );
    const reasoningTokens = toOptionalNumber(
        event.reasoningTokens
        ?? event.usage?.reasoningTokens
        ?? event.usage?.reasoning_tokens
        ?? metadata.reasoningTokens,
    );
    return {
        finishReason,
        reasoningTokens: reasoningTokens !== undefined && reasoningTokens > 0 ? reasoningTokens : undefined,
    };
}

    function toOptionalNumber(value: unknown): number | undefined {
        if (value === null || value === undefined || value === '') {
            return undefined;
        }

        const normalized = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(normalized) ? normalized : undefined;
    }

// ── Utility ──────────────────────────────────────────────────────────

function generateAgentKey(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).substring(2, 8);
    return `${slug}-${suffix}`;
}

// ── Agent CRUD ───────────────────────────────────────────────────────

export async function createAgentRecord(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    data: {
        name: string;
        description?: string;
        config: IAgent['config'];
        status?: IAgent['status'];
        /** A key chosen by the caller (checked for uniqueness below). Default: the name as a slug plus a random suffix. */
        key?: string;
        /** Where the agent came from (`metadata.template` for an agent made from a template). */
        metadata?: IAgent['metadata'];
    },
): Promise<IAgent> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = data.key ?? generateAgentKey(data.name);

    // Verify uniqueness
    const existing = await db.findAgentByKey(key, projectId);
    if (existing) {
        throw new Error(`Agent key "${key}" already exists`);
    }

    const agent = await db.createAgent({
        tenantId,
        projectId,
        key,
        name: data.name,
        description: data.description,
        // Sandbox secrets are sealed here, the one write path every creator
        // (dashboard, client API) goes through.
        config: sealAgentConfigSecrets(migrateAgentReasoning(data.config), undefined),
        status: data.status || 'active',
        ...(data.metadata ? { metadata: data.metadata } : {}),
        createdBy: userId,
    });

    logger.info('Agent created', { key, projectId });
    return agent;
}

export async function updateAgentRecord(
    tenantDbName: string,
    agentId: string,
    data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
    userId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // Old Advanced-tab reasoning moves next to the model on every save.
    if (data.config) data = { ...data, config: migrateAgentReasoning(data.config) };
    if (data.config?.sandbox || data.config?.callback !== undefined) {
        // `config` replaces the stored one wholesale; masked secret values
        // must resolve against what is stored, not be saved as the mask —
        // and a plaintext secret (sandbox secrets, the callback secret) must
        // be sealed before it is written. A callback sent without a URL (or
        // as `null`) is the way to remove it: the field is dropped here.
        const current = await db.findAgentById(agentId);
        data = { ...data, config: sealAgentConfigSecrets(data.config, current?.config) };
    } else if (data.config) {
        // The removed Execution settings a stored config may still carry go on save.
        data = { ...data, config: stripLegacyExecutionConfig(data.config) };
    }
    return db.updateAgent(agentId, { ...data, updatedBy: userId });
}

export async function deleteAgentRecord(
    tenantDbName: string,
    agentId: string,
): Promise<boolean> {
    return runWithTenantScope(tenantDbName, async (db) => {
        const agent = await db.findAgentById(agentId);
        const deleted = await db.deleteAgent(agentId);
        // Its triggers (and their webhook delivery logs) go with it: nothing could fire them any more.
        if (deleted && agent) {
            const triggers = await db.listAgentTriggers({ tenantId: agent.tenantId, projectId: agent.projectId, agentKey: agent.key });
            for (const trigger of triggers) await db.deleteAgentTriggerDeliveries(String(trigger._id));
            await db.deleteAgentTriggersForAgent(agent.tenantId, agent.projectId, agent.key);
        }
        return deleted;
    });
}

export async function getAgentById(
    tenantDbName: string,
    agentId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return withMigratedReasoning(await db.findAgentById(agentId));
}

export async function getAgentByKey(
    tenantDbName: string,
    key: string,
    projectId?: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return withMigratedReasoning(await db.findAgentByKey(key, projectId));
}

/** Read-side half of the `runtime.reasoning` migration (the save side is in create/update). */
function withMigratedReasoning(agent: IAgent | null): IAgent | null {
    if (!agent?.config) return agent;
    const config = migrateAgentReasoning(agent.config);
    return config === agent.config ? agent : { ...agent, config };
}

export async function listAgents(
    tenantDbName: string,
    filters?: { projectId?: string; status?: IAgent['status']; search?: string },
): Promise<IAgent[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgents(filters);
}

// ── Agent Publish & Versioning ───────────────────────────────────────

/**
 * Publishes the current agent config as a new immutable version.
 * After publishing, API/SDK calls will use this version by default.
 */
export async function publishAgent(
    tenantDbName: string,
    agentId: string,
    userId: string,
    changelog?: string,
): Promise<IAgentVersion> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentById(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" not found`);

    // Keep versioning monotonic even if agent.latestVersion was not persisted
    // correctly in older SQLite writes.
    const latestPublishedSnapshot = await db.findLatestAgentVersion(String(agent._id));
    const latestKnownVersion = Math.max(
      agent.latestVersion ?? 0,
      agent.publishedVersion ?? 0,
      latestPublishedSnapshot?.version ?? 0,
    );
    const nextVersion = latestKnownVersion + 1;

    // An imported agent waits as a draft until someone reviews and publishes it, so
    // publishing turns it on. An agent someone switched off stays inactive.
    const status = agent.status === 'draft' ? 'active' : agent.status;

    const version = await db.createAgentVersion({
        tenantId: agent.tenantId,
        projectId: agent.projectId,
        agentId: String(agent._id),
        agentKey: agent.key,
        version: nextVersion,
        snapshot: {
            name: agent.name,
            description: agent.description,
            config: agent.config,
            status,
        },
        changelog,
        publishedBy: userId,
    });

    // Update agent with latest published version
    await db.updateAgent(agentId, {
        publishedVersion: nextVersion,
        latestVersion: nextVersion,
        ...(status !== agent.status ? { status } : {}),
        updatedBy: userId,
    });

    logger.info('Agent published', {
        agentId,
        agentKey: agent.key,
        version: nextVersion,
    });

    return version;
}

export async function getAgentVersion(
    tenantDbName: string,
    agentId: string,
    version: number,
): Promise<IAgentVersion | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentVersion(agentId, version);
}

export async function listAgentVersions(
    tenantDbName: string,
    agentId: string,
    options?: { limit?: number; skip?: number },
): Promise<{ versions: IAgentVersion[]; total: number }> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgentVersions(agentId, options);
}

// Lives in agentConfigResolution.ts (the spend pre-flight and the sub-agent roster need it without
// importing this module); the name stays here for every caller.
export { resolveAgentConfig } from './agentConfigResolution';

/**
 * Which version of an agent a realtime (voice) session should run, as the
 * `version` to hand `executePlaygroundChat` — undefined means the draft.
 *
 * Realtime presets default to `'published'`: a phone line is production
 * traffic and must not change under it each time someone edits the draft.
 * With nothing published (or the snapshot missing) it falls back to the draft,
 * the same rule `resolveAgentConfig` applies to API calls. An unknown agent
 * resolves to undefined rather than throwing: the run that follows fails with
 * the proper "not found" error on the path that already reports it.
 */
export async function resolveAgentVoiceVersion(params: {
    tenantDbName: string;
    projectId?: string;
    agentKey: string;
    prefer: 'published' | 'draft';
}): Promise<number | undefined> {
    if (params.prefer === 'draft') return undefined;
    const db = await getDatabase();
    await db.switchToTenant(params.tenantDbName);
    const agent = await db.findAgentByKey(params.agentKey, params.projectId);
    if (!agent) {
        logger.warn('Voice version lookup: agent not found', { agentKey: params.agentKey });
        return undefined;
    }
    if (!agent.publishedVersion) return undefined;
    const snapshot = await db.findAgentVersion(String(agent._id), agent.publishedVersion);
    return snapshot ? snapshot.version : undefined;
}

// ── Model connection check ───────────────────────────────────────────

export interface AgentModelCheckResult {
    ok: boolean;
    latencyMs: number;
    /** Set when the check failed — see `classifyAgentRunError`. */
    error?: { message: string; type: string; code?: string | null };
}

/**
 * The chat model an agent run (or the model check, or a title) talks to: an
 * agent-sdk chat model whose every call is a call into the gateway
 * (gatewayChatModel.ts) - so whatever is configured on the Model Hub record applies
 * to the agent too. A Dynamic LLM is no different: the gateway routes it per call.
 */
export async function buildAgentChatModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
    overrides: Record<string, unknown> = {},
    /** What the agent selected for this model (wins over everything). */
    reasoning?: NativeAgentReasoning,
    /** What the API request asked for (lowest rung; see agentReasoning.ts). */
    requestReasoning?: NativeAgentReasoning,
    /** What this call is for and who it is made for: the usage row's route and attribution, spend, routing. */
    call: AgentModelCall = {},
) {
    const model = await getModelByKey(tenantDbName, modelKey, projectId);
    if (!model) throw new Error(`Model "${modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    // Top P, Max Tokens, `unsupportedParams` and `requestDefaults` take effect inside
    // the gateway, exactly as for any other caller of the model.
    const passthrough: Record<string, unknown> = {};
    for (const key of ['temperature', 'top_p', 'max_tokens'] as const) {
        if (overrides[key] !== undefined) passthrough[key] = overrides[key];
    }
    const chatModel = await buildGatewayChatModel({
        tenantDbName,
        tenantId,
        projectId,
        model,
        overrides: passthrough,
        ...(reasoning ? { reasoning } : {}),
        ...(requestReasoning ? { requestReasoning } : {}),
        ...call,
    });
    return { model, chatModel };
}

/** The usage-row side of `buildAgentChatModel`. */
export type AgentModelCall = AgentModelCaller & Pick<Parameters<typeof buildGatewayChatModel>[0], 'route' | 'purpose' | 'showReasoning' | 'onReasoning' | 'onCost' | 'onRouted' | 'maxTotalOutputTokens'>;

/**
 * One tiny completion through exactly the path an agent run uses (the model's
 * provider runtime and invocation settings), so a wrong API key or a deleted
 * deployment shows up on the Configure page — not as an agent that "doesn't
 * answer" in its first session.
 */
export async function checkAgentModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
): Promise<AgentModelCheckResult> {
    const startedAt = Date.now();
    try {
        const { model, chatModel } = await buildAgentChatModel(
            tenantDbName, tenantId, projectId, modelKey, {}, undefined, undefined,
            { route: 'agent.check', purpose: 'model-check' },
        );
        await chatModel
            .invoke([{ role: 'user', content: 'Reply with the single word OK.' }])
            .catch((error: unknown) => {
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            });
        return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
        logger.info('Agent model check failed', {
            modelKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return { ok: false, latencyMs: Date.now() - startedAt, error: classifyAgentRunError(error, { exposeInternal: true }).error };
    }
}

// ── Conversation CRUD ────────────────────────────────────────────────

/**
 * Where a conversation came from, stored as `metadata.source`. Only
 * `console` sessions — the ones a person started from the dashboard to try the
 * agent — can be continued from the UI; the rest are real traffic (or a
 * run's own bookkeeping) and are shown read-only. Records written before this
 * existed carry no source. `portal` is end-user traffic through an enterprise
 * portal page (/p/<key>): real usage, so read-only in the Studio like the rest.
 */
export type AgentConversationSource = 'console' | 'api' | 'a2a' | 'trigger' | 'evaluation' | 'redteam' | 'portal';

export async function createConversation(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    agentKey: string,
    title?: string,
    /** Session-level context — applied to every turn, see `executePlaygroundChatLocal`. */
    metadata?: Record<string, unknown>,
    /**
     * The session's spend budget. Absent = the agent's own default
     * (`config.budget`); `null` = none, whatever the agent's default.
     */
    budget?: IAgentSessionBudget | null,
): Promise<IAgentConversation> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const sessionBudget = budget === undefined
        ? agentSessionBudget((await db.findAgentByKey(agentKey, projectId))?.config)
        : budget ?? undefined;

    return db.createAgentConversation({
        tenantId,
        projectId,
        agentKey,
        title: title || 'New conversation',
        messages: [],
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(sessionBudget ? { budget: sessionBudget, spentUsd: 0 } : {}),
        createdBy: userId,
    });
}

export async function getConversationById(
    tenantDbName: string,
    conversationId: string,
): Promise<IAgentConversation | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    const conversation = await db.findAgentConversationById(conversationId);
    // A "running" session whose turn died (process crash) reads as ended.
    return conversation ? withSessionSpend(await normalizeStaleRunningStatus(db, conversation)) : null;
}

export async function listConversations(
    tenantDbName: string,
    agentKey: string,
    filters?: { projectId?: string; limit?: number; skip?: number; createdBy?: string },
): Promise<IAgentConversation[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return normalizeStaleRunningStatuses(db, await db.listAgentConversations(agentKey, filters));
}

export async function deleteConversation(
    tenantDbName: string,
    conversationId: string,
): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    // A persistent agent sandbox belongs to its conversation and goes with it.
    const conversation = await db.findAgentConversationById(conversationId);
    if (conversation?.metadata?.sandbox) {
        await destroyConversationSandbox({ tenantDbName, tenantId: conversation.tenantId, conversation });
    }
    // So do the files attached to it (object, markdown and row).
    if (conversation) await deleteConversationFiles(tenantDbName, conversation);
    return db.deleteAgentConversation(conversationId);
}

// ── Agent Chat Execution ─────────────────────────────────────────────

/**
 * Shared mutable reference threaded through `executeAgentChatLocal` so a
 * deadline (synchronous ceiling, §5) or an asynchronously-flipped cancel flag
 * (background mode, §7 step 6) can stop a turn's outcome from being
 * persisted — WITHOUT waiting for `sdkAgent.invoke()` itself to return early,
 * which the SDK's own cancellation primitives cannot reliably do (an
 * in-flight tool/model call runs to completion regardless — see the
 * promoted spike in `__tests__/unit/agent-sdk-cancellation.test.ts`, §12.2).
 *
 * `deadlineAt` (sync path) and `cancelled` (background path, flipped by the
 * worker's own heartbeat-cadence poll of `cancelRequestedAt`) are checked
 * together, once, immediately before the conversation write (§12.12) — not
 * relied on to actually interrupt the in-flight call.
 */
export interface AgentRunCancellationCell {
    /** Absolute epoch-ms deadline. When set and already passed, the turn is superseded. */
    deadlineAt?: number;
    /** Flipped to `true` asynchronously by an external caller (e.g. a background worker's cancel poll). */
    cancelled: boolean;
    /**
     * Set when the run was finalized WITHOUT waiting for this turn to stop (its
     * ceiling passed while a call hung): the conversation is free for a newer turn
     * and this one is only running out. It writes nothing mid-turn from then on, and
     * its end is recorded only if no newer turn took the session (`runtimeTurnId`).
     */
    abandoned?: boolean;
}

/** True once a deadline has passed or an explicit cancel has been recorded. */
function isCancellationCellTripped(cell: AgentRunCancellationCell | undefined): boolean {
    if (!cell) return false;
    if (cell.cancelled) return true;
    if (cell.deadlineAt !== undefined && Date.now() > cell.deadlineAt) return true;
    return false;
}

/**
 * Bridges the mutable `cancellationCell.cancelled` flag into an `AbortSignal`
 * the SDK's `InvokeConfig.cancellationToken` understands. A short poll
 * interval is the only way to observe a plain boolean flipping asynchronously
 * from the outside during an in-flight `invoke()` call — this is a
 * best-effort inner control (§12.2: it stops the loop before its NEXT step,
 * it does not interrupt a call already in flight), not the mechanism that
 * actually bounds the caller's wait (that is the `Promise.race` at the call
 * site, §5/§7 step 5).
 */
const CANCELLATION_CELL_POLL_MS = 250;

/**
 * ONE `cancellationToken` for the SDK out of the two ways a turn can be
 * stopped: the cell (deadline / background cancel, polled) and the caller's
 * own `signal` (e.g. a realtime barge-in, event-driven). Either aborts it.
 * With only a signal there is nothing to poll and the signal is used as is.
 */
function bridgeCancellationCell(
    cell: AgentRunCancellationCell | undefined,
    callerSignal?: AbortSignal,
): { signal?: AbortSignal; stop: () => void } {
    if (!cell) return { ...(callerSignal ? { signal: callerSignal } : {}), stop: () => undefined };
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (cell.cancelled || callerSignal?.aborted) controller.abort(callerSignal?.reason);
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setInterval(() => {
        if (cell.cancelled && !controller.signal.aborted) controller.abort();
    }, CANCELLATION_CELL_POLL_MS);
    timer.unref?.();
    return {
        signal: controller.signal,
        stop: () => {
            clearInterval(timer);
            callerSignal?.removeEventListener('abort', onCallerAbort);
        },
    };
}

/**
 * Remembers the text a turn has streamed so far, for the one case where
 * nothing else can say what was produced: the caller aborted and the model
 * call REJECTED (a provider that honours the abort signal throws instead of
 * returning), so there is no result to read the partial answer from.
 */
function captureStreamedText(onTextChunk: ((text: string) => void) | undefined): {
    onTextChunk?: (text: string) => void;
    text: () => string;
} {
    if (!onTextChunk) return { text: () => '' };
    let streamed = '';
    return {
        onTextChunk: (text: string) => {
            streamed += text;
            onTextChunk(text);
        },
        text: () => streamed,
    };
}

/** `stopDetail` of a turn the caller's `signal` ended (the SDK's own wording for it). */
const CALLER_ABORT_DETAIL = 'aborted';

export interface AgentChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    userMessage: string;
    /** Ids of the conversation's files this message attaches (uploaded to the session first). */
    attachments?: string[];
    userId: string;
    /**
     * Whose spend limits the turn counts against when `userId` is a synthetic
     * owner (a trigger run): the trigger's accountable person.
     */
    accountableUserId?: string;
    /** The background run executing this turn, when there is one — stamped on its session events. */
    runId?: string;
    /**
     * The reminder this turn is the wake-up of (a run of `channel: 'reminder'`): the turn starts
     * with a note framed as the agent's own (`reminderNoteText`), stored with `metadata.origin`.
     */
    reminder?: ReminderWake;
    /**
     * No interactive user on this turn (a schedule, an eval or red-team case, an
     * OpenAI-shaped client). An approval-gated tool call or a
     * question then follows the agent's `humanInTheLoop.unattended` setting —
     * `deny` (default: the call fails, the run goes on), `pause` (waits for
     * Studio, like an attended run) or `allow` (runs without approval) — rather
     * than parking on a prompt no one will see.
     */
    unattended?: boolean;
    /**
     * The caller can run the agent's client tools even though it cannot answer an
     * approval (the OpenAI-shaped chat completions bridge: a `tool_calls` reply
     * and a `tool` message are its way of asking and answering). Only meaningful
     * with `unattended`; a client tool that would need approval is then not offered
     * unless `humanInTheLoop.unattended` is `allow`.
     */
    answersClientTools?: boolean;
    /**
     * The model the route resolved for this turn (`resolveAgentRunModel`; the policy decision was the
     * route's). Must be the agent's main model or on its `additionalModels`, otherwise the main model runs.
     * A background turn takes the choice stored on its session instead.
     */
    modelKey?: string;
    /**
     * Reasoning the API request asked for (`reasoning_effort` / `reasoning: {effort}`, already
     * validated by the route). The lowest rung: the agent's pick and the Model Hub default win.
     */
    requestReasoning?: NormalizedReasoning;
    /** Request a specific published version (API/SDK) */
    version?: number;
    /** When true, use the published version (default for API/SDK calls) */
    usePublished?: boolean;
    /**
     * Caller-supplied runtime context (headers for downstream tools/MCP/
     * connected agents, metadata). Plain data — serializes over the job queue.
     */
    runtimeContext?: AgentRuntimeContext;
    /**
     * Who is asking and through which door (portal key, group ids, ...), for
     * Dynamic LLM caller conditions. Plain data. Fields left out are derived
     * from the request: agentKey, projectId, userId, the channel from
     * `runtimeContext.source`, the API token from `runtimeContext.tokenId`.
     */
    callerContext?: RoutingCallerContext;
    /**
     * Per-request structured output and validated agent variables. The run engine
     * carries them on the run row (so a queued run and a resume see the same
     * values) and passes them here; how the turn applies them is §6 of the run
     * engine spec.
     */
    responseFormat?: AgentResponseFormat;
    variables?: Record<string, unknown>;
    /**
     * Whether `variables` also fill the `{{variables.<name>}}` prompt variables (default
     * true). Off for variables that came from outside the platform's own callers: they
     * then reach the model only inside the user message, never the system prompt. The
     * prompt still reads the declared defaults and the values named in `literalVariables`.
     */
    variablesInPrompt?: boolean;
    /**
     * With `variablesInPrompt: false`: the names in `variables` whose value did not come
     * from the external content (a trigger's own fixed values). Only these, besides the
     * declared defaults, fill `{{variables.<name>}}` in the system prompt.
     */
    literalVariables?: string[];
    /**
     * The message / variables came from an external payload (a webhook): the Variables
     * block is closed with a line saying where the external data ends.
     */
    externalContent?: boolean;
    /**
     * Incremental answer text — internal agents (model token stream) and
     * connected agents (SSE) alike. Functions cannot cross the job queue, so
     * a run routed to another node replays its chunks over the cluster stream
     * relay (Redis pub/sub); without Redis a routed run streams nothing and
     * the caller still gets the complete result.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Incremental reasoning ("thinking") text while the model thinks, for a
     * caller that can show it live. Asking for it turns the model call into a
     * stream; nothing fires when the agent hides its reasoning
     * (`showReasoning: false`) or the model produced none. Same relay caveat
     * as `onTextChunk`.
     */
    onReasoningChunk?: (text: string) => void;
    /**
     * Shared deadline/cancel reference for the synchronous ceiling (§5) and
     * background max-duration/cancel (§7) — see `AgentRunCancellationCell`.
     * Absent for ordinary calls (dashboard, playground-adjacent callers),
     * which keep today's unconditional-persist behavior.
     */
    cancellationCell?: AgentRunCancellationCell;
    /**
     * The caller is no longer interested (a realtime barge-in, a closed
     * client). Stops the agent loop / connected-agent request; the turn then
     * RESOLVES — never rejects — with the text produced so far and
     * `stop_reason: 'cancelled'`. A run the SDK stopped at a step boundary
     * (and a connected agent's partial answer, guarded) is persisted like any
     * other cancelled run; a model call torn down mid-flight leaves no state
     * to persist, so the conversation stays as it was. Relayed to the worker
     * when the run is routed.
     */
    signal?: AbortSignal;
}

/** Tool-call progress notification surfaced while an agent run executes. */
export interface AgentToolCallEvent {
    phase: 'start' | 'success' | 'error';
    /** Tool name as the agent sees it (e.g. `knowledge_search`). */
    name: string;
    /** Provider tool-call id, when available. */
    id?: string;
    /**
     * The call's arguments. Carried so a live row can say WHICH search is
     * running ("web_search · Cognipeer") rather than just that one is — with
     * several parallel calls of the same tool, the name alone identifies
     * nothing.
     */
    args?: unknown;
    /** Filled on the terminal phase. */
    durationMs?: number;
    /** Filled on `error`. */
    error?: string;
    /**
     * Set when a delegated child made the call (a step of its own loop). Absent
     * on the agent's own calls and on the delegation call that handed the task
     * over: a child cannot delegate, so it never emits a delegation tool event.
     */
    subagent?: { id?: string; name: string };
    /**
     * Set only on the `start` of a delegation call the SDK re-enters after a
     * child's pause was answered (same call id as in the paused turn).
     */
    resumed?: true;
}

/** The notification for an SDK tool_call event, or undefined for any other event. */
function toToolCallEvent(event: AgentSdkEvent, resumedCalls?: ReadonlySet<string>): AgentToolCallEvent | undefined {
    if (event.type !== 'tool_call' || !event.name) return undefined;
    if (event.phase !== 'start' && event.phase !== 'success' && event.phase !== 'error') return undefined;
    const subagent = subagentStampOf(event);
    const resumed = event.phase === 'start' && !subagent && isDelegationTool(event.name)
        && typeof event.id === 'string' && Boolean(resumedCalls?.has(event.id));
    return {
        phase: event.phase,
        name: event.name,
        id: event.id,
        ...(event.args !== undefined ? { args: event.args } : {}),
        ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
        ...(event.error?.message ? { error: event.error.message } : {}),
        ...(subagent ? { subagent } : {}),
        ...(resumed ? { resumed: true as const } : {}),
    };
}

/** Ephemeral (playground) chat — no DB conversation required */
export interface AgentPlaygroundChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userMessage: string;
    /** The model the route resolved for this turn - see `AgentChatRequest.modelKey`. */
    modelKey?: string;
    /** See `AgentChatRequest.requestReasoning`. */
    requestReasoning?: NormalizedReasoning;
    /** Who is asking and through which door - see `AgentChatRequest.callerContext`. Overrides what is derived from the runtime context. */
    callerContext?: RoutingCallerContext;
    /** Ids of the session's files this message attaches (a Session only; uploaded to it first). */
    attachments?: string[];
    /**
     * Previous messages for context. Ignored (and the DB history loaded
     * instead) whenever `conversationId` is set — a caller-supplied history
     * next to a real conversation id would let the client fabricate turns the
     * agent never actually produced, and persist them.
     */
    history?: Array<{ role: string; content: string }>;
    /**
     * Backs this run with a persisted Session: history loads from the
     * conversation instead of `history`, and the exchange (including steps/
     * usage/output) is written back afterward. Omitted, this behaves exactly
     * as the stateless playground always has — in-memory, nothing saved.
     */
    conversationId?: string;
    /**
     * Run a published version instead of the draft. The playground's whole point
     * is the draft, so absent means draft — but comparing a change against what
     * is live is the other half of that job.
     */
    version?: number;
    /**
     * Caller-supplied runtime context (headers for downstream tools/MCP/
     * connected agents, metadata). Plain data — serializes over the job queue.
     */
    runtimeContext?: AgentRuntimeContext;
    /**
     * Best-effort: fires as the agent starts/finishes each tool call so
     * callers (e.g. realtime sessions) can surface progress. Functions cannot
     * cross the job queue — when the agent is assigned to another cluster node
     * the events are replayed over the cluster stream relay (Redis pub/sub);
     * without it the run still works, but no events fire. Connected agents
     * run their tools remotely and never fire it.
     */
    onToolEvent?: (event: AgentToolCallEvent) => void;
    /**
     * Incremental answer text, for a caller that can render it as it arrives —
     * internal agents (model token stream) and connected agents (SSE) alike.
     * Same relay caveat as `onToolEvent`.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Incremental reasoning text while the model thinks (the operator's playground
     * always gets it when the model produced it). Same relay caveat as `onToolEvent`.
     */
    onReasoningChunk?: (text: string) => void;
    /**
     * Operator view: ask the provider for the thinking text (Claude: summarized
     * display) even when the agent hides reasoning from its API responses. The
     * result carries it; what a Session STORES still follows the agent's setting.
     */
    revealReasoning?: boolean;
    /**
     * Fires when the agent summarizes its context mid-run. Same relay caveat
     * as `onToolEvent`.
     */
    onCompaction?: (compaction: IAgentTurnCompaction) => void;
    /**
     * Abort the turn (realtime barge-in). The run RESOLVES with the text
     * produced so far, `stopReason: 'cancelled'` and `stopDetail: 'aborted'`;
     * a Session turn is persisted that way. Relayed to the worker when the
     * run is routed to another node.
     */
    signal?: AbortSignal;
    /**
     * This run is embedded in a host page that declared client tools: they are
     * offered to the model for this run only, and a call pauses the turn as a
     * `client_tool` pending action the page answers. Set by a host that KNOWS
     * the embedding (a portal's embed session) — never from a client request.
     * Needs a Session (`conversationId`) to park the paused turn on.
     */
    embedded?: EmbeddedRunContext;
    /**
     * The answer(s) this turn replaces — set when a regenerate re-runs a user
     * message (`prepareSessionRerun`): the new assistant message keeps them as
     * `previousVersions` (newest last, at most 5).
     */
    previousVersions?: IAgentMessageVersion[];
}

/**
 * One tool call as the playground shows it.
 *
 * The playground is where an operator debugs an agent, so a step carries the
 * arguments and the result — not just the name. The live chat path deliberately
 * does NOT return these: a tool result can be large and can contain exactly the
 * data a guardrail redacted from the answer.
 */
export type AgentPlaygroundStep = IAgentConversationStep;

/** A session turn's result: the persisted assistant message minus role/timestamp, which `persistSessionTurn` adds. */
export type AgentPlaygroundChatResult = Omit<IAgentConversationMessage, 'role' | 'timestamp'>;

/** OpenAI Responses API–compatible output content item */
export interface ResponseOutputText {
    type: 'output_text';
    text: string;
    /** Files the agent produced this turn (`file_path`, as OpenAI's code interpreter cites its files). Additive. */
    annotations?: ClientFileAnnotation[];
}

/** OpenAI Responses API–compatible output message */
export interface ResponseOutputMessage {
    id: string;
    type: 'message';
    role: 'assistant';
    content: ResponseOutputText[];
}

/** OpenAI Responses API–compatible reasoning ("thinking") output item */
export interface ResponseReasoningItem {
    id: string;
    type: 'reasoning';
    summary: Array<{ type: 'summary_text'; text: string }>;
}

export type ResponseOutputItem = ResponseReasoningItem | ResponseOutputMessage;

/** OpenAI Responses API–compatible usage */
export interface ResponseUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** The cached slice of `input_tokens` (0 when the run did not report one). */
    input_tokens_details: { cached_tokens: number };
    /** The reasoning slice of `output_tokens` (0 when the run did not report one). */
    output_tokens_details: { reasoning_tokens: number };
}

/** OpenAI Responses API–compatible response shape */
export interface AgentChatResponse {
    id: string;
    object: 'response';
    model: string;
    output: ResponseOutputItem[];
    /**
     * `incomplete` when a run limit, a cancellation or a pause ended the run
     * before a final answer — see `incomplete_details` and `stop_reason`.
     */
    status: 'completed' | 'failed' | 'incomplete' | 'requires_action';
    /** OpenAI Responses convention: why the response is `incomplete`. */
    incomplete_details?: { reason: string } | null;
    /** OpenAI Responses convention: present when `status` is `failed` — the run is over and cannot be continued. */
    error?: { code: string; message: string } | null;
    /** How the agent run ended; `completed` for a normal final answer, `requires_action` while it waits on a person. */
    stop_reason?: AgentStopReason | 'requires_action' | 'budget_reached';
    /** Present when `status` is `requires_action`: the approvals / questions to resolve. */
    required_action?: { type: 'agent_actions'; actions: ClientPendingAction[] };
    /** The runtime's own wording for a non-`completed` stop, e.g. which limit. */
    stop_detail?: string;
    usage: ResponseUsage;
    created_at: number;
    previous_response_id: string | null;
    /** Version used for this response (null if not versioned) */
    version: number | null;
    /**
     * Validated structured answer, present only when the agent declares a
     * structured-output schema and the final answer satisfied it. Additive:
     * the top-level `output` stays the OpenAI-style item array.
     */
    output_parsed?: unknown;
    /** Why the structured contract failed (parse/validation); mutually exclusive with `output_parsed`. */
    output_error?: string;
    /** Files the agent produced this turn (its sandbox's `/outputs/`, or `session_files_create`), saved as session files. Additive; absent when none. */
    output_files?: ClientOutputFile[];
    /** Things the turn could not do as configured (a sub-agent skipped or empty, files not delivered, a tool not offered). Additive; absent when none. */
    warnings?: string[];
    /** Conversation messages for dashboard playgrounds */
    _conversation_messages?: Array<{ role: string; content: string; reasoning?: string; timestamp: Date }>;
}

/**
 * `incomplete_details.reason` for a run that stopped early. `max_output_tokens`
 * is OpenAI's own value, so a stock client recognizes the output-token cap;
 * the rest are this API's, named after the limit that fired.
 */
export function incompleteReason(stopReason: AgentStopReason | 'budget_reached', stopDetail?: string): string {
    if (stopReason === 'limit') {
        if (stopDetail?.startsWith('maxTotalOutputTokens') || stopDetail?.startsWith('maxOutputTokens')) return 'max_output_tokens';
        if (stopDetail?.startsWith('maxCostUsd')) return 'max_cost';
        if (stopDetail?.startsWith('maxWallClockMs')) return 'max_duration';
        return 'run_limit';
    }
    return stopReason;
}

/**
 * The live parts of a request that cannot ride in a queue payload, as relay
 * handlers for `routeInstanceCall`. Event names are the contract with
 * `agentRelayCallbacks` on the worker.
 */
function agentRelayOptions(request: {
    onTextChunk?: (text: string) => void;
    onReasoningChunk?: (text: string) => void;
    onToolEvent?: (event: AgentToolCallEvent) => void;
    onCompaction?: (compaction: IAgentTurnCompaction) => void;
    signal?: AbortSignal;
}): RelayCallerOptions {
    const { onTextChunk, onReasoningChunk, onToolEvent, onCompaction } = request;
    return {
        handlers: {
            text: onTextChunk ? (data) => { if (typeof data === 'string') onTextChunk(data); } : undefined,
            reasoning: onReasoningChunk ? (data) => { if (typeof data === 'string') onReasoningChunk(data); } : undefined,
            tool: onToolEvent ? (data) => onToolEvent(data as AgentToolCallEvent) : undefined,
            compaction: onCompaction ? (data) => onCompaction(data as IAgentTurnCompaction) : undefined,
        },
        ...(request.signal ? { signal: request.signal } : {}),
    };
}

/**
 * Worker side of `agentRelayOptions`: callbacks that publish back to the
 * caller, ONLY for the events the caller listens for (an `onTextChunk` turns
 * the SDK's streaming on — a caller that did not ask for text must not change
 * how the model is called), plus the caller-controlled abort signal.
 * EXPORTED for the queue consumer.
 */
export function agentRelayCallbacks(relay: WorkerRelay | null): Pick<
    AgentPlaygroundChatRequest,
    'onTextChunk' | 'onReasoningChunk' | 'onToolEvent' | 'onCompaction' | 'signal'
> {
    if (!relay) return {};
    return {
        ...(relay.events.has('text') ? { onTextChunk: (text: string) => relay.emit('text', text) } : {}),
        ...(relay.events.has('reasoning') ? { onReasoningChunk: (text: string) => relay.emit('reasoning', text) } : {}),
        ...(relay.events.has('tool') ? { onToolEvent: (event: AgentToolCallEvent) => relay.emit('tool', event) } : {}),
        ...(relay.events.has('compaction')
            ? { onCompaction: (compaction: IAgentTurnCompaction) => relay.emit('compaction', compaction) }
            : {}),
        ...(relay.signal ? { signal: relay.signal } : {}),
    };
}

/**
 * Who a run is for, as the agent-run quota (domain `agent`) sees it. The
 * runtime context carries the identity the server stamped on the request — the
 * dashboard user, a portal user, an API token and its owner — so a run entry
 * point that has no `userId` field of its own is still attributed.
 */
function agentRunCallerOf(request: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userId?: string;
    runtimeContext?: AgentRuntimeContext;
}): AgentRunCaller {
    return {
        tenantDbName: request.tenantDbName,
        tenantId: request.tenantId,
        projectId: request.projectId,
        agentKey: request.agentKey,
        userId: request.userId || request.runtimeContext?.userId,
        tokenId: request.runtimeContext?.tokenId,
    };
}

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
    // Old `runtime.reasoning` becomes the main model's own selection (a stored draft or a
    // published snapshot may still carry it).
    // Bindings of a switched-off service (knowledge engine, MCP, tools, browser, web search, memory,
    // files, sandbox) are dropped here, so every builder below sees a config without them.
    const config = await applyServiceAvailability(tenantId, migrateAgentReasoning(input.config), { agentKey });
    const hitl = resolveHitlConfig(config.humanInTheLoop);
    const hitlMode = resolveHitlRunMode(hitl, { unattended: input.unattended, canPause: input.canPause });

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
    const { model, chatModel } = await buildAgentChatModel(tenantDbName, tenantId, projectId, config.modelKey, {
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.topP !== undefined ? { top_p: config.topP } : {}),
        ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
    }, agentReasoningForModel(config, config.modelKey), input.requestReasoning, {
        route: input.route,
        agentKey,
        ...(input.conversation?._id ? { sessionId: String(input.conversation._id) } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        onRouted: (key) => { routedModelKey = key; },
        // The operator's own views (playground, Compare versions) ask for the thinking text whatever the
        // agent publishes; every other surface follows the agent. Live deltas come from the SDK's reasoning
        // events (see the stream callbacks), so the gateway's own onReasoning hook is not wired here.
        ...(input.revealReasoning || agentShowsReasoning(config) || input.source === 'agent-playground' ? {} : { showReasoning: false }),
        ...(Number(config.runtime?.limits?.maxTotalOutputTokens) > 0
            ? { maxTotalOutputTokens: Number(config.runtime?.limits?.maxTotalOutputTokens) }
            : {}),
        ...(spend ? { onCost: agentSpendSettler(spend, config.modelKey) } : {}),
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
            tenantDbName, tenantId, projectId, config, toolGuard,
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
    const memoryMountPrompt = buildMemoryPromptSection(config.memory);
    if (memoryMountPrompt) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryMountPrompt}` : memoryMountPrompt;
    if (memory?.store && memoryToolMode !== 'off') {
        const mountedStores = buildMountedMemoryStores(config.memory, {
            tenantDbName, tenantId, projectId, agentKey,
            conversationId: input.memoryConversationId,
            userId: input.userId,
            onWarning: (message) => warnings.add(message),
        });
        const mountScope = (m: (typeof mountedStores)[number]) => m.mount.scope;
        const allowWrites = memoryToolMode === 'readwrite' && mountedStores.some((m) => m.mount.access === 'read_write');
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
            mounts: mountedStores.map((m) => ({ key: m.mount.storeKey, access: m.mount.access, scope: mountScope(m), store: m.store })),
        }));
        toolDefinitions.push(...memoryToolDefinitions(allowWrites, mountedStores.map((m) => m.mount.storeKey)));
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
        ? { scope: sessionFilesScope, conversationId: String(input.conversation._id), readPageChars: filesCfg.readPageChars }
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
                if (input.unattended && clientToolNeedsApproval(tool, hitl) && hitl.unattended !== 'allow') {
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
                    approvalPolicy: input.unattended ? { ...hitl, toolApprovalEnabled: false } : hitl,
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
    const approvalSubagents = new Map<string, string>();
    const tracingSink = await createInternalTracingSink(
        tenantDbName, tenantId, projectId, toolDefinitions, agentKey, (id) => { traceSessionId = id; }, approvalSubagents,
    );

    const { subagents, cleanupTasks: subagentCleanupTasks, models: subagentModels } = await buildAgentSubagents({
        db,
        tenantDbName,
        tenantId,
        projectId,
        subagents: activeSubagentEntries(config),
        createToolFn: createTool,
        zod: z,
        guard: toolGuard,
        runtimeContext,
        identity,
        ...(spend ? { spend } : {}),
        ...(sessionImages ? { images: sessionImages } : {}),
        toolMedia,
        modelTakesImages,
        caller: {
            agentKey,
            ...(input.conversation?._id ? { sessionId: String(input.conversation._id) } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
        },
        reasoning: { config, ...(input.requestReasoning ? { request: input.requestReasoning } : {}) },
        prompt: {
            parent: { config, variables: promptVariables },
            ...(input.variables ? { variables: input.variables } : {}),
            ...(input.variablesInPrompt !== undefined ? { variablesInPrompt: input.variablesInPrompt } : {}),
            ...(input.userId ? { userId: input.userId } : {}),
        },
        onWarning: (message) => warnings.add(message),
        approvals: { hitl, mode: hitlMode, run: { unattended: input.unattended, canPause: input.canPause }, allowedTools },
    });
    cleanupTasks.push(...subagentCleanupTasks);

    const skills = await buildAgentSkills(tenantDbName, projectId, config.skills);
    const outputSchema = resolveTurnOutputSchema(config, input.responseFormat);
    const skillPolicy = resolveAgentSkillPolicy(config);
    const tracingMetadata = input.modelChoice
        ? { ...buildTracingMetadata(runtimeContext), agentModel: input.modelChoice.modelKey, agentModelReason: input.modelChoice.reason }
        : buildTracingMetadata(runtimeContext);
    const sessionBudgetActive = Boolean(activeSessionBudget(input.conversation));
    const costEstimator = await buildAgentCostEstimator(config, model, subagentModels, sessionBudgetActive, (message) => warnings.add(message));
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
        ? applyToolApprovals(ownTools, hitl, allowedTools)
        : hitlMode === 'deny'
            ? denyUnattendedTools(ownTools, hitl, allowedTools)
            : ownTools;
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
        /** Who the run's Console identity tokens are for; a pause stores it for its continuation. */
        identity,
        // Files of both kinds ride on the answer: what the agent left in the sandbox's /outputs/ and what it wrote with the file tools.
        collectOutputs: mergeOutputCollectors(sandboxTools.collectOutputs, ...(fileOutputs ? [fileOutputs.collectOutputs] : [])),
        tappedUsd: () => tappedUsd,
        routedModel: () => routedModelKey,
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

/** `metadata` of a stored assistant message: the model that answered (see IAgentConversationMessage.metadata). */
function answeredWithMetadata(modelKey: string, offered: boolean, routedModel: string | undefined) {
    if (!offered && !routedModel) return {};
    return { metadata: { model: modelKey, ...(routedModel ? { routedModel } : {}) } };
}

/**
 * Invoke options that forward the answer's deltas to `onTextChunk`.
 *
 * `stream: true` is what actually turns provider deltas on — with only
 * `onStream` the SDK fires it exactly once, at the end, with the whole answer.
 * That terminal `isFinal` call repeats the FULL content, so forwarding it
 * would print the answer twice: once streamed, once again in one burst.
 */
function textStreamOptions(onTextChunk: ((text: string) => void) | undefined, agentKey: string) {
    if (!onTextChunk) return {};
    return {
        stream: true,
        onStream: (chunk: { text?: string; isFinal?: boolean }) => {
            // The SDK passes a sub-agent's deltas up only when asked to (the console never asks), stamped
            // with the sub-agent. They are its text, not this answer's: appended, they would read as the
            // parent's words and end up in the partial answer of an aborted turn.
            if (chunk.isFinal || !chunk.text || isSubagentEvent(chunk)) return;
            try {
                onTextChunk(chunk.text);
            } catch (callbackError) {
                logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
            }
        },
    };
}

/**
 * Taps the SDK's `reasoning` events of one turn: forwards each piece to the
 * caller and keeps the whole text.
 *
 * The SDK emits them only while the model call streams (`stream: true`), one
 * event per provider delta and no marker between model steps; a step boundary
 * (a tool call, or answer text) is therefore remembered and the next piece
 * starts a new paragraph, so a turn that thought before and after a tool call
 * reads as two thoughts rather than one run-on. `enabled: false` swallows
 * everything (the agent hides its reasoning).
 */
export function createReasoningTap(
    onReasoningChunk: ((text: string) => void) | undefined,
    agentKey: string,
    enabled = true,
): {
    listening: boolean;
    onEvent: (event: AgentSdkEvent) => void;
    text: () => string;
} {
    let collected = '';
    let boundary = false;
    return {
        listening: Boolean(onReasoningChunk) && enabled,
        onEvent: (event) => {
            if (!enabled) return;
            // A sub-agent's thinking, tool calls and text reach this tap too, stamped with the sub-agent:
            // none of it is this turn's thinking or a boundary between this turn's model steps.
            if (isSubagentEvent(event)) return;
            if (event.type === 'tool_call' || event.type === 'stream') {
                if (collected) boundary = true;
                return;
            }
            if (event.type !== 'reasoning' || typeof event.text !== 'string' || !event.text) return;
            const piece = boundary ? `\n\n${event.text}` : event.text;
            boundary = false;
            collected += piece;
            if (!onReasoningChunk) return;
            try {
                onReasoningChunk(piece);
            } catch (callbackError) {
                logger.warn('onReasoningChunk callback failed', { agentKey, error: callbackError });
            }
        },
        text: () => collected,
    };
}

/**
 * `textStreamOptions` plus the switch for reasoning: a caller that wants only
 * the thinking still needs the model call to stream, or the SDK emits nothing.
 */
function liveStreamOptions(
    onTextChunk: ((text: string) => void) | undefined,
    reasoningTap: { listening: boolean },
    agentKey: string,
) {
    const text = textStreamOptions(onTextChunk, agentKey);
    return reasoningTap.listening ? { ...text, stream: true } : text;
}

/**
 * Records a `summarization` event as a compaction of this turn: kept on the turn's
 * record, announced on the session log and handed to the caller when it listens.
 * A compaction a delegated child made of its OWN context is none of that: it did
 * not touch this turn's messages, and counting it would show the parent's
 * transcript as shortened (and name tool results as compacted) when it was not.
 */
function noteTurnCompaction(
    event: Parameters<typeof compactionFromEvent>[0],
    turn: {
        compactions: IAgentTurnCompaction[];
        turnEvents: Pick<SessionTurnEvents, 'onCompaction'> | undefined;
        onCompaction?: (compaction: IAgentTurnCompaction) => void;
        agentKey: string;
    },
): void {
    if (isSubagentEvent(event)) return;
    const compaction = compactionFromEvent(event);
    turn.compactions.push(compaction);
    turn.turnEvents?.onCompaction(compaction);
    try {
        turn.onCompaction?.(compaction);
    } catch (callbackError) {
        logger.warn('onCompaction callback failed', { agentKey: turn.agentKey, error: callbackError });
    }
}

/** The reasoning of a finished turn: what streamed (every model step), else the last message's. */
function turnReasoning(result: AgentSdkInvokeResult, reasoningTap: { text: () => string }): string | undefined {
    return reasoningTap.text() || extractAgentReasoning(result);
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
 * The runtime context a turn runs with: the session's own (`metadata.runtimeContext`,
 * entered once when the session was started) UNDER the caller's, so a
 * per-message value still wins. Headers and metadata merge key by key.
 */
function mergeSessionRuntimeContext(
    conversation: Pick<IAgentConversation, 'metadata'> | null | undefined,
    requestContext: AgentRuntimeContext | undefined,
): AgentRuntimeContext | undefined {
    const sessionContext = conversation?.metadata?.runtimeContext as AgentRuntimeContext | undefined;
    if (!sessionContext) return requestContext;
    return {
        ...sessionContext,
        ...requestContext,
        headers: { ...sessionContext.headers, ...requestContext?.headers },
        metadata: { ...sessionContext.metadata, ...requestContext?.metadata },
    };
}

/**
 * The files a message attaches, checked against the session BEFORE anything
 * runs (a refusal must not mark the session running or leave tools open).
 * Throws `AgentAttachmentError`; empty when the message attaches nothing.
 *
 * That is the files it names, plus — when the agent's `attachNewUploads` is on
 * (the default) — the files uploaded to the session that no message has carried
 * yet. Every channel that starts a turn gets that here, so "create a session,
 * upload, ask" works the same from the dashboard, the Responses API, a
 * background run or a portal.
 */
async function resolveMessageAttachments(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    conversation: IAgentConversation | null;
    config: IAgentConfig;
    fileIds: string[] | undefined;
}): Promise<IFileRecord[]> {
    const named = input.fileIds ?? [];
    const availability = attachmentsAvailability(input.config);
    if (named.length > 0) {
        if (!input.conversation) {
            throw new AgentAttachmentError(400, 'attachment_not_found', 'Attachments belong to a session; start one and upload the files to it first.');
        }
        if (!availability.available) {
            throw new AgentAttachmentError(403, 'attachments_disabled', attachmentsUnavailableMessage(availability.reason));
        }
    }
    const scope = { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId };
    const records = input.conversation && named.length > 0
        ? await resolveTurnAttachments(scope, String(input.conversation._id), named)
        : [];

    if (input.conversation && availability.available && availability.cfg.attachNewUploads) {
        const carried = new Set(records.map((record) => String(record._id)));
        for (const record of await findUnsentSessionFiles(scope, input.conversation)) {
            if (!carried.has(String(record._id))) records.push(record);
        }
    }
    return records;
}

/**
 * The attached files made ready for the model — in the turn, or readable with
 * the session file tools, images as parts when the model takes them. Never
 * fails the turn: what could not be read is a warning.
 */
async function assembleMessageAttachments(input: {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    records: IFileRecord[];
    config: IAgentConfig;
    model: Parameters<typeof resolveModelCapabilities>[0];
    warnings: Set<string>;
}): Promise<AssembledAttachments> {
    if (input.records.length === 0) return NO_ATTACHMENTS;
    const assembled = await assembleTurnAttachments({
        scope: { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId },
        records: input.records,
        cfg: resolveAttachmentsConfig(input.config.attachments),
        supportsVision: resolveModelCapabilities(input.model).inputModalities.includes('image'),
    });
    for (const warning of assembled.warnings) input.warnings.add(warning);
    return assembled;
}

/**
 * How the files of EARLIER messages reach the model again (`buildTurnInputState`):
 * a transcript replay rebuilds each message with its attachments, and the last
 * `attachments.carryRecentImages` messages with images are shown again when the
 * agent's own context no longer holds them. Absent for a stateless call, which
 * has no session and so no files.
 */
async function earlierAttachments(input: {
    db: Awaited<ReturnType<typeof getDatabase>>;
    conversation: IAgentConversation | null;
    config: IAgentConfig;
    model: Parameters<typeof resolveModelCapabilities>[0];
}): Promise<NonNullable<Parameters<typeof buildTurnInputState>[0]['attachments']> | undefined> {
    if (!input.conversation) return undefined;
    const cfg = resolveAttachmentsConfig(input.config.attachments);
    const supportsVision = resolveModelCapabilities(input.model).inputModalities.includes('image');
    const carryRecentImages = supportsVision && agentTakesAttachments(input.config) ? cfg.carryRecentImages : 0;
    let availableFileIds: Set<string> | undefined;
    if (carryRecentImages > 0 && input.conversation.messages?.some((message) => message.attachments?.length)) {
        try {
            const records = await input.db.listFileRecordsByConversation(String(input.conversation._id));
            availableFileIds = new Set(records.map((record) => String(record._id)));
        } catch (error) {
            logger.debug('Could not list the session files to carry images from', { error: error instanceof Error ? error.message : String(error) });
        }
    }
    // The window the SDK builds each request from: a picture counts as still seen only inside it.
    const { policy, lastTurnsToKeep } = resolveAgentRuntimeOptions(input.config).context ?? {};
    const window = policy && lastTurnsToKeep ? { policy, lastTurnsToKeep } : undefined;
    return { supportsVision, carryRecentImages, ...(availableFileIds ? { availableFileIds } : {}), ...(window ? { window } : {}) };
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

/**
 * The OpenAI Responses–shaped reply to one exchange. `outcome` is absent for a
 * connected agent, which reports no stop reason at all.
 */
/** `agent.output_file` event payloads of a turn's output attachments. */
function outputFileEvents(conversationId: string, attachments: ReadonlyArray<IAgentMessageAttachment>): Array<Record<string, unknown>> {
    return toClientOutputFiles(conversationId, attachments).map(outputFileEventData);
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
    };
}

export async function executeAgentChatLocal(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    // The last stop for a turn that arrives without the entry above (a queue worker, a background run).
    await assertAgentsEnabled(request);
    const scope: { events?: SessionTurnEvents } = {};
    try {
        return await runWithRoutingCaller(routingCallerOf(request), () => runAgentChatTurn(request, scope));
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
    const offersModels = config.kind !== 'external' && additionalModelKeys(config).length > 0;
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
    const callsModel = !(config.kind === 'external' && config.connection);
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

    // 3. Model, prompt, guardrails and tools — see `buildLocalAgentRun`.
    const { sdkAgent, model, cleanupTasks, warnings, hitl, costEstimator, tappedUsd, routedModel, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity } = await buildLocalAgentRun({
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
        const compactions: IAgentTurnCompaction[] = [];
        const cancellationBridge = bridgeCancellationCell(request.cancellationCell, request.signal);
        const streamed = captureStreamedText(onTextChunk);
        const reasoningTap = createReasoningTap(onReasoningChunk, agentKey, agentShowsReasoning(config));
        const liveInvokeConfig = {
            onEvent: (event: AgentSdkEvent) => {
                if (event.type === 'summarization') {
                    noteTurnCompaction(event, { compactions, turnEvents, agentKey });
                    return;
                }
                reasoningTap.onEvent(event);
                noteSdkEvent(event);
                turnEvents.onSdkEvent(event);
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
        const turnOutcome = endedByCallerAbort(describeTurnOutcome(result, inputState.messages.length), request.signal);
        const usage = normalizePlaygroundUsage(result.metadata?.usage)?.usage;
        await reconcileTrace(usage);
        // What the turn cost: kept on the message (the session's running total
        // is the sum of these) and, with a session budget, checked against it.
        const turnCostUsd = usage
            ? await priceAgentTurn({ plan: budgetPlan, result, costEstimator, pricing: model.pricing, usage })
            : undefined;
        if (usage && turnCostUsd !== undefined) usage.costUsd = turnCostUsd;
        const budget = budgetPlan
            ? settleSessionBudget(budgetPlan, turnCostUsd, isSessionBudgetBreach(budgetPlan, turnOutcome), turnOutcome.stopReason)
            : undefined;
        let outcome = budgetAwareOutcome(turnOutcome, budget);
        const outputParsed = result.output;
        const outputError = result.outputError ? describeStructuredOutputError(result.outputError) : undefined;
        const compactedTools = compactions.length > 0
            ? compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined)
            : [];
        // The same per-call detail a dashboard session stores, so a conversation
        // started over the API shows its tool calls when it is opened there.
        const steps = extractPlaygroundSteps(result, priorExecutionIds);

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
                ...(compactions.length > 0 ? { compactions, ...(compactedTools.length > 0 ? { compactedTools } : {}) } : {}),
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

        return {
            id: typeof entry.executionId === 'string' ? entry.executionId : undefined,
            name: typeof entry.toolName === 'string' ? entry.toolName : 'tool',
            args: entry.args,
            output,
            ...(rawDiffers ? { rawOutput } : {}),
            ...(errorText ? { error: errorText } : {}),
            ...(subagentOf ? { subagent: subagentOf } : {}),
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

/**
 * Prices a turn from the model's own `pricing` record.
 *
 * Returns undefined rather than 0 when the model has no pricing configured —
 * a displayed "$0.00" reads as "this was free", which is a different claim
 * from "nobody told the console what this model costs".
 */
async function priceTurn(
    pricing: IModelPricing | null | undefined,
    usage: AgentPlaygroundChatResult['usage'],
): Promise<number | undefined> {
    if (!pricing || !usage) return undefined;
    try {
        const { calculateCost } = await import('@/lib/services/models/usageLogger');
        return calculateCost(pricing, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
        }).totalCost;
    } catch {
        return undefined;
    }
}

/**
 * What a turn cost. With a budget in force this is the SDK's own per-request
 * usage priced by the cost estimator — the figure the budget was enforced
 * against, sub-agent models at their own prices. A turn that delegated is priced
 * the same way even without a budget: the SDK's ledger holds the sub-agents'
 * model calls next to the parent's (each tagged `subagent`, with the model it
 * ran on), so the turn's total at the primary model's price would charge a
 * cheaper or dearer child at the wrong rate. Otherwise (or when the SDK
 * reported no per-request usage) it is the turn's total usage at the primary
 * model's price.
 */
async function priceAgentTurn(input: {
    plan: SessionBudgetPlan | null;
    result: Pick<AgentSdkInvokeResult, 'state'>;
    costEstimator: ReturnType<typeof buildCostEstimator>;
    pricing: IModelPricing | null | undefined;
    usage: AgentPlaygroundChatResult['usage'];
}): Promise<number | undefined> {
    const perRequest = (input.result.state as {
        usage?: {
            perRequest?: Array<{
                modelName?: string;
                subagent?: { name?: string };
                usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: { cached_tokens?: number };
                    completion_tokens_details?: { reasoning_tokens?: number };
                };
            }>;
        };
    } | undefined)?.usage?.perRequest;
    // A turn whose own model has no price stays unpriced however its children are priced:
    // a cost that left the parent's calls out would read as the whole bill.
    const estimate = input.costEstimator;
    if (
        estimate && Array.isArray(perRequest) && perRequest.length > 0
        && (input.plan || (input.pricing && perRequest.some((request) => request.subagent)))
    ) {
        let cost = 0;
        for (const request of perRequest) {
            cost += estimate({
                modelName: request.modelName,
                inputTokens: Number(request.usage?.prompt_tokens) || 0,
                outputTokens: Number(request.usage?.completion_tokens) || 0,
                cachedInputTokens: Number(request.usage?.prompt_tokens_details?.cached_tokens) || 0,
                reasoningTokens: Number(request.usage?.completion_tokens_details?.reasoning_tokens) || 0,
            }) || 0;
        }
        return cost;
    }
    return priceTurn(input.pricing, input.usage);
}

/**
 * The turn's outcome as it is reported when the SESSION budget stopped it: the
 * SDK's `limit` becomes `budget_reached`, with the budget's own wording.
 */
function budgetAwareOutcome(outcome: AgentTurnOutcome, settlement: SessionBudgetSettlement | undefined): AgentTurnOutcome {
    return settlement?.reached ? { ...outcome, stopDetail: budgetStopDetail(settlement) } : outcome;
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
        };
        return await runWithRoutingCaller(caller, () => runPlaygroundChatTurn(request, scope));
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
    const offersModels = config.kind !== 'external' && additionalModelKeys(config).length > 0;
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
    const callsModel = !(config.kind === 'external' && config.connection);
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

    const { sdkAgent, model, systemPrompt, cleanupTasks, warnings, hitl, costEstimator, tappedUsd, routedModel, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity } = await buildLocalAgentRun({
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
    const { onToolEvent, onCompaction, signal } = request;
    const compactions: IAgentTurnCompaction[] = [];
    const streamed = captureStreamedText(onTextChunk);
    // The operator's playground always sees the thinking the model produced.
    const reasoningTap = createReasoningTap(onReasoningChunk, agentKey);
    const invokeConfig = {
        onEvent: (event: AgentSdkEvent) => {
            reasoningTap.onEvent(event);
            noteSdkEvent(event);
            turnEvents?.onSdkEvent(event);
            if (event.type === 'summarization') {
                // Collected for the turn record either way; forwarded live
                // so a session shows the compaction as it happens.
                noteTurnCompaction(event, { compactions, turnEvents, onCompaction, agentKey });
                return;
            }
            if (!onToolEvent) return;
            const payload = toToolCallEvent(event);
            if (!payload) return;
            try {
                onToolEvent(payload);
            } catch (callbackError) {
                logger.warn('onToolEvent callback failed', { agentKey, error: callbackError });
            }
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
                ...(compactions.length > 0 ? { compactions } : {}),
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
        const turnOutcome = endedByCallerAbort(describeTurnOutcome(result, inputState.messages.length), signal);
        const compactedTools = compactions.length > 0
            ? compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined)
            : [];

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
            steps: extractPlaygroundSteps(result, priorExecutionIds),
            ...(outputFiles.attachments.length > 0 ? { attachments: outputFiles.attachments } : {}),
            version: ranVersion,
            ...answeredWithMetadata(model.key, Boolean(modelChoice), routedModel()),
            ...(outcome.stopReason !== 'completed'
                ? { stopReason: outcome.stopReason, ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}) }
                : {}),
            ...(compactions.length > 0 ? { compactions } : {}),
            ...(compactedTools.length > 0 ? { compactedTools } : {}),
            ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
            ...(request.previousVersions?.length ? { previousVersions: request.previousVersions.slice(-MAX_PREVIOUS_VERSIONS) } : {}),
        };

        const costUsd = await priceAgentTurn({
            plan: budgetPlan, result, costEstimator, pricing: model.pricing, usage: playgroundResult.usage,
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
    onCompaction?: (compaction: IAgentTurnCompaction) => void;
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
        return await runAgentResumeTurn(request, scope);
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

    const { sdkAgent, model, systemPrompt, cleanupTasks, warnings, hitl, costEstimator, toolGuard, tappedUsd, routedModel, collectOutputs, reconcileTrace, failTrace, noteSdkEvent, identity } = await buildLocalAgentRun({
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
        const compactions: IAgentTurnCompaction[] = [];
        const streamed = captureStreamedText(onTextChunk);
        const reasoningTap = createReasoningTap(onReasoningChunk, agentKey, agentShowsReasoning(config) || source === 'agent-playground');
        const cancellationBridge = bridgeCancellationCell(request.cancellationCell, request.signal);
        const invokeConfig = {
            onEvent: (event: AgentSdkEvent) => {
                reasoningTap.onEvent(event);
                noteSdkEvent(event);
                turnEvents.onSdkEvent(event);
                if (event.type === 'summarization') {
                    noteTurnCompaction(event, { compactions, turnEvents, onCompaction: request.onCompaction, agentKey });
                    return;
                }
                if (!request.onToolEvent) return;
                const payload = toToolCallEvent(event, reEntered);
                if (!payload) return;
                try {
                    request.onToolEvent(payload);
                } catch (callbackError) {
                    logger.warn('onToolEvent callback failed', { agentKey, error: callbackError });
                }
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
        const turnOutcome = endedByCallerAbort(describeTurnOutcome(result, inputMessageCount), request.signal);
        const usage = normalizePlaygroundUsage(result.metadata?.usage)?.usage;
        const compactedTools = compactions.length > 0
            ? compactedToolResults(state.messages as AgentSdkMessage[], result.state?.messages as AgentSdkMessage[] | undefined)
            : [];
        const steps = extractPlaygroundSteps(result, priorExecutionIds);
        const costUsd = await priceAgentTurn({ plan: budgetPlan, result, costEstimator, pricing: model.pricing, usage });
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
            ...(compactions.length > 0 ? { compactions, ...(compactedTools.length > 0 ? { compactedTools } : {}) } : {}),
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
