'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChartDots3,
  IconDatabase,
  IconDatabaseExport,
  IconEye,
  IconPlus,
  IconServer,
  IconSparkles,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import type {
  VectorIndexRecord,
  VectorProviderView,
} from '@/lib/services/vector';
import CreateVectorIndexModal from '@/components/vector/CreateVectorIndexModal';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface VectorDashboardData {
  overview: {
    totalProviders: number;
    activeProviders: number;
    disabledProviders: number;
    erroredProviders: number;
    totalIndexes: number;
  };
  providerBreakdown: Array<{ key: string; label: string; driver: string; status: string; indexCount: number }>;
  dimensionDistribution: Array<{ dimension: number; count: number }>;
  metricDistribution: Array<{ metric: string; count: number }>;
  recentIndexes: Array<{ key: string; name: string; providerKey: string; dimension: number; metric: string; createdAt?: string }>;
}

interface VectorIndexRow {
  provider: VectorProviderView;
  index: VectorIndexRecord;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function VectorIndexPage() {
  const router = useRouter();
  const [providers, setProviders] = useState<VectorProviderView[]>([]);
  const [indexesByProvider, setIndexesByProvider] = useState<
    Record<string, VectorIndexRecord[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [dashboardData, setDashboardData] = useState<VectorDashboardData | null>(
    null,
  );
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);
  const [deleteTarget, setDeleteTarget] = useState<VectorIndexRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');

  const loadDashboard = useCallback(async () => {
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/vector/dashboard?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) {
        setDashboardData((await res.json()) as VectorDashboardData);
      }
    } catch (err) {
      console.error('Failed to load vector dashboard', err);
    }
  }, [dateFilter]);

  const loadProvidersAndIndexes = useCallback(async () => {
    setRefreshing(true);
    try {
      const providerResponse = await fetch(
        '/api/vector/providers?includeIndexes=true',
        { cache: 'no-store' },
      );
      if (!providerResponse.ok) {
        throw new Error('Failed to load vector providers');
      }
      const providerData = await providerResponse.json();
      const fetchedProviders: VectorProviderView[] = providerData.providers ?? [];
      setProviders(fetchedProviders);

      const nextIndexes: Record<string, VectorIndexRecord[]> = {};
      Object.entries(
        (providerData.indexesByProvider ?? {}) as Record<string, VectorIndexRecord[]>,
      ).forEach(([key, value]) => {
        nextIndexes[key] = [...value];
      });
      fetchedProviders.forEach((provider) => {
        if (!nextIndexes[provider.key]) nextIndexes[provider.key] = [];
      });
      setIndexesByProvider(nextIndexes);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load vector data',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadProvidersAndIndexes();
    void loadDashboard();
  }, [loadProvidersAndIndexes, loadDashboard]);

  const rows = useMemo<VectorIndexRow[]>(() => {
    return providers.flatMap((provider) =>
      (indexesByProvider[provider.key] ?? []).map((index) => ({
        provider,
        index,
      })),
    );
  }, [providers, indexesByProvider]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (providerFilter !== 'all' && r.provider.key !== providerFilter)
        return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !r.index.name.toLowerCase().includes(q) &&
          !r.index.key.toLowerCase().includes(q) &&
          !r.provider.label.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, query, providerFilter]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/vector/indexes/${encodeURIComponent(deleteTarget.index.key)}?providerKey=${encodeURIComponent(deleteTarget.provider.key)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to delete index');
      }
      notifications.show({
        color: 'green',
        title: 'Vector index deleted',
        message: `${deleteTarget.index.name} has been removed.`,
      });
      setDeleteTarget(null);
      await loadProvidersAndIndexes();
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to delete index',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleIndexCreated = ({
    index,
    provider,
  }: {
    index: VectorIndexRecord;
    provider: VectorProviderView;
  }) => {
    setIndexesByProvider((current) => ({
      ...current,
      [provider.key]: [...(current[provider.key] ?? []), index],
    }));
    if (!providers.find((p) => p.key === provider.key)) {
      setProviders((current) => [...current, provider]);
    }
    setCreateModalOpen(false);
    router.push(`/dashboard/vector/${provider.key}/${index.key}`);
  };

  const columns: DataGridColumn<VectorIndexRow>[] = [
    {
      key: 'name',
      label: 'Index',
      render: ({ index }) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {index.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {index.key}
          </span>
        </div>
      ),
    },
    {
      key: 'provider',
      label: 'Provider',
      render: ({ provider }) => (
        <div className="ds-row ds-gap-xs">
          <StatusBadge
            status={provider.status === 'active' ? 'active' : 'paused'}
            label={provider.label}
          />
        </div>
      ),
    },
    {
      key: 'dimension',
      label: 'Dimension',
      align: 'right',
      render: ({ index }) => (
        <span className="ds-mono" style={{ fontSize: 12.5 }}>
          {index.dimension}
        </span>
      ),
    },
    {
      key: 'metric',
      label: 'Metric',
      render: ({ index }) => (
        <span className="ds-badge">{index.metric}</span>
      ),
    },
    {
      key: 'created',
      label: 'Created',
      render: ({ index }) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(index.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Vector"
        title="Knowledge Index"
        subtitle="Manage knowledge indexes across providers, inspect recent items, and launch queries."
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="default"
              size="sm"
              leftSection={<IconDatabaseExport size={14} stroke={1.7} />}
              onClick={() => router.push('/dashboard/vector/migrations')}
            >
              Migrations
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => setCreateModalOpen(true)}
            >
              Create index
            </Button>
          </>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total indexes"
          icon={<IconDatabase size={14} stroke={1.7} />}
          value={dashboardData?.overview.totalIndexes ?? rows.length}
        />
        <StatTile
          label="Providers"
          icon={<IconServer size={14} stroke={1.7} />}
          value={dashboardData?.overview.totalProviders ?? providers.length}
        />
        <StatTile
          label="Active providers"
          icon={<IconSparkles size={14} stroke={1.7} />}
          value={
            dashboardData?.overview.activeProviders ??
            providers.filter((p) => p.status === 'active').length
          }
        />
        <StatTile
          label="Errored providers"
          icon={<IconChartDots3 size={14} stroke={1.7} />}
          value={
            dashboardData?.overview.erroredProviders ??
            providers.filter((p) => p.status === 'errored').length
          }
        />
      </div>

      <DataGrid<VectorIndexRow>
        records={filtered}
        loading={loading}
        rowKey={(r) => `${r.provider.key}:${r.index.key}`}
        onRowClick={(r) =>
          router.push(`/dashboard/vector/${r.provider.key}/${r.index.key}`)
        }
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by index, key, or provider…',
        }}
        filters={[
          {
            value: providerFilter,
            onChange: setProviderFilter,
            ariaLabel: 'Filter by provider',
            width: 180,
            options: [
              { value: 'all', label: 'All providers' },
              ...providers.map((p) => ({ value: p.key, label: p.label })),
            ],
          },
        ]}
        onRefresh={loadProvidersAndIndexes}
        refreshing={refreshing}
        empty={{
          icon: <IconDatabase size={26} stroke={1.7} />,
          title:
            providers.length === 0 ? 'No vector providers' : 'No indexes yet',
          description:
            providers.length === 0
              ? 'Configure a vector provider first to start creating indexes.'
              : 'Create your first vector index to store and query embeddings.',
          primaryAction: {
            label: 'Create index',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${rows.length} indexes`}
        rowActions={(r) => [
          {
            id: 'open',
            label: 'View details',
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/vector/${r.provider.key}/${r.index.key}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete index',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(r),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete vector index"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete index <strong>{deleteTarget?.index.name}</strong>? This cannot be
          undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </Group>
      </Modal>

      <CreateVectorIndexModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onCreated={handleIndexCreated}
      />
    </PageContainer>
  );
}
