'use client';

import { useState, useEffect, useCallback } from 'react';
import CreateMcpModal from '@/components/mcp/CreateMcpModal';
import {
  Modal,
  Stack,
  Text,
  Group,
  Button,
  Checkbox,
  Collapse,
  UnstyledButton,
  Badge,
  Loader,
  Center,
  Paper,
  TextInput,
  Select,
  Divider,
  ThemeIcon,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconServer,
  IconSearch,
  IconTool,
  IconBrowser,
  IconWorldSearch,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { IAgentToolBinding } from '@/lib/database/provider/types.domain';

export type ToolBinding = IAgentToolBinding;

// ── Source-agnostic tool source descriptor ───────────────────────────────

interface ToolSourceGroup {
  /** Discriminator – matches ToolBinding.source */
  source: ToolBinding['source'];
  /** Unique key of the source (e.g. tool key, MCP server key, or system tool key) */
  sourceKey: string;
  /** Human-readable name */
  name: string;
  description?: string;
  /** Source type label (OpenAPI / MCP / System) */
  typeLabel: string;
  /** Available tools within this source */
  tools: { name: string; description: string }[];
}

/**
 * System tools whose whole binding is one config field picked from a
 * `Select` (a browser, a web search instance) rather than a checkbox list of
 * discrete tool names. Each renders as its own group, in this order.
 */
const SYSTEM_TOOLS = [
  {
    sourceKey: 'browser_use',
    field: 'browserId',
    icon: IconBrowser,
    name: 'Browser Use',
    description: 'Drive a Playwright browser session: navigate, click, type, snapshot, screenshot, extract, close.',
    toolDescription: 'Bundle of browser_navigate, browser_click, browser_type, browser_snapshot, browser_screenshot, browser_extract and more.',
    label: 'Browser',
    placeholder: 'Select a browser to add Browser Use',
    emptyPlaceholder: 'No browsers available',
    hint: 'Selecting a browser adds the Browser Use system tool to this agent.',
    nothingFound: 'No browsers',
  },
  {
    sourceKey: 'web_search',
    field: 'providerKey',
    icon: IconWorldSearch,
    name: 'Web Search',
    description: 'Search the web through a configured Web Search instance and return ranked results, optionally with a synthesized answer.',
    toolDescription: 'Search the web and return ranked results (title, url, snippet), with an optional AI-synthesized answer.',
    label: 'Web Search instance',
    placeholder: 'Select an instance to add Web Search',
    emptyPlaceholder: 'No web search instances available',
    hint: 'Selecting an instance adds the Web Search system tool to this agent.',
    nothingFound: 'No web search instances',
  },
] as const;

const systemToolFor = (source: string, sourceKey: string) =>
  source === 'system' ? SYSTEM_TOOLS.find((tool) => tool.sourceKey === sourceKey) : undefined;

/** Adds `key` to a copy of `set`, or removes it if present. */
const toggleIn = (set: Set<string>, key: string) => {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
};

// ── Props ────────────────────────────────────────────────────────────────

export interface ToolSelectorModalProps {
  opened: boolean;
  onClose: () => void;
  /** Current bindings stored on the agent config */
  value: ToolBinding[];
  /** Called with the updated bindings when user confirms selection */
  onChange: (bindings: ToolBinding[]) => void;
}

// ── Component ────────────────────────────────────────────────────────────

export function ToolSelectorModal({
  opened,
  onClose,
  value,
  onChange,
}: ToolSelectorModalProps) {
  const t = useTranslations('agents');

  // Data
  const [sources, setSources] = useState<ToolSourceGroup[]>([]);
  const [loading, setLoading] = useState(false);

  // UI state
  const [search, setSearch] = useState('');
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  // Selection state – keyed by "source::sourceKey::toolName"
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // An MCP server created from here: once the list reloads, all its tools
  // are selected — the reason it was created from inside the agent.
  const [createMcpOpen, setCreateMcpOpen] = useState(false);
  const [pendingServerKey, setPendingServerKey] = useState<string | null>(null);

  // Per-binding config state for system tools (e.g. browser_use needs a browserId)
  const [systemConfigs, setSystemConfigs] = useState<Record<string, Record<string, unknown>>>({});

  // Picker options per config-only system tool (sourceKey → browsers / web search instances)
  const [systemOptions, setSystemOptions] = useState<Record<string, Array<{ value: string; label: string }>>>({});

  // ── Helpers ─────────────────────────────────────────────────────

  const toKey = (source: string, sourceKey: string, toolName: string) =>
    `${source}::${sourceKey}::${toolName}`;

  const parseKey = (key: string) => {
    const [source, sourceKey, ...rest] = key.split('::');
    return { source, sourceKey, toolName: rest.join('::') };
  };

  // ── Seed selection from incoming value ──────────────────────────

  useEffect(() => {
    if (!opened) return;
    const initial = new Set<string>();
    const initialConfigs: Record<string, Record<string, unknown>> = {};
    for (const b of value) {
      const bindingId = `${b.source}::${b.sourceKey}`;
      if (systemToolFor(b.source, b.sourceKey)) {
        if (b.config) initialConfigs[bindingId] = b.config;
        continue;
      }
      for (const tn of b.toolNames) {
        initial.add(toKey(b.source, b.sourceKey, tn));
      }
      if (b.source === 'system' && b.config) {
        initialConfigs[bindingId] = b.config;
      }
    }
    setSelected(initial);
    setSystemConfigs(initialConfigs);
    setSearch('');
  }, [opened, value]);

  // ── Load available tool sources ────────────────────────────────

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const allGroups: ToolSourceGroup[] = [];

      // Unified Tools (primary source)
      const toolsRes = await fetch('/api/tools?status=active', { cache: 'no-store' });
      if (toolsRes.ok) {
        const toolsData = await toolsRes.json();
        const toolGroups: ToolSourceGroup[] = (toolsData.tools ?? []).map(
          (t: { key: string; name: string; description?: string; type: string; actions: { key: string; name: string; description: string }[] }) => ({
            source: 'tool' as const,
            sourceKey: t.key,
            name: t.name,
            description: t.description,
            typeLabel: t.type === 'openapi' ? 'OpenAPI' : 'MCP',
            tools: (t.actions ?? []).map((a) => ({
              name: a.key,
              description: a.description || a.name,
            })),
          }),
        );
        allGroups.push(...toolGroups);
      }

      // Legacy MCP servers (backward compat)
      const mcpRes = await fetch('/api/mcp?status=active', { cache: 'no-store' });
      if (mcpRes.ok) {
        const mcpData = await mcpRes.json();
        const mcpGroups: ToolSourceGroup[] = (mcpData.servers ?? []).map(
          (s: { key: string; name: string; description?: string; tools: { name: string; description: string }[]; disabledTools?: string[] }) => ({
            source: 'mcp' as const,
            sourceKey: s.key,
            name: s.name,
            description: s.description,
            typeLabel: 'MCP (legacy)',
            tools: (s.tools ?? []).filter(
              (t) => !(s.disabledTools ?? []).includes(t.name),
            ),
          }),
        );
        allGroups.push(...mcpGroups);
      }

      // System Tools (built-in, hardcoded)
      const browsersRes = await fetch('/api/browser/browsers?status=active', { cache: 'no-store' });
      const browsers: Array<{ id: string; name: string; key: string }> =
        browsersRes.ok ? ((await browsersRes.json()).browsers ?? []) : [];
      setSystemOptions((prev) => ({
        ...prev,
        browser_use: browsers.map((b) => ({ value: b.id, label: `${b.name} (${b.key})` })),
      }));

      const webSearchRes = await fetch('/api/websearch/providers', { cache: 'no-store' });
      const providers: Array<{ key: string; label: string; status: string }> =
        webSearchRes.ok ? ((await webSearchRes.json()).providers ?? []) : [];
      setSystemOptions((prev) => ({
        ...prev,
        web_search: providers
          .filter((p) => p.status === 'active')
          .map((p) => ({ value: p.key, label: `${p.label} (${p.key})` })),
      }));

      allGroups.unshift(...SYSTEM_TOOLS.map((tool) => ({
        source: 'system' as const,
        sourceKey: tool.sourceKey,
        name: tool.name,
        description: tool.description,
        typeLabel: 'System',
        tools: [{ name: tool.sourceKey, description: tool.toolDescription }],
      })));

      setSources(allGroups);

      // Auto-expand sources that have selected tools
      const expanded = new Set<string>();
      for (const g of allGroups) {
        const hasSelected = g.tools.some((tool) =>
          value.some(
            (b) =>
              b.source === g.source &&
              b.sourceKey === g.sourceKey &&
              b.toolNames.includes(tool.name),
          ),
        );
        if (hasSelected) expanded.add(`${g.source}::${g.sourceKey}`);
      }
      setExpandedSources(expanded);
    } catch (err) {
      console.error('Failed to load tool sources', err);
    } finally {
      setLoading(false);
    }
  }, [value]);

  useEffect(() => {
    if (opened) loadSources();
  }, [opened, loadSources]);

  useEffect(() => {
    if (!pendingServerKey) return;
    const group = sources.find((g) => g.source === 'mcp' && g.sourceKey === pendingServerKey);
    if (!group) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const tool of group.tools) next.add(toKey('mcp', group.sourceKey, tool.name));
      return next;
    });
    setExpandedSources((prev) => new Set(prev).add(`mcp::${group.sourceKey}`));
    setPendingServerKey(null);
  }, [pendingServerKey, sources]);

  // ── Toggle helpers ──────────────────────────────────────────────

  const toggleSource = (source: string, sourceKey: string) =>
    setExpandedSources((prev) => toggleIn(prev, `${source}::${sourceKey}`));

  const toggleTool = (source: string, sourceKey: string, toolName: string) =>
    setSelected((prev) => toggleIn(prev, toKey(source, sourceKey, toolName)));

  const toggleAllToolsInSource = (group: ToolSourceGroup, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const tool of group.tools) {
        const key = toKey(group.source, group.sourceKey, tool.name);
        if (checked) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  // ── Build bindings from selection ──────────────────────────────

  const buildBindings = (): ToolBinding[] => {
    const map = new Map<string, ToolBinding>();
    for (const key of selected) {
      const { source, sourceKey, toolName } = parseKey(key);
      const id = `${source}::${sourceKey}`;
      if (!map.has(id)) {
        const binding: ToolBinding = {
          source: source as ToolBinding['source'],
          sourceKey,
          toolNames: [],
        };
        if (source === 'system' && systemConfigs[id]) {
          binding.config = systemConfigs[id];
        }
        map.set(id, binding);
      }
      map.get(id)!.toolNames.push(toolName);
    }

    for (const tool of SYSTEM_TOOLS) {
      const id = `system::${tool.sourceKey}`;
      const cfg = systemConfigs[id];
      const picked = cfg?.[tool.field];
      if (typeof picked === 'string' && picked) {
        map.set(id, { source: 'system', sourceKey: tool.sourceKey, toolNames: [tool.sourceKey], config: { ...cfg } });
      }
    }

    return Array.from(map.values());
  };

  // ── Filter sources by search ───────────────────────────────────

  const lowerSearch = search.toLowerCase();
  const filteredSources = sources
    .map((group) => {
      if (!search) return group;
      const matchesGroup = group.name.toLowerCase().includes(lowerSearch);
      const filteredTools = group.tools.filter(
        (t) =>
          t.name.toLowerCase().includes(lowerSearch) ||
          t.description.toLowerCase().includes(lowerSearch),
      );
      if (matchesGroup) return group; // show all tools if server name matches
      if (filteredTools.length === 0) return null;
      return { ...group, tools: filteredTools };
    })
    .filter(Boolean) as ToolSourceGroup[];

  // ── Count helpers ──────────────────────────────────────────────

  const selectedCountForSource = (group: ToolSourceGroup) => {
    const sys = systemToolFor(group.source, group.sourceKey);
    if (sys) return systemConfigs[`system::${group.sourceKey}`]?.[sys.field] ? 1 : 0;
    return group.tools.filter((t) => selected.has(toKey(group.source, group.sourceKey, t.name))).length;
  };

  const totalSelected =
    selected.size + SYSTEM_TOOLS.filter((tool) => systemConfigs[`system::${tool.sourceKey}`]?.[tool.field]).length;

  // ── Confirm ────────────────────────────────────────────────────

  const handleConfirm = () => {
    onChange(buildBindings());
    onClose();
  };

  // ── Render ─────────────────────────────────────────────────────

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('config.toolSelectorTitle')}
      size="lg"
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('config.toolSelectorDescription')}
        </Text>

        <Group gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            placeholder="Search tools..."
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button variant="light" leftSection={<IconPlus size={14} />} onClick={() => setCreateMcpOpen(true)}>
            New MCP server
          </Button>
        </Group>
        <CreateMcpModal
          opened={createMcpOpen}
          onClose={() => setCreateMcpOpen(false)}
          onCreated={(server) => {
            setCreateMcpOpen(false);
            setPendingServerKey(server.key);
            void loadSources();
          }}
        />

        {loading ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : filteredSources.length === 0 ? (
          <Center py="xl">
            <Text size="sm" c="dimmed">
              No tool sources available.
            </Text>
          </Center>
        ) : (
          <Stack gap={0}>
            {filteredSources.map((group) => {
              const sourceId = `${group.source}::${group.sourceKey}`;
              const isExpanded = expandedSources.has(sourceId);
              const count = selectedCountForSource(group);
              const allSelected = count === group.tools.length && group.tools.length > 0;
              const someSelected = count > 0 && !allSelected;
              const systemTool = systemToolFor(group.source, group.sourceKey);
              const GroupIcon = systemTool?.icon ?? IconServer;
              const options = systemTool ? systemOptions[group.sourceKey] ?? [] : [];

              return (
                <Paper key={sourceId} withBorder radius="sm" mb="xs">
                  {/* Source header */}
                  <UnstyledButton
                    onClick={() => toggleSource(group.source, group.sourceKey)}
                    style={{ width: '100%' }}
                    p="xs"
                  >
                    <Group justify="space-between">
                      <Group gap="xs">
                        {isExpanded ? (
                          <IconChevronDown size={16} />
                        ) : (
                          <IconChevronRight size={16} />
                        )}
                        <ThemeIcon size="sm" variant="light" color={group.source === 'system' ? 'grape' : 'blue'}>
                          <GroupIcon size={12} />
                        </ThemeIcon>
                        <div>
                          <Text size="sm" fw={600}>
                            {group.name}
                          </Text>
                          {group.description && (
                            <Text size="xs" c="dimmed" lineClamp={1}>
                              {group.description}
                            </Text>
                          )}
                        </div>
                      </Group>
                      <Group gap="xs">
                        {count > 0 && (
                          <Badge size="xs" variant="light" color="blue">
                            {count}/{group.tools.length}
                          </Badge>
                        )}
                        <Badge size="xs" variant="light" color={group.source === 'system' ? 'grape' : 'gray'}>
                          {group.typeLabel}
                        </Badge>
                      </Group>
                    </Group>
                  </UnstyledButton>

                  {/* Tools list */}
                  <Collapse in={isExpanded}>
                    <Divider />
                    <Stack gap={0} p="xs" pt={0}>
                      {systemTool ? (
                        <Select
                          mt="xs"
                          mb="xs"
                          label={systemTool.label}
                          placeholder={options.length === 0 ? systemTool.emptyPlaceholder : systemTool.placeholder}
                          description={systemTool.hint}
                          data={options}
                          value={(systemConfigs[sourceId]?.[systemTool.field] as string) ?? null}
                          onChange={(value) => {
                            setSystemConfigs((prev) => ({
                              ...prev,
                              [sourceId]: { ...(prev[sourceId] ?? {}), [systemTool.field]: value ?? '' },
                            }));
                          }}
                          searchable
                          clearable
                          nothingFoundMessage={systemTool.nothingFound}
                        />
                      ) : (
                        <>
                          <Checkbox
                            label={
                              <Text size="xs" fw={600} c="dimmed">
                                Select all ({group.tools.length})
                              </Text>
                            }
                            checked={allSelected}
                            indeterminate={someSelected}
                            onChange={(e) =>
                              toggleAllToolsInSource(group, e.currentTarget.checked)
                            }
                            mt="xs"
                            mb="xs"
                          />
                          {group.tools.map((tool) => {
                            const key = toKey(group.source, group.sourceKey, tool.name);
                            return (
                              <Checkbox
                                key={key}
                                label={
                                  <Group gap="xs">
                                    <IconTool size={12} />
                                    <div>
                                      <Text size="sm">{tool.name}</Text>
                                      {tool.description && (
                                        <Text size="xs" c="dimmed" lineClamp={2}>
                                          {tool.description}
                                        </Text>
                                      )}
                                    </div>
                                  </Group>
                                }
                                checked={selected.has(key)}
                                onChange={() =>
                                  toggleTool(group.source, group.sourceKey, tool.name)
                                }
                                mb={4}
                                ml="md"
                              />
                            );
                          })}
                        </>
                      )}
                    </Stack>
                  </Collapse>
                </Paper>
              );
            })}
          </Stack>
        )}

        {/* Footer */}
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {totalSelected} tool(s) selected
          </Text>
          <Group gap="xs">
            <Button variant="default" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleConfirm}>
              Confirm
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
