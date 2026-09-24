/**
 * Agent Service
 *
 * Business logic for agent CRUD and chat orchestration.
 * Uses agent-sdk for runtime execution with automatic tracing.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/core/logger';
import { routeInstanceCall } from '@/lib/core/cluster';
import type { QueuePayload } from '@/lib/core/queue';
import { agentEntityId } from './agentEntityId';
import type {
    AgentInvokeResult as AgentSdkInvokeResult,
    Message as AgentSdkMessage,
    Skill as AgentSdkSkill,
    SkillPolicy as AgentSdkSkillPolicy,
    SmartAgentEvent as AgentSdkEvent,
    SmartAgentMemoryConfig as AgentSdkMemoryConfig,
    SubagentDef as AgentSdkSubagentDef,
    ToolInterface as AgentSdkToolInterface,
    TraceSinkConfig as AgentSdkTraceSinkConfig,
    TraceSessionFile,
} from '@cognipeer/agent-sdk';
import type { ZodTypeAny } from 'zod';
import {
    jsonSchemaToZod,
    toolInputSchemaToZod,
    resolveAgentRuntimeOptions,
    resolveAgentSkillPolicy,
    resolveStructuredOutputSchema,
    type ResolvedAgentRuntimeOptions,
} from './agentRuntimeConfig';
import { buildAgentSkills } from './agentSkillService';
import { buildAgentMemoryOption } from './agentMemoryAdapter';
import type { IAgentSubagent } from '@/lib/database/provider/types.domain';
import {
    buildPromptVariables,
    renderPromptTemplate,
    shouldRenderInlinePrompt,
    type RenderedPrompt,
} from './promptVariables';
import { getDatabase, type IAgent, type IAgentConfig, type IAgentConversation, type IAgentTracingEvent, type IAgentTracingSession, type IAgentVersion, type IModelPricing } from '@/lib/database';
import { getModelByKey } from '@/lib/services/models/modelService';
import { resolveModelInvocationConfig } from '@/lib/services/models/inferenceService';
import { buildModelRuntime } from '@/lib/services/models/runtimeService';
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
import type { AgentPlugin as AgentSdkPlugin } from '@cognipeer/agent-sdk';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { getMcpServerByKey, executeMcpTool, isMcpToolEnabled } from '@/lib/services/mcp';
// By path: the barrel does not export it, and it is the ONE reader of a
// server's `guardrail` / legacy `aegis` columns (`mcpService.ts`).
import { resolveMcpGuardrailBinding } from '@/lib/services/mcp/mcpService';
import { getToolByKey, executeToolAction, logToolRequest, toolRequestSecretValues } from '@/lib/services/tools';
import { resolveBrowser, createBrowserSession, buildBrowserAgentTools, closeBrowserSession } from '@/lib/services/browser';
import { buildWebSearchAgentTools } from '@/lib/services/webSearch';
import { recordTracingSessionCreated } from '@/lib/services/agentTracing';
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
import { normalizePlaygroundUsage } from './playgroundUsage';
import { withAssembledStream } from './assembledStream';
import { withStrictToolCalling } from './strictToolSchema';
import { withModelUsageLogging } from './modelUsageTap';
import { buildMemoryTools, memoryToolDefinitions } from './agentMemoryTools';
import { annotateAgentRunError, classifyAgentRunError } from './agentErrors';
import { buildAgentSandboxTools, destroyConversationSandbox } from './agentSandboxTools';
import { sealAgentConfigSecrets } from './agentSandboxSecrets';
import {
    buildCostEstimator,
    buildTurnInputState,
    compactedToolResults,
    compactionFromEvent,
    describeTurnOutcome,
    loadConversationState,
    saveConversationState,
    type AgentStopReason,
    type AgentTurnCompaction,
} from './agentTurnState';
import { isTruncatedFinishReason, normalizeFinishReason } from '@/lib/shared/finishReason';

const logger = createLogger('agents');

// The console's runtime defaults moved to `./agentRuntimeConfig` when they
// became per-agent settings; `CONSOLE_AGENT_DEFAULTS` there holds the same
// values and is what an agent with no `runtime` block still resolves to.

const CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION =
    'PRIMARY retrieval tool. For factual, product, policy, API, docs, or troubleshooting questions, call this tool BEFORE drafting the final answer. Use the user question (or a focused rewrite) as query. If results are empty/insufficient, then answer briefly with uncertainty. Each match carries a documentId — pass it to knowledge_read_document or knowledge_read_document_lines when the question needs more of that file than the matched passage.';

const CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION =
    'Returns the whole extracted text of one knowledge-base document, given the documentId from a knowledge_search result. Use this when the question is about the document as a whole (e.g. "summarize this file") and the file is not huge. The response is truncated past a size limit — when it is, switch to knowledge_read_document_lines to read the rest.';

const CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION =
    'Returns one line range of a knowledge-base document, given the documentId from a knowledge_search result. Use this for long documents, to page through a file, or to jump to a specific part of it. Call again with a later offset to continue reading.';

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
 */
interface AgentToolGuard {
    protect<A extends Record<string, unknown>, R>(
        spec: AgentToolSpec,
        execute: (safeArgs: A) => Promise<R>,
    ): (args: A) => Promise<R | string>;
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
            execute: (safeArgs: A) => Promise<R>,
        ): (args: A) => Promise<R | string> {
            return async (args: A) => {
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

                    const result = await execute(safeArgs);
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
        (alias): alias is (input: Record<string, unknown>) => Promise<unknown> =>
            typeof alias === 'function',
    );
    if (!original) {
        logger.warn('Tool exposes no callable; left unguarded', { tool: tool.name });
        return tool;
    }

    const guarded = guard.protect<Record<string, unknown>, unknown>(
        spec,
        async (safeArgs) => original(safeArgs),
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
 * ONE implementation for all four call sites (chat input/output, playground
 * input/output). They had drifted into four different behaviours — the
 * playground's output check ran under the `input.pre` hook, logged no `source`,
 * blocked on the record's legacy `action` column rather than on the findings,
 * and neither playground site applied a redaction — which meant an operator
 * testing a guardrail in the playground was not testing what production runs.
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
 *   · Neither `executeAgentChatLocal` nor `executePlaygroundChatLocal` passes
 *     `stream` or `onStream` at all, and no caller of either streams: the agent
 *     endpoints (`plugins/agents.ts`, `plugins/client-agents.ts`,
 *     `plugins/client-a2a.ts`) all await one `invoke` and send one response.
 *
 * So there is no socket on this path to gate, and pretending otherwise would be
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
 * DELETED, and worth saying why rather than leaving a gap.
 *
 * This used to be `warnUnservablePromptBinding`, telling an operator that a
 * `prompt.pre` binding "will not run on this agent" and to bind `input.pre` as
 * well. That was true until agent-sdk 0.10.0: the console emitted no
 * `prompt.pre` anywhere, because only the thing running the loop knows which
 * model call is the first of a turn.
 *
 * The plugin layer's `userPromptSubmit` is exactly that thing, and it now
 * serves the hook on this surface — so the warning became advice toward the
 * WRONG fix: an operator who follows it moves a once-per-turn policy onto
 * `input.pre`, which fires on every model call, and pays for a moderation
 * judge on each one.
 *
 * The stream warning above is NOT deleted alongside it. 0.10.0 did not close
 * that one: `onStream` is still `(chunk) => void`, synchronous and unawaitable,
 * and `pluginCapabilities().features.streamGate.implemented` is still false.
 * Streaming enforcement stays on the gateway.
 */

/**
 * THE TEXT HOOKS RUN AS AN SDK PLUGIN; THE TOOL HOOKS DO NOT. Both halves of
 * that sentence are load-bearing.
 *
 * agent-sdk 0.10.0 finally has a real plugin layer, so `prompt.pre`,
 * `input.pre` and `output.pre` can be served by the host itself instead of by
 * the brackets this module used to put around `sdkAgent.invoke`. That is a
 * straight win: `userPromptSubmit` fires exactly once for a user turn, which is
 * what `prompt.pre` has always meant and what no console surface could emit
 * before — `warnUnservablePromptBinding` existed only to apologise for it.
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
    return input.ledger.resolve(fromResult || input.fallback);
}

/**
 * The two hooks NO agent surface serves, warned together because they are one
 * question for a caller ("what did this operator configure that I cannot run?")
 * and because every agent entry point has to ask it: local chat, playground,
 * and — through `warnUnservableExternalBindings` — both connected-agent
 * branches.
 */
function warnUnservableAgentBindings(config: GuardrailBindingSource, agentKey: string): void {
    warnUnservableStreamBinding(config, agentKey);
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
    warnUnservableAgentBindings(config, agentKey);

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
    ragModuleKey: string,
    guard: AgentToolGuard,
): Promise<{ tools: AgentSdkToolInterface[]; toolDefinitions: TraceToolDefinition[] }> {
    const { createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    // Tenant-wide lookup: the user explicitly bound this module to the agent.
    const knowledgeModule = await getRagModule(tenantDbName, ragModuleKey);
    const filterableFields = knowledgeModule?.filterableFields ?? [];

    const searchTool = createTool({
        name: 'knowledge_search',
        description: CONSOLE_AGENT_KNOWLEDGE_SEARCH_DESCRIPTION,
        schema: filterableFields.length > 0
            ? z.object({
                query: z.string().describe('The search query'),
                filter: z.record(z.unknown()).optional()
                    .describe(knowledgeSearchFilterDescription(filterableFields)),
            })
            : z.object({ query: z.string().describe('The search query') }),
        func: guard.protect(
            { name: agentToolPolicyName('knowledge', 'search'), requestedName: 'knowledge_search' },
            async (args: { query: string; filter?: Record<string, unknown> }) => {
                const result = await queryRag(tenantDbName, tenantId, undefined, {
                    ragModuleKey,
                    query: args.query,
                    topK: 5,
                    filter: args.filter,
                });
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
        return document;
    }

    const readTool = createTool({
        name: 'knowledge_read_document',
        description: CONSOLE_AGENT_KNOWLEDGE_READ_DESCRIPTION,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document'),
                requestedName: 'knowledge_read_document',
            },
            async (args: { documentId: string }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentFullText(tenantDbName, tenantId, undefined, document);
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
        description: CONSOLE_AGENT_KNOWLEDGE_READ_LINES_DESCRIPTION,
        schema: z.object({
            documentId: z.string().describe('The documentId from a knowledge_search result'),
            offset: z.number().int().min(1).optional().describe('1-indexed line to start from (default 1)'),
            limit: z.number().int().min(1).max(1000).optional()
                .describe('Number of lines to return (default 200, max 1000)'),
        }),
        func: guard.protect(
            {
                name: agentToolPolicyName('knowledge', 'read_document_lines'),
                requestedName: 'knowledge_read_document_lines',
            },
            async (args: { documentId: string; offset?: number; limit?: number }) => {
                const document = await resolveOwnedDocument(args.documentId);
                if (!document) return 'Document not found in this knowledge base.';
                const result = await getRagDocumentTextLines(tenantDbName, tenantId, undefined, document, {
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
            knowledgeSearchToolDefinition(filterableFields),
            knowledgeReadToolDefinition(),
            knowledgeReadLinesToolDefinition(),
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

type CreateConsoleSdkAgentInput = {
    name: string;
    version?: string;
    model: unknown;
    tools: AgentSdkToolInterface[];
    systemPrompt?: string;
    tracingSink: AgentSdkTraceSinkConfig;
    threadId?: string;
    /** Guardrail plugins for the TEXT hooks; see `buildAgentGuardrailPlugins`. */
    plugins?: AgentSdkPlugin[];
    /**
     * Attribution tags forwarded to the trace session's own `metadata` field —
     * separate from prompt variables. This is what lets a scheduled fire, a
     * live API call, and a playground run show up distinguishably in the
     * existing Traces/Observability views instead of needing a parallel "run"
     * record: `?metadataKey=scheduleId&metadataValue=<id>` on the tracing list
     * finds every fire of one schedule, and `schedule.lastConversationId`
     * already equals the trace's `threadId` (see below), so a single fire is
     * one click away without any new API surface.
     */
    tracingMetadata?: Record<string, string>;
    /**
     * Resolved agent-sdk knobs from `config.runtime`. Absent for callers that
     * have no agent config to hand (they get the console defaults).
     */
    runtimeOptions?: ResolvedAgentRuntimeOptions;
    /** zod contract for the final answer, from `config.structuredOutput`. */
    outputSchema?: ZodTypeAny;
    /** Sub-agent registry built from `config.subagents`. */
    subagents?: AgentSdkSubagentDef[];
    /** Discoverable skills built from `config.skills` — see `agentSkillService.ts`. */
    skills?: AgentSdkSkill[];
    skillPolicy?: AgentSdkSkillPolicy;
    /** Console-memory-backed `MemoryStore` — see `agentMemoryAdapter.ts`. Absent when memory is off. */
    memory?: AgentSdkMemoryConfig;
    /** Prices model calls for `limits.maxCostUsd` — see `buildAgentCostEstimator`. */
    costEstimator?: ReturnType<typeof buildCostEstimator>;
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
    // `createSmartAgent` (:10325), the one `createConsoleSdkAgent` builds. On
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

    return new AgentGuardrailBlockedError(`Agent response blocked by guardrail: ${reason}`, {
        guardrailKey,
        reason,
        hook: consoleHookFor(incident?.hook ?? markerPlugin?.hook),
    });
}

/**
 * EXPORTED FOR TESTS ONLY. These are module-private helpers whose whole job is
 * to notice something the SDK does not announce, or to compose several keys'
 * plugins; they need coverage that does not require standing up a real agent
 * and a real model.
 */
export const __testables = {
    guardrailDenial,
    guardrailBlockedError,
    buildAgentGuardrailPlugins,
    MessageRewriteLedger,
    persistedUserTurn,
};

/**
 * `limits.maxCostUsd` is enforced by the SDK only through a `costEstimator`;
 * without one the limit did nothing at all. Built only when the limit is set,
 * from the pricing of the agent's model and of every sub-agent model override
 * — a delegated call spends from the same budget.
 */
async function buildAgentCostEstimator(
    tenantDbName: string,
    projectId: string,
    config: IAgentConfig,
    primary: { key?: string; modelId?: string; pricing?: IModelPricing | null },
): Promise<ReturnType<typeof buildCostEstimator>> {
    if (!(Number(config.runtime?.limits?.maxCostUsd) > 0)) return undefined;
    const { calculateCost } = await import('@/lib/services/models/usageLogger');
    const models: Array<{ names: Array<string | undefined>; pricing?: IModelPricing | null }> = [
        { names: [primary.key, primary.modelId], pricing: primary.pricing },
    ];
    for (const entry of config.subagents ?? []) {
        if (!entry.modelKey || entry.modelKey === primary.key) continue;
        const child = await getModelByKey(tenantDbName, entry.modelKey, projectId).catch(() => null);
        if (child) models.push({ names: [child.key, child.modelId], pricing: child.pricing });
    }
    const estimator = buildCostEstimator(models, primary.pricing, calculateCost);
    if (!estimator) {
        logger.warn('maxCostUsd is set but the agent model has no pricing; the cost limit cannot be enforced', {
            modelKey: primary.key,
        });
    }
    return estimator;
}

/**
 * Reasoning ("thinking") models expose their chain-of-thought separately from the
 * final answer. The agent SDK keeps it on the assistant message's
 * `additional_kwargs.reasoning_content` (our SDK LangChain integration maps the
 * OpenAI-compatible `reasoning_content` field there). Pull the reasoning trace from
 * the final assistant message so callers can surface it alongside the answer.
 */
function extractAgentReasoning(result: AgentSdkInvokeResult): string | undefined {
    const messages = (result.messages ?? []) as Array<{
        getType?: () => string;
        _getType?: () => string;
        additional_kwargs?: Record<string, unknown>;
    }>;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        const type = msg?.getType?.() ?? msg?._getType?.();
        if (type && type !== 'ai') continue;
        const reasoning = msg?.additional_kwargs?.['reasoning_content'];
        if (typeof reasoning === 'string' && reasoning.length > 0) {
            return reasoning;
        }
        if (type === 'ai') break;
    }
    return undefined;
}

function createConsoleSdkAgent(
    createSmartAgentFn: typeof import('@cognipeer/agent-sdk').createSmartAgent,
    input: CreateConsoleSdkAgentInput,
) {
    return createSmartAgentFn({
        name: input.name,
        version: input.version,
        model: input.model,
        ...(input.tools.length > 0 ? { tools: input.tools } : {}),
        // Omitted entirely when empty: an empty array and no key mean the same
        // thing to the host, and the shorter option object is what every other
        // conditional field here does.
        ...(input.plugins && input.plugins.length > 0 ? { plugins: input.plugins } : {}),
        // `runtimeOptions` already carries the module defaults for every knob an
        // operator left untouched, so spreading it is equivalent to the literal
        // block this replaced — see `agentRuntimeConfig.CONSOLE_AGENT_DEFAULTS`.
        ...(input.runtimeOptions ?? resolveAgentRuntimeOptions({})),
        ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
        ...(input.subagents && input.subagents.length > 0 ? { subagents: input.subagents } : {}),
        ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
        ...(input.skillPolicy ? { skillPolicy: input.skillPolicy } : {}),
        ...(input.memory ? { memory: input.memory } : {}),
        ...(input.costEstimator ? { costEstimator: input.costEstimator } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        tracing: {
            enabled: true,
            mode: 'batched',
            sink: input.tracingSink,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            ...(input.tracingMetadata && Object.keys(input.tracingMetadata).length > 0
                ? { metadata: input.tracingMetadata }
                : {}),
        },
    });
}

/**
 * Reduces `runtimeContext` into the flat string map the trace session's own
 * `metadata` field accepts.
 *
 * Deliberately narrow: `source` and `trigger`/`scheduleId`/`scheduleName` (the
 * fields the scheduler stamps into `metadata` for prompt variables) are worth
 * attribution — they are exactly what `?metadataKey=…&metadataValue=…` on the
 * tracing list is for. The rest of a caller's free-form metadata is left out;
 * it was sent for prompt rendering, not for a tracing filter, and object/array
 * values would need a shape decision this call site should not make silently.
 */
function buildTracingMetadata(runtimeContext: AgentRuntimeContext | undefined): Record<string, string> | undefined {
    if (!runtimeContext) return undefined;
    const out: Record<string, string> = {};
    if (runtimeContext.source) out.source = runtimeContext.source;
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

// ── Sub-agent registry ──────────────────────────────────────────────

type BuildSubagentsInput = {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    subagents: IAgentSubagent[] | undefined;
    createToolFn: typeof import('@cognipeer/agent-sdk').createTool;
    zod: typeof import('zod').z;
    guard: AgentToolGuard;
    runtimeContext?: AgentRuntimeContext;
    /** Depth guard: a `ref` sub-agent must not pull in its own `ref` children. */
    depth?: number;
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
async function buildAgentSubagents(
    input: BuildSubagentsInput,
): Promise<{ subagents: AgentSdkSubagentDef[]; cleanupTasks: Array<() => Promise<void>> }> {
    const entries = (input.subagents ?? []).filter((entry) => entry.enabled !== false);
    if (entries.length === 0) return { subagents: [], cleanupTasks: [] };

    const subagents: AgentSdkSubagentDef[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];
    const seen = new Set<string>();

    for (const entry of entries) {
        if (!entry.name || seen.has(entry.name)) {
            logger.warn('Skipping sub-agent with missing or duplicate name', { name: entry.name });
            continue;
        }
        seen.add(entry.name);

        let systemPrompt = entry.systemPrompt;
        let toolBindings = entry.toolBindings;
        let knowledgeEngineKey = entry.knowledgeEngineKey;
        let modelKey = entry.modelKey;

        if (entry.kind === 'ref') {
            if (!entry.agentKey) {
                logger.warn('Skipping sub-agent reference with no agentKey', { name: entry.name });
                continue;
            }
            try {
                const resolved = await resolveAgentConfig(
                    input.tenantDbName,
                    entry.agentKey,
                    input.projectId,
                    entry.agentVersion,
                );
                if (resolved.config.kind === 'external') {
                    // An external agent is an HTTP endpoint, not a set of tools —
                    // it cannot be flattened into a child of this process.
                    logger.warn('Skipping connected agent used as sub-agent', {
                        name: entry.name,
                        agentKey: entry.agentKey,
                    });
                    continue;
                }
                systemPrompt = entry.systemPrompt ?? resolved.config.systemPrompt;
                toolBindings = resolved.config.toolBindings;
                knowledgeEngineKey = resolved.config.knowledgeEngineKey;
                modelKey = entry.modelKey ?? resolved.config.modelKey;
            } catch (error) {
                logger.warn('Sub-agent reference could not be resolved; skipping', {
                    name: entry.name,
                    agentKey: entry.agentKey,
                    error: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
        }

        const childTools: AgentSdkToolInterface[] = [];
        if (knowledgeEngineKey) {
            const knowledge = await buildKnowledgeTools(
                input.tenantDbName,
                input.tenantId,
                knowledgeEngineKey,
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
            );
            childTools.push(...bound.tools);
            cleanupTasks.push(...bound.cleanupTasks);
        }

        let childModel: unknown;
        if (modelKey) {
            childModel = await buildSubagentModel(input.tenantDbName, input.tenantId, input.projectId, modelKey);
        }

        subagents.push({
            name: entry.name,
            ...(entry.title ? { title: entry.title } : {}),
            header: entry.header || entry.title || entry.name,
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(childTools.length > 0 ? { tools: childTools } : {}),
            ...(childModel ? { model: childModel } : {}),
            ...(entry.limits ? { limits: entry.limits } : {}),
            ...(entry.childContextPolicy ? { childContextPolicy: entry.childContextPolicy } : {}),
            ...(entry.outputSchema
                ? { outputSchema: jsonSchemaToZod(entry.outputSchema) }
                : {}),
            metadata: { kind: entry.kind, ...(entry.agentKey ? { agentKey: entry.agentKey } : {}) },
        });
    }

    return { subagents, cleanupTasks };
}

/**
 * Builds the LangChain model for a sub-agent's model override. Returns
 * undefined when the key no longer resolves, which makes the child fall back to
 * the parent's model rather than failing the whole run.
 */
async function buildSubagentModel(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    modelKey: string,
): Promise<unknown> {
    try {
        const model = await getModelByKey(tenantDbName, modelKey, projectId);
        if (!model || model.category !== 'llm') return undefined;
        const { runtime } = await buildModelRuntime(tenantDbName, tenantId, model.providerKey, projectId);
        if (!runtime.createChatModel) return undefined;
        const lcModel = await runtime.createChatModel({
            modelId: model.modelId,
            category: 'llm',
            modelSettings: resolveModelInvocationConfig(model, {}),
        });
        const { fromLangchainModel } = await import('@cognipeer/agent-sdk');
        return withModelUsageLogging(withStrictToolCalling(withAssembledStream(fromLangchainModel(lcModel))), {
            tenantDbName,
            model,
            route: 'agent.subagent',
        });
    } catch (error) {
        logger.warn('Sub-agent model override could not be built; falling back to parent model', {
            modelKey,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
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
): Promise<{
    cleanupTasks: Array<() => Promise<void>>;
    tools: AgentSdkToolInterface[];
    definitions: TraceToolDefinition[];
}> {
    if (!bindings || bindings.length === 0) return { cleanupTasks: [], tools: [], definitions: [] };

    const tools: AgentSdkToolInterface[] = [];
    const definitions: TraceToolDefinition[] = [];
    const cleanupTasks: Array<() => Promise<void>> = [];

    for (const binding of bindings) {
        if (binding.source === 'tool') {
            // ── Unified tool system ──────────────────────────────
            const toolRecord = await getToolByKey(tenantDbName, binding.sourceKey);
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

                const tool = createToolFn({
                    name: action.name,
                    description: action.description || `Call ${action.name} on ${toolRecord.name}`,
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
                                const { result, latencyMs } = await executeToolAction(
                                    toolRecord, action.key, args, toolRuntimeHeaders,
                                );
                                logToolRequest(
                                    tenantDbName, tenantId, toolRecord.projectId,
                                    toolRecord.key, action.key, action.name,
                                    'success', latencyMs,
                                    args,
                                    typeof result === 'object' ? (result as Record<string, unknown>) : { value: result },
                                    undefined,
                                    'agent',
                                    runtimeContext?.tokenId,
                                    toolRuntimeAuth,
                                    toolSecretValues,
                                );
                                return typeof result === 'string' ? result : JSON.stringify(result);
                            } catch (execError) {
                                const errorMessage = execError instanceof Error ? execError.message : 'Failed to execute tool action';
                                logToolRequest(
                                    tenantDbName, tenantId, toolRecord.projectId,
                                    toolRecord.key, action.key, action.name,
                                    'error', 0,
                                    args,
                                    undefined,
                                    errorMessage,
                                    'agent',
                                    runtimeContext?.tokenId,
                                    toolRuntimeAuth,
                                    toolSecretValues,
                                );
                                throw execError;
                            }
                        },
                    ),
                });
                tools.push(tool);
                definitions.push({
                    name: action.name,
                    description: action.description || `Call ${action.name} on ${toolRecord.name}`,
                    parameters: action.inputSchema,
                });
            }
        } else if (binding.source === 'mcp') {
            // ── Legacy MCP server bindings ───────────────────────
            const server = await getMcpServerByKey(tenantDbName, binding.sourceKey);
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
                    const { result } = await executeMcpTool(server, toolName, args, mcpRuntimeHeaders);
                    return typeof result === 'string' ? result : JSON.stringify(result);
                };
                const tool = createToolFn({
                    name: mcpToolDef.name,
                    description: mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`,
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
                definitions.push({
                    name: mcpToolDef.name,
                    description: mcpToolDef.description || `Call ${mcpToolDef.name} on ${server.name}`,
                    parameters: mcpToolDef.inputSchema,
                });
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
                const browserTools = (buildBrowserAgentTools({
                    tenantDbName,
                    tenantId,
                    projectId,
                    sessionKey: session.sessionKey,
                    createdBy: 'agent-runtime',
                }) as unknown as AgentSdkToolInterface[]).map((browserTool) =>
                    // Built elsewhere, so guarded after the fact. These are the
                    // agent's only tools that navigate and type into a live
                    // browser, i.e. the surface `tool_access.sideEffects` most
                    // wants to name.
                    protectBuiltTool(
                        guard,
                        {
                            name: agentToolPolicyName('browser', browserTool.name),
                            requestedName: browserTool.name,
                        },
                        browserTool,
                    ),
                );
                tools.push(...browserTools);
                for (const browserTool of browserTools) {
                    // Browser tools carry zod schemas only — record name +
                    // description, no parameters.
                    definitions.push({
                        name: browserTool.name,
                        ...(typeof browserTool.description === 'string' && browserTool.description
                            ? { description: browserTool.description }
                            : {}),
                    });
                }
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
            const webSearchTools = (buildWebSearchAgentTools({
                tenantDbName,
                tenantId,
                projectId,
                providerKey,
            }) as unknown as AgentSdkToolInterface[]).map((webSearchTool) =>
                protectBuiltTool(
                    guard,
                    {
                        name: agentToolPolicyName('websearch', webSearchTool.name),
                        requestedName: webSearchTool.name,
                    },
                    webSearchTool,
                ),
            );
            tools.push(...webSearchTools);
            for (const webSearchTool of webSearchTools) {
                definitions.push({
                    name: webSearchTool.name,
                    ...(typeof webSearchTool.description === 'string' && webSearchTool.description
                        ? { description: webSearchTool.description }
                        : {}),
                });
            }
        }
    }

    return { cleanupTasks, tools, definitions };
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
 * Creates a customSink that saves trace sessions directly to the database,
 * bypassing the HTTP tracing endpoint and its API-token authentication.
 * This is used for internal agent executions (dashboard playground & client API chat).
 *
 * `toolDefinitions` is the tool menu bound for THIS invocation: every model-
 * call event ('ai_call') gets a `tool_definitions` section carrying it.
 * Capture is per event, never per session — the SDK binds one menu per
 * invoke, but a session/thread spans invocations whose menus can differ, so
 * each call must record the menu it actually saw.
 */
async function createInternalTracingSink(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    toolDefinitions?: TraceToolDefinition[],
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

                const events = Array.isArray(session.events) ? session.events : [];

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

                const sessionDoc: Omit<IAgentTracingSession, '_id' | 'createdAt' | 'updatedAt'> = {
                    sessionId: session.sessionId,
                    traceId: session.traceId,
                    rootSpanId: session.rootSpanId,
                    threadId: session.threadId,
                    tenantId,
                    projectId,
                    source: 'custom',
                    agent: session.agent ?? {},
                    agentName: session.agent?.name ?? undefined,
                    agentVersion: session.agent?.version ?? undefined,
                    agentModel: session.agent?.model ?? undefined,
                    config: session.config ?? {},
                    metadata: session.metadata ?? {},
                    summary: session.summary ?? {},
                    status: session.status || 'unknown',
                    startedAt: session.startedAt ? new Date(session.startedAt) : new Date(),
                    endedAt: session.endedAt ? new Date(session.endedAt) : undefined,
                    durationMs: session.durationMs ?? undefined,
                    errors: session.errors ?? [],
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

                // Upsert session
                const existing = await db.findAgentTracingSessionById(session.sessionId, projectId);
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

                // Replace events
                await db.deleteAgentTracingEvents(session.sessionId, projectId);
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

                    const eventDoc: Omit<IAgentTracingEvent, '_id' | 'createdAt'> = {
                        sessionId: session.sessionId,
                        traceId: event.traceId ?? undefined,
                        spanId: event.spanId ?? undefined,
                        parentSpanId: event.parentSpanId ?? undefined,
                        tenantId,
                        projectId,
                        id: event.id ?? undefined,
                        type: event.type ?? undefined,
                        label: event.label ?? undefined,
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
                        metadata: restMetadata,
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
    },
): Promise<IAgent> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const key = generateAgentKey(data.name);

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
        // (dashboard, client API, Assistants) goes through.
        config: sealAgentConfigSecrets(data.config, undefined),
        status: data.status || 'active',
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
    if (data.config?.sandbox || data.config?.execution) {
        // `config` replaces the stored one wholesale; masked secret values
        // must resolve against what is stored, not be saved as the mask —
        // and a plaintext secret (sandbox secrets, the execution callback
        // secret) must be sealed before it is written.
        const current = await db.findAgentById(agentId);
        data = { ...data, config: sealAgentConfigSecrets(data.config, current?.config) };
    }
    return db.updateAgent(agentId, { ...data, updatedBy: userId });
}

export async function deleteAgentRecord(
    tenantDbName: string,
    agentId: string,
): Promise<boolean> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.deleteAgent(agentId);
}

export async function getAgentById(
    tenantDbName: string,
    agentId: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentById(agentId);
}

export async function getAgentByKey(
    tenantDbName: string,
    key: string,
    projectId?: string,
): Promise<IAgent | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentByKey(key, projectId);
}

export async function listAgents(
    tenantDbName: string,
    filters?: { projectId?: string; status?: IAgent['status']; search?: string },
): Promise<IAgent[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgents(filters);
}

export async function countAgents(
    tenantDbName: string,
    projectId?: string,
): Promise<number> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.countAgents(projectId);
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
            status: agent.status,
        },
        changelog,
        publishedBy: userId,
    });

    // Update agent with latest published version
    await db.updateAgent(agentId, {
        publishedVersion: nextVersion,
        latestVersion: nextVersion,
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

/**
 * Resolves the agent config to use for execution.
 * - If a specific version is requested, returns that version's config.
 * - For API/SDK calls (not playground), uses the published version.
 * - Falls back to current agent config if no version is published (backward compat).
 */
export async function resolveAgentConfig(
    tenantDbName: string,
    agentKey: string,
    projectId?: string,
    requestedVersion?: number,
): Promise<{
    agent: IAgent;
    config: IAgent['config'];
    resolvedVersion: number | null;
    agentName: string;
    agentDescription?: string;
}> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    const agent = await db.findAgentByKey(agentKey, projectId);
    if (!agent) throw new Error(`Agent "${agentKey}" not found`);

    // If a specific version is requested
    if (requestedVersion !== undefined && requestedVersion !== null) {
        const version = await db.findAgentVersion(String(agent._id), requestedVersion);
        if (!version) {
            throw new Error(`Version ${requestedVersion} not found for agent "${agentKey}"`);
        }
        return {
            agent,
            config: version.snapshot.config,
            resolvedVersion: version.version,
            agentName: version.snapshot.name,
            agentDescription: version.snapshot.description,
        };
    }

    // Use published version if available
    if (agent.publishedVersion) {
        const version = await db.findAgentVersion(
            String(agent._id),
            agent.publishedVersion,
        );
        if (version) {
            return {
                agent,
                config: version.snapshot.config,
                resolvedVersion: version.version,
                agentName: version.snapshot.name,
                agentDescription: version.snapshot.description,
            };
        }
    }

    // Fallback to current config (never published or version data missing)
    return {
        agent,
        config: agent.config,
        resolvedVersion: null,
        agentName: agent.name,
        agentDescription: agent.description,
    };
}

// ── Model connection check ───────────────────────────────────────────

export interface AgentModelCheckResult {
    ok: boolean;
    latencyMs: number;
    /** Set when the check failed — see `classifyAgentRunError`. */
    error?: { message: string; type: string; code?: string | null };
}

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
        const model = await getModelByKey(tenantDbName, modelKey, projectId);
        if (!model) throw new Error(`Model "${modelKey}" not found`);
        if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');
        const { runtime } = await buildModelRuntime(tenantDbName, tenantId, model.providerKey, projectId);
        if (!runtime.createChatModel) throw new Error('Provider runtime does not support chat model creation');
        const lcModel = await runtime.createChatModel({
            modelId: model.modelId,
            category: model.category,
            modelSettings: resolveModelInvocationConfig(model, {}).modelSettings,
        });
        await (lcModel as { invoke: (input: unknown) => Promise<unknown> })
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

export async function createConversation(
    tenantDbName: string,
    tenantId: string,
    projectId: string,
    userId: string,
    agentKey: string,
    title?: string,
    /** Session-level context — applied to every turn, see `executePlaygroundChatLocal`. */
    metadata?: Record<string, unknown>,
): Promise<IAgentConversation> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);

    return db.createAgentConversation({
        tenantId,
        projectId,
        agentKey,
        title: title || 'New conversation',
        messages: [],
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        createdBy: userId,
    });
}

export async function getConversationById(
    tenantDbName: string,
    conversationId: string,
): Promise<IAgentConversation | null> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.findAgentConversationById(conversationId);
}

export async function listConversations(
    tenantDbName: string,
    agentKey: string,
    filters?: { projectId?: string; limit?: number; skip?: number },
): Promise<IAgentConversation[]> {
    const db = await getDatabase();
    await db.switchToTenant(tenantDbName);
    return db.listAgentConversations(agentKey, filters);
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

function bridgeCancellationCell(
    cell: AgentRunCancellationCell | undefined,
): { signal?: AbortSignal; stop: () => void } {
    if (!cell) return { stop: () => undefined };
    const controller = new AbortController();
    if (cell.cancelled) controller.abort();
    const timer = setInterval(() => {
        if (cell.cancelled && !controller.signal.aborted) controller.abort();
    }, CANCELLATION_CELL_POLL_MS);
    timer.unref?.();
    return { signal: controller.signal, stop: () => clearInterval(timer) };
}

export interface AgentChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    conversationId: string;
    userMessage: string;
    userId: string;
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
     * Incremental answer text. Same queue caveat as the playground's: a
     * function cannot be serialized to another node, so a routed run simply
     * streams nothing and the caller still gets the complete result.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Shared deadline/cancel reference for the synchronous ceiling (§5) and
     * background max-duration/cancel (§7) — see `AgentRunCancellationCell`.
     * Absent for ordinary calls (dashboard, playground-adjacent callers),
     * which keep today's unconditional-persist behavior.
     */
    cancellationCell?: AgentRunCancellationCell;
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
}

/** Ephemeral (playground) chat — no DB conversation required */
export interface AgentPlaygroundChatRequest {
    tenantDbName: string;
    tenantId: string;
    projectId: string;
    agentKey: string;
    userMessage: string;
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
     * In-process only, best-effort: fires as the agent starts/finishes each
     * tool call so callers (e.g. realtime sessions) can surface progress.
     * Functions cannot cross the job queue — when the agent is assigned to
     * another cluster node the run still works, but no events fire.
     */
    onToolEvent?: (event: AgentToolCallEvent) => void;
    /**
     * Incremental answer text, for a caller that can render it as it arrives.
     * Same queue caveat as `onToolEvent` — a function cannot be serialized to
     * another node, so a routed run simply streams nothing.
     */
    onTextChunk?: (text: string) => void;
    /**
     * Fires when the agent summarizes its context mid-run. Same queue caveat
     * as `onToolEvent`.
     */
    onCompaction?: (compaction: AgentTurnCompaction) => void;
}

/**
 * One tool call as the playground shows it.
 *
 * The playground is where an operator debugs an agent, so a step carries the
 * arguments and the result — not just the name. The live chat path deliberately
 * does NOT return these: a tool result can be large and can contain exactly the
 * data a guardrail redacted from the answer.
 */
export interface AgentPlaygroundStep {
    id?: string;
    name: string;
    args?: unknown;
    /** What the MODEL saw — possibly a summary of the result. See `rawOutput`. */
    output?: unknown;
    /** The untouched tool result, set only when it differs from `output`. */
    rawOutput?: unknown;
    /** Present when the tool threw. */
    error?: string;
    /** Sub-agent that made the call, when delegation was involved. */
    subagent?: string;
    status?: 'success' | 'error' | 'rejected' | 'handoff';
    fromCache?: boolean;
    summarized?: boolean;
    originalTokenCount?: number;
    timestamp?: string;
}

export interface AgentPlaygroundChatResult {
    content: string;
    reasoning?: string;
    /** Parsed structured output, when the agent declares an output schema. */
    output?: unknown;
    /** Why the structured contract failed, when it did. */
    outputError?: string;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        totalTokens?: number;
        /** Priced from the model's own `pricing`; absent when the model has none. */
        costUsd?: number;
    };
    /** Wall-clock time of the run, measured server-side. */
    latencyMs?: number;
    steps?: AgentPlaygroundStep[];
    /** Which config actually ran: a version number, or null for the draft. */
    version?: number | null;
    /** Set when the run ended without a final answer — see `describeTurnOutcome`. */
    stopReason?: Exclude<AgentStopReason, 'completed'>;
    stopDetail?: string;
    /** Context summarizations during this turn. */
    compactions?: AgentTurnCompaction[];
    compactedTools?: Array<{ toolName: string; toolCallId: string }>;
    /** Non-fatal problems during the turn (a failed memory lookup, …). */
    warnings?: string[];
}

/** OpenAI Responses API–compatible output content item */
export interface ResponseOutputText {
    type: 'output_text';
    text: string;
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
    status: 'completed' | 'failed' | 'incomplete';
    /** OpenAI Responses convention: why the response is `incomplete`. */
    incomplete_details?: { reason: string } | null;
    /** How the agent run ended; `completed` for a normal final answer. */
    stop_reason?: AgentStopReason;
    /** The runtime's own wording for a non-`completed` stop, e.g. which limit. */
    stop_detail?: string;
    usage: ResponseUsage;
    created_at: number;
    previous_response_id: string | null;
    /** Version used for this response (null if not versioned) */
    version: number | null;
    /** Conversation messages for dashboard playgrounds */
    _conversation_messages?: Array<{ role: string; content: string; reasoning?: string; timestamp: Date }>;
}

/**
 * `incomplete_details.reason` for a run that stopped early. `max_output_tokens`
 * is OpenAI's own value, so a stock client recognizes the output-token cap;
 * the rest are this API's, named after the limit that fired.
 */
export function incompleteReason(stopReason: AgentStopReason, stopDetail?: string): string {
    if (stopReason === 'limit') {
        if (stopDetail?.startsWith('maxTotalOutputTokens')) return 'max_output_tokens';
        if (stopDetail?.startsWith('maxCostUsd')) return 'max_cost';
        if (stopDetail?.startsWith('maxWallClockMs')) return 'max_duration';
        return 'run_limit';
    }
    return stopReason;
}

export async function executeAgentChat(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    // The callback cannot be serialized over the queue — stripped from the
    // payload, kept on the local fast path. A routed run answers in full; it
    // just does not stream on the way.
    const payload = { ...request };
    delete payload.onTextChunk;
    return routeInstanceCall(
        {
            entityType: 'agent',
            entityId: agentEntityId(request.tenantId, request.agentKey),
            jobName: 'chat',
        },
        payload as unknown as QueuePayload,
        () => executeAgentChatLocal(request),
        // A routed turn with a ceiling waits exactly as long as the ceiling
        // allows and is never retried: the queue default (60s, 3 attempts)
        // cut long turns off early and could re-run a turn's tool calls.
        request.cancellationCell?.deadlineAt !== undefined
            ? { timeoutMs: Math.max(1_000, request.cancellationCell.deadlineAt - Date.now()), attempts: 1 }
            : undefined,
    );
}

/** Local (non-routed) implementation. Exported so the queue consumer can call it. */
export async function executeAgentChatLocal(
    request: AgentChatRequest,
): Promise<AgentChatResponse> {
    const {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId,
    } = request;
    let { userMessage } = request;

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
    const conversation = await db.findAgentConversationById(conversationId);
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

    // 2b. Connected (external) agent — invoke over HTTP, skip local runtime.
    //
    // THE TEXT HOOKS ARE THE WHOLE ENFORCEMENT SURFACE HERE, and that is a
    // property of the wire, not an omission: a connected agent runs on the far
    // side of one HTTP call — we send text and get text back. Its tools are
    // chosen, executed and returned by the remote runtime, so no tool name,
    // no argument object and no tool result ever crosses into this process and
    // there is nothing for `tool.pre` / `tool.post` to evaluate. That is why
    // `createAgentToolGuard` is deliberately NOT built on this branch, and why
    // a tool binding on a connected agent is warned about rather than quietly
    // dropped: silent non-enforcement is the failure this plane exists to end.
    if (config.kind === 'external' && config.connection) {
        warnUnservableExternalBindings(config, agentKey);

        // Reassigned exactly as the local path does at 5a: the guarded text is
        // what goes upstream, what is persisted, and what the title is cut from.
        userMessage = await evaluateBoundGuardrails({
            tenantDbName,
            tenantId,
            projectId,
            config,
            hook: 'input.pre',
            text: userMessage,
            source: 'agent',
        });

        const now = new Date();
        const history = (conversation.messages || []).map((m) => ({ role: m.role, content: m.content }));
        const { content: externalContent } = await invokeExternalAgent(
            config.connection,
            [...history, { role: 'user', content: userMessage }],
            { tenantDbName, tenantId, projectId },
            resolveRuntimeHeaders(request.runtimeContext, 'agent', agentKey, config.connection.runtimeHeaders),
        );

        // BEFORE `updatedMessages` is built, because that one array is both the
        // persisted history and the returned payload. Redacting only the
        // response would leave the raw answer in the conversation — where the
        // next turn reads it back and sends it upstream as history.
        const assistantContent = await evaluateBoundGuardrails({
            tenantDbName,
            tenantId,
            projectId,
            config,
            hook: 'output.pre',
            text: externalContent,
            source: 'agent',
        });

        const updatedMessages = [
            ...(conversation.messages || []),
            { role: 'user', content: userMessage, timestamp: now },
            { role: 'assistant', content: assistantContent, timestamp: new Date() },
        ];
        // §12.12: a deadline/cancel decision made about this turn while the
        // external HTTP call was in flight must not be overwritten by a late
        // write once it finally returns.
        if (!isCancellationCellTripped(request.cancellationCell)) {
            await db.updateAgentConversation(conversationId, {
                messages: updatedMessages,
                title: conversation.title === 'New conversation' && updatedMessages.length <= 2
                    ? userMessage.substring(0, 80)
                    : conversation.title,
            });
        }

        const responseId = `resp_${conversationId}`;
        const msgId = `msg_${Date.now().toString(36)}`;
        return {
            id: responseId,
            object: 'response' as const,
            model: agent.name,
            output: [
                {
                    id: msgId,
                    type: 'message' as const,
                    role: 'assistant' as const,
                    content: [{ type: 'output_text' as const, text: assistantContent }],
                },
            ],
            status: 'completed' as const,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            created_at: Math.floor(Date.now() / 1000),
            previous_response_id: (conversation.messages?.length ?? 0) > 0 ? responseId : null,
            version: resolvedVersion,
            _conversation_messages: updatedMessages,
        };
    }

    // 3. Resolve model
    if (!config.modelKey) throw new Error('Agent has no model configured');
    const model = await getModelByKey(tenantDbName, config.modelKey, projectId);
    if (!model) throw new Error(`Model "${config.modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    // 4. Build LangChain model runtime
    const { runtime } = await buildModelRuntime(
        tenantDbName,
        tenantId,
        model.providerKey,
        projectId,
    );

    if (!runtime.createChatModel) {
        throw new Error('Provider runtime does not support chat model creation');
    }

    // Resolved through the gateway's helper so an agent obeys the same model
    // record everything else does. Previously this built its own settings object
    // and never read `model.settings`, which meant: a hard-coded temperature of
    // 0.7 reached models that reject the parameter outright, the operator could
    // not override it from the Model Hub, and `top_p`/`max_tokens` were passed
    // under snake_case keys the contract layer does not read — so an agent's
    // Top P and Max Tokens settings had never taken effect at all.
    const lcModel = runtime.createChatModel({
        modelId: model.modelId,
        category: model.category,
        modelSettings: resolveModelInvocationConfig(model, {
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.topP !== undefined ? { top_p: config.topP } : {}),
            ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
        }).modelSettings,
    });

    // 5. Resolve system prompt
    let systemPrompt = config.systemPrompt;
    const promptVariables = buildPromptVariables({
        config,
        agentKey,
        agentName: agent.name,
        version: resolvedVersion,
        runtimeContext: request.runtimeContext,
        userId: request.userId,
    });
    if (!systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId);
        if (prompt) {
            const rendered = renderPromptTemplate(prompt.template, promptVariables);
            systemPrompt = rendered.text;
            reportPromptVariables(rendered, { agentKey, promptKey: config.promptKey });
        }
    } else if (systemPrompt && shouldRenderInlinePrompt(config, systemPrompt)) {
        const rendered = renderPromptTemplate(systemPrompt, promptVariables);
        systemPrompt = rendered.text;
        reportPromptVariables(rendered, { agentKey });
    }

    // 5a. Guardrails. One guard for the whole run — resolving the bindings once
    // keeps every tool this agent gets under the same policy, and a legacy
    // config (no `guardrails` array) resolves to the no-op guard.
    warnUnservableAgentBindings(config, agentKey);
    const toolGuard = createAgentToolGuard({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        actorId: request.userId,
        source: 'agent',
    });

    // THE TEXT HOOKS NOW RUN INSIDE THE AGENT, not around it.
    //
    // `prompt.pre`, `input.pre` and `output.pre` are served by the SDK plugin
    // built here and handed to `createConsoleSdkAgent` below. The brackets that
    // used to sit on either side of `invoke()` are gone: they ran `input.pre`
    // once per TURN, where `preModelCall` runs it on every model call — which is
    // what `input.pre` has always meant on the gateway, and what an operator
    // binding it expects. `prompt.pre` is the once-per-turn hook, and it now
    // actually fires.
    //
    // Tool hooks stay on `toolGuard` above; see `AGENT_PLUGIN_HOOKS`.
    //
    // The ledger collects what `input.pre` rewrote on the wire, so step 8 can
    // persist the redacted user turn rather than the raw one.
    const rewriteLedger = new MessageRewriteLedger();
    const guardrailPlugins = await buildAgentGuardrailPlugins({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        actorId: request.userId,
        onMessageRewrite: (rewrite) => rewriteLedger.record(rewrite),
    });

    // 5b. Build RAG retrieval tool if knowledge engine is configured
    const { createSmartAgent, fromLangchainModel, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    const tools: AgentSdkToolInterface[] = [];
    const toolDefinitions: TraceToolDefinition[] = [];
    if (config.knowledgeEngineKey) {
        const knowledgeTools = await buildKnowledgeTools(
            tenantDbName, tenantId, config.knowledgeEngineKey, toolGuard,
        );
        tools.push(...knowledgeTools.tools);
        toolDefinitions.push(...knowledgeTools.toolDefinitions);
    }

    if (config.knowledgeEngineKey) {
        const knowledgeSearchInstruction = [
            'Knowledge-base-first policy:',
            '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
            '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
            '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
        ].join('\n');
        systemPrompt = systemPrompt
            ? `${knowledgeSearchInstruction}\n\n${systemPrompt}`
            : knowledgeSearchInstruction;
    }

    // 5c. Build bound tools from toolBindings (MCP, future sources)
    const { cleanupTasks, tools: boundTools, definitions: boundToolDefinitions } = await buildBoundTools(
        tenantDbName,
        tenantId,
        projectId,
        config.toolBindings,
        createTool,
        z,
        toolGuard,
        request.runtimeContext,
    );
    tools.push(...boundTools);
    toolDefinitions.push(...boundToolDefinitions);

    // 5d. Memory as tools the model can actually call. The SDK gives it
    // neither: recall is pre-injected as a system message and writes only
    // happen at compaction, so an agent can neither look a fact up nor record
    // what it was just told. Built from the SAME store the SDK path reads, so
    // a tool write is visible to next turn's injection.
    // Non-fatal failures during the run (memory today), reported with the answer.
    const warnings = new Set<string>();
    const memoryOption = buildAgentMemoryOption(config.memory, {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId,
        userId: request.userId,
        onWarning: (message) => warnings.add(message),
    });
    const memoryToolMode = config.memory?.tools ?? 'readwrite';
    if (memoryOption?.store && memoryToolMode !== 'off') {
        const allowWrites = memoryToolMode === 'readwrite';
        tools.push(...buildMemoryTools({
            store: memoryOption.store,
            // 'workspace' is the SDK's OWN default when a config names no
            // scope (every runtime profile sets `memory: { scope: 'workspace' }`).
            // Defaulting to 'session' here would have the tools write where the
            // SDK's injection never reads — a fact stored and then invisible.
            scope: memoryOption.scope ?? 'workspace',
            createToolFn: createTool,
            zod: z,
            guard: toolGuard,
            allowWrites,
        }));
        toolDefinitions.push(...memoryToolDefinitions(allowWrites));
    }

    // 5e. Sandbox access (Enterprise). Provisioned on first use; cleaned up
    // with the other bound tools once the run is over.
    const sandboxTools = await buildAgentSandboxTools({
        sandbox: config.sandbox,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversation,
        createToolFn: createTool,
        zod: z,
        protect: (name, tool) => protectBuiltTool(toolGuard, { name, requestedName: tool.name }, tool),
        onWarning: (message) => warnings.add(message),
    });
    tools.push(...sandboxTools.tools);
    toolDefinitions.push(...sandboxTools.definitions);
    cleanupTasks.push(sandboxTools.cleanup);

    // 6. What the agent resumes from: the state the conversation's last turn
    // ended in (its tool calls and results, summaries, plan), or the text
    // transcript when there is none — see agentTurnState.ts.
    const now = new Date();
    const carried = await loadConversationState(db, conversation);

    // 7. Create agent-sdk instance and invoke
    // Wrapped so a streamed turn keeps its tool calls and usage — see
    // assembledStream.ts for what agent-sdk 0.10.1 drops without it.
    // Usage-tapped: agent calls bypass the gateway, so without this they
    // never reached Model Hub or the bill — see modelUsageTap.ts.
    const sdkModel = withModelUsageLogging(withStrictToolCalling(withAssembledStream(fromLangchainModel(lcModel))), {
        tenantDbName,
        model,
        route: 'agent.chat',
        agentKey,
    });
    const tracingSink = await createInternalTracingSink(tenantDbName, tenantId, projectId, toolDefinitions);

    const chatSubagents = await buildAgentSubagents({
        tenantDbName,
        tenantId,
        projectId,
        subagents: config.subagents,
        createToolFn: createTool,
        zod: z,
        guard: toolGuard,
        runtimeContext: request.runtimeContext,
    });
    cleanupTasks.push(...chatSubagents.cleanupTasks);

    const chatSkills = await buildAgentSkills(tenantDbName, projectId, config.skills);

    const sdkAgent = createConsoleSdkAgent(createSmartAgent, {
        name: agent.name,
        model: sdkModel,
        tools,
        systemPrompt,
        tracingSink,
        plugins: guardrailPlugins,
        threadId: conversationId,
        version: resolvedVersion !== null ? String(resolvedVersion) : undefined,
        runtimeOptions: resolveAgentRuntimeOptions(config),
        outputSchema: resolveStructuredOutputSchema(config.structuredOutput),
        subagents: chatSubagents.subagents,
        skills: chatSkills,
        skillPolicy: resolveAgentSkillPolicy(config),
        memory: memoryOption,
        tracingMetadata: buildTracingMetadata(request.runtimeContext),
        costEstimator: await buildAgentCostEstimator(tenantDbName, projectId, config, model),
    });

    const inputState = buildTurnInputState({
        carried,
        transcript: conversation.messages || [],
        userMessage,
    });
    const userTurnIndex = inputState.messages.length - 1;

    try {
        // Streaming is opt-in per call: `stream: true` is what actually turns
        // provider deltas on, and the SDK's terminal `isFinal` callback
        // repeats the WHOLE answer, so forwarding it would emit the response
        // twice. Both handled, same as the playground path.
        const { onTextChunk: onLiveTextChunk } = request;
        const compactions: AgentTurnCompaction[] = [];
        const cancellationBridge = bridgeCancellationCell(request.cancellationCell);
        const liveInvokeConfig = {
            onEvent: (event: AgentSdkEvent) => {
                if (event.type === 'summarization') compactions.push(compactionFromEvent(event));
            },
            ...(onLiveTextChunk
                ? {
                    stream: true,
                    onStream: (chunk: { text?: string; isFinal?: boolean }) => {
                        if (chunk.isFinal || !chunk.text) return;
                        try {
                            onLiveTextChunk(chunk.text);
                        } catch (callbackError) {
                            logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
                        }
                    },
                }
                : {}),
            ...(cancellationBridge.signal ? { cancellationToken: cancellationBridge.signal } : {}),
            ...(request.cancellationCell?.deadlineAt !== undefined
                ? { timeoutMs: Math.max(0, request.cancellationCell.deadlineAt - Date.now()) }
                : {}),
        };

        const result: AgentSdkInvokeResult = await sdkAgent.invoke(inputState, liveInvokeConfig)
            .catch((error: unknown) => {
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            })
            .finally(() => cancellationBridge.stop());

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

        const assistantReasoning = extractAgentReasoning(result);

        // 7b. Output guardrail check. Behaviour change over the single-slot
        // version, deliberate: a REDACTION is now applied instead of computed
        // and dropped. The redacted text is what gets stored on the
        // conversation and what gets returned, because a guardrail that
        // rewrites the answer only in the log is not enforcing anything.
        // (`reasoning` is still unchecked — it is not part of the answer the
        // gateway checks either, and gating it belongs with the SDK work that
        // would let a chain-of-thought be withheld separately.)
        // `output.pre` ran inside the agent, on `postModelCall`. A redaction it
        // landed is already in `result.content`, because the plugin rewrites the
        // host's own payload rather than handing a copy back — which is what
        // makes the redaction reach the user instead of only the log. A BLOCK
        // surfaces as a thrown invoke, handled by the catch below.
        //
        // A run a limit or a cancellation cut short has no final answer; the
        // outcome carries why, and the last text the agent did write.
        const outcome = describeTurnOutcome(result, inputState.messages.length);
        const assistantContent = outcome.content;
        const usage = normalizePlaygroundUsage(result.metadata?.usage)?.usage;
        const compactedTools = compactions.length > 0
            ? compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined)
            : [];

        // 8. Update conversation with new messages — the REWRITTEN user turn,
        // and the title cut from the same string.
        const updatedMessages: IAgentConversation['messages'] = [
            ...(conversation.messages || []),
            { role: 'user', content: persistedUserMessage, timestamp: now },
            {
                role: 'assistant',
                content: assistantContent,
                ...(assistantReasoning ? { reasoning: assistantReasoning } : {}),
                ...(outcome.stopReason !== 'completed'
                    ? { stopReason: outcome.stopReason, ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}) }
                    : {}),
                ...(compactions.length > 0 ? { compactions, ...(compactedTools.length > 0 ? { compactedTools } : {}) } : {}),
                ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
                ...(usage ? { usage } : {}),
                timestamp: new Date(),
            },
        ];

        // §12.12: the deadline (sync ceiling, §5) or an async cancel flag
        // (background mode, §7 step 6) may have already decided this turn's
        // outcome while `sdkAgent.invoke()` was in flight — a late-arriving
        // result here must never overwrite that decision by persisting
        // anyway, however complete the answer looks.
        const supersededByDeadlineOrCancel = isCancellationCellTripped(request.cancellationCell);
        if (!supersededByDeadlineOrCancel) {
            await db.updateAgentConversation(conversationId, {
                messages: updatedMessages,
                title: conversation.title === 'New conversation' && updatedMessages.length <= 2
                    ? persistedUserMessage.substring(0, 80)
                    : conversation.title,
            });
            await saveConversationState(db, {
                conversationId,
                tenantId,
                projectId,
                agentKey,
                state: result.state,
                messageCount: updatedMessages.length,
            });
        }

        logger.info(supersededByDeadlineOrCancel ? 'Agent chat completed but superseded (not persisted)' : 'Agent chat completed', {
            agentKey,
            conversationId,
            messageCount: updatedMessages.length,
            persisted: !supersededByDeadlineOrCancel,
            ...(outcome.stopReason !== 'completed' ? { stopReason: outcome.stopReason, stopDetail: outcome.stopDetail } : {}),
        });

        const responseId = `resp_${conversationId}`;
        const msgId = `msg_${Date.now().toString(36)}`;
        const reasoningId = `rs_${Date.now().toString(36)}`;

        return {
            id: responseId,
            object: 'response' as const,
            model: agent.name,
            output: [
                // OpenAI Responses convention: reasoning item precedes the message.
                ...(assistantReasoning
                    ? [
                          {
                              id: reasoningId,
                              type: 'reasoning' as const,
                              summary: [
                                  {
                                      type: 'summary_text' as const,
                                      text: assistantReasoning,
                                  },
                              ],
                          },
                      ]
                    : []),
                {
                    id: msgId,
                    type: 'message' as const,
                    role: 'assistant' as const,
                    content: [
                        {
                            type: 'output_text' as const,
                            text: assistantContent,
                        },
                    ],
                },
            ],
            status: outcome.stopReason === 'completed' ? 'completed' as const : 'incomplete' as const,
            ...(outcome.stopReason !== 'completed'
                ? {
                    incomplete_details: { reason: incompleteReason(outcome.stopReason, outcome.stopDetail) },
                    stop_reason: outcome.stopReason,
                    ...(outcome.stopDetail ? { stop_detail: outcome.stopDetail } : {}),
                }
                : { stop_reason: 'completed' as const }),
            usage: {
                input_tokens: usage?.inputTokens ?? 0,
                output_tokens: usage?.outputTokens ?? 0,
                total_tokens: usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)),
            },
            created_at: Math.floor(Date.now() / 1000),
            previous_response_id: (conversation.messages?.length ?? 0) > 0 ? responseId : null,
            version: resolvedVersion,
            _conversation_messages: updatedMessages,
        };
    } finally {
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
    // The callback can't serialize over the queue — keep it out of the payload
    // (the local fast path still receives the full request).
    const payload = { ...request };
    delete payload.onToolEvent;
    delete payload.onTextChunk;
    return routeInstanceCall(
        {
            entityType: 'agent',
            entityId: agentEntityId(request.tenantId, request.agentKey),
            jobName: 'playground',
        },
        payload as unknown as QueuePayload,
        () => executePlaygroundChatLocal(request),
    );
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
        const sniffedError = Boolean(record?.error) || record?.ok === false;
        const failed = status === 'error' || status === 'rejected' || sniffedError;
        const errorText = failed
            ? (status === 'rejected' ? 'Blocked before the tool ran.' : undefined)
                ?? (record?.error ? String(record.error) : undefined)
                ?? 'The tool call failed.'
            : undefined;

        const rawOutput = entry.rawOutput;
        const rawDiffers = rawOutput !== undefined && rawOutput !== output;

        return {
            id: typeof entry.executionId === 'string' ? entry.executionId : undefined,
            name: typeof entry.toolName === 'string' ? entry.toolName : 'tool',
            args: entry.args,
            output,
            ...(rawDiffers ? { rawOutput } : {}),
            ...(errorText ? { error: errorText } : {}),
            ...(typeof entry.subagent === 'string' ? { subagent: entry.subagent } : {}),
            // Reported as an error even when the SDK called it a success,
            // so the transcript, the Events tab and the per-tool failure
            // count all agree with the error text above.
            ...(failed ? { status: 'error' as const } : status ? { status } : {}),
            ...(entry.fromCache === true ? { fromCache: true } : {}),
            ...(entry.summarized === true ? { summarized: true } : {}),
            ...(typeof entry.originalTokenCount === 'number'
                ? { originalTokenCount: entry.originalTokenCount }
                : {}),
            ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
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
    tenantDbName: string,
    projectId: string,
    modelKey: string | undefined,
    usage: AgentPlaygroundChatResult['usage'],
): Promise<number | undefined> {
    if (!modelKey || !usage) return undefined;
    try {
        const model = await getModelByKey(tenantDbName, modelKey, projectId);
        if (!model?.pricing) return undefined;
        const { calculateCost } = await import('@/lib/services/models/usageLogger');
        return calculateCost(model.pricing, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
        }).totalCost;
    } catch {
        return undefined;
    }
}

function describeStructuredOutputError(error: unknown): string {
    if (typeof error === 'string') return error;
    const record = error as { message?: unknown; issues?: unknown } | null;
    if (record && typeof record.message === 'string') return record.message;
    return JSON.stringify(error);
}

/** Local (non-routed) implementation. Exported so the queue consumer can call it. */
export async function executePlaygroundChatLocal(
    request: AgentPlaygroundChatRequest,
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
    const history = sessionConversation
        ? sessionConversation.messages.map((m) => ({ role: m.role, content: m.content }))
        : request.history;
    // A Session resumes from the state its last turn ended in (tool results,
    // summaries, plan) — the text transcript alone lost all of that. A
    // stateless call has only the history it was handed.
    const carried = sessionConversation ? await loadConversationState(db, sessionConversation) : null;

    // Context entered when the session was started applies to every turn in it.
    // Merged UNDER the request's own context so a per-message override still
    // wins — and merged per-key rather than wholesale, or setting one header on
    // one turn would silently drop the session's whole context for that turn.
    const sessionContext = sessionConversation?.metadata?.runtimeContext as AgentRuntimeContext | undefined;
    const runtimeContext: AgentRuntimeContext | undefined = sessionContext
        ? {
            ...sessionContext,
            ...request.runtimeContext,
            headers: { ...sessionContext.headers, ...request.runtimeContext?.headers },
            metadata: { ...sessionContext.metadata, ...request.runtimeContext?.metadata },
        }
        : request.runtimeContext;

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

    // Connected (external) agent — invoke over HTTP, skip local runtime.
    //
    // Same enforcement surface as the live path, and for the same reason: the
    // remote runtime owns its tools, so `tool.pre` / `tool.post` are NOT
    // enforceable here and no tool guard is built. Only `input.pre` and
    // `output.pre` run — and they run with the same helper the live path uses,
    // so an operator testing a connected agent's policy in the playground is
    // testing what production will actually apply.
    if (config.kind === 'external' && config.connection) {
        warnUnservableExternalBindings(config, agentKey);

        const guardedMessage = await evaluateBoundGuardrails({
            tenantDbName,
            tenantId,
            projectId,
            config,
            hook: 'input.pre',
            text: userMessage,
            source: 'agent-playground',
        });

        const { content } = await invokeExternalAgent(
            config.connection,
            [...(history || []), { role: 'user', content: guardedMessage }],
            { tenantDbName, tenantId, projectId },
            resolveRuntimeHeaders(runtimeContext, 'agent', agentKey, config.connection.runtimeHeaders),
        );

        // Redacting here is still the only enforcement point for a STATELESS
        // call (no session) — the returned string is the only copy. For a
        // Session, persistence below writes this same guarded text, never
        // the raw upstream `content`.
        const guardedContent = await evaluateBoundGuardrails({
            tenantDbName,
            tenantId,
            projectId,
            config,
            hook: 'output.pre',
            text: content,
            source: 'agent-playground',
        });

        const externalResult: AgentPlaygroundChatResult = { content: guardedContent, version: ranVersion };
        if (sessionConversation) {
            await persistSessionTurn(db, sessionConversation, userMessage, externalResult);
        }

        logger.info('Connected agent playground chat completed', { agentKey });
        return externalResult;
    }

    // Resolve model
    if (!config.modelKey) throw new Error('Agent has no model configured');
    const model = await getModelByKey(tenantDbName, config.modelKey, projectId);
    if (!model) throw new Error(`Model "${config.modelKey}" not found`);
    if (model.category !== 'llm') throw new Error('Configured model is not compatible with chat');

    const { runtime } = await buildModelRuntime(tenantDbName, tenantId, model.providerKey, projectId);
    if (!runtime.createChatModel) {
        throw new Error('Provider runtime does not support chat model creation');
    }

    // Resolved through the gateway's helper so an agent obeys the same model
    // record everything else does. Previously this built its own settings object
    // and never read `model.settings`, which meant: a hard-coded temperature of
    // 0.7 reached models that reject the parameter outright, the operator could
    // not override it from the Model Hub, and `top_p`/`max_tokens` were passed
    // under snake_case keys the contract layer does not read — so an agent's
    // Top P and Max Tokens settings had never taken effect at all.
    const lcModel = runtime.createChatModel({
        modelId: model.modelId,
        category: model.category,
        modelSettings: resolveModelInvocationConfig(model, {
            ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
            ...(config.topP !== undefined ? { top_p: config.topP } : {}),
            ...(config.maxTokens !== undefined ? { max_tokens: config.maxTokens } : {}),
        }).modelSettings,
    });

    // Resolve system prompt. Same helper as the live path: a prompt that renders
    // differently in the playground is a prompt nobody can test.
    let systemPrompt = config.systemPrompt;
    const promptVariables = buildPromptVariables({
        config,
        agentKey,
        agentName: agent.name,
        runtimeContext: runtimeContext,
    });
    if (!systemPrompt && config.promptKey) {
        const prompt = await db.findPromptByKey(config.promptKey, projectId);
        if (prompt) {
            const rendered = renderPromptTemplate(prompt.template, promptVariables);
            systemPrompt = rendered.text;
            reportPromptVariables(rendered, { agentKey, promptKey: config.promptKey });
        }
    } else if (systemPrompt && shouldRenderInlinePrompt(config, systemPrompt)) {
        const rendered = renderPromptTemplate(systemPrompt, promptVariables);
        systemPrompt = rendered.text;
        reportPromptVariables(rendered, { agentKey });
    }

    // Guardrails. Same guard and same helper as the live chat path, on purpose:
    // an operator testing a policy in the playground has to be testing what
    // production will run.
    warnUnservableAgentBindings(config, agentKey);
    const toolGuard = createAgentToolGuard({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        // The playground carries no authenticated principal down to here, so
        // the agent stands in for itself. `roles` is `['agent']` either way,
        // which is what `tool_access.allowedRoles` matches on — so a policy
        // verified here behaves the same in production.
        actorId: `agent:${agentKey}`,
        source: 'agent-playground',
    });

    // Same move as the live path: the text hooks run inside the agent now.
    // `source` stays 'agent-playground' so the evaluation log still separates a
    // rehearsal from production traffic.
    const guardrailPlugins = await buildAgentGuardrailPlugins({
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        config,
        actorId: `agent:${agentKey}`,
        source: 'agent-playground',
    });
    const guardedUserMessage = userMessage;

    // Build RAG retrieval tool if knowledge engine is configured
    const { createSmartAgent, fromLangchainModel, createTool } = await import('@cognipeer/agent-sdk');
    const { z } = await import('zod');

    const playgroundTools: AgentSdkToolInterface[] = [];
    const playgroundToolDefinitions: TraceToolDefinition[] = [];
    if (config.knowledgeEngineKey) {
        const knowledgeTools = await buildKnowledgeTools(
            tenantDbName, tenantId, config.knowledgeEngineKey, toolGuard,
        );
        playgroundTools.push(...knowledgeTools.tools);
        playgroundToolDefinitions.push(...knowledgeTools.toolDefinitions);
    }

    if (config.knowledgeEngineKey) {
        const knowledgeSearchInstruction = [
            'Knowledge-base-first policy:',
            '- For user questions that are factual, documentation, API, setup, troubleshooting, or product-behavior related, call `knowledge_search` first.',
            '- Do not provide a final answer before at least one `knowledge_search` attempt unless the request is purely conversational.',
            '- After retrieval, answer using the retrieved content; if retrieval is empty, say you are not fully certain and provide the best concise answer.',
        ].join('\n');
        systemPrompt = systemPrompt
            ? `${knowledgeSearchInstruction}\n\n${systemPrompt}`
            : knowledgeSearchInstruction;
    }

    // Build bound tools from toolBindings (MCP, future sources)
    const {
        cleanupTasks,
        tools: boundPlaygroundTools,
        definitions: boundPlaygroundToolDefinitions,
    } = await buildBoundTools(
        tenantDbName,
        tenantId,
        projectId,
        config.toolBindings,
        createTool,
        z,
        toolGuard,
        runtimeContext,
    );
    playgroundTools.push(...boundPlaygroundTools);
    playgroundToolDefinitions.push(...boundPlaygroundToolDefinitions);

    // Same memory toolset the live path binds — a playground that hands the
    // agent a different set of tools is not testing the agent.
    // Non-fatal failures during the run (memory today), reported with the answer.
    const warnings = new Set<string>();
    const playgroundMemoryOption = buildAgentMemoryOption(config.memory, {
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversationId: sessionConversation ? String(sessionConversation._id) : undefined,
        userId: runtimeContext?.userId,
        onWarning: (message) => warnings.add(message),
    });
    const playgroundMemoryToolMode = config.memory?.tools ?? 'readwrite';
    if (playgroundMemoryOption?.store && playgroundMemoryToolMode !== 'off') {
        const allowWrites = playgroundMemoryToolMode === 'readwrite';
        playgroundTools.push(...buildMemoryTools({
            store: playgroundMemoryOption.store,
            scope: playgroundMemoryOption.scope ?? 'workspace',
            createToolFn: createTool,
            zod: z,
            guard: toolGuard,
            allowWrites,
        }));
        playgroundToolDefinitions.push(...memoryToolDefinitions(allowWrites));
    }

    // Same sandbox access the live path gives the agent — a Session keeps
    // a persistent sandbox across its turns, a stateless call gets a
    // throwaway one.
    const playgroundSandboxTools = await buildAgentSandboxTools({
        sandbox: config.sandbox,
        tenantDbName,
        tenantId,
        projectId,
        agentKey,
        conversation: sessionConversation,
        createToolFn: createTool,
        zod: z,
        protect: (name, tool) => protectBuiltTool(toolGuard, { name, requestedName: tool.name }, tool),
        onWarning: (message) => warnings.add(message),
    });
    playgroundTools.push(...playgroundSandboxTools.tools);
    playgroundToolDefinitions.push(...playgroundSandboxTools.definitions);
    cleanupTasks.push(playgroundSandboxTools.cleanup);

    // The GUARDED message is what the model sees — the single-slot version
    // computed a redaction here and then sent the raw text anyway.
    const inputState = buildTurnInputState({
        carried,
        transcript: history || [],
        userMessage: guardedUserMessage,
        systemPrompt,
    });
    const priorExecutionIds = new Set(
        (carried?.toolHistory ?? [])
            .map((entry) => (entry as { executionId?: unknown }).executionId)
            .filter((id): id is string => typeof id === 'string'),
    );

    // Create agent-sdk instance and invoke (tracing enabled)
    // Wrapped so a streamed turn keeps its tool calls and usage — see
    // assembledStream.ts for what agent-sdk 0.10.1 drops without it.
    // Usage-tapped: agent calls bypass the gateway, so without this they
    // never reached Model Hub or the bill — see modelUsageTap.ts.
    const sdkModel = withModelUsageLogging(withStrictToolCalling(withAssembledStream(fromLangchainModel(lcModel))), {
        tenantDbName,
        model,
        route: 'agent.playground',
        agentKey,
    });
    const tracingSink = await createInternalTracingSink(
        tenantDbName,
        tenantId,
        projectId,
        playgroundToolDefinitions,
    );

    const playgroundSubagents = await buildAgentSubagents({
        tenantDbName,
        tenantId,
        projectId,
        subagents: config.subagents,
        createToolFn: createTool,
        zod: z,
        guard: toolGuard,
        runtimeContext: runtimeContext,
    });
    cleanupTasks.push(...playgroundSubagents.cleanupTasks);

    const playgroundSkills = await buildAgentSkills(tenantDbName, projectId, config.skills);

    const sdkAgent = createConsoleSdkAgent(createSmartAgent, {
        name: agent.name,
        model: sdkModel,
        tools: playgroundTools,
        systemPrompt,
        tracingSink,
        plugins: guardrailPlugins,
        runtimeOptions: resolveAgentRuntimeOptions(config),
        outputSchema: resolveStructuredOutputSchema(config.structuredOutput),
        subagents: playgroundSubagents.subagents,
        skills: playgroundSkills,
        skillPolicy: resolveAgentSkillPolicy(config),
        memory: playgroundMemoryOption,
        costEstimator: await buildAgentCostEstimator(tenantDbName, projectId, config, model),
    });

    // Surface progress to the caller (best-effort; never fails the run).
    const { onToolEvent, onTextChunk, onCompaction } = request;
    const compactions: AgentTurnCompaction[] = [];
    const invokeConfig = {
        onEvent: (event: AgentSdkEvent) => {
            if (event.type === 'summarization') {
                // Collected for the turn record either way; forwarded live
                // so a session shows the compaction as it happens.
                const compaction = compactionFromEvent(event);
                compactions.push(compaction);
                try {
                    onCompaction?.(compaction);
                } catch (callbackError) {
                    logger.warn('onCompaction callback failed', { agentKey, error: callbackError });
                }
                return;
            }
            if (!onToolEvent || event.type !== 'tool_call' || !event.name) return;
            if (event.phase !== 'start' && event.phase !== 'success' && event.phase !== 'error') return;
            try {
                onToolEvent({
                    phase: event.phase,
                    name: event.name,
                    id: event.id,
                    ...(event.args !== undefined ? { args: event.args } : {}),
                    ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
                    ...(event.error?.message ? { error: event.error.message } : {}),
                });
            } catch (callbackError) {
                logger.warn('onToolEvent callback failed', { agentKey, error: callbackError });
            }
        },
        ...(onTextChunk ? {
            // `stream: true` is what actually turns provider deltas on —
            // with only `onStream` the SDK fires it exactly once, at the
            // end, with the whole answer.
            stream: true,
            onStream: (chunk: { text?: string; isFinal?: boolean }) => {
                // That same terminal call repeats the FULL content, so
                // forwarding it would print the answer twice: once
                // streamed, once again in one burst.
                if (chunk.isFinal || !chunk.text) return;
                try {
                    onTextChunk(chunk.text);
                } catch (callbackError) {
                    logger.warn('onTextChunk callback failed', { agentKey, error: callbackError });
                }
            },
        } : {}),
    };

    const invokeStartedAt = Date.now();
    try {
        const result: AgentSdkInvokeResult = await sdkAgent.invoke(inputState, invokeConfig)
            .catch((error: unknown) => {
                throw annotateAgentRunError(error, { modelKey: model.key, providerKey: model.providerKey });
            });

        const blocked = guardrailBlockedError(result);
        if (blocked) throw blocked;

        const assistantReasoning = extractAgentReasoning(result);

        // Output guardrail check. Three defects fixed by going through the
        // shared helper: this site ran under the `input.pre` hook (no `phase`
        // was passed, and 'input' is the default), it blocked on the record's
        // legacy `action` column rather than on whether a finding actually
        // fired, and it dropped any redaction. All three meant a policy
        // verified in the playground was not the policy production ran.
        // Already adjudicated by the plugin's `postModelCall`; see the live path.
        //
        // A run a limit or a cancellation cut short has no final answer; the
        // outcome carries why, and the last text the agent did write.
        const outcome = describeTurnOutcome(result, inputState.messages.length);
        const compactedTools = compactions.length > 0
            ? compactedToolResults(inputState.messages, result.state?.messages as AgentSdkMessage[] | undefined)
            : [];

        logger.info('Playground chat completed', {
            agentKey,
            ...(outcome.stopReason !== 'completed' ? { stopReason: outcome.stopReason, stopDetail: outcome.stopDetail } : {}),
        });

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
            version: ranVersion,
            ...(outcome.stopReason !== 'completed'
                ? { stopReason: outcome.stopReason, ...(outcome.stopDetail ? { stopDetail: outcome.stopDetail } : {}) }
                : {}),
            ...(compactions.length > 0 ? { compactions } : {}),
            ...(compactedTools.length > 0 ? { compactedTools } : {}),
            ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
        };

        const costUsd = await priceTurn(tenantDbName, projectId, config.modelKey, playgroundResult.usage);
        if (costUsd !== undefined && playgroundResult.usage) {
            playgroundResult.usage.costUsd = costUsd;
        }

        if (sessionConversation) {
            const messageCount = await persistSessionTurn(db, sessionConversation, userMessage, playgroundResult);
            if (messageCount !== undefined) {
                await saveConversationState(db, {
                    conversationId: String(sessionConversation._id),
                    tenantId,
                    projectId,
                    agentKey,
                    state: result.state,
                    messageCount,
                });
            }
        }

        return playgroundResult;
    } finally {
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
): Promise<number | undefined> {
    try {
        const now = new Date();
        const messages: IAgentConversation['messages'] = [
            ...conversation.messages,
            { role: 'user', content: userMessage, timestamp: now },
            {
                role: 'assistant',
                content: result.content,
                timestamp: now,
                ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                ...(result.steps && result.steps.length > 0 ? { steps: result.steps } : {}),
                ...(result.output !== undefined ? { output: result.output } : {}),
                ...(result.outputError ? { outputError: result.outputError } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
                ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
                ...(result.stopReason ? { stopReason: result.stopReason } : {}),
                ...(result.stopDetail ? { stopDetail: result.stopDetail } : {}),
                ...(result.compactions?.length ? { compactions: result.compactions } : {}),
                ...(result.compactedTools?.length ? { compactedTools: result.compactedTools } : {}),
                ...(result.warnings?.length ? { warnings: result.warnings } : {}),
                version: result.version ?? null,
            },
        ];
        await db.updateAgentConversation(String(conversation._id), {
            messages,
            // First exchange in a freshly-created "New session" names itself
            // after what was actually asked, same convention the live chat
            // path already uses for its conversation titles.
            title: (!conversation.title || conversation.title === 'New conversation') && messages.length <= 2
                ? userMessage.substring(0, 80)
                : conversation.title,
        });
        return messages.length;
    } catch (error) {
        logger.error('Failed to persist session turn', {
            conversationId: String(conversation._id),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
