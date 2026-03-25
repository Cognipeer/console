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
  Divider,
  ThemeIcon,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconServer,
  IconSearch,
  IconTool,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

// ── Generic tool-binding shape ──────────────────────────────────────────
// Mirrors IAgentToolBinding from the DB but kept local so the component
// stays self-contained.  Supports both unified 'tool' and legacy 'mcp' sources.

export interface ToolBinding {
  source: 'tool' | 'mcp';
  sourceKey: string;
  toolNames: string[];
}

// ── Source-agnostic tool source descriptor ───────────────────────────────

interface ToolSourceGroup {
  /** Discriminator – matches ToolBinding.source */
  source: 'tool' | 'mcp';
  /** Unique key of the source (e.g. tool key or MCP server key) */
  sourceKey: string;
  /** Human-readable name */
  name: string;
  description?: string;
  /** Source type label (OpenAPI / MCP) */
  typeLabel?: string;
  /** Available tools within this source */
  tools: { name: string; description: string }[];
}

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
    for (const b of value) {
      for (const tn of b.toolNames) {
        initial.add(toKey(b.source, b.sourceKey, tn));
      }
    }
    setSelected(initial);
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
          (s: { key: string; name: string; description?: string; tools: { name: string; description: string }[] }) => ({
            source: 'mcp' as const,
            sourceKey: s.key,
            name: s.name,
            description: s.description,
            typeLabel: 'MCP (legacy)',
            tools: s.tools ?? [],
          }),
        );
        allGroups.push(...mcpGroups);
      }

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
        map.set(id, { source: source as 'tool' | 'mcp', sourceKey, toolNames: [] });
      }
      map.get(id)!.toolNames.push(toolName);
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

  const selectedCountForSource = (group: ToolSourceGroup) =>
    group.tools.filter((t) => selected.has(toKey(group.source, group.sourceKey, t.name))).length;

  const totalSelected = selected.size;

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
                        <ThemeIcon size="sm" variant="light" color="blue">
                          <IconServer size={12} />
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
                        <Badge size="xs" variant="light" color="gray">
                          {group.typeLabel || (group.source === 'tool' ? 'Tool' : 'MCP')}
                        </Badge>
                      </Group>
                    </Group>
                  </UnstyledButton>

                  {/* Tools list */}
                  <Collapse in={isExpanded}>
                    <Divider />
                    <Stack gap={0} p="xs" pt={0}>
                      {/* Select all */}
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
