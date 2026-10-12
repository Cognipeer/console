'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import { Group, Loader, MultiSelect, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { IamPrincipalType, PrincipalListItem } from '../api';
import type { PrincipalRef } from '../policies/specModel';
import { usePrincipalSearch } from './usePrincipalSearch';

interface PrincipalMultiSelectProps {
  type: IamPrincipalType;
  label?: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  value: PrincipalRef[];
  onChange: (next: PrincipalRef[]) => void;
  disabled?: boolean;
  error?: ReactNode;
}

/** Pick several users / groups / tokens through the server-side principal search. */
export default function PrincipalMultiSelect({
  type,
  label,
  description,
  placeholder,
  value,
  onChange,
  disabled,
  error,
}: PrincipalMultiSelectProps) {
  const t = useTranslations('iamCenter');
  const { search, setSearch, items, loading, error: searchError } = usePrincipalSearch(type);

  // Every label ever seen, so a selected id keeps its name when later searches no longer return it.
  const known = useRef(new Map<string, string>());
  const byId = useRef(new Map<string, PrincipalListItem>());
  for (const item of items) {
    known.current.set(item.id, item.label);
    byId.current.set(item.id, item);
  }
  for (const ref of value) known.current.set(ref.id, ref.label);

  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const ref of value) map.set(ref.id, { value: ref.id, label: ref.label });
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { value: item.id, label: item.label });
    return [...map.values()];
  }, [items, value]);

  return (
    <MultiSelect
      label={label}
      description={description}
      placeholder={value.length === 0 ? (placeholder ?? t('pickers.searchPlaceholder')) : undefined}
      data={data}
      value={value.map((v) => v.id)}
      onChange={(ids) =>
        onChange(ids.map((id) => ({ id, label: known.current.get(id) ?? id })))
      }
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      hidePickedOptions
      clearable
      disabled={disabled}
      error={error ?? searchError ?? undefined}
      nothingFoundMessage={loading ? t('pickers.searching') : t('pickers.nothingFound')}
      rightSection={loading ? <Loader size={14} /> : undefined}
      maxDropdownHeight={260}
      renderOption={({ option }) => {
        const item = byId.current.get(option.value);
        return (
          <Group gap="xs" justify="space-between" wrap="nowrap" w="100%">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" truncate>
                {option.label}
              </Text>
              {item?.sublabel ? (
                <Text size="xs" c="dimmed" truncate>
                  {item.sublabel}
                </Text>
              ) : null}
            </div>
            {typeof item?.memberCount === 'number' ? (
              <Text size="xs" c="dimmed">
                {t('pickers.members', { count: item.memberCount })}
              </Text>
            ) : null}
          </Group>
        );
      }}
    />
  );
}
