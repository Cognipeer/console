'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconPlus,
  IconShield,
  IconShieldOff,
  IconTrash,
  IconPlayerPlay,
} from '@tabler/icons-react';
import PageHeader from '@/components/layout/PageHeader';
import CreateGuardrailModal from '@/components/guardrails/CreateGuardrailModal';
import type { GuardrailView } from '@/lib/services/guardrail/constants';

interface ModelOption {
  value: string;
  label: string;
}

const TYPE_COLORS: Record<string, string> = {
  preset: 'violet',
  custom: 'teal',
};

const ACTION_COLORS: Record<string, string> = {
  block: 'red',
  warn: 'orange',
  flag: 'blue',
};

const TARGET_LABELS: Record<string, string> = {
  input: 'Input',
  output: 'Output',
  both: 'Both',
};

export default function GuardrailsPage() {
  const [guardrails, setGuardrails] = useState<GuardrailView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<GuardrailView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  const loadGuardrails = async () => {
    setLoading(true);
    try {
      const [grRes, modelsRes] = await Promise.all([
        fetch('/api/guardrails', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);

      if (grRes.ok) {
        const data = await grRes.json();
        setGuardrails(data.guardrails ?? []);
      }

      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setModels(
          (data.models ?? []).map((m: { key: string; name: string }) => ({
            value: m.key,
            label: m.name,
          })),
        );
      }
    } catch (err) {
      console.error('Failed to load guardrails', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGuardrails();
  }, []);

  const handleToggleEnabled = async (g: GuardrailView) => {
    try {
      const res = await fetch(`/api/guardrails/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !g.enabled }),
      });
      if (!res.ok) throw new Error('Failed to update guardrail');
      notifications.show({
        title: g.enabled ? 'Guardrail disabled' : 'Guardrail enabled',
        message: `"${g.name}" has been ${g.enabled ? 'disabled' : 'enabled'}`,
        color: g.enabled ? 'orange' : 'teal',
      });
      await loadGuardrails();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const handleDelete = (g: GuardrailView) => {
    setDeleteTarget(g);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/guardrails/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Guardrail deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadGuardrails();
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

  const rows = guardrails.map((g) => (
    <Table.Tr key={g.id} style={{ opacity: g.enabled ? 1 : 0.55 }}>
      <Table.Td>
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon
            size={30}
            radius="sm"
            variant="light"
            color={g.enabled ? TYPE_COLORS[g.type] ?? 'gray' : 'gray'}
          >
            {g.enabled ? <IconShield size={15} /> : <IconShieldOff size={15} />}
          </ThemeIcon>
          <div>
            <Text
              fw={500}
              size="sm"
              component={Link}
              href={`/dashboard/guardrails/${g.id}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              {g.name}
            </Text>
            {g.description && (
              <Text size="xs" c="dimmed" lineClamp={1}>{g.description}</Text>
            )}
          </div>
        </Group>
      </Table.Td>

      <Table.Td>
        <Badge size="sm" variant="light" color={TYPE_COLORS[g.type] ?? 'gray'}>
          {g.type}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Badge size="sm" variant="light" color="gray">
          {TARGET_LABELS[g.target] ?? g.target}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Badge size="sm" variant="light" color={ACTION_COLORS[g.action] ?? 'gray'}>
          {g.action}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Badge
          size="sm"
          variant="light"
          color={g.enabled ? 'teal' : 'gray'}
        >
          {g.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </Table.Td>

      <Table.Td>
        <Text size="xs" c="dimmed">
          {g.createdAt
            ? new Date(g.createdAt).toLocaleDateString()
            : '—'}
        </Text>
      </Table.Td>

      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Tooltip label="View details">
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => router.push(`/dashboard/guardrails/${g.id}`)}
            >
              <IconEye size={14} />
            </ActionIcon>
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="sm">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconEdit size={14} />}
                onClick={() => router.push(`/dashboard/guardrails/${g.id}`)}
              >
                Edit
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => router.push(`/dashboard/guardrails/${g.id}?tab=test`)}
              >
                Test
              </Menu.Item>
              <Menu.Item
                leftSection={g.enabled ? <IconShieldOff size={14} /> : <IconShield size={14} />}
                onClick={() => handleToggleEnabled(g)}
              >
                {g.enabled ? 'Disable' : 'Enable'}
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={() => handleDelete(g)}
              >
                Delete
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Table.Td>
    </Table.Tr>
  ));

  return (
    <>
      <PageHeader
        icon={<IconShield size={20} />}
        title="AI Governance"
        subtitle="Define safety policies to protect your AI services from harmful or policy-violating content."
        actions={
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New Guardrail
          </Button>
        }
      />

      <Paper withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
        {loading ? (
          <Center p="xl">
            <Loader size="sm" />
          </Center>
        ) : guardrails.length === 0 ? (
          <Stack align="center" p="xl" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light" color="violet">
              <IconShield size={28} />
            </ThemeIcon>
            <Text fw={600} size="lg">No guardrails yet</Text>
            <Text c="dimmed" size="sm" ta="center" maw={400}>
              Guardrails protect your AI services from harmful content, PII leaks,
              prompt injection, and policy violations.
            </Text>
            <Button
              mt="sm"
              leftSection={<IconPlus size={16} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create your first guardrail
            </Button>
          </Stack>
        ) : (
          <Table horizontalSpacing="md" verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        )}
      </Paper>

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete guardrail"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateGuardrailModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(g) => {
          void loadGuardrails();
          router.push(`/dashboard/guardrails/${g.id}`);
        }}
        models={models}
      />
    </>
  );
}
