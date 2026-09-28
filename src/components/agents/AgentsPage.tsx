'use client';

import { useEffect, useMemo, useState } from 'react';
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
  IconFileImport,
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
import ImportAgentShell from './ImportAgentShell';

interface Agent {
  _id: string;
  key: string;
  name: string;
  description?: string;
  config: {
    modelKey?: string;
    kind?: 'native' | 'external';
    connection?: { protocol?: string };
    toolBindings?: Array<{ toolNames?: string[] }>;
    knowledgeEngineKey?: string;
    memory?: { enabled?: boolean };
    subagents?: unknown[];
  };
  status: string;
  publishedVersion?: number | null;
  createdAt: string;
  updatedAt?: string;
}

type StatusFilter = 'all' | 'active' | 'inactive' | 'draft';
type KindFilter = 'all' | 'native' | 'external';
type PublishFilter = 'all' | 'published' | 'unpublished';

/** Tools the agent can call by name — the bound ones; knowledge/memory are shown as capability chips. */
function boundToolCount(agent: Agent): number {
  return (agent.config.toolBindings ?? []).reduce((sum, b) => sum + (b.toolNames?.length ?? 0), 0);
}

/** A create-menu entry: title over a one-line description. */
function MenuOption({ title, description }: { title: string; description: string }) {
  return (
    <div className="ds-col" style={{ gap: 1 }}>
      <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
      <span className="ds-muted" style={{ fontSize: 11 }}>
        {description}
      </span>
    </div>
  );
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
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [publishFilter, setPublishFilter] = useState<PublishFilter>('all');
  const [modelFilter, setModelFilter] = useState('all');

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
    setImportOpen(false);
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

  // Model options come from the agents actually listed, so the filter never
  // offers a model no agent uses (an empty result that looks like a bug).
  const modelOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const a of agents) if (a.config.kind !== 'external' && a.config.modelKey) keys.add(a.config.modelKey);
    return [...keys].sort();
  }, [agents]);

  const filtered = useMemo(() => agents.filter((a) => {
    const q = query.trim().toLowerCase();
    if (q) {
      // The key is included: it is what API callers put in `model`, so it is
      // what someone reading a log or a trace will paste here.
      const hit =
        a.name.toLowerCase().includes(q) ||
        a.key.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (a.config.modelKey ?? '').toLowerCase().includes(q) ||
        (a.config.connection?.protocol ?? '').toLowerCase().includes(q);
      if (!hit) return false;
    }
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    const kind = a.config.kind === 'external' ? 'external' : 'native';
    if (kindFilter !== 'all' && kind !== kindFilter) return false;
    // API channels run the PUBLISHED version, so "never published" is the
    // set of agents no external caller can actually reach yet.
    if (publishFilter === 'published' && !a.publishedVersion) return false;
    if (publishFilter === 'unpublished' && a.publishedVersion) return false;
    if (modelFilter !== 'all' && a.config.modelKey !== modelFilter) return false;
    return true;
  }), [agents, query, statusFilter, kindFilter, publishFilter, modelFilter]);

  const filtersApplied =
    Boolean(query.trim()) || statusFilter !== 'all' || kindFilter !== 'all'
    || publishFilter !== 'all' || modelFilter !== 'all';

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
      key: 'published',
      label: 'Published',
      render: (agent) => (
        agent.config.kind === 'external'
          ? <span className="ds-faint" style={{ fontSize: 12 }}>—</span>
          : agent.publishedVersion
            ? <Badge size="xs" variant="light" color="teal">v{agent.publishedVersion}</Badge>
            : <Badge size="xs" variant="light" color="gray">draft only</Badge>
      ),
    },
    {
      key: 'capabilities',
      label: 'Capabilities',
      render: (agent) => {
        const tools = boundToolCount(agent);
        return (
          <Group gap={4} wrap="nowrap">
            {tools > 0 ? <Badge size="xs" variant="outline" color="gray">{tools} tools</Badge> : null}
            {agent.config.knowledgeEngineKey ? <Badge size="xs" variant="outline" color="blue">knowledge</Badge> : null}
            {agent.config.memory?.enabled ? <Badge size="xs" variant="outline" color="grape">memory</Badge> : null}
            {agent.config.subagents?.length ? (
              <Badge size="xs" variant="outline" color="violet">{agent.config.subagents.length} sub-agents</Badge>
            ) : null}
            {!tools && !agent.config.knowledgeEngineKey && !agent.config.memory?.enabled && !agent.config.subagents?.length
              ? <span className="ds-faint" style={{ fontSize: 12 }}>—</span>
              : null}
          </Group>
        );
      },
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
                <MenuOption title={t('createAgent')} description={t('createAgentDesc')} />
              </Menu.Item>
              <Menu.Item
                leftSection={<IconPlugConnected size={15} />}
                onClick={() => setConnectModalOpen(true)}
              >
                <MenuOption title={t('connectAgent')} description={t('connectAgentDesc')} />
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item
                leftSection={<IconFileImport size={15} />}
                onClick={() => setImportOpen(true)}
              >
                <MenuOption
                  title="Import"
                  description="From a Claude Managed Agent or an agent manifest (YAML / JSON)"
                />
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
          placeholder: 'Search name, key, model…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: (v) => setStatusFilter(v as StatusFilter),
            ariaLabel: 'Filter by status',
            width: 130,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'draft', label: 'Draft' },
              { value: 'inactive', label: 'Inactive' },
            ],
          },
          {
            value: publishFilter,
            onChange: (v) => setPublishFilter(v as PublishFilter),
            ariaLabel: 'Filter by published version',
            width: 150,
            options: [
              { value: 'all', label: 'Any version' },
              { value: 'published', label: 'Published' },
              { value: 'unpublished', label: 'Never published' },
            ],
          },
          {
            value: kindFilter,
            onChange: (v) => setKindFilter(v as KindFilter),
            ariaLabel: 'Filter by agent kind',
            width: 130,
            options: [
              { value: 'all', label: 'All kinds' },
              { value: 'native', label: 'Built here' },
              { value: 'external', label: 'Connected' },
            ],
          },
          {
            value: modelFilter,
            onChange: setModelFilter,
            ariaLabel: 'Filter by model',
            width: 170,
            options: [
              { value: 'all', label: 'All models' },
              ...modelOptions.map((key) => ({ value: key, label: key })),
            ],
          },
        ]}
        toolbarRight={filtersApplied ? (
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => {
              setQuery('');
              setStatusFilter('all');
              setKindFilter('all');
              setPublishFilter('all');
              setModelFilter('all');
            }}
          >
            Clear filters
          </Button>
        ) : undefined}
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

      <ImportAgentShell
        opened={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleCreated}
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
