'use client';

/**
 * Grouped probe picker — replaces the flat MultiSelect with an OWASP-grouped,
 * searchable checklist. Probes are bucketed by their OWASP category, each row
 * carries a severity badge and description, and every group (plus the whole
 * catalog) has a select-all toggle. Custom probes get their own group so the
 * user can tell hand-authored attacks from the built-in catalog at a glance.
 */

import { useMemo, useState } from 'react';
import { Badge, Checkbox, Group, Pill, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { OWASP_LLM_CATEGORIES, normalizeOwaspCategory, owaspCategoryLabel } from '@/lib/services/redteam/owasp';
import { missingProbeKeys, selectedDisabledProbes } from './helpers';
import { SEVERITY_COLOR, SEVERITY_ORDER } from './severity';
import type { DisabledProbeView, ProbeCatalogView } from './types';

const CUSTOM_GROUP = 'Custom probes';

/** Position in the OWASP 2025 list; a category outside it sorts after the list. */
function categoryRank(category: string): number {
  const at = (OWASP_LLM_CATEGORIES as readonly string[]).indexOf(category);
  return at === -1 ? OWASP_LLM_CATEGORIES.length : at;
}

interface Props {
  probes: ProbeCatalogView[];
  /** Custom probes that exist but are switched off. */
  disabledProbes?: DisabledProbeView[];
  value: string[];
  onChange: (keys: string[]) => void;
  /** Note shown when nothing is selected (e.g. "runs the full built-in catalog"). */
  emptyHint?: string;
}

interface ProbeGroup {
  key: string;
  label: string;
  probes: ProbeCatalogView[];
}

export default function ProbePicker({ probes, disabledProbes, value, onChange, emptyHint }: Props) {
  const [search, setSearch] = useState('');
  const selected = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = q
      ? probes.filter(
          (p) =>
            p.key.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            normalizeOwaspCategory(p.category).toLowerCase().includes(q) ||
            owaspCategoryLabel(p.category).toLowerCase().includes(q),
        )
      : probes;
    return [...matches].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  }, [probes, search]);

  const groups = useMemo<ProbeGroup[]>(() => {
    const byGroup = new Map<string, ProbeCatalogView[]>();
    for (const p of filtered) {
      const groupKey = p.custom ? CUSTOM_GROUP : normalizeOwaspCategory(p.category);
      const list = byGroup.get(groupKey) ?? [];
      list.push(p);
      byGroup.set(groupKey, list);
    }
    // Built-in OWASP groups first (sorted by category), custom group last.
    const entries = [...byGroup.entries()];
    entries.sort(([a], [b]) => {
      if (a === CUSTOM_GROUP) return 1;
      if (b === CUSTOM_GROUP) return -1;
      return categoryRank(a) - categoryRank(b) || a.localeCompare(b);
    });
    return entries.map(([key, list]) => ({
      key,
      label: key === CUSTOM_GROUP ? CUSTOM_GROUP : owaspCategoryLabel(key),
      probes: list,
    }));
  }, [filtered]);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };

  const setMany = (keys: string[], on: boolean) => {
    const next = new Set(selected);
    for (const k of keys) {
      if (on) next.add(k);
      else next.delete(k);
    }
    onChange([...next]);
  };

  const allKeys = useMemo(() => probes.map((p) => p.key), [probes]);
  // Selected keys the catalog no longer has (a custom probe that was deleted). Only judged once the catalog has loaded,
  // otherwise every selection would flash as deleted.
  const disabledKeys = useMemo(() => (disabledProbes ?? []).map((d) => d.key), [disabledProbes]);
  const missing = useMemo(
    () => (probes.length > 0 ? missingProbeKeys(value, allKeys, disabledKeys) : []),
    [value, allKeys, disabledKeys, probes.length],
  );
  const selectedDisabled = useMemo(() => selectedDisabledProbes(value, disabledProbes), [value, disabledProbes]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected = allKeys.some((k) => selected.has(k));

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <TextInput
          size="xs"
          placeholder="Search probes…"
          leftSection={<IconSearch size={13} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <Checkbox
          size="xs"
          label={`Select all (${allKeys.filter((k) => selected.has(k)).length}/${allKeys.length})`}
          checked={allSelected}
          indeterminate={!allSelected && someSelected}
          onChange={(e) => setMany(allKeys, e.currentTarget.checked)}
        />
      </Group>

      {selectedDisabled.length > 0 ? (
        <Group gap={6} data-testid="redteam-disabled-probes">
          {selectedDisabled.map((d) => (
            <Pill
              key={d.key}
              size="sm"
              withRemoveButton
              onRemove={() => onChange(value.filter((k) => k !== d.key))}
              removeButtonProps={{ 'aria-label': `Remove disabled probe ${d.name}` }}
            >
              {d.name} · disabled
            </Pill>
          ))}
          <Text size="xs" c="dimmed">Skipped while disabled.</Text>
        </Group>
      ) : null}

      {missing.length > 0 ? (
        <Group gap={6} data-testid="redteam-deleted-probes">
          <Text size="xs" c="dimmed">No longer exist:</Text>
          {missing.map((key) => (
            <Pill
              key={key}
              size="sm"
              withRemoveButton
              onRemove={() => onChange(value.filter((k) => k !== key))}
              removeButtonProps={{ 'aria-label': `Remove deleted probe ${key}` }}
            >
              {key} · deleted probe
            </Pill>
          ))}
        </Group>
      ) : null}

      <Text size="xs" c="dimmed">OWASP Top 10 for LLM Applications (2025)</Text>

      <ScrollArea.Autosize mah={340} type="auto">
        <Stack gap="sm" pr="sm">
          {groups.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">No probes match “{search}”.</Text>
          ) : (
            groups.map((group) => {
              const keys = group.probes.map((p) => p.key);
              const groupAll = keys.every((k) => selected.has(k));
              const groupSome = keys.some((k) => selected.has(k));
              return (
                <div key={group.key}>
                  <Group justify="space-between" align="center" mb={4}>
                    <Checkbox
                      size="xs"
                      checked={groupAll}
                      indeterminate={!groupAll && groupSome}
                      onChange={(e) => setMany(keys, e.currentTarget.checked)}
                      label={
                        <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.4 }}>
                          {group.label}
                        </Text>
                      }
                    />
                  </Group>
                  <Stack gap={2} pl="md">
                    {group.probes.map((p) => (
                      <Group
                        key={p.key}
                        align="flex-start"
                        gap="xs"
                        wrap="nowrap"
                        style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 6 }}
                        onClick={() => toggle(p.key)}
                      >
                        <Checkbox
                          size="xs"
                          checked={selected.has(p.key)}
                          aria-label={p.name}
                          onChange={() => toggle(p.key)}
                          onClick={(e) => e.stopPropagation()}
                          mt={2}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Group gap={6} wrap="nowrap">
                            <Text size="sm" fw={500} truncate>{p.name}</Text>
                            <Badge size="xs" variant="light" color={SEVERITY_COLOR[p.severity] ?? 'gray'}>
                              {p.severity}
                            </Badge>
                            {p.custom ? <Badge size="xs" variant="outline" color="teal">custom</Badge> : null}
                          </Group>
                          {p.description ? (
                            <Text size="xs" c="dimmed" lineClamp={2}>{p.description}</Text>
                          ) : null}
                        </div>
                      </Group>
                    ))}
                  </Stack>
                </div>
              );
            })
          )}
        </Stack>
      </ScrollArea.Autosize>

      {selected.size === 0 && emptyHint ? (
        <Text size="xs" c="dimmed">{emptyHint}</Text>
      ) : null}
    </Stack>
  );
}
