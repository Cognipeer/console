'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import { Group, Loader, Select, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { IamPrincipalType, PrincipalListItem } from '../api';
import type { PrincipalRef } from '../policies/specModel';
import { usePrincipalSearch } from './usePrincipalSearch';

interface PrincipalSelectProps {
  type: IamPrincipalType;
  label?: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  value: PrincipalRef | null;
  onChange: (next: PrincipalRef | null) => void;
  disabled?: boolean;
  required?: boolean;
  error?: ReactNode;
}

/** Pick ONE user / group / token through the server-side principal search. */
export default function PrincipalSelect({
  type,
  label,
  description,
  placeholder,
  value,
  onChange,
  disabled,
  required,
  error,
}: PrincipalSelectProps) {
  const t = useTranslations('iamCenter');
  const { search, setSearch, items, loading, error: searchError } = usePrincipalSearch(type);

  const known = useRef(new Map<string, string>());
  const byId = useRef(new Map<string, PrincipalListItem>());
  for (const item of items) {
    known.current.set(item.id, item.label);
    byId.current.set(item.id, item);
  }
  if (value) known.current.set(value.id, value.label);

  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    if (value) map.set(value.id, { value: value.id, label: value.label });
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { value: item.id, label: item.label });
    return [...map.values()];
  }, [items, value]);

  return (
    <Select
      label={label}
      description={description}
      placeholder={placeholder ?? t('pickers.searchPlaceholder')}
      data={data}
      value={value?.id ?? null}
      onChange={(id) => onChange(id ? { id, label: known.current.get(id) ?? id } : null)}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      clearable
      allowDeselect
      disabled={disabled}
      required={required}
      error={error ?? searchError ?? undefined}
      nothingFoundMessage={loading ? t('pickers.searching') : t('pickers.nothingFound')}
      rightSection={loading ? <Loader size={14} /> : undefined}
      maxDropdownHeight={260}
      renderOption={({ option }) => {
        const item = byId.current.get(option.value);
        return (
          <div style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" truncate>
                {option.label}
              </Text>
              {item?.role ? (
                <Text size="xs" c="dimmed">
                  {item.role}
                </Text>
              ) : null}
            </Group>
            {item?.sublabel ? (
              <Text size="xs" c="dimmed" truncate>
                {item.sublabel}
              </Text>
            ) : null}
          </div>
        );
      }}
    />
  );
}
