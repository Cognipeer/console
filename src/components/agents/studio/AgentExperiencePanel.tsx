'use client';

/**
 * Experience — what a chat surface shows around the agent.
 *
 * The welcome text (Markdown, with a few variables) and the suggested first
 * messages ("starters") that a portal or an embedded widget shows on an empty
 * conversation. Both are optional and stored on the agent's config; a portal may
 * override them for itself. Nothing here changes how the agent answers.
 */

import {
    ActionIcon,
    Badge,
    Button,
    Group,
    Paper,
    Stack,
    Switch,
    Text,
    TextInput,
    Textarea,
    Tooltip,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import type { IAgentExperienceConfig } from '@/lib/database/provider/types.domain';
import { useTranslations } from '@/lib/i18n';
import { ConfigBlock } from './ConfigSection';
import {
    AGENT_STARTERS_MAX,
    AGENT_STARTER_LABEL_MAX,
    AGENT_STARTER_TEXT_MAX,
    AGENT_WELCOME_MAX,
    WELCOME_VARIABLES,
    addStarter,
    experienceSaveErrors,
    moveStarter,
    patchExperience,
    removeStarter,
    updateStarter,
} from './experienceSettings';

export interface AgentExperiencePanelProps {
    value: IAgentExperienceConfig | undefined;
    onChange: (next: IAgentExperienceConfig | undefined) => void;
    /** Show the problems a refused save found. */
    showErrors?: boolean;
}

export default function AgentExperiencePanel({ value, onChange, showErrors = false }: AgentExperiencePanelProps) {
    const t = useTranslations('agents.experience');
    const starters = value?.starters ?? [];
    const issues = experienceSaveErrors(value);
    const issueFor = (field: string) => (showErrors ? issues.find((issue) => issue.field === field) : undefined);
    const messageFor = (code: NonNullable<ReturnType<typeof issueFor>>['code']) => (
        code === 'starter_text_required' ? t('starterTextRequired')
            : code === 'starter_text_too_long' ? t('starterTextTooLong', { max: AGENT_STARTER_TEXT_MAX })
                : code === 'starter_label_too_long' ? t('starterLabelTooLong', { max: AGENT_STARTER_LABEL_MAX })
                    : t('welcomeTooLong', { max: AGENT_WELCOME_MAX })
    );

    return (
        <Stack gap="lg">
            <ConfigBlock title={t('welcomeTitle')}>
                <Stack gap={6}>
                    <Textarea
                        aria-label={t('welcomeTitle')}
                        placeholder={t('welcomePlaceholder')}
                        value={value?.welcome ?? ''}
                        onChange={(event) => onChange(patchExperience(value, { welcome: event.currentTarget.value }))}
                        autosize
                        minRows={3}
                        maxRows={10}
                        error={(() => {
                            const issue = issueFor('experience.welcome');
                            return issue ? messageFor(issue.code) : undefined;
                        })()}
                        description={t('welcomeDescription')}
                    />
                    <Group gap={6} wrap="wrap">
                        <Text size="xs" c="dimmed">{t('variables')}</Text>
                        {WELCOME_VARIABLES.map((variable) => (
                            <Badge key={variable} size="sm" variant="light" color="gray" ff="monospace" tt="none">{variable}</Badge>
                        ))}
                    </Group>
                    <Text size="xs" c="dimmed">{(value?.welcome ?? '').length} / {AGENT_WELCOME_MAX}</Text>
                </Stack>
            </ConfigBlock>

            <ConfigBlock title={t('startersTitle')}>
                <Stack gap="sm">
                    <Text size="sm" c="dimmed">{t('startersDescription', { max: AGENT_STARTERS_MAX })}</Text>
                    {starters.length === 0 ? (
                        <Text size="sm" c="dimmed">{t('startersEmpty')}</Text>
                    ) : (
                        starters.map((starter, index) => {
                            const textIssue = issueFor(`experience.starters.${index}.text`);
                            const labelIssue = issueFor(`experience.starters.${index}.label`);
                            return (
                                <Paper key={index} withBorder radius="md" p="sm">
                                    <Stack gap="xs">
                                        <Group align="flex-start" wrap="nowrap" gap="xs">
                                            <Textarea
                                                style={{ flex: 1 }}
                                                aria-label={t('starterText')}
                                                label={t('starterText')}
                                                placeholder={t('starterTextPlaceholder')}
                                                value={starter.text}
                                                onChange={(event) => onChange(updateStarter(value, index, { text: event.currentTarget.value }))}
                                                autosize
                                                minRows={1}
                                                maxRows={4}
                                                error={textIssue ? messageFor(textIssue.code) : undefined}
                                            />
                                            <Group gap={2} wrap="nowrap" mt={24}>
                                                <Tooltip label={t('moveUp')} withArrow>
                                                    <ActionIcon
                                                        variant="subtle"
                                                        color="gray"
                                                        aria-label={t('moveUp')}
                                                        disabled={index === 0}
                                                        onClick={() => onChange(moveStarter(value, index, index - 1))}
                                                    >
                                                        <IconArrowUp size={16} />
                                                    </ActionIcon>
                                                </Tooltip>
                                                <Tooltip label={t('moveDown')} withArrow>
                                                    <ActionIcon
                                                        variant="subtle"
                                                        color="gray"
                                                        aria-label={t('moveDown')}
                                                        disabled={index === starters.length - 1}
                                                        onClick={() => onChange(moveStarter(value, index, index + 1))}
                                                    >
                                                        <IconArrowDown size={16} />
                                                    </ActionIcon>
                                                </Tooltip>
                                                <Tooltip label={t('removeStarter')} withArrow>
                                                    <ActionIcon
                                                        variant="subtle"
                                                        color="red"
                                                        aria-label={t('removeStarter')}
                                                        onClick={() => onChange(removeStarter(value, index))}
                                                    >
                                                        <IconTrash size={16} />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Group>
                                        </Group>
                                        <Group align="flex-end" gap="md" wrap="wrap">
                                            <TextInput
                                                style={{ flex: 1, minWidth: 180 }}
                                                label={t('starterLabel')}
                                                description={t('starterLabelDescription')}
                                                value={starter.label ?? ''}
                                                onChange={(event) => onChange(updateStarter(value, index, { label: event.currentTarget.value }))}
                                                error={labelIssue ? messageFor(labelIssue.code) : undefined}
                                            />
                                            <Switch
                                                label={t('autoSend')}
                                                description={t('autoSendDescription')}
                                                checked={starter.autoSend === true}
                                                onChange={(event) => onChange(updateStarter(value, index, { autoSend: event.currentTarget.checked }))}
                                            />
                                        </Group>
                                    </Stack>
                                </Paper>
                            );
                        })
                    )}
                    <Group>
                        <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconPlus size={14} />}
                            disabled={starters.length >= AGENT_STARTERS_MAX}
                            onClick={() => onChange(addStarter(value))}
                        >
                            {t('addStarter')}
                        </Button>
                        {starters.length >= AGENT_STARTERS_MAX ? (
                            <Text size="xs" c="dimmed">{t('startersLimit', { max: AGENT_STARTERS_MAX })}</Text>
                        ) : null}
                    </Group>
                    {starters.some((starter) => starter.text.trim()) ? (
                        <Stack gap={4}>
                            <Text size="xs" c="dimmed">{t('preview')}</Text>
                            <Group gap="xs" wrap="wrap">
                                {starters.filter((starter) => starter.text.trim()).map((starter, index) => (
                                    <Badge key={index} size="lg" variant="outline" color="gray" tt="none" fw={500}>
                                        {starter.label?.trim() || starter.text.trim()}
                                    </Badge>
                                ))}
                            </Group>
                        </Stack>
                    ) : null}
                </Stack>
            </ConfigBlock>
            <Text size="xs" c="dimmed">{t('publishNote')}</Text>
        </Stack>
    );
}
