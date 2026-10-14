import type { ReactNode } from 'react';
import { NumberInput, TextInput } from '@mantine/core';
import { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import CatalogPriceFill from '@/components/models/CatalogPriceFill';
import type { FieldProps } from './types';

interface PricingSectionProps {
  number: number;
  done?: boolean;
  description: ReactNode;
  modelId: string;
  currencyProps: FieldProps;
  inputProps: FieldProps;
  outputProps: FieldProps;
  cachedProps: FieldProps;
  onApplyCatalog: (pricing: { inputTokenPer1M: number; outputTokenPer1M: number; cachedTokenPer1M: number }) => void;
  /** Category-specific price fields (per second / character / page / image). */
  children?: ReactNode;
}

/** Section "Pricing": per-unit prices used for accounting and routing. */
export default function PricingSection({
  number,
  done,
  description,
  modelId,
  currencyProps,
  inputProps,
  outputProps,
  cachedProps,
  onApplyCatalog,
  children,
}: PricingSectionProps) {
  return (
    <FormSection number={number} title="Pricing" description={description} done={done}>
      <FormRow cols={2}>
        <FormField label="Currency">
          <TextInput placeholder="USD" {...currencyProps} />
        </FormField>
        <FormField
          label="Input · per 1M tokens"
          action={<CatalogPriceFill modelId={modelId} onApply={onApplyCatalog} />}
        >
          <NumberInput min={0} decimalScale={4} {...inputProps} />
        </FormField>
      </FormRow>
      <FormRow cols={2}>
        <FormField label="Output · per 1M tokens">
          <NumberInput min={0} decimalScale={4} {...outputProps} />
        </FormField>
        <FormField label="Cached · per 1M tokens" optional>
          <NumberInput min={0} decimalScale={4} {...cachedProps} />
        </FormField>
      </FormRow>
      {children}
    </FormSection>
  );
}
