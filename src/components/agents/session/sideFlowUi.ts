/**
 * What the inspector lists from a session's stored turns now that a turn is
 * more than a flat list of tool calls: the Events tab follows the order of the
 * turn (child steps indented under their sub-agent, plan versions and
 * summarization passes between the calls), and the Context tab says where each
 * pass happened. Pure - the panel only draws the rows.
 */

import type { IAgentConversationStep, IAgentTurnCompaction, IAgentTurnPlanSnapshot } from '@/lib/database/provider/types.domain';
import { isPlanTool } from '@/lib/shared/agentTurnFlow';
import type { SubagentStatusKind, SubagentStepRow } from './subagentUi';
import {
    buildTurnFlowAt,
    compactionAnchorId,
    compactionPassKey,
    compactionPlacement,
    delegationAnchorId,
    stepOffsetsOf,
    type CompactionPlacement,
    type StoredTurn,
} from './turnFlowUi';

// ── Events ──────────────────────────────────────────────────────────────

export type SideEventRow =
    /** One tool call of the agent's own; `number` counts the calls of its turn. */
    | { kind: 'step'; key: string; turnIndex: number; number: number; step: IAgentConversationStep }
    /** A plan version, in the place of the manage_plan call that wrote it. */
    | { kind: 'plan'; key: string; turnIndex: number; toolName: string; version: number; anchorId: string }
    /** A sub-agent's header; its steps follow as `child` rows. */
    | {
        kind: 'subagent';
        key: string;
        turnIndex: number;
        name: string;
        status: SubagentStatusKind;
        /** A turn stored before runs were recorded: only the delegation call is known. */
        stepsNotRecorded: boolean;
        anchorId?: string;
    }
    /** A step of the sub-agent above it. */
    | { kind: 'child'; key: string; turnIndex: number; row: SubagentStepRow }
    /** One summarization pass of the agent's own. */
    | { kind: 'compaction'; key: string; turnIndex: number; index: number; failed: boolean; anchorId: string };

/** The plan tool a version came from: the call that wrote it, else the tool's usual name. */
function planToolName(message: StoredTurn, plan: IAgentTurnPlanSnapshot): string {
    const call = plan.toolCallId ? (message.steps ?? []).find((step) => step.id === plan.toolCallId) : undefined;
    return call && isPlanTool(call.name) ? call.name : 'manage_plan';
}

/**
 * The rows of the Events tab, oldest turn first, each turn in the order it
 * happened. `turnIndex` is the message's place in the session (what
 * `onGoToTurn` takes). Messages that did none of this have no rows.
 *
 * The rows come from the same blocks the transcript draws (`orderTurnFlow`), so
 * the tab lists exactly the calls the transcript shows: a plan call that wrote a
 * version is that version's row, and one that wrote none (a read, in a message
 * that records its plan versions) is left out here as it is there. Calls are
 * numbered from the offsets the transcript takes (`stepOffsetsOf`), so the
 * number on a row is the number on its card.
 */
export function sessionEventRows(messages: ReadonlyArray<StoredTurn & { role?: string }>): SideEventRow[] {
    const rows: SideEventRow[] = [];
    messages.forEach((message, turnIndex) => {
        if (message.role !== undefined && message.role !== 'assistant') return;
        const blocks = buildTurnFlowAt(messages, turnIndex);
        const offsets = stepOffsetsOf(blocks);
        blocks.forEach((block, b) => {
            switch (block.kind) {
                case 'steps':
                    block.steps.forEach((step, i) => {
                        const number = offsets[b] + i + 1;
                        rows.push({ kind: 'step', key: `${turnIndex}:step:${number}`, turnIndex, number, step });
                    });
                    break;
                case 'plan':
                    rows.push({
                        kind: 'plan',
                        key: `${turnIndex}:${block.key}`,
                        turnIndex,
                        toolName: planToolName(message, block.plan),
                        version: block.plan.version,
                        anchorId: block.anchorId,
                    });
                    break;
                case 'subagents':
                    if (block.step) {
                        const number = offsets[b] + 1;
                        rows.push({ kind: 'step', key: `${turnIndex}:step:${number}`, turnIndex, number, step: block.step });
                    }
                    for (const run of block.runs) {
                        rows.push({
                            kind: 'subagent',
                            key: `${turnIndex}:run:${run.id}`,
                            turnIndex,
                            name: run.name,
                            status: run.statusKind,
                            stepsNotRecorded: false,
                            ...(block.anchorId ? { anchorId: block.anchorId } : {}),
                        });
                        for (const row of run.rows) {
                            if (row.kind === 'step') rows.push({ kind: 'child', key: `${turnIndex}:run:${run.id}:${row.key}`, turnIndex, row });
                        }
                    }
                    if (block.legacy) {
                        rows.push({
                            kind: 'subagent',
                            key: `${turnIndex}:run:${block.legacy.id}`,
                            turnIndex,
                            name: block.legacy.name,
                            status: block.legacy.statusKind,
                            stepsNotRecorded: true,
                            ...(block.anchorId ? { anchorId: block.anchorId } : {}),
                        });
                    }
                    break;
                case 'compaction':
                    rows.push({
                        kind: 'compaction',
                        key: `${turnIndex}:${block.key}`,
                        turnIndex,
                        index: block.index,
                        failed: block.view.failed,
                        anchorId: block.anchorId,
                    });
                    break;
                default:
                    break;
            }
        });
    });
    return rows;
}

/** Rows that count as events in the tab's badge: tool calls, the agent's and its sub-agents'. */
export function countEventRows(rows: ReadonlyArray<SideEventRow>): number {
    return rows.filter((row) => row.kind === 'step' || row.kind === 'child').length;
}

// ── Context ─────────────────────────────────────────────────────────────

export interface ContextPassEntry {
    key: string;
    /** The message's place in the session. */
    turnIndex: number;
    /** The agent's own pass, or one a sub-agent made of its own context. */
    kind: 'agent' | 'subagent';
    compaction: IAgentTurnCompaction;
    /** 1-based number among the agent's own passes of the message (`agent` only). */
    pass: number;
    placement: CompactionPlacement;
    subagentName?: string;
    /** What "go to" scrolls to: the divider (`agent`) or the sub-agent's group (`subagent`, when it has an anchor). */
    anchorId?: string;
}

/**
 * Every summarization pass of the session, oldest first, with where in its turn
 * it happened ("after web_search", "at turn start") and, for a sub-agent's, whose it was.
 */
export function sessionContextPasses(messages: ReadonlyArray<StoredTurn>): ContextPassEntry[] {
    const entries: ContextPassEntry[] = [];
    messages.forEach((message, turnIndex) => {
        (message.compactions ?? []).forEach((compaction, i) => {
            const pass = compaction.index ?? i + 1;
            entries.push({
                key: `${turnIndex}:pass:${pass}`,
                turnIndex,
                kind: 'agent',
                compaction,
                pass,
                placement: compactionPlacement(message, compaction),
                anchorId: compactionAnchorId(turnIndex, compactionPassKey(compaction, i + 1)),
            });
        });
        for (const run of message.subagentRuns ?? []) {
            (run.compactions ?? []).forEach((compaction, i) => {
                entries.push({
                    key: `${turnIndex}:run:${run.id}:pass:${i + 1}`,
                    turnIndex,
                    kind: 'subagent',
                    compaction,
                    pass: i + 1,
                    placement: { kind: 'unplaced' },
                    subagentName: run.name,
                    ...(run.parentToolCallId ? { anchorId: delegationAnchorId(run.parentToolCallId) } : {}),
                });
            });
        }
    });
    return entries;
}
