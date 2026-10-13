'use client';

/**
 * The reasoning dropdown that sits right next to a model in the Build tab:
 * "Model default" first (= the agent sets nothing; the Model Hub default, then
 * the API request, then the provider decide), then the levels the model's
 * driver understands. A Dynamic LLM routes to other models, so it offers every
 * level and the routed model translates. Token-budget engines (Anthropic,
 * Bedrock, Vertex) also get an optional budget field once a level is picked.
 */

import { NumberInput, Select } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { REASONING_EFFORTS, reasoningControlForDriver, type ReasoningEffort } from '@/lib/services/models/reasoning';

export interface ReasoningPickerModel {
    key: string;
    name: string;
    providerKey?: string;
    settings?: Record<string, unknown>;
}

export interface ReasoningPickerValue {
    reasoningEffort?: ReasoningEffort;
    reasoningBudgetTokens?: number;
}

export interface ReasoningPickerOptions {
    kind: 'effort' | 'budget' | 'toggle';
    efforts: ReasoningEffort[];
    budget: boolean;
}

/** What the picker offers for a model; undefined when its provider has no reasoning controls. */
export function reasoningPickerOptions(
    model: ReasoningPickerModel | undefined,
    driverByProviderKey: Record<string, string | undefined>,
): ReasoningPickerOptions | undefined {
    if (!model) return undefined;
    const dynamic = Boolean((model.settings as { dynamic?: unknown } | undefined)?.dynamic);
    if (dynamic) return { kind: 'effort', efforts: [...REASONING_EFFORTS], budget: false };
    const control = reasoningControlForDriver(model.providerKey ? driverByProviderKey[model.providerKey] : undefined);
    if (control.kind === 'none') return undefined;
    return { kind: control.kind, efforts: control.efforts, budget: control.budget };
}

export interface AgentReasoningPickerProps {
    model?: ReasoningPickerModel;
    driverByProviderKey: Record<string, string | undefined>;
    value: ReasoningPickerValue;
    onChange: (next: ReasoningPickerValue) => void;
    disabled?: boolean;
    testId?: string;
}

export default function AgentReasoningPicker({ model, driverByProviderKey, value, onChange, disabled, testId }: AgentReasoningPickerProps) {
    const t = useTranslations('agents.config');
    const tm = useTranslations('modelReasoning');
    const options = reasoningPickerOptions(model, driverByProviderKey);
    if (!options) return null;

    const data = [
        { value: '', label: t('reasoningModelDefault') },
        ...options.efforts.map((effort) => ({
            value: effort,
            label: options.kind === 'toggle' ? tm(`toggle.${effort}`) : tm(`effort.${effort}`),
        })),
    ];

    return (
        <>
            <Select
                size="sm"
                w={190}
                label={t('reasoningEffort')}
                aria-label={t('reasoningPickerAria', { model: model?.name ?? '' })}
                data={data}
                value={value.reasoningEffort ?? ''}
                allowDeselect={false}
                disabled={disabled}
                data-testid={testId}
                onChange={(next) => {
                    const effort = (next || undefined) as ReasoningEffort | undefined;
                    // A budget next to "none" means nothing, and "Model default" owns no budget at all.
                    onChange({
                        ...(effort ? { reasoningEffort: effort } : {}),
                        ...(effort && effort !== 'none' && value.reasoningBudgetTokens
                            ? { reasoningBudgetTokens: value.reasoningBudgetTokens }
                            : {}),
                    });
                }}
            />
            {options.budget && value.reasoningEffort && value.reasoningEffort !== 'none' ? (
                <NumberInput
                    size="sm"
                    w={170}
                    label={t('reasoningBudget')}
                    description={t('reasoningBudgetHint')}
                    min={1}
                    value={value.reasoningBudgetTokens ?? ''}
                    onChange={(next) => onChange({
                        reasoningEffort: value.reasoningEffort,
                        ...(typeof next === 'number' && next > 0 ? { reasoningBudgetTokens: Math.floor(next) } : {}),
                    })}
                    data-testid={testId ? `${testId}-budget` : undefined}
                />
            ) : null}
        </>
    );
}
