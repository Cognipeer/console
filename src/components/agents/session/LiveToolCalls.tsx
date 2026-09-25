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

/**
 * A live turn, in the order it happened: the model's text and its tool calls
 * interleave ("Let me search…" → web_search → "Found it, now…" → fetch →
 * answer). Keeping one text buffer and one call list rendered the calls on top
 * and every piece of text glued together underneath — the narration read as
 * part of the answer and the order was lost.
 */
export type LiveSegment =
    | { kind: 'text'; text: string }
    | { kind: 'tools'; calls: LiveToolCall[] };

export interface LiveToolEvent {
    phase: string;
    name: string;
    id?: string;
    args?: unknown;
    durationMs?: number;
    error?: string;
}

export function appendLiveText(segments: LiveSegment[], text: string): LiveSegment[] {
    if (!text) return segments;
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') {
        return [...segments.slice(0, -1), { kind: 'text', text: last.text + text }];
    }
    return [...segments, { kind: 'text', text }];
}

export function applyLiveToolEvent(segments: LiveSegment[], event: LiveToolEvent): LiveSegment[] {
    if (event.phase === 'start') {
        const count = segments.reduce((n, segment) => n + (segment.kind === 'tools' ? segment.calls.length : 0), 0);
        const call: LiveToolCall = {
            key: event.id ?? `${event.name}:${count}`,
            name: event.name,
            detail: summariseArgs(event.args),
            running: true,
        };
        const last = segments[segments.length - 1];
        if (last?.kind === 'tools') {
            return [...segments.slice(0, -1), { kind: 'tools', calls: [...last.calls, call] }];
        }
        return [...segments, { kind: 'tools', calls: [call] }];
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

/** Every call of the latest group settled and no text yet: the model is writing. */
export function isGenerating(segments: LiveSegment[]): boolean {
    const last = segments[segments.length - 1];
    return last?.kind === 'tools' && last.calls.every((call) => !call.running);
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
