'use client';

/**
 * The inspector beside a session transcript.
 *
 * Everything here is derived from the turns the session already stores — no
 * extra fetch, no second source of truth. Tokens, cost and latency are
 * recorded per turn when the turn runs (`agentService.ts#persistSessionTurn`),
 * so a session reopened a week later shows the same numbers it showed live.
 */

import { useMemo, useState } from 'react';
import {
    Badge,
    Box,
    Code,
    CopyButton,
    Group,
    ScrollArea,
    Stack,
    Table,
    Tabs,
    Text,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { IconCheck, IconCopy, IconList, IconSettings, IconTool } from '@tabler/icons-react';
import { formatDuration, formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import type { ChatMessage, PlaygroundStep } from './sessionTypes';
import { formatCost, summariseSession } from './sessionUsage';
import classes from './AgentSessionView.module.css';

export interface SessionSidePanelProps {
    sessionId: string;
    createdAt?: string;
    updatedAt?: string;
    agentName: string;
    agentKey: string;
    /** '' means the session runs the draft config. */
    pinnedVersion: string;
    publishedVersion?: number | null;
    sessionContext?: Record<string, unknown>;
    messages: ChatMessage[];
    running: boolean;
    /** Jumps the transcript to the turn an event belongs to. */
    onGoToTurn: (index: number) => void;
}

interface FlatEvent {
    turnIndex: number;
    step: PlaygroundStep;
    stepIndex: number;
}

export default function SessionSidePanel({
    sessionId,
    createdAt,
    updatedAt,
    agentName,
    agentKey,
    pinnedVersion,
    publishedVersion,
    sessionContext,
    messages,
    running,
    onGoToTurn,
}: SessionSidePanelProps) {
    const [tab, setTab] = useState<string>('session');
    const totals = useMemo(() => summariseSession(messages), [messages]);

    const events = useMemo<FlatEvent[]>(() => {
        const flat: FlatEvent[] = [];
        messages.forEach((message, turnIndex) => {
            message.steps?.forEach((step, stepIndex) => flat.push({ turnIndex, step, stepIndex }));
        });
        return flat;
    }, [messages]);

    const tools = useMemo(() => {
        const byName = new Map<string, { calls: number; failed: number; subagent?: string }>();
        events.forEach(({ step }) => {
            const entry = byName.get(step.name) ?? { calls: 0, failed: 0, subagent: step.subagent };
            entry.calls += 1;
            if (step.error) entry.failed += 1;
            byName.set(step.name, entry);
        });
        return Array.from(byName.entries())
            .map(([name, value]) => ({ name, ...value }))
            .sort((a, b) => b.calls - a.calls);
    }, [events]);

    /** Per-turn cost bars — the shape of the spend, not just its total. */
    const costSeries = useMemo(() => {
        const points = messages
            .map((message, index) => ({ index, cost: message.usage?.costUsd ?? 0 }))
            .filter((point) => point.cost > 0);
        const max = points.reduce((acc, point) => Math.max(acc, point.cost), 0);
        return { points, max };
    }, [messages]);

    return (
        <Tabs value={tab} onChange={(value) => setTab(value ?? 'session')} className={classes.sidePanel}>
            <Tabs.List>
                <Tabs.Tab value="session" leftSection={<IconSettings size={13} />}>Session</Tabs.Tab>
                <Tabs.Tab value="events" leftSection={<IconList size={13} />}>
                    Events
                    {events.length > 0 ? <Badge size="xs" variant="light" ml={6}>{events.length}</Badge> : null}
                </Tabs.Tab>
                <Tabs.Tab value="tools" leftSection={<IconTool size={13} />}>
                    Tools
                    {tools.length > 0 ? <Badge size="xs" variant="light" ml={6}>{tools.length}</Badge> : null}
                </Tabs.Tab>
            </Tabs.List>

            <ScrollArea className={classes.sidePanelBody}>
                <Tabs.Panel value="session" p="md">
                    <Stack gap="lg">
                        <Stack gap={0}>
                            <MetaRow label="ID" value={<SessionIdValue id={sessionId} />} />
                            <MetaRow
                                label="Status"
                                value={
                                    <Badge size="xs" variant="light" color={running ? 'blue' : 'gray'}>
                                        {running ? 'Running' : 'Idle'}
                                    </Badge>
                                }
                            />
                            <MetaRow label="Created" value={<TimeValue value={createdAt} />} />
                            <MetaRow label="Updated" value={<TimeValue value={updatedAt} />} />
                            <MetaRow label="Agent" value={<Text size="xs" ff="monospace">{agentKey}</Text>} title={agentName} />
                            <MetaRow
                                label="Config"
                                value={
                                    <Badge size="xs" variant="light" color={pinnedVersion ? 'teal' : 'gray'}>
                                        {pinnedVersion
                                            ? `v${pinnedVersion}${Number(pinnedVersion) === publishedVersion ? ' · published' : ''}`
                                            : 'draft'}
                                    </Badge>
                                }
                            />
                            <MetaRow label="Turns" value={<Text size="xs">{totals.turns}</Text>} />
                        </Stack>

                        <Box>
                            <Group justify="space-between" align="baseline" mb={6}>
                                <Text size="xs" fw={700} tt="uppercase" c="dimmed">Cost</Text>
                                <Text size="sm" fw={600}>
                                    {formatCost(totals.costUsd)}
                                    {!totals.costComplete ? <Text component="span" size="xs" c="dimmed"> +</Text> : null}
                                </Text>
                            </Group>
                            {costSeries.points.length > 0 ? (
                                <Group gap={2} align="flex-end" className={classes.costChart}>
                                    {costSeries.points.map((point) => (
                                        <Tooltip
                                            key={point.index}
                                            label={`Turn ${Math.ceil((point.index + 1) / 2)} · ${formatCost(point.cost)}`}
                                            withArrow
                                        >
                                            <UnstyledButton
                                                onClick={() => onGoToTurn(point.index)}
                                                className={classes.costBar}
                                                style={{ height: `${Math.max(8, (point.cost / costSeries.max) * 100)}%` }}
                                            />
                                        </Tooltip>
                                    ))}
                                </Group>
                            ) : (
                                <Text size="xs" c="dimmed">
                                    {totals.turns > 0
                                        ? 'The model used here has no pricing configured.'
                                        : 'No turns yet.'}
                                </Text>
                            )}
                            {!totals.costComplete && costSeries.points.length > 0 ? (
                                <Text size="10px" c="dimmed" mt={4}>
                                    Some turns are unpriced — their model has no pricing configured.
                                </Text>
                            ) : null}
                        </Box>

                        <Box>
                            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Usage</Text>
                            <Table withRowBorders={false} verticalSpacing={4} className={classes.usageTable}>
                                <Table.Tbody>
                                    <UsageRow label="Input tokens" value={formatNumber(totals.inputTokens)} />
                                    <UsageRow label="Output tokens" value={formatNumber(totals.outputTokens)} />
                                    <UsageRow
                                        label="Cache read"
                                        value={formatNumber(totals.cachedInputTokens)}
                                        // Cached tokens are a discounted slice of the input
                                        // tokens above, not an extra charge on top.
                                        hint="Part of the input tokens, billed at the cache-read rate."
                                    />
                                    <UsageRow label="Total tokens" value={formatNumber(totals.totalTokens)} strong />
                                    <UsageRow
                                        label="Active time"
                                        value={formatDuration(totals.activeMs)}
                                        hint="Time the agent spent working, summed over turns."
                                    />
                                </Table.Tbody>
                            </Table>
                        </Box>

                        {sessionContext && Object.keys(sessionContext).length > 0 ? (
                            <Box>
                                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Session context</Text>
                                <Text size="10px" c="dimmed" mb={4}>
                                    Applied to every turn. A per-message override still wins.
                                </Text>
                                <Code block className={classes.sidePanelCode}>
                                    {JSON.stringify(sessionContext, null, 2)}
                                </Code>
                            </Box>
                        ) : null}
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="events" p="md">
                    {events.length === 0 ? (
                        <Text size="xs" c="dimmed">No tool calls in this session yet.</Text>
                    ) : (
                        <Stack gap={4}>
                            {events.map(({ turnIndex, step, stepIndex }) => (
                                <UnstyledButton
                                    key={`${turnIndex}-${stepIndex}`}
                                    onClick={() => onGoToTurn(turnIndex)}
                                    className={classes.eventRow}
                                >
                                    <Group gap="xs" wrap="nowrap">
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color={step.error ? 'red' : 'blue'}
                                            className={classes.eventBadge}
                                        >
                                            {stepIndex + 1}
                                        </Badge>
                                        <Box className={classes.eventName}>
                                            <Text size="xs" ff="monospace" truncate>{step.name}</Text>
                                            {step.subagent ? (
                                                <Text size="10px" c="violet.6">via {step.subagent}</Text>
                                            ) : null}
                                        </Box>
                                    </Group>
                                </UnstyledButton>
                            ))}
                        </Stack>
                    )}
                </Tabs.Panel>

                <Tabs.Panel value="tools" p="md">
                    {tools.length === 0 ? (
                        <Text size="xs" c="dimmed">This session has not called a tool yet.</Text>
                    ) : (
                        <Table withRowBorders={false} verticalSpacing={6}>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th><Text size="10px" c="dimmed" tt="uppercase">Tool</Text></Table.Th>
                                    <Table.Th ta="right"><Text size="10px" c="dimmed" tt="uppercase">Calls</Text></Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {tools.map((tool) => (
                                    <Table.Tr key={tool.name}>
                                        <Table.Td>
                                            <Text size="xs" ff="monospace" truncate>{tool.name}</Text>
                                            {tool.failed > 0 ? (
                                                <Text size="10px" c="red">{tool.failed} failed</Text>
                                            ) : null}
                                        </Table.Td>
                                        <Table.Td ta="right"><Text size="xs">{tool.calls}</Text></Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}
                </Tabs.Panel>
            </ScrollArea>
        </Tabs>
    );
}

function MetaRow({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
    return (
        <Group justify="space-between" wrap="nowrap" gap="sm" className={classes.metaRow}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Box className={classes.metaValue} title={title}>{value}</Box>
        </Group>
    );
}

function SessionIdValue({ id }: { id: string }) {
    return (
        <CopyButton value={id}>
            {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : id} withArrow>
                    <UnstyledButton onClick={copy} className={classes.copyId}>
                        <Group gap={4} wrap="nowrap">
                            <Text size="xs" ff="monospace" truncate>{id}</Text>
                            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                        </Group>
                    </UnstyledButton>
                </Tooltip>
            )}
        </CopyButton>
    );
}

function TimeValue({ value }: { value?: string }) {
    if (!value) return <Text size="xs" c="dimmed">—</Text>;
    return (
        <Tooltip label={new Date(value).toLocaleString()} withArrow>
            <Text size="xs">{formatRelativeTime(value)}</Text>
        </Tooltip>
    );
}

function UsageRow({
    label,
    value,
    strong,
    hint,
}: {
    label: string;
    value: string;
    strong?: boolean;
    hint?: string;
}) {
    const labelNode = <Text size="xs" c={strong ? undefined : 'dimmed'} fw={strong ? 600 : undefined}>{label}</Text>;
    return (
        <Table.Tr>
            <Table.Td>
                {hint ? <Tooltip label={hint} withArrow multiline w={220}>{labelNode}</Tooltip> : labelNode}
            </Table.Td>
            <Table.Td ta="right"><Text size="xs" fw={strong ? 700 : 500}>{value}</Text></Table.Td>
        </Table.Tr>
    );
}
