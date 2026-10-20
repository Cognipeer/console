'use client';

/**
 * The runs of one agent, or of one of its sessions.
 *
 * Every turn is a run, and every run belongs to a session. The session list
 * says what a conversation holds; this table adds what it cannot show: each
 * run's lifecycle, why it failed, whether its callback landed, and a way to
 * stop it. In the session drawer it is filtered to that session
 * (`conversationId`). Polls while anything is still queued or running.
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
import { IconPlayerStop, IconRefresh, IconX } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';
import type { serializeAgentRun } from '@/lib/services/agents/agentRunService';

/** A run as `GET /api/agents/:id/runs` sends it. */
type AgentRunRow = ReturnType<typeof serializeAgentRun>;

const ERROR_LABELS: Record<string, string> = {
    agent_error: 'Agent error',
    guardrail_block: 'Blocked by guardrail',
    worker_lost: 'Worker lost',
    max_duration_exceeded: 'Max duration exceeded',
    canceled_by_caller: 'Canceled',
    precondition_failed: 'Agent or token no longer valid',
    service_disabled: 'Agents service switched off',
    service_not_licensed: 'Agents service not licensed',
    owner_disabled: 'Run owner disabled',
    owner_unverifiable: 'Run owner could not be verified',
};

type Filter = 'all' | 'active' | 'failed';
// A scheduled run is not running yet but can still change (it is promoted when due) and can be canceled.
export const ACTIVE_RUN_STATUSES = new Set(['scheduled', 'queued', 'running']);
const POLL_MS = 5_000;

export interface AgentRunsTableProps {
    agentId: string;
    /** Open the run's conversation in the session inspector; omitted where the table already is one. */
    onOpenConversation?: (conversationId: string) => void;
    /** Only this session's runs (compact: no trigger chip, newest 50). */
    conversationId?: string;
    /** Reports how many runs are queued/running, for a badge elsewhere. */
    onActiveCountChange?: (count: number) => void;
    /** Only the runs this trigger started (its history), with a way back to all runs. */
    trigger?: { id: string; name: string } | null;
    onClearTrigger?: () => void;
}

function durationOf(run: AgentRunRow): number | null {
    if (!run.started_at) return null;
    const end = run.completed_at ?? Math.floor(Date.now() / 1000);
    return Math.max(0, end - run.started_at) * 1000;
}

export default function AgentRunsTable({ agentId, onOpenConversation, conversationId, onActiveCountChange, trigger, onClearTrigger }: AgentRunsTableProps) {
    const tTriggers = useTranslations('agents.triggers');
    const tr = useTranslations('agents.reminders');
    const [runs, setRuns] = useState<AgentRunRow[] | null>(null);
    const [filter, setFilter] = useState<Filter>('all');
    const [canceling, setCanceling] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const query = conversationId
                ? `conversationId=${encodeURIComponent(conversationId)}&limit=50`
                : `limit=200${trigger ? `&triggerId=${encodeURIComponent(trigger.id)}` : ''}`;
            const res = await fetch(`/api/agents/${agentId}/runs?${query}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as { runs: AgentRunRow[] };
            setRuns(data.runs ?? []);
        } catch {
            setRuns((prev) => prev ?? []);
        }
    }, [agentId, trigger, conversationId]);

    useEffect(() => { void load(); }, [load]);

    const activeCount = useMemo(() => (runs ?? []).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length, [runs]);
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
            notifications.show({ color: 'teal', message: run.status === 'queued' || run.status === 'scheduled' ? 'Run canceled' : 'Cancel requested — the run stops at its next step' });
            await load();
        } catch (error) {
            notifications.show({ color: 'red', message: `Could not cancel: ${error instanceof Error ? error.message : String(error)}` });
        } finally {
            setCanceling(null);
        }
    };

    const rows = useMemo(() => (runs ?? []).filter((run) => {
        if (filter === 'active') return ACTIVE_RUN_STATUSES.has(run.status);
        if (filter === 'failed') return run.status === 'failed';
        return true;
    }), [runs, filter]);

    if (runs === null) {
        return <Stack gap="xs">{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</Stack>;
    }

    const triggerFilter = trigger && !conversationId ? (
        <Group gap={6}>
            <Badge
                variant="light"
                rightSection={onClearTrigger ? (
                    <ActionIcon size="xs" variant="transparent" color="gray" aria-label={tTriggers('runsFilterClear')} onClick={onClearTrigger}>
                        <IconX size={10} />
                    </ActionIcon>
                ) : null}
            >
                {tTriggers('runsFilter', { name: trigger.name })}
            </Badge>
        </Group>
    ) : null;

    if (runs.length === 0) {
        if (triggerFilter) {
            return (
                <Stack gap="sm">
                    {triggerFilter}
                    <Text size="sm" c="dimmed" ta="center" py="lg">No runs match this filter.</Text>
                </Stack>
            );
        }
        if (conversationId) {
            return <Text size="sm" c="dimmed" py="xs">{tr('noRunsForSession')}</Text>;
        }
        return (
            <EmptyState
                title="No runs yet"
                description="Every turn is recorded as a run, with its status, callback and result."
                minHeight={200}
            />
        );
    }

    return (
        <Stack gap="sm">
            {triggerFilter}
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
                                            {run.cancel_requested_at && ACTIVE_RUN_STATUSES.has(run.status)
                                                ? <Badge size="xs" color="orange" variant="light">canceling</Badge>
                                                : null}
                                        </Group>
                                    </Table.Td>
                                    <Table.Td>
                                        {onOpenConversation ? (
                                            <UnstyledButton onClick={() => onOpenConversation(run.conversation_id)}>
                                                <Text size="xs" ff="monospace" c="dimmed">{run.id}</Text>
                                                <Text size="xs" c="teal" td="underline">Open conversation</Text>
                                            </UnstyledButton>
                                        ) : <Text size="xs" ff="monospace" c="dimmed">{run.id}</Text>}
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="xs" c="dimmed">
                                            {run.status === 'scheduled' && run.scheduled_for
                                                ? `Starts ${new Date(run.scheduled_for * 1000).toLocaleString()}`
                                                : run.created_at ? formatRelativeTime(new Date(run.created_at * 1000)) : '—'}
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
                                        {ACTIVE_RUN_STATUSES.has(run.status) && !run.cancel_requested_at ? (
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
