'use client';

/**
 * Memory — its own tab. Picks an EXISTING store from console's own Memory
 * module (the same ones listed at `/dashboard/memory`), the same
 * "reference an existing asset by key" relationship `knowledgeEngineKey` has
 * to a Knowledge Engine module. Nothing here stands up a new memory backend —
 * see `agentMemoryAdapter.ts` for how this store is bridged into the SDK's
 * own structured-summarization memory pipeline.
 */

import { Alert, Anchor, Group, Select, Stack, Switch, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type {
    AgentMemoryReadPolicy,
    AgentMemoryScope,
    AgentMemoryWritePolicy,
    IAgentMemoryConfig,
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
    disabled?: boolean;
}

export default function AgentMemoryPanel({ value, onChange, stores, disabled }: AgentMemoryPanelProps) {
    const enabled = value?.enabled ?? false;
    const patch = (patch: Partial<IAgentMemoryConfig>) => onChange({ ...(value ?? {}), ...patch });

    const activeStores = stores.filter((s) => s.status === 'active');

    return (
        <Stack gap="md">
            <Switch
                label="Remember across runs"
                description="Recall relevant memories before answering, and let the SDK's own summarizer decide what's worth saving as it compacts context."
                checked={enabled}
                onChange={(event) => patch({ enabled: event.currentTarget.checked })}
                disabled={disabled}
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
                        <Select
                            label="Memory store"
                            placeholder="Select a store…"
                            data={activeStores.map((s) => ({ value: s.key, label: s.name }))}
                            value={value?.memoryStoreKey ?? null}
                            onChange={(next) => patch({ memoryStoreKey: next ?? undefined })}
                            searchable
                            disabled={disabled}
                        />
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
                            value={value?.scope ?? 'session'}
                            onChange={(next) => patch({ scope: (next as AgentMemoryScope) ?? undefined })}
                            disabled={disabled}
                            allowDeselect={false}
                        />
                        <Select
                            label="Write policy"
                            description="When facts get written back to the store."
                            data={[
                                // Not "via a tool call" — the SDK exposes no memory
                                // tool. `manual` simply means the SDK never writes.
                                { value: 'manual', label: 'manual — the agent never writes' },
                                { value: 'auto_important', label: 'auto_important — only stable facts' },
                                { value: 'always', label: 'always — every compaction writes facts' },
                            ]}
                            value={value?.writePolicy ?? 'auto_important'}
                            onChange={(next) => patch({ writePolicy: (next as AgentMemoryWritePolicy) ?? undefined })}
                            disabled={disabled}
                            allowDeselect={false}
                        />
                        <Select
                            label="Read policy"
                            data={[
                                { value: 'recent_only', label: 'recent_only' },
                                { value: 'semantic', label: 'semantic — vector search' },
                                { value: 'hybrid', label: 'hybrid' },
                            ]}
                            value={value?.readPolicy ?? 'hybrid'}
                            onChange={(next) => patch({ readPolicy: (next as AgentMemoryReadPolicy) ?? undefined })}
                            disabled={disabled}
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

                    {/*
                      Two things operators reliably assume and are wrong about,
                      both verified against the SDK rather than its docs.
                    */}
                    <Alert variant="light" color="gray">
                        <Text size="xs">
                            Memory adds <strong>no tools</strong>. Recalled facts are injected ahead of the
                            model call as a system message, so the agent never decides to look something up —
                            it simply already knows it.
                        </Text>
                        {value?.writePolicy !== 'manual' ? (
                            <Text size="xs" mt={6}>
                                Facts are written <strong>at compaction</strong>, from the summary the SDK
                                produces. A conversation that never grows past the summarization threshold
                                writes nothing, however much it was told — so a short session can read memory
                                without ever adding to it.
                            </Text>
                        ) : null}
                    </Alert>
                </>
            ) : null}
        </Stack>
    );
}
