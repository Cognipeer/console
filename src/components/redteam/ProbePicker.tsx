'use client';

/**
 * Grouped probe picker — replaces the flat MultiSelect with an OWASP-grouped,
 * searchable checklist. Probes are bucketed by their OWASP category, each row
 * carries a severity badge and description, and every group (plus the whole
 * catalog) has a select-all toggle. Custom probes get their own group so the
 * user can tell hand-authored attacks from the built-in catalog at a glance.
 */

import { useMemo, useState } from 'react';
import { Badge, Checkbox, Group, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { ProbeCatalogView } from './types';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'gray',
};

const CATEGORY_LABELS: Record<string, string> = {
  'LLM01-prompt-injection': 'LLM01 · Prompt Injection',
  'LLM02-insecure-output-handling': 'LLM02 · Insecure Output Handling',
  'LLM04-model-dos': 'LLM04 · Model Denial of Service',
  'LLM05-supply-chain': 'LLM05 · Supply Chain',
  'LLM06-sensitive-information-disclosure': 'LLM06 · Sensitive Information Disclosure',
  'LLM07-system-prompt-leakage': 'LLM07 · System Prompt Leakage',
  'LLM08-excessive-agency': 'LLM08 · Excessive Agency',
  'LLM09-overreliance': 'LLM09 · Overreliance',
};

const CUSTOM_GROUP = 'Custom probes';

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

interface Props {
  probes: ProbeCatalogView[];
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

export default function ProbePicker({ probes, value, onChange, emptyHint }: Props) {
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
            p.category.toLowerCase().includes(q),
        )
      : probes;
    return [...matches].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  }, [probes, search]);

  const groups = useMemo<ProbeGroup[]>(() => {
    const byGroup = new Map<string, ProbeCatalogView[]>();
    for (const p of filtered) {
      const groupKey = p.custom ? CUSTOM_GROUP : p.category;
      const list = byGroup.get(groupKey) ?? [];
      list.push(p);
      byGroup.set(groupKey, list);
    }
    // Built-in OWASP groups first (sorted by category), custom group last.
    const entries = [...byGroup.entries()];
    entries.sort(([a], [b]) => {
      if (a === CUSTOM_GROUP) return 1;
      if (b === CUSTOM_GROUP) return -1;
      return a.localeCompare(b);
    });
    return entries.map(([key, list]) => ({
      key,
      label: key === CUSTOM_GROUP ? CUSTOM_GROUP : categoryLabel(key),
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
          label={`Select all (${selected.size}/${allKeys.length})`}
          checked={allSelected}
          indeterminate={!allSelected && someSelected}
          onChange={(e) => setMany(allKeys, e.currentTarget.checked)}
        />
      </Group>

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
