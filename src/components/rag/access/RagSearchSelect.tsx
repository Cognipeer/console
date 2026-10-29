'use client';

/**
 * A pick-one whose candidates come from the server as you type (people of a project, the documents of a knowledge
 * base): nothing is loaded wholesale, the first page arrives when the list is first opened, and the keyboard behaves
 * like the other server-searching pickers (typing into a box that holds a choice starts a fresh search, Enter picks
 * the first result; see `useSearchBox`).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Loader, Select, Text } from '@mantine/core';
import { useSearchBox } from '@/components/quota/useSearchBox';
import { useServerSearch } from './useRagAccessData';

export interface RagSearchOption {
  value: string;
  label: string;
  description?: string;
}

export interface RagSearchSelectProps {
  label: string;
  placeholder?: string;
  description?: ReactNode;
  value: RagSearchOption | null;
  onChange: (next: RagSearchOption | null) => void;
  /** The matches of the words typed (the first page for none). */
  search: (query: string, signal: AbortSignal) => Promise<RagSearchOption[]>;
  /** Asks again when this changes (another knowledge base). */
  searchKey?: string;
  nothingFound?: string;
  disabled?: boolean;
  clearable?: boolean;
}

export function RagSearchSelect({
  label,
  placeholder,
  description,
  value,
  onChange,
  search,
  searchKey,
  nothingFound = 'Nothing found',
  disabled = false,
  clearable = true,
}: RagSearchSelectProps) {
  // The first page is asked for when the list is first opened, not for every picker on the screen at once.
  const [armed, setArmed] = useState(false);
  const found = useServerSearch(search, { enabled: armed, resetKey: searchKey });

  const box = useSearchBox({
    label: value?.label,
    value: value?.value ?? null,
    initialText: value?.label ?? '',
    onQuery: found.setQuery,
    enter: { ready: !found.loading, results: found.items },
  });

  const data = useMemo(() => {
    const options = new Map<string, RagSearchOption>();
    for (const item of found.items) options.set(item.value, item);
    // The choice stays selectable whatever a later search returns.
    if (value && !options.has(value.value)) options.set(value.value, value);
    return [...options.values()].map((option) => ({ value: option.value, label: option.label, description: option.description }));
  }, [found.items, value]);

  const searching = found.query.trim() !== '';
  const pinned = value !== null && !found.items.some((item) => item.value === value.value);

  return (
    <Select
      label={label}
      placeholder={placeholder}
      description={description}
      data={data}
      value={value?.value ?? null}
      onChange={(next) => onChange(next ? data.find((option) => option.value === next) ?? null : null)}
      onDropdownOpen={() => setArmed(true)}
      searchable
      clearable={clearable}
      disabled={disabled}
      // The server already filtered and ranked: the list is not filtered a second time on the label. The one thing
      // left out is the choice that is not among the results, while somebody searches for something else.
      filter={({ options }) =>
        searching && pinned && value
          ? options.filter((option) => !('value' in option) || option.value !== value.value)
          : options}
      {...box.props}
      rightSection={armed && found.loading ? <Loader size="xs" /> : undefined}
      nothingFoundMessage={found.loading ? 'Searching…' : nothingFound}
      error={found.error ? found.error.message : undefined}
      renderOption={({ option }) => {
        const extra = (option as { description?: string }).description;
        return (
          <div style={{ minWidth: 0 }}>
            <Text size="sm" truncate>{option.label}</Text>
            {extra ? (
              // Not `c="dimmed"`: a highlighted option turns white, and a fixed grey would be unreadable on it.
              <Text size="xs" truncate style={{ opacity: 0.72 }}>{extra}</Text>
            ) : null}
          </div>
        );
      }}
    />
  );
}
