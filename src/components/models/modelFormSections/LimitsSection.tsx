import { NumberInput } from '@mantine/core';
import { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { FieldProps } from './types';

interface LimitsSectionProps {
  number: number;
  contextWindow?: { label: string; hint?: string; placeholder?: string; props: FieldProps };
  maxOutputTokens?: { label: string; hint?: string; placeholder?: string; props: FieldProps };
  /** Runtime default for `max_tokens` when the caller sends none. */
  maxTokens: { label?: string; hint?: string; props: FieldProps };
  /** Default temperature (create only). */
  temperatureProps?: FieldProps;
}

/** Section "Limits": context window, output cap and default sampling parameters. */
export default function LimitsSection({
  number,
  contextWindow,
  maxOutputTokens,
  maxTokens,
  temperatureProps,
}: LimitsSectionProps) {
  return (
    <FormSection
      number={number}
      title="Limits"
      description="Token limits and defaults used when callers don't specify their own."
      done
    >
      {contextWindow || maxOutputTokens ? (
        <FormRow cols={2}>
          {contextWindow ? (
            <FormField label={contextWindow.label} optional hint={contextWindow.hint}>
              <NumberInput
                min={1}
                step={1024}
                thousandSeparator=","
                placeholder={contextWindow.placeholder}
                {...contextWindow.props}
              />
            </FormField>
          ) : null}
          {maxOutputTokens ? (
            <FormField label={maxOutputTokens.label} optional hint={maxOutputTokens.hint}>
              <NumberInput
                min={1}
                step={1024}
                thousandSeparator=","
                placeholder={maxOutputTokens.placeholder}
                {...maxOutputTokens.props}
              />
            </FormField>
          ) : null}
        </FormRow>
      ) : null}
      <FormRow cols={2}>
        {temperatureProps ? (
          <FormField label="Temperature" optional>
            <NumberInput min={0} max={2} step={0.1} decimalScale={2} placeholder="Optional" {...temperatureProps} />
          </FormField>
        ) : null}
        <FormField label={maxTokens.label ?? 'Max tokens'} optional hint={maxTokens.hint}>
          <NumberInput min={1} step={1024} thousandSeparator="," placeholder="Optional" {...maxTokens.props} />
        </FormField>
      </FormRow>
    </FormSection>
  );
}
