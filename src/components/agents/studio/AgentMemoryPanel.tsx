'use client';

/**
 * Memory — its own tab. Picks an EXISTING store from console's own Memory
 * module (the same ones listed at `/dashboard/memory`), the same
 * "reference an existing asset by key" relationship `knowledgeEngineKey` has
 * to a Knowledge Engine module. Nothing here stands up a new memory backend —
 * see `agentMemoryAdapter.ts` for how this store is bridged into the SDK's
 * own structured-summarization memory pipeline.
 */

import { ActionIcon, Alert, Anchor, Button, Code, Group, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type {
    AgentMemoryReadPolicy,
    AgentMemoryScope,
    AgentMemoryToolMode,
    AgentMemoryWritePolicy,
    IAgentMemoryConfig,
    IAgentMemoryMount,
} from '@/lib/database/provider/types.domain';

export interface MemoryStoreOption {
    key: string;
    name: string;
    status: string;
}

export interface AgentMemoryPanelProps {
    value: IAgentMemoryConfig | undefined;
    onChange: (next: IAgentMemoryConfig | undefined) => void;
    stores: MemoryStoreOption[];
}

const MAX_MOUNTS = 5;

/** The mounts to edit: explicit ones, else the legacy single key shown as the first row. */
export function editableMounts(value: IAgentMemoryConfig | undefined): IAgentMemoryMount[] {
    if (value?.mounts?.length) return value.mounts;
    if (value?.memoryStoreKey) return [{ storeKey: value.memoryStoreKey, access: 'read_write' }];
    return [];
}

/** Saving mounts migrates the legacy key: it becomes the first mount and is cleared. */
export function withMounts(value: IAgentMemoryConfig | undefined, mounts: IAgentMemoryMount[]): IAgentMemoryConfig {
    return { ...(value ?? {}), memoryStoreKey: undefined, mounts: mounts.length ? mounts : undefined };
}

export default function AgentMemoryPanel({ value, onChange, stores }: AgentMemoryPanelProps) {
    const t = useTranslations('agents.memoryMounts');
    const enabled = value?.enabled ?? false;
    const mounts = editableMounts(value);
    const setMounts = (next: IAgentMemoryMount[]) => onChange(withMounts(value, next));
    const setMount = (i: number, p: Partial<IAgentMemoryMount>) => setMounts(mounts.map((m, idx) => (idx === i ? { ...m, ...p } : m)));
    const patch = (patch: Partial<IAgentMemoryConfig>) => onChange({ ...(value ?? {}), ...patch });
    const tools = value?.tools ?? 'readwrite';

    const activeStores = stores.filter((s) => s.status === 'active');

    return (
        <Stack gap="md">
            <Switch
                label="Remember across runs"
                description="Recall relevant memories before answering, and let the SDK's own summarizer decide what's worth saving as it compacts context."
                checked={enabled}
                onChange={(event) => patch({ enabled: event.currentTarget.checked })}
            />

            {enabled ? (
                <>
                    {stores.length === 0 ? (
                        <Alert variant="light" color="yellow" icon={<IconInfoCircle size={16} />}>
                            <Text size="sm">
                                No memory stores exist yet. Create one from{' '}
                                <Anchor href="/dashboard/memory" target="_blank">the Memory module</Anchor>{' '}
                                first — it needs a vector provider and an embedding model, the same as a
                                Knowledge Engine.
                            </Text>
                        </Alert>
                    ) : (
                        <Stack gap="xs">
                            <div>
                                <Text size="sm" fw={500}>{t('title')}</Text>
                                <Text size="xs" c="dimmed">{t('description')}</Text>
                            </div>
                            {mounts.map((m, i) => (
                                <Stack key={i} gap={6} p="xs" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
                                    <Group align="flex-end" wrap="nowrap">
                                        <Select
                                            style={{ flex: 1 }}
                                            label={t('store')}
                                            placeholder={t('storePlaceholder')}
                                            data={activeStores
                                                .filter((s) => s.key === m.storeKey || !mounts.some((o) => o.storeKey === s.key))
                                                .map((s) => ({ value: s.key, label: s.name }))}
                                            value={m.storeKey || null}
                                            onChange={(next) => setMount(i, { storeKey: next ?? '' })}
                                            searchable
                                        />
                                        <Select
                                            w={150}
                                            label={t('access')}
                                            data={[
                                                { value: 'read_write', label: t('readWrite') },
                                                { value: 'read_only', label: t('readOnly') },
                                            ]}
                                            value={m.access ?? 'read_write'}
                                            onChange={(next) => setMount(i, { access: (next as IAgentMemoryMount['access']) ?? 'read_write' })}
                                            allowDeselect={false}
                                        />
                                        <Select
                                            w={150}
                                            label={t('scope')}
                                            placeholder={t('scopeDefault')}
                                            data={['session', 'user', 'workspace', 'tenant']}
                                            value={m.scope ?? null}
                                            onChange={(next) => setMount(i, { scope: (next as AgentMemoryScope) ?? undefined })}
                                            clearable
                                        />
                                        <ActionIcon variant="subtle" color="red" aria-label={t('remove')} onClick={() => setMounts(mounts.filter((_, idx) => idx !== i))}>
                                            <IconTrash size={16} />
                                        </ActionIcon>
                                    </Group>
                                    <TextInput
                                        label={t('useFor')}
                                        placeholder={t('useForPlaceholder')}
                                        value={m.description ?? ''}
                                        onChange={(event) => setMount(i, { description: event.currentTarget.value || undefined })}
                                    />
                                </Stack>
                            ))}
                            <Group justify="space-between">
                                <Button
                                    size="xs"
                                    variant="light"
                                    leftSection={<IconPlus size={14} />}
                                    disabled={mounts.length >= MAX_MOUNTS}
                                    onClick={() => setMounts([...mounts, { storeKey: '', access: 'read_write' }])}
                                >
                                    {t('add')}
                                </Button>
                                <Text size="xs" c="dimmed">{mounts.length >= MAX_MOUNTS ? t('limit') : mounts.length > 1 ? t('primaryNote') : ''}</Text>
                            </Group>
                        </Stack>
                    )}

                    <Group grow>
                        <Select
                            label="Scope"
                            description="What a fact is remembered against."
                            data={[
                                { value: 'session', label: 'session — this conversation only' },
                                { value: 'user', label: 'user — follows the caller everywhere' },
                                { value: 'workspace', label: 'workspace — shared by this agent' },
                                { value: 'tenant', label: 'tenant — shared by the whole store' },
                            ]}
                            // 'workspace' is what actually runs when nothing is
                            // picked — it is the SDK's default in every runtime
                            // profile. Showing 'session' here said otherwise.
                            value={value?.scope ?? 'workspace'}
                            onChange={(next) => patch({ scope: (next as AgentMemoryScope) ?? undefined })}
                            allowDeselect={false}
                        />
                        <Select
                            label="Write policy"
                            description="When the SDK writes facts on its own, apart from the tools below."
                            data={[
                                // Accurate again now that memory_write exists:
                                // `manual` means no AUTOMATIC writes, so the
                                // tool is the only way in.
                                { value: 'manual', label: 'manual — only via memory_write' },
                                { value: 'auto_important', label: 'auto_important — only stable facts' },
                                { value: 'always', label: 'always — every compaction writes facts' },
                            ]}
                            value={value?.writePolicy ?? 'auto_important'}
                            onChange={(next) => patch({ writePolicy: (next as AgentMemoryWritePolicy) ?? undefined })}
                            allowDeselect={false}
                        />
                        <Select
                            label="Read policy"
                            description="How facts are chosen for the pre-injected recall each turn."
                            data={[
                                { value: 'recent_only', label: 'recent_only — most recently written facts' },
                                { value: 'semantic', label: 'semantic — vector similarity search' },
                                { value: 'hybrid', label: 'hybrid — half recent, half semantic, deduped' },
                            ]}
                            value={value?.readPolicy ?? 'hybrid'}
                            onChange={(next) => patch({ readPolicy: (next as AgentMemoryReadPolicy) ?? undefined })}
                            allowDeselect={false}
                        />
                    </Group>

                    {value?.scope === 'session' ? (
                        <Alert variant="light" color="blue">
                            <Text size="xs">
                                Session scope means memory does not carry over to a NEW session with the same
                                agent — pick &quot;user&quot; if you want the agent to remember someone across
                                separate conversations.
                            </Text>
                        </Alert>
                    ) : null}

                    <Select
                        label="Memory tools"
                        description="Whether the agent can call memory itself, on top of the facts pre-injected each turn."
                        data={[
                            { value: 'readwrite', label: 'search, write and forget' },
                            { value: 'read', label: 'search only — the agent cannot change stored facts' },
                            { value: 'off', label: 'no tools — pre-injected recall only' },
                        ]}
                        value={tools}
                        onChange={(next) => patch({ tools: (next as AgentMemoryToolMode) ?? undefined })}
                        allowDeselect={false}
                    />

                    {/*
                      What the SDK does on its own, verified against its source
                      rather than its docs — and what the console adds on top.
                    */}
                    <Alert variant="light" color="gray">
                        <Text size="xs">
                            The SDK itself gives the agent <strong>no memory tools</strong>: it injects
                            recalled facts ahead of the model call as a system message, and only writes
                            facts back <strong>at compaction</strong>, from the summary it produces. A
                            conversation that never grows past the summarization threshold writes nothing,
                            however much it was told.
                        </Text>
                        {tools !== 'off' ? (
                            <Text size="xs" mt={6}>
                                The tools above close that gap:{' '}
                                <Code>memory_search</Code> lets the agent look something up when the
                                pre-injected slice missed it
                                {tools === 'readwrite' ? (
                                    <>, and <Code>memory_write</Code> / <Code>memory_forget</Code> let it
                                    record a fact the moment it is told, rather than waiting for a
                                    compaction that may never come</>
                                ) : null}
                                . They read and write the same store, so nothing is stored twice.
                            </Text>
                        ) : (
                            <Text size="xs" mt={6}>
                                With tools off, an agent told &quot;remember that I prefer Turkish&quot; will
                                agree and then store nothing unless the conversation later compacts.
                            </Text>
                        )}
                    </Alert>
                </>
            ) : null}
        </Stack>
    );
}
