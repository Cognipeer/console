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
  IconApi,
  IconCopy,
  IconCheck,
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import CreateMcpModal from '@/components/mcp/CreateMcpModal';
import type { McpServerView } from '@/lib/services/mcp';

const STATUS_COLORS: Record<string, string> = {
  active: 'teal',
  disabled: 'gray',
};

const AUTH_LABELS: Record<string, string> = {
  none: 'None',
  token: 'Bearer',
  header: 'Header',
  basic: 'Basic',
};

export default function McpServersPage() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServerView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const loadServers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers ?? []);
      }
    } catch (err) {
      console.error('Failed to load MCP servers', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadServers();
  }, []);

  const handleToggleStatus = async (s: McpServerView) => {
    try {
      const newStatus = s.status === 'active' ? 'disabled' : 'active';
      const res = await fetch(`/api/mcp/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update server');
      notifications.show({
        title: newStatus === 'active' ? 'Server enabled' : 'Server disabled',
        message: `"${s.name}" has been ${newStatus === 'active' ? 'enabled' : 'disabled'}`,
        color: newStatus === 'active' ? 'teal' : 'orange',
      });
      await loadServers();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const handleDelete = (s: McpServerView) => {
    setDeleteTarget(s);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/mcp/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Server deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadServers();
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

  const totalServers = servers.length;
  const activeServers = servers.filter((s) => s.status === 'active').length;
  const disabledServers = totalServers - activeServers;
  const totalTools = servers.reduce((sum, s) => sum + (s.tools?.length ?? 0), 0);

  return (
    <>
      <PageHeader
        icon={<IconApi size={20} />}
        title="MCP Servers"
        subtitle="Expose your APIs as Model Context Protocol servers. Upload an OpenAPI spec and get a unique MCP endpoint."
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New MCP Server
          </Button>
        }
      />

      {loading ? (
        <Paper withBorder radius="md">
          <Center p="xl">
            <Loader size="sm" />
          </Center>
        </Paper>
      ) : servers.length === 0 ? (
        <Paper withBorder radius="md">
          <Stack align="center" p="xl" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light" color="blue">
              <IconApi size={28} />
            </ThemeIcon>
            <Text fw={600} size="lg">No MCP Servers yet</Text>
            <Text c="dimmed" size="sm" ta="center" maw={400}>
              Create your first MCP server by uploading an OpenAPI specification.
              Each server gets a unique endpoint that tools and agents can consume.
            </Text>
            <Button
              mt="sm"
              leftSection={<IconPlus size={16} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create your first MCP server
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Total Servers</Text>
              <Text fw={700} size="xl" mt="xs">{totalServers}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Active</Text>
              <Text fw={700} size="xl" mt="xs" c="teal">{activeServers}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Disabled</Text>
              <Text fw={700} size="xl" mt="xs" c="gray">{disabledServers}</Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>Total Tools</Text>
              <Text fw={700} size="xl" mt="xs">{totalTools}</Text>
            </Paper>
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {servers.map((s) => (
              <Paper key={s.id} withBorder radius="md" p="md" style={{ opacity: s.status === 'active' ? 1 : 0.7 }}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                    <ThemeIcon
                      size={34}
                      radius="md"
                      variant="light"
                      color={s.status === 'active' ? 'blue' : 'gray'}
                    >
                      <IconApi size={18} />
                    </ThemeIcon>
                    <div style={{ minWidth: 0 }}>
                      <Text
                        fw={600}
                        size="sm"
                        component={Link}
                        href={`/dashboard/mcp/${s.id}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                        lineClamp={1}
                      >
                        {s.name}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {s.description || 'No description'}
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
                        onClick={() => router.push(`/dashboard/mcp/${s.id}`)}
                      >
                        View
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconEdit size={14} />}
                        onClick={() => router.push(`/dashboard/mcp/${s.id}`)}
                      >
                        Edit
                      </Menu.Item>
                      <Menu.Item
                        leftSection={s.status === 'active' ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                        onClick={() => handleToggleStatus(s)}
                      >
                        {s.status === 'active' ? 'Disable' : 'Enable'}
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={() => handleDelete(s)}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </Group>

                <Group gap="xs" mb="sm">
                  <Badge size="sm" variant="light" color={STATUS_COLORS[s.status] ?? 'gray'}>
                    {s.status === 'active' ? 'Active' : 'Disabled'}
                  </Badge>
                  <Badge size="sm" variant="light" color="indigo">
                    {s.tools?.length ?? 0} tools
                  </Badge>
                  <Badge size="sm" variant="light" color="gray">
                    {AUTH_LABELS[s.upstreamAuth?.type] ?? s.upstreamAuth?.type}
                  </Badge>
                </Group>

                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="xs" c="dimmed" ff="monospace" lineClamp={1}>
                    {s.key}
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <CopyButton value={s.key}>
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
                        onClick={() => router.push(`/dashboard/mcp/${s.id}`)}
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
        title="Delete MCP Server"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will remove the
          server endpoint and all associated request logs. This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateMcpModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(s) => {
          void loadServers();
          router.push(`/dashboard/mcp/${s.id}`);
        }}
      />
    </>
  );
}
