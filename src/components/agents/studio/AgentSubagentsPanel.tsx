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
    Group,
    Menu,
    Modal,
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

import type {
    AgentChildContextPolicy,
    AgentSubagentMode,
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
    disabled?: boolean;
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
    disabled,
}: AgentSubagentsPanelProps) {
    const [editing, setEditing] = useState<{ index: number; draft: IAgentSubagent } | null>(null);

    const refOptions = useMemo(
        () =>
            agents
                .filter((agent) => agent.key !== currentAgentKey)
                .map((agent) => ({
                    value: agent.key,
                    label: agent.publishedVersion ? `${agent.name} (v${agent.publishedVersion})` : `${agent.name} (draft only)`,
                })),
        [agents, currentAgentKey],
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
        onChange(next, next.length === 0 ? undefined : policy);
    };

    const patchPolicy = (patch: Partial<IAgentSubagentPolicy>) => onChange(subagents, { ...(policy ?? {}), ...patch });

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
                    <Text size="sm" fw={600}>Sub-agents</Text>
                    <Text size="xs" c="dimmed">
                        Roles this agent can hand a task to. The orchestrator picks one by name from the
                        header you write, so write the header as &quot;what it does + when to use it&quot;.
                    </Text>
                </Stack>
                <Menu position="bottom-end" disabled={disabled}>
                    <Menu.Target>
                        <Button size="xs" leftSection={<IconPlus size={14} />} rightSection={<IconChevronDown size={12} />} disabled={disabled}>
                            Add sub-agent
                        </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                        <Menu.Item
                            leftSection={<IconUsers size={14} />}
                            onClick={() => setEditing({ index: -1, draft: { ...EMPTY_INLINE } })}
                        >
                            Define inline
                            <Text size="xs" c="dimmed">A role that lives only in this agent</Text>
                        </Menu.Item>
                        <Menu.Item
                            leftSection={<IconLink size={14} />}
                            disabled={refOptions.length === 0}
                            onClick={() => setEditing({ index: -1, draft: { kind: 'ref', name: '', header: '' } })}
                        >
                            Use an existing agent
                            <Text size="xs" c="dimmed">
                                {refOptions.length === 0 ? 'No other agents in this project' : 'Borrow its prompt, model and tools'}
                            </Text>
                        </Menu.Item>
                    </Menu.Dropdown>
                </Menu>
            </Group>

            {subagents.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">
                        No sub-agents. The agent answers everything itself. Add one when a task needs its own
                        prompt, its own tool surface, or its own context budget — a research pass whose 50
                        tool results should not land in the main transcript is the usual case.
                    </Text>
                </Alert>
            ) : (
                <Stack gap="xs">
                    {subagents.map((entry, index) => (
                        <Card key={`${entry.kind}-${entry.name}-${index}`} withBorder padding="sm" radius="md">
                            <Group justify="space-between" wrap="nowrap" align="flex-start">
                                <Stack gap={4} style={{ minWidth: 0 }}>
                                    <Group gap="xs">
                                        <Text size="sm" fw={600} ff="monospace">{entry.name || '(unnamed)'}</Text>
                                        <Badge
                                            size="xs"
                                            variant="light"
                                            color={entry.kind === 'ref' ? 'violet' : 'blue'}
                                            leftSection={entry.kind === 'ref' ? <IconLink size={9} /> : <IconUsers size={9} />}
                                        >
                                            {entry.kind === 'ref' ? entry.agentKey : 'inline'}
                                        </Badge>
                                        {entry.enabled === false ? (
                                            <Badge size="xs" variant="light" color="gray">disabled</Badge>
                                        ) : null}
                                        {entry.modelKey ? (
                                            <Tooltip label="Model override">
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
                                        disabled={disabled}
                                        onClick={() => setEditing({ index, draft: { ...entry } })}
                                    >
                                        <IconPencil size={14} />
                                    </ActionIcon>
                                    <Menu position="bottom-end" disabled={disabled}>
                                        <Menu.Target>
                                            <ActionIcon variant="subtle" size="sm" disabled={disabled}>
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
                                                {entry.enabled === false ? 'Enable' : 'Disable'}
                                            </Menu.Item>
                                            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => remove(index)}>
                                                Remove
                                            </Menu.Item>
                                        </Menu.Dropdown>
                                    </Menu>
                                </Group>
                            </Group>
                        </Card>
                    ))}
                </Stack>
            )}

            {subagents.length > 0 ? (
                <Card withBorder padding="sm" radius="md">
                    <Stack gap="sm">
                        <Text size="sm" fw={600}>Delegation guards</Text>
                        <Group grow>
                            <Select
                                label="Mode"
                                data={[
                                    { value: 'off', label: 'off — no delegation' },
                                    { value: 'registry_only', label: 'registry_only — only the list above' },
                                    { value: 'registry_and_adhoc', label: 'registry_and_adhoc — also ad-hoc roles' },
                                ]}
                                value={policy?.mode ?? 'registry_only'}
                                onChange={(next) => patchPolicy({ mode: (next as AgentSubagentMode) ?? 'registry_only' })}
                                disabled={disabled}
                                allowDeselect={false}
                            />
                            <Select
                                label="Child context"
                                description="How much of the parent's transcript a child starts with."
                                data={[
                                    { value: 'minimal', label: 'minimal — the task only' },
                                    { value: 'scoped', label: 'scoped — task plus relevant history' },
                                    { value: 'full', label: 'full — the whole transcript' },
                                ]}
                                value={policy?.childContextPolicy ?? 'scoped'}
                                onChange={(next) =>
                                    patchPolicy({ childContextPolicy: (next as AgentChildContextPolicy) ?? 'scoped' })
                                }
                                disabled={disabled}
                                allowDeselect={false}
                            />
                        </Group>
                        <Group grow>
                            <NumberInput
                                label="Max depth"
                                placeholder="2"
                                min={1}
                                max={5}
                                value={policy?.maxDepth ?? ''}
                                onChange={(next) => patchPolicy({ maxDepth: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                            <NumberInput
                                label="Max child calls per run"
                                placeholder="8"
                                min={1}
                                value={policy?.maxChildCalls ?? ''}
                                onChange={(next) => patchPolicy({ maxChildCalls: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                            <NumberInput
                                label="Max parallel"
                                placeholder="3"
                                min={1}
                                value={policy?.maxParallel ?? ''}
                                onChange={(next) => patchPolicy({ maxParallel: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                        </Group>
                        <Switch
                            label="Ad-hoc children may use the parent's tools"
                            checked={policy?.allowAdhocTools ?? false}
                            onChange={(event) => patchPolicy({ allowAdhocTools: event.currentTarget.checked })}
                            disabled={disabled || (policy?.mode ?? 'registry_only') !== 'registry_and_adhoc'}
                        />
                    </Stack>
                </Card>
            ) : null}

            <Modal
                opened={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.index === -1 ? 'Add sub-agent' : 'Edit sub-agent'}
                size="lg"
            >
                {draft ? (
                    <Stack gap="md">
                        {draft.kind === 'ref' ? (
                            <Select
                                label="Agent"
                                description="Loaded from its published version at run time, so a draft edit there cannot change this agent mid-run."
                                data={refOptions}
                                value={draft.agentKey ?? null}
                                onChange={(next) => {
                                    const picked = agents.find((a) => a.key === next);
                                    setEditing({
                                        index: editing!.index,
                                        draft: {
                                            ...draft,
                                            agentKey: next ?? undefined,
                                            name: draft.name || slugName(picked?.name ?? next ?? ''),
                                            header: draft.header || `Delegates to the ${picked?.name ?? next} agent.`,
                                        },
                                    });
                                }}
                                searchable
                                required
                            />
                        ) : null}

                        <TextInput
                            label="Name"
                            description="What the orchestrator calls. Lowercase, underscores."
                            placeholder="log_reader"
                            value={draft.name}
                            onChange={(event) =>
                                setEditing({ index: editing!.index, draft: { ...draft, name: event.currentTarget.value } })
                            }
                            error={
                                draft.name && nameTaken(slugName(draft.name), editing!.index)
                                    ? 'Another sub-agent already uses this name'
                                    : null
                            }
                            required
                        />

                        <Textarea
                            label="Header"
                            description="One line: what it does and when to use it. This is the only thing the orchestrator reads when choosing."
                            placeholder="Searches application logs for a time window and returns the matching lines with timestamps."
                            value={draft.header}
                            onChange={(event) =>
                                setEditing({ index: editing!.index, draft: { ...draft, header: event.currentTarget.value } })
                            }
                            autosize
                            minRows={2}
                            required
                        />

                        {draft.kind === 'inline' ? (
                            <>
                                <Textarea
                                    label="System prompt"
                                    description="The child's role. Leave empty to inherit nothing — the header alone is often enough."
                                    value={draft.systemPrompt ?? ''}
                                    onChange={(event) =>
                                        setEditing({
                                            index: editing!.index,
                                            draft: { ...draft, systemPrompt: event.currentTarget.value || undefined },
                                        })
                                    }
                                    autosize
                                    minRows={4}
                                    maxRows={12}
                                />
                                <Select
                                    label="Model override"
                                    description="Falls back to the parent's model. A cheap model here is the usual reason to have a sub-agent at all."
                                    data={modelOptions}
                                    value={draft.modelKey ?? null}
                                    onChange={(next) =>
                                        setEditing({
                                            index: editing!.index,
                                            draft: { ...draft, modelKey: next ?? undefined },
                                        })
                                    }
                                    searchable
                                    clearable
                                />
                            </>
                        ) : (
                            <Alert variant="light" color="violet" icon={<IconInfoCircle size={16} />}>
                                <Text size="xs">
                                    The referenced agent&apos;s prompt, model, tools and knowledge engine are used as-is.
                                    Override the name and header here only — everything else stays owned by that agent.
                                </Text>
                            </Alert>
                        )}

                        <Select
                            label="Child context override"
                            description="Overrides the roster-wide setting for this one sub-agent."
                            data={['minimal', 'scoped', 'full']}
                            value={draft.childContextPolicy ?? null}
                            onChange={(next) =>
                                setEditing({
                                    index: editing!.index,
                                    draft: { ...draft, childContextPolicy: (next as AgentChildContextPolicy) ?? undefined },
                                })
                            }
                            clearable
                        />

                        <Group grow>
                            <NumberInput
                                label="Max tool calls"
                                placeholder="inherit"
                                min={1}
                                value={draft.limits?.maxToolCalls ?? ''}
                                onChange={(next) =>
                                    setEditing({
                                        index: editing!.index,
                                        draft: {
                                            ...draft,
                                            limits: {
                                                ...(draft.limits ?? {}),
                                                maxToolCalls: next === '' ? undefined : Number(next),
                                            },
                                        },
                                    })
                                }
                            />
                            <NumberInput
                                label="Max context tokens"
                                placeholder="inherit"
                                min={1000}
                                step={1000}
                                value={draft.limits?.maxContextTokens ?? ''}
                                onChange={(next) =>
                                    setEditing({
                                        index: editing!.index,
                                        draft: {
                                            ...draft,
                                            limits: {
                                                ...(draft.limits ?? {}),
                                                maxContextTokens: next === '' ? undefined : Number(next),
                                            },
                                        },
                                    })
                                }
                            />
                        </Group>

                        <Group justify="flex-end">
                            <Button variant="default" onClick={() => setEditing(null)}>Cancel</Button>
                            <Button onClick={commitDraft} disabled={draftInvalid}>
                                {editing?.index === -1 ? 'Add' : 'Save'}
                            </Button>
                        </Group>
                    </Stack>
                ) : null}
            </Modal>
        </Stack>
    );
}
