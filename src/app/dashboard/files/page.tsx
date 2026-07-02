'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBan, IconCheck, IconFolder, IconPlus, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import CreateFileBucketModal from '@/components/files/CreateFileBucketModal';
import { ApiError, apiRequest } from '@/lib/api/client';
import type { FileBucketView } from '@/lib/services/files';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface FilesDashboardData {
  overview: { totalBuckets: number; activeBuckets: number; disabledBuckets: number };
  providerBreakdown: Array<{ providerKey: string; count: number; active: number }>;
  recentBuckets: Array<{ key: string; name: string; providerKey: string; status: string; createdAt: string }>;
}

function formatDate(value?: Date | string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function FilesDashboardPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [dashboardData, setDashboardData] = useState<FilesDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FileBucketView | null>(null);
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const bucketsQuery = useQuery<FileBucketView[], ApiError>({
    queryKey: ['file-buckets'],
    queryFn: async () => {
      const response = await apiRequest<{ buckets?: FileBucketView[] }>(
        '/api/files/buckets',
      );
      return response.buckets ?? [];
    },
  });

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/files/dashboard?${params.toString()}`, {
        cache: 'no-store',
      });
      if (res.ok) setDashboardData((await res.json()) as FilesDashboardData);
    } catch (err) {
      console.error('Failed to load files dashboard', err);
    } finally {
      setDashboardLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const deleteBucket = useMutation({
    mutationFn: async (bucket: FileBucketView) => {
      await apiRequest(`/api/files/buckets/${encodeURIComponent(bucket.key)}`, {
        method: 'DELETE',
        parseJson: false,
      });
      return bucket;
    },
    onSuccess: (_, bucket) => {
      notifications.show({
        color: 'green',
        title: 'Bucket deleted',
        message: `${bucket.name} has been removed.`,
      });
      queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) =>
        current.filter((item) => item.key !== bucket.key),
      );
      setDeleteTarget(null);
    },
    onError: (error) => {
      notifications.show({
        color: 'red',
        title: 'Unable to delete bucket',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    },
  });

  const toggleBucketStatus = useMutation({
    mutationFn: async (bucket: FileBucketView) => {
      const nextStatus = bucket.status === 'disabled' ? 'active' : 'disabled';
      const { bucket: updated } = await apiRequest<{ bucket: FileBucketView }>(
        `/api/files/buckets/${encodeURIComponent(bucket.key)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      return updated;
    },
    onSuccess: (updated) => {
      notifications.show({
        color: 'green',
        title: updated.status === 'disabled' ? 'Bucket disabled' : 'Bucket enabled',
        message: `${updated.name} is now ${updated.status}.`,
      });
      queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) =>
        current.map((item) => (item.key === updated.key ? { ...item, ...updated } : item)),
      );
    },
    onError: (error) => {
      notifications.show({
        color: 'red',
        title: 'Unable to update bucket',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    },
  });

  const buckets = useMemo(() => bucketsQuery.data ?? [], [bucketsQuery.data]);
  const loading = bucketsQuery.isPending;

  const providers = useMemo(() => {
    const map = new Map<string, { key: string; label: string }>();
    buckets.forEach((b) => {
      if (b.provider) {
        map.set(b.provider.key, { key: b.provider.key, label: b.provider.label });
      }
    });
    return Array.from(map.values());
  }, [buckets]);

  const filtered = useMemo(() => {
    return buckets.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (providerFilter !== 'all' && b.provider?.key !== providerFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !b.name.toLowerCase().includes(q) &&
          !b.key.toLowerCase().includes(q) &&
          !(b.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [buckets, query, statusFilter, providerFilter]);

  const columns: DataGridColumn<FileBucketView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (b) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {b.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {b.key}
          </span>
        </div>
      ),
    },
    {
      key: 'provider',
      label: 'Provider',
      render: (b) =>
        b.provider ? (
          <div className="ds-col" style={{ gap: 2 }}>
            <span style={{ fontSize: 12.5 }}>{b.provider.label}</span>
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {b.provider.driver}
            </span>
          </div>
        ) : (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            Provider unavailable
          </span>
        ),
    },
    {
      key: 'prefix',
      label: 'Prefix',
      render: (b) =>
        b.prefix ? (
          <span className="ds-mono" style={{ fontSize: 12 }}>
            {b.prefix}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (b) => <StatusBadge status={b.status === 'active' ? 'active' : 'paused'} />,
    },
    {
      key: 'updated',
      label: 'Updated',
      render: (b) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(b.updatedAt ?? b.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Files"
        title="Document Store"
        subtitle="View and manage storage buckets connected to your tenant."
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => setCreateOpen(true)}
            >
              Create bucket
            </Button>
          </>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total buckets"
          icon={<IconFolder size={14} stroke={1.7} />}
          value={
            dashboardLoading ? '—' : (dashboardData?.overview.totalBuckets ?? buckets.length)
          }
        />
        <StatTile
          label="Active"
          icon={<IconCheck size={14} stroke={1.7} />}
          value={dashboardLoading ? '—' : (dashboardData?.overview.activeBuckets ?? '—')}
        />
        <StatTile
          label="Disabled"
          icon={<IconBan size={14} stroke={1.7} />}
          value={dashboardLoading ? '—' : (dashboardData?.overview.disabledBuckets ?? '—')}
        />
      </div>

      <DataGrid<FileBucketView>
        records={filtered}
        loading={loading}
        rowKey={(b) => b.key}
        onRowClick={(b) =>
          router.push(`/dashboard/files/${encodeURIComponent(b.key)}`)
        }
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        filters={[
          {
            value: providerFilter,
            onChange: setProviderFilter,
            ariaLabel: 'Filter by provider',
            width: 160,
            options: [
              { value: 'all', label: 'All providers' },
              ...providers.map((p) => ({ value: p.key, label: p.label })),
            ],
          },
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={() => void bucketsQuery.refetch()}
        refreshing={bucketsQuery.isRefetching}
        empty={{
          icon: <IconFolder size={26} stroke={1.7} />,
          title: 'No buckets yet',
          description: 'Create your first bucket to start storing and routing files.',
          primaryAction: {
            label: 'Create bucket',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${buckets.length} buckets`}
        rowActions={(b) => [
          {
            id: 'open',
            label: 'Open bucket',
            icon: <IconFolder size={14} />,
            onClick: () => router.push(`/dashboard/files/${encodeURIComponent(b.key)}`),
          },
          {
            id: 'toggle-status',
            label: b.status === 'disabled' ? 'Enable' : 'Disable',
            icon: b.status === 'disabled' ? <IconCheck size={14} /> : <IconBan size={14} />,
            disabled: toggleBucketStatus.isPending,
            onClick: () => toggleBucketStatus.mutate(b),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            disabled: deleteBucket.isPending,
            onClick: () => setDeleteTarget(b),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete bucket"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete bucket <strong>{deleteTarget?.name}</strong>? Files within the
          bucket must be removed first.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={deleteBucket.isPending}
            onClick={() => deleteTarget && deleteBucket.mutate(deleteTarget)}
          >
            Delete
          </Button>
        </Group>
      </Modal>

      <CreateFileBucketModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(bucket) => {
          queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) => {
            const idx = current.findIndex((b) => b.key === bucket.key);
            if (idx >= 0) {
              return current.map((b, i) => (i === idx ? bucket : b));
            }
            return [bucket, ...current];
          });
          setCreateOpen(false);
          router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
        }}
      />
    </PageContainer>
  );
}
