import { useEffect, useState } from 'react';
import { MultiSelect, TagsInput } from '@mantine/core';
import type { DynamicRoutingSignal } from '@/lib/database';

/** Caller-context signals a Dynamic LLM rule can test (compared with in / not_in). */
export const CALLER_SIGNAL_VALUES: ReadonlyArray<DynamicRoutingSignal> = [
  'channel',
  'userId',
  'groupIds',
  'agentKey',
  'portalKey',
  'apiTokenId',
  'projectId',
];

export function isCallerSignal(signal: string): boolean {
  return (CALLER_SIGNAL_VALUES as ReadonlyArray<string>).includes(signal);
}

export const CHANNEL_OPTIONS = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'portal', label: 'Portal' },
  { value: 'messaging', label: 'Slack / Teams' },
  { value: 'api', label: 'API' },
  { value: 'embed', label: 'Embed' },
  { value: 'a2a', label: 'A2A' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'playground', label: 'Playground' },
];

export interface IdentityOption {
  value: string;
  label: string;
}

export interface IdentityOptions {
  userId: IdentityOption[];
  groupIds: IdentityOption[];
  agentKey: IdentityOption[];
  apiTokenId: IdentityOption[];
  projectId: IdentityOption[];
}

const EMPTY: IdentityOptions = { userId: [], groupIds: [], agentKey: [], apiTokenId: [], projectId: [] };

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

async function load(url: string, listKey: string): Promise<Row[]> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return [];
  const data = (await res.json()) as Row;
  return Array.isArray(data[listKey]) ? (data[listKey] as Row[]) : [];
}

/** Loads the pickers' options from the existing dashboard APIs (each failure just leaves that list empty). */
export function useIdentityOptions(enabled: boolean): IdentityOptions {
  const [options, setOptions] = useState<IdentityOptions>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void Promise.allSettled([
      load('/api/users', 'users'),
      load('/api/groups', 'groups'),
      load('/api/agents', 'agents'),
      load('/api/tokens?scope=project', 'tokens'),
      load('/api/projects', 'projects'),
    ]).then(([users, groups, agents, tokens, projects]) => {
      if (cancelled) return;
      const rows = (r: PromiseSettledResult<Row[]>) => (r.status === 'fulfilled' ? r.value : []);
      const pick = (list: Row[], idKeys: string[], labelKeys: string[]): IdentityOption[] =>
        list.flatMap((row) => {
          const value = idKeys.map((k) => (row[k] == null ? undefined : String(row[k]))).find(Boolean);
          if (!value) return [];
          const label = labelKeys.map((k) => str(row[k])).find(Boolean) ?? value;
          return [{ value, label: label === value ? value : `${label} (${value.slice(0, 8)})` }];
        });
      setOptions({
        userId: pick(rows(users), ['_id', 'id'], ['name', 'email']),
        groupIds: pick(rows(groups), ['_id', 'id'], ['name']),
        agentKey: rows(agents).flatMap((a) => {
          const key = str(a.key);
          return key ? [{ value: key, label: str(a.name) ? `${a.name as string} (${key})` : key }] : [];
        }),
        apiTokenId: pick(rows(tokens), ['_id', 'id'], ['label', 'name']),
        projectId: pick(rows(projects), ['_id', 'id'], ['name']),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return options;
}

const splitValue = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

/** Searchable multi-select (or free tags for portal keys) for one caller condition's value. */
export function CallerValueField({
  signal,
  value,
  onChange,
  options,
}: {
  signal: DynamicRoutingSignal;
  value: string;
  onChange: (value: string) => void;
  options: IdentityOptions;
}) {
  const selected = splitValue(value);
  if (signal === 'portalKey') {
    // Portals are an EE module with no listing API here: keys are typed.
    return (
      <TagsInput
        size="xs"
        placeholder="portal key, Enter to add"
        value={selected}
        onChange={(v) => onChange(v.join(','))}
      />
    );
  }
  const data =
    signal === 'channel' ? CHANNEL_OPTIONS : options[signal as keyof IdentityOptions] ?? [];
  // Keep ids that are no longer listed visible, so an old rule can still be edited.
  const known = new Set(data.map((d) => d.value));
  const merged = [...data, ...selected.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
  return (
    <MultiSelect
      size="xs"
      searchable
      clearable
      placeholder="Select…"
      data={merged}
      value={selected}
      onChange={(v) => onChange(v.join(','))}
    />
  );
}

const SIGNAL_NOUN: Record<string, string> = {
  channel: 'channel',
  userId: 'user',
  groupIds: 'group',
  agentKey: 'agent',
  portalKey: 'portal',
  apiTokenId: 'API token',
  projectId: 'project',
};

/** "channel in Portal" / "group not in Pro, Staff" for the rule preview line. */
export function describeCallerCondition(
  signal: DynamicRoutingSignal,
  operator: string,
  value: string,
  options: IdentityOptions,
): string {
  const labelOf = (v: string) => {
    if (signal === 'channel') return CHANNEL_OPTIONS.find((o) => o.value === v)?.label.toLowerCase() ?? v;
    const hit = options[signal as keyof IdentityOptions]?.find((o) => o.value === v);
    return hit ? hit.label.replace(/ \([^)]*\)$/, '') : v;
  };
  const list = splitValue(value).map(labelOf).join(', ') || '…';
  return `${SIGNAL_NOUN[signal] ?? signal} ${operator === 'not_in' ? 'not in' : 'in'} ${list}`;
}
