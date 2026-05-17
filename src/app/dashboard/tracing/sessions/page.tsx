'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Text, Tooltip } from '@mantine/core';
import {
  IconBook,
  IconEye,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

interface SessionRecord {
  sessionId: string;
  threadId?: string;
  agentName?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

interface SessionsResponse {
  sessions: SessionRecord[];
  total: number;
}

dayjs.extend(relativeTime);

const DEFAULT_PAGE_SIZE = 25;

export default function TracingSessionsPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set('limit', pageSize.toString());
    params.set('skip', ((page - 1) * pageSize).toString());
    if (query) params.set('query', query.trim());
    if (statusFilter !== 'all') params.set('status', statusFilter);
    return params;
  }, [page, pageSize, query, statusFilter]);

  const fetchSessions = useCallback(
    async (isRefresh = false, signal?: AbortSignal) => {
      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);

        const params = buildQueryParams();
        const response = await fetch(
          `/api/tracing/sessions?${params.toString()}`,
          { signal },
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch sessions');
        }
        const data: SessionsResponse = await response.json();
        setSessions(data.sessions || []);
        setTotalSessions(data.total || 0);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load sessions:', error);
        setSessions([]);
        setTotalSessions(0);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [buildQueryParams],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchSessions(false, controller.signal);
    return () => controller.abort();
  }, [fetchSessions]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalSessions / pageSize)),
    [totalSessions, pageSize],
  );

  const columns: DataGridColumn<SessionRecord>[] = [
    {
      key: 'agent',
      label: 'Agent',
      render: (s) => (
        <Tooltip label={s.agentName || s.sessionId} withArrow>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {s.agentName || '—'}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'session',
      label: 'Session',
      render: (s) => (
        <Tooltip label={s.sessionId} withArrow>
          <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
            {s.sessionId.substring(0, 8)}…
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'thread',
      label: 'Thread',
      render: (s) =>
        s.threadId ? (
          <Tooltip label={s.threadId} withArrow>
            <button
              type="button"
              className="ds-mono"
              style={{
                fontSize: 12,
                color: 'var(--ds-accent)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/dashboard/tracing/threads/${s.threadId}`);
              }}
            >
              {s.threadId.substring(0, 8)}…
            </button>
          </Tooltip>
        ) : (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            —
          </span>
        ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => (
        <StatusBadge
          status={
            s.status === 'success'
              ? 'ok'
              : s.status === 'error'
                ? 'err'
                : s.status === 'running'
                  ? 'info'
                  : 'paused'
          }
          label={(s.status || 'unknown').toUpperCase()}
        />
      ),
    },
    {
      key: 'started',
      label: 'Started',
      render: (s) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatRelativeTime(s.startedAt)}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {formatDuration(s.durationMs)}
        </span>
      ),
    },
    {
      key: 'events',
      label: 'Events',
      align: 'right',
      render: (s) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {formatNumber(s.totalEvents)}
        </span>
      ),
    },
    {
      key: 'tokens',
      label: 'Tokens',
      align: 'right',
      render: (s) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {formatNumber(s.totalTokens)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Tracing"
        title="Session Explorer"
        subtitle="Inspect recent agent sessions, filter by agent or status, and drill into the execution timeline."
        actions={
          <Button
            variant="default"
            size="sm"
            leftSection={<IconBook size={14} stroke={1.7} />}
            onClick={() => openDocs('api-tracing')}
          >
            Docs
          </Button>
        }
      />

      <DataGrid<SessionRecord>
        records={sessions}
        loading={loading}
        rowKey={(s) => s.sessionId}
        onRowClick={(s) =>
          router.push(`/dashboard/tracing/sessions/${s.sessionId}`)
        }
        columns={columns}
        search={{
          value: query,
          onChange: (v) => {
            setQuery(v);
            setPage(1);
          },
          placeholder: 'Search session ID or agent…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: (v) => {
              setStatusFilter(v);
              setPage(1);
            },
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'success', label: 'Success' },
              { value: 'error', label: 'Error' },
              { value: 'running', label: 'Running' },
            ],
          },
        ]}
        onRefresh={() => void fetchSessions(true)}
        refreshing={refreshing}
        empty={{
          title: 'No sessions found',
          description:
            'Tracing sessions will appear here once agents start running.',
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {formatNumber(totalSessions)} total · Page {page} of {totalPages}
          </Text>
        }
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          total: totalSessions,
          hasMore: page < totalPages,
        }}
        rowActions={(s) => [
          {
            id: 'view',
            label: 'View session',
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/tracing/sessions/${s.sessionId}`),
          },
        ]}
      />
    </PageContainer>
  );
}
