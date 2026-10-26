'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Collapse,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBook,
  IconChartHistogram,
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconRobot,
} from '@tabler/icons-react';
import SessionTable from '@/components/tracing/SessionTable';
import SessionStatusBadge from '@/components/tracing/SessionStatusBadge';
import AgentHealthPanel from '@/components/tracing/health/AgentHealthPanel';
import { formatDayLabel } from '@/components/tracing/health/healthFormat';
import { formatRelative } from '@/components/iam/timeFormat';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { DetailSkeleton } from '@/components/common/ui/Skeletons';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { useHealthDateFilter } from '@/components/tracing/health/useHealthDateFilter';
import { buildDashboardDateSearchParams, dashboardDateFilterKey } from '@/lib/utils/dashboardDateFilter';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  humanize,
  calcCacheHitRate,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { useLocale, useTranslations } from '@/lib/i18n';

interface AgentOverviewResponse {
  agent: {
    name: string;
    label: string;
    latestStatus: string | null;
    latestVersion: string | null;
    latestSessionAt: string | null;
    versions: string[];
    sessionsCount: number;
  };
  recentSessions: Array<{
    sessionId: string;
    threadId?: string;
    status: string;
    startedAt: string;
    durationMs: number | null;
    totalEvents: number | null;
    totalTokens: number | null;
  }>;
  analytics: {
    totals: {
      sessionsCount: number;
      totalEvents: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCachedInputTokens: number;
      totalTokens: number;
      totalDurationMs: number;
      averageInputTokensPerSession: number;
      averageOutputTokensPerSession: number;
      averageCachedInputTokensPerSession: number;
      averageTokensPerSession: number;
      averageDurationMs: number;
    };
    tools: {
      totals: {
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        successCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{ status: string; count: number }>;
    models: Array<{ model: string; sessionsCount: number }>;
    versions: Array<{ version: string | null; sessionsCount: number }>;
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
      averageDurationMs: number;
    }>;
    insights?: {
      sampledSessions: number;
      perCall: {
        aiCalls: number;
        toolCalls: number;
        avgAiCallsPerSession: number;
        avgToolCallsPerSession: number;
        avgInputTokensPerAiCall: number | null;
      };
      toolMenu: {
        coveragePct: number;
        avgMenuSize: number | null;
        maxMenuSize: number | null;
        distinctTools: number;
        available: boolean;
      };
      promptProfile: {
        found: boolean;
        sourceSessionId?: string;
        capturedAt?: string;
        preview?: string;
        lint?: {
          chars: number;
          lines: number;
          estTokens: number;
          paragraphs: number;
          passed: number;
          warned: number;
          failed: number;
          checks: Array<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
        };
      };
      errorPatterns: Array<{ message: string; count: number; lastSeen: string | null }>;
    } | null;
  };
}

export default function AgentTracingAgentPage() {
  const params = useParams<{ agentName: string }>();
  const router = useRouter();
  const t = useTranslations('tracingHealth');
  const locale = useLocale();
  const { openDocs } = useDocsDrawer();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AgentOverviewResponse | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [rawDailyOpen, setRawDailyOpen] = useState(false);
  // Same 24h default as the agents list and the health panel when the link carries no period.
  const [dateFilter, setDateFilter] = useHealthDateFilter('last_day');
  const filterKey = dashboardDateFilterKey(dateFilter);

  const agentName = useMemo(() => {
    const value = params?.agentName ?? '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }, [params?.agentName]);

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  useEffect(() => {
    if (!agentName) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        // The first load of an agent shows skeletons; later ones keep the page and show the refresh state.
        setRefreshing(true);
        setError(null);

        const query = buildDashboardDateSearchParams(dateFilter);
        query.append('timezone', timezone);

        const response = await fetch(
          `/api/tracing/agents/${encodeURIComponent(agentName)}/overview?${query}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
          throw new Error(typeof payload.error === 'string' ? payload.error : t('detail.loadError'));
        }

        const payload = (await response.json()) as AgentOverviewResponse;
        if (!controller.signal.aborted) setData(payload);
      } catch (err: unknown) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        console.error('Agent overview fetch error:', err);
        setError(err instanceof Error && err.message ? err.message : t('detail.loadError'));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void load();
    return () => controller.abort();
    // `filterKey` stands for `dateFilter`: the filter object is replaced on every URL change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName, filterKey, timezone, refreshKey, t]);

  const handleShowAllSessions = () => {
    router.push(`/dashboard/tracing/sessions?agent=${encodeURIComponent(agentName)}`);
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/dashboard/tracing/sessions/${encodeURIComponent(sessionId)}`);
  };

  const handleThreadClick = (threadId: string) => {
    router.push(`/dashboard/tracing/threads/${encodeURIComponent(threadId)}`);
  };

  if (loading && !data) {
    return <DetailSkeleton tabs={0} aside={false} actions={3} />;
  }

  const agent = data?.agent;
  const analytics = data?.analytics;
  const totals = analytics?.totals || {
    sessionsCount: 0,
    totalEvents: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    averageInputTokensPerSession: 0,
    averageOutputTokensPerSession: 0,
    averageCachedInputTokensPerSession: 0,
    averageTokensPerSession: 0,
    averageDurationMs: 0,
  };
  const toolTotals = analytics?.tools?.totals || {
    totalCalls: 0,
    errorCalls: 0,
    successCalls: 0,
    errorRate: 0,
  };
  const toolItems = analytics?.tools?.items || [];
  const statusEntries = analytics?.statuses || [];
  const versionEntries = analytics?.versions || [];
  const modelEntries = analytics?.models || [];
  const dailyRows = analytics?.daily || [];
  const displayLabel = agent?.label || agentName;
  const statusEntriesTotal = statusEntries.reduce(
    (sum, item) => sum + (item.count || 0),
    0,
  );

  type DailyRow = (typeof dailyRows)[number];
  const dailyColumns: DataGridColumn<DailyRow>[] = [
    { key: 'date', label: t('detail.colDate'), render: (row) => formatDayLabel(row.date, locale) },
    { key: 'sessions', label: t('detail.colSessions'), render: (row) => formatNumber(row.sessionsCount) },
    { key: 'events', label: t('detail.colEvents'), render: (row) => formatNumber(row.totalEvents) },
    { key: 'tokens', label: t('detail.colTokens'), render: (row) => formatNumber(row.totalTokens) },
    {
      key: 'avgDuration',
      label: t('detail.colAvgDuration'),
      render: (row) => formatDuration(row.averageDurationMs),
    },
  ];

  return (
    <DetailShell
      backHref="/dashboard/tracing"
      backLabel={t('detail.backToTracing')}
      icon={
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--ds-accent-soft)',
            color: 'var(--ds-accent)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <IconRobot size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1
            className="ds-h2"
            style={{
              margin: 0,
              whiteSpace: 'nowrap',
              maxWidth: 540,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {displayLabel}
          </h1>
          {agent?.latestStatus ? <SessionStatusBadge status={agent.latestStatus} /> : null}
          {agent?.latestVersion ? (
            <span className="ds-badge ds-badge-info">v{agent.latestVersion}</span>
          ) : null}
        </>
      }
      meta={
        <>
          <span className="ds-mono">{agentName}</span>
          <span className="ds-faint">·</span>
          <span>
            {t('detail.sessionsTracked', { count: formatNumber(agent?.sessionsCount || 0) })}
          </span>
          {agent?.latestSessionAt ? (
            <>
              <span className="ds-faint">·</span>
              <span>{t('detail.lastActive', { when: formatRelative(agent.latestSessionAt, locale) })}</span>
            </>
          ) : null}
        </>
      }
      actions={
        <>
          <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
          <Button
            onClick={() => openDocs('api-tracing')}
            variant="light"
            size="xs"
            leftSection={<IconBook size={14} />}
          >
            {t('common.docs')}
          </Button>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => setRefreshKey((key) => key + 1)}
            loading={refreshing}
          >
            {t('common.refresh')}
          </Button>
        </>
      }
    >
      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      {/* Top-level stat tiles */}
      <div className="ds-stat-grid">
        <StatTile
          label={t('detail.totalSessions')}
          value={formatNumber(totals.sessionsCount)}
          delta={t('detail.allTime', { count: formatNumber(agent?.sessionsCount || 0) })}
        />
        <StatTile
          label={t('detail.totalEvents')}
          value={formatNumber(totals.totalEvents)}
          delta={t('detail.avgDuration', { duration: formatDuration(totals.averageDurationMs) })}
        />
        <StatTile
          label={t('detail.totalTokens')}
          value={formatNumber(totals.totalTokens)}
          delta={t('detail.avgPerSession', { count: formatNumber(totals.averageTokensPerSession) })}
        />
        <StatTile
          label={t('detail.toolErrorRate')}
          value={formatPercent(toolTotals.errorRate)}
          delta={t('detail.totalCalls', { count: formatNumber(toolTotals.totalCalls) })}
        />
      </div>

      {/* Health: rollup charts, normal range, markers */}
      <AgentHealthPanel key={agentName} agentName={agentName} dateFilter={dateFilter} refreshKey={refreshKey} />

      {/* Token breakdown */}
      <DetailCard
        title={t('detail.tokenBreakdown')}
        description={t('detail.tokenBreakdownDescription')}
      >
        <div className="ds-stat-grid">
          <StatTile
            label={t('detail.inputTokens')}
            value={formatNumber(totals.totalInputTokens)}
            delta={t('detail.avgPerSession', { count: formatNumber(totals.averageInputTokensPerSession) })}
          />
          <StatTile
            label={t('detail.outputTokens')}
            value={formatNumber(totals.totalOutputTokens)}
            delta={t('detail.avgPerSession', { count: formatNumber(totals.averageOutputTokensPerSession) })}
          />
          <StatTile
            label={t('detail.cachedInput')}
            value={formatNumber(totals.totalCachedInputTokens)}
            delta={t('detail.cacheHitRate', {
              rate: formatPercent(
                calcCacheHitRate(totals.totalInputTokens, totals.totalCachedInputTokens),
              ),
            })}
          />
        </div>
      </DetailCard>

      {/* Deterministic analysis lives on the Cost workbench */}
      <Alert
        color="teal"
        variant="light"
        icon={<IconChartHistogram size={16} />}
        title={t('detail.analysisMovedTitle')}
      >
        <Text size="sm">
          {t('detail.analysisMovedBefore')}{' '}
          <Anchor component={Link} size="sm" href="/dashboard/cost/analysis">
            {t('detail.analysisMovedLink')}
          </Anchor>
          .
        </Text>
      </Alert>

      {/* Two-column: Status + Versions */}
      <DetailTwoCol>
        <DetailCard
          title={t('detail.statusBreakdown')}
          actions={
            <span className="ds-badge">{formatNumber(statusEntriesTotal)}</span>
          }
        >
          {statusEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              {t('detail.noStatusData')}
            </Center>
          ) : (
            <Stack gap={6}>
              {statusEntries.map((item) => (
                <Group key={item.status} justify="space-between">
                  <Text size="sm">{humanize(item.status)}</Text>
                  <Badge size="sm" color="blue">
                    {formatNumber(item.count)}
                  </Badge>
                </Group>
              ))}
            </Stack>
          )}
        </DetailCard>

        <DetailCard
          title={t('detail.versions')}
          actions={
            <span className="ds-badge">
              {t('detail.versionsCount', { count: formatNumber(agent?.versions.length || 0) })}
            </span>
          }
        >
          {versionEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              {t('detail.noVersions')}
            </Center>
          ) : (
            <Stack gap={6}>
              {versionEntries.map((item) => (
                <Group key={item.version || 'unknown'} justify="space-between">
                  <Text size="sm">{item.version || t('detail.unknownVersion')}</Text>
                  <Badge size="sm" color="grape">
                    {formatNumber(item.sessionsCount)}
                  </Badge>
                </Group>
              ))}
            </Stack>
          )}
        </DetailCard>
      </DetailTwoCol>

      {/* Two-column: Top models + Tool summary */}
      <DetailTwoCol>
        <DetailCard
          title={t('detail.topModels')}
          actions={
            <span className="ds-badge">
              {t('detail.entries', { count: formatNumber(modelEntries.length) })}
            </span>
          }
        >
          {modelEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              {t('detail.noModels')}
            </Center>
          ) : (
            <Stack gap={6}>
              {modelEntries.slice(0, 10).map((item) => (
                <Group key={item.model} justify="space-between">
                  <Text size="sm" lineClamp={1}>
                    {item.model}
                  </Text>
                  <Badge size="sm" color="teal">
                    {formatNumber(item.sessionsCount)}
                  </Badge>
                </Group>
              ))}
            </Stack>
          )}
        </DetailCard>

        <DetailCard
          title={t('detail.toolSummary')}
          actions={
            <span className="ds-badge">
              {t('detail.entries', { count: formatNumber(toolItems.length) })}
            </span>
          }
        >
          {toolItems.length === 0 ? (
            <Center h={120} c="dimmed">
              {t('detail.noTools')}
            </Center>
          ) : (
            <Stack gap={6}>
              {toolItems.slice(0, 10).map((item) => (
                <Group key={item.toolName} justify="space-between" align="center">
                  <Stack gap={0}>
                    <Text size="sm" fw={500}>{item.toolName}</Text>
                    <Text size="xs" c="dimmed">
                      {t('detail.callsAndErrors', {
                        calls: formatNumber(item.totalCalls),
                        errors: formatNumber(item.errorCalls),
                      })}
                    </Text>
                  </Stack>
                  <Badge size="sm" color={item.errorRate > 0.1 ? 'red' : 'green'}>
                    {formatPercent(item.errorRate)}
                  </Badge>
                </Group>
              ))}
            </Stack>
          )}
        </DetailCard>
      </DetailTwoCol>

      {/* Raw daily activity: the charts above replace it as the way to read the trend */}
      <DetailCard
        title={
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            px={0}
            onClick={() => setRawDailyOpen((open) => !open)}
            aria-expanded={rawDailyOpen}
            aria-controls="agent-raw-daily"
            leftSection={rawDailyOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          >
            {t('detail.rawDaily')}
          </Button>
        }
        actions={
          <span className="ds-badge">{t('detail.rawDailyDays', { count: formatNumber(dailyRows.length) })}</span>
        }
      >
        <Collapse in={rawDailyOpen} id="agent-raw-daily">
          <DataGrid<DailyRow>
            records={dailyRows}
            rowKey={(row) => row.date}
            columns={dailyColumns}
            empty={{ title: t('detail.noActivity') }}
          />
        </Collapse>
      </DetailCard>

      {/* Recent sessions */}
      <DetailCard
        title={t('detail.recentSessions')}
        description={t('detail.recentSessionsDescription')}
        actions={
          <Button
            variant="light"
            size="xs"
            rightSection={<IconArrowUpRight size={14} />}
            onClick={handleShowAllSessions}
          >
            {t('detail.showAllSessions')}
          </Button>
        }
      >
        <SessionTable
          sessions={(data?.recentSessions || []).map((session) => ({
            sessionId: session.sessionId,
            threadId: session.threadId,
            agentName,
            status: session.status,
            startedAt: session.startedAt,
            durationMs: session.durationMs ?? undefined,
            totalEvents: session.totalEvents ?? undefined,
            totalTokens: session.totalTokens ?? undefined,
          }))}
          onRowClick={handleSessionClick}
          onThreadClick={handleThreadClick}
          loading={loading && !data}
        />
      </DetailCard>

      <DetailCard pad="md">
        <Text size="sm" c="dimmed">
          {t('detail.footerBefore')}{' '}
          <span className="ds-mono">/api/client/tracing/sessions</span>
          {' '}{t('detail.footerWith')}{' '}
          <Anchor component={Link} href="/dashboard/tokens">{t('detail.footerTokensLink')}</Anchor>
          {'. '}{t('detail.footerSee')}{' '}
          <Anchor component="button" onClick={() => openDocs('examples-tracing')}>
            {t('detail.footerExamplesLink')}
          </Anchor>
          {' '}{t('detail.footerAfter')}
        </Text>
      </DetailCard>
    </DetailShell>
  );
}
