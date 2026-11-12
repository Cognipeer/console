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

import { useEffect, useMemo, useState } from 'react';
import {
    ActionIcon,
    Badge,
    Group,
    SegmentedControl,
    Skeleton,
    Stack,
    Text,
    Tooltip,
    UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerStop, IconRefresh, IconX } from '@tabler/icons-react';
import EmptyState from '@/components/common/EmptyState';
import DataGrid from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import { RUN_POLL_MS, httpErrorOr, useAgentRuns, useCancelRun, type AgentRunRow } from '@/lib/api/queries/agents';
import { formatDuration, formatRelativeTime } from '@/lib/utils/tracingUtils';

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
    const tFeedback = useTranslations('navigationFeedback');
    const [filter, setFilter] = useState<Filter>('all');
    const [canceling, setCanceling] = useState<string | null>(null);

    const runsQuery = useAgentRuns(
        agentId,
        conversationId
            ? `conversationId=${encodeURIComponent(conversationId)}&limit=50`
            : `limit=200${trigger ? `&triggerId=${encodeURIComponent(trigger.id)}` : ''}`,
    );
    const cancelRun = useCancelRun(agentId);
    // Null until the first answer; a failed read reads as none. Polls while anything is still queued or running.
    const runs = useMemo<AgentRunRow[] | null>(
        () => runsQuery.data ?? (runsQuery.isPending ? null : []),
        [runsQuery.data, runsQuery.isPending],
    );
    const load = runsQuery.refetch;
    const { isError: runsFailed, errorUpdatedAt: runsFailedAt, data: runsData } = runsQuery;
    useEffect(() => {
        // The first load failing would read as "no runs yet": say so. A failed poll keeps the last list quietly.
        if (runsFailed && !runsData) notifications.show({ color: 'red', message: tFeedback('loadFailed') });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [runsFailed, runsFailedAt]);

    const activeCount = useMemo(() => (runs ?? []).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length, [runs]);
    useEffect(() => { onActiveCountChange?.(activeCount); }, [activeCount, onActiveCountChange]);

    const cancel = async (run: AgentRunRow) => {
        setCanceling(run.id);
        try {
            await cancelRun.mutateAsync(run.id);
            notifications.show({ color: 'teal', message: run.status === 'queued' || run.status === 'scheduled' ? 'Run canceled' : 'Cancel requested — the run stops at its next step' });
            await load();
        } catch (error) {
            notifications.show({ color: 'red', message: `Could not cancel: ${httpErrorOr(error)}` });
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
                    {activeCount > 0 ? <Text size="xs" c="dimmed">Refreshing every {RUN_POLL_MS / 1000}s</Text> : null}
                    <Tooltip label="Refresh" withArrow>
                        <ActionIcon variant="subtle" color="gray" onClick={() => void load()} aria-label="Refresh runs">
                            <IconRefresh size={14} />
                        </ActionIcon>
                    </Tooltip>
                </Group>
            </Group>

            <DataGrid<AgentRunRow>
                records={rows}
                rowKey={(run) => run.id}
                empty={{ title: 'No runs match this filter.' }}
                columns={[
                    {
                        key: 'status',
                        label: 'Status',
                        width: 110,
                        render: (run) => (
                            <Group gap={4} wrap="nowrap">
                                <StatusBadge status={run.status} />
                                {run.cancel_requested_at && ACTIVE_RUN_STATUSES.has(run.status)
                                    ? <Badge size="xs" color="orange" variant="light">canceling</Badge>
                                    : null}
                            </Group>
                        ),
                    },
                    {
                        key: 'run',
                        label: 'Run',
                        render: (run) => onOpenConversation ? (
                            <UnstyledButton onClick={() => onOpenConversation(run.conversation_id)}>
                                <Text size="xs" ff="monospace" c="dimmed">{run.id}</Text>
                                <Text size="xs" c="teal" td="underline">Open conversation</Text>
                            </UnstyledButton>
                        ) : <Text size="xs" ff="monospace" c="dimmed">{run.id}</Text>,
                    },
                    {
                        key: 'started',
                        label: 'Started',
                        width: 110,
                        render: (run) => (
                            <Text size="xs" c="dimmed">
                                {run.status === 'scheduled' && run.scheduled_for
                                    ? `Starts ${new Date(run.scheduled_for * 1000).toLocaleString()}`
                                    : run.created_at ? formatRelativeTime(new Date(run.created_at * 1000)) : '—'}
                            </Text>
                        ),
                    },
                    {
                        key: 'duration',
                        label: 'Duration',
                        align: 'right',
                        width: 90,
                        render: (run) => {
                            const duration = durationOf(run);
                            return <Text size="xs">{duration !== null ? formatDuration(duration) : '—'}</Text>;
                        },
                    },
                    {
                        key: 'callback',
                        label: 'Callback',
                        width: 130,
                        render: (run) => run.callback ? (
                            <Tooltip label={`${run.callback.url}${run.callback.signed ? ' · signed' : ''} · ${run.callback.attempts} attempt(s)`} withArrow multiline maw={360}>
                                <Badge
                                    size="xs"
                                    variant="light"
                                    color={run.callback.status === 'delivered' ? 'teal' : run.callback.status === 'failed' ? 'red' : 'gray'}
                                >
                                    {run.callback.status ?? 'pending'}
                                </Badge>
                            </Tooltip>
                        ) : <Text size="xs" c="dimmed">polling</Text>,
                    },
                    {
                        key: 'error',
                        label: 'Error',
                        render: (run) => run.error ? (
                            <Tooltip label={run.error.message ?? ''} disabled={!run.error.message} withArrow multiline maw={420}>
                                <Text size="xs" c={run.status === 'failed' ? 'red' : 'dimmed'} lineClamp={1}>
                                    {ERROR_LABELS[run.error.type] ?? run.error.type}
                                    {run.error.message && run.status === 'failed' ? ` — ${run.error.message}` : ''}
                                </Text>
                            </Tooltip>
                        ) : <Text size="xs" c="dimmed">—</Text>,
                    },
                    {
                        key: 'actions',
                        label: '',
                        align: 'right',
                        width: 40,
                        render: (run) => ACTIVE_RUN_STATUSES.has(run.status) && !run.cancel_requested_at ? (
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
                        ) : null,
                    },
                ]}
            />
        </Stack>
    );
}
