'use client';

/**
 * Sub-agents: the agent's own delegation roster.
 *
 * Two kinds, deliberately not unified. An `inline` sub-agent is a role that only
 * makes sense inside this agent — it has no life of its own and no version. A
 * `ref` sub-agent is another console agent, owned and versioned by whoever owns
 * that agent; this panel only borrows it. Collapsing the two would mean either
 * creating a top-level agent for every helper role, or silently forking a shared
 * agent the moment someone edited it here.
 */

import { useMemo, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Card,
    Checkbox,
    Group,
    Menu,
    NumberInput,
    Select,
    Stack,
    Switch,
    Text,
    Textarea,
    TextInput,
    Tooltip,
} from '@mantine/core';
import {
    IconChevronDown,
    IconDots,
    IconInfoCircle,
    IconLink,
    IconPencil,
    IconPlus,
    IconTrash,
    IconUsers,
} from '@tabler/icons-react';

import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { SUBAGENT_POLICY_LIMITS } from '@/lib/services/agents/subagentConfigRules';
import type {
    AgentChildContextPolicy,
    AgentSubagentMode,
    IAgentLimits,
    IAgentSubagent,
    IAgentSubagentPolicy,
} from '@/lib/database/provider/types.domain';

export interface AgentOption {
    key: string;
    name: string;
    publishedVersion?: number | null;
}

export interface ModelOption {
    key: string;
    name: string;
}

export interface AgentSubagentsPanelProps {
    subagents: IAgentSubagent[];
    policy: IAgentSubagentPolicy | undefined;
    onChange: (subagents: IAgentSubagent[], policy: IAgentSubagentPolicy | undefined) => void;
    /** Other agents in the project, offered as `ref` targets. */
    agents: AgentOption[];
    models: ModelOption[];
    /** Excluded from the `ref` picker — an agent cannot delegate to itself. */
    currentAgentKey?: string;
}

const EMPTY_INLINE: IAgentSubagent = { kind: 'inline', name: '', header: '' };

function slugName(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 48);
}

export default function AgentSubagentsPanel({
    subagents,
    policy,
    onChange,
    agents,
    models,
    currentAgentKey,
}: AgentSubagentsPanelProps) {
    const t = useTranslations('agents.subagents');
    const [editing, setEditing] = useState<{ index: number; draft: IAgentSubagent } | null>(null);

    const refOptions = useMemo(
        () =>
            agents
                .filter((agent) => agent.key !== currentAgentKey)
                .map((agent) => ({
                    value: agent.key,
                    label: agent.publishedVersion
                        ? t('agentVersioned', { name: agent.name, version: agent.publishedVersion })
                        : t('agentDraftOnly', { name: agent.name }),
                })),
        [agents, currentAgentKey, t],
    );

    const modelOptions = useMemo(
        () => models.map((model) => ({ value: model.key, label: model.name })),
        [models],
    );

    const nameTaken = (name: string, index: number) =>
        subagents.some((entry, i) => i !== index && entry.name === name);

    const commitDraft = () => {
        if (!editing) return;
        const draft = { ...editing.draft, name: slugName(editing.draft.name) };
        const next = [...subagents];
        if (editing.index < 0) next.push(draft);
        else next[editing.index] = draft;
        onChange(next, policy);
        setEditing(null);
    };

    const remove = (index: number) => {
        const next = subagents.filter((_, i) => i !== index);
        onChange(next, policy);
    };

    // No policy and no roster means delegation was never configured: off.
    const mode: AgentSubagentMode = policy?.mode ?? (subagents.length > 0 ? 'registry_only' : 'off');
    const enabled = mode !== 'off';
    const adhoc = mode === 'registry_and_adhoc';

    const patchPolicy = (patch: Partial<IAgentSubagentPolicy>) => onChange(subagents, { ...(policy ?? {}), ...patch });
    const patchDraft = (patch: Partial<IAgentSubagent>) =>
        editing && setEditing({ index: editing.index, draft: { ...editing.draft, ...patch } });
    const patchDraftLimits = (patch: Partial<IAgentLimits>) =>
        patchDraft({ limits: { ...(editing?.draft.limits ?? {}), ...patch } });

    const draft = editing?.draft;
    const draftInvalid =
        !draft ||
        !draft.name.trim() ||
        !draft.header.trim() ||
        (draft.kind === 'ref' && !draft.agentKey) ||
        nameTaken(slugName(draft.name), editing.index);

    return (
        <Stack gap="md">
            <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                    <Text size="sm" fw={600}>{t('title')}</Text>
                    <Text size="xs" c="dimmed">{t('intro')}</Text>
                </Stack>
                <Menu position="bottom-end">
                    <Menu.Target>
                        <Button
                            size="xs"
                            disabled={!enabled}
                            leftSection={<IconPlus size={14} />}
                            rightSection={<IconChevronDown size={12} />}
                        >
                            {t('addButton')}
                        </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item
                            leftSection={<IconUsers size={14} />}
                            onClick={() => setEditing({ index: -1, draft: { ...EMPTY_INLINE } })}
                        >
                            {t('defineInline')}
                            <Text size="xs" c="dimmed">{t('defineInlineHint')}</Text>
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconLink size={14} />}
                            disabled={refOptions.length === 0}
                            onClick={() => setEditing({ index: -1, draft: { kind: 'ref', name: '', header: '' } })}
                        >
                            {t('useExisting')}
                            <Text size="xs" c="dimmed">
                                {refOptions.length === 0 ? t('noOtherAgents') : t('useExistingHint')}
                            </Text>
                        </Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </Group>

            <Card withBorder padding="sm" radius="md">
                <Stack gap="xs">
                    <Switch
                        label={t('enableLabel')}
                        description={t('enableDescription')}
                        checked={enabled}
                        onChange={(event) =>
                            patchPolicy({
                                mode: event.currentTarget.checked
                                    ? adhoc
                                        ? 'registry_and_adhoc'
                                        : 'registry_only'
                                    : 'off',
                            })
                        }
                    />
                    <Checkbox
                        label={t('adhocLabel')}
                        description={t('adhocDescription')}
                        checked={adhoc}
                        disabled={!enabled}
                        onChange={(event) =>
                            patchPolicy({ mode: event.currentTarget.checked ? 'registry_and_adhoc' : 'registry_only' })
                        }
                    />
                </Stack>
            </Card>

            {subagents.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">{adhoc ? t('emptyAdhoc') : t('emptyNone')}</Text>
                </Alert>
            ) : (
                <Stack gap="xs">
                    {subagents.map((entry, index) => (
                        <Card key={`${entry.kind}-${entry.name}-${index}`} withBorder padding="sm" radius="md">
                            <Group justify="space-between" wrap="nowrap" align="flex-start">
                                <Stack gap={4} style={{ minWidth: 0 }}>
                                    <Group gap="xs">
                                        <Text size="sm" fw={600} ff="monospace">{entry.name || t('unnamed')}</Text>
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color={entry.kind === 'ref' ? 'violet' : 'blue'}
                                            leftSection={entry.kind === 'ref' ? <IconLink size={9} /> : <IconUsers size={9} />}
                                        >
                                            {entry.kind === 'ref' ? entry.agentKey : t('inlineBadge')}
                                        </Badge>
                                        {entry.enabled === false ? (
                                            <Badge size="xs" variant="light" color="gray">{t('disabledBadge')}</Badge>
                                        ) : null}
                                        {entry.modelKey ? (
                                            <Tooltip label={t('modelOverrideTip')}>
                                                <Badge size="xs" variant="outline" color="gray">{entry.modelKey}</Badge>
                                            </Tooltip>
                                        ) : null}
                                    </Group>
                                    <Text size="xs" c="dimmed" lineClamp={2}>{entry.header}</Text>
                                </Stack>
                                <Group gap={4} wrap="nowrap">
                                    <ActionIcon
                                        variant="subtle"
                                        size="sm"
                                        onClick={() => setEditing({ index, draft: { ...entry } })}
                                    >
                                        <IconPencil size={14} />
                                    </ActionIcon>
                                    <Menu position="bottom-end">
                                        <Menu.Target>
                                            <ActionIcon variant="subtle" size="sm">
                                                <IconDots size={14} />
                                            </ActionIcon>
                                        </Menu.Target>
                                        <Menu.Dropdown>
                                            <Menu.Item
                                                onClick={() => {
                                                    const next = [...subagents];
                                                    next[index] = { ...entry, enabled: entry.enabled === false };
                                                    onChange(next, policy);
                                                }}
                                            >
                                                {entry.enabled === false ? t('enable') : t('disable')}
                                            </Menu.Item>
                                            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => remove(index)}>
                                                {t('remove')}
                                            </Menu.Item>
                                        </Menu.Dropdown>
                                    </Menu>
                                </Group>
                            </Group>
                        </Card>
                    ))}
                </Stack>
            )}

            {enabled ? (
                <Card withBorder padding="sm" radius="md">
                    <Stack gap="sm">
                        <Text size="sm" fw={600}>{t('guardsTitle')}</Text>
                        <Group grow>
                            <Select
                                label={t('childContextLabel')}
                                description={t('childContextDescription')}
                                data={[
                                    { value: 'minimal', label: t('contextMinimal') },
                                    { value: 'scoped', label: t('contextScoped') },
                                    { value: 'full', label: t('contextFull') },
                                ]}
                                value={policy?.childContextPolicy ?? 'scoped'}
                                onChange={(next) =>
                                    patchPolicy({ childContextPolicy: (next as AgentChildContextPolicy) ?? 'scoped' })
                                }
                                allowDeselect={false}
                            />
                        </Group>
                        <Group grow>
                            <NumberInput
                                label={t('maxDepth')}
                                description={t('maxDepthDescription')}
                                placeholder="2"
                                min={SUBAGENT_POLICY_LIMITS.maxDepth.min}
                                max={SUBAGENT_POLICY_LIMITS.maxDepth.max}
                                allowDecimal={false}
                                value={policy?.maxDepth ?? ''}
                                onChange={(next) => patchPolicy({ maxDepth: next === '' ? undefined : Number(next) })}
                            />
                            <NumberInput
                                label={t('maxChildCalls')}
                                description={t('maxChildCallsDescription')}
                                placeholder="8"
                                min={SUBAGENT_POLICY_LIMITS.maxChildCalls.min}
                                max={SUBAGENT_POLICY_LIMITS.maxChildCalls.max}
                                allowDecimal={false}
                                value={policy?.maxChildCalls ?? ''}
                                onChange={(next) => patchPolicy({ maxChildCalls: next === '' ? undefined : Number(next) })}
                            />
                            <NumberInput
                                label={t('maxParallel')}
                                description={t('maxParallelDescription')}
                                placeholder="4"
                                min={SUBAGENT_POLICY_LIMITS.maxParallel.min}
                                max={SUBAGENT_POLICY_LIMITS.maxParallel.max}
                                allowDecimal={false}
                                value={policy?.maxParallel ?? ''}
                                onChange={(next) => patchPolicy({ maxParallel: next === '' ? undefined : Number(next) })}
                            />
                        </Group>
                        <Switch
                            label={t('adhocToolsLabel')}
                            checked={policy?.allowAdhocTools ?? false}
                            onChange={(event) => patchPolicy({ allowAdhocTools: event.currentTarget.checked })}
                            disabled={!adhoc}
                        />
                        <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} p="sm">
                            <Text size="xs">{t('approvalsNote')}</Text>
                        </Alert>
                    </Stack>
                </Card>
            ) : null}

            {draft ? (
                <FormShell
                    open
                    onClose={() => setEditing(null)}
                    icon={<IconUsers size={16} />}
                    title={editing?.index === -1 ? t('modalAdd') : t('modalEdit')}
                    primaryAction={{
                        label: editing?.index === -1 ? t('add') : t('save'),
                        color: 'teal',
                        disabled: draftInvalid,
                        onClick: commitDraft,
                    }}
                    secondaryAction={{ label: t('cancel'), onClick: () => setEditing(null) }}
                >
                    <FormSection number={1} title={t('sectionBasics')}>
                        <Stack gap="md">
                        {draft.kind === 'ref' ? (
                            <Select
                                label={t('agentLabel')}
                                description={t('agentDescription')}
                                data={refOptions}
                                value={draft.agentKey ?? null}
                                onChange={(next) => {
                                    const picked = agents.find((a) => a.key === next);
                                    patchDraft({
                                        agentKey: next ?? undefined,
                                        name: draft.name || slugName(picked?.name ?? next ?? ''),
                                        header: draft.header || t('defaultHeader', { name: picked?.name ?? next ?? '' }),
                                    });
                                }}
                                searchable
                                required
                            />
                        ) : null}

                        <TextInput
                            label={t('nameLabel')}
                            description={t('nameDescription')}
                            placeholder={t('namePlaceholder')}
                            value={draft.name}
                            onChange={(event) => patchDraft({ name: event.currentTarget.value })}
                            error={
                                draft.name && nameTaken(slugName(draft.name), editing!.index)
                                    ? t('nameTaken')
                                    : null
                            }
                            required
                        />

                        <Textarea
                            label={t('headerLabel')}
                            description={t('headerDescription')}
                            placeholder={t('headerPlaceholder')}
                            value={draft.header}
                            onChange={(event) => patchDraft({ header: event.currentTarget.value })}
                            autosize
                            minRows={2}
                            required
                        />

                        </Stack>
                    </FormSection>

                    <FormSection number={2} title={t('sectionBehaviour')}>
                        <Stack gap="md">
                        <Textarea
                            label={draft.kind === 'ref' ? t('promptRefLabel') : t('promptLabel')}
                            description={draft.kind === 'ref' ? t('promptRefDescription') : t('promptInlineDescription')}
                            value={draft.systemPrompt ?? ''}
                            onChange={(event) => patchDraft({ systemPrompt: event.currentTarget.value || undefined })}
                            autosize
                            minRows={draft.kind === 'ref' ? 2 : 4}
                            maxRows={12}
                        />
                        <Select
                            label={t('modelLabel')}
                            description={draft.kind === 'ref' ? t('modelRefDescription') : t('modelInlineDescription')}
                            data={modelOptions}
                            value={draft.modelKey ?? null}
                            onChange={(next) => patchDraft({ modelKey: next ?? undefined })}
                            searchable
                            clearable
                        />
                        {draft.kind === 'ref' ? (
                            <Alert variant="light" color="violet" icon={<IconInfoCircle size={16} />}>
                                <Text size="xs">{t('refNote')}</Text>
                            </Alert>
                        ) : null}

                        </Stack>
                    </FormSection>

                    <FormSection number={3} title={t('sectionLimits')}>
                        <Stack gap="md">
                        <Select
                            label={t('contextOverrideLabel')}
                            description={t('contextOverrideDescription')}
                            data={['minimal', 'scoped', 'full']}
                            value={draft.childContextPolicy ?? null}
                            onChange={(next) => patchDraft({ childContextPolicy: (next as AgentChildContextPolicy) ?? undefined })}
                            clearable
                        />

                        <Group grow>
                            <NumberInput
                                label={t('maxToolCalls')}
                                placeholder={t('inheritPlaceholder')}
                                min={1}
                                max={500}
                                allowDecimal={false}
                                value={draft.limits?.maxToolCalls ?? ''}
                                onChange={(next) => patchDraftLimits({ maxToolCalls: next === '' ? undefined : Number(next) })}
                            />
                            <NumberInput
                                label={t('maxContextTokens')}
                                placeholder={t('inheritPlaceholder')}
                                min={1000}
                                step={1000}
                                allowDecimal={false}
                                value={draft.limits?.maxContextTokens ?? ''}
                                onChange={(next) => patchDraftLimits({ maxContextTokens: next === '' ? undefined : Number(next) })}
                            />
                        </Group>
                        </Stack>
                    </FormSection>
                </FormShell>
            ) : null}
        </Stack>
    );
}
