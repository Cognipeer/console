import { useId, useMemo, type ReactNode } from 'react';
import { Autocomplete, Loader, Select, TextInput, type ComboboxStringItem, type OptionsFilter } from '@mantine/core';
import { FormField, FormRow, FormSection } from '@/components/common/ui/FormShell';
import { useTranslations } from '@/lib/i18n';
import FieldWithAction from './FieldWithAction';
import type { FieldProps } from './types';

export interface ProviderSummary {
  key: string;
  label: string;
  status: string;
  driver: string;
  description?: string;
}

/** One model id the provider is known to serve, offered while typing the Model ID. */
export interface ModelIdSuggestion {
  value: string;
  /** Shown next to the id when it differs (the provider's display name). */
  label?: string;
  /** Options with the same group are listed under one heading. */
  group?: string;
}

interface ProviderSectionProps {
  number: number;
  done?: boolean;
  providers: ProviderSummary[];
  providerKey: string;
  onProviderChange: (key: string) => void;
  modelIdProps: FieldProps;
  modelIdPlaceholder?: string;
  /**
   * Model ids the provider serves. When given (even empty), the Model ID field offers them while typing and still
   * takes any text; keep passing an array once the form shows, or the field is swapped and loses focus.
   */
  modelIdSuggestions?: ModelIdSuggestion[];
  /** The suggestions are being listed. */
  modelIdLoading?: boolean;
  /** Shown at the end of the Model ID label row, next to the label (e.g. a link back to the model catalog). */
  modelIdAction?: ReactNode;
  /** Shown instead of the picker when the project has no provider. */
  emptyState?: ReactNode;
}

/** At most this many suggestions are drawn at once; typing narrows the rest. */
const SUGGESTION_LIMIT = 50;

/** Section "Provider & connection": which provider serves the model, and under which model id. */
export default function ProviderSection({
  number,
  done,
  providers,
  providerKey,
  onProviderChange,
  modelIdProps,
  modelIdPlaceholder = 'gpt-4o-mini',
  modelIdSuggestions,
  modelIdLoading = false,
  modelIdAction,
  emptyState,
}: ProviderSectionProps) {
  const selected = providers.find((p) => p.key === providerKey);
  const modelIdInputId = useId();
  const modelIdInput = modelIdSuggestions ? (
    <ModelIdAutocomplete
      id={modelIdInputId}
      placeholder={modelIdPlaceholder}
      suggestions={modelIdSuggestions}
      loading={modelIdLoading}
      inputProps={modelIdProps}
    />
  ) : (
    <TextInput id={modelIdInputId} placeholder={modelIdPlaceholder} {...modelIdProps} />
  );
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
        {modelIdAction ? (
          // Not FormField's `action`: inside its <label> the button became the label's control, so clicking
          // "Model ID" pressed "Back to catalog" and closed the form.
          <FieldWithAction label="Model ID" required htmlFor={modelIdInputId} action={modelIdAction}>
            {modelIdInput}
          </FieldWithAction>
        ) : (
          <FormField label="Model ID" required>
            {modelIdInput}
          </FormField>
        )}
      </FormRow>
    </FormSection>
  );
}

/**
 * The Model ID as free text with the provider's model ids offered while typing. Matching looks at the id and the
 * display name, so "sonnet" finds `claude-sonnet-4-5`.
 */
function ModelIdAutocomplete({
  id,
  placeholder,
  suggestions,
  loading,
  inputProps,
}: {
  id: string;
  placeholder: string;
  suggestions: ModelIdSuggestion[];
  loading: boolean;
  inputProps: FieldProps;
}) {
  const t = useTranslations('modelCatalog');
  const { data, labels } = useMemo(() => {
    // Mantine refuses duplicate values; the first suggestion of an id wins.
    const seen = new Set<string>();
    const labelOf = new Map<string, string>();
    const groups = new Map<string, string[]>();
    const ungrouped: string[] = [];
    for (const suggestion of suggestions) {
      const value = suggestion.value.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      if (suggestion.label && suggestion.label !== value) labelOf.set(value, suggestion.label);
      if (suggestion.group) groups.set(suggestion.group, [...(groups.get(suggestion.group) ?? []), value]);
      else ungrouped.push(value);
    }
    return {
      data: [...ungrouped, ...[...groups].map(([group, items]) => ({ group, items }))],
      labels: labelOf,
    };
  }, [suggestions]);

  const filter = useMemo<OptionsFilter>(() => ({ options, search, limit }) => {
    const term = search.trim().toLowerCase();
    const matches = (item: ComboboxStringItem) =>
      !term || item.value.toLowerCase().includes(term) || (labels.get(item.value)?.toLowerCase().includes(term) ?? false);
    let left = limit;
    const out: typeof options = [];
    for (const option of options) {
      if (left <= 0) break;
      if ('group' in option) {
        const items = option.items.filter(matches).slice(0, left);
        if (items.length) {
          out.push({ ...option, items });
          left -= items.length;
        }
      } else if (matches(option)) {
        out.push(option);
        left -= 1;
      }
    }
    return out;
  }, [labels]);

  return (
    <Autocomplete
      id={id}
      placeholder={placeholder}
      data={data}
      filter={filter}
      limit={SUGGESTION_LIMIT}
      maxDropdownHeight={280}
      renderOption={({ option }) => {
        const label = labels.get(option.value);
        return (
          <div className="ds-col" style={{ gap: 1, minWidth: 0 }}>
            <span className="ds-mono" style={{ fontSize: 12.5 }}>{option.value}</span>
            {label ? <span className="ds-faint" style={{ fontSize: 11.5 }}>{label}</span> : null}
          </div>
        );
      }}
      rightSection={loading ? <Loader size={14} aria-label={t('autocomplete.loading')} /> : null}
      {...inputProps}
    />
  );
}
