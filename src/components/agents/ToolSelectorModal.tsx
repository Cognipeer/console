'use client';

import { useState, useEffect } from 'react';
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
  IconRoute,
  IconServer,
  IconSearch,
  IconTool,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import { useFlowToolSource } from '@/components/enterprise/EnterpriseFlowAgentUi';
import { apiGet } from '@/lib/api/client';
import {
  SYSTEM_TOOLS,
  sourceIdOf,
  systemToolFor,
  useToolSources,
  type ToolBinding,
  type ToolSourceGroup,
} from './toolSources';

export type { ToolBinding } from './toolSources';

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
  /** Called with all the updated bindings when user confirms selection */
  onChange: (bindings: ToolBinding[]) => void;
  /** The agent being edited: its own MCP servers are listed with the hub's. */
  agentId?: string;
  /** Only this source, its tools open: choosing the tools of one row of the agent's Tools list. */
  focus?: { source: ToolBinding['source']; sourceKey: string } | null;
  /** Leaves the agent's own MCP servers out: adding from the hub and the library. */
  sharedOnly?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────

export function ToolSelectorModal({
  opened,
  onClose,
  value,
  onChange,
  agentId,
  focus = null,
  sharedOnly = false,
}: ToolSelectorModalProps) {
  const t = useTranslations('agents');
  const tm = useTranslations('managedTools');
  // Flows as a tool source, where Flows are available (Enterprise): null otherwise.
  const flowTools = useFlowToolSource();

  // Data
  const { sources, flowsByKey, loading: loadingSources, loaded } = useToolSources({ agentId, bindings: value, enabled: opened });
  const loading = loadingSources || !loaded;

  // UI state
  const [search, setSearch] = useState('');
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

  // Selection state – keyed by "source::sourceKey::toolName"
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
      const bindingId = sourceIdOf(b);
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

  // ── Options of the config-only system tools ─────────────────────

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const list = async <T,>(url: string, key: string): Promise<T[]> => {
      try {
        return (await apiGet<Record<string, T[]>>(url))[key] ?? [];
      } catch {
        return [];
      }
    };
    void (async () => {
      const [browsers, providers, crawlers] = await Promise.all([
        list<{ id: string; name: string; key: string }>('/api/browser/browsers?status=active', 'browsers'),
        list<{ key: string; label: string; status: string }>('/api/websearch/providers', 'providers'),
        list<{ key: string; name: string }>('/api/crawler/crawlers?status=active', 'crawlers'),
      ]);
      if (cancelled) return;
      setSystemOptions({
        browser_use: browsers.map((b) => ({ value: b.id, label: `${b.name} (${b.key})` })),
        web_search: providers
          .filter((p) => p.status === 'active')
          .map((p) => ({ value: p.key, label: `${p.label} (${p.key})` })),
        crawler: crawlers.map((c) => ({ value: c.key, label: `${c.name} (${c.key})` })),
      });
    })();
    return () => { cancelled = true; };
  }, [opened]);

  // Sources that have selected tools start open.
  useEffect(() => {
    if (!opened || loading) return;
    const expanded = new Set<string>();
    for (const g of sources) {
      const bound = value.find((b) => b.source === g.source && b.sourceKey === g.sourceKey);
      if (bound && g.tools.some((tool) => bound.toolNames.includes(tool.name))) expanded.add(sourceIdOf(g));
    }
    setExpandedSources(expanded);
  }, [opened, loading, sources, value]);

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
  // Every binding, the ones of sources not shown here included: the selection was seeded from all of them.

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

    // A flow binding keeps what the Flows tab set (description, wait time, version); a new one is built the same way.
    if (flowTools) {
      for (const [id, binding] of map) {
        if (binding.source === 'flow') map.set(id, flowTools.rebuildBinding(binding, value, flowsByKey));
      }
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

  // ── What is offered ────────────────────────────────────────────
  // One source when focused (even a switched-off one: its tools may still be bound); otherwise every source that is
  // on, without the agent's own servers when only shared ones are asked for.

  const focusId = focus ? sourceIdOf(focus) : null;
  const offered = sources.filter((g) =>
    focusId ? sourceIdOf(g) === focusId : !g.inactive && !(sharedOnly && g.ownedByAgent),
  );
  const focusedGroup = focusId ? offered[0] : undefined;

  const lowerSearch = search.toLowerCase();
  const filteredSources = offered
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

  const totalSelected = offered.reduce((sum, group) => sum + selectedCountForSource(group), 0);

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
      title={focusedGroup ? t('config.toolSelectorFocusTitle', { name: focusedGroup.name }) : t('config.toolSelectorTitle')}
      size="lg"
      centered
    >
      <Stack gap="md">
        {focus ? null : (
          <Text size="sm" c="dimmed">
            {t('config.toolSelectorDescription')}
          </Text>
        )}

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
              const sourceId = sourceIdOf(group);
              const isExpanded = focus ? true : expandedSources.has(sourceId);
              const count = selectedCountForSource(group);
              const allSelected = count === group.tools.length && group.tools.length > 0;
              const someSelected = count > 0 && !allSelected;
              const systemTool = systemToolFor(group.source, group.sourceKey);
              const GroupIcon = systemTool?.icon ?? (group.source === 'flow' ? IconRoute : IconServer);
              const options = systemTool ? systemOptions[group.sourceKey] ?? [] : [];

              return (
                <Paper key={sourceId} withBorder radius="sm" mb="xs">
                  {/* Source header */}
                  <UnstyledButton
                    onClick={() => toggleSource(group.source, group.sourceKey)}
                    style={{ width: '100%' }}
                    p="xs"
                    disabled={Boolean(focus)}
                  >
                    <Group justify="space-between">
                      <Group gap="xs">
                        {focus ? null : isExpanded ? (
                          <IconChevronDown size={16} />
                        ) : (
                          <IconChevronRight size={16} />
                        )}
                        <ThemeIcon size="sm" variant="light" color={group.source === 'system' ? 'grape' : group.source === 'flow' ? 'indigo' : 'blue'}>
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
                        {group.managed && (
                          <Badge size="xs" variant="light" color="grape">
                            {tm('badge')}
                          </Badge>
                        )}
                        {group.ownedByAgent && (
                          <Badge size="xs" variant="light" color="indigo">
                            {t('config.toolsThisAgent')}
                          </Badge>
                        )}
                        {group.inactive && (
                          <Badge size="xs" variant="light" color="gray">
                            {t('config.toolsDisabled')}
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
