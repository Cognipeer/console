/**
 * Human in the loop, configuration side: which tool calls wait for a person,
 * whether the model may ask the user a question, how long a request lives, who
 * may answer it. The runtime side — pausing, resolving, resuming — is in
 * `agentPendingActions.ts` / `agentActionResolution.ts`.
 *
 * An agent without `config.humanInTheLoop` (every agent that existed before
 * this) resolves to "off": nothing pauses, exactly as before.
 */

import type {
    AgentHitlUnattendedPolicy,
    AgentToolApprovalException,
    AgentToolApprovalPolicy,
    IAgentConfig,
    IAgentHumanInTheLoopConfig,
} from '@/lib/database';
import {
    HitlBlockedCallError,
    approvalReasonOf,
    decideToolCall,
    normalizeToolExceptions,
    validateToolExceptions,
    type HitlCallDecision,
    type HitlCallLog,
    type ToolPolicySource,
} from './agentHitlExceptions';

/**
 * Tools that only READ (and the agent's own file-writing tools, which never touch anything outside
 * the session). They follow `toolApproval.tools[name]` when one is set
 * and are otherwise never asked about — approving every knowledge lookup would
 * make the feature unusable. Everything else Console builds (bound / MCP /
 * custom tools, memory writes, sandbox_exec / run_code / write_file) follows
 * the default policy.
 *
 * SDK-internal tools (todo, context, delegation, skills, `get_tool_response`…)
 * are not in the list because they are never gated at all: only tools Console
 * builds get `needsApproval`.
 */
export const HITL_READ_ONLY_TOOLS: readonly string[] = [
    'memory_search',
    // `read` replaces the next three; the old names stay for stored configs.
    'read',
    'sandbox_read_file',
    'sandbox_list_files',
    'sandbox_preview_link',
    'web_search',
    'web_fetch',
    // Read an attached session file (sessionFiles.ts).
    'session_files_list',
    'session_files_read',
    'session_files_view_image',
    // The agent's own text files for the user (agentFileOutputTools.ts): scratch output of the run, delivered after the turn.
    'session_files_create',
    'session_files_append',
    // The agent's own reminders in this session (agentReminderTools.ts): reading them and taking one back.
    // Setting one (`reminder_set`) follows the policy like any other write.
    'reminder_list',
    'reminder_cancel',
    // The SDK's own ask-user tool: asking IS the human step.
    'ask_user_question',
];

/** Every tool whose name starts with one of these is read-only (`knowledge_search`, `knowledge_read_document`…). */
export const HITL_READ_ONLY_TOOL_PREFIXES: readonly string[] = ['knowledge_'];

export function isReadOnlyTool(toolName: string): boolean {
    return HITL_READ_ONLY_TOOLS.includes(toolName)
        || HITL_READ_ONLY_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

/** Defaults of the settings below — used when the stored config leaves one out. */
export const HITL_DEFAULTS = {
    timeoutMinutes: 1440,
    onTimeout: 'deny',
    approvers: 'owner_or_admin',
    onUserMessageWhilePending: 'reject',
    defaultPolicy: 'always',
    allowFreeText: true,
    unattended: 'deny',
} as const;

/**
 * What a NEW agent created from the dashboard stores. Agents created through
 * the client API without the field get nothing — their callers never expected
 * a run to stop and wait.
 */
export const DASHBOARD_AGENT_HITL_DEFAULTS: IAgentHumanInTheLoopConfig = {
    toolApproval: { enabled: true, defaultPolicy: 'always' },
    askUser: { enabled: false, allowFreeText: true },
};

export interface ResolvedHitlConfig {
    toolApprovalEnabled: boolean;
    defaultPolicy: AgentToolApprovalPolicy;
    toolPolicies: Record<string, AgentToolApprovalPolicy>;
    /** Per-tool exceptions judged on a call's arguments (`agentHitlExceptions.ts`); malformed ones left out. */
    toolExceptions: Record<string, AgentToolApprovalException[]>;
    askUserEnabled: boolean;
    allowFreeText: boolean;
    /** 0 = never expires. */
    timeoutMinutes: number;
    onTimeout: 'deny' | 'cancel';
    approvers: 'owner' | 'owner_or_admin' | 'project_members';
    onUserMessageWhilePending: 'reject' | 'cancel_pending';
    /** What a gated tool call or a question does on a run with nobody to answer. */
    unattended: AgentHitlUnattendedPolicy;
}

/** True when the agent can ever pause (a tool approval or a question is switched on). */
export function hitlCanPause(resolved: ResolvedHitlConfig): boolean {
    return resolved.toolApprovalEnabled || resolved.askUserEnabled;
}

/** `read` replaced these tools; a policy an admin stored for one of them keeps applying (the stricter wins). */
const REPLACED_BY_READ = ['sandbox_read_file', 'session_files_read', 'session_files_view_image'] as const;

function carryOverReadPolicies(policies: Record<string, AgentToolApprovalPolicy>): Record<string, AgentToolApprovalPolicy> {
    if (policies.read === 'always') return policies;
    const old = REPLACED_BY_READ.map((name) => policies[name]).filter((policy) => policy === 'always' || policy === 'never');
    if (old.includes('always')) policies.read = 'always';
    else if (policies.read === undefined && old.length > 0) policies.read = 'never';
    return policies;
}

export function resolveHitlConfig(
    hitl: IAgentConfig['humanInTheLoop'] | undefined,
): ResolvedHitlConfig {
    const approval = hitl?.toolApproval;
    const timeout = hitl?.timeoutMinutes;
    return {
        toolApprovalEnabled: approval?.enabled === true,
        defaultPolicy: approval?.defaultPolicy === 'never' ? 'never' : HITL_DEFAULTS.defaultPolicy,
        toolPolicies: carryOverReadPolicies(approval?.tools && typeof approval.tools === 'object' ? { ...approval.tools } : {}),
        toolExceptions: normalizeToolExceptions(approval?.exceptions),
        askUserEnabled: hitl?.askUser?.enabled === true,
        allowFreeText: hitl?.askUser?.allowFreeText !== false,
        timeoutMinutes: typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0
            ? timeout
            : HITL_DEFAULTS.timeoutMinutes,
        onTimeout: hitl?.onTimeout === 'cancel' ? 'cancel' : HITL_DEFAULTS.onTimeout,
        approvers: hitl?.approvers === 'owner' || hitl?.approvers === 'project_members'
            ? hitl.approvers
            : HITL_DEFAULTS.approvers,
        onUserMessageWhilePending: hitl?.onUserMessageWhilePending === 'cancel_pending'
            ? 'cancel_pending'
            : HITL_DEFAULTS.onUserMessageWhilePending,
        unattended: hitl?.unattended === 'pause' || hitl?.unattended === 'allow'
            ? hitl.unattended
            : HITL_DEFAULTS.unattended,
    };
}

/**
 * The effective policy for one tool: an explicit per-tool setting wins, then
 * the read-only exemption, then the agent's default.
 */
export function toolApprovalPolicy(resolved: ResolvedHitlConfig, toolName: string): AgentToolApprovalPolicy {
    const explicit = resolved.toolPolicies[toolName];
    if (explicit === 'always' || explicit === 'never') return explicit;
    if (isReadOnlyTool(toolName)) return 'never';
    return resolved.defaultPolicy;
}

/** What decides a tool's own setting (see {@link toolApprovalPolicy}): what a call that asks was asked by. */
export function toolApprovalPolicySource(resolved: ResolvedHitlConfig, toolName: string): ToolPolicySource {
    const explicit = resolved.toolPolicies[toolName];
    if (explicit === 'always' || explicit === 'never') return 'tool_policy';
    if (isReadOnlyTool(toolName)) return 'read_only';
    return 'default_policy';
}

/** The verdict for one call of a tool: the strictest of its matching exceptions, else its own setting. */
export function toolCallDecision(resolved: ResolvedHitlConfig, toolName: string, args: unknown): HitlCallDecision {
    return decideToolCall(
        { policy: toolApprovalPolicy(resolved, toolName), source: toolApprovalPolicySource(resolved, toolName) },
        resolved.toolExceptions[toolName],
        args,
    );
}

/** The session allow-list ("don't ask again for this tool in this session"). */
export function sessionAllowedTools(metadata: Record<string, unknown> | undefined): Set<string> {
    const raw = metadata?.hitlAllowedTools;
    return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : []);
}

type ToolRecord = { name?: string; needsApproval?: unknown; approvalPrompt?: unknown };

/** Whether the tool has exceptions, i.e. is decided per call rather than one way for every call. */
function hasExceptions(resolved: ResolvedHitlConfig, name: string): boolean {
    return (resolved.toolExceptions[name]?.length ?? 0) > 0;
}

function hasDenyException(resolved: ResolvedHitlConfig, name: string): boolean {
    return resolved.toolExceptions[name]?.some((exception) => exception.action === 'deny') ?? false;
}

/**
 * Does this call wait for a person? The session allow-list ("don't ask again
 * for this tool") skips the tool's own setting, never an exception: that was
 * written for exactly these arguments.
 */
function callAsks(decision: HitlCallDecision, allowedTools: ReadonlySet<string>, name: string): boolean {
    if (decision.action !== 'ask') return false;
    return decision.source === 'exception' || !allowedTools.has(name);
}

/** What a gate set on the tool before this one (another side's) says about the call. */
function priorAsks(tool: ToolRecord, args: unknown): boolean {
    const prior = tool.needsApproval;
    if (typeof prior === 'function') {
        try {
            return Boolean((prior as (input: unknown) => unknown)(args));
        } catch {
            // The SDK reads a predicate that throws as "ask"; so does this.
            return true;
        }
    }
    return prior === true;
}

/** The approval prompt already on the tool (its own, or another side's), for these arguments. */
function promptOf(tool: ToolRecord, args: unknown): string | undefined {
    const own = tool.approvalPrompt;
    if (typeof own === 'function') {
        try {
            const text = (own as (input: unknown) => unknown)(args);
            return typeof text === 'string' && text ? text : undefined;
        } catch {
            return undefined;
        }
    }
    return typeof own === 'string' && own ? own : undefined;
}

/**
 * Returns the tools with `needsApproval` set per the agent's policy; the input
 * array is not mutated. A tool that never needs approval (policy `never` and no
 * exceptions, or toolApproval off) is returned untouched, so an agent without
 * the feature hands the SDK exactly the tools it did before.
 *
 * The SDK gets a predicate rather than `true`: a tool the user chose to "allow
 * for this session" stops asking without rebuilding the tool, and a tool with
 * exceptions is decided on each call's arguments. Its `approvalPrompt` says why
 * a call waits; the SDK stores it on the approval and in the trace, and `log`
 * keeps the structured reason for the pending action. A call an exception
 * refuses never asks: the tool's execution throws {@link HitlBlockedCallError}.
 *
 * A gate already on the tool (another side's, see {@link gateChildTools}) is
 * kept: the call asks when either side asks.
 */
export function applyToolApprovals<T extends ToolRecord>(
    tools: T[],
    resolved: ResolvedHitlConfig,
    allowedTools: ReadonlySet<string>,
    log?: HitlCallLog,
): T[] {
    if (!resolved.toolApprovalEnabled) return tools;
    return tools.map((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : '';
        if (!name) return tool;
        const perCall = hasExceptions(resolved, name);
        if (!perCall && toolApprovalPolicy(resolved, name) !== 'always') return tool;
        const asks = (args: unknown) => {
            const decision = toolCallDecision(resolved, name, args);
            // A call an exception lets through is recorded, so its step can show the rule.
            if (decision.source === 'exception' && decision.action === 'allow') log?.note(name, args, decision);
            return callAsks(decision, allowedTools, name);
        };
        const gated: T = {
            ...tool,
            needsApproval: tool.needsApproval === undefined ? asks : (args: unknown) => priorAsks(tool, args) || asks(args),
            approvalPrompt: (args: unknown) => {
                if (priorAsks(tool, args)) return promptOf(tool, args);
                const decision = toolCallDecision(resolved, name, args);
                if (decision.action !== 'ask') return promptOf(tool, args);
                log?.note(name, args, decision);
                return promptOf(tool, args) ?? approvalReasonOf(name, decision).text;
            },
        };
        if (!hasDenyException(resolved, name)) return gated;
        return refuseCalls(gated, (args) => blockedCall(resolved, name, args, log));
    });
}

/** The refusal of a call an exception blocks, or null. */
function blockedCall(resolved: ResolvedHitlConfig, name: string, args: unknown, log?: HitlCallLog): Error | null {
    const decision = toolCallDecision(resolved, name, args);
    if (decision.action !== 'deny' || !decision.exception) return null;
    log?.note(name, args, decision);
    return new HitlBlockedCallError(name, decision.exception);
}

/** What a denied call tells the model: the tool did not run, and why. */
export const UNATTENDED_DENIED_MESSAGE = 'This tool needs human approval and no approver is available in this run.';

/** Thrown in place of a call that would wait for approval on a run nobody can answer (decided per call). */
export class HitlUnattendedCallError extends Error {
    constructor() {
        super(UNATTENDED_DENIED_MESSAGE);
        this.name = 'HitlUnattendedCallError';
    }
}

function isHitlRefusal(error: unknown): boolean {
    return error instanceof HitlBlockedCallError || error instanceof HitlUnattendedCallError;
}

const TOOL_CALLABLE_KEYS = ['func', 'invoke', 'call', '_call', 'run'] as const;

/**
 * The tool with each way of running it checking the call first: a call
 * `refusal` names an error for throws it instead of running. A refusal is a
 * decision, so it is never retried, and no cached result is served in its place.
 */
function refuseCalls<T extends ToolRecord>(tool: T, refusal: (args: unknown) => Error | null): T {
    const checked: Record<string, unknown> = { ...tool };
    for (const key of TOOL_CALLABLE_KEYS) {
        const original = checked[key];
        if (typeof original !== 'function') continue;
        checked[key] = async function (this: unknown, input: unknown, ...rest: unknown[]) {
            const refused = refusal(input);
            if (refused) throw refused;
            return (original as (...params: unknown[]) => unknown).apply(this, [input, ...rest]);
        };
    }
    const retry = checked.retry;
    if (retry && typeof retry === 'object') {
        const own = (retry as { shouldRetry?: unknown }).shouldRetry;
        checked.retry = {
            ...retry,
            shouldRetry: (error: unknown, attempt: number) => !isHitlRefusal(error)
                && (typeof own === 'function' ? Boolean((own as (e: unknown, n: number) => unknown)(error, attempt)) : true),
        };
    }
    delete checked.cache;
    return checked as T;
}

/**
 * The tools of a run that runs gated calls without anyone approving them
 * (`unattended: allow`): nothing asks, but a call an exception blocks is still
 * refused — "run without approval" never meant "run what a rule forbids".
 */
export function applyToolBlocks<T extends ToolRecord>(
    tools: T[],
    resolved: ResolvedHitlConfig,
    log?: HitlCallLog,
): T[] {
    if (!resolved.toolApprovalEnabled) return tools;
    return tools.map((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : '';
        if (!name || !hasDenyException(resolved, name)) return tool;
        return refuseCalls(tool, (args) => blockedCall(resolved, name, args, log));
    });
}

/**
 * How the agent's human-in-the-loop settings apply to ONE run:
 *  - `ask`: the run pauses for a person (approvals gate the tools, the model may ask a question);
 *  - `deny`: nobody can answer, so a gated tool call fails and the question tool is not offered;
 *  - `allow`: nothing is gated (the owner opted in for unattended runs, or the agent has no settings).
 */
export type HitlRunMode = 'ask' | 'deny' | 'allow';

/**
 * Picks the mode of a run. `unattended` = no interactive user on it (a
 * schedule, an evaluation, an OpenAI-shaped client…); the agent's
 * own `unattended` setting then decides. `canPause: false` = there is nowhere
 * to park a paused turn (a stateless playground call has no conversation), so
 * `pause` cannot be honoured there and degrades to `deny` — never to `allow`.
 */
export function resolveHitlRunMode(
    resolved: ResolvedHitlConfig,
    run: { unattended?: boolean; canPause?: boolean },
): HitlRunMode {
    if (!hitlCanPause(resolved)) return 'allow';
    const canPause = run.canPause !== false;
    if (!run.unattended && canPause) return 'ask';
    return unattendedMode(resolved.unattended, canPause);
}

function unattendedMode(policy: AgentHitlUnattendedPolicy, canPause: boolean): HitlRunMode {
    if (policy === 'allow') return 'allow';
    if (policy === 'pause' && canPause) return 'ask';
    return 'deny';
}

/**
 * The tools of a run nobody can answer, for the `deny` mode: a tool that would
 * have waited for approval is returned with its execution replaced by one that
 * throws {@link UNATTENDED_DENIED_MESSAGE}. The SDK turns a throw into an
 * error tool result the model reads and carries on from, records the call as
 * a failed step, and emits the same `tool_call` start / error events a failing
 * tool does — so the denial shows up in the session log. The real tool never
 * runs. A tool the user allowed for this session (the allow-list) is left as it
 * is, as is every tool that would not have asked.
 */
export function denyUnattendedTools<T extends ToolRecord>(
    tools: T[],
    resolved: ResolvedHitlConfig,
    allowedTools: ReadonlySet<string>,
    log?: HitlCallLog,
): T[] {
    if (!resolved.toolApprovalEnabled) return tools;
    const refuse = async (): Promise<never> => {
        throw new Error(UNATTENDED_DENIED_MESSAGE);
    };
    return tools.map((tool) => {
        const name = typeof tool.name === 'string' ? tool.name : '';
        if (!name) return tool;
        if (hasExceptions(resolved, name)) {
            // Decided per call: one that would ask is refused (nobody can answer it), one an exception
            // blocks is blocked, the rest run.
            const refusal = (args: unknown): Error | null => {
                const decision = toolCallDecision(resolved, name, args);
                if (decision.action === 'deny') return blockedCall(resolved, name, args, log);
                if (callAsks(decision, allowedTools, name)) return new HitlUnattendedCallError();
                if (decision.source === 'exception') log?.note(name, args, decision);
                return null;
            };
            const refused = refuseCalls(tool, refusal);
            // A call this side refuses must not wait for another side's approval first.
            if (tool.needsApproval !== undefined) refused.needsApproval = (args: unknown) => refusal(args) === null && priorAsks(tool, args);
            return refused;
        }
        if (toolApprovalPolicy(resolved, name) !== 'always' || allowedTools.has(name)) return tool;
        const denied: Record<string, unknown> = { ...tool };
        for (const key of TOOL_CALLABLE_KEYS) {
            if (typeof denied[key] === 'function') denied[key] = refuse;
        }
        // A refusal is not transient: retrying it would only wait. Keep the rest of the policy.
        if (denied.retry && typeof denied.retry === 'object') denied.retry = { ...denied.retry, maxRetries: 0 };
        // Never serve a cached result for a call that is being refused.
        delete denied.cache;
        delete denied.needsApproval;
        return denied as T;
    });
}

/** One set of approval settings a sub-agent's tools answer to, and how it applies to this run. */
export interface ChildApprovalSide {
    hitl: ResolvedHitlConfig;
    mode: HitlRunMode;
}

/**
 * The tools of a sub-agent, gated the way the people who own it would gate them.
 * A sub-agent's tools answer to every side that applies to it: the delegating
 * agent's settings always, and, when the sub-agent is another agent, that agent's
 * own settings too. A tool that any side gates is gated; a side that cannot ask
 * anybody on this run (`deny`) refuses the call, whatever the other sides say.
 * Calls that wait for approval are applied first so a refusal is never undone.
 */
export function gateChildTools<T extends ToolRecord>(
    tools: T[],
    sides: ChildApprovalSide[],
    allowedTools: ReadonlySet<string>,
    log?: HitlCallLog,
): T[] {
    let gated = tools;
    for (const side of sides) {
        if (side.mode === 'ask') gated = applyToolApprovals(gated, side.hitl, allowedTools, log);
    }
    for (const side of sides) {
        if (side.mode === 'deny') gated = denyUnattendedTools(gated, side.hitl, allowedTools, log);
    }
    // A side that lets everything run still blocks what its exceptions block.
    for (const side of sides) {
        if (side.mode === 'allow') gated = applyToolBlocks(gated, side.hitl, log);
    }
    return gated;
}

/** Warnings/errors for the saved config — `agentConfigValidation` merges them into its report. */
export function validateHitlConfig(config: IAgentConfig): {
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
} {
    const errors: Array<{ field: string; message: string }> = [];
    const warnings: Array<{ field: string; message: string }> = [];
    const hitl = config.humanInTheLoop;
    if (hitl === undefined || hitl === null) return { errors, warnings };
    if (typeof hitl !== 'object' || Array.isArray(hitl)) {
        errors.push({ field: 'humanInTheLoop', message: 'must be an object' });
        return { errors, warnings };
    }

    const enumCheck = (field: string, value: unknown, allowed: readonly string[]) => {
        if (value === undefined || value === null) return;
        if (typeof value !== 'string' || !allowed.includes(value)) {
            errors.push({ field, message: `must be one of: ${allowed.join(', ')}` });
        }
    };
    enumCheck('humanInTheLoop.onTimeout', hitl.onTimeout, ['deny', 'cancel']);
    enumCheck('humanInTheLoop.approvers', hitl.approvers, ['owner', 'owner_or_admin', 'project_members']);
    enumCheck('humanInTheLoop.onUserMessageWhilePending', hitl.onUserMessageWhilePending, ['reject', 'cancel_pending']);
    enumCheck('humanInTheLoop.unattended', hitl.unattended, ['deny', 'pause', 'allow']);

    const timeout = hitl.timeoutMinutes;
    if (timeout !== undefined && timeout !== null) {
        if (typeof timeout !== 'number' || !Number.isFinite(timeout)) {
            errors.push({ field: 'humanInTheLoop.timeoutMinutes', message: 'must be a number' });
        } else if (!Number.isInteger(timeout) || timeout < 0) {
            errors.push({ field: 'humanInTheLoop.timeoutMinutes', message: 'must be a whole number of minutes, 0 or more (0 = never expires)' });
        } else if (timeout > 60 * 24 * 365) {
            errors.push({ field: 'humanInTheLoop.timeoutMinutes', message: 'must be at most one year' });
        }
    }

    const approval = hitl.toolApproval;
    if (approval) {
        enumCheck('humanInTheLoop.toolApproval.defaultPolicy', approval.defaultPolicy, ['always', 'never']);
        for (const [tool, policy] of Object.entries(approval.tools ?? {})) {
            enumCheck(`humanInTheLoop.toolApproval.tools.${tool}`, policy, ['always', 'never']);
        }
        errors.push(...validateToolExceptions(approval.exceptions));
        const hasAny = Object.values(approval.exceptions ?? {}).some((list) => Array.isArray(list) && list.length > 0);
        if (hasAny && !approval.enabled) {
            warnings.push({
                field: 'humanInTheLoop.toolApproval.exceptions',
                message: 'Approval exceptions apply only while "Ask before tools run" is on',
            });
        }
    }
    if (hitl.unattended === 'allow' && (approval?.enabled || hitl.askUser?.enabled)) {
        warnings.push({
            field: 'humanInTheLoop.unattended',
            message: 'With "Run without approval", schedules, API bridges and evaluations run this agent\'s gated tools with nobody approving them',
        });
    }
    if (hitl.askUser?.enabled && hitl.askUser.allowFreeText === false) {
        warnings.push({
            field: 'humanInTheLoop.askUser.allowFreeText',
            message: 'With free text off, every question the model asks must offer options to pick from',
        });
    }
    return { errors, warnings };
}
