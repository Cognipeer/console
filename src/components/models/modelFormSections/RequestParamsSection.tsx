import { Badge, Group, JsonInput, MultiSelect, Text } from '@mantine/core';
import { FormField, FormSection, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import { REQUEST_DEFAULTS_PLACEHOLDER, toStringArray, unsupportedParamOptions } from '@/components/models/requestParams';
import type { FieldProps } from './types';

interface RequestParamsSectionProps {
  number: number;
  /** The model's provider driver: `max_tokens` is only offered for the OpenAI-schema ones. */
  driver?: string;
  autoDropped: { params: string[]; reason?: string };
  autoDrop: { checked: boolean; onChange: (checked: boolean) => void };
  unsupportedProps: FieldProps;
  requestDefaultsProps: FieldProps;
  passthrough: { checked: boolean; onChange: (checked: boolean) => void };
}

/** Section "Request parameters": what the gateway drops, adds or forwards on calls to this model. */
export default function RequestParamsSection({
  number,
  driver,
  autoDropped,
  autoDrop,
  unsupportedProps,
  requestDefaultsProps,
  passthrough,
}: RequestParamsSectionProps) {
  return (
    <FormSection
      number={number}
      title="Request parameters"
      description="Which parameters are dropped, added or forwarded on every request to this model."
      done
    >
      <FormField
        label="Detected automatically"
        hint={
          autoDropped.params.length
            ? autoDropped.reason
            : 'Nothing known against this provider and model id. Anything the provider still rejects goes in the list below.'
        }
      >
        {autoDropped.params.length ? (
          <Group gap={6}>
            {autoDropped.params.map((param) => (
              <Badge key={param} variant="light" color="gray" radius="sm">
                {param}
              </Badge>
            ))}
          </Group>
        ) : (
          <Text size="sm" c="dimmed">None</Text>
        )}
      </FormField>

      <ToggleList>
        <ToggleRow
          label="Drop detected parameters automatically"
          description="On by default. Turn off if the provider has started accepting a parameter this list still flags."
          checked={autoDrop.checked}
          onChange={autoDrop.onChange}
        />
      </ToggleList>

      <FormField
        label="Also reject these"
        optional
        hint="Added on top of what was detected, for anything the registry does not know about this provider yet."
      >
        <MultiSelect
          data={unsupportedParamOptions(driver, toStringArray((unsupportedProps as { value?: unknown }).value))}
          searchable
          clearable
          placeholder="None"
          {...unsupportedProps}
        />
      </FormField>

      <FormField
        label="Extra request body (JSON)"
        optional
        hint="Merged into every request to this model. For parameters outside the OpenAI schema — vLLM takes chat_template_kwargs, top_k, repetition_penalty. A caller's value wins over these."
      >
        <JsonInput
          autosize
          minRows={4}
          formatOnBlur
          validationError="Must be valid JSON"
          placeholder={REQUEST_DEFAULTS_PLACEHOLDER}
          {...requestDefaultsProps}
        />
      </FormField>

      <ToggleList>
        <ToggleRow
          label="Forward unrecognised caller parameters"
          description="Off by default. When on, body fields the gateway does not know are passed to the provider as-is."
          checked={passthrough.checked}
          onChange={passthrough.onChange}
        />
      </ToggleList>
    </FormSection>
  );
}
