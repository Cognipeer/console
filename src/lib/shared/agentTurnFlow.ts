/**
 * What happened in an agent turn, and in which order: the agent's plan, the
 * sub-agents it ran and the passes that summarized its context, beside its tool
 * calls. The server stamps these on the turn as they happen (SSE frames, session
 * log rows, the stored message); the session view and the portal read them back
 * here, so a turn shows in the same order live, after it ends and after a reload.
 * Dependency-free: usable on the server and in the client.
 */

import type {
    AgentSubagentRunPhase,
    IAgentConversationStep,
    IAgentPlanStep,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
    IAgentTurnSubagentRun,
} from '@/lib/database/provider/types.domain';

const PLAN_TOOLS = new Set(['manage_plan', 'manage_todo_list']);
const DELEGATION_TOOLS = new Set(['delegate_to', 'spawn_subagent', 'spawn_subagents_parallel']);

/** manage_plan, or its deprecated alias manage_todo_list: the call writes the agent's plan. */
export function isPlanTool(toolName: string | undefined): boolean {
    return Boolean(toolName && PLAN_TOOLS.has(toolName));
}

/** The SDK's delegation tools: a call to one of these hands a task to a sub-agent. */
export function isDelegationTool(toolName: string | undefined): boolean {
    return Boolean(toolName && DELEGATION_TOOLS.has(toolName));
}

/**
 * The delegation call a sub-agent run belongs to. The SDK gives each child of
 * spawn_subagents_parallel its own key, `<toolCallId>#<index>`; the call itself
 * is `<toolCallId>`, so that is what the run is grouped and anchored by.
 */
export function delegationCallIdOf(parentToolCallId: string): string;
export function delegationCallIdOf(parentToolCallId: string | undefined): string | undefined;
export function delegationCallIdOf(parentToolCallId: string | undefined): string | undefined {
    return parentToolCallId?.replace(/#\d+$/, '');
}

/** SSE `plan` and session log `agent.plan`: one plan version, as the agent wrote it. */
export type AgentPlanEvent = IAgentTurnPlanSnapshot;

/** SSE `subagent` and session log `agent.subagent`: one lifecycle step of a sub-agent. */
export interface AgentSubagentEvent {
    phase: AgentSubagentRunPhase;
    /** The SDK's spawn id; a resumed run keeps it. */
    id: string;
    name: string;
    mode?: 'registry' | 'adhoc';
    parentToolCallId?: string;
    parallel?: boolean;
    /** This leg continues a run an earlier leg of the turn started (it paused for a person). */
    resumed?: boolean;
    status?: string;
    note?: string;
    /** `start`: the task it was given, clipped to 2 KB. */
    input?: string;
    /** `result` / `error`: what it answered, clipped to 2 KB. */
    content?: string;
    error?: string;
    durationMs?: number;
    usage?: IAgentTurnSubagentRun['usage'];
    target?: IAgentTurnSubagentRun['target'];
    at: string;
}

/**
 * SSE `summary` and session log `agent.compaction`: a summarization pass that
 * finished, or (live only, agent-sdk ≥ 0.20) one that started or ended without
 * changing anything. A pass a sub-agent made of its own context carries
 * `subagent`: it belongs in that sub-agent's group and never counts as the
 * parent's.
 */
export type AgentCompactionEvent = IAgentTurnCompaction & {
    subagent?: { id?: string; name: string };
    /** Absent on a finished pass. `start`: the summarizer is running; `skipped`: it ended without a change. Both share the pass's `id`. */
    phase?: 'start' | 'skipped';
};

/** `AgentToolCallEvent.subagent`: which sub-agent made the call, and under which delegation. */
export interface AgentToolCallSubagentStamp {
    id?: string;
    name: string;
    parentToolCallId?: string;
    parallel?: boolean;
}

// ── Plan ────────────────────────────────────────────────────────────────

export interface PlanProgress {
    done: number;
    total: number;
    blocked: number;
    /** The step being worked on: the first in progress, else the first not started. Absent when every step is done. */
    current?: IAgentPlanStep;
}

export function planProgress(plan: Pick<IAgentTurnPlanSnapshot, 'steps'> | null | undefined): PlanProgress {
    const steps = plan?.steps ?? [];
    const done = steps.filter((step) => step.status === 'completed').length;
    const blocked = steps.filter((step) => step.status === 'blocked').length;
    const current = steps.find((step) => step.status === 'in-progress') ?? steps.find((step) => step.status === 'not-started');
    return { done, total: steps.length, blocked, ...(current ? { current } : {}) };
}

/** What a plan version changed against the one before it, step by step (matched by id). */
export interface PlanChange {
    completed: IAgentPlanStep[];
    started: IAgentPlanStep[];
    blocked: IAgentPlanStep[];
    added: IAgentPlanStep[];
    removed: IAgentPlanStep[];
}

export function planDiff(
    previous: Pick<IAgentTurnPlanSnapshot, 'steps'> | null | undefined,
    next: Pick<IAgentTurnPlanSnapshot, 'steps'>,
): PlanChange {
    const before = new Map((previous?.steps ?? []).map((step) => [String(step.id), step]));
    const after = new Set(next.steps.map((step) => String(step.id)));
    const change: PlanChange = { completed: [], started: [], blocked: [], added: [], removed: [] };
    for (const step of next.steps) {
        const old = before.get(String(step.id));
        if (previous && !old) change.added.push(step);
        if (old?.status === step.status) continue;
        if (step.status === 'completed') change.completed.push(step);
        else if (step.status === 'in-progress') change.started.push(step);
        else if (step.status === 'blocked') change.blocked.push(step);
    }
    if (previous) change.removed = previous.steps.filter((step) => !after.has(String(step.id)));
    return change;
}

// ── Turn order ──────────────────────────────────────────────────────────

/** One block of a turn, in the order it happened. */
export type TurnFlowBlock =
    | { kind: 'narration'; text: string }
    /** Consecutive tool calls of the agent's own. */
    | { kind: 'steps'; steps: IAgentConversationStep[] }
    /** One plan version; `previous` is the version before it, when known, to show what changed. */
    | { kind: 'plan'; plan: IAgentTurnPlanSnapshot; previous?: IAgentTurnPlanSnapshot }
    /**
     * A delegation call and the sub-agents it ran. `step` is the stored call
     * (absent when the call did not finish in this message, e.g. it paused);
     * `runs` is empty on turns stored before runs were recorded.
     */
    | { kind: 'subagents'; parentToolCallId?: string; step?: IAgentConversationStep; runs: IAgentTurnSubagentRun[]; parallel: boolean }
    /** One summarization pass of the agent's own; `index` is its 1-based number in the message. */
    | { kind: 'compaction'; compaction: IAgentTurnCompaction; index: number };

export interface TurnFlowInput {
    steps?: IAgentConversationStep[];
    plans?: IAgentTurnPlanSnapshot[];
    subagentRuns?: IAgentTurnSubagentRun[];
    compactions?: IAgentTurnCompaction[];
}

export interface TurnFlowOptions {
    /** The plan as it stood before this message (an earlier turn's last version), for the first version's diff. */
    previousPlan?: IAgentTurnPlanSnapshot;
}

type Atom =
    | { kind: 'narration'; text: string }
    | { kind: 'step'; step: IAgentConversationStep }
    | { kind: 'plan'; plan: IAgentTurnPlanSnapshot; callId?: string }
    | { kind: 'subagents'; parentToolCallId?: string; step?: IAgentConversationStep; runs: IAgentTurnSubagentRun[]; parallel: boolean }
    | { kind: 'compaction'; compaction: IAgentTurnCompaction; index: number };

function timeOf(value: string | undefined): number {
    return value ? Date.parse(value) : Number.NaN;
}

function atomTime(atom: Atom): number {
    switch (atom.kind) {
        case 'step': return timeOf(atom.step.timestamp);
        case 'plan': return timeOf(atom.plan.at);
        case 'subagents': {
            const fromStep = timeOf(atom.step?.timestamp);
            return Number.isFinite(fromStep) ? fromStep : timeOf(atom.runs[0]?.startedAt);
        }
        case 'compaction': return timeOf(atom.compaction.at);
        default: return Number.NaN;
    }
}

/** Places an atom by wall clock: after the last atom that happened no later than it. */
function insertByTime(atoms: Atom[], atom: Atom): void {
    const at = atomTime(atom);
    if (!Number.isFinite(at)) {
        atoms.push(atom);
        return;
    }
    let anyTimed = false;
    for (let i = atoms.length - 1; i >= 0; i -= 1) {
        const t = atomTime(atoms[i]);
        if (!Number.isFinite(t)) continue;
        anyTimed = true;
        if (t <= at) {
            atoms.splice(i + 1, 0, atom);
            return;
        }
    }
    if (anyTimed) atoms.unshift(atom);
    else atoms.push(atom);
}

/** True when the atom stands for the tool call with this id. */
function holdsCall(atom: Atom, toolCallId: string): boolean {
    switch (atom.kind) {
        case 'step': return atom.step.id === toolCallId;
        case 'plan': return atom.callId === toolCallId;
        case 'subagents': return atom.parentToolCallId === toolCallId || atom.step?.id === toolCallId;
        default: return false;
    }
}

/**
 * The blocks of one stored assistant message, in the order they happened.
 *
 * Tool steps keep their stored order. A plan version takes the place of the
 * manage_plan call that wrote it; a delegation call becomes a group of the
 * sub-agents it ran; a summarization pass sits right after the tool call it
 * followed (`afterToolCallId`; `null` = before any). What carries no anchor (a
 * turn stored before these fields existed, or a run whose call is in another
 * message) is placed by wall clock, and at the end when it has none.
 */
export function orderTurnFlow(message: TurnFlowInput, options: TurnFlowOptions = {}): TurnFlowBlock[] {
    const steps = message.steps ?? [];
    const plans = message.plans ?? [];
    const runs = message.subagentRuns ?? [];
    const compactions = message.compactions ?? [];
    // Turns that record plan versions leave out a plan call that wrote none (a read).
    const recordsPlans = Array.isArray(message.plans);

    const plansByCall = new Map<string, IAgentTurnPlanSnapshot[]>();
    for (const plan of plans) {
        if (!plan.toolCallId) continue;
        plansByCall.set(plan.toolCallId, [...(plansByCall.get(plan.toolCallId) ?? []), plan]);
    }
    const runsByCall = new Map<string, IAgentTurnSubagentRun[]>();
    for (const run of runs) {
        // A run stored under the SDK's `<call>#<index>` key (a child of a parallel call) belongs to the call.
        const key = delegationCallIdOf(run.parentToolCallId) ?? '';
        runsByCall.set(key, [...(runsByCall.get(key) ?? []), run]);
    }

    const placedPlans = new Set<IAgentTurnPlanSnapshot>();
    const placedRunCalls = new Set<string>();
    const atoms: Atom[] = [];

    for (const step of steps) {
        if (step.narration?.trim()) atoms.push({ kind: 'narration', text: step.narration });
        const id = step.id;
        if (isPlanTool(step.name) && step.status !== 'error') {
            const written = id ? plansByCall.get(id) : undefined;
            if (written?.length) {
                for (const plan of written) {
                    atoms.push({ kind: 'plan', plan, callId: id });
                    placedPlans.add(plan);
                }
                continue;
            }
            if (recordsPlans) continue;
        }
        if (isDelegationTool(step.name)) {
            const ran = id ? runsByCall.get(id) ?? [] : [];
            if (id && ran.length) placedRunCalls.add(id);
            atoms.push({
                kind: 'subagents',
                parentToolCallId: id,
                step,
                runs: ran,
                parallel: step.name === 'spawn_subagents_parallel' || ran.length > 1 || ran.some((run) => run.parallel),
            });
            continue;
        }
        atoms.push({ kind: 'step', step });
    }

    for (const plan of plans) {
        if (!placedPlans.has(plan)) insertByTime(atoms, { kind: 'plan', plan, callId: plan.toolCallId });
    }
    for (const [callId, ran] of runsByCall) {
        if (callId && placedRunCalls.has(callId)) continue;
        insertByTime(atoms, {
            kind: 'subagents',
            ...(callId ? { parentToolCallId: callId } : {}),
            runs: ran,
            parallel: ran.length > 1 || ran.some((run) => run.parallel),
        });
    }

    let atStart = 0;
    compactions.forEach((compaction, i) => {
        const atom: Atom = { kind: 'compaction', compaction, index: compaction.index ?? i + 1 };
        if (compaction.afterToolCallId === null) {
            atoms.splice(atStart, 0, atom);
            atStart += 1;
            return;
        }
        if (typeof compaction.afterToolCallId === 'string') {
            const callId = compaction.afterToolCallId;
            let anchor = -1;
            for (let a = atoms.length - 1; a >= 0; a -= 1) {
                if (holdsCall(atoms[a], callId)) {
                    anchor = a;
                    break;
                }
            }
            if (anchor >= 0) {
                // After the anchor and after passes already placed behind it, so passes keep their order.
                let at = anchor + 1;
                while (at < atoms.length && atoms[at].kind === 'compaction') at += 1;
                atoms.splice(at, 0, atom);
                return;
            }
        }
        insertByTime(atoms, atom);
    });

    const blocks: TurnFlowBlock[] = [];
    let lastPlan = options.previousPlan;
    for (const atom of atoms) {
        switch (atom.kind) {
            case 'step': {
                const last = blocks[blocks.length - 1];
                if (last?.kind === 'steps') last.steps.push(atom.step);
                else blocks.push({ kind: 'steps', steps: [atom.step] });
                break;
            }
            case 'plan':
                blocks.push({ kind: 'plan', plan: atom.plan, ...(lastPlan ? { previous: lastPlan } : {}) });
                lastPlan = atom.plan;
                break;
            case 'narration':
                blocks.push({ kind: 'narration', text: atom.text });
                break;
            case 'subagents':
                blocks.push({
                    kind: 'subagents',
                    ...(atom.parentToolCallId ? { parentToolCallId: atom.parentToolCallId } : {}),
                    ...(atom.step ? { step: atom.step } : {}),
                    runs: atom.runs,
                    parallel: atom.parallel,
                });
                break;
            case 'compaction':
                blocks.push({ kind: 'compaction', compaction: atom.compaction, index: atom.index });
                break;
        }
    }
    return blocks;
}

/** The last plan version a list of messages recorded, oldest message first. */
export function latestPlanOf(messages: ReadonlyArray<{ plans?: IAgentTurnPlanSnapshot[] }>): IAgentTurnPlanSnapshot | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const plans = messages[i].plans;
        if (plans?.length) return plans[plans.length - 1];
    }
    return undefined;
}
