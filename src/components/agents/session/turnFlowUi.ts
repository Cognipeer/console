/**
 * A stored assistant turn as the blocks the session view draws, in the order
 * things happened: narration, the agent's own tool calls, plan versions,
 * sub-agent groups and summarization passes. `orderTurnFlow` (shared with the
 * server and the portal) decides the order; this adds what each block needs to
 * be drawn - progress and diff chips for a plan, run views for a group, token
 * figures for a pass - and the stable DOM ids the "go to" links scroll to.
 * Pure.
 */

import {
    delegationCallIdOf,
    latestPlanOf,
    planProgress,
    orderTurnFlow,
    type AgentCompactionEvent,
    type PlanProgress,
    type TurnFlowInput,
} from '@/lib/shared/agentTurnFlow';
import type {
    IAgentConversationStep,
    IAgentMessagePendingAction,
    IAgentTurnCompaction,
    IAgentTurnPlanSnapshot,
} from '@/lib/database/provider/types.domain';
import { planChangeParts, planPercent, type PlanDiffPart } from './planUi';
import {
    legacyDelegationView,
    parallelGroupView,
    storedRunView,
    type ParallelGroupView,
    type SubagentRunView,
} from './subagentUi';

// ── DOM anchors ─────────────────────────────────────────────────────────

/** Keeps an id usable in a DOM id and a CSS selector: letters, digits, `_` and `-`. */
function cssSafe(value: string | number): string {
    return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * What identifies a summarization pass inside its message: its id when it has
 * one, else its number. `fallbackIndex` is the 1-based position in the
 * message's list, which is also what `orderTurnFlow` numbers a pass without an
 * `index` by - so the transcript and the side panel agree.
 */
export function compactionPassKey(compaction: { id?: string; index?: number }, fallbackIndex: number): string | number {
    return compaction.id ?? compaction.index ?? fallbackIndex;
}

/** DOM id of the divider for one pass (`messageIndex` = the message's place in the session). */
export function compactionAnchorId(messageIndex: number, passKey: string | number): string {
    return `flow-pass-${messageIndex}-${cssSafe(passKey)}`;
}

/** DOM id of the row for one plan version (versions grow through a session, so the version is enough). */
export function planAnchorId(version: number): string {
    return `flow-plan-v${cssSafe(version)}`;
}

/**
 * DOM id of a delegation group: the sub-agent group or parallel container its call opened. A parallel spawn's
 * children are keyed `<call>#<n>`; the group is the call's, so every key of a call gives the call's id.
 */
export function delegationAnchorId(toolCallId: string): string {
    return `flow-delegation-${cssSafe(delegationCallIdOf(toolCallId))}`;
}

// ── Summarization pass ──────────────────────────────────────────────────

/** The figures one divider shows: "pass 2 · 84.2k → 11.9k tokens (−86%) · 3.1s · 4 tool results replaced". */
export interface CompactionDividerView {
    /** Pass number in the message; absent inside a sub-agent's group. */
    index?: number;
    /** The pass is still being made (live only). */
    pending: boolean;
    /** The summarizer failed and a local fallback summary was used. */
    failed: boolean;
    tokensBefore?: number;
    tokensAfter?: number;
    /** Share of the context the pass removed, rounded; negative when it grew. Needs both token counts. */
    savedPercent?: number;
    durationMs?: number;
    /** Tool results this pass replaced (the pass's own list when it has one, else the count the SDK gave). */
    replacedTools?: number;
    compactedTools: Array<{ toolName: string; toolCallId: string }>;
    model?: string;
}

/** The divider figures for one pass. Leave `index` out for a pass inside a sub-agent's group. */
export function compactionDividerView(
    compaction: AgentCompactionEvent | IAgentTurnCompaction,
    options: { index?: number } = {},
): CompactionDividerView {
    const { tokensBefore, tokensAfter } = compaction;
    const compactedTools = compaction.compactedTools ?? [];
    const replaced = compactedTools.length || compaction.messagesCompressed || 0;
    const pending = (compaction as AgentCompactionEvent).phase === 'start';
    return {
        ...(options.index !== undefined ? { index: options.index } : {}),
        pending,
        failed: compaction.failed === true,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        ...(tokensBefore && tokensAfter !== undefined ? { savedPercent: Math.round((1 - tokensAfter / tokensBefore) * 100) } : {}),
        ...(compaction.durationMs !== undefined ? { durationMs: compaction.durationMs } : {}),
        ...(replaced > 0 ? { replacedTools: replaced } : {}),
        compactedTools,
        ...(compaction.model ? { model: compaction.model } : {}),
    };
}

/** Where a pass happened, for the Context tab: "at turn start", "after web_search", "after <sub-agent names>". */
export type CompactionPlacement =
    | { kind: 'turn_start' }
    | { kind: 'after_tool'; toolName: string }
    | { kind: 'after_subagents'; names: string[] }
    /** Stored before positions existed, or its call is in another message. */
    | { kind: 'unplaced' };

/** Where `compaction` happened in `message`, from its `afterToolCallId`. */
export function compactionPlacement(
    message: Pick<TurnFlowInput, 'steps' | 'subagentRuns'>,
    compaction: Pick<IAgentTurnCompaction, 'afterToolCallId'>,
): CompactionPlacement {
    const after = compaction.afterToolCallId;
    if (after === null) return { kind: 'turn_start' };
    if (typeof after !== 'string') return { kind: 'unplaced' };
    const step = (message.steps ?? []).find((candidate) => candidate.id === after);
    const callId = delegationCallIdOf(after);
    const names = (message.subagentRuns ?? [])
        .filter((run) => run.parentToolCallId !== undefined && delegationCallIdOf(run.parentToolCallId) === callId)
        .map((run) => run.name);
    if (names.length) return { kind: 'after_subagents', names };
    if (!step) return { kind: 'unplaced' };
    return { kind: 'after_tool', toolName: step.name };
}

// ── The blocks ──────────────────────────────────────────────────────────

/** A stored assistant message, as far as the flow needs it. */
export interface StoredTurn extends TurnFlowInput {
    pendingActions?: IAgentMessagePendingAction[];
}

export type TurnFlowBlockView =
    | { kind: 'narration'; key: string; text: string }
    | { kind: 'steps'; key: string; steps: IAgentConversationStep[] }
    | {
        kind: 'plan';
        key: string;
        anchorId: string;
        plan: IAgentTurnPlanSnapshot;
        previous?: IAgentTurnPlanSnapshot;
        progress: PlanProgress;
        percent: number;
        /** What the version changed against `previous`; empty for a plan's first version. */
        parts: PlanDiffPart[];
        /** The first plan block of the turn: drawn as the full card; later ones are one-line updates. */
        full: boolean;
    }
    | {
        kind: 'subagents';
        key: string;
        /** Absent when the group has no delegation call to anchor to. */
        anchorId?: string;
        parentToolCallId?: string;
        /** The stored delegation call, when it finished in this message. */
        step?: IAgentConversationStep;
        parallel: boolean;
        runs: SubagentRunView[];
        /** The header of a parallel container (more than one run, or `spawn_subagents_parallel`). */
        group?: ParallelGroupView;
        /** A delegation call stored before runs were recorded: its call is all there is. */
        legacy?: SubagentRunView;
    }
    | {
        kind: 'compaction';
        key: string;
        anchorId: string;
        compaction: IAgentTurnCompaction;
        index: number;
        view: CompactionDividerView;
    };

/**
 * The blocks of one stored assistant message, in the order they happened, with
 * what each needs to be drawn. `previousPlan` is the plan as it stood before
 * the message; `messageIndex` is the message's place in the session (it makes
 * the pass anchors unique).
 */
export function buildTurnFlow(
    message: StoredTurn,
    options: { previousPlan?: IAgentTurnPlanSnapshot; messageIndex?: number } = {},
): TurnFlowBlockView[] {
    const messageIndex = options.messageIndex ?? 0;
    const blocks = orderTurnFlow(message, { previousPlan: options.previousPlan });
    let firstPlanSeen = false;
    return blocks.map((block, i): TurnFlowBlockView => {
        const key = `${block.kind}-${i}`;
        switch (block.kind) {
            case 'narration':
                return { kind: 'narration', key, text: block.text };
            case 'steps':
                return { kind: 'steps', key, steps: block.steps };
            case 'plan': {
                const full = !firstPlanSeen;
                firstPlanSeen = true;
                return {
                    kind: 'plan',
                    key,
                    anchorId: planAnchorId(block.plan.version),
                    plan: block.plan,
                    ...(block.previous ? { previous: block.previous } : {}),
                    progress: planProgress(block.plan),
                    percent: planPercent(block.plan),
                    parts: planChangeParts(block.previous, block.plan),
                    full,
                };
            }
            case 'subagents': {
                const runs = block.runs.map((run) => storedRunView(run, message.pendingActions));
                const legacy = runs.length === 0 && block.step ? legacyDelegationView(block.step) : undefined;
                return {
                    kind: 'subagents',
                    key,
                    ...(block.parentToolCallId ? { anchorId: delegationAnchorId(block.parentToolCallId), parentToolCallId: block.parentToolCallId } : {}),
                    ...(block.step ? { step: block.step } : {}),
                    parallel: block.parallel,
                    runs,
                    ...(block.parallel && runs.length ? { group: parallelGroupView(runs) } : {}),
                    ...(legacy ? { legacy } : {}),
                };
            }
            case 'compaction':
                return {
                    kind: 'compaction',
                    key,
                    anchorId: compactionAnchorId(messageIndex, compactionPassKey(block.compaction, block.index)),
                    compaction: block.compaction,
                    index: block.index,
                    view: compactionDividerView(block.compaction, { index: block.index }),
                };
        }
    });
}

/**
 * `buildTurnFlow` for the message at `messageIndex` of a session: the plan it
 * starts from is the latest one an earlier message recorded.
 */
export function buildTurnFlowAt(messages: ReadonlyArray<StoredTurn>, messageIndex: number): TurnFlowBlockView[] {
    return buildTurnFlow(messages[messageIndex], {
        previousPlan: latestPlanOf(messages.slice(0, messageIndex)),
        messageIndex,
    });
}

/** "−86%" for a pass that shrank the context, "+4%" for one that grew it (a summary longer than what it replaced). */
export function compactionChangeLabel(savedPercent: number): string {
    if (savedPercent > 0) return `−${savedPercent}%`;
    if (savedPercent < 0) return `+${-savedPercent}%`;
    return '0%';
}

/**
 * For each message of a session, the latest plan version an EARLIER message
 * recorded: what the message's first plan version is compared against. One pass
 * over the session instead of one `latestPlanOf` per message.
 */
export function previousPlansOf(messages: ReadonlyArray<{ plans?: IAgentTurnPlanSnapshot[] }>): Array<IAgentTurnPlanSnapshot | undefined> {
    const out: Array<IAgentTurnPlanSnapshot | undefined> = [];
    let latest: IAgentTurnPlanSnapshot | undefined;
    for (const message of messages) {
        out.push(latest);
        const plans = message.plans;
        if (plans?.length) latest = plans[plans.length - 1];
    }
    return out;
}

/**
 * How many tool calls come before each block of a turn. A call's number is its block's offset plus its place in
 * the block plus one, and the transcript (`StoredTurnFlow`) and the Events tab (`sessionEventRows`) both take the
 * offsets from here, so a call carries the same number in both. The rule: the agent's own calls count, and so does
 * a delegation call that finished in this message (its sub-agent block has the `step`); a plan call is in no block
 * (its version is a plan block, or it only read the plan and `orderTurnFlow` hides it), so it counts for nothing.
 */
export function stepOffsetsOf(blocks: ReadonlyArray<TurnFlowBlockView>): number[] {
    let counted = 0;
    return blocks.map((block) => {
        const offset = counted;
        if (block.kind === 'steps') counted += block.steps.length;
        else if (block.kind === 'subagents' && block.step) counted += 1;
        return offset;
    });
}

/** Which key a group's open state is kept under (the transcript holds it so "Show in group" can open a group). */
export function runExpansionKey(runId: string): string {
    return `run:${runId}`;
}

/** The key a parallel container's open state is kept under. */
export function callExpansionKey(toolCallId: string): string {
    return `call:${toolCallId}`;
}

/**
 * The open states "Show in group" sets for a delegation call: its container,
 * and the run(s) an approval or question belongs to (every run when the action
 * names none). Blocks of other calls are left out. A request raised by a
 * parallel spawn's child carries the child's key (`<call>#<n>`): it opens the
 * group of `<call>`.
 */
export function showInGroupExpansion(
    blocks: ReadonlyArray<TurnFlowBlockView>,
    delegationToolCallId: string,
    subagentName?: string,
): Record<string, boolean> {
    const open: Record<string, boolean> = {};
    const callId = delegationCallIdOf(delegationToolCallId);
    for (const block of blocks) {
        if (block.kind !== 'subagents' || !block.parentToolCallId || delegationCallIdOf(block.parentToolCallId) !== callId) continue;
        // The key the transcript reads the container's state under (`StoredTurnFlow`): the block's own call id.
        open[callExpansionKey(block.parentToolCallId)] = true;
        for (const run of block.runs) {
            if (!subagentName || run.name === subagentName) open[runExpansionKey(run.id)] = true;
        }
        if (block.legacy) open[runExpansionKey(block.legacy.id)] = true;
    }
    return open;
}
