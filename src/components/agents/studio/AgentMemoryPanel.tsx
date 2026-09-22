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
                            data={[
                                { value: 'manual', label: 'manual — only via an explicit tool call' },
                                { value: 'auto_important', label: 'auto_important — the SDK decides' },
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
                </>
            ) : null}
        </Stack>
    );
}
