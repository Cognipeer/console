/**
 * How the agent's plan reads in the session view: one status → icon, color and
 * wording for every step, what a new version changed ("✓ 1, 2 done · ▶ 3
 * started"), which plan is the current one, and the list of versions a session
 * went through. Pure - the labels are translation keys under
 * `agents.sessionFlow` (and the values to fill in), resolved by the component.
 */

import {
    latestPlanOf,
    planDiff,
    planProgress,
    type PlanChange,
} from '@/lib/shared/agentTurnFlow';
import type { AgentPlanStepStatus, IAgentPlanStep, IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import { latestLivePlan, type LiveSegment } from './liveFlow';

// ── Step status ─────────────────────────────────────────────────────────

/** Tabler icon names (without the `Icon` prefix, kebab-case) the plan rows use. */
export type PlanStatusIcon = 'circle-dashed' | 'player-play' | 'circle-check' | 'alert-triangle';

export interface PlanStatusView {
    status: AgentPlanStepStatus;
    icon: PlanStatusIcon;
    /** A Mantine color name. */
    color: 'gray' | 'blue' | 'teal' | 'orange';
    /** Translation key under `agents.sessionFlow`. */
    labelKey: 'planStatusNotStarted' | 'planStatusInProgress' | 'planStatusCompleted' | 'planStatusBlocked';
}

const STATUS_VIEWS: Record<AgentPlanStepStatus, PlanStatusView> = {
    'not-started': { status: 'not-started', icon: 'circle-dashed', color: 'gray', labelKey: 'planStatusNotStarted' },
    'in-progress': { status: 'in-progress', icon: 'player-play', color: 'blue', labelKey: 'planStatusInProgress' },
    completed: { status: 'completed', icon: 'circle-check', color: 'teal', labelKey: 'planStatusCompleted' },
    blocked: { status: 'blocked', icon: 'alert-triangle', color: 'orange', labelKey: 'planStatusBlocked' },
};

/** Icon, color and wording of a step status; a status this build does not know reads as not started. */
export function planStatusView(status: string | undefined): PlanStatusView {
    return STATUS_VIEWS[status as AgentPlanStepStatus] ?? STATUS_VIEWS['not-started'];
}

/** "3 · Write the report": a step as one line. */
export function planStepLabel(step: Pick<IAgentPlanStep, 'id' | 'title'>): string {
    return `${step.id} · ${step.title}`;
}

/** Completed steps over all steps as a whole percentage (0 for an empty plan). */
export function planPercent(plan: Pick<IAgentTurnPlanSnapshot, 'steps'> | null | undefined): number {
    const { done, total } = planProgress(plan);
    return total === 0 ? 0 : Math.round((done / total) * 100);
}

// ── What a version changed ──────────────────────────────────────────────

export type PlanDiffKind = 'completed' | 'started' | 'blocked' | 'added' | 'removed';

/** One chip of "✓ 1, 2 done · ▶ 3 started": the component fills `labelKey` with `{ ids }` (or `{ count }`). */
export interface PlanDiffPart {
    kind: PlanDiffKind;
    /** The glyph that leads the chip. */
    symbol: '✓' | '▶' | '⚠' | '+' | '−';
    color: 'teal' | 'blue' | 'orange' | 'gray';
    /** Translation key under `agents.sessionFlow`; takes `{ ids }`. */
    labelKey: 'planDiffCompleted' | 'planDiffStarted' | 'planDiffBlocked' | 'planDiffAdded' | 'planDiffRemoved';
    /** The step ids, in plan order. */
    ids: string[];
    /** `ids` joined with ", ". */
    text: string;
    count: number;
}

const DIFF_PARTS: Array<{ kind: PlanDiffKind; symbol: PlanDiffPart['symbol']; color: PlanDiffPart['color']; labelKey: PlanDiffPart['labelKey'] }> = [
    { kind: 'completed', symbol: '✓', color: 'teal', labelKey: 'planDiffCompleted' },
    { kind: 'started', symbol: '▶', color: 'blue', labelKey: 'planDiffStarted' },
    { kind: 'blocked', symbol: '⚠', color: 'orange', labelKey: 'planDiffBlocked' },
    { kind: 'added', symbol: '+', color: 'gray', labelKey: 'planDiffAdded' },
    { kind: 'removed', symbol: '−', color: 'gray', labelKey: 'planDiffRemoved' },
];

/**
 * The chips of what a plan version changed, in a fixed order (done, started,
 * blocked, added, removed); a kind that changed nothing has no chip. Empty when
 * nothing changed - the row then shows only the version and the progress.
 */
export function planDiffLabel(change: PlanChange): PlanDiffPart[] {
    const parts: PlanDiffPart[] = [];
    for (const spec of DIFF_PARTS) {
        const ids = change[spec.kind].map((step) => String(step.id));
        if (ids.length === 0) continue;
        parts.push({ ...spec, ids, text: ids.join(', '), count: ids.length });
    }
    return parts;
}

/** What `plan` changed against `previous`, as chips. The first version of a plan (no `previous`) has none: it is shown in full. */
export function planChangeParts(
    previous: Pick<IAgentTurnPlanSnapshot, 'steps'> | null | undefined,
    plan: Pick<IAgentTurnPlanSnapshot, 'steps'>,
): PlanDiffPart[] {
    return previous ? planDiffLabel(planDiff(previous, plan)) : [];
}

// ── Which plan is current ───────────────────────────────────────────────

/** The plan `GET …/sessions/:id` returns (`plan`): the one the carried state holds. */
export interface SessionPlanRecord {
    version: number;
    steps: IAgentPlanStep[];
    completion?: number;
    /** When the state was last updated (ISO). */
    at?: string;
}

export interface CurrentPlan {
    plan: IAgentTurnPlanSnapshot;
    /** Where it came from: the running turn, a stored message, or the session's carried state. */
    source: 'live' | 'message' | 'session';
}

/**
 * The plan to show in the dock and the side panel: the newest one the running
 * turn wrote, else the newest any stored message recorded, else the session's
 * carried plan (a session whose messages predate plan versions, or whose
 * history is not loaded). `null` when the session has no plan at all - the dock
 * and the tab are then hidden.
 */
export function currentPlanOf(input: {
    live?: LiveSegment[];
    messages?: ReadonlyArray<{ plans?: IAgentTurnPlanSnapshot[] }>;
    sessionPlan?: SessionPlanRecord | null;
}): CurrentPlan | null {
    const live = input.live ? latestLivePlan(input.live) : undefined;
    if (live) return { plan: live, source: 'live' };
    const stored = latestPlanOf(input.messages ?? []);
    if (stored) return { plan: stored, source: 'message' };
    const session = input.sessionPlan;
    if (session && Array.isArray(session.steps) && session.steps.length > 0) {
        return {
            plan: {
                version: session.version,
                operation: 'update',
                steps: session.steps,
                ...(session.completion !== undefined ? { completion: session.completion } : {}),
                at: session.at ?? '',
            },
            source: 'session',
        };
    }
    return null;
}

// ── History ─────────────────────────────────────────────────────────────

export interface PlanHistoryEntry {
    /** 1-based turn number (the n-th user message at or before the plan's message). */
    turnIndex: number;
    /** Index of the message that recorded it in the session's message list - what `onGoToTurn` takes. */
    messageIndex: number;
    plan: IAgentTurnPlanSnapshot;
    /** The version before it in the session, when there is one. */
    previous?: IAgentTurnPlanSnapshot;
    change: PlanChange;
}

/**
 * Every plan version a session recorded, oldest first, each with the version
 * before it (across messages) and what it changed. Messages that recorded no
 * plan are skipped.
 */
export function planHistory(
    messages: ReadonlyArray<{ role?: string; plans?: IAgentTurnPlanSnapshot[] }>,
): PlanHistoryEntry[] {
    const entries: PlanHistoryEntry[] = [];
    let turns = 0;
    let previous: IAgentTurnPlanSnapshot | undefined;
    messages.forEach((message, messageIndex) => {
        if (message.role === 'user') turns += 1;
        for (const plan of message.plans ?? []) {
            entries.push({
                turnIndex: Math.max(1, turns),
                messageIndex,
                plan,
                ...(previous ? { previous } : {}),
                change: planDiff(previous, plan),
            });
            previous = plan;
        }
    });
    return entries;
}
