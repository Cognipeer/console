'use client';

import { useState } from 'react';
import { Select, type SelectProps } from '@mantine/core';
import { includesFolded } from '@/lib/shared/searchFold';
import { useSearchBox } from './useSearchBox';

export interface SearchableSelectProps
  extends Omit<
    SelectProps,
    'data' | 'searchable' | 'filter' | 'searchValue' | 'onSearchChange' | 'allowDeselect' | 'selectFirstOptionOnChange'
  > {
  /** A flat list; the whole list is in the browser, so it is filtered here (see `SearchableSelect`). */
  data: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
}

/**
 * A searchable pick-one over a list the browser already holds (the projects of
 * a tenant, a fixed list of resources). It behaves like the pickers that ask
 * the server (see useSearchBox): typing into a box that holds a choice starts a
 * fresh search instead of extending the name, Enter picks the first match, and
 * the filter folds case the Turkish-aware way ("ışık" finds "IŞIK").
 */
export function SearchableSelect({ data, value, ...others }: SearchableSelectProps) {
  const [query, setQuery] = useState('');
  const label = value ? data.find((option) => option.value === value)?.label : undefined;
  const box = useSearchBox({ label, value: value ?? null, initialText: label ?? '', onQuery: setQuery });

  return (
    <Select
      {...others}
      data={data as SelectProps['data']}
      value={value}
      searchable
      // The first match is highlighted as you type, so Enter picks it.
      selectFirstOptionOnChange
      filter={({ options }) =>
        options.filter((option) => !('value' in option) || includesFolded(option.label, query))
      }
      {...box.props}
    />
  );
}
