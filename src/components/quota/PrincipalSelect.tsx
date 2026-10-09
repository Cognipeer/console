'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Select, Text } from '@mantine/core';
import { PICKER_LIMIT, resolvePickerOption, searchPickerOptions, type PickerOption, type PickerType } from './pickerSources';

interface PrincipalSelectProps {
  type: PickerType;
  /** The stored value: a user / group / token id, or an agent key. */
  value?: string;
  /** What to show for `value` before (or without) a search — e.g. the name of an already-saved target. */
  valueLabel?: string;
  onChange: (value: string | undefined, option?: PickerOption) => void;
  /** Called with the best known name of `value` (and again when a better one arrives). */
  onLabelChange?: (label: string | undefined) => void;
  label?: string;
  description?: string;
  placeholder?: string;
  nothingFoundMessage?: string;
  disabled?: boolean;
  clearable?: boolean;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * A searchable picker whose candidates come from the server as you type, so it
 * stays usable on a tenant with tens of thousands of users (see pickerSources).
 */
export function PrincipalSelect({
  type,
  value,
  valueLabel,
  onChange,
  onLabelChange,
  label,
  description,
  placeholder,
  nothingFoundMessage,
  disabled = false,
  clearable = true,
}: PrincipalSelectProps) {
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<PickerOption[]>([]);
  const [loading, setLoading] = useState(false);
  // The option behind the current value stays selectable whatever a later search returns.
  const [chosen, setChosen] = useState<PickerOption | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    const handle = setTimeout(() => {
      setLoading(true);
      searchPickerOptions(type, search)
        .then((options) => {
          if (requestId.current === id) setFound(options);
        })
        .catch(() => {
          if (requestId.current === id) setFound([]);
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    }, search ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(handle);
  }, [type, search]);

  // A different kind of target invalidates the remembered choice.
  useEffect(() => {
    setChosen(null);
    setSearch('');
  }, [type]);

  // A stored id that arrives without a name (a deep link) is looked up once.
  const [resolved, setResolved] = useState<PickerOption | null>(null);
  useEffect(() => {
    setResolved(null);
    if (!value || valueLabel) return;
    let cancelled = false;
    void resolvePickerOption(type, value).then((option) => {
      if (!cancelled && option) setResolved(option);
    });
    return () => {
      cancelled = true;
    };
  }, [type, value, valueLabel]);

  const data = useMemo(() => {
    const byValue = new Map<string, PickerOption>(found.map((option) => [option.value, option]));
    // The stored value stays selectable whatever the search returns, under the best name known.
    if (value && !byValue.has(value)) {
      byValue.set(
        value,
        chosen?.value === value ? chosen : resolved?.value === value ? resolved : { value, label: valueLabel ?? value },
      );
    }
    return [...byValue.values()].map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
    }));
  }, [found, chosen, resolved, value, valueLabel]);

  const lookup = useMemo(() => new Map(found.map((option) => [option.value, option])), [found]);

  // Report the name of the current value (the stored id before anything better is known).
  const currentLabel = value ? data.find((option) => option.value === value)?.label : undefined;
  const reportLabel = useRef(onLabelChange);
  reportLabel.current = onLabelChange;
  useEffect(() => {
    reportLabel.current?.(currentLabel);
  }, [currentLabel]);

  return (
    <Select
      label={label}
      description={description}
      placeholder={placeholder}
      data={data}
      value={value || null}
      onChange={(next) => {
        const option = next ? lookup.get(next) ?? (chosen?.value === next ? chosen : undefined) : undefined;
        setChosen(option ?? null);
        onChange(next || undefined, option);
      }}
      searchable
      clearable={clearable}
      disabled={disabled}
      // The server already filtered: do not filter the list a second time on the label.
      filter={({ options }) => options}
      searchValue={search}
      onSearchChange={setSearch}
      limit={PICKER_LIMIT}
      rightSection={loading ? <Loader size="xs" /> : undefined}
      nothingFoundMessage={nothingFoundMessage}
      renderOption={({ option }) => {
        const description = (option as { description?: string }).description;
        return (
          <div>
            <Text size="sm">{option.label}</Text>
            {description ? (
              <Text size="xs" c="dimmed">
                {description}
              </Text>
            ) : null}
          </div>
        );
      }}
    />
  );
}
