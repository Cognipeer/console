'use client';

import { useState, useEffect, useCallback } from 'react';
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
  IconServer,
  IconSearch,
  IconTool,
  IconBrowser,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

// ── Generic tool-binding shape ──────────────────────────────────────────
// Mirrors IAgentToolBinding from the DB but kept local so the component
// stays self-contained.  Supports unified 'tool', legacy 'mcp', and 'system' sources.

export interface ToolBinding {
  source: 'tool' | 'mcp' | 'system';
  sourceKey: string;
  toolNames: string[];
  config?: Record<string, unknown>;
}

// ── Source-agnostic tool source descriptor ───────────────────────────────

interface ToolSourceGroup {
  /** Discriminator – matches ToolBinding.source */
  source: 'tool' | 'mcp' | 'system';
  /** Unique key of the source (e.g. tool key, MCP server key, or system tool key) */
  sourceKey: string;
  /** Human-readable name */
  name: string;
  description?: string;
  /** Source type label (OpenAPI / MCP / System) */
  typeLabel?: string;
  /** Available tools within this source */
  tools: { name: string; description: string }[];
}

interface BrowserOption { id: string; name: string; key: string; status: string }

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

  // Per-binding config state for system tools (e.g. browser_use needs a browserId)
  const [systemConfigs, setSystemConfigs] = useState<Record<string, Record<string, unknown>>>({});

  // Browser options for the browser_use picker
  const [browsers, setBrowsers] = useState<BrowserOption[]>([]);

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
      if (b.source === 'system' && b.sourceKey === 'browser_use') {
        if (b.config) {
          initialConfigs[bindingId] = b.config;
        }
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
      let browserList: BrowserOption[] = [];
      if (browsersRes.ok) {
        const browsersData = await browsersRes.json();
        browserList = (browsersData.browsers ?? []).map((b: { id: string; name: string; key: string; status: string }) => ({
          id: b.id, name: b.name, key: b.key, status: b.status,
        }));
      }
      setBrowsers(browserList);

      const systemGroup: ToolSourceGroup = {
        source: 'system',
        sourceKey: 'browser_use',
        name: 'Browser Use',
        description: 'Drive a Playwright browser session: navigate, click, type, snapshot, screenshot, extract, close.',
        typeLabel: 'System',
        tools: [
          { name: 'browser_use', description: 'Bundle of browser_navigate, browser_click, browser_type, browser_snapshot, browser_screenshot, browser_extract and more.' },
        ],
      };
      allGroups.unshift(systemGroup);

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

  // ── Toggle helpers ──────────────────────────────────────────────

  const toggleSource = (source: string, sourceKey: string) => {
    const id = `${source}::${sourceKey}`;
    setExpandedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTool = (source: string, sourceKey: string, toolName: string) => {
    const key = toKey(source, sourceKey, toolName);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
          source: source as 'tool' | 'mcp' | 'system',
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

    const browserUseConfig = systemConfigs['system::browser_use'];
    const browserId =
      typeof browserUseConfig?.browserId === 'string' ? browserUseConfig.browserId : '';

    if (browserId) {
      map.set('system::browser_use', {
        source: 'system',
        sourceKey: 'browser_use',
        toolNames: ['browser_use'],
        config: {
          ...browserUseConfig,
          browserId,
        },
      });
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
    if (group.source === 'system' && group.sourceKey === 'browser_use') {
      return systemConfigs['system::browser_use']?.browserId ? 1 : 0;
    }

    return group.tools.filter((t) => selected.has(toKey(group.source, group.sourceKey, t.name))).length;
  };

  const totalSelected =
    selected.size + (systemConfigs['system::browser_use']?.browserId ? 1 : 0);

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

        <TextInput
          placeholder="Search tools..."
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
                          {group.source === 'system' ? <IconBrowser size={12} /> : <IconServer size={12} />}
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
                          {group.typeLabel || (group.source === 'tool' ? 'Tool' : group.source === 'mcp' ? 'MCP' : 'System')}
                        </Badge>
                      </Group>
                    </Group>
                  </UnstyledButton>

                  {/* Tools list */}
                  <Collapse in={isExpanded}>
                    <Divider />
                    <Stack gap={0} p="xs" pt={0}>
                      {group.source === 'system' && group.sourceKey === 'browser_use' ? (
                        <Select
                          mt="xs"
                          mb="xs"
                          label="Browser"
                          placeholder={browsers.length === 0 ? 'No browsers available' : 'Select a browser to add Browser Use'}
                          description="Selecting a browser adds the Browser Use system tool to this agent."
                          data={browsers.map((b) => ({ value: b.id, label: `${b.name} (${b.key})` }))}
                          value={(systemConfigs[sourceId]?.browserId as string) ?? null}
                          onChange={(value) => {
                            setSystemConfigs((prev) => ({
                              ...prev,
                              [sourceId]: { ...(prev[sourceId] ?? {}), browserId: value ?? '' },
                            }));
                          }}
                          searchable
                          clearable
                          nothingFoundMessage="No browsers"
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
