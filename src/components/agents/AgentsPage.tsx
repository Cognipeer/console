'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Paper,
  Center,
  Loader,
  Text,
  Group,
  Stack,
  ThemeIcon,
  Modal,
  TextInput,
  Textarea,
  Select,
  ActionIcon,
  Menu,
  Table,
  Badge,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconRobot,
  IconPlus,
  IconDotsVertical,
  IconTrash,
  IconEye,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import PageHeader from '@/components/layout/PageHeader';

interface Agent {
  _id: string;
  key: string;
  name: string;
  description?: string;
  config: {
    modelKey: string;
    systemPrompt?: string;
    promptKey?: string;
    temperature?: number;
    topP?: number;
  };
  status: string;
  createdAt: string;
}

interface Model {
  _id: string;
  key: string;
  name: string;
  modelId: string;
  category: string;
}

export default function AgentsPage() {
  const router = useRouter();
  const t = useTranslations('agents');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);

  const form = useForm({
    initialValues: {
      name: '',
      description: '',
      modelKey: '',
    },
    validate: {
      name: (v) => (!v.trim() ? t('validation.nameRequired') : null),
      modelKey: (v) => (!v ? t('validation.modelRequired') : null),
    },
  });

  const loadAgents = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setAgents(data.agents ?? []);
      }
    } catch (err) {
      console.error('Failed to load agents', err);
    } finally {
      setLoading(false);
    }
  };

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
      }
    } catch (err) {
      console.error('Failed to load models', err);
    }
  };

  useEffect(() => {
    loadAgents();
    loadModels();
  }, []);

  const handleCreate = async (values: typeof form.values) => {
    setCreating(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          config: {
            modelKey: values.modelKey,
            temperature: 0.7,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to create agent');
      }

      const data = await res.json();
      notifications.show({
        title: t('notifications.created'),
        message: t('notifications.createdDesc', { name: values.name }),
        color: 'teal',
      });
      setCreateModalOpen(false);
      form.reset();

      // Navigate to the new agent's detail page
      router.push(`/dashboard/agents/${data.agent._id}`);
    } catch (err: any) {
      notifications.show({
        title: t('notifications.error'),
        message: err.message,
        color: 'red',
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/agents/${deleteTarget._id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        notifications.show({
          title: t('notifications.deleted'),
          message: t('notifications.deletedDesc', { name: deleteTarget.name }),
          color: 'teal',
        });
        setDeleteTarget(null);
        loadAgents();
      }
    } catch (err) {
      notifications.show({
        title: t('notifications.error'),
        message: t('notifications.deleteFailed'),
        color: 'red',
      });
    }
  };

  return (
    <>
      <PageHeader
        icon={<IconRobot size={20} />}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setCreateModalOpen(true)}
          >
            {t('createAgent')}
          </Button>
        }
      />

      <Paper withBorder radius="md" p={0} style={{ overflow: 'hidden' }}>
        {loading ? (
          <Center p="xl">
            <Loader size="sm" />
          </Center>
        ) : agents.length === 0 ? (
          <Center p="xl">
            <Stack align="center" gap="sm">
              <ThemeIcon size={48} radius="xl" variant="light" color="gray">
                <IconRobot size={24} />
              </ThemeIcon>
              <Text size="lg" fw={600}>
                {t('empty.title')}
              </Text>
              <Text size="sm" c="dimmed" ta="center" maw={400}>
                {t('empty.description')}
              </Text>
              <Button
                size="sm"
                leftSection={<IconPlus size={14} />}
                onClick={() => setCreateModalOpen(true)}
              >
                {t('createAgent')}
              </Button>
            </Stack>
          </Center>
        ) : (
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('table.name')}</Table.Th>
                <Table.Th>{t('table.model')}</Table.Th>
                <Table.Th>{t('table.status')}</Table.Th>
                <Table.Th>{t('table.createdAt')}</Table.Th>
                <Table.Th style={{ width: 60 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {agents.map((agent) => (
                <Table.Tr
                  key={agent._id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => router.push(`/dashboard/agents/${agent._id}`)}
                >
                  <Table.Td>
                    <Group gap="xs">
                      <ThemeIcon size={28} radius="md" variant="light" color="violet">
                        <IconRobot size={14} />
                      </ThemeIcon>
                      <div>
                        <Text size="sm" fw={600}>
                          {agent.name}
                        </Text>
                        {agent.description && (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {agent.description}
                          </Text>
                        )}
                      </div>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{agent.config.modelKey}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant="light"
                      color={agent.status === 'active' ? 'teal' : 'gray'}
                    >
                      {agent.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {new Date(agent.createdAt).toLocaleDateString()}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <IconDotsVertical size={14} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          leftSection={<IconEye size={14} />}
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/dashboard/agents/${agent._id}`);
                          }}
                        >
                          {t('actions.view')}
                        </Menu.Item>
                        <Menu.Item
                          color="red"
                          leftSection={<IconTrash size={14} />}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(agent);
                          }}
                        >
                          {t('actions.delete')}
                        </Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      {/* Create Agent Modal */}
      <Modal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title={t('createModal.title')}
        size="md"
      >
        <form onSubmit={form.onSubmit(handleCreate)}>
          <Stack gap="md">
            <TextInput
              label={t('createModal.name')}
              placeholder={t('createModal.namePlaceholder')}
              required
              {...form.getInputProps('name')}
            />
            <Textarea
              label={t('createModal.description')}
              placeholder={t('createModal.descriptionPlaceholder')}
              rows={2}
              {...form.getInputProps('description')}
            />
            <Select
              label={t('createModal.model')}
              placeholder={t('createModal.modelPlaceholder')}
              required
              data={models.map((m) => ({
                value: m.key,
                label: `${m.name} (${m.modelId})`,
              }))}
              searchable
              {...form.getInputProps('modelKey')}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setCreateModalOpen(false)}>
                {t('createModal.cancel')}
              </Button>
              <Button type="submit" loading={creating}>
                {t('createModal.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteModal.title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {t('deleteModal.message')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)}>
              {t('deleteModal.cancel')}
            </Button>
            <Button color="red" onClick={handleDelete}>
              {t('deleteModal.delete')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
