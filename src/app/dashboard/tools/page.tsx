'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconTool,
  IconCopy,
  IconCheck,
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconApi,
  IconCloud,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import CreateToolModal from '@/components/tools/CreateToolModal';
import type { ToolView } from '@/lib/services/tools';

const STATUS_COLORS: Record<string, string> = {
  active: 'teal',
  disabled: 'gray',
};

const TYPE_COLORS: Record<string, string> = {
  openapi: 'indigo',
  mcp: 'violet',
};

const TYPE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI',
  mcp: 'MCP',
};

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const loadTools = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tools', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setTools(data.tools ?? []);
      }
    } catch (err) {
      console.error('Failed to load tools', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const handleToggleStatus = async (t: ToolView) => {
    try {
      const newStatus = t.status === 'active' ? 'disabled' : 'active';
      const res = await fetch(`/api/tools/${t.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update tool');
      notifications.show({
        title: newStatus === 'active' ? 'Tool enabled' : 'Tool disabled',
        message: `"${t.name}" has been ${newStatus === 'active' ? 'enabled' : 'disabled'}`,
        color: newStatus === 'active' ? 'teal' : 'orange',
      });
      await loadTools();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const handleDelete = (t: ToolView) => {
    setDeleteTarget(t);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/tools/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Tool deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadTools();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const totalTools = tools.length;
  const activeTools = tools.filter((t) => t.status === 'active').length;
  const disabledTools = totalTools - activeTools;
  const totalActions = tools.reduce((sum, t) => sum + (t.actions?.length ?? 0), 0);

  return (
    <>
      <PageHeader
        icon={<IconTool size={20} />}
        title="Tools"
        subtitle="Manage tools from OpenAPI specs or MCP servers. Tools are available for agents and direct API execution."
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New Tool
          </Button>
        }
      />

      {loading ? (
        <Paper withBorder radius="md">
          <Center p="xl">
            <Loader size="sm" />
          </Center>
        </Paper>
      ) : tools.length === 0 ? (
        <Paper withBorder radius="md">
          <Stack align="center" p="xl" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light" color="blue">
              <IconTool size={28} />
            </ThemeIcon>
            <Text fw={600} size="lg">No tools yet</Text>
            <Text c="dimmed" size="sm" ta="center" maw={400}>
              Add your first tool by importing an OpenAPI specification or connecting to an MCP server.
              Tools can be used by agents or called directly via the API.
            </Text>
            <Button
              mt="sm"
              leftSection={<IconPlus size={16} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create your first tool
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Total Tools</Text>
              <Text fw={700} size="xl" mt="xs">{totalTools}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Active</Text>
              <Text fw={700} size="xl" mt="xs" c="teal">{activeTools}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Disabled</Text>
              <Text fw={700} size="xl" mt="xs" c="gray">{disabledTools}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Total Actions</Text>
              <Text fw={700} size="xl" mt="xs">{totalActions}</Text>
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {tools.map((t) => (
              <Paper key={t.id} withBorder radius="md" p="md" style={{ opacity: t.status === 'active' ? 1 : 0.7 }}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <ThemeIcon
                      size={34}
                      radius="md"
                      variant="light"
                      color={t.type === 'openapi' ? 'indigo' : 'violet'}
                    >
                      {t.type === 'openapi' ? <IconApi size={18} /> : <IconCloud size={18} />}
                    </ThemeIcon>
                    <div style={{ minWidth: 0 }}>
                      <Text
                        fw={600}
                        size="sm"
                        component={Link}
                        href={`/dashboard/tools/${t.id}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                        lineClamp={1}
                      >
                        {t.name}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {t.description || 'No description'}
                      </Text>
                    </div>
                  </Group>

                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" size="sm">
                        <IconDotsVertical size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconEye size={14} />}
                        onClick={() => router.push(`/dashboard/tools/${t.id}`)}
                      >
                        View
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconEdit size={14} />}
                        onClick={() => router.push(`/dashboard/tools/${t.id}`)}
                      >
                        Edit
                      </Menu.Item>
                      <Menu.Item
                        leftSection={t.status === 'active' ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                        onClick={() => handleToggleStatus(t)}
                      >
                        {t.status === 'active' ? 'Disable' : 'Enable'}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => handleDelete(t)}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>

                <Group gap="xs" mb="sm">
                  <Badge size="sm" variant="light" color={STATUS_COLORS[t.status] ?? 'gray'}>
                    {t.status === 'active' ? 'Active' : 'Disabled'}
                  </Badge>
                  <Badge size="sm" variant="light" color={TYPE_COLORS[t.type] ?? 'gray'}>
                    {TYPE_LABELS[t.type] ?? t.type}
                  </Badge>
                  <Badge size="sm" variant="light" color="blue">
                    {t.actions?.length ?? 0} actions
                  </Badge>
                </Group>

                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>
                    {t.key}
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <CopyButton value={t.key}>
                      {({ copied, copy }) => (
                        <Tooltip label={copied ? 'Copied' : 'Copy key'}>
                          <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} size="sm" onClick={copy}>
                            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </CopyButton>
                    <Tooltip label="View details">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => router.push(`/dashboard/tools/${t.id}`)}
                      >
                        <IconEye size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                </Group>
              </Paper>
            ))}
          </SimpleGrid>
        </Stack>
      )}

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete Tool"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will remove the
          tool and all its actions. Agents that reference this tool will no longer have access to it. This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateToolModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(t) => {
          void loadTools();
          router.push(`/dashboard/tools/${t.id}`);
        }}
      />
    </>
  );
}
