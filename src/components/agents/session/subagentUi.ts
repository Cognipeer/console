/**
 * How a sub-agent run reads in the session view. One builder serves the live
 * turn (`LiveSubagentRun`, from the reducers in `liveFlow.ts`) and the stored
 * one (`IAgentTurnSubagentRun`, from the message), so a group looks the same
 * while it runs, when the turn ends and after a reload. Pure - labels are
 * translation keys under `agents.sessionFlow`, resolved by the component.
 */

import { delegationCallIdOf, type AgentCompactionEvent } from '@/lib/shared/agentTurnFlow';
import type {
    IAgentConversationStep,
    IAgentMessagePendingAction,
    IAgentSubagentStep,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';
import { summariseArgs, type LiveSubagentRun, type LiveToolCall } from './liveFlow';
import { stepFailed } from './sessionTypes';

/** A run as the live turn holds it, or as a stored message does. */
export type SubagentRunSource = IAgentTurnSubagentRun | LiveSubagentRun;

/**
 * - `running`: working now. `paused`: waiting for a person (an approval or an answer).
 * - `done`: finished with an answer. `failed`: errored. `blocked` / `incomplete` / `cancelled`: the SDK's own verdicts
 *   (and what a stored run that never reported an end reads as: `incomplete`).
 * - `continued`: a stored run that paused for a person who has since answered. The run went on in the next message of
 *   the session (the same run, `resumed` there), so this message is where it stopped, not something still waiting.
 */
export type SubagentStatusKind = 'running' | 'done' | 'failed' | 'paused' | 'blocked' | 'incomplete' | 'cancelled' | 'continued';

/** The translation key (under `agents.sessionFlow`) that words a status. */
export type SubagentStatusLabelKey =
    | 'subagentStatusRunning'
    | 'subagentStatusDone'
    | 'subagentStatusFailed'
    | 'subagentStatusPaused'
    | 'subagentStatusBlocked'
    | 'subagentStatusIncomplete'
    | 'subagentStatusCancelled'
    | 'subagentStatusContinued';

export interface SubagentStatusStyle {
    labelKey: SubagentStatusLabelKey;
    /** A Mantine color name. */
    color: 'blue' | 'teal' | 'red' | 'orange' | 'gray';
}

const STATUS_STYLES: Record<SubagentStatusKind, SubagentStatusStyle> = {
    running: { labelKey: 'subagentStatusRunning', color: 'blue' },
    done: { labelKey: 'subagentStatusDone', color: 'teal' },
    failed: { labelKey: 'subagentStatusFailed', color: 'red' },
    paused: { labelKey: 'subagentStatusPaused', color: 'orange' },
    blocked: { labelKey: 'subagentStatusBlocked', color: 'orange' },
    incomplete: { labelKey: 'subagentStatusIncomplete', color: 'gray' },
    cancelled: { labelKey: 'subagentStatusCancelled', color: 'gray' },
    continued: { labelKey: 'subagentStatusContinued', color: 'gray' },
};

/** The wording key and color of a run's status, for the header chip. */
export function subagentStatusStyle(kind: SubagentStatusKind): SubagentStatusStyle {
    return STATUS_STYLES[kind];
}

/**
 * Whether a group starts open: while it works, waits for a person or failed
 * (the person needs to see why), closed once it finished - the header already
 * says "Result: …" - or went on in the next message (`continued`).
 */
export function subagentStartsOpen(kind: SubagentStatusKind): boolean {
    return kind === 'running' || kind === 'paused' || kind === 'failed';
}

/** One tool call of the sub-agent. Live rows carry no payload, stored ones carry the clipped args and output. */
export interface SubagentStepRow {
    kind: 'step';
    /** Stable within the run: the call id, or a synthetic key. */
    key: string;
    name: string;
    status: 'running' | 'success' | 'error';
    /** The argument worth showing beside the name. */
    detail?: string;
    args?: unknown;
    output?: unknown;
    error?: string;
    durationMs?: number;
    timestamp?: string;
    /** Args or output were cut when the run was stored. */
    truncated: boolean;
}

/** One summarization pass the sub-agent made of its own context. */
export interface SubagentCompactionRow {
    kind: 'compaction';
    key: string;
    compaction: AgentCompactionEvent;
    /** Still being made (live only). */
    pending: boolean;
}

export type SubagentRow = SubagentStepRow | SubagentCompactionRow;

export interface SubagentRunView {
    id: string;
    name: string;
    /** First letter of the name, for the avatar. */
    initial: string;
    /** Translation key: where the run came from. Absent when the stream did not say. */
    modeLabelKey?: 'subagentModeRegistry' | 'subagentModeAdhoc';
    /** The registry entry it ran ("support-agent v3"), when known. */
    targetText?: string;
    statusKind: SubagentStatusKind;
    /** Steps it took, including those past the stored cap. */
    stepCount: number;
    durationMs?: number;
    /** Total tokens the run used, when the SDK said. */
    tokens?: number;
    /** The task it was given. */
    input?: string;
    /** The first line of what it answered: the collapsed header's "Result: …". */
    result?: string;
    /** All of what it answered. */
    resultFull?: string;
    error?: string;
    /** Open approvals / questions that belong to this run. */
    approvals: number;
    /** Its steps and its own summarization passes, in the order they happened. */
    rows: SubagentRow[];
    /** This leg continues a run an earlier leg started: the header says "continued". */
    resumed: boolean;
    /** A turn stored before sub-agent runs were recorded: only the delegation call is known. */
    stepsNotRecorded: boolean;
    /** Steps past the stored cap (counted, not kept). */
    stepsDropped: number;
}

export interface SubagentViewOptions {
    /**
     * The turn is running: a run that has not reported an end is `running`. Stored, the same run never ended
     * (the turn was cancelled or lost) and reads `incomplete`; one that paused for a person reads `paused` only
     * while a request of its own is still open, and `continued` once it was answered. Detected from the data when
     * not given; pass it (or use `liveRunView` / `storedRunView`) because an empty live run and an empty stored
     * one look alike.
     */
    live?: boolean;
}

const RESULT_LINE_CHARS = 160;

function isLiveStep(step: IAgentSubagentStep | LiveToolCall): step is LiveToolCall {
    return 'running' in step && typeof step.running === 'boolean';
}

function looksLive(run: SubagentRunSource): boolean {
    if ('startedAt' in run) return false;
    if (run.steps.length > 0) return isLiveStep(run.steps[0]);
    return Array.isArray(run.compactions);
}

/** First letter or digit of a name, upper-cased ("?" when it has none). */
export function subagentInitial(name: string): string {
    const match = Array.from(name.trim()).find((char) => /[\p{L}\p{N}]/u.test(char));
    return match ? match.toUpperCase() : '?';
}

/** The first non-empty line of a text, clipped: what the collapsed header shows of an answer. */
export function firstLineOf(text: string | undefined, max = RESULT_LINE_CHARS): string | undefined {
    if (!text) return undefined;
    const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
    if (!line) return undefined;
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Open approvals and questions that belong to a run: same delegation call (a parallel child's key `<call>#<n>` is its
 * call's, on either side), and the same sub-agent when the action names one.
 */
function approvalsFor(run: SubagentRunSource, pendingActions: ReadonlyArray<IAgentMessagePendingAction> | undefined): number {
    if (!pendingActions?.length || !run.parentToolCallId) return 0;
    const callId = delegationCallIdOf(run.parentToolCallId);
    return pendingActions.filter((action) => (
        action.status === 'pending'
        && delegationCallIdOf(action.delegationToolCallId) === callId
        && (!action.subagent || action.subagent === run.name)
    )).length;
}

function statusKindOf(run: SubagentRunSource, live: boolean, awaiting: boolean): SubagentStatusKind {
    if (run.phase === 'error' || run.status === 'error' || (run.phase === 'result' && run.error)) return 'failed';
    if (run.phase === 'paused' || run.status === 'needs_input') {
        // A run that is running right now is waiting. A stored one waits only while a request of its own is open:
        // once the person answered, the run went on in the next message and this one is where it stopped.
        return live || awaiting ? 'paused' : 'continued';
    }
    if (run.phase === 'start') return awaiting ? 'paused' : live ? 'running' : 'incomplete';
    switch (run.status) {
        case 'blocked': return 'blocked';
        case 'incomplete': return 'incomplete';
        case 'cancelled': return 'cancelled';
        default: return 'done';
    }
}

function tokensOf(usage: SubagentRunSource['usage']): number | undefined {
    if (!usage) return undefined;
    if (typeof usage.totalTokens === 'number') return usage.totalTokens;
    if (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number') {
        return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    }
    return undefined;
}

function durationOf(run: SubagentRunSource): number | undefined {
    if (typeof run.durationMs === 'number') return run.durationMs;
    const stored = run as IAgentTurnSubagentRun;
    if (stored.startedAt && stored.endedAt) {
        const span = Date.parse(stored.endedAt) - Date.parse(stored.startedAt);
        if (Number.isFinite(span) && span >= 0) return span;
    }
    return undefined;
}

function targetTextOf(target: SubagentRunSource['target']): string | undefined {
    if (!target?.agentName) return undefined;
    return target.version !== undefined ? `${target.agentName} v${target.version}` : target.agentName;
}

function modeKeyOf(run: SubagentRunSource): SubagentRunView['modeLabelKey'] {
    const mode = run.mode ?? (run.target ? (run.target.kind === 'ref' ? 'registry' : 'adhoc') : undefined);
    if (mode === 'registry') return 'subagentModeRegistry';
    if (mode === 'adhoc') return 'subagentModeAdhoc';
    return undefined;
}

function stepRowsOf(run: SubagentRunSource): SubagentStepRow[] {
    return (run.steps as Array<IAgentSubagentStep | LiveToolCall>).map((step, index): SubagentStepRow => {
        if (isLiveStep(step)) {
            return {
                kind: 'step',
                key: step.key,
                name: step.name,
                status: step.running ? 'running' : step.error ? 'error' : 'success',
                ...(step.detail ? { detail: step.detail } : {}),
                ...(step.error ? { error: step.error } : {}),
                ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
                truncated: false,
            };
        }
        const detail = summariseArgs(step.args);
        return {
            kind: 'step',
            key: step.id ?? `${run.id}:step:${index}`,
            name: step.name,
            status: step.status,
            ...(detail ? { detail } : {}),
            ...(step.args !== undefined ? { args: step.args } : {}),
            ...(step.output !== undefined ? { output: step.output } : {}),
            ...(step.error ? { error: step.error } : {}),
            ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
            ...(step.timestamp ? { timestamp: step.timestamp } : {}),
            truncated: step._truncated === true,
        };
    });
}

function timeOf(value: string | undefined): number {
    return value ? Date.parse(value) : Number.NaN;
}

/**
 * Puts a run's summarization passes between its steps: after the step a pass
 * names (`afterToolCallId`; `null` = before any), else by wall clock (after the
 * last step that started no later than the pass), else at the end. Passes that
 * share a place keep their order.
 */
function interleave(steps: SubagentStepRow[], passes: ReadonlyArray<AgentCompactionEvent>, runId: string): SubagentRow[] {
    const rows: SubagentRow[] = [...steps];
    let atStart = 0;
    passes.forEach((compaction, i) => {
        const row: SubagentCompactionRow = {
            kind: 'compaction',
            key: compaction.id ?? `${runId}:pass-${i + 1}`,
            compaction,
            pending: compaction.phase === 'start',
        };
        const after = (index: number) => {
            let at = index + 1;
            while (at < rows.length && rows[at].kind === 'compaction') at += 1;
            rows.splice(at, 0, row);
        };
        if (compaction.afterToolCallId === null) {
            rows.splice(atStart, 0, row);
            atStart += 1;
            return;
        }
        if (typeof compaction.afterToolCallId === 'string') {
            const anchor = rows.findIndex((candidate) => candidate.kind === 'step' && candidate.key === compaction.afterToolCallId);
            if (anchor >= 0) {
                after(anchor);
                return;
            }
        }
        const at = timeOf(compaction.at);
        if (Number.isFinite(at)) {
            let anyTimed = false;
            for (let r = rows.length - 1; r >= 0; r -= 1) {
                const candidate = rows[r];
                if (candidate.kind !== 'step') continue;
                const t = timeOf(candidate.timestamp);
                if (!Number.isFinite(t)) continue;
                anyTimed = true;
                if (t <= at) {
                    after(r);
                    return;
                }
            }
            if (anyTimed) {
                rows.splice(atStart, 0, row);
                atStart += 1;
                return;
            }
        }
        rows.push(row);
    });
    return rows;
}

/**
 * The view of one sub-agent run, live or stored: header facts (name, where it
 * ran, status, steps, time, tokens), the task and the answer, how many open
 * approvals wait on it (so a run that paused for one reads `paused`), and the
 * rows of its steps and own summarization passes in the order they happened.
 */
export function subagentRunView(
    run: SubagentRunSource,
    pendingActions?: ReadonlyArray<IAgentMessagePendingAction>,
    options: SubagentViewOptions = {},
): SubagentRunView {
    const live = options.live ?? looksLive(run);
    const approvals = approvalsFor(run, pendingActions);
    const stepsDropped = (run as IAgentTurnSubagentRun).stepsDropped ?? 0;
    const target = targetTextOf(run.target);
    const modeLabelKey = modeKeyOf(run);
    const duration = durationOf(run);
    const tokens = tokensOf(run.usage);
    const input = run.input?.trim() ? run.input : undefined;
    return {
        id: run.id,
        name: run.name,
        initial: subagentInitial(run.name),
        ...(modeLabelKey ? { modeLabelKey } : {}),
        ...(target ? { targetText: target } : {}),
        statusKind: statusKindOf(run, live, approvals > 0),
        stepCount: run.steps.length + stepsDropped,
        ...(duration !== undefined ? { durationMs: duration } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(input ? { input } : {}),
        ...(firstLineOf(run.result) ? { result: firstLineOf(run.result), resultFull: run.result } : {}),
        ...(run.error ? { error: run.error } : {}),
        approvals,
        rows: interleave(stepRowsOf(run), run.compactions ?? [], run.id),
        resumed: run.resumed === true,
        stepsNotRecorded: false,
        stepsDropped,
    };
}

/** `subagentRunView` for a run of the turn that is running. */
export function liveRunView(run: LiveSubagentRun, pendingActions?: ReadonlyArray<IAgentMessagePendingAction>): SubagentRunView {
    return subagentRunView(run, pendingActions, { live: true });
}

/** `subagentRunView` for a run a stored message recorded. */
export function storedRunView(run: IAgentTurnSubagentRun, pendingActions?: ReadonlyArray<IAgentMessagePendingAction>): SubagentRunView {
    return subagentRunView(run, pendingActions, { live: false });
}

function textArg(args: unknown, fields: string[]): string | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const record = args as Record<string, unknown>;
    for (const field of fields) {
        const value = record[field];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

/**
 * The view of a delegation call stored before runs were recorded: all that is
 * known is the call (its arguments, outcome and answer), not the steps the
 * sub-agent took. `stepsNotRecorded` tells the component to say so.
 */
export function legacyDelegationView(step: IAgentConversationStep): SubagentRunView {
    const name = textArg(step.args, ['agent', 'agent_name', 'agentName', 'name', 'subagent', 'target']) ?? step.subagent ?? step.name;
    const input = textArg(step.args, ['task', 'input', 'prompt', 'message', 'instructions']);
    const answer = typeof step.output === 'string' ? step.output : undefined;
    const failed = stepFailed(step);
    return {
        id: step.id ?? step.name,
        name,
        initial: subagentInitial(name),
        statusKind: failed ? 'failed' : 'done',
        stepCount: 0,
        ...(input ? { input } : {}),
        ...(firstLineOf(answer) ? { result: firstLineOf(answer), resultFull: answer } : {}),
        ...(step.error ? { error: step.error } : {}),
        approvals: 0,
        rows: [],
        resumed: false,
        stepsNotRecorded: true,
        stepsDropped: 0,
    };
}

/** The header of a parallel group ("⑂ 3 sub-agents · 2 / 3 done · 41s · 1 approval"). */
export interface ParallelGroupView {
    /** Runs in the group. */
    count: number;
    /** Runs that have ended, however they ended (progress, not success); a run that went on in the next message is not waiting here, so it counts. */
    done: number;
    /** Runs still working. */
    running: number;
    /** Runs that ended in an error. */
    failed: number;
    /** Open approvals / questions across the runs. */
    approvals: number;
    /** Wall time: the longest run, since they ran side by side. Absent while none reports one. */
    durationMs?: number;
    /** Tokens across the runs, when any reported them. */
    tokens?: number;
    names: string[];
    /** The group's one status: running if any run works, else paused if any waits, else failed if any failed, else done. */
    statusKind: SubagentStatusKind;
}

/** The group header for the runs one `spawn_subagents_parallel` call started. Takes views already built (so approvals and the live flag are decided once). */
export function parallelGroupView(runs: ReadonlyArray<SubagentRunView>): ParallelGroupView {
    const running = runs.filter((run) => run.statusKind === 'running').length;
    const paused = runs.filter((run) => run.statusKind === 'paused').length;
    const failed = runs.filter((run) => run.statusKind === 'failed').length;
    const durations = runs.map((run) => run.durationMs).filter((value): value is number => typeof value === 'number');
    const tokens = runs.map((run) => run.tokens).filter((value): value is number => typeof value === 'number');
    return {
        count: runs.length,
        done: runs.length - running - paused,
        running,
        failed,
        approvals: runs.reduce((sum, run) => sum + run.approvals, 0),
        ...(durations.length ? { durationMs: Math.max(...durations) } : {}),
        ...(tokens.length ? { tokens: tokens.reduce((sum, value) => sum + value, 0) } : {}),
        names: runs.map((run) => run.name),
        statusKind: running > 0 ? 'running' : paused > 0 ? 'paused' : failed > 0 ? 'failed' : 'done',
    };
}
