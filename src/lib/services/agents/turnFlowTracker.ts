/**
 * What happened in one invoke leg of an agent turn, and in which order: the plan
 * versions the agent wrote, the sub-agents it ran (with their own tool calls and
 * summarization passes) and the passes that summarized its own context.
 *
 * The SDK announces each of these as a separate event kind and never says where
 * in the turn it stands: a plan event carries no tool call id, a summarization
 * event no position, and a child's events arrive among the parent's, told apart
 * only by the stamp the SDK puts on them. The tracker is fed every event in
 * arrival order and keeps the little state that turns them into what the session
 * view needs: the anchors (the last finished tool call, the open plan call), the
 * records stored on the message, and the frames to forward live.
 *
 * Pure: no database, no clock but `now`, no callbacks. The three invoke paths of
 * `agentService.ts` (background/API, playground, resume) each own one tracker per
 * leg and hand it every SDK event, so they record the same things the same way.
 */

import type {
    AgentPlanStepStatus,
    IAgentPlanStep,
    IAgentSubagent,
    IAgentSubagentStep,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';
import {
    isDelegationTool,
    isPlanTool,
    type AgentCompactionEvent,
    type AgentPlanEvent,
    type AgentSubagentEvent,
    type AgentToolCallSubagentStamp,
} from '@/lib/shared/agentTurnFlow';
import { compactionFromEvent } from './agentTurnState';
import { normalizePlaygroundUsage } from './playgroundUsage';
import { isSubagentEvent, subagentStampOf } from './subagentEvents';

/** The bounds that keep one message's flow records small, whatever the agent does. */
export const TURN_FLOW_LIMITS = {
    /** Plan versions kept per leg: the first and the latest ones. */
    plans: 30,
    planSteps: 100,
    planText: 500,
    /** Sub-agent runs kept per leg; later ones are counted in `subagentRunsDropped`. */
    runs: 64,
    stepsPerRun: 50,
    /** A run's task and answer. */
    runText: 2048,
    runNote: 1000,
    /** A step's args or output: kept whole up to this size (as JSON), else cut to a preview of it. */
    stepValue: 1024,
    /** All steps' args and output of a leg together; past it steps keep neither. */
    stepBudget: 64 * 1024,
    compactionsPerRun: 20,
    /** What a sub-agent's pass keeps of what its summarizer wrote: this many entries of each list (every text in it is cut to `runText`). */
    compactionItems: 10,
} as const;

/** What a summarization event becomes: the frame to forward and whether the session log records it. */
export interface TurnFlowCompactionNote {
    event: AgentCompactionEvent;
    /** False for live-only frames (`start`, `skipped`) and for a pass that merely completes one already recorded. */
    persist: boolean;
}

export interface TurnFlowSnapshot {
    plans: IAgentTurnPlanSnapshot[];
    /**
     * How many calls of the agent's own plan tools succeeded, whatever they wrote. A turn
     * with calls and no `plans` only read its plan: the record still says it keeps plan
     * versions, so the read is left out of the transcript as it is live.
     */
    planCalls: number;
    subagentRuns: IAgentTurnSubagentRun[];
    subagentRunsDropped: number;
    /** The agent's own passes, positioned. A sub-agent's are on its run. */
    compactions: IAgentTurnCompaction[];
}

export interface TurnFlowTrackerOptions {
    /** Delegation calls this leg re-enters after a child's pause was answered (`resumedDelegationIds`). */
    resumedDelegationIds?: ReadonlySet<string>;
    /** What a sub-agent's name stands for in the agent's roster, when Console knows (`subagentTargets`). */
    targets?: ReadonlyMap<string, NonNullable<IAgentTurnSubagentRun['target']>>;
    now?: () => Date;
}

export interface TurnFlowTracker {
    /**
     * A `tool_call` event. Returns the stamp for a delegated child's call, with the
     * delegation it belongs to, so live rows and log rows can be grouped. `dropped`
     * is set for a call of a child whose run the tracker has no room for (past the
     * cap): there is no stamp, and the call is not to be told or logged.
     */
    noteToolCall(event: object): { stamp?: AgentToolCallSubagentStamp; dropped?: true };
    /** A `plan` event of the agent's own: the version to forward, or undefined (a read, a child's, one already seen). */
    notePlan(event: object): AgentPlanEvent | undefined;
    /** A `subagent` lifecycle event: the frame to forward. */
    noteSubagent(event: object): AgentSubagentEvent | undefined;
    /**
     * A `summarization` event of any kind (see {@link TurnFlowCompactionNote}); undefined for
     * one of a sub-agent whose run the tracker has no room for.
     */
    noteCompaction(event: object): TurnFlowCompactionNote | undefined;
    /**
     * At the end of the leg: gives each of the agent's passes the tool results IT
     * replaced, for an SDK that does not say (< 0.20). `turnLevel` is the whole
     * leg's replaced results, found by comparing the transcript before and after.
     * A pass leaves the newest round of calls (what the model has not yet read)
     * alone, so each result goes to the first pass that ran after a LATER round
     * of calls had begun. Returns the agent's passes.
     */
    finalizeCompactedTools(turnLevel: ReadonlyArray<{ toolName: string; toolCallId: string }>): IAgentTurnCompaction[];
    snapshot(): TurnFlowSnapshot;
}

type Loose = Record<string, unknown>;

const PLAN_STATUSES: ReadonlySet<string> = new Set<AgentPlanStepStatus>(['not-started', 'in-progress', 'completed', 'blocked']);
const SUBAGENT_PHASES: ReadonlySet<string> = new Set(['start', 'result', 'error', 'paused']);
const TRIGGERS: ReadonlySet<string> = new Set(['pre_leg', 'mid_leg', 'post_tools']);

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/** `value` cut to `max` characters (the last one an ellipsis); undefined for anything but a string. */
function clip(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function errorMessage(error: unknown): string | undefined {
    if (typeof error === 'string') return error || undefined;
    return text((error as { message?: unknown } | undefined)?.message);
}

/** The roster's sub-agents by name, as a run's `target` reports them. */
export function subagentTargets(
    entries: ReadonlyArray<Pick<IAgentSubagent, 'kind' | 'name' | 'agentKey' | 'agentVersion'>>,
): Map<string, NonNullable<IAgentTurnSubagentRun['target']>> {
    const targets = new Map<string, NonNullable<IAgentTurnSubagentRun['target']>>();
    for (const entry of entries) {
        if (!entry.name || targets.has(entry.name)) continue;
        targets.set(entry.name, entry.kind === 'ref'
            ? {
                kind: 'ref',
                ...(entry.agentKey ? { agentName: entry.agentKey } : {}),
                ...(typeof entry.agentVersion === 'number' ? { version: entry.agentVersion } : {}),
            }
            : { kind: 'inline' });
    }
    return targets;
}

/** One plan step as the SDK's `todoList` holds it, text clipped, an unknown status read as not started. */
function toPlanStep(raw: unknown, index: number): IAgentPlanStep {
    const step = (raw && typeof raw === 'object' ? raw : {}) as Loose;
    const id = typeof step.id === 'number' || typeof step.id === 'string' ? step.id : index + 1;
    const limit = TURN_FLOW_LIMITS.planText;
    const owner = clip(step.owner, limit);
    const exitCriteria = clip(step.exitCriteria, limit);
    const evidence = clip(step.evidence, limit);
    return {
        id,
        title: clip(step.title, limit) ?? clip(step.step, limit) ?? '',
        status: typeof step.status === 'string' && PLAN_STATUSES.has(step.status) ? (step.status as AgentPlanStepStatus) : 'not-started',
        ...(owner ? { owner } : {}),
        ...(exitCriteria ? { exitCriteria } : {}),
        ...(evidence ? { evidence } : {}),
    };
}

/** A plan's steps as the SDK holds them, normalized the way a recorded version is (at most 100). */
export function planStepsOf(list: unknown): IAgentPlanStep[] {
    return Array.isArray(list) ? list.slice(0, TURN_FLOW_LIMITS.planSteps).map(toPlanStep) : [];
}

/**
 * A sub-agent's pass as its run keeps it. What the summarizer wrote is a model's own text, so it
 * is bounded the way the run's task and answer are: every text is cut to `runText` and every list
 * to `compactionItems` entries (the replaced results to the steps a run keeps). The ids, the
 * position, the trigger, the counts and the status are small and stay as they are.
 */
function boundedPass(pass: IAgentTurnCompaction): IAgentTurnCompaction {
    const { runText, compactionItems, stepsPerRun } = TURN_FLOW_LIMITS;
    const cut = (value: unknown) => clip(value, runText) ?? '';
    const some = (list: unknown, size: number = compactionItems): unknown[] => (Array.isArray(list) ? list.slice(0, size) : []);
    const texts = (list: unknown) => some(list).filter((entry): entry is string => typeof entry === 'string').map(cut);
    const { summary } = pass;
    return {
        ...pass,
        ...(summary
            ? {
                summary: {
                    ...(summary.userDirectives ? { userDirectives: texts(summary.userDirectives) } : {}),
                    ...(summary.directiveSources
                        ? { directiveSources: Object.fromEntries(Object.entries(summary.directiveSources).slice(0, compactionItems).map(([directive, quote]) => [cut(directive), cut(quote)])) }
                        : {}),
                    ...(summary.facts ? { facts: some(summary.facts).map((fact) => ({ key: cut((fact as Loose)?.key), value: cut((fact as Loose)?.value) })) } : {}),
                    ...(summary.goals ? { goals: texts(summary.goals) } : {}),
                    ...(summary.openQuestions ? { openQuestions: texts(summary.openQuestions) } : {}),
                    ...(summary.discarded ? { discarded: texts(summary.discarded) } : {}),
                },
            }
            : {}),
        ...(pass.droppedDirectives
            ? {
                droppedDirectives: some(pass.droppedDirectives).map((entry) => {
                    const dropped = (entry ?? {}) as Loose;
                    return { directive: cut(dropped.directive), reason: cut(dropped.reason), ...(dropped.sourceQuote ? { sourceQuote: cut(dropped.sourceQuote) } : {}) };
                }),
            }
            : {}),
        ...(pass.integrityNotes ? { integrityNotes: texts(pass.integrityNotes) } : {}),
        ...(pass.compactedTools ? { compactedTools: pass.compactedTools.slice(0, stepsPerRun) } : {}),
    };
}

interface RunState {
    run: IAgentTurnSubagentRun;
    /** Created from a child's own event, before (or without) its `start` in this leg. */
    fromStamp: boolean;
    /** Ids of the child calls past the step cap, so their results are not mistaken for new steps. */
    droppedStepIds: Set<string>;
}

interface PassState {
    compaction: IAgentTurnCompaction;
    /** How many of the agent's tool calls had finished when the pass happened. */
    finishedBefore: number;
    /** How many rounds of the agent's tool calls had begun when the pass happened. */
    round: number;
    /** How many tool events of the agent's own had gone by, to spot a double emit right after this pass. */
    toolEventsAt: number;
    summary: string | undefined;
}

export function createTurnFlowTracker(options: TurnFlowTrackerOptions = {}): TurnFlowTracker {
    const now = () => (options.now ? options.now() : new Date()).toISOString();
    const resumedIds = options.resumedDelegationIds ?? new Set<string>();
    const limits = TURN_FLOW_LIMITS;

    // The agent's own tool calls: the ones in flight (in start order) anchor a plan
    // event, the last one finished anchors a summarization pass.
    const openCalls = new Map<string, string>();
    let lastFinished: string | null = null;
    let finishedCount = 0;
    const finishOrder = new Map<string, number>();
    let parentToolEvents = 0;
    // The calls come in rounds, one per model reply: a call that starts while others are in
    // flight joins their round, one that starts with none open begins the next. The summarizer
    // leaves the newest round alone (the model has not read it yet), which is how a pass is
    // matched to the results it replaced (see `finalizeCompactedTools`).
    let round = 0;
    const roundOf = new Map<string, number>();
    let planCalls = 0;

    const plans: IAgentTurnPlanSnapshot[] = [];
    const planVersions = new Set<number>();
    let lastVersion = 0;

    const runs = new Map<string, RunState>();
    const droppedRuns = new Set<string>();
    let runsDropped = 0;
    let stepBudget: number = limits.stepBudget;

    const passes: PassState[] = [];
    let passesCarryTools = false;

    // ── Sub-agent runs ──────────────────────────────────────────────

    /** The run for an id, made when it is new; undefined when it is past the cap (counted once). */
    function runFor(id: string, name: string, fromStamp: boolean): RunState | undefined {
        const known = runs.get(id);
        if (known) return known;
        if (droppedRuns.has(id)) return undefined;
        if (runs.size >= limits.runs) {
            droppedRuns.add(id);
            runsDropped += 1;
            return undefined;
        }
        // A run first seen through a child's own event is one a start of an earlier leg opened:
        // the delegation it belongs to is the one in flight, when exactly one is.
        const delegations = fromStamp ? [...openCalls].filter(([, tool]) => isDelegationTool(tool)) : [];
        const target = options.targets?.get(name);
        const state: RunState = {
            run: {
                id,
                name,
                ...(fromStamp ? { resumed: true as const } : {}),
                ...(delegations.length === 1 ? { parentToolCallId: delegations[0][0], ...(delegations[0][1] === 'spawn_subagents_parallel' ? { parallel: true } : {}) } : {}),
                phase: 'start',
                ...(target ? { target } : {}),
                startedAt: now(),
                steps: [],
            },
            fromStamp,
            droppedStepIds: new Set(),
        };
        runs.set(id, state);
        return state;
    }

    /** The run a stamped child event came from, by id, else by name (the newest one still going first). */
    function runOfStamp(stamp: { id?: string; name: string }): RunState | undefined {
        if (stamp.id) {
            if (droppedRuns.has(stamp.id)) return undefined;
            return runs.get(stamp.id) ?? runFor(stamp.id, stamp.name, true);
        }
        const byName = [...runs.values()].filter((state) => state.run.name === stamp.name);
        const found = [...byName].reverse().find((state) => state.run.phase === 'start') ?? byName[byName.length - 1];
        return found ?? runFor(stamp.name, stamp.name, true);
    }

    /** `value` as a step stores it: whole when small, else a preview, and nothing once the leg's budget is spent. */
    function storeValue(value: unknown): { has: boolean; stored?: unknown; truncated: boolean } {
        if (value === undefined) return { has: false, truncated: false };
        let json: string | undefined;
        try {
            json = JSON.stringify(value);
        } catch {
            json = undefined;
        }
        if (json === undefined) return { has: false, truncated: true };
        const whole = json.length <= limits.stepValue;
        const cost = whole ? json.length : limits.stepValue;
        if (cost > stepBudget) {
            stepBudget = 0;
            return { has: false, truncated: true };
        }
        stepBudget -= cost;
        return { has: true, stored: whole ? value : json.slice(0, limits.stepValue), truncated: !whole };
    }

    function noteChildToolCall(state: RunState, event: Loose): void {
        const run = state.run;
        const phase = event.phase;
        const id = text(event.id);
        const name = text(event.name) ?? 'tool';
        if (phase === 'start') {
            if (run.steps.length >= limits.stepsPerRun) {
                run.stepsDropped = (run.stepsDropped ?? 0) + 1;
                if (id) state.droppedStepIds.add(id);
                return;
            }
            const step: IAgentSubagentStep = { ...(id ? { id } : {}), name, status: 'running', timestamp: now() };
            const args = storeValue(event.args);
            if (args.has) step.args = args.stored;
            if (args.truncated) step._truncated = true;
            run.steps.push(step);
            return;
        }
        if (phase !== 'success' && phase !== 'error') return;
        if (id && state.droppedStepIds.has(id)) return;
        let step = id
            ? run.steps.find((candidate) => candidate.id === id)
            : [...run.steps].reverse().find((candidate) => candidate.name === name && candidate.status === 'running');
        if (!step) {
            // The start was not seen (an earlier leg's): the result alone still says what ran.
            if (run.steps.length >= limits.stepsPerRun) {
                run.stepsDropped = (run.stepsDropped ?? 0) + 1;
                return;
            }
            step = { ...(id ? { id } : {}), name, status: 'running', timestamp: now() };
            run.steps.push(step);
        }
        step.status = phase === 'success' ? 'success' : 'error';
        if (phase === 'success') {
            const output = storeValue(event.result);
            if (output.has) step.output = output.stored;
            if (output.truncated) step._truncated = true;
        } else {
            const failure = clip(errorMessage(event.error), limits.stepValue);
            if (failure) step.error = failure;
        }
        if (typeof event.durationMs === 'number') step.durationMs = event.durationMs;
    }

    // ── Tool calls ──────────────────────────────────────────────────

    function noteToolCall(raw: object): { stamp?: AgentToolCallSubagentStamp; dropped?: true } {
        const event = raw as Loose;
        const stamp = subagentStampOf(event);
        const phase = event.phase;
        // A child of a run past the cap has no run to hold its calls: a stamp would send them
        // live to a group that never ends, so they are neither stamped, told nor logged.
        if (stamp && droppedRuns.has(stamp.id ?? stamp.name)) return { dropped: true };
        if (phase !== 'start' && phase !== 'success' && phase !== 'error') return stamp ? { stamp } : {};

        if (!stamp) {
            parentToolEvents += 1;
            const id = text(event.id);
            if (id) {
                if (phase === 'start') {
                    if (openCalls.size === 0) round += 1;
                    openCalls.set(id, text(event.name) ?? '');
                    roundOf.set(id, round);
                } else {
                    // A result with no start here (the call began in an earlier leg) joins the round in flight, else opens one.
                    if (!roundOf.has(id)) roundOf.set(id, openCalls.size > 0 ? round : ++round);
                    openCalls.delete(id);
                    lastFinished = id;
                    if (!finishOrder.has(id)) finishOrder.set(id, ++finishedCount);
                }
            }
            if (phase === 'success' && isPlanTool(text(event.name))) planCalls += 1;
            return {};
        }

        const state = runOfStamp(stamp);
        if (!state) return { dropped: true };
        noteChildToolCall(state, event);
        const parentToolCallId = state.run.parentToolCallId;
        return {
            stamp: {
                ...stamp,
                ...(parentToolCallId ? { parentToolCallId } : {}),
                ...(state.run.parallel ? { parallel: true } : {}),
            },
        };
    }

    // ── Plan ────────────────────────────────────────────────────────

    function notePlan(raw: object): AgentPlanEvent | undefined {
        if (isSubagentEvent(raw)) return undefined;
        const event = raw as Loose;
        const operation = event.operation;
        if (operation !== 'write' && operation !== 'update') return undefined;
        const version = typeof event.version === 'number' && Number.isFinite(event.version) ? event.version : lastVersion + 1;
        if (planVersions.has(version)) return undefined;
        planVersions.add(version);
        lastVersion = Math.max(lastVersion, version);

        let toolCallId = text(event.toolCallId);
        if (!toolCallId) {
            for (const [id, tool] of [...openCalls].reverse()) {
                if (isPlanTool(tool)) {
                    toolCallId = id;
                    break;
                }
            }
        }
        const snapshot: IAgentTurnPlanSnapshot = {
            ...(toolCallId ? { toolCallId } : {}),
            version,
            operation: operation as 'write' | 'update',
            steps: planStepsOf(event.todoList),
            ...(typeof event.adherenceScore === 'number' && Number.isFinite(event.adherenceScore) ? { completion: event.adherenceScore } : {}),
            at: now(),
        };
        // The first version shows what the agent set out to do; the newest ones what became of it.
        if (plans.length >= limits.plans) plans.splice(1, 1);
        plans.push(snapshot);
        return { ...snapshot, steps: snapshot.steps.map((step) => ({ ...step })) };
    }

    // ── Sub-agents ──────────────────────────────────────────────────

    function noteSubagent(raw: object): AgentSubagentEvent | undefined {
        if (isSubagentEvent(raw)) return undefined;
        const event = raw as Loose;
        const phase = event.phase;
        const id = text(event.id);
        if (typeof phase !== 'string' || !SUBAGENT_PHASES.has(phase) || !id) return undefined;
        const name = text(event.name) ?? id;
        // A run whose first event here is not its start was started by an earlier leg (it paused for a person).
        const state = runFor(id, name, phase !== 'start');
        if (!state) return undefined;
        const run = state.run;
        const at = now();

        run.name = name;
        if (event.mode === 'registry' || event.mode === 'adhoc') run.mode = event.mode;
        const parentToolCallId = text(event.parentToolCallId);
        if (parentToolCallId) run.parentToolCallId = parentToolCallId;
        if (event.parallel === true) run.parallel = true;
        run.phase = phase as IAgentTurnSubagentRun['phase'];
        const target = options.targets?.get(name);
        if (target) run.target = target;

        if (phase === 'start') {
            // A child's own events can reach the tracker first (a resumed leg): the start settles it.
            state.fromStamp = false;
            if (run.parentToolCallId && resumedIds.has(run.parentToolCallId)) run.resumed = true;
            else delete run.resumed;
            const input = clip(event.input, limits.runText);
            if (input !== undefined) run.input = input;
            run.startedAt = at;
        } else {
            const result = clip(event.content, limits.runText);
            if (result !== undefined) run.result = result;
            if (phase !== 'paused') run.endedAt = at;
        }
        const status = text(event.status);
        if (status) run.status = status;
        const note = clip(event.note, limits.runNote);
        if (note) run.note = note;
        const error = clip(errorMessage(event.error), limits.runNote);
        if (error) run.error = error;
        if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) run.durationMs = event.durationMs;
        const usage = event.usage ? normalizePlaygroundUsage(event.usage)?.usage : undefined;
        if (usage) {
            run.usage = {
                ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
            };
        }

        return {
            phase: phase as AgentSubagentEvent['phase'],
            id,
            name,
            ...(run.mode ? { mode: run.mode } : {}),
            ...(run.parentToolCallId ? { parentToolCallId: run.parentToolCallId } : {}),
            ...(run.parallel ? { parallel: true } : {}),
            ...(run.resumed ? { resumed: true } : {}),
            ...(run.status ? { status: run.status } : {}),
            ...(run.note ? { note: run.note } : {}),
            ...(phase === 'start' && run.input !== undefined ? { input: run.input } : {}),
            ...(phase !== 'start' && run.result !== undefined ? { content: run.result } : {}),
            ...(run.error ? { error: run.error } : {}),
            ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
            ...(run.usage ? { usage: { ...run.usage } } : {}),
            ...(run.target ? { target: { ...run.target } } : {}),
            at,
        };
    }

    // ── Summarization ───────────────────────────────────────────────

    function perPassTools(event: Loose): Array<{ toolName: string; toolCallId: string }> | undefined {
        if (!Array.isArray(event.compactedTools)) return undefined;
        return event.compactedTools
            .map((entry) => entry as Loose)
            .filter((entry) => typeof entry?.toolCallId === 'string' && typeof entry?.toolName === 'string')
            .map((entry) => ({ toolName: entry.toolName as string, toolCallId: entry.toolCallId as string }));
    }

    function noteCompaction(raw: object): TurnFlowCompactionNote | undefined {
        const event = raw as Loose;
        const stamp = subagentStampOf(event);
        const subagent = stamp ? { ...(stamp.id ? { id: stamp.id } : {}), name: stamp.name } : undefined;
        const trigger = typeof event.trigger === 'string' && TRIGGERS.has(event.trigger)
            ? (event.trigger as IAgentTurnCompaction['trigger'])
            : undefined;

        // A pass that started or ended without a change is told live and never kept:
        // it changed nothing in the transcript the message stores.
        if (event.phase === 'start' || event.phase === 'skipped') {
            // Nor is one of a child whose run is past the cap: there is no group to show it in (see `noteToolCall`).
            if (stamp && droppedRuns.has(stamp.id ?? stamp.name)) return undefined;
            const frame: AgentCompactionEvent = {
                at: now(),
                phase: event.phase as 'start' | 'skipped',
                id: text(event.id) ?? `pass-${passes.length + 1}`,
                ...(trigger ? { trigger } : {}),
                // `fallback`: the summarizer failed; `error` (SDK 0.20+): the pass itself threw.
                ...(event.phase === 'skipped' && (event.status === 'fallback' || event.status === 'error') ? { failed: true } : {}),
                ...(subagent ? { subagent } : {}),
            };
            return { event: frame, persist: false };
        }

        const compaction = compactionFromEvent(raw as Parameters<typeof compactionFromEvent>[0]);
        const tools = perPassTools(event);
        if (tools) passesCarryTools = true;

        if (stamp) {
            const state = runOfStamp(stamp);
            if (!state) return undefined;
            const kept = state.run.compactions;
            const index = (kept?.length ?? 0) + 1;
            const child = boundedPass({
                ...compaction,
                id: text(event.id) ?? `pass-${state.run.id}-${index}`,
                index,
                ...(trigger ? { trigger } : {}),
                ...(tools?.length ? { compactedTools: tools } : {}),
            });
            if (index <= limits.compactionsPerRun) state.run.compactions = [...(kept ?? []), child];
            return { event: { ...child, ...(subagent ? { subagent } : {}) }, persist: true };
        }

        const previous = passes[passes.length - 1];
        // agent-sdk < 0.20 reports a failed summarizer twice: once from the failure, once as the
        // pass that ends with the same fallback summary. The second one completes the first.
        if (
            previous
            && previous.compaction.failed
            && event.status === undefined
            && previous.toolEventsAt === parentToolEvents
            && typeof event.summary === 'string'
            && event.summary === previous.summary
        ) {
            const merged: IAgentTurnCompaction = {
                ...compaction,
                failed: true,
                ...(previous.compaction.id ? { id: previous.compaction.id } : {}),
                ...(previous.compaction.index !== undefined ? { index: previous.compaction.index } : {}),
                afterToolCallId: previous.compaction.afterToolCallId ?? null,
                ...(previous.compaction.trigger ? { trigger: previous.compaction.trigger } : {}),
            };
            previous.compaction = merged;
            return { event: { ...merged }, persist: false };
        }

        const index = passes.length + 1;
        const pass: IAgentTurnCompaction = {
            ...compaction,
            id: text(event.id) ?? `pass-${index}`,
            index,
            afterToolCallId: lastFinished,
            ...(trigger ? { trigger } : {}),
            ...(tools?.length ? { compactedTools: tools } : {}),
        };
        passes.push({
            compaction: pass,
            finishedBefore: finishedCount,
            round,
            toolEventsAt: parentToolEvents,
            summary: typeof event.summary === 'string' ? event.summary : undefined,
        });
        return { event: { ...pass }, persist: true };
    }

    function finalizeCompactedTools(turnLevel: ReadonlyArray<{ toolName: string; toolCallId: string }>): IAgentTurnCompaction[] {
        if (passes.length > 0 && !passesCarryTools) {
            for (const tool of turnLevel) {
                const finished = finishOrder.get(tool.toolCallId);
                const called = roundOf.get(tool.toolCallId);
                let owner: PassState;
                if (finished === undefined || called === undefined) {
                    // A call that finished in an earlier turn is not in the order: the first pass replaced it.
                    owner = passes[0];
                } else {
                    // A pass leaves the newest round of calls alone, so it replaced a result only when a later round
                    // had begun: the first such pass. A result no such pass can own (an SDK that does not hold the
                    // newest round back) goes to the first pass after its call finished, as it did before.
                    owner = passes.find((pass) => pass.round > called)
                        ?? passes.find((pass) => pass.finishedBefore >= finished)
                        ?? passes[passes.length - 1];
                }
                owner.compaction.compactedTools = [...(owner.compaction.compactedTools ?? []), { toolName: tool.toolName, toolCallId: tool.toolCallId }];
            }
        }
        return passes.map((pass) => pass.compaction);
    }

    return {
        noteToolCall,
        notePlan,
        noteSubagent,
        noteCompaction,
        finalizeCompactedTools,
        snapshot: () => ({
            plans: [...plans],
            planCalls,
            subagentRuns: [...runs.values()].map((state) => state.run),
            subagentRunsDropped: runsDropped,
            compactions: passes.map((pass) => pass.compaction),
        }),
    };
}
