'use client';

/**
 * Member management panel for a composite MCP server.
 *
 * A composite republishes tools from other MCP servers on the tenant — this
 * panel lets the operator add/remove members. Each member keeps its own
 * auth, its own tool enable/disable + rename overrides, its own request
 * logs and its own Aegis binding; this panel only decides *which* servers
 * are included. Naming collisions are resolved automatically by the backend
 * (see `allocateExposedNames` in `composite.ts`) — real tool names are kept
 * unless two members collide.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconExternalLink, IconPlus, IconX } from '@tabler/icons-react';
import { ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import type { McpSourceType } from '@/lib/database';

interface McpMemberSummary {
  serverId: string;
  serverKey: string;
  name: string;
  sourceType: McpSourceType;
  status: string;
  toolCount: number;
}

interface McpMemberOption {
  id: string;
  key: string;
  name: string;
  sourceType: McpSourceType;
  status: string;
  toolCount: number;
}

interface McpMembersPanelProps {
  serverId: string;
  members: McpMemberSummary[];
  onServerUpdated: (server: unknown) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI proxy',
  remote: 'Remote MCP',
  stdio: 'Stdio package',
  internal: 'Internal service',
};

export default function McpMembersPanel({ serverId, members, onServerUpdated }: McpMembersPanelProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [options, setOptions] = useState<McpMemberOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const memberIds = useMemo(() => new Set(members.map((m) => m.serverId)), [members]);

  useEffect(() => {
    if (!pickerOpen) return;
    fetch('/api/mcp?status=active')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = Array.isArray(data?.servers) ? data.servers : [];
        setOptions(
          list
            .filter((s: { id: string; sourceType?: string }) => s.id !== serverId && s.sourceType !== 'composite')
            .map((s: { id: string; key: string; name: string; sourceType?: string; status: string; tools?: unknown[] }) => ({
              id: s.id,
              key: s.key,
              name: s.name,
              sourceType: (s.sourceType ?? 'openapi') as McpSourceType,
              status: s.status,
              toolCount: s.tools?.length ?? 0,
            })),
        );
      })
      .catch(() => setOptions([]));
  }, [pickerOpen, serverId]);

  const patchMembers = async (nextServerIds: string[]) => {
    const res = await fetch(`/api/mcp/${serverId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compositeConfig: { members: nextServerIds.map((id) => ({ serverId: id })) },
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to update members');
    }
    const data = await res.json();
    onServerUpdated(data.server);
  };

  const handleAddSelected = async () => {
    if (selected.size === 0) return;
    setAdding(true);
    try {
      await patchMembers([...memberIds, ...selected]);
      notifications.show({ title: 'Members added', message: `${selected.size} member(s) added`, color: 'teal' });
      setSelected(new Set());
      setPickerOpen(false);
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to add members',
        color: 'red',
      });
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (memberId: string) => {
    setRemoving(memberId);
    try {
      await patchMembers([...memberIds].filter((id) => id !== memberId));
      notifications.show({ title: 'Member removed', message: 'Tools were rebuilt without it', color: 'teal' });
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to remove member',
        color: 'red',
      });
    } finally {
      setRemoving(null);
    }
  };

  const availableOptions = options.filter((o) => !memberIds.has(o.id));

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Each member keeps its own auth, enabled tools and request logs — this only decides which of
          their tools are republished here.
        </Text>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={13} />}
          onClick={() => setPickerOpen((v) => !v)}
        >
          Add member
        </Button>
      </Group>

      {members.length === 0 ? (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          This composite has no members — it publishes no tools and will not serve calls until you add one.
        </Alert>
      ) : (
        <Paper withBorder radius="md">
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Server</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Tools</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {members.map((m) => (
                <Table.Tr key={m.serverId}>
                  <Table.Td>
                    <Group gap={6}>
                      <Anchor href={`/dashboard/mcp/${m.serverId}`} size="sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {m.name} <IconExternalLink size={12} />
                      </Anchor>
                      <Text size="xs" c="dimmed" ff="monospace">{m.serverKey}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color="grape">
                      {SOURCE_LABELS[m.sourceType] ?? m.sourceType}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={m.status === 'active' ? 'teal' : 'gray'}>
                      {m.status === 'active' ? 'Active' : 'Disabled'}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{m.toolCount}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Button
                      variant="subtle"
                      color="red"
                      size="xs"
                      leftSection={<IconX size={13} />}
                      loading={removing === m.serverId}
                      onClick={() => void handleRemove(m.serverId)}
                    >
                      Remove
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}

      {pickerOpen ? (
        <Paper withBorder radius="md" p="md">
          <Stack gap="sm">
            <Text fw={600} size="sm">Add members</Text>
            {availableOptions.length === 0 ? (
              <Text size="sm" c="dimmed">
                No other eligible MCP servers — every active server on this project is already a member.
              </Text>
            ) : (
              <ToggleList>
                {availableOptions.map((o) => (
                  <ToggleRow
                    key={o.id}
                    label={o.name}
                    description={`${o.key} · ${SOURCE_LABELS[o.sourceType] ?? o.sourceType} · ${o.toolCount} tool${o.toolCount === 1 ? '' : 's'}`}
                    checked={selected.has(o.id)}
                    onChange={(checked) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(o.id);
                      else next.delete(o.id);
                      return next;
                    })}
                  />
                ))}
              </ToggleList>
            )}
            <Group justify="flex-end">
              <Button variant="default" size="xs" onClick={() => { setPickerOpen(false); setSelected(new Set()); }}>
                Cancel
              </Button>
              <Button
                size="xs"
                disabled={selected.size === 0}
                loading={adding}
                onClick={() => void handleAddSelected()}
              >
                Add {selected.size > 0 ? selected.size : ''} member{selected.size === 1 ? '' : 's'}
              </Button>
            </Group>
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
