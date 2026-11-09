'use client';

/**
 * Grouped probe picker: a searchable checklist in four groups (built-in default
 * set, more built-in probes, custom, imported). Each row shows severity, the
 * OWASP category and what the probe works with. On an agent campaign a probe
 * that cannot run against agents is dimmed and says so (it stays selectable).
 * A menu selects every probe of one OWASP category at once.
 */

import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Group, Menu, Pill, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconSearch } from '@tabler/icons-react';
import { OWASP_LLM_CATEGORIES, normalizeOwaspCategory, owaspCategoryLabel } from '@/lib/services/redteam/owasp';
import {
  agentFit,
  defaultSetNote,
  groupPickerProbes,
  isNewProbe,
  keysInCategory,
  missingProbeKeys,
  selectedDisabledProbes,
  worksWithLabels,
} from './helpers';
import { SEVERITY_COLOR, SEVERITY_ORDER } from './severity';
import type { DisabledProbeView, ProbeCatalogView, RedTeamTargetKind } from './types';

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
  /** Overrides the note shown when nothing is selected; by default it names the default set. */
  emptyHint?: string;
  /** The campaign's target: on an agent, probes that cannot run there are marked. */
  targetKind?: RedTeamTargetKind;
}

export default function ProbePicker({ probes, disabledProbes, value, onChange, emptyHint, targetKind }: Props) {
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
    return [...matches].sort(
      (a, b) =>
        categoryRank(normalizeOwaspCategory(a.category)) - categoryRank(normalizeOwaspCategory(b.category)) ||
        (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
    );
  }, [probes, search]);

  const groups = useMemo(() => groupPickerProbes(filtered), [filtered]);

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
  const categories = useMemo(() => {
    const seen = new Set(probes.map((p) => normalizeOwaspCategory(p.category)));
    return [...seen].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
  }, [probes]);
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
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button size="compact-xs" variant="default" rightSection={<IconChevronDown size={12} />}>Select all in…</Button>
          </Menu.Target>
          <Menu.Dropdown>
            {categories.map((c) => {
              const keys = keysInCategory(probes, c);
              return (
                <Menu.Item key={c} onClick={() => setMany(keys, !keys.every((k) => selected.has(k)))}>
                  {owaspCategoryLabel(c)} ({keys.filter((k) => selected.has(k)).length}/{keys.length})
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
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
                <div key={group.id} data-testid={`redteam-picker-group-${group.id}`}>
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
                    {group.probes.map((p) => {
                      const fit = targetKind === 'agent' ? agentFit(p) : ({ kind: 'full' } as const);
                      const works = worksWithLabels(p);
                      return (
                        <Group
                          key={p.key}
                          align="flex-start"
                          gap="xs"
                          wrap="nowrap"
                          style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: 6, opacity: fit.kind === 'none' ? 0.55 : 1 }}
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
                              {isNewProbe(p.addedAt) ? <Badge size="xs" variant="filled" color="teal">NEW</Badge> : null}
                              {p.custom && p.origin !== 'import' ? <Badge size="xs" variant="outline" color="teal">custom</Badge> : null}
                            </Group>
                            <Text size="xs" c="dimmed" truncate>
                              {owaspCategoryLabel(p.category)}
                              {works.length > 0 ? ` · ${works.join(' · ')}` : ''}
                            </Text>
                            {p.description ? (
                              <Text size="xs" c="dimmed" lineClamp={2}>{p.description}</Text>
                            ) : null}
                            {fit.kind !== 'full' ? (
                              <Text size="xs" c={fit.kind === 'none' ? 'orange.8' : 'dimmed'} data-testid="redteam-picker-agent-note">{fit.text}</Text>
                            ) : null}
                          </div>
                        </Group>
                      );
                    })}
                  </Stack>
                </div>
              );
            })
          )}
        </Stack>
      </ScrollArea.Autosize>

      {selected.size === 0 ? (
        <Text size="xs" c="dimmed">{emptyHint ?? defaultSetNote(probes)}</Text>
      ) : null}
    </Stack>
  );
}
