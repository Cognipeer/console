/**
 * Tool guard of an agent run: the canonical policy name of a tool, the
 * `tool.pre` / `tool.post` hooks wrapped around every built tool, and the
 * result a blocked call returns.
 */

import { randomUUID } from 'node:crypto';
import type { ToolInterface as AgentSdkToolInterface } from '@cognipeer/agent-sdk';
import { GUARDRAIL_CONTRACT_VERSION, GuardrailEnforcementError, runHook, toolCallSubject, toolResultSubject } from '@/lib/services/guardrail';
import type { HookScope, HookVerdict } from '@/lib/services/guardrail';
import { resolveBindings } from '@/lib/services/guardrail/hooks/binding';
import type { GuardrailBindingSource } from '@/lib/services/guardrail/hooks/binding';
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('agents');

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
 *   agent.channel.<toolName>               the channel system tools (`slack_send_direct_message`…)
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
 * MCP tools keep the MCP layer's spelling, `<serverKey>/<toolName>` (as
 * `mcpHook` names them one layer down), so a policy written for a server's tool
 * matches on both layers.
 */
export function agentToolPolicyName(...segments: readonly string[]): string {
    return ['agent', ...segments].join('.');
}

/** What one guarded tool call needs to identify itself to policy. */
interface AgentToolSpec {
    /** Canonical policy name — see `agentToolPolicyName`. */
    name: string;
    /** The name the model actually called, before any canonicalisation. */
    requestedName: string;
    /**
     * Guardrails a lower layer evaluates on every call of this tool (an MCP
     * server's own guardrail): skipped here, so a guardrail bound on both
     * layers runs once per call.
     */
    skipGuardrailKeys?: readonly string[];
    /**
     * For a tool whose values must not be stored (a tool of an MCP server with
     * PII protection): what the evaluation log keeps instead, the arguments and
     * the result as they crossed to the upstream, and finding messages masked
     * the same way. The hooks still judge the real values. A side the view cannot
     * give is withheld from the log.
     */
    logView?: {
        /** Once per call, before the hooks run: the arguments as they leave, and the masker for finding messages. */
        open(args: Record<string, unknown>): Promise<AgentToolLogView>;
        /** Called after the call returned, with the arguments it was made with. */
        result(args: Record<string, unknown>): unknown;
    };
}

/** What the evaluation log of one protected call may keep. */
export interface AgentToolLogView {
    args?: Record<string, unknown>;
    mask?: (text: string) => Promise<string>;
}

/** What the evaluation log keeps for a side of a protected call that has no tokenized view. */
const WITHHELD_LOG_TEXT = 'Not logged: PII protection is on for this tool';

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
export interface AgentToolGuard {
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
            const skipped = new Set(spec.skipGuardrailKeys ?? []);
            const callPreKeys = preKeys.filter((key) => !skipped.has(key));
            const callPostKeys = postKeys.filter((key) => !skipped.has(key));
            if (callPreKeys.length === 0 && callPostKeys.length === 0) return execute;
            const { logView } = spec;

            return async (args: A, ...rest: unknown[]) => {
                const scope = scopeForCall();
                // Made before the hooks run: a call they block is logged without the values too.
                const view: AgentToolLogView | undefined = logView
                    ? await logView.open(args).catch((): AgentToolLogView => ({}))
                    : undefined;
                const logMask = view?.mask ? { logMask: view.mask } : {};
                try {
                    let safeArgs = args;

                    if (callPreKeys.length > 0) {
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
                            guardrailKeys: callPreKeys,
                            ...(view
                                ? {
                                    logText: view.args
                                        ? toolCallSubject({ toolName: spec.name, args: view.args, providerRef }).text
                                        : WITHHELD_LOG_TEXT,
                                    ...logMask,
                                }
                                : {}),
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
                    if (callPostKeys.length === 0) return result;

                    let logText: string | undefined;
                    if (logView && view) {
                        const loggedResult = logView.result(safeArgs);
                        logText = loggedResult === undefined
                            ? WITHHELD_LOG_TEXT
                            : toolResultSubject({ toolName: spec.name, args: {}, result: loggedResult, providerRef }).text;
                    }
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
                        guardrailKeys: callPostKeys,
                        ...(logText !== undefined ? { logText, ...logMask } : {}),
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
export function protectBuiltTool(
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
