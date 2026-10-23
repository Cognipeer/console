'use client';

/**
 * The Reminders tab of the session inspector: what the agent has set for
 * itself in this session. Scheduled ones can be fired now or canceled; the
 * finished ones say how they ended and which run they started.
 */

import { Box, Button, Code, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useTranslations } from '@/lib/i18n';
import { cancelReminder, fireReminderNow } from '../studio/reminderActions';
import { formatUntil, isUpcomingReminder, type AgentReminderView } from '../studio/reminderUi';

export interface SessionRemindersPanelProps {
    agentId: string;
    reminders: AgentReminderView[] | null;
    /** The list changed (fired or canceled) — read it again. */
    onChanged: () => void;
    /** Read-only viewers can see reminders but not act on them. */
    readOnly?: boolean;
}

export default function SessionRemindersPanel({ agentId, reminders, onChanged, readOnly }: SessionRemindersPanelProps) {
    const t = useTranslations('agents.reminders');
    const active = (reminders ?? []).filter(isUpcomingReminder);
    const past = (reminders ?? []).filter((reminder) => !isUpcomingReminder(reminder));

    const act = async (kind: 'fire' | 'cancel', reminder: AgentReminderView) => {
        const ok = kind === 'fire'
            ? await fireReminderNow(agentId, reminder.id, t('fireFailed'))
            : await cancelReminder(agentId, reminder.id, t('cancelFailed'));
        if (ok) {
            notifications.show({ color: 'teal', message: kind === 'fire' ? t('fired') : t('canceled') });
            onChanged();
        }
    };

    if (reminders === null) return <Text size="xs" c="dimmed">{t('loading')}</Text>;
    if (reminders.length === 0) return <Text size="xs" c="dimmed">{t('sessionEmpty')}</Text>;

    return (
        <Stack gap="md">
            {active.length > 0 ? (
                <Stack gap="xs">
                    <Text size="xs" fw={600}>{t('activeHeading')}</Text>
                    {active.map((reminder) => (
                        <Box key={reminder.id}>
                            <Text size="xs" c="dimmed">
                                {new Date(reminder.fire_at * 1000).toLocaleString()} · {formatUntil(reminder.fire_at, t)}
                            </Text>
                            <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reminder.message}</Text>
                            {readOnly ? null : (
                                <Group gap={4} mt={2}>
                                    <Button size="compact-xs" variant="default" onClick={() => void act('fire', reminder)}>{t('fireNow')}</Button>
                                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => void act('cancel', reminder)}>{t('cancel')}</Button>
                                </Group>
                            )}
                        </Box>
                    ))}
                </Stack>
            ) : null}
            {past.length > 0 ? (
                <Stack gap="xs">
                    <Text size="xs" fw={600}>{t('pastHeading')}</Text>
                    {past.map((reminder) => (
                        <Box key={reminder.id}>
                            <Text size="xs" c="dimmed">
                                {new Date(reminder.fire_at * 1000).toLocaleString()} · {t(`status_${reminder.status}`)}
                            </Text>
                            <Text size="sm" c="dimmed" lineClamp={2}>{reminder.message}</Text>
                            <Code style={{ fontSize: 11 }}>{reminder.id}</Code>
                        </Box>
                    ))}
                </Stack>
            ) : null}
        </Stack>
    );
}
