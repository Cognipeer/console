'use client';

/**
 * "Additional models" of an agent: further models a caller may pick for a run, next to the
 * main one. The list bounds the choice (an administrator narrows it per person with the
 * list); each row carries the label and description a picker shows.
 */

import { useMemo } from 'react';
import { MultiSelect, Stack, Text, TextInput } from '@mantine/core';
import type { IAgentAdditionalModel } from '@/lib/database/provider/types.domain';

export const MAX_ADDITIONAL_MODELS = 10;

export interface AdditionalModelOption {
    key: string;
    name: string;
    modelId?: string;
}

export interface AgentAdditionalModelsProps {
    value: IAgentAdditionalModel[];
    onChange: (next: IAgentAdditionalModel[]) => void;
    models: AdditionalModelOption[];
    /** The main model: it is always usable, so it cannot be added here. */
    mainModelKey: string;
    labels: {
        title: string;
        description: string;
        placeholder: string;
        label: string;
        labelPlaceholder: string;
        descriptionLabel: string;
        descriptionPlaceholder: string;
    };
}

export default function AgentAdditionalModels({ value, onChange, models, mainModelKey, labels }: AgentAdditionalModelsProps) {
    const options = useMemo(
        () => models
            .filter((m) => m.key !== mainModelKey)
            .map((m) => ({ value: m.key, label: m.modelId ? `${m.name} (${m.modelId})` : m.name })),
        [models, mainModelKey],
    );
    const selected = value.map((entry) => entry.modelKey);

    const setSelection = (keys: string[]) => {
        const limited = keys.slice(0, MAX_ADDITIONAL_MODELS);
        // Keep what was typed for the models that stay; a new one starts empty.
        onChange(limited.map((key) => value.find((entry) => entry.modelKey === key) ?? { modelKey: key }));
    };
    const patch = (key: string, change: Partial<IAgentAdditionalModel>) => {
        onChange(value.map((entry) => {
            if (entry.modelKey !== key) return entry;
            const next = { ...entry, ...change };
            if (!next.label) delete next.label;
            if (!next.description) delete next.description;
            return next;
        }));
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
            {value.map((entry) => (
                <Stack key={entry.modelKey} gap={4} data-testid={`agent-additional-model-${entry.modelKey}`}>
                    <Text size="xs" fw={600}>{nameOf(entry.modelKey)}</Text>
                    <TextInput
                        size="xs"
                        aria-label={`${labels.label} ${entry.modelKey}`}
                        placeholder={labels.labelPlaceholder || nameOf(entry.modelKey)}
                        value={entry.label ?? ''}
                        onChange={(event) => patch(entry.modelKey, { label: event.currentTarget.value })}
                        maxLength={80}
                    />
                    <TextInput
                        size="xs"
                        aria-label={`${labels.descriptionLabel} ${entry.modelKey}`}
                        placeholder={labels.descriptionPlaceholder}
                        value={entry.description ?? ''}
                        onChange={(event) => patch(entry.modelKey, { description: event.currentTarget.value })}
                        maxLength={200}
                    />
                </Stack>
            ))}
        </Stack>
    );
}
