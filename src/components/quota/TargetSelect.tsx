'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { tryTranslate } from '@/components/resources/i18nLookup';
import { useTranslations } from '@/lib/i18n';
import type { QuotaTargetSource } from '@/lib/quota/targets';
import { PICKER_LIMIT, type FetchLike, type TargetOption } from './pickerSources';
import { useSearchBox } from './useSearchBox';
import { useTargetResolution, useTargetSearch } from './useTargetSearch';

export interface TargetSelectProps {
  /** What is searched and which value is stored: see `quotaTargetSource`. */
  source: QuotaTargetSource;
  /** The stored value (a limit's `scopeId`). */
  value?: string;
  /** The limit's project: picks between rows that store the same value in different projects. */
  projectId?: string;
  /** The new value (undefined = cleared) and the row it came from, which says where it lives. */
  onChange: (value: string | undefined, option?: TargetOption) => void;
  /** Called with the best known name of `value` (and again when a better one arrives). */
  onLabelChange?: (label: string | undefined) => void;
  disabled?: boolean;
  clearable?: boolean;
  /** Replaces `fetch`; for tests. */
  fetcher?: FetchLike;
}

/** What a dropdown entry is: a registry row, the value being typed, or the "first N of M" note. */
type Entry =
  | { value: string; label: string; row: TargetOption; kind: 'row' }
  | { value: string; label: string; row: TargetOption; kind: 'typed' }
  | { value: string; label: string; kind: 'more'; disabled: true };

/** Row ids are `type:id`, so this can never be one. */
const MORE = '__more__';

/** The row a stored value stands for when the registry can not (yet) say. */
function storedRow(source: QuotaTargetSource, value: string): TargetOption {
  return { id: `stored:${value}`, type: source.types[0] ?? 'resource', value, label: value };
}

/**
 * Pick the thing a limit points at, by searching the resource registry as you
 * type: a model, a vector index, a file bucket, a provider, an agent name. The
 * stored value is whatever the guard compares (`source.valueField`), never the
 * row's id; the option shows the human name with the key, the kind and the
 * project underneath, so two rows that share a key stay tellable apart.
 *
 *  - The first page is there before anything is typed; typing asks the server
 *    after a short pause, and the dropdown says when it shows only the first
 *    page of many.
 *  - Typing into a box that already holds a choice starts a fresh search (the
 *    name is replaced, not extended), and Enter picks the first, best-ranked
 *    result (see useSearchBox).
 *  - A saved value that no longer exists is kept and shown, with a note, never
 *    dropped (the limit would silently stop naming anything).
 *  - Someone who may not browse the registry gets a plain field for the value.
 */
export function TargetSelect({
  source,
  value,
  projectId,
  onChange,
  onLabelChange,
  disabled = false,
  clearable = true,
  fetcher,
}: TargetSelectProps) {
  const t = useTranslations('settings.quotaSection.target');
  const search = useTargetSearch(source, { fetcher });
  const [chosen, setChosen] = useState<TargetOption | null>(null);

  const justPicked = !!value && chosen?.value === value;
  const resolution = useTargetResolution(source, value || undefined, {
    skip: justPicked,
    preferProjectId: projectId,
    fetcher,
  });

  const selected = useMemo((): TargetOption | null => {
    if (!value) return null;
    if (chosen?.value === value) return chosen;
    if (resolution?.status === 'found') return resolution.option;
    const inPage = search.options.filter((option) => option.value === value);
    return inPage.find((option) => projectId && option.projectId === projectId) ?? inPage[0] ?? storedRow(source, value);
  }, [value, chosen, resolution, search.options, projectId, source]);

  // Report the name of the current value (the stored value itself until something better is known).
  const reportLabel = useRef(onLabelChange);
  reportLabel.current = onLabelChange;
  const currentLabel = selected?.label;
  useEffect(() => {
    reportLabel.current?.(currentLabel);
  }, [currentLabel]);

  // The box shows the stored value from the first paint; Mantine swaps in the name once it is known.
  const box = useSearchBox({
    label: currentLabel,
    value: selected?.id,
    initialText: value ?? '',
    onQuery: search.setQuery,
    enter: { ready: !search.loading && search.status === 'ok', results: search.options },
  });

  const searching = search.query.trim() !== '';
  /** The stored value, when the page of results does not hold it (it is kept selectable, but not offered while searching). */
  const pinnedId = selected && !search.options.some((row) => row.id === selected.id) ? selected.id : undefined;

  const entries = useMemo((): Entry[] => {
    const out: Entry[] = search.options.map((row) => ({ value: row.id, label: row.label, row, kind: 'row' }));
    // A value the registry does not know is legitimate for some targets (an SDK's agent name): offer what was typed.
    // After the registry rows, so that Enter picks the best-ranked row and not the words as typed.
    const query = search.query.trim();
    if (source.allowsUnregistered && query && !search.options.some((row) => row.value === query)) {
      const row: TargetOption = { id: `typed:${query}`, type: source.types[0] ?? 'resource', value: query, label: query };
      out.push({ value: row.id, label: query, row, kind: 'typed' });
    }
    // The stored value stays selectable whatever page the search returned.
    if (selected && !out.some((entry) => entry.value === selected.id)) {
      out.unshift({ value: selected.id, label: selected.label, row: selected, kind: 'row' });
    }
    if (search.total > search.options.length) {
      out.push({
        value: MORE,
        label: t('showingFirst', { count: search.options.length || PICKER_LIMIT, total: search.total }),
        kind: 'more',
        disabled: true,
      });
    }
    return out;
  }, [search.options, search.query, search.total, selected, source, t]);

  const noun = source.noun;
  const placeholder = t(`placeholder.${noun}`);

  // Registry closed to this person: the value can still be written by someone who knows it.
  if (search.status === 'unavailable' || resolution?.status === 'unavailable') {
    return (
      <TextInput
        placeholder={t('manualPlaceholder')}
        description={t('manualHint')}
        aria-label={t('manualPlaceholder')}
        value={value ?? ''}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
      />
    );
  }

  const missing = !!value && !justPicked && resolution?.status === 'missing';
  const kindWord = tryTranslate(t, `kind.${noun}`, 'settings.quotaSection.target') ?? noun;

  const handlePick = (id: string | null) => {
    const entry = id ? entries.find((candidate) => candidate.value === id) : undefined;
    if (!entry || entry.kind === 'more') {
      setChosen(null);
      onChange(undefined);
      return;
    }
    setChosen(entry.row);
    onChange(entry.row.value, entry.row);
  };

  const nothingFound = search.loading
    ? t('searching')
    : search.status === 'failed'
      ? t('searchFailed')
      : t(`empty.${noun}`);

  return (
    <Stack gap={4}>
      <Select
        data={entries}
        value={selected?.id ?? null}
        onChange={handlePick}
        searchable
        clearable={clearable}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={placeholder}
        // The server already chose and ordered the candidates: do not filter them a second time on the label.
        // The one thing left out is the stored value that is not among them, while somebody searches for something else.
        filter={({ options }) =>
          searching && pinnedId ? options.filter((option) => !('value' in option) || option.value !== pinnedId) : options
        }
        {...box.props}
        rightSection={search.loading ? <Loader size="xs" /> : undefined}
        nothingFoundMessage={nothingFound}
        maxDropdownHeight={280}
        renderOption={({ option }) => {
          const entry = option as unknown as Entry;
          if (entry.kind === 'more') {
            return (
              <Text size="xs" c="dimmed">
                {entry.label}
              </Text>
            );
          }
          if (entry.kind === 'typed') return <Text size="sm">{t('useTyped', { value: entry.label })}</Text>;
          // Several kinds searched together: say which one this is.
          const kind =
            source.types.length > 1
              ? tryTranslate(t, `types.${entry.row.type}`, 'settings.quotaSection.target') ?? entry.row.type
              : undefined;
          const facts = [kind, entry.row.description].filter(Boolean).join(' · ');
          return (
            <div>
              <Text size="sm">{entry.label}</Text>
              {facts ? (
                // Not `c="dimmed"`: a highlighted option is filled with the accent and its text turns white, and a fixed
                // grey would be unreadable on it. The shade follows the option's own colour instead.
                <Text size="xs" style={{ opacity: 0.72 }}>
                  {facts}
                </Text>
              ) : null}
            </div>
          );
        }}
      />
      {missing ? (
        <Text size="xs" c="orange" role="status">
          {source.allowsUnregistered
            ? t('unregistered', { value: value ?? '' })
            : t('notFound', { value: value ?? '', kind: kindWord })}
        </Text>
      ) : null}
    </Stack>
  );
}
