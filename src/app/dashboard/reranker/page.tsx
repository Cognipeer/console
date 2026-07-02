'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsSort,
  IconPlus,
  IconTrash,
  IconActivity,
  IconCheck,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateRerankerModal from '@/components/reranker/CreateRerankerModal';

interface RerankerView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  strategy: string;
  config?: { modelKey?: string };
  status: string;
  totalRuns?: number;
  avgLatencyMs?: number;
  lastUsedAt?: string;
  createdAt?: string;
}

const STRATEGY_LABEL: Record<string, string> = {
  'dedicated-model': 'Dedicated model',
  'llm-judge': 'LLM judge',
  'llm-listwise': 'LLM listwise',
  heuristic: 'Heuristic',
};

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatLatency(ms?: number) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function RerankerDashboardPage() {
  const router = useRouter();
  const [rerankers, setRerankers] = useState<RerankerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RerankerView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/reranker', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load rerankers');
      const data = await res.json();
      setRerankers(data.rerankers ?? []);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to load rerankers',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/reranker/${encodeURIComponent(deleteTarget.key)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to delete reranker');
      }
      notifications.show({
        color: 'green',
        title: 'Reranker deleted',
        message: `${deleteTarget.name} has been removed.`,
      });
      setRerankers((prev) => prev.filter((r) => r.key !== deleteTarget.key));
      setDeleteTarget(null);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to delete',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleCreated = (reranker: Record<string, unknown>) => {
    setCreateOpen(false);
    router.push(`/dashboard/reranker/${encodeURIComponent(reranker.key as string)}`);
  };

  const filtered = useMemo(() => {
    return rerankers.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !r.name.toLowerCase().includes(q)
          && !r.key.toLowerCase().includes(q)
          && !(r.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rerankers, query, statusFilter]);

  const activeCount = rerankers.filter((r) => r.status === 'active').length;
  const totalRuns = rerankers.reduce((s, r) => s + (r.totalRuns ?? 0), 0);

  const columns: DataGridColumn<RerankerView>[] = [
    {
      key: 'name',
      label: 'Reranker',
      render: (r) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {r.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {r.key}
          </span>
        </div>
      ),
    },
    {
      key: 'strategy',
      label: 'Strategy',
      render: (r) => (
        <span className="ds-badge">{STRATEGY_LABEL[r.strategy] ?? r.strategy}</span>
      ),
    },
    {
      key: 'model',
      label: 'Model',
      render: (r) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {r.config?.modelKey ?? '—'}
        </span>
      ),
    },
    {
      key: 'runs',
      label: 'Runs',
      align: 'right',
      render: (r) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {r.totalRuns ?? 0}
        </span>
      ),
    },
    {
      key: 'avgLatency',
      label: 'Avg latency',
      align: 'right',
      render: (r) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {formatLatency(r.avgLatencyMs)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <StatusBadge status={r.status === 'active' ? 'active' : 'paused'} />
      ),
    },
    {
      key: 'created',
      label: 'Created',
      render: (r) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(r.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Knowledge"
        title="Reranker"
        subtitle="Re-rank retrieval results using a dedicated model, an LLM judge, or a heuristic strategy."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateOpen(true)}
          >
            Create reranker
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total rerankers"
          icon={<IconArrowsSort size={14} stroke={1.7} />}
          value={rerankers.length}
        />
        <StatTile
          label="Active"
          icon={<IconCheck size={14} stroke={1.7} />}
          value={activeCount}
        />
        <StatTile
          label="Total runs"
          icon={<IconActivity size={14} stroke={1.7} />}
          value={totalRuns}
        />
      </div>

      <DataGrid<RerankerView>
        records={filtered}
        loading={loading}
        rowKey={(r) => r.key}
        onRowClick={(r) => router.push(`/dashboard/reranker/${encodeURIComponent(r.key)}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
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
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={load}
        refreshing={refreshing}
        empty={{
          icon: <IconArrowsSort size={26} stroke={1.7} />,
          title: 'No rerankers yet',
          description:
            'Create a reranker to re-order retrieval results before they reach the LLM.',
          primaryAction: {
            label: 'Create reranker',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${rerankers.length} rerankers`}
        rowActions={(r) => [
          {
            id: 'open',
            label: 'Open',
            icon: <IconArrowsSort size={14} />,
            onClick: () => router.push(`/dashboard/reranker/${encodeURIComponent(r.key)}`),
          },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(r),
          },
        ]}
      />

      <CreateRerankerModal
        opened={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />

      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete reranker"
        size="sm"
      >
        <Text size="sm">
          Delete <strong>{deleteTarget?.name}</strong>? Any RAG modules pointing to this
          reranker will silently skip reranking and return vector-ranked results.
        </Text>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 16,
          }}
        >
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </div>
      </Modal>
    </PageContainer>
  );
}
