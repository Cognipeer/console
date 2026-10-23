'use client';

/**
 * The body of a stored assistant turn, in the order things happened: what the
 * model wrote, its tool calls, the plan versions, the sub-agent groups and the
 * summarization passes - the same order the turn had while it ran. The blocks
 * come from `buildTurnFlow`; this draws them.
 *
 * Which sub-agent groups are open is kept by the caller (`expansion`), so a
 * "Show in group" link on an approval card further down the turn can open one.
 */

import { Box, Stack } from '@mantine/core';
import Markdown from './AgentMarkdown';
import CompactionDivider from './CompactionDivider';
import { PlanCard, PlanUpdateRow } from './PlanCard';
import { StepTimeline } from './StepCards';
import { ParallelSubagents, SubagentGroup } from './SubagentGroup';
import type { ChatMessage } from './sessionTypes';
import type { SubagentRunView } from './subagentUi';
import { callExpansionKey, runExpansionKey, stepOffsetsOf, type TurnFlowBlockView } from './turnFlowUi';

export interface TurnExpansion {
    /** Open state by key (`runExpansionKey`, `callExpansionKey`); a group with no entry keeps its own default. */
    state: Readonly<Record<string, boolean>>;
    set: (key: string, open: boolean) => void;
}

export interface StoredTurnFlowProps {
    blocks: TurnFlowBlockView[];
    message: Pick<ChatMessage, 'compactions' | 'compactedTools'>;
    expansion: TurnExpansion;
}

/** The runs whose open state the caller holds, by run id. */
function openRuns(runs: ReadonlyArray<SubagentRunView>, state: Readonly<Record<string, boolean>>): Record<string, boolean> {
    const open: Record<string, boolean> = {};
    for (const run of runs) {
        const value = state[runExpansionKey(run.id)];
        if (value !== undefined) open[run.id] = value;
    }
    return open;
}

export default function StoredTurnFlow({ blocks, message, expansion }: StoredTurnFlowProps) {
    // The tool-call badges number the calls of the whole turn, across the blocks of calls between the other blocks:
    // the same numbers the Events tab gives them (a delegation call is a call too, a plan call is none).
    const offsets = stepOffsetsOf(blocks);
    const passes = message.compactions ?? [];

    return (
        <Stack gap="xs" mb="xs" data-testid="stored-turn-flow">
            {blocks.map((block, index) => {
                switch (block.kind) {
                    case 'narration':
                        return <Markdown key={block.key} text={block.text} />;
                    case 'steps':
                        return <StepTimeline key={block.key} steps={block.steps} offset={offsets[index]} />;
                    case 'plan':
                        return block.full
                            ? <PlanCard key={block.key} plan={block.plan} anchorId={block.anchorId} />
                            : <PlanUpdateRow key={block.key} plan={block.plan} parts={block.parts} anchorId={block.anchorId} />;
                    case 'subagents': {
                        const toolName = block.step?.name;
                        if (block.runs.length === 0) {
                            const legacy = block.legacy;
                            return legacy ? (
                                <SubagentGroup
                                    key={block.key}
                                    view={legacy}
                                    toolName={toolName}
                                    anchorId={block.anchorId}
                                    legacyStep={block.step}
                                    legacyIndex={offsets[index]}
                                    expanded={expansion.state[runExpansionKey(legacy.id)]}
                                    onExpandedChange={(open) => expansion.set(runExpansionKey(legacy.id), open)}
                                />
                            ) : null;
                        }
                        if (block.parallel) {
                            const callKey = block.parentToolCallId ? callExpansionKey(block.parentToolCallId) : undefined;
                            return (
                                <ParallelSubagents
                                    key={block.key}
                                    runs={block.runs}
                                    group={block.group}
                                    toolName={toolName}
                                    anchorId={block.anchorId}
                                    expanded={callKey ? expansion.state[callKey] : undefined}
                                    onExpandedChange={callKey ? (open) => expansion.set(callKey, open) : undefined}
                                    runExpanded={openRuns(block.runs, expansion.state)}
                                    onRunExpandedChange={(runId, open) => expansion.set(runExpansionKey(runId), open)}
                                />
                            );
                        }
                        return (
                            <Stack key={block.key} gap={6}>
                                {block.runs.map((run, i) => (
                                    <SubagentGroup
                                        key={run.id}
                                        view={run}
                                        toolName={toolName}
                                        anchorId={i === 0 ? block.anchorId : undefined}
                                        expanded={expansion.state[runExpansionKey(run.id)]}
                                        onExpandedChange={(open) => expansion.set(runExpansionKey(run.id), open)}
                                    />
                                ))}
                            </Stack>
                        );
                    }
                    case 'compaction': {
                        const lastPass = passes[passes.length - 1] === block.compaction;
                        return (
                            <Box key={block.key}>
                                <CompactionDivider
                                    compaction={block.compaction}
                                    view={block.view}
                                    anchorId={block.anchorId}
                                    // Turns stored before each pass kept its own list name the replaced tools once, on the last pass.
                                    compactedTools={block.compaction.compactedTools ?? (lastPass ? message.compactedTools : undefined)}
                                />
                            </Box>
                        );
                    }
                }
            })}
        </Stack>
    );
}
