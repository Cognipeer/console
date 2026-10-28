'use client';

/**
 * The reminders of one agent — the other view of the Sessions tab, shown only
 * for an agent that uses reminders. A reminder is a scheduled run on a session,
 * so this is the "what is coming" list: when, what the agent wrote, where, and
 * a way to fire or cancel it. Polls while anything is still scheduled.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Button, Group, Menu, Select, Skeleton, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDots, IconRefresh } from '@tabler/icons-react';
import DataGrid from '@/components/common/ui/DataGrid';
import { useConfirm } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { cancelReminder, fireReminderNow } from './reminderActions';
import ReminderDetailDrawer from './ReminderDetailDrawer';
import {
    filterReminders,
    formatUntil,
    isUpcomingReminder,
    reminderOwnerText,
    reminderQueryStatus,
    type AgentReminderView,
    type AgentRemindersResponse,
    type ReminderStatusFilter,
} from './reminderUi';

const POLL_MS = 15_000;

export interface AgentRemindersTableProps {
    agentId: string;
    /** Open the reminder's session in the session drawer. */
    onOpenSession: (sessionId: string) => void;
    /** Reports how many reminders are still scheduled, for the view switch. */
    onActiveCountChange?: (count: number) => void;
}

export default function AgentRemindersTable({ agentId, onOpenSession, onActiveCountChange }: AgentRemindersTableProps) {
    const t = useTranslations('agents.reminders');
    const { confirm } = useConfirm();
    const [reminders, setReminders] = useState<AgentReminderView[] | null>(null);
    const [viewOthers, setViewOthers] = useState(false);
    const [filter, setFilter] = useState<ReminderStatusFilter>('active');
    const [ownerId, setOwnerId] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

    const queryStatus = reminderQueryStatus(filter);
    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/agents/${agentId}/reminders?status=${queryStatus}&limit=200`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json() as AgentRemindersResponse;
            setReminders(data.reminders ?? []);
            setViewOthers(data.scope?.viewOthers === true);
            if (typeof data.summary?.active === 'number') onActiveCountChange?.(data.summary.active);
        } catch {
            setReminders((prev) => prev ?? []);
        }
    }, [agentId, queryStatus, onActiveCountChange]);

    useEffect(() => { void load(); }, [load]);

    const scheduledCount = useMemo(() => (reminders ?? []).filter(isUpcomingReminder).length, [reminders]);
    useEffect(() => {
        if (scheduledCount === 0) return;
        const timer = setInterval(() => { void load(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [scheduledCount, load]);

    const cancelOne = async (reminder: AgentReminderView) => {
        setBusyId(reminder.id);
        const ok = await cancelReminder(agentId, reminder.id, t('cancelFailed'));
        setBusyId(null);
        if (ok) {
            notifications.show({ color: 'teal', message: t('canceled') });
            setSelectedId(null);
            await load();
        }
    };

    const fireOne = async (reminder: AgentReminderView) => {
        setBusyId(reminder.id);
        const ok = await fireReminderNow(agentId, reminder.id, t('fireFailed'));
        setBusyId(null);
        if (ok) {
            notifications.show({ color: 'teal', message: t('fired') });
            setSelectedId(null);
            await load();
        }
    };

    const cancelAll = async () => {
        const active = (reminders ?? []).filter(isUpcomingReminder);
        const ok = await confirm({
            title: t('cancelAllTitle'),
            message: t('cancelAllMessage', { count: active.length }),
            confirmLabel: t('cancelAll'),
            tone: 'danger',
        });
        if (!ok) return;
        const results = await Promise.all(active.map((reminder) => cancelReminder(agentId, reminder.id, t('cancelFailed'))));
        notifications.show({ color: 'teal', message: t('canceledMany', { count: results.filter(Boolean).length }) });
        await load();
    };

    const owners = useMemo(() => {
        const seen = new Map<string, string>();
        for (const reminder of reminders ?? []) {
            if (reminder.owner?.id) seen.set(reminder.owner.id, reminderOwnerText(reminder));
        }
        return [...seen].map(([value, label]) => ({ value, label }));
    }, [reminders]);

    const rows = useMemo(() => filterReminders(reminders ?? [], filter, ownerId), [reminders, filter, ownerId]);
    const selected = (reminders ?? []).find((reminder) => reminder.id === selectedId) ?? null;

    if (reminders === null) {
        return <Stack gap="xs">{[0, 1, 2].map((i) => <Skeleton key={i} h={36} />)}</Stack>;
    }

    return (
        <Stack gap="sm">
            <Group justify="space-between">
                <Group gap="xs">
                    <Select
                        size="xs"
                        w={140}
                        allowDeselect={false}
                        aria-label={t('statusFilter')}
                        value={filter}
                        onChange={(value) => setFilter((value as ReminderStatusFilter) ?? 'active')}
                        data={[
                            { value: 'active', label: t('filterActive') },
                            { value: 'all', label: t('filterAll') },
                            { value: 'succeeded', label: t('status_succeeded') },
                            { value: 'failed', label: t('status_failed') },
                            { value: 'canceled', label: t('status_canceled') },
                        ]}
                    />
                    {viewOthers && owners.length > 0 ? (
                        <Select
                            size="xs"
                            w={160}
                            clearable
                            placeholder={t('allOwners')}
                            aria-label={t('owner')}
                            value={ownerId}
                            onChange={setOwnerId}
                            data={owners}
                        />
                    ) : null}
                </Group>
                <Group gap="xs">
                    <Tooltip label={t('refresh')} withArrow>
                        <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => void load()} aria-label={t('refresh')}>
                            <IconRefresh size={14} />
                        </ActionIcon>
                    </Tooltip>
                    <Menu position="bottom-end" withinPortal>
                        <Menu.Target>
                            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('more')}>
                                <IconDots size={14} />
                            </ActionIcon>
                        </Menu.Target>
                        <Menu.Dropdown>
                            <Menu.Item color="red" disabled={scheduledCount === 0} onClick={() => void cancelAll()}>
                                {t('cancelAll')}
                            </Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                </Group>
            </Group>

            <DataGrid<AgentReminderView>
                records={rows}
                rowKey={(reminder) => reminder.id}
                empty={{ title: t('emptyTitle'), description: t('emptyDescription') }}
                columns={[
                    {
                        key: 'fire_at',
                        label: t('nextFire'),
                        width: 170,
                        render: (reminder) => (
                            <>
                                <Text size="xs">{new Date(reminder.fire_at * 1000).toLocaleString()}</Text>
                                {isUpcomingReminder(reminder) ? <Text size="xs" c="dimmed">{formatUntil(reminder.fire_at, t)}</Text> : null}
                            </>
                        ),
                    },
                    {
                        key: 'message',
                        label: t('message'),
                        render: (reminder) => (
                            <UnstyledButton onClick={() => setSelectedId(reminder.id)} maw={420}>
                                {reminder.restricted
                                    ? <Text size="sm" c="dimmed" fs="italic" lineClamp={1} data-testid="reminder-restricted">{t('restrictedMessage')}</Text>
                                    : <Text size="sm" lineClamp={1}>{reminder.message}</Text>}
                            </UnstyledButton>
                        ),
                    },
                    {
                        key: 'session',
                        label: t('sessionOwner'),
                        width: 220,
                        render: (reminder) => (
                            <>
                                <UnstyledButton onClick={() => onOpenSession(reminder.session_id)} maw={210}>
                                    <Text size="xs" lineClamp={1}>{reminder.session_title || reminder.session_id}</Text>
                                </UnstyledButton>
                                {reminder.owner ? <Text size="xs" c="dimmed" lineClamp={1}>{reminderOwnerText(reminder)}</Text> : null}
                            </>
                        ),
                    },
                    {
                        key: 'status',
                        label: t('status'),
                        width: 120,
                        render: (reminder) => <Text size="xs" c="dimmed">{t(`status_${reminder.status}`)}</Text>,
                    },
                    {
                        key: 'actions',
                        label: '',
                        align: 'right',
                        width: 80,
                        render: (reminder) =>
                            isUpcomingReminder(reminder) ? (
                                <Button size="compact-xs" variant="subtle" color="gray" loading={busyId === reminder.id} onClick={() => void cancelOne(reminder)}>
                                    {t('cancel')}
                                </Button>
                            ) : null,
                    },
                ]}
            />

            <Text size="xs" c="dimmed">{t('retentionNote')}</Text>

            <ReminderDetailDrawer
                reminder={selected}
                onClose={() => setSelectedId(null)}
                onOpenSession={(sessionId) => { setSelectedId(null); onOpenSession(sessionId); }}
                onFireNow={fireOne}
                onCancel={cancelOne}
            />
        </Stack>
    );
}
