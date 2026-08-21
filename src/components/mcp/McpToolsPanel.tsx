'use client';

/**
 * Tool enable/disable panel for an MCP server.
 *
 * Built for large tool sets (an OpenAPI import can bring 1000+ endpoints):
 * tools are grouped by path prefix, groups render rows only when expanded,
 * and every toggle edits a local draft that is persisted with a single
 * PATCH (full `disabledTools` replacement) on Save.
 *
 * Each row also opens an annotations editor — the MCP `ToolAnnotations` hints
 * strict clients (OpenAI's connector) require in `tools/list`.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Code,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAdjustments, IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react';
import type { IMcpToolAnnotations, McpSourceType } from '@/lib/database';
import {
  defaultAnnotationsForSource,
  resolveToolAnnotations,
} from '@/lib/services/mcp/toolAnnotations';

interface McpToolRow {
  name: string;
  description?: string;
  httpMethod?: string;
  httpPath?: string;
  annotations?: IMcpToolAnnotations;
  /** sourceType 'composite' only: which member server this tool routes to. */
  origin?: { serverId: string; serverKey: string; realName: string };
}

interface McpToolsPanelProps {
  serverId: string;
  tools: McpToolRow[];
  disabledTools: string[];
  sourceType?: McpSourceType;
  /** Operator overrides keyed by tool name. */
  toolAnnotations?: Record<string, IMcpToolAnnotations>;
  /** Operator-authored descriptions keyed by tool name. */
  toolDescriptions?: Record<string, string>;
  /** Operator-set exposed names, keyed by the real (discovered) tool name. */
  toolNames?: Record<string, string>;
  /** Receives the fresh server payload returned by the PATCH. */
  onServerUpdated: (server: unknown) => void;
}

const ANNOTATION_FLAGS = [
  {
    key: 'readOnlyHint' as const,
    label: 'Read-only',
    hint: 'The tool only reads data — no state is changed.',
  },
  {
    key: 'destructiveHint' as const,
    label: 'Destructive',
    hint: 'The tool may perform irreversible updates or deletions.',
  },
  {
    key: 'idempotentHint' as const,
    label: 'Idempotent',
    hint: 'Calling it repeatedly with the same arguments has no extra effect.',
  },
  {
    key: 'openWorldHint' as const,
    label: 'Open world',
    hint: 'The tool reaches systems outside this console (the public internet).',
  },
];

/** Mirrors the server-side charset check in mcpService.ts. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

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
  // Composite servers: group by the member server that owns the tool,
  // regardless of that member's own source shape.
  if (tool.origin) return tool.origin.serverKey;
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
  sourceType,
  toolAnnotations,
  toolDescriptions,
  toolNames,
  onServerUpdated,
}: McpToolsPanelProps) {
  const savedKey = useMemo(() => [...disabledTools].sort().join('\n'), [disabledTools]);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(disabledTools));
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [editingTool, setEditingTool] = useState<McpToolRow | null>(null);
  const [annDraft, setAnnDraft] = useState<IMcpToolAnnotations>({});
  const [descDraft, setDescDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [savingAnn, setSavingAnn] = useState(false);

  const overrides = useMemo(() => toolAnnotations ?? {}, [toolAnnotations]);
  const descOverrides = useMemo(() => toolDescriptions ?? {}, [toolDescriptions]);
  const nameOverrides = useMemo(() => toolNames ?? {}, [toolNames]);
  const sourceDefaults = useMemo(() => defaultAnnotationsForSource(sourceType), [sourceType]);
  const nameDraftTrimmed = nameDraft.trim();
  const nameDraftValid = !nameDraftTrimmed || TOOL_NAME_PATTERN.test(nameDraftTrimmed);

  const effectiveFor = (tool: McpToolRow, override: IMcpToolAnnotations | undefined) =>
    resolveToolAnnotations(
      { ...tool, annotations: { ...(tool.annotations ?? {}), ...(override ?? {}) } },
      sourceDefaults,
    );

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
          && !(t.description ?? '').toLowerCase().includes(query)
          && !(nameOverrides[t.name] ?? '').toLowerCase().includes(query)) {
          return false;
        }
        if (statusFilter === 'enabled' && draft.has(t.name)) return false;
        if (statusFilter === 'disabled' && !draft.has(t.name)) return false;
        return true;
      }),
    }))
    .filter((g) => g.visible.length > 0), [groups, query, statusFilter, draft, nameOverrides]);

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

  const openAnnotationEditor = (tool: McpToolRow) => {
    setEditingTool(tool);
    setAnnDraft({ ...(overrides[tool.name] ?? {}) });
    setDescDraft(descOverrides[tool.name] ?? '');
    setNameDraft(nameOverrides[tool.name] ?? '');
  };

  const handleSaveAnnotations = async () => {
    if (!editingTool) return;
    if (!nameDraftValid) {
      notifications.show({
        title: 'Invalid tool name',
        message: 'Use only letters, numbers, "_" and "-" (max 128 characters).',
        color: 'red',
      });
      return;
    }
    setSavingAnn(true);
    try {
      const payload = Object.keys(annDraft).length ? annDraft : null;
      const description = descDraft.trim();
      const name = nameDraftTrimmed;
      const res = await fetch(`/api/mcp/${serverId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolAnnotations: { [editingTool.name]: payload },
          toolDescriptions: { [editingTool.name]: description || null },
          toolNames: { [editingTool.name]: name || null },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save tool settings');
      onServerUpdated(data.server);
      setEditingTool(null);
      notifications.show({
        title: 'Tool settings saved',
        message: payload || description || name
          ? `Overrides applied to ${editingTool.name}`
          : `${editingTool.name} is back to its discovered definition`,
        color: 'teal',
      });
    } catch (err) {
      notifications.show({
        title: 'Save failed',
        message: err instanceof Error ? err.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setSavingAnn(false);
    }
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
                    {nameOverrides[tool.name] ? (
                      <Text size="xs" c="grape" ff="monospace">
                        → exposed as {nameOverrides[tool.name]}
                      </Text>
                    ) : null}
                    {tool.origin ? (
                      <Text size="xs" c="dimmed">
                        via <Text span ff="monospace">{tool.origin.serverKey}</Text>
                        {tool.origin.realName !== tool.name ? (
                          <> · <Text span ff="monospace">{tool.origin.realName}</Text> there</>
                        ) : null}
                      </Text>
                    ) : null}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed" lineClamp={1}>
                      {descOverrides[tool.name] || tool.description || '—'}
                    </Text>
                  </Table.Td>
                  <Table.Td width={150}>
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      {(() => {
                        const override = overrides[tool.name];
                        const effective = effectiveFor(tool, override);
                        return (
                          <Badge
                            size="sm"
                            variant={override || descOverrides[tool.name] ? 'filled' : 'light'}
                            color={effective.readOnlyHint ? 'teal' : effective.destructiveHint ? 'red' : 'gray'}
                          >
                            {effective.readOnlyHint ? 'read-only' : effective.destructiveHint ? 'destructive' : 'write'}
                          </Badge>
                        );
                      })()}
                      <Tooltip label="Edit description & annotations">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          onClick={() => openAnnotationEditor(tool)}
                          aria-label={`Edit settings for ${tool.name}`}
                        >
                          <IconAdjustments size={15} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
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

      <Modal
        opened={!!editingTool}
        onClose={() => setEditingTool(null)}
        title={`Tool settings · ${editingTool?.name ?? ''}`}
        size="lg"
      >
        {editingTool ? (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              What MCP clients see for this tool in <Code>tools/list</Code>. The description
              drives tool selection by the model; the hints tell clients such as OpenAI&apos;s
              connector whether a call needs approval. Leave a hint on <b>Auto</b> to keep the
              value Console derives from the tool definition.
            </Text>

            <Textarea
              label="Description"
              description="Overrides the description discovered from the spec or upstream server."
              placeholder={editingTool.description || 'No description discovered'}
              autosize
              minRows={3}
              maxRows={10}
              value={descDraft}
              onChange={(e) => setDescDraft(e.currentTarget.value)}
            />

            <TextInput
              label="Tool name"
              description={
                `The identifier MCP clients and agents call this tool by (default: "${editingTool.name}"). `
                + 'Must stay unique on this server; calls under the new name still run the same underlying tool.'
              }
              placeholder={editingTool.name}
              value={nameDraft}
              error={nameDraftValid ? undefined : 'Use only letters, numbers, "_" and "-" (max 128 characters).'}
              onChange={(e) => setNameDraft(e.currentTarget.value)}
            />

            <TextInput
              label="Title"
              description="Human-readable label shown by MCP clients (cosmetic — not the identifier used to call it)."
              placeholder={editingTool.name}
              value={annDraft.title ?? ''}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setAnnDraft((prev) => {
                  const next = { ...prev };
                  if (value.trim()) next.title = value;
                  else delete next.title;
                  return next;
                });
              }}
            />

            {ANNOTATION_FLAGS.map(({ key, label, hint }) => (
              <Group key={key} justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ flex: 1 }}>
                  <Text size="sm" fw={500}>{label}</Text>
                  <Text size="xs" c="dimmed">{hint}</Text>
                </div>
                <SegmentedControl
                  size="xs"
                  value={annDraft[key] === undefined ? 'auto' : annDraft[key] ? 'yes' : 'no'}
                  onChange={(v) => setAnnDraft((prev) => {
                    const next = { ...prev };
                    if (v === 'auto') delete next[key];
                    else next[key] = v === 'yes';
                    return next;
                  })}
                  data={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'yes', label: 'Yes' },
                    { value: 'no', label: 'No' },
                  ]}
                />
              </Group>
            ))}

            <Paper withBorder radius="md" p="sm">
              <Text size="xs" c="dimmed" mb={6}>Effective response</Text>
              <Code block>
                {JSON.stringify(
                  {
                    name: nameDraftTrimmed || editingTool.name,
                    description: descDraft.trim() || editingTool.description || '',
                    annotations: effectiveFor(editingTool, annDraft),
                  },
                  null,
                  2,
                )}
              </Code>
            </Paper>

            <Group justify="space-between">
              <Button
                variant="subtle"
                color="red"
                disabled={savingAnn || (!Object.keys(annDraft).length && !descDraft.trim() && !nameDraft.trim())}
                onClick={() => { setAnnDraft({}); setDescDraft(''); setNameDraft(''); }}
              >
                Reset to discovered
              </Button>
              <Group gap="xs">
                <Button variant="default" disabled={savingAnn} onClick={() => setEditingTool(null)}>
                  Cancel
                </Button>
                <Button loading={savingAnn} disabled={!nameDraftValid} onClick={() => void handleSaveAnnotations()}>
                  Save
                </Button>
              </Group>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </Stack>
  );
}
