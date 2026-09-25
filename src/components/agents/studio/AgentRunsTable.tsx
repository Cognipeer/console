'use client';

/**
 * Background runs of one agent — the queue side of Sessions.
 *
 * A background run is an API turn that was queued instead of held open
 * (docs/guide/agent-background-execution.md). Its conversation is an
 * ordinary session; this table adds what the session cannot show: the run's
 * lifecycle, why it failed, whether its callback landed, and a way to stop
 * it. Polls while anything is still queued or running.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Group,
    SegmentedControl,
    Skeleton,
    Stack,
    Table,
    Text,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import type { serializeAgentRun } from '@/lib/services/agents/agentRunService';

/** A run as `GET /api/agents/:id/runs` sends it. */
type AgentRunRow = ReturnType<typeof serializeAgentRun>;

const ERROR_LABELS: Record<string, string> = {
    agent_error: 'Agent error',
    worker_lost: 'Worker lost',
    max_duration_exceeded: 'Max duration exceeded',
    canceled_by_caller: 'Canceled',
    precondition_failed: 'Agent or token no longer valid',
};

type Filter = 'all' | 'active' | 'failed';
const ACTIVE = new Set(['queued', 'running']);
const POLL_MS = 5_000;

export interface AgentRunsTableProps {
    agentId: string;
    /** Open the run's conversation in the session inspector. */
    onOpenConversation: (conversationId: string) => void;
    /** Reports how many runs are queued/running, for a badge elsewhere. */
    onActiveCountChange?: (count: number) => void;
}

function durationOf(run: AgentRunRow): number | null {
    if (!run.started_at) return null;
    const end = run.completed_at ?? Math.floor(Date.now() / 1000);
    return Math.max(0, end - run.started_at) * 1000;
}

export default function AgentRunsTable({ agentId, onOpenConversation, onActiveCountChange }: AgentRunsTableProps) {
    const [runs, setRuns] = useState<AgentRunRow[] | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const [canceling, setCanceling] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/runs?limit=200`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { runs: AgentRunRow[] };
            setRuns(data.runs ?? []);
        } catch {
            setRuns((prev) => prev ?? []);
        }
    }, [agentId]);

    useEffect(() => { void load(); }, [load]);

    const activeCount = useMemo(() => (runs ?? []).filter((run) => ACTIVE.has(run.status)).length, [runs]);
    useEffect(() => { onActiveCountChange?.(activeCount); }, [activeCount, onActiveCountChange]);

    // Poll only while something can still change.
    useEffect(() => {
        if (activeCount === 0) return;
        const timer = setInterval(() => { void load(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [activeCount, load]);

    const cancel = async (run: AgentRunRow) => {
        setCanceling(run.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/runs/${run.id}/cancel`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
            notifications.show({ color: 'teal', message: run.status === 'queued' ? 'Run canceled' : 'Cancel requested — the run stops at its next step' });
            await load();
        } catch (error) {
            notifications.show({ color: 'red', message: `Could not cancel: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setCanceling(null);
        }
    };

    const rows = useMemo(() => (runs ?? []).filter((run) => {
        if (filter === 'active') return ACTIVE.has(run.status);
        if (filter === 'failed') return run.status === 'failed';
        return true;
    }), [runs, filter]);

    if (runs === null) {
        return <Stack gap="xs">{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</Stack>;
    }

    if (runs.length === 0) {
        return (
            <EmptyState
                title="No background runs yet"
                description="API calls with background: true are queued and show up here with their status, callback and result."
                minHeight={200}
            />
        );
    }

    return (
        <Stack gap="sm">
            <Group justify="space-between">
                <SegmentedControl
                    size="xs"
                    value={filter}
                    onChange={(value) => setFilter(value as Filter)}
                    data={[
                        { value: 'all', label: `All · ${runs.length}` },
                        { value: 'active', label: `Active · ${activeCount}` },
                        { value: 'failed', label: `Failed · ${runs.filter((run) => run.status === 'failed').length}` },
                    ]}
                />
                <Group gap="xs">
                    {activeCount > 0 ? <Text size="xs" c="dimmed">Refreshing every {POLL_MS / 1000}s</Text> : null}
                    <Tooltip label="Refresh" withArrow>
                        <ActionIcon variant="subtle" color="gray" onClick={() => void load()} aria-label="Refresh runs">
                            <IconRefresh size={14} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>

            {rows.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="lg">No runs match this filter.</Text>
            ) : (
                <Table highlightOnHover verticalSpacing={6}>
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th w={110}>Status</Table.Th>
                            <Table.Th>Run</Table.Th>
                            <Table.Th w={110}>Started</Table.Th>
                            <Table.Th w={90} ta="right">Duration</Table.Th>
                            <Table.Th w={130}>Callback</Table.Th>
                            <Table.Th>Error</Table.Th>
                            <Table.Th w={40} />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {rows.map((run) => {
                            const duration = durationOf(run);
                            return (
                                <Table.Tr key={run.id}>
                                    <Table.Td>
                                        <Group gap={4} wrap="nowrap">
                                            <StatusBadge status={run.status} />
                                            {run.cancel_requested_at && ACTIVE.has(run.status)
                                                ? <Badge size="xs" color="orange" variant="light">canceling</Badge>
                                                : null}
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>
                                        <UnstyledButton onClick={() => onOpenConversation(run.conversation_id)}>
                                            <Text size="xs" ff="monospace" c="dimmed">{run.id}</Text>
                                            <Text size="xs" c="teal" td="underline">Open conversation</Text>
                                        </UnstyledButton>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="xs" c="dimmed">
                                            {run.created_at ? formatRelativeTime(new Date(run.created_at * 1000)) : '—'}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td ta="right">
                                        <Text size="xs">{duration !== null ? formatDuration(duration) : '—'}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        {run.callback ? (
                                            <Tooltip label={`${run.callback.url}${run.callback.signed ? ' · signed' : ''} · ${run.callback.attempts} attempt(s)`} withArrow multiline maw={360}>
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color={run.callback.status === 'delivered' ? 'teal' : run.callback.status === 'failed' ? 'red' : 'gray'}
                                                >
                                                    {run.callback.status ?? 'pending'}
                                                </Badge>
                                            </Tooltip>
                                        ) : <Text size="xs" c="dimmed">polling</Text>}
                                    </Table.Td>
                                    <Table.Td>
                                        {run.error ? (
                                            <Tooltip label={run.error.message ?? ''} disabled={!run.error.message} withArrow multiline maw={420}>
                                                <Text size="xs" c={run.status === 'failed' ? 'red' : 'dimmed'} lineClamp={1}>
                                                    {ERROR_LABELS[run.error.type] ?? run.error.type}
                                                    {run.error.message && run.status === 'failed' ? ` — ${run.error.message}` : ''}
                                                </Text>
                                            </Tooltip>
                                        ) : <Text size="xs" c="dimmed">—</Text>}
                                    </Table.Td>
                                    <Table.Td>
                                        {ACTIVE.has(run.status) && !run.cancel_requested_at ? (
                                            <Tooltip label="Cancel run" withArrow>
                                                <ActionIcon
                                                    size="sm"
                                                    variant="subtle"
                                                    color="red"
                                                    loading={canceling === run.id}
                                                    onClick={() => void cancel(run)}
                                                    aria-label="Cancel run"
                                                >
                                                    <IconPlayerStop size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        ) : null}
                                    </Table.Td>
                                </Table.Tr>
                            );
                        })}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
}
