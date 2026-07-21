'use client';

/**
 * Tool enable/disable panel for an MCP server.
 *
 * Built for large tool sets (an OpenAPI import can bring 1000+ endpoints):
 * tools are grouped by path prefix, groups render rows only when expanded,
 * and every toggle edits a local draft that is persisted with a single
 * PATCH (full `disabledTools` replacement) on Save.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Center,
  Code,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';

interface McpToolRow {
  name: string;
  description?: string;
  httpMethod?: string;
  httpPath?: string;
}

interface McpToolsPanelProps {
  serverId: string;
  tools: McpToolRow[];
  disabledTools: string[];
  /** Receives the fresh server payload returned by the PATCH. */
  onServerUpdated: (server: unknown) => void;
}

/** Flat list below this size — grouping only helps at scale. */
const GROUP_THRESHOLD = 30;
/** Per-group render cap so a single huge group can't freeze the tab. */
const MAX_RENDERED_ROWS = 300;
/** Auto-expand every matching group while filtering, up to this many rows. */
const AUTO_EXPAND_LIMIT = 200;

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'teal',
  PUT: 'yellow',
  PATCH: 'orange',
  DELETE: 'red',
};

function groupKeyFor(tool: McpToolRow): string {
  if (tool.httpPath) {
    const seg = tool.httpPath.split('/').filter(Boolean)[0];
    return seg ? `/${seg}` : '/';
  }
  // Non-HTTP tools (remote/stdio): group by common name prefix, e.g. "github_*".
  const match = tool.name.match(/^([A-Za-z0-9]+)[._-]/);
  return match ? match[1] : 'other';
}

export default function McpToolsPanel({
  serverId,
  tools,
  disabledTools,
  onServerUpdated,
}: McpToolsPanelProps) {
  const savedKey = useMemo(() => [...disabledTools].sort().join('\n'), [disabledTools]);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(disabledTools));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Re-sync the draft whenever the persisted selection changes (save,
  // refresh-tools, spec update).
  useEffect(() => {
    setDraft(new Set(disabledTools));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey, serverId]);

  const dirty = useMemo(() => {
    if (draft.size !== disabledTools.length) return true;
    return disabledTools.some((n) => !draft.has(n));
  }, [draft, disabledTools]);

  const changeCount = useMemo(() => {
    const saved = new Set(disabledTools);
    let count = 0;
    draft.forEach((n) => { if (!saved.has(n)) count += 1; });
    saved.forEach((n) => { if (!draft.has(n)) count += 1; });
    return count;
  }, [draft, disabledTools]);

  const grouped = tools.length > GROUP_THRESHOLD;
  const hasHttp = useMemo(() => tools.some((t) => t.httpPath), [tools]);

  const groups = useMemo(() => {
    const map = new Map<string, McpToolRow[]>();
    for (const tool of tools) {
      const key = grouped ? groupKeyFor(tool) : 'all';
      const list = map.get(key);
      if (list) list.push(tool);
      else map.set(key, [tool]);
    }
    return [...map.entries()]
      .map(([key, items]) => ({
        key,
        items: items.slice().sort((a, b) =>
          (a.httpPath ?? a.name).localeCompare(b.httpPath ?? b.name)
          || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [tools, grouped]);

  const query = search.trim().toLowerCase();
  const filterActive = query.length > 0 || statusFilter !== 'all';

  const visibleGroups = useMemo(() => groups
    .map((g) => ({
      ...g,
      visible: g.items.filter((t) => {
        if (query
          && !t.name.toLowerCase().includes(query)
          && !(t.httpPath ?? '').toLowerCase().includes(query)
          && !(t.description ?? '').toLowerCase().includes(query)) {
          return false;
        }
        if (statusFilter === 'enabled' && draft.has(t.name)) return false;
        if (statusFilter === 'disabled' && !draft.has(t.name)) return false;
        return true;
      }),
    }))
    .filter((g) => g.visible.length > 0), [groups, query, statusFilter, draft]);

  const visibleCount = useMemo(
    () => visibleGroups.reduce((sum, g) => sum + g.visible.length, 0),
    [visibleGroups],
  );
  const enabledCount = tools.length - draft.size;
  const autoExpand = !grouped
    || visibleGroups.length === 1
    || (filterActive && visibleCount <= AUTO_EXPAND_LIMIT);

  const setMany = (names: string[], disabled: boolean) => {
    setDraft((prev) => {
      const next = new Set(prev);
      for (const n of names) {
        if (disabled) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/mcp/${serverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabledTools: [...draft] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save tool selection');
      onServerUpdated(data.server);
      const total = data.server?.tools?.length ?? tools.length;
      const disabled = data.server?.disabledTools?.length ?? 0;
      notifications.show({
        title: 'Tool selection saved',
        message: `${total - disabled} of ${total} tools enabled`,
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: 'Save failed',
        message: err instanceof Error ? err.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!tools.length) {
    return (
      <Paper withBorder radius="md">
        <Center p="xl">
          <Text c="dimmed">No tools discovered yet</Text>
        </Center>
      </Paper>
    );
  }

  const visibleNames = visibleGroups.flatMap((g) => g.visible.map((t) => t.name));
  const bulkLabel = filterActive ? `matching (${visibleCount})` : `all (${tools.length})`;

  const renderRows = (items: McpToolRow[]) => {
    const rendered = items.slice(0, MAX_RENDERED_ROWS);
    return (
      <>
        <Table horizontalSpacing="md" verticalSpacing={6}>
          <Table.Tbody>
            {rendered.map((tool) => {
              const isDisabled = draft.has(tool.name);
              return (
                <Table.Tr key={tool.name} style={isDisabled ? { opacity: 0.55 } : undefined}>
                  <Table.Td width={52}>
                    <Switch
                      size="sm"
                      checked={!isDisabled}
                      onChange={(e) => setMany([tool.name], !e.currentTarget.checked)}
                      aria-label={`Toggle ${tool.name}`}
                    />
                  </Table.Td>
                  {hasHttp ? (
                    <Table.Td width={80}>
                      {tool.httpMethod ? (
                        <Badge size="sm" variant="light" color={METHOD_COLORS[tool.httpMethod] ?? 'gray'}>
                          {tool.httpMethod}
                        </Badge>
                      ) : null}
                    </Table.Td>
                  ) : null}
                  <Table.Td>
                    <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {tool.httpPath ?? tool.name}
                    </Text>
                    {tool.httpPath ? (
                      <Text size="xs" c="dimmed" ff="monospace">{tool.name}</Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" lineClamp={1}>
                      {tool.description || '—'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
        {items.length > rendered.length ? (
          <Text size="xs" c="dimmed" p="sm">
            Showing first {rendered.length} of {items.length} — refine the search to see the rest.
            Bulk actions still apply to every matching tool.
          </Text>
        ) : null}
      </>
    );
  };

  return (
    <Stack gap="sm">
      <Paper withBorder radius="md" p="sm">
        <Group justify="space-between" wrap="wrap" gap="sm">
          <Group gap="xs">
            <Badge size="lg" variant="light" color={draft.size ? 'yellow' : 'teal'}>
              {enabledCount} / {tools.length} enabled
            </Badge>
            {filterActive ? (
              <Text size="xs" c="dimmed">{visibleCount} match</Text>
            ) : null}
          </Group>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              disabled={!visibleNames.length}
              onClick={() => setMany(visibleNames, false)}
            >
              Enable {bulkLabel}
            </Button>
            <Button
              size="xs"
              variant="default"
              color="red"
              disabled={!visibleNames.length}
              onClick={() => setMany(visibleNames, true)}
            >
              Disable {bulkLabel}
            </Button>
          </Group>
        </Group>
        <Group mt="sm" gap="sm" wrap="wrap">
          <TextInput
            size="xs"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Search by name, path or description…"
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
          <SegmentedControl
            size="xs"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as 'all' | 'enabled' | 'disabled')}
            data={[
              { value: 'all', label: 'All' },
              { value: 'enabled', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ]}
          />
        </Group>
      </Paper>

      {dirty ? (
        <Paper
          withBorder
          radius="md"
          p="sm"
          style={{
            position: 'sticky',
            top: 8,
            zIndex: 5,
            borderColor: 'var(--mantine-color-yellow-5)',
            background: 'var(--mantine-color-body)',
          }}
        >
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {changeCount} unsaved tool {changeCount === 1 ? 'change' : 'changes'}
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                variant="default"
                disabled={saving}
                onClick={() => setDraft(new Set(disabledTools))}
              >
                Discard
              </Button>
              <Button size="xs" loading={saving} onClick={() => void handleSave()}>
                Save changes
              </Button>
            </Group>
          </Group>
        </Paper>
      ) : null}

      {!visibleGroups.length ? (
        <Paper withBorder radius="md">
          <Center p="xl">
            <Text c="dimmed">No tools match the current filter</Text>
          </Center>
        </Paper>
      ) : visibleGroups.map((g) => {
        const isExpanded = autoExpand || expanded.has(g.key);
        const groupDisabled = g.visible.filter((t) => draft.has(t.name)).length;
        const groupEnabled = g.visible.length - groupDisabled;
        return (
          <Paper key={g.key} withBorder radius="md" style={{ overflow: 'hidden' }}>
            {grouped ? (
              <Group
                justify="space-between"
                px="md"
                py={8}
                style={{ borderBottom: isExpanded ? '1px solid var(--mantine-color-default-border)' : undefined }}
              >
                <UnstyledButton onClick={() => toggleGroup(g.key)} style={{ flex: 1 }}>
                  <Group gap="xs">
                    {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                    <Code fw={600}>{g.key}</Code>
                    <Badge size="sm" variant="light" color={groupDisabled === 0 ? 'teal' : groupEnabled === 0 ? 'red' : 'yellow'}>
                      {groupEnabled}/{g.visible.length} enabled
                    </Badge>
                  </Group>
                </UnstyledButton>
                <Group gap={6}>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setMany(g.visible.map((t) => t.name), false)}
                  >
                    Enable
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => setMany(g.visible.map((t) => t.name), true)}
                  >
                    Disable
                  </Button>
                </Group>
              </Group>
            ) : null}
            {isExpanded ? renderRows(g.visible) : null}
          </Paper>
        );
      })}
    </Stack>
  );
}
