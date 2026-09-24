'use client';

/**
 * A session, read — not resumed.
 *
 * Clicking a session used to drop you straight into the chat, which is the
 * wrong default for most of what the list holds: API, A2A and scheduled runs
 * are real traffic you want to inspect, not continue. So a click opens this
 * panel (the same read-first shape as Observability), and only a session a
 * person started from the console to try the agent offers Continue.
 */

import { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Center,
    Code,
    Drawer,
    Group,
    Loader,
    Paper,
    Stack,
    Table,
    Tabs,
    Text,
} from '@mantine/core';
import {
    IconActivity,
    IconCoin,
    IconCode,
    IconMessageCircle,
    IconPlayerPlay,
    IconClock,
    IconTool,
    IconHash,
    IconInfoCircle,
} from '@tabler/icons-react';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import MessageBlock from '@/components/common/ui/MessageBlock';
import JsonTreeViewer from '@/components/common/JsonTreeViewer';
import PropertiesPanel from '@/components/common/ui/PropertiesPanel';
import ThreadDetailView from '@/components/tracing/ThreadDetailView';
import { formatDuration, formatNumber } from '@/lib/utils/tracingUtils';
import { formatCost } from '../session/sessionUsage';
import type { ChatMessage, PlaygroundStep } from '../session/sessionTypes';
import { isContinuableSession, messageCountOf, SessionSourceBadge, sessionSourceLabel, type SessionListItem } from './SessionList';

interface SessionRecord {
    _id: string;
    title?: string;
    createdAt?: string;
    updatedAt?: string;
    messages?: ChatMessage[];
    metadata?: Record<string, unknown>;
}

export interface SessionDetailDrawerProps {
    agentId: string;
    /** The row that was clicked; null closes the drawer. */
    session: SessionListItem | null;
    onClose: () => void;
    onContinue: (sessionId: string) => void;
}

function stepStatus(step: PlaygroundStep): string {
    if (step.status === 'error' || step.error) return 'error';
    if (step.status === 'rejected') return 'warn';
    return 'ok';
}

export default function SessionDetailDrawer({ agentId, session, onClose, onContinue }: SessionDetailDrawerProps) {
    const [record, setRecord] = useState<SessionRecord | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const sessionId = session?._id;

    useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setRecord(null);
        fetch(`/api/agents/${agentId}/sessions/${sessionId}`, { cache: 'no-store' })
            .then(async (res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!cancelled) setRecord(data.session as SessionRecord);
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [agentId, sessionId]);

    const toolUsage = useMemo(() => {
        const byName = new Map<string, { calls: number; errors: number }>();
        for (const message of record?.messages ?? []) {
            for (const step of message.steps ?? []) {
                const entry = byName.get(step.name) ?? { calls: 0, errors: 0 };
                entry.calls += 1;
                if (stepStatus(step) === 'error') entry.errors += 1;
                byName.set(step.name, entry);
            }
        }
        return [...byName.entries()].sort((a, b) => b[1].calls - a[1].calls);
    }, [record]);

    const continuable = session ? isContinuableSession(session.source) : false;

    return (
        <Drawer
            opened={Boolean(session)}
            onClose={onClose}
            position="right"
            size="80%"
            title={
                <Group gap="xs" wrap="nowrap">
                    <Text fw={600} lineClamp={1}>{session?.title || 'New session'}</Text>
                    {session ? <SessionSourceBadge source={session.source} /> : null}
                </Group>
            }
        >
            {session ? (
                <Stack gap="md">
                    {!continuable ? (
                        <Alert variant="light" color="gray" p="xs">
                            <Text size="xs">
                                Read-only — this session came in via {sessionSourceLabel(session.source)}. Only sessions
                                started from the console can be continued here.
                            </Text>
                        </Alert>
                    ) : null}

                    {/*
                      Agent turns are traced with threadId = conversationId, so
                      the Observability thread view is this session. Sessions
                      with no trace (tracing off, or older than it) fall back
                      to the stored transcript.
                    */}
                    <ThreadDetailView
                        key={session._id}
                        threadId={session._id}
                        embedded
                        actions={continuable ? (
                            <Button
                                size="xs"
                                leftSection={<IconPlayerPlay size={14} />}
                                onClick={() => onContinue(session._id)}
                            >
                                Continue
                            </Button>
                        ) : null}
                        emptyFallback={
                            <Stack gap="md">
                                {continuable ? (
                                    <Group justify="flex-end">
                                        <Button
                                            size="xs"
                                            leftSection={<IconPlayerPlay size={14} />}
                                            onClick={() => onContinue(session._id)}
                                        >
                                            Continue
                                        </Button>
                                    </Group>
                                ) : null}
                                                <div className="ds-stat-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                                                    <StatTile label="Turns" icon={<IconHash size={14} stroke={1.7} />} value={session.turns ?? 0} />
                                                    <StatTile
                                                        label="Tokens"
                                                        icon={<IconActivity size={14} stroke={1.7} />}
                                                        value={session.totalTokens ? formatNumber(session.totalTokens) : '—'}
                                                    />
                                                    <StatTile
                                                        label="Cost"
                                                        icon={<IconCoin size={14} stroke={1.7} />}
                                                        value={session.costUsd ? formatCost(session.costUsd) : '—'}
                                                    />
                                                    <StatTile
                                                        label="Active"
                                                        icon={<IconClock size={14} stroke={1.7} />}
                                                        value={session.activeMs ? formatDuration(session.activeMs) : '—'}
                                                    />
                                                </div>
                            
                                                {loading ? (
                                                    <Center py="xl"><Loader size="sm" /></Center>
                                                ) : error ? (
                                                    <Alert color="red" variant="light">Could not load the session: {error}</Alert>
                                                ) : record ? (
                                                    <Tabs defaultValue="conversation">
                                                        <Tabs.List>
                                                            <Tabs.Tab value="conversation" leftSection={<IconMessageCircle size={14} />}>
                                                                Conversation
                                                            </Tabs.Tab>
                                                            <Tabs.Tab value="tools" leftSection={<IconTool size={14} />}>
                                                                Tools{toolUsage.length > 0 ? ` · ${toolUsage.length}` : ''}
                                                            </Tabs.Tab>
                                                            <Tabs.Tab value="details" leftSection={<IconInfoCircle size={14} />}>Details</Tabs.Tab>
                                                            <Tabs.Tab value="raw" leftSection={<IconCode size={14} />}>Raw</Tabs.Tab>
                                                        </Tabs.List>
                            
                                                        <Tabs.Panel value="conversation" pt="md">
                                                            {(record.messages ?? []).length === 0 ? (
                                                                <Text size="sm" c="dimmed">No messages yet.</Text>
                                                            ) : (
                                                                <Stack gap="sm">
                                                                    {(record.messages ?? []).map((message, index) => (
                                                                        <Paper key={index} withBorder radius="md" p="sm">
                                                                            <Stack gap="xs">
                                                                                <MessageBlock messageRole={message.role} content={message.content} />
                                                                                {(message.steps ?? []).length > 0 ? (
                                                                                    <Stack gap={4}>
                                                                                        {(message.steps ?? []).map((step, stepIndex) => (
                                                                                            <Group key={step.id ?? stepIndex} gap="xs" wrap="nowrap">
                                                                                                <StatusBadge status={stepStatus(step)} label={step.status ?? 'success'} />
                                                                                                <Code>{step.name}</Code>
                                                                                                {step.error ? (
                                                                                                    <Text size="xs" c="red" lineClamp={1}>{step.error}</Text>
                                                                                                ) : null}
                                                                                            </Group>
                                                                                        ))}
                                                                                    </Stack>
                                                                                ) : null}
                                                                                {message.role === 'assistant' && message.usage ? (
                                                                                    <Group gap="md">
                                                                                        {message.latencyMs ? (
                                                                                            <Text size="xs" c="dimmed">{formatDuration(message.latencyMs)}</Text>
                                                                                        ) : null}
                                                                                        {message.usage.totalTokens ? (
                                                                                            <Text size="xs" c="dimmed">{formatNumber(message.usage.totalTokens)} tokens</Text>
                                                                                        ) : null}
                                                                                        {message.usage.costUsd ? (
                                                                                            <Text size="xs" c="dimmed">{formatCost(message.usage.costUsd)}</Text>
                                                                                        ) : null}
                                                                                    </Group>
                                                                                ) : null}
                                                                            </Stack>
                                                                        </Paper>
                                                                    ))}
                                                                </Stack>
                                                            )}
                                                        </Tabs.Panel>
                            
                                                        <Tabs.Panel value="tools" pt="md">
                                                            {toolUsage.length === 0 ? (
                                                                <Text size="sm" c="dimmed">No tool calls in this session.</Text>
                                                            ) : (
                                                                <Table verticalSpacing={6}>
                                                                    <Table.Thead>
                                                                        <Table.Tr>
                                                                            <Table.Th>Tool</Table.Th>
                                                                            <Table.Th ta="right">Calls</Table.Th>
                                                                            <Table.Th ta="right">Errors</Table.Th>
                                                                        </Table.Tr>
                                                                    </Table.Thead>
                                                                    <Table.Tbody>
                                                                        {toolUsage.map(([name, stats]) => (
                                                                            <Table.Tr key={name}>
                                                                                <Table.Td><Code>{name}</Code></Table.Td>
                                                                                <Table.Td ta="right"><Text size="xs">{stats.calls}</Text></Table.Td>
                                                                                <Table.Td ta="right">
                                                                                    {stats.errors > 0
                                                                                        ? <Badge size="xs" color="red" variant="light">{stats.errors}</Badge>
                                                                                        : <Text size="xs" c="dimmed">0</Text>}
                                                                                </Table.Td>
                                                                            </Table.Tr>
                                                                        ))}
                                                                    </Table.Tbody>
                                                                </Table>
                                                            )}
                                                        </Tabs.Panel>
                            
                                                        <Tabs.Panel value="details" pt="md">
                                                            <PropertiesPanel
                                                                title="Session"
                                                                rows={[
                                                                    { key: 'source', label: 'Source', value: sessionSourceLabel(session.source) },
                                                                    { key: 'messages', label: 'Messages', value: String(messageCountOf(session)) },
                                                                    { key: 'in', label: 'Input tokens', value: session.inputTokens ? formatNumber(session.inputTokens) : '—' },
                                                                    { key: 'out', label: 'Output tokens', value: session.outputTokens ? formatNumber(session.outputTokens) : '—' },
                                                                    {
                                                                        key: 'avg',
                                                                        label: 'Average turn',
                                                                        value: session.activeMs && session.turns
                                                                            ? formatDuration(Math.round(session.activeMs / session.turns))
                                                                            : '—',
                                                                    },
                                                                    {
                                                                        key: 'created',
                                                                        label: 'Created',
                                                                        value: session.createdAt ? new Date(session.createdAt).toLocaleString() : '—',
                                                                    },
                                                                    {
                                                                        key: 'ctx',
                                                                        label: 'Session context',
                                                                        value: session.hasContext ? <Badge size="xs" variant="light">set</Badge> : 'none',
                                                                    },
                                                                ]}
                                                            />
                                                            {record.metadata?.runtimeContext ? (
                                                                <Stack gap={6} mt="md">
                                                                    <Text size="xs" fw={700} c="dimmed" tt="uppercase">Runtime context</Text>
                                                                    <JsonTreeViewer data={record.metadata.runtimeContext} initialExpandLevel={1} />
                                                                </Stack>
                                                            ) : null}
                                                        </Tabs.Panel>
                            
                                                        <Tabs.Panel value="raw" pt="md">
                                                            <JsonTreeViewer data={record} initialExpandLevel={1} />
                                                        </Tabs.Panel>
                                                    </Tabs>
                                                ) : null}
                            </Stack>
                        }
                    />
                </Stack>
            ) : null}
        </Drawer>
    );
}
