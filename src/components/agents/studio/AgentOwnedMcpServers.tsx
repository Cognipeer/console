'use client';

/**
 * Configure → Tools: the MCP servers that belong to this agent (`IAgentResourceOwner`).
 *
 * A server created inside the agent is part of it: it is not in the MCP hub, no other agent can use it, it has no
 * endpoint of its own, and it is deleted together with the agent. It is created here (or from the tool picker),
 * managed in a drawer that shows the same screen as a hub server, and deleted here. Creating one binds all its tools
 * to the agent; deleting one takes its tools off the agent.
 */

import { useCallback, useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Drawer, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconServer, IconSettings, IconTrash } from '@tabler/icons-react';
import CreateMcpModal from '@/components/mcp/CreateMcpModal';
import McpDetailView from '@/components/mcp/McpDetailView';
import { useDeleteResource } from '@/components/common/confirm/useDeleteResource';
import { useCanWriteService } from '@/components/layout/launcher/LauncherContext';
import { useTranslations } from '@/lib/i18n';
import type { IAgentToolBinding } from '@/lib/database/provider/types.domain';

/** What this list shows of a server (`GET /api/mcp?agentId=…&owned=only`). */
interface OwnedServer {
  id: string;
  key: string;
  name: string;
  description?: string;
  sourceType?: string;
  status: string;
  tools?: Array<{ name: string }>;
  disabledTools?: string[];
}

const SOURCE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI',
  remote: 'Remote MCP',
  stdio: 'Package',
  internal: 'Internal service',
  composite: 'Composite',
};

export interface AgentOwnedMcpServersProps {
  agentId: string;
  /** The agent's tool bindings as currently edited. */
  bindings: IAgentToolBinding[];
  /** Saves new bindings: a created server's tools are bound, a deleted server's are taken off. */
  onBindingsChange: (bindings: IAgentToolBinding[]) => void | Promise<void>;
  /** A server was created, changed or deleted here: the page reloads what it knows of the agent's MCP servers. */
  onServersChanged?: () => void;
  readOnly?: boolean;
}

/** Every enabled tool of a server, as one binding. */
function bindingFor(server: OwnedServer): IAgentToolBinding {
  const disabled = new Set(server.disabledTools ?? []);
  return {
    source: 'mcp',
    sourceKey: server.key,
    toolNames: (server.tools ?? []).map((tool) => tool.name).filter((name) => !disabled.has(name)),
  };
}

export default function AgentOwnedMcpServers({
  agentId,
  bindings,
  onBindingsChange,
  onServersChanged,
  readOnly = false,
}: AgentOwnedMcpServersProps) {
  const canWrite = useCanWriteService('mcp') && !readOnly;
  const deleteResource = useDeleteResource();
  const tNouns = useTranslations('common.confirm.nouns');
  const [servers, setServers] = useState<OwnedServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<OwnedServer | null>(null);

  // Reloaded when the agent's MCP bindings change too: the tool picker can create one of these servers.
  const boundMcpKeys = bindings.filter((b) => b.source === 'mcp').map((b) => b.sourceKey).sort().join('|');
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mcp?agentId=${encodeURIComponent(agentId)}&owned=only`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { servers?: OwnedServer[] };
      setServers(data.servers ?? []);
    } catch {
      // Keep what is shown.
    } finally {
      setLoaded(true);
    }
  }, [agentId]);
  useEffect(() => {
    void load();
  }, [load, boundMcpKeys]);

  const unbind = async (server: OwnedServer) => {
    const next = bindings.filter((b) => !(b.source === 'mcp' && b.sourceKey === server.key));
    if (next.length !== bindings.length) await onBindingsChange(next);
  };

  const handleCreated = async (server: OwnedServer) => {
    setCreating(false);
    setServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)]);
    // Made from inside the agent so the agent can use it: all its tools are bound right away.
    const binding = bindingFor(server);
    if (binding.toolNames.length > 0) {
      await onBindingsChange([...bindings.filter((b) => !(b.source === 'mcp' && b.sourceKey === server.key)), binding]);
    }
    onServersChanged?.();
  };

  const handleDelete = async (server: OwnedServer) => {
    const deleted = await deleteResource({
      noun: tNouns('mcpServer'),
      name: server.name,
      type: 'mcp-server',
      id: server.id,
      extraWarning: 'It belongs to this agent only, so its tools are also taken off the agent.',
      action: async () => {
        const res = await fetch(`/api/mcp/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('The MCP server could not be deleted.');
      },
    });
    if (!deleted) return;
    notifications.show({ title: 'Deleted', message: `"${server.name}" was deleted`, color: 'red' });
    await afterDeleted(server);
  };

  const afterDeleted = async (server: OwnedServer) => {
    setServers((prev) => prev.filter((s) => s.id !== server.id));
    await unbind(server);
    onServersChanged?.();
  };

  const closeDrawer = () => {
    setManaging(null);
    // The drawer may have renamed it, changed its tools or switched it off.
    void load();
    onServersChanged?.();
  };

  return (
    <Stack gap="xs" data-testid="agent-owned-mcp">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={2}>
          <Text size="sm" fw={600}>This agent&apos;s MCP servers</Text>
          <Text size="xs" c="dimmed">
            Only this agent uses them. They are not in the MCP hub, have no endpoint of their own, and are deleted
            with the agent.
          </Text>
        </Stack>
        {canWrite ? (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => setCreating(true)}
            data-testid="agent-owned-mcp-create"
          >
            New MCP server
          </Button>
        ) : null}
      </Group>

      {loaded && servers.length === 0 ? (
        <Text size="xs" c="dimmed" fs="italic">No MCP servers of its own yet.</Text>
      ) : null}

      {servers.map((server) => {
        const total = server.tools?.length ?? 0;
        const enabled = total - (server.disabledTools?.length ?? 0);
        const used = bindings.find((b) => b.source === 'mcp' && b.sourceKey === server.key)?.toolNames.length ?? 0;
        return (
          <Paper key={server.id} withBorder radius="sm" p="xs">
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <IconServer size={16} style={{ flexShrink: 0 }} />
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} truncate>{server.name}</Text>
                    {server.status !== 'active' ? (
                      <Badge size="xs" variant="light" color="gray">Disabled</Badge>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed" truncate>
                    {SOURCE_LABELS[server.sourceType ?? 'openapi'] ?? server.sourceType}
                    {' · '}
                    {enabled === total ? `${total} tools` : `${enabled}/${total} tools`}
                    {' · '}
                    {used > 0 ? `${used} in use` : 'not in use'}
                  </Text>
                </Stack>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Button
                  size="compact-xs"
                  variant="default"
                  leftSection={<IconSettings size={12} />}
                  onClick={() => setManaging(server)}
                >
                  Manage
                </Button>
                {canWrite ? (
                  <Tooltip label="Delete server" withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={`Delete ${server.name}`}
                      onClick={() => void handleDelete(server)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
              </Group>
            </Group>
          </Paper>
        );
      })}

      {canWrite ? (
        <CreateMcpModal
          opened={creating}
          onClose={() => setCreating(false)}
          ownerAgentId={agentId}
          onCreated={(server) => void handleCreated(server as unknown as OwnedServer)}
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
                const server = managing;
                setManaging(null);
                void afterDeleted(server);
              },
            }}
          />
        ) : null}
      </Drawer>
    </Stack>
  );
}
