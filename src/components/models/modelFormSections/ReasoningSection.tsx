import { NumberInput, Select, Text } from '@mantine/core';
import { FormField, FormSection, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { reasoningControlForDriver } from '@/lib/services/models/reasoning';
import type { ReasoningFormValue } from '@/components/models/reasoningForm';

interface ReasoningSectionProps {
  number: number;
  driver?: string;
  value: ReasoningFormValue;
  onChange: (patch: Partial<ReasoningFormValue>) => void;
  /** The GPT-5 + tools rule applies to this model: it is shown, not editable. */
  forcedNoneWithTools?: boolean;
  /** Opened from a "set the reasoning" shortcut: scroll here and focus the effort picker. */
  focusOnMount?: boolean;
}

/**
 * Section "Reasoning": the model's default thinking effort and whether the
 * thinking text is handed back to callers. Options follow the driver — effort
 * levels for OpenAI-family, level or token budget for Anthropic / Bedrock /
 * Vertex, on/off for OpenAI-compatible engines. "Not set" sends nothing.
 */
export default function ReasoningSection({
  number,
  driver,
  value,
  onChange,
  forcedNoneWithTools,
  focusOnMount,
}: ReasoningSectionProps) {
  const t = useTranslations('modelReasoning');
  const control = reasoningControlForDriver(driver);

  const options = [
    { value: '', label: t('notSet') },
    ...control.efforts.map((effort) => ({
      value: effort,
      label: control.kind === 'toggle' ? t(`toggle.${effort}`) : t(`effort.${effort}`),
    })),
  ];

  return (
    <FormSection number={number} title={t('title')} description={t('description')} done focusOnMount={focusOnMount}>
      {control.kind === 'none' ? (
        <Text size="sm" c="dimmed">{t('unsupportedDriver')}</Text>
      ) : (
        <>
          <FormField
            label={control.kind === 'toggle' ? t('toggleLabel') : t('effortLabel')}
            optional
            hint={t(`hint.${control.kind}`)}
          >
            <Select
              data={options}
              value={value.effort}
              allowDeselect={false}
              onChange={(next) => onChange({ effort: (next ?? '') as ReasoningFormValue['effort'] })}
            />
          </FormField>

          {control.budget ? (
            <FormField label={t('budgetLabel')} optional hint={t('budgetHint')}>
              <NumberInput
                min={1024}
                step={1024}
                thousandSeparator=","
                placeholder={t('budgetPlaceholder')}
                disabled={value.effort === 'none'}
                value={value.budgetTokens}
                onChange={(next) => onChange({ budgetTokens: next === '' ? '' : Number(next) })}
              />
            </FormField>
          ) : null}

          {control.includeThoughts ? (
            <ToggleList>
              <ToggleRow
                label={t('includeThoughts.label')}
                description={t('includeThoughts.description')}
                checked={value.includeThoughts}
                onChange={(checked) => onChange({ includeThoughts: checked })}
              />
            </ToggleList>
          ) : null}
        </>
      )}

      {forcedNoneWithTools ? (
        <Text size="sm" c="orange" data-testid="reasoning-forced-none">
          {t('forcedNoneWithTools')}
        </Text>
      ) : null}

      <ToggleList>
        <ToggleRow
          label={t('returnReasoning.label')}
          description={t('returnReasoning.description')}
          checked={value.returnReasoning}
          onChange={(checked) => onChange({ returnReasoning: checked })}
        />
      </ToggleList>
    </FormSection>
  );
}
