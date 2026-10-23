'use client';

/**
 * The turn that is running, drawn from its live segments in the order things
 * happen: thinking, the model's text, tool calls, the plan it writes, the
 * sub-agents it runs and the context it summarizes. A followed turn (one this
 * page did not start) draws through the same component, so both read alike -
 * and read like the stored turn that replaces them when the turn ends.
 */

import { Box, Stack } from '@mantine/core';
import Markdown from './AgentMarkdown';
import CompactionDivider from './CompactionDivider';
import LiveToolCalls from './LiveToolCalls';
import { isGenerating, type LiveSegment } from './liveFlow';
import { PlanCard, PlanUpdateRow } from './PlanCard';
import { planChangeParts } from './planUi';
import ReasoningBlock from './ReasoningBlock';
import { ParallelSubagents, SubagentGroup } from './SubagentGroup';
import { liveRunView } from './subagentUi';
import { compactionDividerView, delegationAnchorId, planAnchorId } from './turnFlowUi';
import classes from './AgentSessionView.module.css';

export default function LiveTurnFlow({ segments }: { segments: LiveSegment[] }) {
    const generating = isGenerating(segments);
    const last = segments.length - 1;
    // The agent's own passes are numbered in the order they were made, like the stored turn numbers them.
    let passes = 0;
    let plans = 0;

    const blocks = segments.map((segment, index) => {
        switch (segment.kind) {
            case 'reasoning':
                return (
                    <Box key={`reasoning-${index}`} className={classes.chatMarkdown}>
                        <ReasoningBlock reasoning={segment.text} streaming={index === last} testId="agent-live-reasoning" />
                    </Box>
                );
            case 'tools':
                return <LiveToolCalls key={`tools-${index}`} calls={segment.calls} generating={generating && index === last} />;
            case 'text':
                return (
                    <Box key={`text-${index}`} className={classes.chatMarkdown}>
                        <Markdown text={segment.text} />
                    </Box>
                );
            case 'plan': {
                const first = plans === 0;
                plans += 1;
                const anchorId = planAnchorId(segment.plan.version);
                return first
                    ? <PlanCard key={`plan-${index}`} plan={segment.plan} anchorId={anchorId} />
                    : (
                        <PlanUpdateRow
                            key={`plan-${index}`}
                            plan={segment.plan}
                            parts={planChangeParts(segment.previous, segment.plan)}
                            anchorId={anchorId}
                        />
                    );
            }
            case 'compaction': {
                if (!segment.pending) passes += 1;
                const number = segment.compaction.index ?? passes;
                return (
                    <CompactionDivider
                        key={`compaction-${segment.compaction.id ?? index}`}
                        compaction={segment.compaction}
                        view={compactionDividerView(segment.compaction, segment.pending ? {} : { index: number })}
                    />
                );
            }
            case 'subagents': {
                const anchorId = segment.parentToolCallId ? delegationAnchorId(segment.parentToolCallId) : undefined;
                const key = `subagents-${segment.parentToolCallId ?? index}`;
                const toolName = segment.call?.name;
                // The delegation call is out but the sub-agent has not reported in yet: the call reads as a running row.
                if (segment.runs.length === 0) {
                    return segment.call
                        ? <LiveToolCalls key={key} calls={[segment.call]} generating={false} />
                        : null;
                }
                const views = segment.runs.map((run) => liveRunView(run));
                if (segment.parallel) {
                    return <ParallelSubagents key={key} runs={views} toolName={toolName} anchorId={anchorId} />;
                }
                return (
                    <Stack key={key} gap={6}>
                        {views.map((view, i) => (
                            <SubagentGroup key={view.id} view={view} toolName={toolName} anchorId={i === 0 ? anchorId : undefined} />
                        ))}
                    </Stack>
                );
            }
            default:
                return null;
        }
    });

    return (
        <Stack gap="xs">
            {blocks}
            {/* After a plan, a settled delegation or a finished pass the model is writing again, as after a tool run. */}
            {generating && segments[last]?.kind !== 'tools' ? <LiveToolCalls calls={[]} generating /> : null}
        </Stack>
    );
}
