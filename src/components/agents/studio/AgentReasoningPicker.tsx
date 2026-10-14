'use client';

/**
 * The reasoning dropdown that sits right next to a model in the Build tab:
 * "Model default" first (= the agent sets nothing; the Model Hub default, then
 * the API request, then the provider decide), then the levels the model's
 * driver understands. A Dynamic LLM routes to other models, so it offers every
 * level and the routed model translates. Token-budget engines (Anthropic,
 * Bedrock, Vertex) also get an optional budget field once a level is picked.
 */

import { NumberInput, Select, Stack } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { REASONING_EFFORTS, reasoningControlForDriver, type ReasoningEffort } from '@/lib/services/models/reasoning';

export interface ReasoningPickerModel {
    key: string;
    name: string;
    providerKey?: string;
    /** The provider-side model id: picks the effort list for OpenAI reasoning models on compatible endpoints. */
    modelId?: string;
    /** The driver the model record itself carries; wins over the provider lookup. */
    providerDriver?: string;
    capabilities?: { supportsReasoning?: boolean } | null;
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

/**
 * What the picker offers for a model. The driver comes from the model record
 * first, then from the provider list (which a non-admin may not be able to
 * load). A driver nobody can name still gets the generic effort list, so the
 * dropdown is never silently missing; a driver with no reasoning controls
 * only gets it when the model is flagged as a reasoning model.
 */
export function reasoningPickerOptions(
    model: ReasoningPickerModel | undefined,
    driverByProviderKey: Record<string, string | undefined>,
): ReasoningPickerOptions | undefined {
    if (!model) return undefined;
    const dynamic = Boolean((model.settings as { dynamic?: unknown } | undefined)?.dynamic);
    if (dynamic) return { kind: 'effort', efforts: [...REASONING_EFFORTS], budget: false };
    const driver = model.providerDriver || (model.providerKey ? driverByProviderKey[model.providerKey] : undefined);
    const control = reasoningControlForDriver(driver, model.modelId);
    if (control.kind === 'none') {
        if (!driver || model.capabilities?.supportsReasoning) {
            return { kind: 'effort', efforts: [...REASONING_EFFORTS], budget: false };
        }
        return undefined;
    }
    return { kind: control.kind, efforts: control.efforts, budget: control.budget };
}

export interface AgentReasoningPickerProps {
    model?: ReasoningPickerModel;
    driverByProviderKey: Record<string, string | undefined>;
    value: ReasoningPickerValue;
    onChange: (next: ReasoningPickerValue) => void;
    disabled?: boolean;
    testId?: string;
    /** A row of a list: no visible labels (the list has a column header) and the budget stacks under the level. */
    compact?: boolean;
}

export default function AgentReasoningPicker({ model, driverByProviderKey, value, onChange, disabled, testId, compact }: AgentReasoningPickerProps) {
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
    // A stored level the model's rule does not list (the model changed since) stays visible: the SDK maps it at request time.
    const stored = value.reasoningEffort;
    if (stored && !options.efforts.includes(stored)) {
        data.push({ value: stored, label: options.kind === 'toggle' ? tm(`toggle.${stored}`) : tm(`effort.${stored}`) });
    }

    const controls = (
        <>
            <Select
                size="sm"
                w={170}
                label={compact ? undefined : t('reasoningEffort')}
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
                    label={compact ? undefined : t('reasoningBudget')}
                    description={compact ? undefined : t('reasoningBudgetHint')}
                    aria-label={t('reasoningBudget')}
                    placeholder={compact ? t('reasoningBudget') : undefined}
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

    return compact ? <Stack gap={4} w={170}>{controls}</Stack> : controls;
}
