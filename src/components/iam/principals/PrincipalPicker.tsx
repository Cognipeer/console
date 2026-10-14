'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Loader, SegmentedControl, Select, Stack, Text, type ComboboxItem, type MantineSize } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslations } from '@/lib/i18n';
import {
  fetchPrincipals,
  isAbortError,
  PRINCIPAL_TYPES,
  type PrincipalRef,
  type PrincipalSummary,
  type PrincipalType,
} from './client';
import { PrincipalIcon } from './visuals';

interface PrincipalPickerProps {
  value: PrincipalRef | null;
  onChange: (value: PrincipalRef | null) => void;
  /** Principal types on offer; the first one is the initial type. Default: all. */
  types?: readonly PrincipalType[];
  size?: MantineSize;
  /** Accessible name of the search box. */
  ariaLabel?: string;
  placeholder?: string;
}

const RESULT_LIMIT = 15;

/**
 * Search-as-you-type principal selector (server-side search, so it stays fast on
 * a directory of tens of thousands of users). A type switch narrows the search
 * to users, groups or API tokens; the selected principal is reported as
 * `{ type, id, label }`. Nothing is fetched until the dropdown is opened.
 */
export default function PrincipalPicker({
  value,
  onChange,
  types = PRINCIPAL_TYPES,
  size = 'xs',
  ariaLabel,
  placeholder,
}: PrincipalPickerProps) {
  const t = useTranslations('iamPrincipals');
  const offered = types.length > 0 ? types : PRINCIPAL_TYPES;
  const [picked, setType] = useState<PrincipalType>(value?.type ?? offered[0] ?? 'user');
  // The offered types can change under a mounted picker; never sit on one that is gone.
  const type = offered.includes(picked) ? picked : (offered[0] ?? 'user');
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 250);
  const [active, setActive] = useState(false);
  const [results, setResults] = useState<PrincipalSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // Follow an external change of the value (a filter restored from the URL).
  const valueType = value?.type;
  useEffect(() => {
    if (valueType) setType(valueType);
  }, [valueType]);

  // While closed the input shows the selected label; do not search for it.
  const searchTerm = value && debounced === value.label ? '' : debounced;

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const mine = ++seq.current;
    setLoading(true);
    fetchPrincipals({ type, q: searchTerm, limit: RESULT_LIMIT }, controller.signal)
      .then((page) => {
        if (mine === seq.current && !controller.signal.aborted) setResults(page.items);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err) && mine === seq.current) setResults([]);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    return () => controller.abort();
  }, [active, type, searchTerm]);

  const data = useMemo<ComboboxItem[]>(() => {
    const items = results.map((p) => ({ value: p.id, label: p.label }));
    if (value && value.type === type && !items.some((i) => i.value === value.id)) {
      items.unshift({ value: value.id, label: value.label });
    }
    return items;
  }, [results, value, type]);

  const detail = useMemo(() => new Map(results.map((p) => [p.id, p])), [results]);

  const handleChange = useCallback(
    (id: string | null) => {
      if (!id) {
        onChange(null);
        return;
      }
      const hit = detail.get(id);
      onChange({ type, id, label: hit?.label ?? (value?.id === id ? value.label : id) });
    },
    [detail, onChange, type, value],
  );

  const handleTypeChange = (next: string) => {
    const nextType = next as PrincipalType;
    setType(nextType);
    setResults([]);
    if (value && value.type !== nextType) onChange(null);
  };

  return (
    <Group gap="xs" wrap="nowrap" align="center">
      {offered.length > 1 ? (
        <SegmentedControl
          size={size}
          value={type}
          onChange={handleTypeChange}
          aria-label={t('picker.type')}
          data={offered.map((p) => ({ value: p, label: t(`types.${p}`) }))}
        />
      ) : null}
      <Select
        size={size}
        style={{ flex: '1 1 0', minWidth: 0 }}
        searchable
        clearable
        value={value && value.type === type ? value.id : null}
        data={data}
        onChange={handleChange}
        onSearchChange={setSearch}
        onDropdownOpen={() => setActive(true)}
        onDropdownClose={() => setActive(false)}
        filter={({ options }) => options}
        placeholder={placeholder ?? t('picker.placeholder')}
        aria-label={ariaLabel ?? t('picker.search')}
        nothingFoundMessage={loading ? t('picker.searching') : t('picker.nothing')}
        leftSection={<PrincipalIcon type={type} size={14} />}
        rightSection={loading && !value ? <Loader size={12} /> : undefined}
        renderOption={({ option }) => {
          const hit = detail.get(option.value);
          return (
            <Stack gap={0}>
              <Text size="sm">{option.label}</Text>
              {hit?.sublabel ? (
                <Text size="xs" c="dimmed">
                  {hit.sublabel}
                </Text>
              ) : null}
            </Stack>
          );
        }}
        comboboxProps={{ withinPortal: true }}
      />
    </Group>
  );
}
