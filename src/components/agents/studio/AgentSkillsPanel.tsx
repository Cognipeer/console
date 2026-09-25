'use client';

/**
 * Skills an agent can discover and open — built from the project's skill
 * library (Settings → the top-level Skills page), not defined inline here.
 * A skill is a reusable asset shared across agents, same relationship an
 * agent has to a Prompt or a Tool.
 */

import { useMemo, useState } from 'react';
import {
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
} from '@mantine/core';
import { IconBulb, IconInfoCircle, IconPlus } from '@tabler/icons-react';
import SkillEditorModal from '@/components/skills/SkillEditorModal';
import type { IAgentSkillPolicy } from '@/lib/database/provider/types.domain';
import type { SkillView } from '@/components/skills/types';

export interface AgentSkillsPanelProps {
    skills: string[];
    policy: IAgentSkillPolicy | undefined;
    library: SkillView[];
    onChange: (skills: string[], policy: IAgentSkillPolicy | undefined) => void;
    /** A skill created from this panel — the page adds it to its library copy. */
    onLibraryAdd?: (skill: SkillView) => void;
    disabled?: boolean;
}

export default function AgentSkillsPanel({ skills, policy, library, onChange, onLibraryAdd, disabled }: AgentSkillsPanelProps) {
    const [creating, setCreating] = useState(false);
    const options = useMemo(
        () => library
            .filter((s) => s.status === 'active' || skills.includes(s.key))
            .map((s) => ({
                value: s.key,
                label: s.status === 'inactive' ? `${s.title} (inactive)` : s.title,
            })),
        [library, skills],
    );

    const selected = useMemo(() => library.filter((s) => skills.includes(s.key)), [library, skills]);

    const patchPolicy = (patch: Partial<IAgentSkillPolicy>) => onChange(skills, { ...(policy ?? {}), ...patch });

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
                    disabled={disabled}
                >
                    New skill
                </Button>
            </Group>

            {/* Created here, saved to the project's skill library (so other agents
                can use it too) and attached to this agent in one step. */}
            <SkillEditorModal
                opened={creating}
                onClose={() => setCreating(false)}
                skill={null}
                onSaved={(created) => {
                    setCreating(false);
                    onLibraryAdd?.(created);
                    if (!skills.includes(created.key)) onChange([...skills, created.key], policy);
                }}
            />

            <MultiSelect
                placeholder={library.length ? 'Select skills…' : 'No skills in the library yet'}
                data={options}
                value={skills}
                onChange={(next) => onChange(next, next.length === 0 ? undefined : policy)}
                searchable
                clearable
                disabled={disabled}
            />

            {library.length === 0 ? (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="sm">
                        No skills exist yet. Create one with <strong>New skill</strong> — it is saved to the
                        project&apos;s skill library and attached to this agent.
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
                            disabled={disabled}
                            allowDeselect={false}
                        />
                        <Group grow>
                            <NumberInput
                                label="Max open at once"
                                placeholder="3"
                                min={1}
                                value={policy?.maxOpenSkills ?? ''}
                                onChange={(next) => patchPolicy({ maxOpenSkills: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                            <NumberInput
                                label="Max tools per skill"
                                placeholder="10"
                                min={1}
                                value={policy?.maxBoundToolsPerSkill ?? ''}
                                onChange={(next) => patchPolicy({ maxBoundToolsPerSkill: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                            <NumberInput
                                label="Max tools total"
                                placeholder="20"
                                min={1}
                                value={policy?.maxBoundToolsTotal ?? ''}
                                onChange={(next) => patchPolicy({ maxBoundToolsTotal: next === '' ? undefined : Number(next) })}
                                disabled={disabled}
                            />
                        </Group>
                    </Stack>
                </Card>
            ) : null}
        </Stack>
    );
}
