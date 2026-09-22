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

import { Box, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconWorld } from '@tabler/icons-react';
import { formatDuration } from '@/lib/utils/tracingUtils';
import classes from './AgentSessionView.module.css';

export interface LiveToolCall {
    /** Provider tool-call id when there is one; a synthetic key otherwise. */
    key: string;
    name: string;
    /** The argument worth showing beside the name — see `summariseArgs`. */
    detail?: string;
    running: boolean;
    durationMs?: number;
    error?: string;
}

/**
 * The one argument a human would use to tell two calls of the same tool apart.
 *
 * Tool schemas differ, so this prefers the conventional "what was asked"
 * fields and falls back to the first short string rather than dumping JSON:
 * the row is a progress line, not a payload viewer — the full args are in the
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

            {/* Nothing to show yet: the first model call has not decided on a
                tool, so neither a tool row nor "Generating" would be true. */}
            {calls.length === 0 && !generating ? <Box /> : null}
        </Stack>
    );
}
