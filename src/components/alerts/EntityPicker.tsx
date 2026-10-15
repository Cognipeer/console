'use client';

import { useEffect, useMemo, useState } from 'react';
import { Group, TagsInput, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useLocale, useTranslations } from '@/lib/i18n';
import { entityTypeLabel } from './alertCatalog';
import type { EntityMetricType } from './alertTypes';

const MAX_KEYS = 50;
const MAX_KEY_LENGTH = 200;

interface EntitySuggestion {
  key: string;
  requests: number;
  lastSeenMs: number;
}

export interface EntityPickerProps {
  entityType: EntityMetricType;
  /** Selected entity keys (agent names, model keys, ...). */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  error?: string;
}

/**
 * Multi-select of the entities that have data in this project (`GET /alerts/entities`,
 * searched server-side) that also accepts free text: an entity that has not reported
 * yet can be alerted on by name.
 */
export default function EntityPicker({ entityType, value, onChange, disabled, error }: EntityPickerProps) {
  const t = useTranslations('alerts');
  const locale = useLocale();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const [suggestions, setSuggestions] = useState<EntitySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ entityType, limit: '50' });
    if (debounced.trim()) params.set('q', debounced.trim());
    fetch(`/api/alerts/entities?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { entities?: EntitySuggestion[] };
        setSuggestions(Array.isArray(data.entities) ? data.entities : []);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setSuggestions([]);
        setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [entityType, debounced]);

  const requestsByKey = useMemo(() => new Map(suggestions.map((entry) => [entry.key, entry.requests])), [suggestions]);
  const data = useMemo(() => suggestions.map((entry) => entry.key), [suggestions]);

  return (
    <TagsInput
      label={t('target.pickerLabel', { type: entityTypeLabel(entityType, t, true) })}
      description={failed ? t('target.pickerUnavailable') : t('target.pickerHint')}
      placeholder={value.length === 0 ? t('target.pickerPlaceholder', { type: entityTypeLabel(entityType, t) }) : undefined}
      data={data}
      value={value}
      searchValue={search}
      onSearchChange={setSearch}
      maxTags={MAX_KEYS}
      disabled={disabled}
      error={error}
      clearable
      acceptValueOnBlur
      splitChars={[';', '\n']}
      rightSection={loading ? <Text size="xs" c="dimmed">…</Text> : undefined}
      renderOption={({ option }) => {
        const requests = requestsByKey.get(option.value);
        return (
          <Group justify="space-between" wrap="nowrap" style={{ width: '100%' }} gap="sm">
            <Text size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {option.value}
            </Text>
            {requests !== undefined ? (
              <Text size="xs" c="dimmed">
                {t('target.pickerRequests', { count: requests.toLocaleString(locale) })}
              </Text>
            ) : null}
          </Group>
        );
      }}
      onChange={(next) =>
        onChange(
          [...new Set(next.map((key) => key.trim().slice(0, MAX_KEY_LENGTH)).filter(Boolean))].slice(0, MAX_KEYS),
        )
      }
    />
  );
}
