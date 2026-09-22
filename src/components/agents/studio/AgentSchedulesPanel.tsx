'use client';

/**
 * Recurring runs for an agent.
 *
 * Every schedule runs the PUBLISHED version, so an unpublished agent gets a
 * blocking notice rather than a form: a schedule that silently never fires is
 * worse than one you cannot create yet.
 */

import { useCallback, useEffect, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Code,
    Group,
    Modal,
    NumberInput,
    SegmentedControl,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle,
    IconCalendarTime,
    IconInfoCircle,
    IconPencil,
    IconPlayerPlay,
    IconPlus,
    IconTrash,
} from '@tabler/icons-react';

interface Schedule {
    id: string;
    name: string;
    enabled: boolean;
    mode: 'interval' | 'cron';
    intervalSeconds?: number;
    cron?: string;
    message: string;
    variables?: Record<string, string>;
    lastRunAt?: string;
    lastStatus?: 'ok' | 'error';
    lastError?: string;
    lastConversationId?: string;
}

export interface AgentSchedulesPanelProps {
    agentId: string;
    publishedVersion?: number | null;
}

const CRON_PRESETS = [
    { label: 'Every hour', cron: '0 * * * *' },
    { label: 'Every weekday at 09:00 UTC', cron: '0 9 * * 1-5' },
    { label: 'Every night at 02:00 UTC', cron: '0 2 * * *' },
    { label: 'Every Monday at 08:00 UTC', cron: '0 8 * * 1' },
];

const EMPTY: Schedule = {
    id: '',
    name: '',
    enabled: true,
    mode: 'cron',
    cron: '0 9 * * 1-5',
    message: '',
};

function formatWhen(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
}

export default function AgentSchedulesPanel({ agentId, publishedVersion }: AgentSchedulesPanelProps) {
    const [schedules, setSchedules] = useState<Schedule[]>([]);
    const [nextRuns, setNextRuns] = useState<Record<string, string | null>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [runningId, setRunningId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Schedule | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/schedules`, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            setSchedules(data.schedules ?? []);
            setNextRuns(data.nextRuns ?? {});
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async () => {
        if (!draft) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/schedules`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(draft.id ? { id: draft.id } : {}),
                    name: draft.name.trim(),
                    enabled: draft.enabled,
                    mode: draft.mode,
                    intervalSeconds: draft.mode === 'interval' ? draft.intervalSeconds : undefined,
                    cron: draft.mode === 'cron' ? draft.cron : undefined,
                    message: draft.message,
                    variables: draft.variables,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                notifications.show({ title: 'Schedule rejected', message: data.error, color: 'red' });
                return;
            }
            setDraft(null);
            await load();
        } finally {
            setSaving(false);
        }
    };

    const remove = async (id: string) => {
        const res = await fetch(`/api/agents/${agentId}/schedules/${id}`, { method: 'DELETE' });
        if (res.ok) await load();
    };

    const toggle = async (schedule: Schedule) => {
        await fetch(`/api/agents/${agentId}/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...schedule, enabled: !schedule.enabled }),
        });
        await load();
    };

    const runNow = async (schedule: Schedule) => {
        setRunningId(schedule.id);
        try {
            const res = await fetch(`/api/agents/${agentId}/schedules/${schedule.id}/run`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                notifications.show({ title: 'Run failed', message: data.error, color: 'red' });
                return;
            }
            notifications.show({
                title: 'Run finished',
                message: data.content ? String(data.content).slice(0, 160) : 'The agent produced no text.',
                color: 'teal',
            });
            await load();
        } finally {
            setRunningId(null);
        }
    };

    if (!publishedVersion) {
        return (
            <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} title="Publish first">
                <Text size="sm">
                    A schedule always runs the published version — that is what keeps an unattended job from
                    changing behaviour the moment somebody opens the playground. Publish this agent and the
                    scheduler becomes available.
                </Text>
            </Alert>
        );
    }

    return (
        <Stack gap="md">
            <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                    <Text size="sm" fw={600}>Schedules</Text>
                    <Text size="xs" c="dimmed">
                        Each fire starts a fresh conversation and runs published v{publishedVersion}. Times are UTC.
                    </Text>
                </Stack>
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft({ ...EMPTY })}>
                    Add schedule
                </Button>
            </Group>

            {!loading && schedules.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">
                        No schedules. Add one to run this agent on a cadence — a nightly digest, an hourly
                        triage sweep, a weekly report.
                    </Text>
                </Alert>
            ) : null}

            <Stack gap="xs">
                {schedules.map((schedule) => (
                    <Card key={schedule.id} withBorder padding="sm" radius="md">
                        <Group justify="space-between" align="flex-start" wrap="nowrap">
                            <Stack gap={4} style={{ minWidth: 0 }}>
                                <Group gap="xs">
                                    <Text size="sm" fw={600}>{schedule.name}</Text>
                                    <Badge size="xs" variant="light" leftSection={<IconCalendarTime size={9} />}>
                                        {schedule.mode === 'cron'
                                            ? schedule.cron
                                            : `every ${schedule.intervalSeconds ?? 0}s`}
                                    </Badge>
                                    {!schedule.enabled ? (
                                        <Badge size="xs" variant="light" color="gray">paused</Badge>
                                    ) : null}
                                    {schedule.lastStatus ? (
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color={schedule.lastStatus === 'ok' ? 'teal' : 'red'}
                                        >
                                            last run {schedule.lastStatus}
                                        </Badge>
                                    ) : null}
                                </Group>
                                <Text size="xs" c="dimmed" lineClamp={2}>{schedule.message}</Text>
                                <Group gap="md">
                                    {schedule.lastConversationId ? (
                                        <Anchor
                                            size="xs"
                                            href={`/dashboard/tracing/threads/${schedule.lastConversationId}`}
                                            target="_blank"
                                        >
                                            Last: {formatWhen(schedule.lastRunAt)}
                                        </Anchor>
                                    ) : (
                                        <Text size="xs" c="dimmed">Last: {formatWhen(schedule.lastRunAt)}</Text>
                                    )}
                                    <Text size="xs" c="dimmed">Next: {formatWhen(nextRuns[schedule.id])}</Text>
                                    <Anchor
                                        size="xs"
                                        href={`/dashboard/tracing/sessions?metadataKey=scheduleId&metadataValue=${schedule.id}`}
                                        target="_blank"
                                    >
                                        All runs
                                    </Anchor>
                                </Group>
                                {schedule.lastError ? (
                                    <Text size="xs" c="red" lineClamp={2}>{schedule.lastError}</Text>
                                ) : null}
                            </Stack>

                            <Group gap={4} wrap="nowrap">
                                <Tooltip label="Run now (does not affect the next scheduled fire)">
                                    <ActionIcon
                                        variant="subtle"
                                        size="sm"
                                        loading={runningId === schedule.id}
                                        onClick={() => void runNow(schedule)}
                                    >
                                        <IconPlayerPlay size={14} />
                                    </ActionIcon>
                                </Tooltip>
                                <Tooltip label={schedule.enabled ? 'Pause' : 'Resume'}>
                                    <Switch
                                        size="xs"
                                        mt={6}
                                        checked={schedule.enabled}
                                        onChange={() => void toggle(schedule)}
                                    />
                                </Tooltip>
                                <ActionIcon variant="subtle" size="sm" onClick={() => setDraft({ ...schedule })}>
                                    <IconPencil size={14} />
                                </ActionIcon>
                                <ActionIcon variant="subtle" size="sm" color="red" onClick={() => void remove(schedule.id)}>
                                    <IconTrash size={14} />
                                </ActionIcon>
                            </Group>
                        </Group>
                    </Card>
                ))}
            </Stack>

            <Modal
                opened={draft !== null}
                onClose={() => setDraft(null)}
                title={draft?.id ? 'Edit schedule' : 'Add schedule'}
                size="lg"
            >
                {draft ? (
                    <Stack gap="md">
                        <TextInput
                            label="Name"
                            placeholder="Nightly incident digest"
                            value={draft.name}
                            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                            required
                        />

                        <SegmentedControl
                            value={draft.mode}
                            onChange={(next) => setDraft({ ...draft, mode: next as 'interval' | 'cron' })}
                            data={[
                                { value: 'cron', label: 'Cron' },
                                { value: 'interval', label: 'Interval' },
                            ]}
                        />

                        {draft.mode === 'cron' ? (
                            <Stack gap="xs">
                                <TextInput
                                    label="Cron expression (UTC)"
                                    description="5- or 6-field. UTC, not server-local: the same agent must fire at the same moment on every replica."
                                    placeholder="0 9 * * 1-5"
                                    value={draft.cron ?? ''}
                                    onChange={(event) => setDraft({ ...draft, cron: event.currentTarget.value })}
                                />
                                <Group gap="xs">
                                    {CRON_PRESETS.map((preset) => (
                                        <Button
                                            key={preset.cron}
                                            size="compact-xs"
                                            variant="subtle"
                                            onClick={() => setDraft({ ...draft, cron: preset.cron })}
                                        >
                                            {preset.label}
                                        </Button>
                                    ))}
                                </Group>
                            </Stack>
                        ) : (
                            <NumberInput
                                label="Every N seconds"
                                description="Minimum 60."
                                min={60}
                                step={60}
                                value={draft.intervalSeconds ?? 3600}
                                onChange={(next) =>
                                    setDraft({ ...draft, intervalSeconds: next === '' ? undefined : Number(next) })
                                }
                            />
                        )}

                        <Textarea
                            label="Message"
                            description="What the agent is asked on each fire. Prompt variables apply here too."
                            placeholder="Summarise every incident opened in the last 24 hours and post the digest."
                            value={draft.message}
                            onChange={(event) => setDraft({ ...draft, message: event.currentTarget.value })}
                            autosize
                            minRows={3}
                            maxRows={10}
                            required
                        />

                        <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                            <Text size="xs">
                                Every fire creates its own conversation, so tonight&apos;s run never carries last
                                night&apos;s context. The run reaches the prompt with{' '}
                                <Code>scheduleName</Code> and <Code>trigger</Code> available as variables.
                            </Text>
                        </Alert>

                        <Switch
                            label="Enabled"
                            checked={draft.enabled}
                            onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
                        />

                        <Group justify="flex-end">
                            <Button variant="default" onClick={() => setDraft(null)}>Cancel</Button>
                            <Button
                                onClick={() => void save()}
                                loading={saving}
                                disabled={!draft.name.trim() || !draft.message.trim()}
                            >
                                Save
                            </Button>
                        </Group>
                    </Stack>
                ) : null}
            </Modal>
        </Stack>
    );
}
