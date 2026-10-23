'use client';

/**
 * What the agent is doing, while it is doing it.
 *
 * A single "working…" spinner for a forty-second run asks the operator to
 * trust the box. These rows are the run narrating itself: which tool, with
 * which argument, still spinning or finished in how long. Once the answer
 * arrives the same calls are re-rendered from the persisted turn (StepTimeline),
 * so this component's whole job is the gap in between.
 */

import { Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconWorld } from '@tabler/icons-react';
import { formatDuration } from '@/lib/utils/tracingUtils';
import classes from './AgentSessionView.module.css';
import type { LiveToolCall } from './liveFlow';

// The model of a live turn (segments and the reducers that build them) lives in
// `liveFlow.ts`, free of React; it is re-exported here so callers keep one import.
export {
    appendLiveReasoning,
    appendLiveText,
    applyLiveCompaction,
    applyLivePlan,
    applyLiveSubagent,
    applyLiveToolEvent,
    isGenerating,
    latestLivePlan,
    summariseArgs,
} from './liveFlow';
export type { LiveSegment, LiveSubagentRun, LiveToolCall, LiveToolEvent } from './liveFlow';

export interface LiveToolCallsProps {
    calls: LiveToolCall[];
    /** True once every call has finished and the model is writing the answer. */
    generating: boolean;
}

export default function LiveToolCalls({ calls, generating }: LiveToolCallsProps) {
    if (calls.length === 0 && !generating) return null;

    return (
        <Stack gap={6}>
            {calls.length > 0 ? (
                <Paper withBorder radius="md" p="xs">
                    <Stack gap={2}>
                        {calls.map((call) => (
                            <Group key={call.key} justify="space-between" wrap="nowrap" gap="sm">
                                <Group gap={8} wrap="nowrap" className={classes.eventName}>
                                    <IconWorld size={13} className={classes.liveToolIcon} />
                                    <Text size="sm" ff="monospace" fw={500}>{call.name}</Text>
                                    {call.detail ? (
                                        <Text size="sm" c="dimmed" truncate>{call.detail}</Text>
                                    ) : null}
                                </Group>
                                {call.running ? (
                                    <Loader size={12} color="gray" />
                                ) : call.error ? (
                                    <Text size="xs" c="red">failed</Text>
                                ) : (
                                    <Text size="xs" c="dimmed">{formatDuration(call.durationMs)}</Text>
                                )}
                            </Group>
                        ))}
                    </Stack>
                </Paper>
            ) : null}

            {generating ? (
                <Paper withBorder radius="md" p="xs">
                    <Group gap="sm">
                        <Loader size={12} color="gray" />
                        <Text size="sm" c="dimmed">Generating…</Text>
                    </Group>
                </Paper>
            ) : null}
        </Stack>
    );
}
