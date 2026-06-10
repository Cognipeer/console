'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBolt,
  IconBroadcast,
  IconClock,
  IconCoins,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
  IconVolume,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import RealtimeModelFormModal, {
  type RealtimeModelView,
} from '@/components/realtime/RealtimeModelFormModal';

interface RealtimeOverview {
  totalSessions: number;
  activeSessions: number;
  erroredSessions: number;
  totalResponses: number;
  totalTokens: number;
  totalAudioSeconds: number;
  avgDurationMs: number;
  avgFirstTokenLatencyMs: number;
  byTransport: Record<string, number>;
  byModel: Record<string, number>;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatLatency(ms?: number) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatNumber(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

function formatAudioSeconds(seconds?: number) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

export default function RealtimeDashboardPage() {
  const router = useRouter();
  const [models, setModels] = useState<RealtimeModelView[]>([]);
  const [overview, setOverview] = useState<RealtimeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RealtimeModelView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RealtimeModelView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [modelsRes, overviewRes] = await Promise.all([
        fetch('/api/realtime/models', { cache: 'no-store' }),
        fetch('/api/realtime/overview', { cache: 'no-store' }),
      ]);
      if (!modelsRes.ok) throw new Error('Failed to load realtime models');
      const modelsData = await modelsRes.json();
      setModels(modelsData.models ?? []);
      if (overviewRes.ok) {
        const overviewData = await overviewRes.json();
        setOverview(overviewData.overview ?? null);
      }
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to load realtime data',
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
      const res = await fetch(
        `/api/realtime/models/${encodeURIComponent(deleteTarget._id)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to delete realtime model');
      }
      notifications.show({
        color: 'green',
        title: 'Realtime model deleted',
        message: `${deleteTarget.name} has been removed.`,
      });
      setModels((prev) => prev.filter((m) => m._id !== deleteTarget._id));
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

  const toggleStatus = async (model: RealtimeModelView) => {
    const nextStatus = model.status === 'active' ? 'disabled' : 'active';
    try {
      const res = await fetch(
        `/api/realtime/models/${encodeURIComponent(model._id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to update status');
      }
      const data = await res.json();
      setModels((prev) =>
        prev.map((m) => (m._id === model._id ? { ...m, ...(data.model ?? { status: nextStatus }) } : m)),
      );
      notifications.show({
        color: 'green',
        title: nextStatus === 'active' ? 'Model enabled' : 'Model disabled',
        message: `${model.name} is now ${nextStatus}.`,
      });
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to update status',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    }
  };

  const handleSaved = (saved: RealtimeModelView) => {
    setFormOpen(false);
    if (editTarget) {
      setModels((prev) => prev.map((m) => (m._id === saved._id ? saved : m)));
      setEditTarget(null);
    } else {
      setModels((prev) => [saved, ...prev]);
    }
  };

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (model: RealtimeModelView) => {
    setEditTarget(model);
    setFormOpen(true);
  };

  const filtered = useMemo(() => {
    return models.filter((m) => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !m.name.toLowerCase().includes(q)
          && !m.key.toLowerCase().includes(q)
          && !(m.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [models, query, statusFilter]);

  const transportsBreakdown = useMemo(() => {
    const byTransport = overview?.byTransport ?? {};
    const entries = Object.entries(byTransport);
    if (entries.length === 0) return null;
    return entries
      .map(([transport, count]) => `${transport} ${count.toLocaleString()}`)
      .join(' · ');
  }, [overview]);

  const columns: DataGridColumn<RealtimeModelView>[] = [
    {
      key: 'name',
      label: 'Realtime model',
      render: (m) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {m.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {m.key}
          </span>
        </div>
      ),
    },
    {
      key: 'chatModel',
      label: 'Chat model',
      render: (m) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {m.chatModelKey}
        </span>
      ),
    },
    {
      key: 'voice',
      label: 'Voice pipeline',
      render: (m) => (
        <div className="ds-row" style={{ gap: 6 }}>
          {m.sttModelKey ? <span className="ds-badge">STT</span> : null}
          {m.ttsModelKey ? <span className="ds-badge">TTS</span> : null}
          {!m.sttModelKey && !m.ttsModelKey ? (
            <span className="ds-faint" style={{ fontSize: 12 }}>
              Text only
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (m) => (
        <StatusBadge status={m.status === 'active' ? 'active' : 'paused'} label={m.status === 'active' ? 'Active' : 'Disabled'} />
      ),
    },
    {
      key: 'created',
      label: 'Created',
      render: (m) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(m.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Inference · Realtime"
        title="Realtime"
        subtitle="Low-latency speech and text sessions over WebSocket or Twilio media streams."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={openCreate}
          >
            Create realtime model
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total sessions"
          icon={<IconBroadcast size={14} stroke={1.7} />}
          value={formatNumber(overview?.totalSessions)}
          delta={transportsBreakdown ?? undefined}
        />
        <StatTile
          label="Avg first token"
          icon={<IconBolt size={14} stroke={1.7} />}
          value={formatLatency(overview?.avgFirstTokenLatencyMs)}
        />
        <StatTile
          label="Total tokens"
          icon={<IconCoins size={14} stroke={1.7} />}
          value={formatNumber(overview?.totalTokens)}
        />
        <StatTile
          label="Audio processed"
          icon={<IconVolume size={14} stroke={1.7} />}
          value={formatAudioSeconds(overview?.totalAudioSeconds)}
          delta={
            typeof overview?.avgDurationMs === 'number' && overview.avgDurationMs > 0
              ? `avg session ${formatLatency(overview.avgDurationMs)}`
              : undefined
          }
        />
      </div>

      <DataGrid<RealtimeModelView>
        records={filtered}
        loading={loading}
        rowKey={(m) => m._id}
        onRowClick={(m) => openEdit(m)}
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
          icon: <IconBroadcast size={26} stroke={1.7} />,
          title: 'No realtime models yet',
          description:
            'Create a realtime model to serve low-latency voice and text sessions over WebSocket or Twilio.',
          primaryAction: {
            label: 'Create realtime model',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: openCreate,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${models.length} realtime models`}
        rowActions={(m) => [
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconPencil size={14} />,
            onClick: () => openEdit(m),
          },
          {
            id: 'playground',
            label: 'Open in playground',
            icon: <IconPlayerPlay size={14} />,
            onClick: () =>
              router.push(
                `/dashboard/realtime/playground?model=${encodeURIComponent(m.key)}`,
              ),
          },
          {
            id: 'toggle',
            label: m.status === 'active' ? 'Disable' : 'Enable',
            icon: <IconClock size={14} />,
            onClick: () => {
              void toggleStatus(m);
            },
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(m),
          },
        ]}
      />

      <RealtimeModelFormModal
        opened={formOpen}
        model={editTarget}
        onClose={() => {
          setFormOpen(false);
          setEditTarget(null);
        }}
        onSaved={handleSaved}
      />

      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete realtime model"
        size="sm"
      >
        <Text size="sm">
          Delete <strong>{deleteTarget?.name}</strong>? Clients connecting with key{' '}
          <strong>{deleteTarget?.key}</strong> will be rejected. Session logs are kept.
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
