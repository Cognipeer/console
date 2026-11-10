'use client';

/**
 * Configure → Tools: everything the agent can call, one row per source.
 *
 * "This agent" lists the MCP servers that belong to the agent (`IAgentResourceOwner`), bound or not: created here,
 * managed in a drawer that shows the same screen as a hub server, deleted here (and with the agent); no other agent
 * can use them. "Shared" lists what the agent uses from the project: hub MCP servers, custom tools, system tools,
 * flows; a row's remove button takes it off the agent. A row's tool count opens the picker on that source alone.
 * "+ Add" creates an MCP server for the agent, adds from the hub and the library, or creates a custom tool; whatever
 * is created is bound with all its tools.
 */

import { useState } from 'react';
import { ActionIcon, Badge, Button, Drawer, Group, Loader, Menu, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBooks,
  IconChevronDown,
  IconPlus,
  IconRoute,
  IconServer,
  IconSettings,
  IconTool,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import CreateMcpModal from '@/components/mcp/CreateMcpModal';
import McpDetailView from '@/components/mcp/McpDetailView';
import CreateToolModal from '@/components/tools/CreateToolModal';
import { useDeleteResource } from '@/components/common/confirm/useDeleteResource';
import { useCanWriteService } from '@/components/layout/launcher/LauncherContext';
import { useTranslations } from '@/lib/i18n';
import type { ToolView } from '@/lib/services/tools';
import { ToolSelectorModal } from '../ToolSelectorModal';
import { sourceIdOf, systemToolFor, useToolSources, type ToolBinding, type ToolSourceGroup } from '../toolSources';

export interface AgentToolsListProps {
  agentId: string;
  /** The agent's tool bindings as currently edited. */
  bindings: ToolBinding[];
  /** Saves new bindings (every change here is saved at once). */
  onBindingsChange: (bindings: ToolBinding[]) => void | Promise<void>;
  /** One of the agent's own servers was created, changed or deleted: the page reloads what it knows of them. */
  onServersChanged?: () => void;
  readOnly?: boolean;
}

/** What `CreateMcpModal` hands back: enough to bind the server's tools. */
interface CreatedServer {
  key: string;
  tools?: Array<{ name: string }>;
  disabledTools?: string[];
}

type SourceRef = { source: ToolBinding['source']; sourceKey: string };

/** One row: a source the agent has (its own server, or a bound shared source). */
interface Row {
  ref: SourceRef;
  group?: ToolSourceGroup;
  binding?: ToolBinding;
}

/** How many of the source's tools the binding uses. */
function usedCount(row: Row): number {
  const { group, binding } = row;
  if (!binding) return 0;
  if (!group) return binding.toolNames.length;
  if (systemToolFor(group.source, group.sourceKey)) return 1;
  const names = new Set(binding.toolNames);
  return group.tools.filter((tool) => names.has(tool.name)).length;
}

function iconFor(row: Row) {
  const system = systemToolFor(row.ref.source, row.ref.sourceKey);
  if (system) return system.icon;
  if (row.ref.source === 'mcp') return IconServer;
  if (row.ref.source === 'flow') return IconRoute;
  return IconTool;
}

const without = (bindings: ToolBinding[], ref: SourceRef) =>
  bindings.filter((b) => !(b.source === ref.source && b.sourceKey === ref.sourceKey));

export default function AgentToolsList({
  agentId,
  bindings,
  onBindingsChange,
  onServersChanged,
  readOnly = false,
}: AgentToolsListProps) {
  const t = useTranslations('agents');
  const tNouns = useTranslations('common.confirm.nouns');
  const canWriteMcp = useCanWriteService('mcp') && !readOnly;
  const canWriteTools = useCanWriteService('tools') && !readOnly;
  const deleteResource = useDeleteResource();

  // Reloaded when the set of bound sources changes: the picker can bind one this list has not loaded yet.
  const boundIds = bindings.map(sourceIdOf).sort().join('|');
  const { sources, loaded, reload } = useToolSources({ agentId, bindings, enabled: true, reloadKey: boundIds });

  const [pickerOpen, setPickerOpen] = useState(false);
  // Kept while the picker closes, so its content does not switch during the animation.
  const [pickerMode, setPickerMode] = useState<{ focus: SourceRef | null; sharedOnly: boolean }>({ focus: null, sharedOnly: true });
  const [creatingMcp, setCreatingMcp] = useState(false);
  const [creatingTool, setCreatingTool] = useState(false);
  const [managing, setManaging] = useState<{ id: string; ref: SourceRef } | null>(null);

  const openPicker = (focus: SourceRef | null) => {
    setPickerMode({ focus, sharedOnly: focus === null });
    setPickerOpen(true);
  };

  // ── Rows ────────────────────────────────────────────────────────

  const bindingById = new Map(bindings.map((b) => [sourceIdOf(b), b]));
  const groupById = new Map(sources.map((g) => [sourceIdOf(g), g]));
  const ownRows: Row[] = sources
    .filter((g) => g.source === 'mcp' && g.ownedByAgent)
    .map((g) => ({ ref: { source: g.source, sourceKey: g.sourceKey }, group: g, binding: bindingById.get(sourceIdOf(g)) }));
  const ownIds = new Set(ownRows.map((row) => sourceIdOf(row.ref)));
  const sharedRows: Row[] = bindings
    .filter((b) => !ownIds.has(sourceIdOf(b)))
    .map((b) => ({ ref: { source: b.source, sourceKey: b.sourceKey }, group: groupById.get(sourceIdOf(b)), binding: b }));

  // ── Actions ─────────────────────────────────────────────────────

  const handleMcpCreated = async (server: CreatedServer) => {
    setCreatingMcp(false);
    // Made from inside the agent so the agent can use it: all its tools are bound right away.
    const disabled = new Set(server.disabledTools ?? []);
    const toolNames = (server.tools ?? []).map((tool) => tool.name).filter((name) => !disabled.has(name));
    const ref: SourceRef = { source: 'mcp', sourceKey: server.key };
    if (toolNames.length > 0) await onBindingsChange([...without(bindings, ref), { ...ref, toolNames }]);
    void reload();
    onServersChanged?.();
  };

  const handleToolCreated = async (tool: ToolView) => {
    setCreatingTool(false);
    const toolNames = (tool.actions ?? []).map((action) => action.key);
    const ref: SourceRef = { source: 'tool', sourceKey: tool.key };
    if (toolNames.length > 0) await onBindingsChange([...without(bindings, ref), { ...ref, toolNames }]);
    void reload();
  };

  const afterServerDeleted = async (ref: SourceRef) => {
    const next = without(bindings, ref);
    if (next.length !== bindings.length) await onBindingsChange(next);
    void reload();
    onServersChanged?.();
  };

  const handleDeleteServer = async (row: Row) => {
    const group = row.group;
    if (!group?.recordId) return;
    const deleted = await deleteResource({
      noun: tNouns('mcpServer'),
      name: group.name,
      type: 'mcp-server',
      id: group.recordId,
      extraWarning: t('config.toolsDeleteServerWarning'),
      action: async () => {
        const res = await fetch(`/api/mcp/${encodeURIComponent(group.recordId!)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('The MCP server could not be deleted.');
      },
    });
    if (!deleted) return;
    notifications.show({
      title: t('config.toolsDeleted'),
      message: t('config.toolsDeletedMessage', { name: group.name }),
      color: 'red',
    });
    await afterServerDeleted(row.ref);
  };

  const closeDrawer = () => {
    setManaging(null);
    // The drawer may have renamed the server, changed its tools or switched it off.
    void reload();
    onServersChanged?.();
  };

  // ── Render ──────────────────────────────────────────────────────

  const renderRow = (row: Row, own: boolean) => {
    const { group, binding } = row;
    const Icon = iconFor(row);
    const used = usedCount(row);
    const system = systemToolFor(row.ref.source, row.ref.sourceKey);
    const countLabel = system
      ? null
      : group
        ? t('config.toolsCount', { used, total: group.tools.length })
        : t('config.toolsCountBound', { count: binding?.toolNames.length ?? 0 });
    const canPick = !readOnly && Boolean(group) && (Boolean(system) || (group?.tools.length ?? 0) > 1 || used === 0);

    return (
      <Paper key={sourceIdOf(row.ref)} withBorder radius="sm" px="xs" py={6} data-testid={`agent-tool-row-${sourceIdOf(row.ref)}`}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Icon size={16} style={{ flexShrink: 0 }} />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={600} truncate>{group?.name ?? row.ref.sourceKey}</Text>
                {group?.inactive ? (
                  <Badge size="xs" variant="light" color="gray">{t('config.toolsDisabled')}</Badge>
                ) : null}
              </Group>
              <Text size="xs" c="dimmed" truncate>{group?.typeLabel ?? row.ref.source.toUpperCase()}</Text>
            </Stack>
          </Group>

          <Group gap={4} wrap="nowrap">
            {canPick ? (
              <Tooltip label={t('config.toolsChoose')} withArrow>
                <Button
                  size="compact-xs"
                  variant="light"
                  color={used > 0 ? 'blue' : 'gray'}
                  rightSection={<IconChevronDown size={12} />}
                  onClick={() => openPicker(row.ref)}
                >
                  {countLabel ?? t('config.toolsChange')}
                </Button>
              </Tooltip>
            ) : countLabel ? (
              <Badge size="sm" variant="light" color={used > 0 ? 'blue' : 'gray'}>{countLabel}</Badge>
            ) : null}

            {own ? (
              <>
                <Button
                  size="compact-xs"
                  variant="default"
                  leftSection={<IconSettings size={12} />}
                  onClick={() => group?.recordId && setManaging({ id: group.recordId, ref: row.ref })}
                >
                  {t('config.toolsManage')}
                </Button>
                {canWriteMcp ? (
                  <Tooltip label={t('config.toolsDeleteServer')} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={`${t('config.toolsDeleteServer')}: ${group?.name ?? row.ref.sourceKey}`}
                      onClick={() => void handleDeleteServer(row)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </>
            ) : readOnly ? null : (
              <Tooltip label={t('config.toolsRemove')} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`${t('config.toolsRemove')}: ${group?.name ?? row.ref.sourceKey}`}
                  onClick={() => void onBindingsChange(without(bindings, row.ref))}
                >
                  <IconX size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Group>
      </Paper>
    );
  };

  const groupLabel = (label: string, hint?: string) => (
    <Group gap={6} wrap="nowrap">
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">{label}</Text>
      {hint ? <Text size="xs" c="dimmed" truncate>· {hint}</Text> : null}
    </Group>
  );

  return (
    <Stack gap="sm" data-testid="agent-tools">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Text size="xs" c="dimmed">{t('config.toolsDescription')}</Text>
        {readOnly ? null : (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlus size={14} />}
                rightSection={<IconChevronDown size={12} />}
                style={{ flexShrink: 0 }}
                data-testid="agent-tools-add"
              >
                {t('config.toolsAdd')}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {canWriteMcp ? (
                <Menu.Item
                  leftSection={<IconServer size={14} />}
                  onClick={() => setCreatingMcp(true)}
                  data-testid="agent-tools-new-mcp"
                >
                  {t('config.toolsAddNewMcp')}
                </Menu.Item>
              ) : null}
              <Menu.Item
                leftSection={<IconBooks size={14} />}
                onClick={() => openPicker(null)}
                data-testid="agent-tools-from-library"
              >
                {t('config.toolsAddFromLibrary')}
              </Menu.Item>
              {canWriteTools ? (
                <Menu.Item
                  leftSection={<IconTool size={14} />}
                  onClick={() => setCreatingTool(true)}
                  data-testid="agent-tools-new-tool"
                >
                  {t('config.toolsAddNewTool')}
                </Menu.Item>
              ) : null}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      {!loaded ? (
        <Loader size="xs" />
      ) : ownRows.length === 0 && sharedRows.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic">{t('config.noToolsSelected')}</Text>
      ) : (
        <>
          {ownRows.length > 0 ? (
            <Stack gap={6} data-testid="agent-tools-own">
              {groupLabel(t('config.toolsThisAgent'), t('config.toolsThisAgentHint'))}
              {ownRows.map((row) => renderRow(row, true))}
            </Stack>
          ) : null}
          {sharedRows.length > 0 ? (
            <Stack gap={6} data-testid="agent-tools-shared">
              {groupLabel(t('config.toolsShared'))}
              {sharedRows.map((row) => renderRow(row, false))}
            </Stack>
          ) : null}
        </>
      )}

      <ToolSelectorModal
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        value={bindings}
        onChange={(next) => void onBindingsChange(next)}
        agentId={agentId}
        focus={pickerMode.focus}
        sharedOnly={pickerMode.sharedOnly}
      />

      {canWriteMcp ? (
        <CreateMcpModal
          opened={creatingMcp}
          onClose={() => setCreatingMcp(false)}
          ownerAgentId={agentId}
          onCreated={(server) => void handleMcpCreated(server as unknown as CreatedServer)}
        />
      ) : null}

      {canWriteTools ? (
        <CreateToolModal
          opened={creatingTool}
          onClose={() => setCreatingTool(false)}
          onCreated={(tool) => void handleToolCreated(tool)}
        />
      ) : null}

      <Drawer
        opened={managing !== null}
        onClose={closeDrawer}
        position="right"
        size="85%"
        withCloseButton={false}
        padding={0}
        title={null}
      >
        {managing ? (
          <McpDetailView
            serverId={managing.id}
            embedded={{
              onClose: closeDrawer,
              onDeleted: () => {
                const ref = managing.ref;
                setManaging(null);
                void afterServerDeleted(ref);
              },
            }}
          />
        ) : null}
      </Drawer>
    </Stack>
  );
}
