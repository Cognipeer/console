import { FormField, FormRow, FormSection, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import type { ModelInputModality } from '@/lib/services/models/modelCapabilities';
import ModelInputModalitiesField from '@/components/models/ModelInputModalitiesField';

interface Toggle {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

interface CapabilitiesSectionProps {
  number: number;
  toolCalls: Toggle;
  reasoning: Toggle;
  structuredOutputs: Toggle;
  modalities: {
    label: string;
    hint?: string;
    value: ModelInputModality[] | null;
    inferred: ModelInputModality[];
    onChange: (next: ModelInputModality[] | null) => void;
  };
}

/** Section "Capabilities": what the model supports (tools, reasoning, structured output, input types). */
export default function CapabilitiesSection({
  number,
  toolCalls,
  reasoning,
  structuredOutputs,
  modalities,
}: CapabilitiesSectionProps) {
  return (
    <FormSection
      number={number}
      title="Capabilities"
      description="What this model supports — determined by the provider but can be overridden."
    >
      <ToggleList>
        <ToggleRow {...toolCalls} />
        <ToggleRow {...reasoning} />
        <ToggleRow {...structuredOutputs} />
      </ToggleList>
      <FormRow cols={1}>
        <FormField label={modalities.label} hint={modalities.hint}>
          <ModelInputModalitiesField
            hideLabel
            value={modalities.value}
            inferred={modalities.inferred}
            onChange={modalities.onChange}
          />
        </FormField>
      </FormRow>
    </FormSection>
  );
}
