'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconEye,
  IconPlus,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';

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
  const [query, setQuery] = useState('');

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
    void loadAgents();
    void loadModels();
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

      router.push(`/dashboard/agents/${data.agent._id}`);
    } catch (err: unknown) {
      notifications.show({
        title: t('notifications.error'),
        message: err instanceof Error ? err.message : 'Error',
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
        void loadAgents();
      }
    } catch {
      notifications.show({
        title: t('notifications.error'),
        message: t('notifications.deleteFailed'),
        color: 'red',
      });
    }
  };

  const filtered = agents.filter((a) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      (a.description ?? '').toLowerCase().includes(q) ||
      a.config.modelKey.toLowerCase().includes(q)
    );
  });

  const columns: DataGridColumn<Agent>[] = [
    {
      key: 'name',
      label: t('table.name'),
      render: (agent) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</span>
          {agent.description ? (
            <span
              className="ds-muted"
              style={{
                fontSize: 11.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 360,
              }}
            >
              {agent.description}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'model',
      label: t('table.model'),
      render: (agent) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {agent.config.modelKey}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('table.status'),
      render: (agent) => (
        <StatusBadge
          status={agent.status === 'active' ? 'active' : 'paused'}
          label={agent.status}
        />
      ),
    },
    {
      key: 'created',
      label: t('table.createdAt'),
      render: (agent) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {new Date(agent.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Agents"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateModalOpen(true)}
          >
            {t('createAgent')}
          </Button>
        }
      />

      <DataGrid<Agent>
        records={filtered}
        loading={loading}
        rowKey={(a) => a._id}
        onRowClick={(a) => router.push(`/dashboard/agents/${a._id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search agents…',
        }}
        onRefresh={() => void loadAgents()}
        refreshing={loading}
        empty={{
          icon: <IconRobot size={26} stroke={1.7} />,
          title: t('empty.title'),
          description: t('empty.description'),
          primaryAction: {
            label: t('createAgent'),
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${agents.length} agents`}
        rowActions={(agent) => [
          {
            id: 'view',
            label: t('actions.view'),
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/agents/${agent._id}`),
          },
          {
            id: 'delete',
            label: t('actions.delete'),
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(agent),
          },
        ]}
      />

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
              <Button type="submit" color="teal" loading={creating}>
                {t('createModal.create')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('deleteModal.title')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{t('deleteModal.message')}</Text>
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
    </PageContainer>
  );
}
