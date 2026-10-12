'use client';

import { useMemo, type ReactNode } from 'react';
import {
  Select,
  Text,
  type ComboboxItem,
  type ComboboxItemGroup,
  type ComboboxParsedItem,
  type OptionsFilter,
} from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import type { CatalogIndex } from '../catalogModel';
import { LEVELS, matchesQuery } from '../catalogModel';
import type { IamLabels } from '../useIamLabels';

interface ActionSelectProps {
  index: CatalogIndex;
  labels: IamLabels;
  value: string | null;
  onChange: (next: string | null) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  error?: ReactNode;
}

/**
 * One concrete catalog action (service or resource action, grouped by service).
 * The level groups `Read` / `Write` / `Admin` are policy shortcuts, not
 * requestable actions, so they are not offered here.
 */
export default function ActionSelect({
  index,
  labels,
  value,
  onChange,
  label,
  description,
  disabled,
  required,
  error,
}: ActionSelectProps) {
  const t = useTranslations('iamCenter');

  const data = useMemo<ComboboxItemGroup[]>(() => {
    const groups: ComboboxItemGroup[] = [];
    for (const service of index.services) {
      const items: ComboboxItem[] = [];
      const levels = index.serviceActions.get(service.id);
      for (const level of LEVELS) {
        const action = levels?.[level];
        if (action) items.push({ value: action.id, label: labels.action(action.id) });
      }
      for (const action of index.resourceActions.get(service.id) ?? []) {
        items.push({ value: action.id, label: labels.action(action.id) });
      }
      if (items.length > 0) groups.push({ group: labels.service(service.id), items });
    }
    return groups;
  }, [index, labels]);

  const filter: OptionsFilter = ({ options, search }) => {
    const q = search.trim();
    if (!q) return options;
    const matches = (item: ComboboxItem) => matchesQuery(`${item.label} ${item.value}`, q);
    const out: ComboboxParsedItem[] = [];
    for (const option of options) {
      if ('group' in option) {
        const items = option.items.filter(matches);
        if (items.length > 0) out.push({ group: option.group, items });
      } else if (matches(option)) {
        out.push(option);
      }
    }
    return out;
  };

  return (
    <Select
      label={label}
      description={description}
      placeholder={t('check.actionPlaceholder')}
      data={data}
      value={value}
      onChange={onChange}
      filter={filter}
      searchable
      clearable
      limit={120}
      maxDropdownHeight={320}
      nothingFoundMessage={t('pickers.nothingFound')}
      disabled={disabled}
      required={required}
      error={error}
      renderOption={({ option }) => (
        <div style={{ minWidth: 0 }}>
          <Text size="sm" truncate>
            {option.label}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace" truncate>
            {option.value}
          </Text>
        </div>
      )}
    />
  );
}
