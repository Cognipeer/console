'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Text, Tooltip } from '@mantine/core';
import {
  IconBook,
  IconEye,
  IconTimeline,
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

dayjs.extend(relativeTime);

interface ThreadRecord {
  threadId: string;
  sessionsCount: number;
  agents: string[];
  statuses: string[];
  latestStatus: string;
  startedAt: string;
  endedAt?: string;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  modelsUsed: string[];
}

interface ThreadsResponse {
  threads: ThreadRecord[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 25;

export default function TracingThreadsPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
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
    if (query) params.set('threadId', query.trim());
    if (statusFilter !== 'all') params.set('status', statusFilter);
    return params;
  }, [page, pageSize, query, statusFilter]);

  const fetchThreads = useCallback(
    async (isRefresh = false, signal?: AbortSignal) => {
      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);

        const params = buildQueryParams();
        const response = await fetch(
          `/api/tracing/threads?${params.toString()}`,
          { signal },
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch threads');
        }
        const data: ThreadsResponse = await response.json();
        setThreads(data.threads || []);
        setTotalThreads(data.total || 0);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load threads:', error);
        setThreads([]);
        setTotalThreads(0);
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
    void fetchThreads(false, controller.signal);
    return () => controller.abort();
  }, [fetchThreads]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalThreads / pageSize)),
    [totalThreads, pageSize],
  );

  const columns: DataGridColumn<ThreadRecord>[] = [
    {
      key: 'thread',
      label: 'Thread',
      render: (t) => (
        <Tooltip label={t.threadId} withArrow>
          <span className="ds-mono" style={{ fontSize: 12, color: 'var(--ds-text)' }}>
            {t.threadId.substring(0, 8)}…
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'sessions',
      label: 'Sessions',
      align: 'right',
      render: (t) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {t.sessionsCount}
        </span>
      ),
    },
    {
      key: 'agents',
      label: 'Agents',
      render: (t) => (
        <div className="ds-row ds-gap-xs" style={{ flexWrap: 'wrap' }}>
          {(t.agents ?? []).slice(0, 3).map((a) => (
            <span key={a} className="ds-badge">
              {a}
            </span>
          ))}
          {(t.agents?.length ?? 0) > 3 ? (
            <span className="ds-faint" style={{ fontSize: 11 }}>
              +{t.agents.length - 3}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      label: 'Latest status',
      render: (t) => (
        <StatusBadge
          status={
            t.latestStatus === 'success'
              ? 'ok'
              : t.latestStatus === 'error'
                ? 'err'
                : t.latestStatus === 'running'
                  ? 'info'
                  : 'paused'
          }
          label={(t.latestStatus || 'unknown').toUpperCase()}
        />
      ),
    },
    {
      key: 'started',
      label: 'Started',
      render: (t) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatRelativeTime(t.startedAt)}
        </span>
      ),
    },
    {
      key: 'duration',
      label: 'Duration',
      render: (t) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {formatDuration(t.totalDurationMs)}
        </span>
      ),
    },
    {
      key: 'tokens',
      label: 'Tokens',
      align: 'right',
      render: (t) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {formatNumber(
            (t.totalInputTokens ?? 0) + (t.totalOutputTokens ?? 0),
          )}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Tracing"
        title="Thread Explorer"
        subtitle="Aggregate view of sessions sharing the same thread ID — useful for multi-turn agent conversations."
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

      <DataGrid<ThreadRecord>
        records={threads}
        loading={loading}
        rowKey={(t) => t.threadId}
        onRowClick={(t) =>
          router.push(`/dashboard/tracing/threads/${t.threadId}`)
        }
        columns={columns}
        search={{
          value: query,
          onChange: (v) => {
            setQuery(v);
            setPage(1);
          },
          placeholder: 'Search by thread ID…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: (v) => {
              setStatusFilter(v);
              setPage(1);
            },
            ariaLabel: 'Filter by latest status',
            width: 160,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'success', label: 'Success' },
              { value: 'error', label: 'Error' },
              { value: 'in_progress', label: 'In progress' },
            ],
          },
        ]}
        onRefresh={() => void fetchThreads(true)}
        refreshing={refreshing}
        empty={{
          icon: <IconTimeline size={26} stroke={1.7} />,
          title: 'No threads found',
          description:
            'Threads will appear once sessions are grouped by their thread ID.',
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {formatNumber(totalThreads)} total · Page {page} of {totalPages}
          </Text>
        }
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          total: totalThreads,
          hasMore: page < totalPages,
        }}
        rowActions={(t) => [
          {
            id: 'view',
            label: 'View thread',
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/tracing/threads/${t.threadId}`),
          },
        ]}
      />
    </PageContainer>
  );
}
