/**
 * The live turn as data: what the playground builds from the SSE frames of a
 * running turn (or from the session event log when it follows one) so the
 * view can show it in the order it happened - the model's text, its tool
 * calls, the plan it wrote, the sub-agents it ran and the passes that
 * summarized its context. Every function here is pure and returns a new list;
 * the components only render what these reducers produce.
 *
 * `LiveToolCalls.tsx` re-exports all of it, so existing imports keep working.
 */

import {
    delegationCallIdOf,
    isDelegationTool,
    isPlanTool,
    type AgentCompactionEvent,
    type AgentSubagentEvent,
    type AgentToolCallSubagentStamp,
} from '@/lib/shared/agentTurnFlow';
import type { AgentSubagentRunPhase, IAgentTurnPlanSnapshot, IAgentTurnSubagentRun } from '@/lib/database/provider/types.domain';

export interface LiveToolCall {
    /** Provider tool-call id when there is one; a synthetic key otherwise. */
    key: string;
    name: string;
    /** The argument worth showing beside the name - see `summariseArgs`. */
    detail?: string;
    running: boolean;
    durationMs?: number;
    error?: string;
    /** Set on a call a sub-agent made: which one, and under which delegation. */
    subagent?: AgentToolCallSubagentStamp;
}

/**
 * The one argument a human would use to tell two calls of the same tool apart.
 *
 * Tool schemas differ, so this prefers the conventional "what was asked"
 * fields and falls back to the first short string rather than dumping JSON:
 * the row is a progress line, not a payload viewer - the full args are in the
 * finished turn.
 */
export function summariseArgs(args: unknown): string | undefined {
    if (typeof args === 'string') return args.slice(0, 120);
    if (!args || typeof args !== 'object') return undefined;
    const record = args as Record<string, unknown>;

    for (const field of ['query', 'q', 'url', 'question', 'search', 'input', 'path', 'key', 'name']) {
        const value = record[field];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 120);
    }
    for (const value of Object.values(record)) {
        if (typeof value === 'string' && value.trim() && value.length <= 120) return value.trim();
    }
    return undefined;
}

/**
 * One sub-agent run of the live turn, with its own tool calls and its own
 * summarization passes. A pass still being made (`phase: 'start'`) sits in
 * `compactions` until the finished pass with the same `id` replaces it.
 */
export interface LiveSubagentRun {
    id: string;
    name: string;
    mode?: 'registry' | 'adhoc';
    /** The delegation call that started it (what an open approval of the run points back to). */
    parentToolCallId?: string;
    parallel?: boolean;
    /** This leg continues a run an earlier leg of the turn started (it paused for a person). */
    resumed?: boolean;
    phase: AgentSubagentRunPhase;
    status?: string;
    note?: string;
    /** The task it was given. */
    input?: string;
    /** What it answered. */
    result?: string;
    error?: string;
    durationMs?: number;
    usage?: IAgentTurnSubagentRun['usage'];
    target?: IAgentTurnSubagentRun['target'];
    steps: LiveToolCall[];
    compactions: AgentCompactionEvent[];
}

/**
 * A live turn, in the order it happened: the model's text and its tool calls
 * interleave ("Let me search…" → web_search → "Found it, now…" → fetch →
 * answer). Keeping one text buffer and one call list rendered the calls on top
 * and every piece of text glued together underneath - the narration read as
 * part of the answer and the order was lost.
 *
 * `plan`: one plan version the agent wrote; `previous` is the version before
 * it (this turn's or the session's) so the row can show what changed.
 * `compaction`: one summarization pass of the agent's own; `pending` until the
 * finished pass arrives. `subagents`: a delegation call and the runs it
 * started (`call` is absent when a sub-agent event arrived before the call).
 */
export type LiveSegment =
    | { kind: 'text'; text: string }
    | { kind: 'reasoning'; text: string }
    | { kind: 'tools'; calls: LiveToolCall[] }
    | { kind: 'plan'; plan: IAgentTurnPlanSnapshot; previous?: IAgentTurnPlanSnapshot }
    | { kind: 'compaction'; compaction: AgentCompactionEvent; pending: boolean }
    | { kind: 'subagents'; parentToolCallId?: string; call?: LiveToolCall; parallel: boolean; runs: LiveSubagentRun[] };

type SubagentsSegment = Extract<LiveSegment, { kind: 'subagents' }>;

export interface LiveToolEvent {
    phase: string;
    name: string;
    id?: string;
    args?: unknown;
    durationMs?: number;
    error?: string;
    /** The call belongs to a sub-agent: its calls go into that run, not into the parent's rows. */
    subagent?: AgentToolCallSubagentStamp;
    /** The call is a sub-agent's, and the delegation it belongs to was re-entered after a pause. */
    resumed?: boolean;
}

export function appendLiveText(segments: LiveSegment[], text: string): LiveSegment[] {
    if (!text) return segments;
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') {
        return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }];
    }
    return [...segments, { kind: 'text', text }];
}

/** Thinking text joins the reasoning block it continues; text or a tool call in between starts a new one. */
export function appendLiveReasoning(segments: LiveSegment[], text: string): LiveSegment[] {
    if (!text) return segments;
    const last = segments[segments.length - 1];
    if (last?.kind === 'reasoning') {
        return [...segments.slice(0, -1), { kind: 'reasoning', text: last.text + text }];
    }
    return [...segments, { kind: 'reasoning', text: text.replace(/^\n+/, '') }];
}

// ── Sub-agent runs ──────────────────────────────────────────────────────

/**
 * Who a sub-agent event or call is about: the stamp a child tool call carries, or what a lifecycle event names.
 * `parentToolCallId` may be a parallel child's own key (`<call>#<n>`); it belongs to the call `<call>`.
 */
interface RunStamp {
    id?: string;
    name: string;
    parentToolCallId?: string;
    parallel?: boolean;
}

/** True when both name the same delegation call: a parallel spawn's children are keyed `<call>#<n>`, and a group is the call's. */
function sameCall(a: string | undefined, b: string | undefined): boolean {
    return a !== undefined && b !== undefined && delegationCallIdOf(a) === delegationCallIdOf(b);
}

/** A group is open while its delegation call runs, or (when the call was not seen) while a run has not reported an end. */
function isOpenGroup(segment: SubagentsSegment): boolean {
    return Boolean(segment.call?.running) || segment.runs.some((run) => run.phase === 'start');
}

/**
 * The group a sub-agent's event belongs to: the one holding a run with that id,
 * else the one opened by the same delegation call, else the newest group still
 * open. -1 when there is none.
 */
function locateGroup(segments: LiveSegment[], stamp: RunStamp): number {
    if (stamp.id) {
        for (let s = segments.length - 1; s >= 0; s -= 1) {
            const segment = segments[s];
            if (segment.kind === 'subagents' && segment.runs.some((run) => run.id === stamp.id)) return s;
        }
    }
    if (stamp.parentToolCallId) {
        for (let s = segments.length - 1; s >= 0; s -= 1) {
            const segment = segments[s];
            if (segment.kind === 'subagents' && sameCall(segment.parentToolCallId, stamp.parentToolCallId)) return s;
        }
    }
    for (let s = segments.length - 1; s >= 0; s -= 1) {
        const segment = segments[s];
        if (segment.kind === 'subagents' && isOpenGroup(segment)) return s;
    }
    return -1;
}

/**
 * Applies `update` to the run the stamp names, creating the run (and its group,
 * at the end of the turn) when it is not there yet: a child event that arrives
 * before its lifecycle event, or in a follower that joined mid-run, must not be
 * dropped.
 */
function updateRun(
    segments: LiveSegment[],
    stamp: RunStamp,
    resumed: boolean,
    update: (run: LiveSubagentRun) => LiveSubagentRun,
): LiveSegment[] {
    let next = segments;
    let s = locateGroup(segments, stamp);
    if (s < 0) {
        // The group is the delegation call's, however its child is keyed.
        const callId = delegationCallIdOf(stamp.parentToolCallId);
        const created: SubagentsSegment = {
            kind: 'subagents',
            ...(callId ? { parentToolCallId: callId } : {}),
            parallel: stamp.parallel === true,
            runs: [],
        };
        next = [...segments, created];
        s = next.length - 1;
    }
    const group = next[s] as SubagentsSegment;
    const runs = [...group.runs];
    let r = stamp.id
        ? runs.findIndex((run) => run.id === stamp.id)
        : runs.map((run) => run.name === stamp.name).lastIndexOf(true);
    if (r < 0) {
        const parentToolCallId = delegationCallIdOf(stamp.parentToolCallId ?? group.parentToolCallId);
        runs.push({
            id: stamp.id ?? `${stamp.name}:${runs.length}`,
            name: stamp.name,
            ...(parentToolCallId ? { parentToolCallId } : {}),
            ...(stamp.parallel ? { parallel: true } : {}),
            ...(resumed ? { resumed: true } : {}),
            phase: 'start',
            steps: [],
            compactions: [],
        });
        r = runs.length - 1;
    }
    runs[r] = update(runs[r]);
    const out = [...next];
    out[s] = { ...group, parallel: group.parallel || stamp.parallel === true, runs };
    return out;
}

/** One call of a sub-agent, started or settled, inside its run. */
function applyChildToolEvent(segments: LiveSegment[], event: LiveToolEvent, stamp: AgentToolCallSubagentStamp): LiveSegment[] {
    return updateRun(segments, stamp, event.resumed === true, (run) => {
        const base: LiveSubagentRun = {
            ...run,
            ...(event.resumed === true && !run.resumed ? { resumed: true } : {}),
        };
        if (event.phase === 'start') {
            const key = event.id ?? `${event.name}:${run.steps.length}`;
            if (event.id && run.steps.some((step) => step.key === key)) return base;
            const call: LiveToolCall = { key, name: event.name, detail: summariseArgs(event.args), running: true, subagent: stamp };
            // A call after a pause means the run is working again.
            return { ...base, phase: run.phase === 'paused' ? 'start' : run.phase, steps: [...run.steps, call] };
        }
        const index = event.id
            ? run.steps.findIndex((step) => step.key === event.id)
            : run.steps.map((step) => step.name === event.name && step.running).lastIndexOf(true);
        if (index < 0) return base;
        const steps = [...run.steps];
        steps[index] = {
            ...steps[index],
            running: false,
            durationMs: event.durationMs,
            ...(event.error ? { error: event.error } : {}),
        };
        return { ...base, steps };
    });
}

function countCalls(segments: LiveSegment[]): number {
    return segments.reduce((n, segment) => {
        if (segment.kind === 'tools') return n + segment.calls.length;
        if (segment.kind === 'subagents' && segment.call) return n + 1;
        return n;
    }, 0);
}

function appendCall(segments: LiveSegment[], call: LiveToolCall): LiveSegment[] {
    const last = segments[segments.length - 1];
    if (last?.kind === 'tools') {
        return [...segments.slice(0, -1), { kind: 'tools', calls: [...last.calls, call] }];
    }
    return [...segments, { kind: 'tools', calls: [call] }];
}

/**
 * Applies one `tool` frame.
 *
 * - A call to a delegation tool opens a `subagents` group; its end settles the
 *   group's `call`. It is the agent's own call whatever it is stamped with: a
 *   child cannot delegate, and a stamp on one only names the sub-agent the task
 *   was handed to - taking it for that sub-agent's call would open a ghost run.
 * - A call a sub-agent made (`event.subagent`) goes into that run, found by the
 *   stamp's id, else the group of the stamp's delegation call, else the newest
 *   group still open; the run is created when missing.
 * - A call to the plan tool adds no row: the plan it wrote shows as a plan
 *   segment (`applyLivePlan`). Only a failed plan call shows, so the failure is
 *   not hidden.
 * - Any other call is a row in the current tools run, as before.
 */
export function applyLiveToolEvent(segments: LiveSegment[], event: LiveToolEvent): LiveSegment[] {
    if (isDelegationTool(event.name)) return applyDelegationEvent(segments, event);

    if (event.subagent) return applyChildToolEvent(segments, event, event.subagent);

    if (isPlanTool(event.name)) {
        if (event.phase !== 'error') return segments;
        return appendCall(segments, {
            key: event.id ?? `${event.name}:${countCalls(segments)}`,
            name: event.name,
            running: false,
            durationMs: event.durationMs,
            error: event.error ?? 'failed',
        });
    }

    if (event.phase === 'start') {
        const call: LiveToolCall = {
            key: event.id ?? `${event.name}:${countCalls(segments)}`,
            name: event.name,
            detail: summariseArgs(event.args),
            running: true,
        };
        return appendCall(segments, call);
    }
    // Terminal phases carry the same id as their start, so the row updates in
    // place; without an id (some providers omit it) the newest running row of
    // that name is the one that just finished.
    for (let s = segments.length - 1; s >= 0; s -= 1) {
        const segment = segments[s];
        if (segment.kind !== 'tools') continue;
        const index = event.id
            ? segment.calls.findIndex((call) => call.key === event.id)
            : segment.calls.map((call) => call.name === event.name && call.running).lastIndexOf(true);
        if (index < 0) continue;
        const calls = [...segment.calls];
        calls[index] = {
            ...calls[index],
            running: false,
            durationMs: event.durationMs,
            ...(event.error ? { error: event.error } : {}),
        };
        const next = [...segments];
        next[s] = { kind: 'tools', calls };
        return next;
    }
    return segments;
}

/** The delegation call itself: its start opens (or claims) the group, its end settles the group's `call`. */
function applyDelegationEvent(segments: LiveSegment[], event: LiveToolEvent): LiveSegment[] {
    const parallel = event.name === 'spawn_subagents_parallel';
    if (event.phase === 'start') {
        const call: LiveToolCall = {
            key: event.id ?? `${event.name}:${countCalls(segments)}`,
            name: event.name,
            detail: summariseArgs(event.args),
            running: true,
        };
        // Sub-agent events can outrun the call: that group is waiting for it.
        for (let s = segments.length - 1; s >= 0; s -= 1) {
            const segment = segments[s];
            if (segment.kind === 'subagents' && sameCall(segment.parentToolCallId, event.id) && !segment.call) {
                const next = [...segments];
                next[s] = { ...segment, call, parallel: segment.parallel || parallel };
                return next;
            }
        }
        return [
            ...segments,
            { kind: 'subagents', ...(event.id ? { parentToolCallId: event.id } : {}), call, parallel, runs: [] },
        ];
    }
    for (let s = segments.length - 1; s >= 0; s -= 1) {
        const segment = segments[s];
        if (segment.kind !== 'subagents' || !segment.call) continue;
        const matches = event.id ? segment.call.key === event.id : segment.call.running && segment.call.name === event.name;
        if (!matches) continue;
        const next = [...segments];
        next[s] = {
            ...segment,
            call: {
                ...segment.call,
                running: false,
                durationMs: event.durationMs,
                ...(event.error ? { error: event.error } : {}),
            },
        };
        return next;
    }
    return segments;
}

/** The newest plan version a live turn has written so far. */
export function latestLivePlan(segments: LiveSegment[]): IAgentTurnPlanSnapshot | undefined {
    for (let s = segments.length - 1; s >= 0; s -= 1) {
        const segment = segments[s];
        if (segment.kind === 'plan') return segment.plan;
    }
    return undefined;
}

/**
 * Applies one `plan` frame: a new plan segment. `previous` is the last plan
 * this turn already showed, else `basePlan` (the session's plan before the
 * turn), so the first version of a turn can still say what changed. A frame
 * seen twice (a followed session replays) is not shown twice.
 */
export function applyLivePlan(
    segments: LiveSegment[],
    plan: IAgentTurnPlanSnapshot,
    basePlan?: IAgentTurnPlanSnapshot | null,
): LiveSegment[] {
    if (segments.some((segment) => segment.kind === 'plan' && segment.plan.version === plan.version && segment.plan.at === plan.at)) {
        return segments;
    }
    const previous = latestLivePlan(segments) ?? basePlan ?? undefined;
    return [...segments, { kind: 'plan', plan, ...(previous ? { previous } : {}) }];
}

/**
 * Applies one `subagent` frame: finds the run (in the group of the delegation
 * call it names, else by id, else a new group at the end of the turn) and
 * updates its header. Fields a frame does not carry keep their value, so a
 * `result` does not wipe the `input` the `start` set.
 */
export function applyLiveSubagent(segments: LiveSegment[], event: AgentSubagentEvent): LiveSegment[] {
    return updateRun(
        segments,
        { id: event.id, name: event.name, parentToolCallId: event.parentToolCallId, parallel: event.parallel },
        event.resumed === true,
        (run) => ({
            ...run,
            name: event.name || run.name,
            phase: event.phase,
            ...(event.mode ? { mode: event.mode } : {}),
            ...(event.parallel ? { parallel: true } : {}),
            ...(event.resumed ? { resumed: true } : {}),
            ...(event.status !== undefined ? { status: event.status } : {}),
            ...(event.note !== undefined ? { note: event.note } : {}),
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.content !== undefined ? { result: event.content } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            ...(event.usage ? { usage: event.usage } : {}),
            ...(event.target ? { target: event.target } : {}),
        }),
    );
}

// ── Summarization ───────────────────────────────────────────────────────

/**
 * Adds, replaces or removes the entry for one pass in a list that may hold
 * other things (`read` returns the pass an item stands for, if it is one):
 * `start` adds a pending entry; a finished pass replaces the entry with the
 * same id (pending or not - the same pass seen again), else is added;
 * `skipped` removes the pending entry with that id (the newest pending one
 * when the frame has no id).
 */
function mergePass<T>(
    items: T[],
    event: AgentCompactionEvent,
    read: (item: T) => AgentCompactionEvent | undefined,
    make: (event: AgentCompactionEvent, pending: boolean) => T,
): T[] {
    const id = event.id;
    const lastIndex = (test: (pass: AgentCompactionEvent) => boolean): number => {
        for (let i = items.length - 1; i >= 0; i -= 1) {
            const pass = read(items[i]);
            if (pass && test(pass)) return i;
        }
        return -1;
    };
    if (event.phase === 'start') {
        if (id !== undefined && lastIndex((pass) => pass.id === id) >= 0) return items;
        return [...items, make(event, true)];
    }
    if (event.phase === 'skipped') {
        const index = lastIndex((pass) => pass.phase === 'start' && (id === undefined || pass.id === id));
        return index < 0 ? items : items.filter((_, i) => i !== index);
    }
    const index = id !== undefined ? lastIndex((pass) => pass.id === id) : -1;
    if (index < 0) return [...items, make(event, false)];
    const next = [...items];
    next[index] = make(event, false);
    return next;
}

/**
 * Applies one `summary` frame (a summarization pass starting, being skipped or
 * finished).
 *
 * - A pass a sub-agent made (`event.subagent`) goes into that run's
 *   `compactions`, handled the same way, and is stamped with where in the run
 *   it happened (`afterToolCallId`: its newest settled call, `null` before any)
 *   so the group can show it between the right steps.
 * - The agent's own pass is a `compaction` segment, `pending` from its `start`
 *   frame until the finished pass with the same id replaces it in place.
 */
export function applyLiveCompaction(segments: LiveSegment[], event: AgentCompactionEvent): LiveSegment[] {
    const child = event.subagent;
    if (child) {
        return updateRun(segments, { id: child.id, name: child.name }, false, (run) => {
            const prior = event.id !== undefined ? run.compactions.find((pass) => pass.id === event.id) : undefined;
            let settled: string | null = null;
            for (const step of run.steps) if (!step.running) settled = step.key;
            const positioned: AgentCompactionEvent = event.afterToolCallId !== undefined
                ? event
                : { ...event, afterToolCallId: prior?.afterToolCallId !== undefined ? prior.afterToolCallId : settled };
            return {
                ...run,
                compactions: mergePass(run.compactions, positioned, (pass) => pass, (pass) => pass),
            };
        });
    }
    return mergePass<LiveSegment>(
        segments,
        event,
        (segment) => (segment.kind === 'compaction' ? segment.compaction : undefined),
        (compaction, pending) => ({ kind: 'compaction', compaction, pending }),
    );
}

/**
 * True while the model is writing: the newest segment is a settled tools run, a
 * delegation whose runs have all ended, a plan, or a finished pass. False
 * while anything runs or waits, while a pass is being made, and after text.
 */
export function isGenerating(segments: LiveSegment[]): boolean {
    const last = segments[segments.length - 1];
    if (!last) return false;
    switch (last.kind) {
        case 'tools':
            return last.calls.every((call) => !call.running);
        case 'subagents':
            // A run waiting for a person has not ended, but the model is not writing either.
            return !last.call?.running && last.runs.every((run) => run.phase === 'result' || run.phase === 'error');
        case 'plan':
            return true;
        case 'compaction':
            return !last.pending;
        default:
            return false;
    }
}
