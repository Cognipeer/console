'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ActionIcon, Button, Group, Text, TextInput, Tooltip } from '@mantine/core';
import {
  IconBook,
  IconCamera,
  IconEye,
  IconX,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import FlowAttributionLink from '@/components/tracing/FlowAttributionLink';
import { hasFlowAttribution, type TracingFlowBlock } from '@/components/tracing/flowAttribution';
import SessionStatusBadge from '@/components/tracing/SessionStatusBadge';
import {
  isTracingStatusFilterValue,
  TRACING_STATUS_FILTER_VALUES,
} from '@/components/tracing/sessionStatus';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  formatDuration,
  formatNumber,
  formatRelativeTime,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { SkipTrail, type OffsetPageInfo } from '@/lib/shared/offsetPaging';

interface SessionRecord {
  sessionId: string;
  threadId?: string;
  agentName?: string;
  /** Set when the session belongs to an agent a flow owns. */
  flow?: TracingFlowBlock | null;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  totalEvents?: number;
  totalTokens?: number;
}

// A caller who may not view every session gets `hasMore` / `nextSkip` instead of a `total` (see offsetPaging.ts).
interface SessionsResponse extends OffsetPageInfo {
  sessions: SessionRecord[];
}

dayjs.extend(relativeTime);

const DEFAULT_PAGE_SIZE = 25;

/** A `from` / `to` URL value (an ISO instant or a date) as an ISO string, or '' when it is not a date. */
function isoParam(value: string | null): string {
  const raw = value?.trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

/** A `status` URL value the filter offers, else 'all'. */
function statusParam(value: string | null): string {
  const raw = value?.trim() ?? '';
  return isTracingStatusFilterValue(raw) ? raw : 'all';
}

export default function TracingSessionsPage() {
  const router = useRouter();
  const pathname = usePathname()!;
  const searchParams = useSearchParams()!;
  const t = useTranslations('tracingHealth');
  const locale = useLocale();
  const { openDocs } = useDocsDrawer();
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [totalSessions, setTotalSessions] = useState(0);
  // Where each page starts, and whether a list without a total has a next page (null: it has a total).
  const skipTrail = useRef(new SkipTrail());
  const [moreAfter, setMoreAfter] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  // Status and time range come from the URL too: the health charts and agent list link here for an agent's
  // failing sessions in a range.
  const [statusFilter, setStatusFilter] = useState(() => statusParam(searchParams.get('status')));
  const [fromFilter, setFromFilter] = useState(() => isoParam(searchParams.get('from')));
  const [toFilter, setToFilter] = useState(() => isoParam(searchParams.get('to')));
  const [agentFilter, setAgentFilter] = useState(
    () => searchParams.get('agent')?.trim() || '',
  );
  // Sessions of the hidden agents a flow owns, narrowed to one flow (`?flowId=`).
  const [flowFilter, setFlowFilter] = useState(() => searchParams.get('flowId')?.trim() || '');
  const [flowOptions, setFlowOptions] = useState<Array<{ value: string; label: string }>>([]);
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
    if (query) params.set('query', query.trim());
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (agentFilter) params.set('agent', agentFilter.trim());
    if (flowFilter) params.set('flowId', flowFilter);
    if (fromFilter) params.set('from', fromFilter);
    if (toFilter) params.set('to', toFilter);
    if (metadataKey.trim() && metadataValue.trim()) {
      params.set('metadataKey', metadataKey.trim());
      params.set('metadataValue', metadataValue.trim());
    }
    return params;
  }, [page, pageSize, query, statusFilter, agentFilter, flowFilter, fromFilter, toFilter, metadataKey, metadataValue]);

  /** Writes (or removes) URL params without a navigation, so the filters stay shareable. */
  const replaceUrlParams = useCallback(
    (changes: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams],
  );

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
        skipTrail.current.remember(page, data);
        setTotalSessions(data.total ?? 0);
        setMoreAfter(typeof data.total === 'number' ? null : data.hasMore === true);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load sessions:', error);
        setSessions([]);
        setTotalSessions(0);
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

  // The URL only carries agent, status and range (typed metadata filters are page state), and the page rewrites
  // it itself on a status or range change. So a param is applied only when the URL moved on it since the last
  // run (a link, back/forward): re-applying them all would reset the typed metadata filter to the URL's empty value.
  const seenUrl = useRef<Record<string, string> | null>(null);
  useEffect(() => {
    const current = {
      agent: searchParams.get('agent')?.trim() || '',
      flowId: searchParams.get('flowId')?.trim() || '',
      status: statusParam(searchParams.get('status')),
      from: isoParam(searchParams.get('from')),
      to: isoParam(searchParams.get('to')),
      metadataKey: searchParams.get('metadataKey')?.trim() || '',
      metadataValue: searchParams.get('metadataValue')?.trim() || '',
    };
    const before = seenUrl.current;
    seenUrl.current = current;
    const moved = (key: keyof typeof current) => before === null || before[key] !== current[key];
    if (moved('agent')) setAgentFilter((value) => (value === current.agent ? value : current.agent));
    if (moved('flowId')) setFlowFilter((value) => (value === current.flowId ? value : current.flowId));
    if (moved('status')) setStatusFilter((value) => (value === current.status ? value : current.status));
    if (moved('from')) setFromFilter((value) => (value === current.from ? value : current.from));
    if (moved('to')) setToFilter((value) => (value === current.to ? value : current.to));
    if (moved('metadataKey')) setMetadataKey((value) => (value === current.metadataKey ? value : current.metadataKey));
    if (moved('metadataValue')) setMetadataValue((value) => (value === current.metadataValue ? value : current.metadataValue));
  }, [searchParams]);

  // Another search is another list: the pages of the last one no longer say where this one's start.
  useEffect(() => {
    skipTrail.current.reset();
  }, [query, statusFilter, agentFilter, flowFilter, fromFilter, toFilter, metadataKey, metadataValue]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSessions(false, controller.signal);
    return () => controller.abort();
  }, [fetchSessions]);

  // The flows to filter by. Without flows access the filter is simply not offered.
  useEffect(() => {
    const controller = new AbortController();
    // Answers 404 / 402 where Flows are not part of the edition or the license: no options then.
    fetch('/api/flows?limit=200', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => (response.ok ? ((await response.json()) as { items?: Array<{ id: string; name: string }> }) : null))
      .then((result) => {
        if (controller.signal.aborted || !result?.items) return;
        setFlowOptions(result.items.map((flow) => ({ value: flow.id, label: flow.name })));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(totalSessions / pageSize)),
    [totalSessions, pageSize],
  );

  const columns: DataGridColumn<SessionRecord>[] = [
    {
      key: 'agent',
      label: t('sessionTable.agent'),
      render: (s) =>
        hasFlowAttribution(s) ? (
          <FlowAttributionLink flow={s.flow} />
        ) : (
          <Tooltip label={s.agentName || s.sessionId} withArrow>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
              {s.agentName || '—'}
            </span>
          </Tooltip>
        ),
    },
    {
      key: 'session',
      label: t('sessionTable.sessionId'),
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
      label: t('sessionTable.thread'),
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
      label: t('sessionTable.status'),
      render: (s) => <SessionStatusBadge status={s.status} />,
    },
    {
      key: 'started',
      label: t('sessionTable.started'),
      render: (s) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatRelativeTime(s.startedAt)}
        </span>
      ),
    },
    {
      key: 'duration',
      label: t('sessionTable.duration'),
      render: (s) => (
        <span className="ds-mono" style={{ fontSize: 12 }}>
          {formatDuration(s.durationMs)}
        </span>
      ),
    },
    {
      key: 'events',
      label: t('sessionTable.events'),
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
      label: t('sessionTable.tokens'),
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
        eyebrow={t('eyebrow')}
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              size="sm"
              leftSection={<IconCamera size={14} stroke={1.7} />}
              onClick={() =>
                router.push(
                  `/dashboard/evaluations/snapshots/new?source=tracing${
                    agentFilter ? `&agent=${encodeURIComponent(agentFilter)}` : ''
                  }`,
                )
              }
            >
              {t('sessions.createSnapshot')}
            </Button>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconBook size={14} stroke={1.7} />}
              onClick={() => openDocs('api-tracing')}
            >
              {t('common.docs')}
            </Button>
          </Group>
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
          placeholder: t('sessions.search'),
        }}
        filters={[
          ...(flowOptions.length > 0 || flowFilter
            ? [
                {
                  value: flowFilter || 'all',
                  onChange: (v: string) => {
                    const next = v === 'all' ? '' : v;
                    setFlowFilter(next);
                    setPage(1);
                    replaceUrlParams({ flowId: next || null });
                  },
                  ariaLabel: t('sessions.flowFilter'),
                  width: 190,
                  options: [
                    { value: 'all', label: t('sessions.flowAll') },
                    ...flowOptions,
                    // A flow filter from the URL that the list does not know (no flows access, or deleted).
                    ...(flowFilter && !flowOptions.some((o) => o.value === flowFilter)
                      ? [{ value: flowFilter, label: flowFilter }]
                      : []),
                  ],
                },
              ]
            : []),
          {
            value: statusFilter,
            onChange: (v) => {
              setStatusFilter(v);
              setPage(1);
              replaceUrlParams({ status: v === 'all' ? null : v });
            },
            ariaLabel: t('sessions.statusFilter'),
            width: 150,
            options: [
              { value: 'all', label: t('sessions.statusAll') },
              ...TRACING_STATUS_FILTER_VALUES.map((value) => ({ value, label: t(`status.${value}`) })),
            ],
          },
        ]}
        toolbarRight={
          <Group gap={4} wrap="nowrap">
            {fromFilter || toFilter ? (
              <span className="ds-badge ds-row ds-gap-xs" data-testid="sessions-range-chip">
                {fromFilter && toFilter
                  ? t('sessions.rangeChip', { from: formatDateTime(fromFilter, locale), to: formatDateTime(toFilter, locale) })
                  : fromFilter
                    ? t('sessions.rangeFrom', { from: formatDateTime(fromFilter, locale) })
                    : t('sessions.rangeTo', { to: formatDateTime(toFilter, locale) })}
                <Tooltip label={t('sessions.clearRange')} withArrow>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="gray"
                    aria-label={t('sessions.clearRange')}
                    onClick={() => {
                      setFromFilter('');
                      setToFilter('');
                      setPage(1);
                      replaceUrlParams({ from: null, to: null });
                    }}
                  >
                    <IconX size={12} />
                  </ActionIcon>
                </Tooltip>
              </span>
            ) : null}
            <TextInput
              size="xs"
              placeholder={t('sessions.metadataKey')}
              aria-label={t('sessions.metadataKey')}
              value={metadataKey}
              onChange={(e) => {
                setMetadataKey(e.currentTarget.value);
                setPage(1);
              }}
              style={{ width: 130 }}
            />
            <TextInput
              size="xs"
              placeholder={t('sessions.metadataValue')}
              aria-label={t('sessions.metadataValue')}
              value={metadataValue}
              onChange={(e) => {
                setMetadataValue(e.currentTarget.value);
                setPage(1);
              }}
              style={{ width: 130 }}
            />
            {(metadataKey || metadataValue) && (
              <Tooltip label={t('sessions.clearMetadata')} withArrow>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={t('sessions.clearMetadata')}
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
        onRefresh={() => void fetchSessions(true)}
        refreshing={refreshing}
        empty={{
          title: t('sessionTable.emptyTitle'),
          description: t('sessionTable.emptyDescription'),
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {moreAfter === null
              ? t('sessions.footerTotal', { total: formatNumber(totalSessions), page, pages: totalPages })
              : t('sessions.footerPage', { page })}
          </Text>
        }
        pagination={{
          page,
          onPageChange: setPage,
          pageSize,
          ...(moreAfter === null ? { total: totalSessions } : {}),
          hasMore: moreAfter === null ? page < totalPages : moreAfter,
        }}
        rowActions={(s) => [
          {
            id: 'view',
            label: t('sessions.viewSession'),
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/tracing/sessions/${s.sessionId}`),
          },
        ]}
      />
    </PageContainer>
  );
}
