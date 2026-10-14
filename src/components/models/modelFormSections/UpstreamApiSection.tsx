import { Select } from '@mantine/core';
import { FormField, FormSection } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import { UPSTREAM_APIS, type UpstreamApi } from '@/lib/services/models/upstreamApi';

interface UpstreamApiSectionProps {
  number: number;
  value: UpstreamApi;
  onChange: (next: UpstreamApi) => void;
}

/**
 * Section "Upstream API": which OpenAI endpoint the console calls for this model.
 * An explicit choice, never inferred from the model id. Only rendered for the
 * OpenAI-schema drivers (openai, azure, openai-compatible, together); the gateway
 * endpoints keep speaking their clients' wire format either way.
 */
export default function UpstreamApiSection({ number, value, onChange }: UpstreamApiSectionProps) {
  const t = useTranslations('modelUpstreamApi');
  return (
    <FormSection number={number} title={t('title')} description={t('description')} done>
      <FormField label={t('label')} hint={t(`hint.${value}`)}>
        <Select
          data={UPSTREAM_APIS.map((api) => ({ value: api, label: t(`option.${api}`) }))}
          value={value}
          allowDeselect={false}
          onChange={(next) => onChange(next === 'responses' ? 'responses' : 'chat')}
        />
      </FormField>
    </FormSection>
  );
}
