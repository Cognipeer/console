'use client';

/**
 * "What can this model be sent?" — one box per input type, starting from what
 * the model id is known to accept. Ticking a box stores an explicit choice;
 * "Detect automatically" takes it back so the detection applies again.
 * Shared by the create and edit forms.
 */

import { Badge, Button, Checkbox, Group, Stack, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { ModelInputModality } from '@/lib/services/models/modelCapabilities';
import {
    INPUT_MODALITY_OPTIONS,
    shownInputModalities,
    toggleInputModality,
} from './inputModalities';

export interface ModelInputModalitiesFieldProps {
    /** The explicit choice; null = nothing set, the detected types apply. */
    value: ModelInputModality[] | null;
    /** What the model id is known to accept. */
    inferred: ModelInputModality[];
    onChange: (next: ModelInputModality[] | null) => void;
    /** Types the provider can take at all; the others are shown but cannot be ticked. */
    allowed?: readonly ModelInputModality[];
    disabled?: boolean;
    /** The host draws its own label (the create form's FormField). */
    hideLabel?: boolean;
}

export default function ModelInputModalitiesField({
    value,
    inferred,
    onChange,
    allowed,
    disabled,
    hideLabel,
}: ModelInputModalitiesFieldProps) {
    const t = useTranslations('modelWizard.fields.inputModalities');
    const shown = shownInputModalities(value, inferred, allowed);

    return (
        <Stack gap={6}>
            {hideLabel ? null : (
                <div>
                    <Text size="sm" fw={500}>{t('label')}</Text>
                    <Text size="xs" c="dimmed">{t('description')}</Text>
                </div>
            )}
            <Group gap="md" wrap="wrap" role="group" aria-label={t('label')}>
                {INPUT_MODALITY_OPTIONS.map((modality) => (
                    <Checkbox
                        key={modality}
                        label={t(`options.${modality}`)}
                        checked={shown.includes(modality)}
                        // The last box cannot be cleared: a model takes something.
                        disabled={disabled || (allowed ? !allowed.includes(modality) : false) || (shown.length === 1 && shown[0] === modality)}
                        onChange={(event) => onChange(toggleInputModality(shown, modality, event.currentTarget.checked))}
                    />
                ))}
            </Group>
            <Group gap="xs">
                {value ? (
                    <>
                        <Badge size="xs" variant="light" color="blue">{t('manual')}</Badge>
                        <Button size="compact-xs" variant="subtle" color="gray" disabled={disabled} onClick={() => onChange(null)}>
                            {t('reset')}
                        </Button>
                    </>
                ) : (
                    <Badge size="xs" variant="light" color="teal">{t('detected')}</Badge>
                )}
            </Group>
        </Stack>
    );
}
