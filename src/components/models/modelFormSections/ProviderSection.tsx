import type { ReactNode } from 'react';
import { Select, TextInput } from '@mantine/core';
import { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import type { FieldProps } from './types';

export interface ProviderSummary {
  key: string;
  label: string;
  status: string;
  driver: string;
  description?: string;
}

interface ProviderSectionProps {
  number: number;
  done?: boolean;
  providers: ProviderSummary[];
  providerKey: string;
  onProviderChange: (key: string) => void;
  modelIdProps: FieldProps;
  modelIdPlaceholder?: string;
  /** Shown instead of the picker when the project has no provider. */
  emptyState?: ReactNode;
}

/** Section "Provider & connection": which provider serves the model, and under which model id. */
export default function ProviderSection({
  number,
  done,
  providers,
  providerKey,
  onProviderChange,
  modelIdProps,
  modelIdPlaceholder = 'gpt-4o-mini',
  emptyState,
}: ProviderSectionProps) {
  const selected = providers.find((p) => p.key === providerKey);
  return (
    <FormSection
      number={number}
      title="Provider & connection"
      description="The provider that serves this model and the id it is addressed by there."
      done={done}
    >
      {providers.length === 0 ? (
        emptyState ?? (
          <span className="ds-muted" style={{ fontSize: 13 }}>No model providers configured.</span>
        )
      ) : (
        <>
          <FormRow cols={1}>
            <FormField label="Provider" required>
              <Select
                placeholder="Select a model provider"
                data={providers.map((p) => ({ value: p.key, label: p.label, disabled: p.status === 'disabled' }))}
                value={providerKey}
                onChange={(value) => onProviderChange(value ?? '')}
                searchable
              />
            </FormField>
          </FormRow>
          {selected ? (
            <div className="ds-card ds-card-pad-sm" style={{ background: 'var(--ds-surface-1)' }}>
              <div className="ds-row ds-gap-sm" style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{selected.label}</span>
                <span className={`ds-badge ${selected.status === 'active' ? 'ds-badge-ok' : 'ds-badge-warn'}`}>
                  {selected.status}
                </span>
              </div>
              {selected.description ? (
                <div className="ds-muted" style={{ fontSize: 12, marginBottom: 4 }}>{selected.description}</div>
              ) : null}
              <div className="ds-faint" style={{ fontSize: 11.5 }}>
                driver: <span className="ds-mono">{selected.driver}</span> · key:{' '}
                <span className="ds-mono">{selected.key}</span>
              </div>
            </div>
          ) : null}
        </>
      )}
      <FormRow cols={1}>
        <FormField label="Model ID" required>
          <TextInput placeholder={modelIdPlaceholder} {...modelIdProps} />
        </FormField>
      </FormRow>
    </FormSection>
  );
}
