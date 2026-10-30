'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ActionIcon, Button, Group, Text, TextInput, Tooltip } from '@mantine/core';
import {
  IconBook,
  IconEye,
  IconTimeline,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import SessionStatusBadge from '@/components/tracing/SessionStatusBadge';
import {
  isTracingStatusFilterValue,
  TRACING_STATUS_FILTER_VALUES,
} from '@/components/tracing/sessionStatus';
import { useTranslations } from '@/lib/i18n';
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { SkipTrail, type OffsetPageInfo } from '@/lib/shared/offsetPaging';

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

// A caller who may not view every session gets `hasMore` / `nextSkip` instead of a `total` (see offsetPaging.ts).
interface ThreadsResponse extends OffsetPageInfo {
  threads: ThreadRecord[];
}

const DEFAULT_PAGE_SIZE = 25;

/** A `status` URL value the filter offers, else 'all'. */
function statusParam(value: string | null): string {
  const raw = value?.trim() ?? '';
  return isTracingStatusFilterValue(raw) ? raw : 'all';
}

export default function TracingThreadsPage() {
  const router = useRouter();
  const searchParams = useSearchParams()!;
  const th = useTranslations('tracingHealth');
  const { openDocs } = useDocsDrawer();
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
  // Where each page starts, and whether a list without a total has a next page (null: it has a total).
  const skipTrail = useRef(new SkipTrail());
  const [moreAfter, setMoreAfter] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(() => statusParam(searchParams.get('status')));
  const [metadataKey, setMetadataKey] = useState(
    () => searchParams.get('metadataKey')?.trim() || '',
  );
  const [metadataValue, setMetadataValue] = useState(
    () => searchParams.get('metadataValue')?.trim() || '',
  );

  const buildQueryParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set('limit', pageSize.toString());
    params.set('skip', skipTrail.current.skipFor(page, pageSize).toString());
    if (query) params.set('threadId', query.trim());
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (metadataKey.trim() && metadataValue.trim()) {
      params.set('metadataKey', metadataKey.trim());
      params.set('metadataValue', metadataValue.trim());
    }
    return params;
  }, [page, pageSize, query, statusFilter, metadataKey, metadataValue]);

  useEffect(() => {
    const statusFromUrl = statusParam(searchParams.get('status'));
    setStatusFilter((current) => (current === statusFromUrl ? current : statusFromUrl));
    const metadataKeyParam = searchParams.get('metadataKey')?.trim() || '';
    setMetadataKey((current) => (current === metadataKeyParam ? current : metadataKeyParam));
    const metadataValueParam = searchParams.get('metadataValue')?.trim() || '';
    setMetadataValue((current) => (current === metadataValueParam ? current : metadataValueParam));
  }, [searchParams]);

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
        skipTrail.current.remember(page, data);
        setTotalThreads(data.total ?? 0);
        setMoreAfter(typeof data.total === 'number' ? null : data.hasMore === true);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load threads:', error);
        setThreads([]);
        setTotalThreads(0);
        setMoreAfter(null);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [buildQueryParams, page],
  );

  // Another search is another list: the pages of the last one no longer say where this one's start.
  useEffect(() => {
    skipTrail.current.reset();
  }, [query, statusFilter, metadataKey, metadataValue]);

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
      label: th('sessionTable.thread'),
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
      label: th('threads.sessions'),
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
      label: th('threads.agents'),
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
      label: th('threads.latestStatus'),
      render: (t) => <SessionStatusBadge status={t.latestStatus} />,
    },
    {
      key: 'started',
      label: th('sessionTable.started'),
      render: (t) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatRelativeTime(t.startedAt)}
        </span>
      ),
    },
    {
      key: 'duration',
      label: th('sessionTable.duration'),
      render: (t) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {formatDuration(t.totalDurationMs)}
        </span>
      ),
    },
    {
      key: 'tokens',
      label: th('sessionTable.tokens'),
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
        eyebrow={th('eyebrow')}
        title={th('threads.title')}
        subtitle={th('threads.subtitle')}
        actions={
          <Button
            variant="default"
            size="sm"
            leftSection={<IconBook size={14} stroke={1.7} />}
            onClick={() => openDocs('observe-tracing')}
          >
            {th('common.docs')}
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
          placeholder: th('threads.search'),
        }}
        filters={[
          {
            value: statusFilter,
            onChange: (v) => {
              setStatusFilter(v);
              setPage(1);
            },
            ariaLabel: th('sessions.latestStatusFilter'),
            width: 170,
            options: [
              { value: 'all', label: th('sessions.statusAll') },
              ...TRACING_STATUS_FILTER_VALUES.map((value) => ({ value, label: th(`status.${value}`) })),
            ],
          },
        ]}
        toolbarRight={
          <Group gap={4} wrap="nowrap">
            <TextInput
              size="xs"
              placeholder={th('sessions.metadataKey')}
              aria-label={th('sessions.metadataKey')}
              value={metadataKey}
              onChange={(e) => {
                setMetadataKey(e.currentTarget.value);
                setPage(1);
              }}
              style={{ width: 130 }}
            />
            <TextInput
              size="xs"
              placeholder={th('sessions.metadataValue')}
              aria-label={th('sessions.metadataValue')}
              value={metadataValue}
              onChange={(e) => {
                setMetadataValue(e.currentTarget.value);
                setPage(1);
              }}
              style={{ width: 130 }}
            />
            {(metadataKey || metadataValue) && (
              <Tooltip label={th('sessions.clearMetadata')} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={th('sessions.clearMetadata')}
                  onClick={() => {
                    setMetadataKey('');
                    setMetadataValue('');
                    setPage(1);
                  }}
                >
                  <IconX size={14} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        }
        onRefresh={() => void fetchThreads(true)}
        refreshing={refreshing}
        empty={{
          icon: <IconTimeline size={26} stroke={1.7} />,
          title: th('threads.emptyTitle'),
          description: th('threads.emptyDescription'),
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {moreAfter === null
              ? th('sessions.footerTotal', { total: formatNumber(totalThreads), page, pages: totalPages })
              : th('sessions.footerPage', { page })}
          </Text>
        }
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          ...(moreAfter === null ? { total: totalThreads } : {}),
          hasMore: moreAfter === null ? page < totalPages : moreAfter,
        }}
        rowActions={(t) => [
          {
            id: 'view',
            label: th('threads.viewThread'),
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/tracing/threads/${t.threadId}`),
          },
        ]}
      />
    </PageContainer>
  );
}
