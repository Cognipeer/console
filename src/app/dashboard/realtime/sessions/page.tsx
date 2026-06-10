'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBroadcast } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';

interface RealtimeSessionLog {
  _id: string;
  sessionId: string;
  realtimeModelKey: string;
  chatModelKey?: string;
  transport: 'websocket' | 'twilio' | string;
  status: 'active' | 'ended' | 'error' | string;
  responseCount?: number;
  inputAudioSeconds?: number;
  usageInputTokens?: number;
  usageOutputTokens?: number;
  usageTotalTokens?: number;
  firstTokenLatencyMs?: number;
  errorMessage?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

interface RealtimeModelOption {
  key: string;
  name: string;
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

function formatDuration(ms?: number) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatAudioSeconds(seconds?: number) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function sessionStatusBadge(session: RealtimeSessionLog) {
  if (session.status === 'active') return <StatusBadge status="active" />;
  if (session.status === 'error') return <StatusBadge status="error" />;
  return <StatusBadge status="paused" label="Ended" />;
}

export default function RealtimeSessionsPage() {
  const [sessions, setSessions] = useState<RealtimeSessionLog[]>([]);
  const [models, setModels] = useState<RealtimeModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modelFilter, setModelFilter] = useState('all');
  const [transportFilter, setTransportFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (modelFilter !== 'all') params.set('model', modelFilter);
      if (transportFilter !== 'all') params.set('transport', transportFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (from) params.set('from', new Date(from).toISOString());
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        params.set('to', end.toISOString());
      }
      params.set('limit', '200');
      const res = await fetch(`/api/realtime/sessions?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('Failed to load realtime sessions');
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to load sessions',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [modelFilter, transportFilter, statusFilter, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const res = await fetch('/api/realtime/models', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setModels(
              (data.models ?? []).map((m: Record<string, string>) => ({
                key: m.key,
                name: m.name,
              })),
            );
          }
        }
      } catch (err) {
        console.error('Failed to load realtime models', err);
      }
    };
    void loadModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const modelFilterOptions = useMemo(
    () => [
      { value: 'all', label: 'All models' },
      ...models.map((m) => ({ value: m.key, label: m.name })),
    ],
    [models],
  );

  const columns: DataGridColumn<RealtimeSessionLog>[] = [
    {
      key: 'started',
      label: 'Started',
      render: (s) => (
        <span style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
          {formatDate(s.startedAt)}
        </span>
      ),
    },
    {
      key: 'model',
      label: 'Model',
      render: (s) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {s.realtimeModelKey}
        </span>
      ),
    },
    {
      key: 'transport',
      label: 'Transport',
      render: (s) => <span className="ds-badge">{s.transport}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => (
        <div className="ds-row" style={{ gap: 6 }}>
          {sessionStatusBadge(s)}
          {s.errorMessage ? (
            <Tooltip label={s.errorMessage} withArrow multiline maw={360}>
              <IconAlertTriangle
                size={14}
                stroke={1.7}
                color="var(--ds-err)"
                aria-label="Error details"
              />
            </Tooltip>
          ) : null}
        </div>
      ),
    },
    {
      key: 'responses',
      label: 'Responses',
      align: 'right',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {s.responseCount ?? 0}
        </span>
      ),
    },
    {
      key: 'tokens',
      label: 'Tokens',
      align: 'right',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {typeof s.usageTotalTokens === 'number' ? s.usageTotalTokens.toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'audio',
      label: 'Audio in',
      align: 'right',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {formatAudioSeconds(s.inputAudioSeconds)}
        </span>
      ),
    },
    {
      key: 'firstToken',
      label: 'First token',
      align: 'right',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {formatLatency(s.firstTokenLatencyMs)}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      align: 'right',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
          {formatDuration(s.durationMs)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Inference · Realtime"
        title="Realtime sessions"
        subtitle="Session logs for WebSocket and Twilio realtime connections, with usage and latency metrics."
      />

      <DataGrid<RealtimeSessionLog>
        records={sessions}
        loading={loading}
        rowKey={(s) => s._id}
        columns={columns}
        filters={[
          {
            value: modelFilter,
            onChange: setModelFilter,
            ariaLabel: 'Filter by model',
            width: 180,
            options: modelFilterOptions,
          },
          {
            value: transportFilter,
            onChange: setTransportFilter,
            ariaLabel: 'Filter by transport',
            width: 150,
            options: [
              { value: 'all', label: 'All transports' },
              { value: 'websocket', label: 'WebSocket' },
              { value: 'twilio', label: 'Twilio' },
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
              { value: 'ended', label: 'Ended' },
              { value: 'error', label: 'Error' },
            ],
          },
        ]}
        toolbarRight={
          <div className="ds-row" style={{ gap: 8 }}>
            <TextInput
              type="date"
              size="xs"
              aria-label="From date"
              value={from}
              onChange={(e) => setFrom(e.currentTarget.value)}
            />
            <TextInput
              type="date"
              size="xs"
              aria-label="To date"
              value={to}
              onChange={(e) => setTo(e.currentTarget.value)}
            />
          </div>
        }
        onRefresh={load}
        refreshing={refreshing}
        empty={{
          icon: <IconBroadcast size={26} stroke={1.7} />,
          title: 'No sessions found',
          description:
            'No realtime sessions match the current filters. Sessions appear here as clients connect.',
        }}
        footerLeft={`Showing ${sessions.length} sessions`}
      />
    </PageContainer>
  );
}
