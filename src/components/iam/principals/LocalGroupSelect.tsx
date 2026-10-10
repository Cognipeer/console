'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import { Group, Loader, MultiSelect, Select, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import { isAbortError, type PrincipalSummary } from './client';
import { directoryApi } from './directoryApi';

export interface GroupChoice {
  id: string;
  name: string;
}

interface LocalGroupSelectProps {
  /** Several groups, or exactly one. */
  multiple?: boolean;
  value: GroupChoice[];
  onChange: (next: GroupChoice[]) => void;
  /** Groups to leave out of the offer (the ones the person is already in). */
  exclude?: readonly string[];
  label?: string;
  description?: string;
  disabled?: boolean;
}

/**
 * Pick local groups through the server-side search. Directory groups are not
 * offered: their membership is reconciled by the directory and cannot be edited
 * here. Each option says what joining it gives (the group's role and size), because
 * a group's grants reach every member.
 */
export default function LocalGroupSelect({
  multiple,
  value,
  onChange,
  exclude = [],
  label,
  description,
  disabled,
}: LocalGroupSelectProps) {
  const t = useTranslations('iamDirectory');
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const [items, setItems] = useState<PrincipalSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    directoryApi
      .list({ type: 'group', q: debounced, limit: 20, filters: { source: 'local' } }, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setItems(page.items);
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setItems([]);
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced]);

  const known = useRef(new Map<string, PrincipalSummary>());
  for (const item of items) known.current.set(item.id, item);
  const names = useRef(new Map<string, string>());
  for (const item of items) names.current.set(item.id, item.label);
  for (const v of value) names.current.set(v.id, v.name);

  const excluded = useMemo(() => new Set(exclude), [exclude]);
  const data = useMemo(() => {
    const map = new Map<string, { value: string; label: string }>();
    for (const v of value) map.set(v.id, { value: v.id, label: v.name });
    for (const item of items) {
      if (!excluded.has(item.id) && !map.has(item.id)) map.set(item.id, { value: item.id, label: item.label });
    }
    return [...map.values()];
  }, [items, value, excluded]);

  const commonProps = {
    label,
    description,
    data,
    searchable: true as const,
    searchValue: search,
    onSearchChange: setSearch,
    filter: ({ options }: { options: unknown }) => options as never,
    disabled,
    placeholder: t('groupSelect.placeholder'),
    nothingFoundMessage: loading ? t('groupSelect.searching') : t('groupSelect.nothing'),
    rightSection: loading ? <Loader size={14} /> : undefined,
    maxDropdownHeight: 260,
    error: error ? t('groupSelect.failed') : undefined,
    renderOption: ({ option }: { option: { value: string; label: string } }) => {
      const hit = known.current.get(option.value);
      const impact = hit?.tenantRole ? t('groupSelect.givesRole', { role: t(`roles.${hit.tenantRole}`) }) : t('groupSelect.givesNoRole');
      return (
        <div style={{ minWidth: 0, width: '100%' }}>
          <Group gap="xs" justify="space-between" wrap="nowrap">
            <Text size="sm" truncate>
              {option.label}
            </Text>
            {typeof hit?.memberCount === 'number' ? (
              <Text size="xs" c="dimmed">
                {t('groupSelect.members', { count: hit.memberCount })}
              </Text>
            ) : null}
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {impact}
          </Text>
        </div>
      );
    },
  };

  if (multiple) {
    return (
      <MultiSelect
        {...commonProps}
        value={value.map((v) => v.id)}
        hidePickedOptions
        clearable
        onChange={(ids) => onChange(ids.map((id) => ({ id, name: names.current.get(id) ?? id })))}
      />
    );
  }
  return (
    <Select
      {...commonProps}
      value={value[0]?.id ?? null}
      clearable
      onChange={(id) => onChange(id ? [{ id, name: names.current.get(id) ?? id }] : [])}
    />
  );
}
