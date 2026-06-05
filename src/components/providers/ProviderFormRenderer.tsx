'use client';

import {
  TextInput,
  PasswordInput,
  NumberInput,
  Textarea,
  Select,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import type { ProviderFormSchema, ProviderFormField } from '@/lib/providers';
import {
  FormField,
  FormSection,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';

type ProviderFormRendererProps = {
  schema: ProviderFormSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>;
  disabled?: boolean;
  /** Section numbering offset — use to continue numbering across multiple renderers. */
  sectionStart?: number;
};

function renderField(
  field: ProviderFormField,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>,
  disabled?: boolean,
) {
  if (field.type === 'switch') {
    const inputProps = form.getInputProps(field.name, { type: 'checkbox' });
    return (
      <ToggleList key={field.name}>
        <ToggleRow
          label={field.label}
          description={field.description}
          checked={Boolean(inputProps.checked)}
          onChange={(v) => inputProps.onChange?.(v)}
          disabled={disabled}
        />
      </ToggleList>
    );
  }

  const commonProps = {
    disabled,
    placeholder: field.placeholder,
    ...form.getInputProps(field.name),
  } as const;

  const input = (() => {
    switch (field.type) {
      case 'password':
        return <PasswordInput {...commonProps} />;
      case 'number':
        return <NumberInput {...commonProps} />;
      case 'textarea':
        return <Textarea minRows={3} autosize {...commonProps} />;
      case 'select':
        return (
          <Select
            {...commonProps}
            data={
              field.options?.map((option) => ({
                label: option.label,
                value: option.value,
              })) ?? []
            }
          />
        );
      case 'text':
      default:
        return <TextInput {...commonProps} />;
    }
  })();

  return (
    <FormField
      key={field.name}
      label={field.label}
      required={field.required}
      hint={field.description}
    >
      {input}
    </FormField>
  );
}

export function ProviderFormRenderer({
  schema,
  form,
  disabled,
  sectionStart = 1,
}: ProviderFormRendererProps) {
  if (!schema.sections.length) return null;

  return (
    <>
      {schema.sections.map((section, sectionIndex) => (
        <FormSection
          key={sectionIndex}
          number={sectionStart + sectionIndex}
          title={section.title || `Configuration ${sectionIndex + 1}`}
          description={section.description}
        >
          {section.fields.map((field) => renderField(field, form, disabled))}
        </FormSection>
      ))}
    </>
  );
}

export default ProviderFormRenderer;
