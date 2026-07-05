'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconEdit,
  IconEye,
  IconPlus,
  IconSparkles,
  IconTrash,
  IconWorldSearch,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import ProviderConfigModal from '@/components/providers/ProviderConfigModal';
import type { ProviderDescriptor } from '@/lib/providers/types';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';

const WEBSEARCH_DOMAIN = 'websearch' as const;

function hasAiAnswer(p: ProviderConfigView): boolean {
  return (
    ((p.settings as Record<string, unknown>)?.aiAnswer as { enabled?: boolean } | undefined)
      ?.enabled === true
  );
}

export default function WebSearchListPage() {
  const router = useRouter();
  const [instances, setInstances] = useState<ProviderConfigView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [editingInstance, setEditingInstance] = useState<ProviderConfigView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderConfigView | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/websearch/providers', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load web search instances');
      const data = await res.json();
      setInstances(data.providers ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDrivers = useCallback(async () => {
    setDriversLoading(true);
    try {
      const res = await fetch('/api/websearch/providers/drivers', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load drivers');
      const data = await res.json();
      setDrivers(data.drivers ?? []);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to load drivers',
      });
    } finally {
      setDriversLoading(false);
    }
  }, []);

  const openCreateModal = () => {
    setEditingInstance(null);
    setConfigOpen(true);
    void loadDrivers();
  };

  const openEditModal = (instance: ProviderConfigView) => {
    setEditingInstance(instance);
    setConfigOpen(true);
    void loadDrivers();
  };

  const summary = useMemo(() => {
    const active = instances.filter((p) => p.status === 'active').length;
    const aiEnabled = instances.filter(hasAiAnswer).length;
    return { total: instances.length, active, aiEnabled };
  }, [instances]);

  const filtered = useMemo(() => {
    if (!query) return instances;
    const q = query.toLowerCase();
    return instances.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        p.driver.toLowerCase().includes(q),
    );
  }, [instances, query]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      const res = await fetch(
        `/api/providers/${encodeURIComponent(String(deleteTarget._id))}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || 'Failed to delete');
      }
      notifications.show({ color: 'teal', title: 'Deleted', message: 'Instance removed' });
      setDeleteTarget(null);
      await load();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed',
      });
    }
  }

  const columns: DataGridColumn<ProviderConfigView>[] = [
    {
      key: 'label',
      label: 'Instance',
      render: (p) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {p.label}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{p.key}</span>
        </div>
      ),
    },
    {
      key: 'driver',
      label: 'Engine',
      render: (p) => <span className="ds-badge">{p.driver}</span>,
    },
    {
      key: 'ai',
      label: 'AI answer',
      render: (p) =>
        hasAiAnswer(p) ? (
          <span className="ds-badge ds-badge-ok">
            <IconSparkles size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
            on
          </span>
        ) : (
          <span className="ds-faint">off</span>
        ),
    },
    {
      key: 'credentials',
      label: 'Credentials',
      render: (p) =>
        p.hasCredentials ? (
          <span className="ds-badge ds-badge-ok">configured</span>
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (p) => (
        <StatusBadge status={p.status === 'active' ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Web Search"
        title="Web Search"
        subtitle="Create search instances backed by Bing, Brave, Serper, Tavily, self-hosted SearxNG or keyless DuckDuckGo. Open one to run queries and inspect its logs."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={openCreateModal}
          >
            Create instance
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Instances"
          icon={<IconWorldSearch size={14} stroke={1.7} />}
          value={summary.total}
        />
        <StatTile label="Active" value={summary.active} />
        <StatTile label="AI answers enabled" value={summary.aiEnabled} />
      </div>

      <DataGrid<ProviderConfigView>
        records={filtered}
        loading={loading}
        rowKey={(p) => String(p._id)}
        onRowClick={(p) => router.push(`/dashboard/websearch/${encodeURIComponent(p.key)}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search by name, key, engine…',
        }}
        onRefresh={load}
        refreshing={refreshing}
        empty={{
          icon: <IconWorldSearch size={26} stroke={1.7} />,
          title: 'No web search instances yet',
          description:
            'Create an instance (Bing, Brave, Serper, Tavily, SearxNG or DuckDuckGo) to search the web from agents, the API and this dashboard.',
          primaryAction: {
            label: 'Create your first instance',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: openCreateModal,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${instances.length} instances`}
        rowActions={(p) => [
          {
            id: 'open',
            label: 'Open instance',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/websearch/${encodeURIComponent(p.key)}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => openEditModal(p),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(p),
          },
        ]}
      />

      <ProviderConfigModal
        opened={configOpen}
        onClose={() => {
          setConfigOpen(false);
          setEditingInstance(null);
        }}
        mode={editingInstance ? 'edit' : 'create'}
        provider={editingInstance ?? undefined}
        drivers={drivers}
        driversLoading={driversLoading}
        domain={WEBSEARCH_DOMAIN}
        onSubmit={async (options) => {
          if (editingInstance) {
            const updatePayload: Record<string, unknown> = {
              label: options.values.base.label,
              description: options.values.base.description,
              status: options.values.base.status,
              settings: options.values.settings,
              metadata: options.values.metadata,
            };
            if (Object.keys(options.values.credentials).length > 0) {
              updatePayload.credentials = options.values.credentials;
            }
            const res = await fetch(
              `/api/providers/${encodeURIComponent(String(editingInstance._id))}`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(updatePayload),
              },
            );
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error || 'Failed to update instance');
            notifications.show({
              color: 'teal',
              title: 'Web Search',
              message: 'Instance updated',
            });
          } else {
            const payload: Record<string, unknown> = {
              key: options.values.base.key,
              label: options.values.base.label,
              description: options.values.base.description,
              driver: options.driver,
              type: WEBSEARCH_DOMAIN,
              status: options.values.base.status,
              credentials: options.values.credentials,
              settings: options.values.settings,
              metadata: options.values.metadata,
            };
            const res = await fetch('/api/providers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) throw new Error(body?.error || 'Failed to create instance');
            notifications.show({
              color: 'teal',
              title: 'Web Search',
              message: 'Instance created',
            });
            const createdKey = body?.provider?.key ?? options.values.base.key;
            setConfigOpen(false);
            setEditingInstance(null);
            router.push(`/dashboard/websearch/${encodeURIComponent(String(createdKey))}`);
            return;
          }
          setConfigOpen(false);
          setEditingInstance(null);
          await load();
        }}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete instance"
        centered
        size="sm"
      >
        <Stack gap="md">
          <span>
            Delete <strong>{deleteTarget?.label}</strong>? API calls using key{' '}
            <code>{deleteTarget?.key}</code> will start failing.
          </span>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={confirmDelete}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
