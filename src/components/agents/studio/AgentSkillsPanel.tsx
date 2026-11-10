'use client';

/**
 * Skills an agent can discover and open: picked from the project's skill library (the top-level Skills page), or
 * created here. A skill created here belongs to this agent only (`owner`): it is not in the library, no other agent
 * can use it, it is edited and deleted from this panel, and it goes when the agent is deleted.
 */

import { useMemo, useState } from 'react';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Card,
    Group,
    MultiSelect,
    NumberInput,
    Select,
    Stack,
    Text,
    Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBulb, IconInfoCircle, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useDeleteResource } from '@/components/common/confirm/useDeleteResource';
import { useTranslations } from '@/lib/i18n';
import SkillEditorModal from '@/components/skills/SkillEditorModal';
import type { IAgentSkillPolicy } from '@/lib/database/provider/types.domain';
import type { SkillView } from '@/components/skills/types';

export interface AgentSkillsPanelProps {
    skills: string[];
    policy: IAgentSkillPolicy | undefined;
    library: SkillView[];
    onChange: (skills: string[], policy: IAgentSkillPolicy | undefined) => void;
    /** A skill created or edited from this panel — the page adds it to (or replaces it in) its library copy. */
    onLibraryAdd?: (skill: SkillView) => void;
    /** This agent's own skill was deleted from this panel — the page drops it from its library copy. */
    onLibraryRemove?: (key: string) => void;
    /** The agent being edited: a skill created here belongs to it. Without it, "New skill" adds to the library. */
    agentId?: string;
}

export default function AgentSkillsPanel({
    skills,
    policy,
    library,
    onChange,
    onLibraryAdd,
    onLibraryRemove,
    agentId,
}: AgentSkillsPanelProps) {
    const deleteResource = useDeleteResource();
    const tNouns = useTranslations('common.confirm.nouns');
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<SkillView | null>(null);
    const options = useMemo(
        () => library
            .filter((s) => s.status === 'active' || skills.includes(s.key))
            .map((s) => ({
                value: s.key,
                label: `${s.title}${s.owner ? ' (this agent)' : ''}${s.status === 'inactive' ? ' (inactive)' : ''}`,
            })),
        [library, skills],
    );

    const selected = useMemo(() => library.filter((s) => skills.includes(s.key)), [library, skills]);

    const patchPolicy = (patch: Partial<IAgentSkillPolicy>) => onChange(skills, { ...(policy ?? {}), ...patch });

    /** Deletes one of this agent's own skills, and takes it off the agent. */
    const deleteOwnSkill = async (skill: SkillView) => {
        const deleted = await deleteResource({
            noun: tNouns('skill'),
            name: skill.title,
            extraWarning: 'It belongs to this agent only, so it is also taken off the agent.',
            action: async () => {
                const res = await fetch(`/api/skills/${encodeURIComponent(skill._id)}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('The skill could not be deleted.');
            },
        });
        if (!deleted) return;
        notifications.show({ title: 'Deleted', message: `"${skill.title}" was deleted`, color: 'red' });
        onLibraryRemove?.(skill.key);
        const next = skills.filter((key) => key !== skill.key);
        onChange(next, next.length === 0 ? undefined : policy);
    };

    return (
        <Stack gap="md">
            <Group justify="space-between" align="flex-start">
                <Stack gap={2}>
                    <Text size="sm" fw={600}>Skills</Text>
                    <Text size="xs" c="dimmed">
                        Each skill&apos;s header is always visible to the model; the full instructions are
                        disclosed only once it opens the skill — the model decides what it needs.
                    </Text>
                </Stack>
                <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setCreating(true)}
                >
                    New skill
                </Button>
            </Group>

            {/* Created here: the skill belongs to this agent (not the library) and is attached in one step. */}
            <SkillEditorModal
                opened={creating}
                onClose={() => setCreating(false)}
                skill={null}
                ownerAgentId={agentId}
                onSaved={(created) => {
                    setCreating(false);
                    onLibraryAdd?.(created);
                    if (!skills.includes(created.key)) onChange([...skills, created.key], policy);
                }}
            />
            <SkillEditorModal
                opened={editing !== null}
                onClose={() => setEditing(null)}
                skill={editing}
                onSaved={(saved) => {
                    setEditing(null);
                    onLibraryAdd?.(saved);
                }}
            />

            <MultiSelect
                placeholder={library.length ? 'Select skills…' : 'No skills in the library yet'}
                data={options}
                value={skills}
                onChange={(next) => onChange(next, next.length === 0 ? undefined : policy)}
                searchable
                clearable
            />

            {library.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">
                        No skills exist yet. Create one with <strong>New skill</strong>: it belongs to this agent
                        and is attached to it. Skills for several agents are made on the Skills page.
                    </Text>
                </Alert>
            ) : null}

            {selected.length > 0 ? (
                <Stack gap="xs">
                    {selected.map((skill) => (
                        <Card key={skill.key} withBorder padding="sm" radius="md">
                            <Group gap="xs" mb={4}>
                                <IconBulb size={14} />
                                <Text size="sm" fw={600}>{skill.title}</Text>
                                {skill.status === 'inactive' ? (
                                    <Badge size="xs" color="gray" variant="light">inactive — will not load</Badge>
                                ) : null}
                                {skill.minModelTier ? (
                                    <Badge size="xs" variant="outline">{skill.minModelTier} models only</Badge>
                                ) : null}
                                {skill.owner ? (
                                    <>
                                        <Badge size="xs" variant="light" color="indigo">This agent</Badge>
                                        <Group gap={2} ml="auto">
                                            <Tooltip label="Edit skill" withArrow>
                                                <ActionIcon size="sm" variant="subtle" aria-label="Edit skill" onClick={() => setEditing(skill)}>
                                                    <IconPencil size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                            <Tooltip label="Delete skill" withArrow>
                                                <ActionIcon size="sm" variant="subtle" color="red" aria-label="Delete skill" onClick={() => void deleteOwnSkill(skill)}>
                                                    <IconTrash size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        </Group>
                                    </>
                                ) : null}
                            </Group>
                            <Text size="xs" c="dimmed" lineClamp={2}>{skill.header}</Text>
                        </Card>
                    ))}
                </Stack>
            ) : null}

            {skills.length > 0 ? (
                <Card withBorder padding="sm" radius="md">
                    <Stack gap="sm">
                        <Text size="sm" fw={600}>Discovery &amp; budget</Text>
                        <Select
                            label="Discovery"
                            description="'catalog' lists every header in the system prompt (cheapest per call). 'search' keeps the prompt constant and gives the model a search_skills tool instead — better once the library is large."
                            data={[
                                { value: 'catalog', label: 'catalog — headers in the prompt (default)' },
                                { value: 'search', label: 'search — a search_skills tool' },
                            ]}
                            value={policy?.disclosure ?? 'catalog'}
                            onChange={(next) =>
                                patchPolicy({ disclosure: (next as 'catalog' | 'search') ?? undefined })
                            }
                            allowDeselect={false}
                        />
                        <Group grow>
                            <NumberInput
                                label="Max open at once"
                                placeholder="3"
                                min={1}
                                value={policy?.maxOpenSkills ?? ''}
                                onChange={(next) => patchPolicy({ maxOpenSkills: next === '' ? undefined : Number(next) })}
                            />
                            <NumberInput
                                label="Max tools per skill"
                                placeholder="10"
                                min={1}
                                value={policy?.maxBoundToolsPerSkill ?? ''}
                                onChange={(next) => patchPolicy({ maxBoundToolsPerSkill: next === '' ? undefined : Number(next) })}
                            />
                            <NumberInput
                                label="Max tools total"
                                placeholder="20"
                                min={1}
                                value={policy?.maxBoundToolsTotal ?? ''}
                                onChange={(next) => patchPolicy({ maxBoundToolsTotal: next === '' ? undefined : Number(next) })}
                            />
                        </Group>
                    </Stack>
                </Card>
            ) : null}
        </Stack>
    );
}
