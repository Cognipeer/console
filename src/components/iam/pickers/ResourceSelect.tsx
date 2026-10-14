'use client';

import { useMemo, useRef, type ReactNode } from 'react';
import { Group, Loader, Select, Text, TextInput } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { ResourceOption } from '../api';
import type { ResourceRef } from '../policies/specModel';
import { useResourceSearch } from './lookups';

interface ResourceSelectProps {
  /** Registry type id the search is limited to; the picker is inert without one. */
  type: string | null;
  label?: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  value: ResourceRef | null;
  onChange: (next: ResourceRef | null) => void;
  disabled?: boolean;
  error?: ReactNode;
}

/**
 * Pick one resource of a type from the resource registry (server-side search).
 * When the caller cannot read the registry it turns into an id field, so the
 * policy can still be written by someone who knows the id.
 */
export default function ResourceSelect({
  type,
  label,
  description,
  placeholder,
  value,
  onChange,
  disabled,
  error,
}: ResourceSelectProps) {
  const t = useTranslations('iamCenter');
  const { search, setSearch, items, loading, error: searchError, unavailable } = useResourceSearch(type);
  const byId = useRef(new Map<string, ResourceOption>());
  for (const item of items) byId.current.set(item.id, item);

  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    if (value) map.set(value.id, { value: value.id, label: value.label });
    for (const item of items) if (!map.has(item.id)) map.set(item.id, { value: item.id, label: item.name });
    return [...map.values()];
  }, [items, value]);

  if (unavailable) {
    return (
      <TextInput
        label={label}
        description={description ?? t('pickers.resourceManualHint')}
        placeholder={t('pickers.resourceIdPlaceholder')}
        value={value?.id ?? ''}
        onChange={(e) => {
          const id = e.currentTarget.value.trim();
          onChange(id && type ? { type, id, label: id } : null);
        }}
        disabled={disabled || !type}
        error={error}
        spellCheck={false}
        autoComplete="off"
      />
    );
  }

  return (
    <Select
      label={label}
      description={description}
      placeholder={type ? (placeholder ?? t('pickers.resourceSearchPlaceholder')) : t('pickers.chooseTypeFirst')}
      data={data}
      value={value?.id ?? null}
      onChange={(id) => {
        if (!id || !type) {
          onChange(null);
          return;
        }
        const found = byId.current.get(id);
        onChange({ type, id, label: found?.name ?? value?.label ?? id });
      }}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options}
      clearable
      disabled={disabled || !type}
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
              {item?.key ? (
                <Text size="xs" c="dimmed" ff="monospace" truncate>
                  {item.key}
                </Text>
              ) : null}
            </div>
            {item?.projectName ? (
              <Text size="xs" c="dimmed" truncate>
                {item.projectName}
              </Text>
            ) : null}
          </Group>
        );
      }}
    />
  );
}
