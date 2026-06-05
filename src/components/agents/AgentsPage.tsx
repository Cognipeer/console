'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconEye,
  IconPlugConnected,
  IconPlus,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateAgentModal from './CreateAgentModal';
import ConnectAgentModal from './ConnectAgentModal';

interface Agent {
  _id: string;
  key: string;
  name: string;
  description?: string;
  config: {
    modelKey?: string;
    kind?: 'native' | 'external';
    connection?: { protocol?: string };
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

interface Provider {
  _id?: string;
  key: string;
  label?: string;
  name?: string;
}

export default function AgentsPage() {
  const router = useRouter();
  const t = useTranslations('agents');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [query, setQuery] = useState('');

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

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/providers?scope=tenant', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers ?? []);
      }
    } catch (err) {
      console.error('Failed to load providers', err);
    }
  };

  useEffect(() => {
    void loadAgents();
    void loadModels();
    void loadProviders();
  }, []);

  const handleCreated = (agentId: string) => {
    setCreateModalOpen(false);
    setConnectModalOpen(false);
    router.push(`/dashboard/agents/${agentId}`);
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
      (a.config.modelKey ?? '').toLowerCase().includes(q) ||
      (a.config.connection?.protocol ?? '').toLowerCase().includes(q)
    );
  });

  const columns: DataGridColumn<Agent>[] = [
    {
      key: 'name',
      label: t('table.name'),
      render: (agent) => (
        <div className="ds-col" style={{ gap: 2 }}>
          <Group gap={6} wrap="nowrap">
            <span style={{ fontSize: 13, fontWeight: 500 }}>{agent.name}</span>
            {agent.config.kind === 'external' ? (
              <Badge
                size="xs"
                variant="light"
                color="violet"
                leftSection={<IconPlugConnected size={10} />}
              >
                {t('connectedBadge')}
              </Badge>
            ) : null}
          </Group>
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
          {agent.config.kind === 'external'
            ? (agent.config.connection?.protocol ?? 'external')
            : (agent.config.modelKey ?? '—')}
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
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button
                color="teal"
                size="sm"
                leftSection={<IconPlus size={14} stroke={1.7} />}
                rightSection={<IconChevronDown size={14} />}
              >
                {t('createAgent')}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconRobot size={15} />}
                onClick={() => setCreateModalOpen(true)}
              >
                <div className="ds-col" style={{ gap: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{t('createAgent')}</span>
                  <span className="ds-muted" style={{ fontSize: 11 }}>
                    {t('createAgentDesc')}
                  </span>
                </div>
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlugConnected size={15} />}
                onClick={() => setConnectModalOpen(true)}
              >
                <div className="ds-col" style={{ gap: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{t('connectAgent')}</span>
                  <span className="ds-muted" style={{ fontSize: 11 }}>
                    {t('connectAgentDesc')}
                  </span>
                </div>
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
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

      <CreateAgentModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        models={models}
        onCreated={handleCreated}
      />

      <ConnectAgentModal
        opened={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        providers={providers.map((p) => ({ key: p.key, label: p.label || p.name || p.key }))}
        onCreated={handleCreated}
      />

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
