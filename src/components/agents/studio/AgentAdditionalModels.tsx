'use client';

/**
 * "Additional models" of an agent: further models a caller may pick for a run, next to the
 * main one. The list bounds the choice (an administrator narrows it per person with the
 * list); each row is just the model and its reasoning. The name and the "when to choose this
 * model" text a picker shows are set where the picker lives (the portal); a label or description
 * already stored on an entry is kept as is.
 */

import { useMemo } from 'react';
import { Group, MultiSelect, Stack, Text } from '@mantine/core';
import AgentReasoningPicker from './AgentReasoningPicker';
import type { IAgentAdditionalModel } from '@/lib/database/provider/types.domain';

export const MAX_ADDITIONAL_MODELS = 10;

/** One width for every row's reasoning control, so the column lines up. */
const REASONING_COLUMN_WIDTH = 170;

export interface AdditionalModelOption {
    key: string;
    name: string;
    modelId?: string;
    providerKey?: string;
    providerDriver?: string;
    capabilities?: { supportsReasoning?: boolean } | null;
    settings?: Record<string, unknown>;
}

export interface AgentAdditionalModelsProps {
    value: IAgentAdditionalModel[];
    onChange: (next: IAgentAdditionalModel[]) => void;
    models: AdditionalModelOption[];
    /** The main model: it is always usable, so it cannot be added here. */
    mainModelKey: string;
    /** Provider key -> driver; with it each row gets its own reasoning dropdown next to the model. */
    driverByProviderKey?: Record<string, string | undefined>;
    labels: {
        title: string;
        description: string;
        placeholder: string;
        /** Column headers of the rows below the picker. */
        modelColumn: string;
        reasoningColumn: string;
    };
}

export default function AgentAdditionalModels({ value, onChange, models, mainModelKey, driverByProviderKey, labels }: AgentAdditionalModelsProps) {
    const options = useMemo(
        () => models
            .filter((m) => m.key !== mainModelKey)
            .map((m) => ({ value: m.key, label: m.modelId ? `${m.name} (${m.modelId})` : m.name })),
        [models, mainModelKey],
    );
    const selected = value.map((entry) => entry.modelKey);

    const setSelection = (keys: string[]) => {
        const limited = keys.slice(0, MAX_ADDITIONAL_MODELS);
        // Keep the entries of the models that stay (label / description included); a new one starts empty.
        onChange(limited.map((key) => value.find((entry) => entry.modelKey === key) ?? { modelKey: key }));
    };
    const nameOf = (key: string) => models.find((m) => m.key === key)?.name ?? key;

    return (
        <Stack gap="sm">
            <MultiSelect
                label={labels.title}
                description={labels.description}
                placeholder={labels.placeholder}
                data={options}
                value={selected}
                onChange={setSelection}
                searchable
                clearable
                maxValues={MAX_ADDITIONAL_MODELS}
                data-testid="agent-additional-models"
            />
            {value.length > 0 ? (
                <Stack gap="xs">
                    <Group gap="sm" wrap="nowrap" data-testid="agent-additional-models-header">
                        <Text size="xs" c="dimmed" fw={600} style={{ flex: 1, minWidth: 0 }}>{labels.modelColumn}</Text>
                        {driverByProviderKey ? (
                            <Text size="xs" c="dimmed" fw={600} w={REASONING_COLUMN_WIDTH}>{labels.reasoningColumn}</Text>
                        ) : null}
                    </Group>
                    {value.map((entry) => (
                        <Group
                            key={entry.modelKey}
                            gap="sm"
                            wrap="nowrap"
                            align="flex-start"
                            data-testid={`agent-additional-model-${entry.modelKey}`}
                        >
                            <Text size="sm" truncate style={{ flex: 1, minWidth: 0 }} pt={6} title={nameOf(entry.modelKey)}>
                                {nameOf(entry.modelKey)}
                            </Text>
                            {driverByProviderKey ? (
                                <div style={{ width: REASONING_COLUMN_WIDTH, flexShrink: 0 }}>
                                    <AgentReasoningPicker
                                        compact
                                        model={models.find((m) => m.key === entry.modelKey)}
                                        driverByProviderKey={driverByProviderKey}
                                        value={entry}
                                        onChange={(next) => onChange(value.map((row) => {
                                            if (row.modelKey !== entry.modelKey) return row;
                                            const { reasoningEffort: _e, reasoningBudgetTokens: _b, ...rest } = row;
                                            void _e; void _b;
                                            return { ...rest, ...next };
                                        }))}
                                        testId={`agent-additional-reasoning-${entry.modelKey}`}
                                    />
                                </div>
                            ) : null}
                        </Group>
                    ))}
                </Stack>
            ) : null}
        </Stack>
    );
}
