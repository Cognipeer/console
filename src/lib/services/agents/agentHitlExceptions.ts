/**
 * Approval exceptions: per-tool rules that look at a call's ARGUMENTS.
 *
 * A tool's approval setting decides for every call alike, but the dangerous
 * half of most tools is what they were asked to do — `sandbox_exec` with `ls`
 * is fine, with `rm -rf` it is not; an email to a colleague is fine, to a
 * competitor it is not. An exception names an argument (or any of them) and a
 * pattern, and for the calls that match it asks, runs without asking, or
 * refuses the call.
 *
 * Deliberately small: `*` is the only wildcard, matching is not
 * case-sensitive, and there is no order to get wrong — when several exceptions
 * match a call the strictest wins (`deny` › `ask` › `allow`).
 *
 * Pure and dependency-free (types only), so the settings editor evaluates a
 * sample call with exactly the code the runtime runs.
 */

import type {
    AgentToolApprovalException,
    AgentToolApprovalExceptionAction,
    AgentToolApprovalPolicy,
    IAgentApprovalReason,
} from '@/lib/database/provider/types.domain';

export const HITL_EXCEPTION_LIMITS = {
    /** Exceptions on one tool. */
    perTool: 20,
    /** Exceptions on all the tools of an agent. */
    total: 200,
    patternLength: 200,
    /** `*` in one pattern: each one widens the search a matcher has to make. */
    wildcards: 10,
    fieldLength: 128,
    /** Characters of one argument value that are compared; the rest is not looked at. */
    valueLength: 20_000,
    /** How deep "any argument" looks into nested objects and arrays. */
    depth: 6,
    /** How many text values "any argument" compares at most. */
    values: 500,
} as const;

/** A dot path into the arguments: `to`, `body.to`, `recipients.0`. */
const FIELD_PATH = /^[A-Za-z_$][\w$-]*(\.([A-Za-z_$][\w$-]*|\d+))*$/;

const ACTIONS: readonly AgentToolApprovalExceptionAction[] = ['ask', 'allow', 'deny'];

/** How strict an action is: the higher one wins when several exceptions match. */
const STRICTNESS: Record<AgentToolApprovalExceptionAction, number> = { allow: 0, ask: 1, deny: 2 };

// ── Matching ────────────────────────────────────────────────────────────

/**
 * `*` matches any run of characters (including none); everything else is a
 * literal. Not case-sensitive: a rule written `*@Rival.com` must not miss
 * `x@rival.com`, because a rule that silently does not apply fails open.
 *
 * Linear-backtracking wildcard match, not a RegExp, so a pattern cannot be
 * written to stall the matcher.
 */
export function globMatches(pattern: string, value: string): boolean {
    const p = pattern.toLowerCase();
    const v = value.slice(0, HITL_EXCEPTION_LIMITS.valueLength).toLowerCase();
    let pi = 0;
    let vi = 0;
    let star = -1;
    let resume = 0;
    while (vi < v.length) {
        if (pi < p.length && p[pi] !== '*' && p[pi] === v[vi]) {
            pi += 1;
            vi += 1;
        } else if (pi < p.length && p[pi] === '*') {
            star = pi;
            resume = vi;
            pi += 1;
        } else if (star !== -1) {
            pi = star + 1;
            resume += 1;
            vi = resume;
        } else {
            return false;
        }
    }
    while (pi < p.length && p[pi] === '*') pi += 1;
    return pi === p.length;
}

/** Every text value under `value` (numbers and booleans as text), at most `depth` levels down. */
function collectValues(value: unknown, depth: number, out: string[]): string[] {
    if (out.length >= HITL_EXCEPTION_LIMITS.values) return out;
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
    else if (depth < HITL_EXCEPTION_LIMITS.depth && Array.isArray(value)) {
        for (const entry of value) collectValues(entry, depth + 1, out);
    } else if (depth < HITL_EXCEPTION_LIMITS.depth && value && typeof value === 'object') {
        for (const entry of Object.values(value)) collectValues(entry, depth + 1, out);
    }
    return out;
}

function readField(args: unknown, path: string): unknown {
    let current: unknown = args;
    for (const key of path.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/**
 * Does this call match the exception? With a `field`, any text value at or
 * under that path counts — a list of recipients matches when one of them does.
 * Without one, any text value anywhere in the arguments counts: that errs
 * toward matching, which for a rule that asks or blocks is the safe side.
 */
export function exceptionMatches(exception: Pick<AgentToolApprovalException, 'field' | 'pattern'>, args: unknown): boolean {
    const values = exception.field
        ? collectValues(readField(args, exception.field), 0, [])
        : collectValues(args, 0, []);
    return values.some((value) => globMatches(exception.pattern, value));
}

// ── Deciding one call ───────────────────────────────────────────────────

/** Where a tool's own setting came from (see `toolApprovalPolicy`). */
export type ToolPolicySource = 'tool_policy' | 'read_only' | 'default_policy';

/** What happens to one call, and what decided it. */
export interface HitlCallDecision {
    action: AgentToolApprovalExceptionAction;
    source: ToolPolicySource | 'exception';
    /** `exception`: the one that decided. */
    exception?: AgentToolApprovalException;
}

/**
 * The verdict for one call: the strictest matching exception, or the tool's
 * own setting when none matches.
 */
export function decideToolCall(
    base: { policy: AgentToolApprovalPolicy; source: ToolPolicySource },
    exceptions: readonly AgentToolApprovalException[] | undefined,
    args: unknown,
): HitlCallDecision {
    let best: AgentToolApprovalException | undefined;
    for (const exception of exceptions ?? []) {
        if (best && STRICTNESS[exception.action] <= STRICTNESS[best.action]) continue;
        if (exceptionMatches(exception, args)) best = exception;
    }
    if (best) return { action: best.action, source: 'exception', exception: best };
    return { action: base.policy === 'always' ? 'ask' : 'allow', source: base.source };
}

/** What an exception can usefully do on a tool with this setting: what differs from it, plus `deny`. */
export function exceptionActionsFor(policy: AgentToolApprovalPolicy): AgentToolApprovalExceptionAction[] {
    return policy === 'always' ? ['allow', 'deny'] : ['ask', 'deny'];
}

// ── Wording ─────────────────────────────────────────────────────────────

function ruleText(exception: Pick<AgentToolApprovalException, 'field' | 'pattern'>): string {
    return `${exception.field ? `\`${exception.field}\`` : 'an argument'} matches "${exception.pattern}"`;
}

/** Why a call is waiting, as stored on the pending action and shown in the trace. */
export function approvalReasonOf(toolName: string, decision: HitlCallDecision): IAgentApprovalReason {
    if (decision.source === 'exception' && decision.exception) {
        const { field, pattern } = decision.exception;
        return {
            source: 'exception',
            exception: { ...(field ? { field } : {}), pattern },
            text: `Asked because ${ruleText(decision.exception)} — an exception on ${toolName}.`,
        };
    }
    if (decision.source === 'tool_policy') {
        return { source: 'tool_policy', text: `${toolName} is set to always ask.` };
    }
    return { source: 'default_policy', text: 'This agent asks before tools without their own setting run.' };
}

/**
 * What the MODEL reads when an exception refuses a call. It has to tell three
 * things the model would otherwise guess: this is a decision, not an outage;
 * retrying the same call will not help; a different call may be fine.
 */
export function blockedCallMessage(toolName: string, exception: Pick<AgentToolApprovalException, 'field' | 'pattern'>): string {
    return `Blocked by this agent's approval rules: this \`${toolName}\` call is not allowed because ${ruleText(exception)}. `
        + 'This is a policy decision, not a temporary failure, and the same call will be refused again. '
        + 'A different call may be allowed: continue another way if you can, otherwise tell the user that a rule blocked this step.';
}

/** Thrown in place of a call an exception refuses; never retried. */
export class HitlBlockedCallError extends Error {
    readonly exception: AgentToolApprovalException;

    constructor(toolName: string, exception: AgentToolApprovalException) {
        super(blockedCallMessage(toolName, exception));
        this.name = 'HitlBlockedCallError';
        this.exception = exception;
    }
}

// ── What the run decided, for the record ────────────────────────────────

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.keys(value as Record<string, unknown>).sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
}

/**
 * The decisions a run made, by tool and arguments: the gates record what they
 * decided, and the code that stores the turn reads it back — why a pending
 * action is waiting, which call an exception let through or refused. Keyed by
 * the call itself because neither the approval predicate nor the tool sees the
 * SDK's call id.
 */
export interface HitlCallLog {
    note(toolName: string, args: unknown, decision: HitlCallDecision): void;
    /** Why a call that waits for approval is waiting. */
    reasonFor(toolName: string | undefined, args: unknown): IAgentApprovalReason | undefined;
    /** The exception that let a call run without asking, or refused it. */
    ruleFor(toolName: string | undefined, args: unknown): { action: 'allow' | 'deny'; field?: string; pattern: string } | undefined;
}

export function createHitlCallLog(): HitlCallLog {
    const decisions = new Map<string, { toolName: string; decision: HitlCallDecision }>();
    const keyOf = (toolName: string, args: unknown) => `${toolName}\u0000${canonicalJson(args ?? {})}`;
    return {
        note(toolName, args, decision) {
            decisions.set(keyOf(toolName, args), { toolName, decision });
        },
        reasonFor(toolName, args) {
            if (!toolName) return undefined;
            const noted = decisions.get(keyOf(toolName, args));
            return noted && noted.decision.action === 'ask' ? approvalReasonOf(toolName, noted.decision) : undefined;
        },
        ruleFor(toolName, args) {
            if (!toolName) return undefined;
            const decision = decisions.get(keyOf(toolName, args))?.decision;
            if (!decision || decision.source !== 'exception' || !decision.exception || decision.action === 'ask') return undefined;
            const { field, pattern } = decision.exception;
            return { action: decision.action, ...(field ? { field } : {}), pattern };
        },
    };
}

// ── Stored shape ────────────────────────────────────────────────────────

/** The stored exceptions, cleaned for the runtime: anything malformed is left out (validation reports it on save). */
export function normalizeToolExceptions(raw: unknown): Record<string, AgentToolApprovalException[]> {
    const out: Record<string, AgentToolApprovalException[]> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [tool, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        const clean: AgentToolApprovalException[] = [];
        for (const entry of list.slice(0, HITL_EXCEPTION_LIMITS.perTool)) {
            if (exceptionIssue(entry)) continue;
            const { field, pattern, action } = entry as AgentToolApprovalException;
            const trimmedField = typeof field === 'string' ? field.trim() : '';
            clean.push({ ...(trimmedField ? { field: trimmedField } : {}), pattern: pattern.trim(), action });
        }
        if (clean.length > 0) out[tool] = clean;
    }
    return out;
}

/** What can be wrong with one exception (the editor words these itself). */
export type ExceptionIssue =
    | 'not_object'
    | 'action_invalid'
    | 'pattern_required'
    | 'pattern_too_long'
    | 'too_many_wildcards'
    | 'field_not_text'
    | 'field_too_long'
    | 'field_invalid';

/** What is wrong with one exception, as a code, or null. */
export function exceptionIssue(entry: unknown): ExceptionIssue | null {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not_object';
    const { field, pattern, action } = entry as Record<string, unknown>;
    if (typeof action !== 'string' || !ACTIONS.includes(action as AgentToolApprovalExceptionAction)) return 'action_invalid';
    if (typeof pattern !== 'string' || !pattern.trim()) return 'pattern_required';
    if (pattern.length > HITL_EXCEPTION_LIMITS.patternLength) return 'pattern_too_long';
    if ((pattern.match(/\*/g)?.length ?? 0) > HITL_EXCEPTION_LIMITS.wildcards) return 'too_many_wildcards';
    if (field !== undefined && field !== null && field !== '') {
        if (typeof field !== 'string') return 'field_not_text';
        if (field.trim().length > HITL_EXCEPTION_LIMITS.fieldLength) return 'field_too_long';
        if (!FIELD_PATH.test(field.trim())) return 'field_invalid';
    }
    return null;
}

const ISSUE_MESSAGES: Record<ExceptionIssue, string> = {
    not_object: 'must be an object',
    action_invalid: `action must be one of: ${ACTIONS.join(', ')}`,
    pattern_required: 'pattern is required',
    pattern_too_long: `pattern must be at most ${HITL_EXCEPTION_LIMITS.patternLength} characters`,
    too_many_wildcards: `pattern may use * at most ${HITL_EXCEPTION_LIMITS.wildcards} times`,
    field_not_text: 'field must be text',
    field_too_long: `field must be at most ${HITL_EXCEPTION_LIMITS.fieldLength} characters`,
    field_invalid: 'field must be an argument name or a dot path (body.to)',
};

/** What is wrong with one stored exception, or null. */
export function exceptionProblem(entry: unknown): string | null {
    const issue = exceptionIssue(entry);
    return issue ? ISSUE_MESSAGES[issue] : null;
}

/** Errors for `humanInTheLoop.toolApproval.exceptions`, field paths included. */
export function validateToolExceptions(raw: unknown): Array<{ field: string; message: string }> {
    const base = 'humanInTheLoop.toolApproval.exceptions';
    if (raw === undefined || raw === null) return [];
    if (typeof raw !== 'object' || Array.isArray(raw)) return [{ field: base, message: 'must be an object keyed by tool name' }];
    const errors: Array<{ field: string; message: string }> = [];
    let total = 0;
    for (const [tool, list] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
            errors.push({ field: `${base}.${tool}`, message: 'must be a list' });
            continue;
        }
        if (list.length > HITL_EXCEPTION_LIMITS.perTool) {
            errors.push({ field: `${base}.${tool}`, message: `at most ${HITL_EXCEPTION_LIMITS.perTool} exceptions per tool` });
        }
        total += list.length;
        list.forEach((entry, index) => {
            const problem = exceptionProblem(entry);
            if (problem) errors.push({ field: `${base}.${tool}.${index}`, message: problem });
        });
    }
    if (total > HITL_EXCEPTION_LIMITS.total) {
        errors.push({ field: base, message: `at most ${HITL_EXCEPTION_LIMITS.total} exceptions in all` });
    }
    return errors;
}
