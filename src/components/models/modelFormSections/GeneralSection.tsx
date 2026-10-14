import { TextInput, Textarea } from '@mantine/core';
import { ChipPicker, FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { FieldProps } from './types';

interface GeneralSectionProps<C extends string> {
  number: number;
  done?: boolean;
  nameProps: FieldProps;
  keyProps: FieldProps;
  descriptionProps: FieldProps;
  namePlaceholder?: string;
  keyPlaceholder?: string;
  descriptionPlaceholder?: string;
  keyHint?: string;
  /** Category picker (create only); omitted when the category is fixed. */
  category?: {
    options: Array<{ value: C; label: string }>;
    value: C;
    onChange: (value: C) => void;
  };
}

/** Section "General": how the model is identified across the console and SDK. */
export default function GeneralSection<C extends string>({
  number,
  done,
  nameProps,
  keyProps,
  descriptionProps,
  namePlaceholder = 'Friendly model name',
  keyPlaceholder = 'optional-model-key',
  descriptionPlaceholder = 'Optional description',
  keyHint,
  category,
}: GeneralSectionProps<C>) {
  return (
    <FormSection
      number={number}
      title="General"
      description="How this model is identified across the console and SDK."
      done={done}
    >
      <FormRow cols={2}>
        <FormField label="Display name" required>
          <TextInput placeholder={namePlaceholder} {...nameProps} />
        </FormField>
        <FormField label="Key" hint={keyHint}>
          <TextInput placeholder={keyPlaceholder} {...keyProps} />
        </FormField>
      </FormRow>
      {category ? (
        <FormRow cols={1}>
          <FormField label="Category">
            <ChipPicker<C>
              options={category.options}
              value={category.value}
              onChange={(v) => category.onChange(v as C)}
            />
          </FormField>
        </FormRow>
      ) : null}
      <FormRow cols={1}>
        <FormField label="Description" optional>
          <Textarea placeholder={descriptionPlaceholder} autosize minRows={2} {...descriptionProps} />
        </FormField>
      </FormRow>
    </FormSection>
  );
}
