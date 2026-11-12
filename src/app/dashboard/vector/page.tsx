'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { errorMessage } from '@/lib/api/client';
import { useProjectScope } from '@/lib/api/queries/projectScope';
import {
  useDeleteVectorIndex,
  useVectorDashboard,
  useVectorProvidersWithIndexes,
  vectorKeys,
  type VectorProvidersWithIndexes,
} from '@/lib/api/queries/vector';
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
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import type {
  VectorIndexView,
  VectorProviderView,
} from '@/lib/services/vector';
import { formatBytes } from '@/components/files/shared/format';
import CreateVectorIndexModal from '@/components/vector/CreateVectorIndexModal';
import VectorProviderModal from '@/components/vector/VectorProviderModal';
import { useCanWriteService } from '@/components/layout/launcher/LauncherContext';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface VectorIndexRow {
  provider: VectorProviderView;
  index: VectorIndexView;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function VectorIndexPage() {
  const deleteResource = useDeleteResource();
  const tSafe = useTranslations('common.confirm.dataSafety');
  const tPlatform = useTranslations('platformStorage');
  const router = useRouter();
  const queryClient = useQueryClient();
  const project = useProjectScope();
  const providersQuery = useVectorProvidersWithIndexes();
  const deleteIndex = useDeleteVectorIndex();
  const providers = useMemo<VectorProviderView[]>(() => providersQuery.data?.providers ?? [], [providersQuery.data]);
  const indexesByProvider = useMemo<Record<string, VectorIndexView[]>>(
    () => providersQuery.data?.indexesByProvider ?? {},
    [providersQuery.data],
  );
  const loading = providersQuery.isPending;
  const refreshing = providersQuery.isFetching;
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  // Adding a provider or an index is a write to Vector (POST /api/vector/providers, /api/vector/indexes). Unknown until
  // the session answers: the page then explains instead of offering a button that may be refused.
  const canWriteVector = useCanWriteService('vector');
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const dashboardParams = useMemo(() => buildDashboardDateSearchParams(dateFilter), [dateFilter]);
  const dashboardData = useVectorDashboard(dashboardParams).data ?? null;
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');

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

  const confirmDelete = (target: VectorIndexRow) =>
    deleteResource({
      noun: tSafe('nouns.vectorIndex'),
      name: target.index.name,
      type: 'vector-index',
      id: target.index._id ? String(target.index._id) : undefined,
      extraWarning: tSafe('vectorIndexExtra'),
      action: async () => {
        try {
          await deleteIndex.mutateAsync({ indexKey: target.index.key, providerKey: target.provider.key });
        } catch (error) {
          throw new Error(errorMessage(error, 'Failed to delete index'));
        }
        notifications.show({
          color: 'green',
          title: 'Vector index deleted',
          message: `${target.index.name} has been removed.`,
        });
      },
    });

  const updateProviders = (update: (current: VectorProvidersWithIndexes) => VectorProvidersWithIndexes) =>
    queryClient.setQueryData<VectorProvidersWithIndexes>(vectorKeys.providersWithIndexes(project), (current) =>
      update(current ?? { providers: [], indexesByProvider: {} }),
    );

  const handleIndexCreated = ({
    index,
    provider,
  }: {
    index: VectorIndexView;
    provider: VectorProviderView;
  }) => {
    // The create mutation rereads the lists; the row is shown at once meanwhile.
    updateProviders((current) => ({
      providers: current.providers.some((p) => p.key === provider.key) ? current.providers : [...current.providers, provider],
      indexesByProvider: {
        ...current.indexesByProvider,
        [provider.key]: [...(current.indexesByProvider[provider.key] ?? []), index],
      },
    }));
    setCreateModalOpen(false);
    router.push(`/dashboard/vector/${provider.key}/${index.key}`);
  };

  /** A provider was added from the empty state: the index form comes next, with it selected. */
  const handleProviderCreated = (provider: VectorProviderView) => {
    updateProviders((current) => ({
      providers: current.providers.some((p) => p.key === provider.key) ? current.providers : [...current.providers, provider],
      indexesByProvider: { ...current.indexesByProvider, [provider.key]: current.indexesByProvider[provider.key] ?? [] },
    }));
    setProviderModalOpen(false);
    setCreateModalOpen(true);
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
          {provider.platform ? <span className="ds-badge ds-badge-info">{tPlatform('badge')}</span> : null}
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
      key: 'storedSize',
      label: tPlatform('vector.storedSize'),
      align: 'right',
      render: ({ provider, index }) => (
        <span className="ds-mono" style={{ fontSize: 12.5 }}>
          {provider.platform ? formatBytes(index.storedBytes ?? 0) : '—'}
        </span>
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
            {canWriteVector ? (
              <Button
                color="teal"
                size="sm"
                leftSection={<IconPlus size={14} stroke={1.7} />}
                onClick={() => setCreateModalOpen(true)}
              >
                Create index
              </Button>
            ) : null}
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
        onRefresh={() => void providersQuery.refetch()}
        refreshing={refreshing}
        empty={
          providers.length === 0
            ? {
                icon: <IconDatabase size={26} stroke={1.7} />,
                title: 'No vector provider in this project',
                description: canWriteVector
                  ? 'Indexes live in a vector provider. Add one, then create the index.'
                  : 'Indexes live in a vector provider. Someone with write access to Vector in this project adds one; after that you can create indexes here.',
                primaryAction: canWriteVector
                  ? {
                      label: 'Add vector provider',
                      icon: <IconPlus size={14} stroke={1.7} />,
                      onClick: () => setProviderModalOpen(true),
                    }
                  : undefined,
              }
            : {
                icon: <IconDatabase size={26} stroke={1.7} />,
                title: 'No indexes yet',
                description: canWriteVector
                  ? 'Create your first vector index to store and query embeddings.'
                  : 'Someone with write access to Vector in this project creates indexes; they will be listed here.',
                primaryAction: canWriteVector
                  ? {
                      label: 'Create index',
                      icon: <IconPlus size={14} stroke={1.7} />,
                      onClick: () => setCreateModalOpen(true),
                    }
                  : undefined,
              }
        }
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
            onClick: () => void confirmDelete(r),
          },
        ]}
      />

      <CreateVectorIndexModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        providers={providers}
        onCreated={handleIndexCreated}
      />

      <VectorProviderModal
        opened={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        onCreated={handleProviderCreated}
      />
    </PageContainer>
  );
}
