'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBrain,
  IconBulb,
  IconDatabase,
  IconEye,
  IconPlus,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';
import CreateMemoryStoreModal from '@/components/memory/CreateMemoryStoreModal';

interface MemoryStoreItem {
  _id: string;
  key: string;
  name: string;
  description?: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  status: string;
  memoryCount: number;
  createdAt?: string;
  lastActivityAt?: string;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function MemoryPage() {
  const router = useRouter();
  const t = useTranslations('memory');
  const [stores, setStores] = useState<MemoryStoreItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadStores = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/stores', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setStores(data.stores || []);
      }
    } catch (err) {
      console.error('Failed to load memory stores', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadStores();
  }, [loadStores]);

  const handleRefresh = () => {
    setRefreshing(true);
    void loadStores();
  };

  const handleCreated = () => {
    setCreateModalOpen(false);
    notifications.show({
      title: t('storeCreated'),
      message: t('storeCreatedMessage'),
      color: 'teal',
    });
    handleRefresh();
  };

  const filtered = useMemo(() => {
    return stores.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !s.name.toLowerCase().includes(q) &&
          !s.key.toLowerCase().includes(q) &&
          !(s.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [stores, query, statusFilter]);

  const totalMemories = stores.reduce((sum, s) => sum + (s.memoryCount ?? 0), 0);
  const activeStores = stores.filter((s) => s.status === 'active').length;

  const columns: DataGridColumn<MemoryStoreItem>[] = [
    {
      key: 'name',
      label: t('storeName'),
      render: (s) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {s.name}
          </span>
          {s.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {s.description.length > 60
                ? `${s.description.slice(0, 60)}…`
                : s.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {s.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'provider',
      label: t('vectorProvider'),
      render: (s) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {s.vectorProviderKey}
        </span>
      ),
    },
    {
      key: 'embedding',
      label: t('embeddingModel'),
      render: (s) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {s.embeddingModelKey}
        </span>
      ),
    },
    {
      key: 'count',
      label: t('memoryCount'),
      align: 'right',
      render: (s) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {s.memoryCount ?? 0}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('status'),
      render: (s) => (
        <StatusBadge
          status={
            s.status === 'active'
              ? 'active'
              : s.status === 'error'
                ? 'err'
                : 'paused'
          }
        />
      ),
    },
    {
      key: 'created',
      label: t('createdAt'),
      render: (s) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(s.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Memory"
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateModalOpen(true)}
          >
            {t('createStore')}
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Memory stores"
          icon={<IconBulb size={14} stroke={1.7} />}
          value={stores.length}
        />
        <StatTile
          label="Total memories"
          icon={<IconDatabase size={14} stroke={1.7} />}
          value={totalMemories}
        />
        <StatTile
          label="Active stores"
          icon={<IconBrain size={14} stroke={1.7} />}
          value={activeStores}
        />
      </div>

      <DataGrid<MemoryStoreItem>
        records={filtered}
        loading={loading}
        rowKey={(s) => s.key}
        onRowClick={(s) => router.push(`/dashboard/memory/${s.key}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('searchPlaceholder'),
        }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'error', label: 'Error' },
            ],
          },
        ]}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        empty={{
          icon: <IconBulb size={26} stroke={1.7} />,
          title: t('noStores'),
          description: t('noStoresDescription'),
          primaryAction: {
            label: t('createFirstStore'),
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${stores.length} stores`}
        rowActions={(s) => [
          {
            id: 'open',
            label: 'Open store',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/memory/${s.key}`),
          },
        ]}
      />

      <CreateMemoryStoreModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleCreated}
      />
    </PageContainer>
  );
}
