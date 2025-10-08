'use client';

import {
  Stack,
  Title,
  Text,
  TextInput,
  PasswordInput,
  NumberInput,
  Textarea,
  Select,
  Switch,
  Group,
} from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import type { ProviderFormSchema, ProviderFormField } from '@/lib/providers';

type ProviderFormRendererProps = {
  schema: ProviderFormSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>;
  disabled?: boolean;
};

function renderField(
  field: ProviderFormField,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: UseFormReturnType<any>,
  disabled?: boolean,
) {
  const commonProps = {
    key: field.name,
    label: field.label,
    description: field.description,
    withAsterisk: field.required,
    disabled,
    ...form.getInputProps(field.name),
  } as const;

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
          data={field.options?.map((option) => ({
            label: option.label,
            value: option.value,
          })) ?? []}
          placeholder={field.placeholder}
        />
      );
    case 'switch':
      return (
        <Switch
          key={field.name}
          label={field.label}
          description={field.description}
          disabled={disabled}
          {...form.getInputProps(field.name, { type: 'checkbox' })}
        />
      );
    case 'text':
    default:
      return <TextInput placeholder={field.placeholder} {...commonProps} />;
  }
}

export function ProviderFormRenderer({ schema, form, disabled }: ProviderFormRendererProps) {
  if (!schema.sections.length) {
    return null;
  }

  return (
    <Stack gap="lg">
      {schema.sections.map((section, sectionIndex) => (
        <Stack key={sectionIndex} gap="sm">
          {(section.title || section.description) && (
            <div>
              {section.title && (
                <Title order={5} mb={section.description ? 2 : 0}>
                  {section.title}
                </Title>
              )}
              {section.description && (
                <Text size="sm" c="dimmed">
                  {section.description}
                </Text>
              )}
            </div>
          )}
          <Stack gap="sm">
            {section.fields.map((field) => (
              <Group key={field.name} align="flex-start">
                {renderField(field, form, disabled)}
              </Group>
            ))}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}

export default ProviderFormRenderer;
