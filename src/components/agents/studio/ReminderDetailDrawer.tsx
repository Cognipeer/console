'use client';

/**
 * One reminder, read. The message is the agent's own note to itself, so it is
 * set in a gray box with a caption saying so — it is not something a person
 * asked for.
 */

import { useState } from 'react';
import { Box, Button, Code, Drawer, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { formatUntil, isUpcomingReminder, reminderOwnerText, type AgentReminderView } from './reminderUi';

export interface ReminderDetailDrawerProps {
    reminder: AgentReminderView | null;
    onClose: () => void;
    /** Opens the reminder's session in the session drawer. */
    onOpenSession: (sessionId: string) => void;
    onFireNow: (reminder: AgentReminderView) => Promise<void>;
    onCancel: (reminder: AgentReminderView) => Promise<void>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <Box>
            <Text size="xs" c="dimmed">{label}</Text>
            {children}
        </Box>
    );
}

const time = (epochSeconds: number) => new Date(epochSeconds * 1000).toLocaleString();

export default function ReminderDetailDrawer({ reminder, onClose, onOpenSession, onFireNow, onCancel }: ReminderDetailDrawerProps) {
    const t = useTranslations('agents.reminders');
    const [busy, setBusy] = useState<'fire' | 'cancel' | null>(null);

    const run = async (kind: 'fire' | 'cancel', action: (r: AgentReminderView) => Promise<void>) => {
        if (!reminder) return;
        setBusy(kind);
        try {
            await action(reminder);
        } finally {
            setBusy(null);
        }
    };

    return (
        <Drawer opened={Boolean(reminder)} onClose={onClose} position="right" size={520} title={t('detailTitle')}>
            {reminder ? (
                <Stack gap="md">
                    <Group gap="xl">
                        <Field label={t('status')}>
                            <Text size="sm">{t(`status_${reminder.status}`)}</Text>
                        </Field>
                        <Field label={isUpcomingReminder(reminder) ? t('nextFire') : t('firedAt')}>
                            <Text size="sm">{time(reminder.fire_at)}</Text>
                            {isUpcomingReminder(reminder) ? <Text size="xs" c="dimmed">{formatUntil(reminder.fire_at, t)}</Text> : null}
                        </Field>
                    </Group>

                    <Field label={t('message')}>
                        <Box p="sm" mt={4} style={{ background: 'var(--mantine-color-gray-light)', borderRadius: 'var(--mantine-radius-sm)' }}>
                            {reminder.restricted
                                ? <Text size="sm" c="dimmed" fs="italic">{t('restrictedMessage')}</Text>
                                : <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{reminder.message}</Text>}
                        </Box>
                        <Text size="xs" c="dimmed" mt={4}>{t('messageCaption')}</Text>
                    </Field>

                    {reminder.reason ? (
                        <Field label={t('reason')}>
                            <Text size="sm">{reminder.reason}</Text>
                        </Field>
                    ) : null}

                    <Field label={t('session')}>
                        <UnstyledButton onClick={() => onOpenSession(reminder.session_id)}>
                            <Text size="sm" c="teal" td="underline">{reminder.session_title || reminder.session_id}</Text>
                        </UnstyledButton>
                    </Field>

                    {reminder.owner ? (
                        <Field label={t('owner')}>
                            <Text size="sm">{reminderOwnerText(reminder)}</Text>
                        </Field>
                    ) : null}

                    {reminder.set_by_run ? (
                        <Field label={t('setByRun')}>
                            <UnstyledButton onClick={() => onOpenSession(reminder.session_id)}>
                                <Code>{reminder.set_by_run}</Code>
                            </UnstyledButton>
                        </Field>
                    ) : null}

                    <Group gap="xl">
                        <Field label={t('chain')}>
                            <Text size="sm">{reminder.chain}</Text>
                        </Field>
                        <Field label={t('created')}>
                            <Text size="sm">{time(reminder.created_at)}</Text>
                        </Field>
                        {reminder.completed_at ? (
                            <Field label={t('completed')}>
                                <Text size="sm">{time(reminder.completed_at)}</Text>
                            </Field>
                        ) : null}
                    </Group>

                    {reminder.error ? (
                        <Field label={t('error')}>
                            <Text size="sm" c="red">{reminder.error.message || reminder.error.type}</Text>
                        </Field>
                    ) : null}

                    <Group justify="flex-end" gap="xs" mt="md">
                        {isUpcomingReminder(reminder) ? (
                            <Button variant="default" size="xs" loading={busy === 'fire'} disabled={busy === 'cancel'} onClick={() => void run('fire', onFireNow)}>
                                {t('fireNow')}
                            </Button>
                        ) : null}
                        <Button variant="default" size="xs" onClick={() => onOpenSession(reminder.session_id)}>{t('openSession')}</Button>
                        {isUpcomingReminder(reminder) ? (
                            <Button variant="outline" color="red" size="xs" loading={busy === 'cancel'} disabled={busy === 'fire'} onClick={() => void run('cancel', onCancel)}>
                                {t('cancel')}
                            </Button>
                        ) : null}
                    </Group>
                </Stack>
            ) : null}
        </Drawer>
    );
}
