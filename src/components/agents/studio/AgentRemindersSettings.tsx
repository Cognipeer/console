'use client';

/**
 * Reminders — the agent may set a one-shot reminder to come back to a session.
 *
 * Off by default and rarely used, so the card is one quiet header row until the
 * switch is turned on. Every number is a ceiling the platform can lower (the
 * "Limit" hint is the environment's value); an empty field means the default.
 */

import { Anchor, Box, Group, NumberInput, Paper, Select, SimpleGrid, Stack, Switch, Text, Textarea } from '@mantine/core';
import type { IAgentRemindersConfig } from '@/lib/database/provider/types.domain';
import {
    REMINDER_DEFAULTS,
    REMINDER_INSTRUCTIONS_MAX_CHARS,
    REMINDER_PLATFORM_DEFAULTS,
} from '@/lib/services/agents/agentRemindersConfig';
import { useTranslations } from '@/lib/i18n';
import { useReminderLimits } from '@/lib/api/queries/agents';
import { patchReminders } from './reminderUi';

export interface AgentRemindersSettingsProps {
    value: IAgentRemindersConfig | undefined;
    onChange: (next: IAgentRemindersConfig | undefined) => void;
    /** Scrolls to another Configure section (the note links to Approvals & questions). */
    onGoToSection?: (section: string) => void;
}

export default function AgentRemindersSettings({ value, onChange, onGoToSection }: AgentRemindersSettingsProps) {
    const t = useTranslations('agents.reminders');
    const th = useTranslations('agents.hitl');
    const enabled = value?.enabled === true;
    // The platform ceilings, for the hints; the defaults stand in until the call answers or when it fails.
    const limits = useReminderLimits(enabled).data ?? REMINDER_PLATFORM_DEFAULTS;
    const set = (patch: Partial<IAgentRemindersConfig>) => onChange(patchReminders(value, patch));

    const number = (
        key: 'minDelaySeconds' | 'maxHorizonHours' | 'maxActivePerSession' | 'maxFiresPerSession',
        label: string,
        limit: number,
        min: number,
    ) => (
        <NumberInput
            label={label}
            description={t('limit', { value: limit })}
            placeholder={String(REMINDER_DEFAULTS[key])}
            min={min}
            allowDecimal={false}
            value={value?.[key] ?? ''}
            onChange={(next) => set({ [key]: typeof next === 'number' ? next : undefined })}
        />
    );

    return (
        <Paper withBorder radius="md" p="md" mt="lg">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Box>
                    <Text size="sm" fw={600}>{t('title')}</Text>
                    <Text size="xs" c="dimmed">{t('description')}</Text>
                </Box>
                <Group gap="xs" wrap="nowrap">
                    <Text size="xs" c="dimmed">{enabled ? t('on') : t('off')}</Text>
                    <Switch
                        aria-label={t('title')}
                        checked={enabled}
                        onChange={(event) => set({ enabled: event.currentTarget.checked })}
                    />
                </Group>
            </Group>

            {enabled ? (
                <Stack gap="md" mt="md">
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        {number('minDelaySeconds', t('minDelaySeconds'), limits.minDelaySeconds, limits.minDelaySeconds)}
                        {number('maxHorizonHours', t('maxHorizonHours'), limits.maxHorizonHours, 1)}
                        {number('maxActivePerSession', t('maxActivePerSession'), limits.maxActivePerSession, 1)}
                        {number('maxFiresPerSession', t('maxFiresPerSession'), limits.maxFiresPerSession, 1)}
                    </SimpleGrid>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                        <Select
                            label={t('runClass')}
                            allowDeselect={false}
                            data={[
                                { value: 'deferred', label: t('runClassDeferred') },
                                { value: 'default', label: t('runClassDefault') },
                            ]}
                            value={value?.runClass ?? REMINDER_DEFAULTS.runClass}
                            onChange={(next) => set({ runClass: next === 'default' ? 'default' : 'deferred' })}
                        />
                        <Select
                            label={t('whenBusy')}
                            allowDeselect={false}
                            data={[
                                { value: 'postpone', label: t('whenBusyPostpone') },
                                { value: 'skip', label: t('whenBusySkip') },
                            ]}
                            value={value?.whenBusy ?? REMINDER_DEFAULTS.whenBusy}
                            onChange={(next) => set({ whenBusy: next === 'skip' ? 'skip' : 'postpone' })}
                        />
                    </SimpleGrid>
                    <Select
                        label={t('afterUntrusted')}
                        description={t('afterUntrustedHelp')}
                        allowDeselect={false}
                        data={[
                            { value: 'approve', label: t('afterUntrustedApprove') },
                            { value: 'deny', label: t('afterUntrustedDeny') },
                            { value: 'allow', label: t('afterUntrustedAllow') },
                        ]}
                        value={value?.afterUntrustedContent ?? REMINDER_DEFAULTS.afterUntrustedContent}
                        onChange={(next) => set({ afterUntrustedContent: next === 'deny' || next === 'allow' ? next : 'approve' })}
                    />
                    <Text size="xs" c="dimmed">
                        {t('unattendedNote')}{' '}
                        <Anchor component="button" type="button" size="xs" onClick={() => onGoToSection?.('hitl')}>
                            {th('sectionTitle')}
                        </Anchor>
                    </Text>
                    <Textarea
                        label={t('instructions')}
                        description={t('instructionsHint')}
                        autosize
                        minRows={2}
                        maxRows={8}
                        maxLength={REMINDER_INSTRUCTIONS_MAX_CHARS}
                        value={value?.instructions ?? ''}
                        onChange={(event) => set({ instructions: event.currentTarget.value })}
                    />
                </Stack>
            ) : null}
        </Paper>
    );
}
