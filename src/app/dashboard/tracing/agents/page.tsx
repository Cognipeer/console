'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Button, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconBellPlus,
  IconBook,
  IconEye,
  IconListSearch,
  IconRobot,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import Spark from '@/components/common/ui/Spark';
import { SkeletonText } from '@/components/common/ui/Skeletons';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import SessionStatusBadge from '@/components/tracing/SessionStatusBadge';
import { normalizeTracingStatus, TRACING_STATUS_FILTER_VALUES } from '@/components/tracing/sessionStatus';
import {
  buildAgentDetailHref,
  buildCreateAgentAlertHref,
  buildFailingSessionsHref,
} from '@/components/tracing/health/healthLinks';
import {
  formatHealthCost,
  formatHealthCount,
  formatHealthMs,
  formatHealthPercent,
} from '@/components/tracing/health/healthFormat';
import { computeDelta, deltaText, type KpiKind } from '@/components/tracing/health/healthSeries';
import {
  errorSpark,
  filterAgentRows,
  isErrorRateElevated,
  mergeAgentRows,
  sortAgentRows,
  type AgentDirectoryApiRow,
  type AgentHealthApiRow,
  type AgentHealthFilter,
  type AgentListRow,
  type AgentSortKey,
  type SortDirection,
} from '@/components/tracing/health/agentRows';
import { useHealthDateFilter } from '@/components/tracing/health/useHealthDateFilter';
import { formatRelative } from '@/components/iam/timeFormat';
import { buildDashboardDateSearchParams } from '@/lib/utils/dashboardDateFilter';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { useLocale, useTranslations } from '@/lib/i18n';

interface HealthResponse {
  range: { fromMs: number; toMs: number; bucketMs: number; sparkFromMs?: number };
  agents: AgentHealthApiRow[];
  total: number;
  /** False when the alert read failed: the rows' alert state is unknown, not all-clear. Absent on an older server. */
  alertsAvailable?: boolean;
}

interface DirectoryResponse {
  agents: AgentDirectoryApiRow[];
  total: number;
}

// Both endpoints are a "top N" list (the sub-nav and pickers use the directory too), not a paginated
// one: a generous cap covers realistic per-tenant agent counts without server-side pagination.
const LIST_LIMIT = 200;

type HealthState =
  | { status: 'loading'; data: HealthResponse | null }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; data: HealthResponse };

function SortHeader({
  label,
  column,
  sortKey,
  direction,
  onSort,
  align,
  ariaLabel,
  sortedLabel,
}: {
  label: string;
  column: AgentSortKey;
  sortKey: AgentSortKey;
  direction: SortDirection;
  onSort: (column: AgentSortKey) => void;
  align?: 'right';
  ariaLabel: string;
  /** Spoken state of the active sort ("sorted ascending"), for assistive tech. */
  sortedLabel: string;
}) {
  const active = sortKey === column;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      aria-label={ariaLabel}
      data-sorted={active ? direction : undefined}
      style={{
        // Reset the button chrome but keep the browser's focus-visible outline for keyboard users.
        background: 'none',
        border: 0,
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        width: align === 'right' ? '100%' : undefined,
        font: 'inherit',
        color: active ? 'var(--ds-text)' : 'inherit',
      }}
    >
      {label}
      {active ? <VisuallyHidden>{sortedLabel}</VisuallyHidden> : null}
      {active ? (
        direction === 'asc' ? <IconArrowUp size={12} stroke={2} aria-hidden="true" /> : <IconArrowDown size={12} stroke={2} aria-hidden="true" />
      ) : null}
    </button>
  );
}

/**
 * The sortable headers are buttons, which the browser exempts from the grid's uppercase header style; a plain
 * header gets the same treatment so the whole row reads in one case.
 */
const PLAIN_HEADER_STYLE = { textTransform: 'none', letterSpacing: 'normal' } as const;

const NUMBER_STYLE = { fontSize: 12.5, fontVariantNumeric: 'tabular-nums' } as const;

export default function TracingAgentsPage() {
  const router = useRouter();
  const t = useTranslations('tracingHealth');
  const locale = useLocale();
  const { openDocs } = useDocsDrawer();
  const [dateFilter, setDateFilter] = useHealthDateFilter('last_day');
  const [health, setHealth] = useState<HealthState>({ status: 'loading', data: null });
  const [directory, setDirectory] = useState<AgentDirectoryApiRow[] | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [healthFilter, setHealthFilter] = useState<AgentHealthFilter>('all');
  const [sortKey, setSortKey] = useState<AgentSortKey>('sessions');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const periodQuery = useMemo(() => {
    const params = buildDashboardDateSearchParams(dateFilter);
    params.set('limit', String(LIST_LIMIT));
    return params.toString();
  }, [dateFilter]);

  // The health overview follows the selected period.
  useEffect(() => {
    const controller = new AbortController();
    setHealth((previous) => ({ status: 'loading', data: previous.status === 'error' ? null : previous.data }));
    const load = async () => {
      try {
        const response = await fetch(`/api/tracing/agents/health?${periodQuery}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: unknown };
          throw new Error(typeof body.error === 'string' ? body.error : '');
        }
        const data = (await response.json()) as HealthResponse;
        if (!controller.signal.aborted) setHealth({ status: 'ready', data });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setHealth({ status: 'error', message: error instanceof Error && error.message ? error.message : null });
      }
    };
    void load();
    return () => controller.abort();
  }, [periodQuery, attempt]);

  // The directory only adds each agent's latest status (and agents the rollup has nothing for): it is
  // independent of the period, and the list does not wait for it.
  useEffect(() => {
    const controller = new AbortController();
    setDirectoryLoading(true);
    setDirectoryError(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/tracing/agents?limit=${LIST_LIMIT}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('directory');
        const data = (await response.json()) as DirectoryResponse;
        if (!controller.signal.aborted) {
          setDirectory(Array.isArray(data.agents) ? data.agents : []);
          setDirectoryLoading(false);
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
        setDirectory(null);
        setDirectoryError(true);
        setDirectoryLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [attempt]);

  const healthData = health.status === 'error' ? null : health.data;
  const range = healthData?.range ?? null;

  const rows = useMemo(
    () => mergeAgentRows(healthData?.agents ?? [], directory, healthData?.alertsAvailable),
    [healthData, directory],
  );

  const visibleRows = useMemo(
    () =>
      sortAgentRows(
        filterAgentRows(
          rows,
          // Without the directory there is no latest status to filter on: the filter is not offered.
          { query, status: directoryError ? 'all' : statusFilter, health: healthFilter },
          normalizeTracingStatus,
        ),
        sortKey,
        sortDirection,
      ),
    [rows, query, statusFilter, directoryError, healthFilter, sortKey, sortDirection],
  );

  const handleSort = useCallback(
    (column: AgentSortKey) => {
      if (sortKey === column) {
        setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(column);
      setSortDirection(column === 'name' ? 'asc' : 'desc');
    },
    [sortKey],
  );

  const detailHref = useCallback(
    (agentName: string) => buildAgentDetailHref(agentName, dateFilter),
    [dateFilter],
  );

  const sortHeader = (label: string, column: AgentSortKey, align?: 'right') => (
    <SortHeader
      label={label}
      column={column}
      sortKey={sortKey}
      direction={sortDirection}
      onSort={handleSort}
      align={align}
      ariaLabel={t('agents.sortBy', { column: label })}
      sortedLabel={t(sortDirection === 'asc' ? 'agents.sortedAsc' : 'agents.sortedDesc')}
    />
  );

  const deltaLine = (
    current: number | null | undefined,
    previous: number | null | undefined,
    kind: KpiKind,
    good: 'up' | 'down' | 'none',
  ) => {
    const delta = computeDelta(current, previous, kind, good);
    if (!delta || !delta.significant) return null;
    const color = delta.tone === 'bad' ? 'var(--ds-err)' : delta.tone === 'good' ? 'var(--ds-ok)' : undefined;
    return (
      <div className="ds-faint" style={{ fontSize: 11, color }} data-tone={delta.tone}>
        {deltaText(delta, t('kpi.newDelta'), locale)}
      </div>
    );
  };

  const noData = <span className="ds-faint">—</span>;

  const columns: DataGridColumn<AgentListRow>[] = [
    {
      key: 'name',
      label: sortHeader(t('agents.col.agent'), 'name'),
      render: (a) => (
        <Tooltip label={a.name} withArrow>
          <Link
            href={detailHref(a.name)}
            className="ds-row ds-gap-xs"
            style={{ fontSize: 12.5, color: 'var(--ds-text)', textDecoration: 'none' }}
            onClick={(event) => event.stopPropagation()}
          >
            <IconRobot size={14} stroke={1.7} aria-hidden="true" />
            {a.name}
          </Link>
        </Tooltip>
      ),
    },
    {
      key: 'health',
      label: sortHeader(t('agents.col.health'), 'health'),
      render: (a) => {
        // An unreadable alert state never shows a firing/pending phase that may be stale.
        const phase = a.alertState === 'unknown' ? null : a.alert.phase;
        const severity = a.alert.severity ? t(`health.severity.${a.alert.severity}`) : null;
        if (phase === 'firing') {
          const badge = (
            <span className="ds-badge ds-badge-err" title={t('health.firingHint')}>
              <span className="ds-badge-dot" />
              {t('health.firing')}
              {severity ? ` · ${severity}` : ''}
            </span>
          );
          return a.alert.incidentId ? (
            <Link
              href={`/dashboard/alerts/incidents/${encodeURIComponent(a.alert.incidentId)}`}
              onClick={(event) => event.stopPropagation()}
              aria-label={`${t('health.openIncident')}: ${t('health.firing')}`}
              style={{ textDecoration: 'none' }}
            >
              {badge}
            </Link>
          ) : badge;
        }
        if (phase === 'pending') {
          return (
            <span className="ds-badge ds-badge-warn" title={t('health.pendingHint')}>
              <span className="ds-badge-dot" />
              {t('health.pending')}
            </span>
          );
        }
        if (a.alertState === 'unknown') {
          return (
            <span className="ds-badge" title={t('health.unknownHint')}>
              <span className="ds-badge-dot" />
              {t('health.unknown')}
            </span>
          );
        }
        if (a.alertState === 'uncovered') {
          return (
            <Link
              href={buildCreateAgentAlertHref(a.name)}
              onClick={(event) => event.stopPropagation()}
              className="ds-badge"
              style={{ textDecoration: 'none' }}
              title={t('health.noRuleHint')}
              aria-label={`${t('health.noRule')}: ${t('agents.actions.createAlert')}`}
            >
              <span className="ds-badge-dot" />
              {t('health.noRule')}
            </Link>
          );
        }
        return (
          <span className="ds-badge ds-badge-ok" title={t('health.okHint')}>
            <span className="ds-badge-dot" />
            {t('health.ok')}
          </span>
        );
      },
    },
    {
      key: 'sessions',
      label: sortHeader(t('agents.col.sessions'), 'sessions', 'right'),
      align: 'right',
      render: (a) =>
        a.totals ? (
          <div>
            <span className="ds-mono" style={NUMBER_STYLE}>{formatHealthCount(a.totals.requests, locale)}</span>
            {deltaLine(a.totals.requests, a.previous?.requests, 'count', 'none')}
          </div>
        ) : (
          <Tooltip label={t('agents.noData')} withArrow>{noData}</Tooltip>
        ),
    },
    {
      key: 'errorRate',
      label: sortHeader(t('agents.col.errorRate'), 'errorRate', 'right'),
      align: 'right',
      render: (a) => {
        if (!a.totals || typeof a.totals.errorRate !== 'number') return noData;
        const elevated = isErrorRateElevated(a.totals, a.previous);
        return (
          <div>
            <span
              className="ds-mono"
              style={{ ...NUMBER_STYLE, color: elevated ? 'var(--ds-err)' : undefined, fontWeight: elevated ? 600 : undefined }}
              data-elevated={elevated ? 'true' : undefined}
            >
              {formatHealthPercent(a.totals.errorRate, locale)}
            </span>
            {deltaLine(a.totals.errorRate, a.previous?.errorRate, 'percent', 'down')}
          </div>
        );
      },
    },
    {
      key: 'p95',
      label: sortHeader(t('agents.col.p95'), 'p95Ms', 'right'),
      align: 'right',
      render: (a) =>
        a.totals && typeof a.totals.p95Ms === 'number' ? (
          <div>
            <span className="ds-mono" style={NUMBER_STYLE}>{formatHealthMs(a.totals.p95Ms, locale)}</span>
            {deltaLine(a.totals.p95Ms, a.previous?.p95Ms, 'ms', 'down')}
          </div>
        ) : noData,
    },
    {
      key: 'toolErrorRate',
      label: sortHeader(t('agents.col.toolErrorRate'), 'toolErrorRate', 'right'),
      align: 'right',
      render: (a) =>
        a.totals && (a.totals.toolCalls ?? 0) > 0 && typeof a.totals.toolErrorRate === 'number' ? (
          <div>
            <span className="ds-mono" style={NUMBER_STYLE}>{formatHealthPercent(a.totals.toolErrorRate, locale)}</span>
            {deltaLine(a.totals.toolErrorRate, a.previous?.toolErrorRate, 'percent', 'down')}
          </div>
        ) : noData,
    },
    {
      key: 'cost',
      label: sortHeader(t('agents.col.cost'), 'cost', 'right'),
      align: 'right',
      render: (a) =>
        a.totals && (a.totals.costUsd ?? 0) > 0 ? (
          <span className="ds-mono" style={NUMBER_STYLE}>{formatHealthCost(a.totals.costUsd, locale)}</span>
        ) : noData,
    },
    {
      key: 'trend',
      label: <span style={PLAIN_HEADER_STYLE}>{t('agents.col.trend')}</span>,
      width: 130,
      render: (a) => {
        const requests = a.spark && a.spark.requests.length > 1 ? a.spark.requests : null;
        const errors = errorSpark(a.spark?.errorRate);
        if (!requests && !errors) return noData;
        return (
          <div style={{ width: 104 }}>
            {requests ? (
              <div title={t('agents.trendSessions')}>
                <Spark data={requests} height={16} filled={false} />
              </div>
            ) : null}
            {errors ? (
              <div title={t('agents.trendErrors')}>
                <Spark data={errors} height={16} filled={false} color="var(--ds-err)" />
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'status',
      label: sortHeader(t('agents.col.lastStatus'), 'lastStatus'),
      render: (a) => {
        if (!a.latestStatus && directoryLoading) return <SkeletonText width={64} />;
        if (directoryError) return <Tooltip label={t('agents.directoryUnavailable')} withArrow>{noData}</Tooltip>;
        return (
          <div>
            {a.latestStatus ? <SessionStatusBadge status={a.latestStatus} /> : noData}
            {a.latestSessionAt ? (
              <div className="ds-faint" style={{ fontSize: 11, marginTop: 2 }}>
                {t('agents.lastSession', { when: formatRelative(a.latestSessionAt, locale) })}
              </div>
            ) : null}
          </div>
        );
      },
    },
  ];

  const loading = health.status === 'loading' && health.data === null;
  const refreshing = health.status === 'loading' && health.data !== null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('agents.title')}
        subtitle={`${t('agents.subtitle')}${dateFilter.period === 'total' ? ` ${t('agents.periodTotalNote')}` : ''}`}
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="default"
              size="sm"
              leftSection={<IconBook size={14} stroke={1.7} />}
              onClick={() => openDocs('api-tracing')}
            >
              {t('common.docs')}
            </Button>
          </>
        }
      />

      {health.status === 'error' ? (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title={t('agents.loadError')}>
          <div className="ds-row-between" style={{ gap: 12 }}>
            <span style={{ fontSize: 13 }}>{health.message}</span>
            <Button size="xs" variant="default" onClick={() => setAttempt((n) => n + 1)}>
              {t('common.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      {healthData?.alertsAvailable === false ? (
        <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />} data-testid="agents-alerts-unavailable">
          <span style={{ fontSize: 13 }}>{t('agents.alertsUnavailable')}</span>
        </Alert>
      ) : null}

      {directoryError ? (
        <Alert color="yellow" variant="light" icon={<IconAlertCircle size={16} />} data-testid="agents-directory-error">
          <div className="ds-row-between" style={{ gap: 12 }}>
            <span style={{ fontSize: 13 }}>{t('agents.directoryUnavailable')}</span>
            <Button size="xs" variant="default" onClick={() => setAttempt((n) => n + 1)}>
              {t('common.retry')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <DataGrid<AgentListRow>
        records={visibleRows}
        loading={loading}
        rowKey={(a) => a.name}
        rowHref={(a) => detailHref(a.name)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t('agents.search'),
        }}
        filters={[
          {
            value: healthFilter,
            onChange: (value) => setHealthFilter(value as AgentHealthFilter),
            ariaLabel: t('agents.healthFilter'),
            width: 170,
            options: [
              { value: 'all', label: t('agents.allHealth') },
              { value: 'firing', label: t('health.firing') },
              { value: 'pending', label: t('health.pending') },
              { value: 'ok', label: t('health.ok') },
              { value: 'uncovered', label: t('health.noRule') },
            ],
          },
          ...(directoryError
            ? []
            : [
                {
                  value: statusFilter,
                  onChange: setStatusFilter,
                  ariaLabel: t('agents.statusFilter'),
                  width: 170,
                  options: [
                    { value: 'all', label: t('agents.allStatuses') },
                    ...TRACING_STATUS_FILTER_VALUES.map((value) => ({ value, label: t(`status.${value}`) })),
                  ],
                },
              ]),
        ]}
        onRefresh={() => setAttempt((n) => n + 1)}
        refreshing={refreshing}
        empty={{
          icon: <IconRobot size={26} stroke={1.7} />,
          title: t('agents.emptyTitle'),
          description: t('agents.emptyDescription'),
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {t('agents.footer', {
              shown: formatHealthCount(visibleRows.length, locale),
              total: formatHealthCount(rows.length, locale),
            })}
          </Text>
        }
        rowActions={(a) => [
          {
            id: 'view',
            label: t('agents.actions.view'),
            icon: <IconEye size={14} />,
            onClick: () => router.push(detailHref(a.name)),
          },
          {
            id: 'create-alert',
            label: t('agents.actions.createAlert'),
            icon: <IconBellPlus size={14} />,
            onClick: () => router.push(buildCreateAgentAlertHref(a.name)),
          },
          {
            id: 'failing-sessions',
            label: t('agents.actions.failingSessions'),
            icon: <IconListSearch size={14} />,
            onClick: () =>
              router.push(buildFailingSessionsHref(a.name, range ? { fromMs: range.fromMs, toMs: range.toMs } : null)),
          },
        ]}
      />
    </PageContainer>
  );
}
