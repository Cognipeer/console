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
import {
  allFields,
  showsStoredSecretCue,
  visibilitySourceNames,
  visibleSections,
} from './providerFormModel';

type ProviderFormRendererProps = {
  schema: ProviderFormSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>;
  disabled?: boolean;
  /** Section numbering offset — use to continue numbering across multiple renderers. */
  sectionStart?: number;
  /**
   * Set when the provider being edited already stores credentials: the credential fields named in
   * `storedCredentialFields` show this text as their placeholder (a blank one keeps the stored value).
   */
  storedSecretPlaceholder?: string;
  /** The credential fields the provider being edited stores a value for (see `storedCredentialFields`). */
  storedCredentialFields?: ReadonlySet<string>;
};

function renderField(
  field: ProviderFormField,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>,
  options: {
    disabled?: boolean;
    storedSecretPlaceholder?: string;
    storedCredentialFields?: ReadonlySet<string>;
    /** Another field's condition reads this one, so it must always hold a value. */
    isConditionSource: boolean;
  },
) {
  const { disabled, storedSecretPlaceholder, storedCredentialFields, isConditionSource } = options;
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

  const storedCue = storedSecretPlaceholder !== undefined && showsStoredSecretCue(field, storedCredentialFields);
  const commonProps = {
    disabled,
    placeholder: storedCue ? storedSecretPlaceholder : field.placeholder,
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
            // Clicking the chosen option again would clear it; a required choice, or one that decides which
            // other fields apply, always keeps a value.
            allowDeselect={!field.required && !isConditionSource}
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
  storedSecretPlaceholder,
  storedCredentialFields,
}: ProviderFormRendererProps) {
  if (!schema.sections.length) return null;

  // Fields that do not apply to the form as it stands (`visibleWhen`) are not drawn, and a section left with
  // nothing to show goes with them; the numbering follows what is on screen.
  const conditionSources = visibilitySourceNames(allFields(schema));
  const sections = visibleSections(schema, form.values ?? {});

  return (
    <>
      {sections.map(({ section, fields }, sectionIndex) => (
        <FormSection
          key={schema.sections.indexOf(section)}
          number={sectionStart + sectionIndex}
          title={section.title || `Configuration ${sectionIndex + 1}`}
          description={section.description}
        >
          {fields.map((field) =>
            renderField(field, form, {
              disabled,
              storedSecretPlaceholder,
              storedCredentialFields,
              isConditionSource: conditionSources.has(field.name),
            }),
          )}
        </FormSection>
      ))}
    </>
  );
}

export default ProviderFormRenderer;
