'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Stack,
  Group,
  Text,
  Button,
  Badge,
  Anchor,
  ThemeIcon,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  IconAlertCircle,
  IconPlug,
  IconRefresh,
  IconActivity,
  IconCpu,
  IconMessage,
  IconAlertTriangle,
  IconRobot,
  IconChartBar,
  IconExternalLink,
  IconArrowUpRight,
  IconDatabase,
} from '@tabler/icons-react';
import SessionTable from '@/components/tracing/SessionTable';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import { CardSkeleton, StatGridSkeleton } from '@/components/common/ui/Skeletons';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import CollapsibleInfo from '@/components/layout/CollapsibleInfo';
import { buildDailyTrendRows } from '@/components/tracing/health/dailyTrend';
import { formatHealthCount } from '@/components/tracing/health/healthFormat';
import {
  buildDashboardDateSearchParams,
  dashboardDateFilterKey,
} from '@/lib/utils/dashboardDateFilter';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  resolveStatusColor,
  calcCacheHitRate,
} from '@/lib/utils/tracingUtils';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { AgentTracingAgentSummary, DashboardOverview } from '@/lib/services/agentTracing';

type DashboardData = DashboardOverview;

export default function AgentTracingPage() {
  const router = useRouter();
  const t = useTranslations('tracings');
  const th = useTranslations('tracingHealth');
  const tNav = useTranslations('navigation');
  const locale = useLocale();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(
    null,
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const filterKey = dashboardDateFilterKey(dateFilter);

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const fetchDashboard = useCallback(async (signal: AbortSignal) => {
    try {
      // The first load shows skeletons; later ones (filter change, refresh) keep the page in place.
      setRefreshing(true);
      setError(null);

      const params = buildDashboardDateSearchParams(dateFilter);
      params.append('timezone', timezone);

      const response = await fetch(`/api/tracing/dashboard?${params}`, { signal });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: unknown };
        console.error('Dashboard fetch error:', errorData);
        throw new Error(typeof errorData.error === 'string' ? errorData.error : th('overview.loadError'));
      }

      const data = (await response.json()) as DashboardData;
      if (!signal.aborted) setDashboardData(data);
    } catch (fetchError) {
      if (signal.aborted || (fetchError instanceof DOMException && fetchError.name === 'AbortError')) {
        return;
      }
      console.error('Error fetching dashboard:', fetchError);
      setError(fetchError instanceof Error && fetchError.message ? fetchError.message : th('overview.loadError'));
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
    // `filterKey` stands for `dateFilter`: the filter object is replaced on every URL change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, timezone, th]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDashboard(controller.signal);
    return () => controller.abort();
  }, [fetchDashboard, refreshKey]);

  const handleRowClick = (sessionId: string) => {
    if (!sessionId) return;
    router.push(`/dashboard/tracing/sessions/${encodeURIComponent(sessionId)}`);
  };

  const handleShowAllSessions = (agentFilter?: string) => {
    if (agentFilter) {
      router.push(
        `/dashboard/tracing/sessions?agent=${encodeURIComponent(agentFilter)}`,
      );
    } else {
      router.push('/dashboard/tracing/sessions');
    }
  };

  const header = (
    <PageHeader
      eyebrow={th('eyebrow')}
      title={tNav('agentTracing')}
      subtitle={t('list.subtitle')}
      actions={
        <>
          <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
          <Button
            variant="default"
            size="sm"
            onClick={() => setRefreshKey((key) => key + 1)}
            loading={refreshing}
            leftSection={<IconRefresh size={14} stroke={1.7} />}>
            {th('overview.refresh')}
          </Button>
        </>
      }
    />
  );

  if (loading && !dashboardData) {
    return (
      <PageContainer>
        {header}
        <StatGridSkeleton count={4} delta />
        <CardSkeleton blockHeight={220} lines={0} />
        <CardSkeleton blockHeight={160} lines={0} />
      </PageContainer>
    );
  }

  const recentAgentsTotal = dashboardData?.recentAgentsTotal || 0;
  const recentSessions = dashboardData?.recentSessions || [];
  const analytics = dashboardData?.analytics;
  const totals = analytics?.totals || {
    sessionsCount: 0,
    totalTokens: 0,
    totalEvents: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    averageTokensPerSession: 0,
    averageDurationMs: 0,
    totalDurationMs: 0,
  };
  const toolTotals = analytics?.tools?.totals || {
    totalCalls: 0,
    errorCalls: 0,
    errorRate: 0,
  };
  const toolItems = analytics?.tools?.items || [];
  const agentAnalytics = analytics?.agents || [];
  const trendRows = buildDailyTrendRows(analytics?.daily, locale);
  const errorRateHigh = toolTotals.errorRate > 0.1;

  return (
    <PageContainer>
      {/* Header */}
      {header}

      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" title={th('overview.loadError')}>
          <div className="ds-row-between" style={{ gap: 12 }}>
            <Text size="sm">{error}</Text>
            <Button size="xs" variant="default" onClick={() => setRefreshKey((key) => key + 1)}>
              {th('common.retry')}
            </Button>
          </div>
        </Alert>
      )}

      {/* Stat tiles */}
      <div className="ds-stat-grid" aria-busy={refreshing}>
        <StatTile
          label={th('overview.tiles.totalSessions')}
          icon={<IconActivity size={14} stroke={1.7} />}
          value={formatNumber(totals.sessionsCount)}
          delta={th('overview.tiles.activeAgents', { count: formatNumber(recentAgentsTotal) })}
        />
        <StatTile
          label={th('overview.tiles.totalTokens')}
          icon={<IconCpu size={14} stroke={1.7} />}
          value={formatNumber(totals.totalTokens)}
          delta={th('overview.tiles.avgPerSession', { count: formatNumber(totals.averageTokensPerSession) })}
        />
        <StatTile
          label={th('overview.tiles.totalEvents')}
          icon={<IconMessage size={14} stroke={1.7} />}
          value={formatNumber(totals.totalEvents)}
          delta={th('overview.tiles.avgDuration', { duration: formatDuration(totals.averageDurationMs) })}
        />
        <StatTile
          label={th('overview.tiles.toolErrorRate')}
          icon={<IconAlertTriangle size={14} stroke={1.7} />}
          value={
            <span style={{ color: errorRateHigh ? 'var(--ds-err)' : 'var(--ds-ok)' }}>
              {formatPercent(toolTotals.errorRate)}
            </span>
          }
          delta={th('overview.tiles.totalCalls', { count: formatNumber(toolTotals.totalCalls) })}
        />
        {totals.totalCachedInputTokens > 0 && (
          <StatTile
            label={th('overview.tiles.cacheHit')}
            icon={<IconDatabase size={14} stroke={1.7} />}
            value={formatPercent(calcCacheHitRate(totals.totalInputTokens, totals.totalCachedInputTokens))}
            delta={th('overview.tiles.cachedTokens', { count: formatNumber(totals.totalCachedInputTokens) })}
          />
        )}
      </div>

      {/* Quick Start Info Card */}
      <CollapsibleInfo
        title={th('overview.quickStart.title')}
        action={
          <Button
            variant="light"
            color="teal"
            size="xs"
            component="a"
            href="https://www.npmjs.com/package/@cognipeer/agent-sdk"
            target="_blank"
            rightSection={<IconExternalLink size={12} />}
          >
            {th('overview.quickStart.viewSdk')}
          </Button>
        }
      >
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            {th('overview.quickStart.install')}{' '}
            <Anchor
              href="https://www.npmjs.com/package/@cognipeer/agent-sdk"
              target="_blank"
              rel="noopener noreferrer"
              size="xs"
            >
              @cognipeer/agent-sdk
            </Anchor>{' '}
            {th('overview.quickStart.installRest')}
          </Text>
          <Text size="xs" c="dimmed">
            {th('overview.quickStart.http')}{' '}
            <Anchor component={Link} href="/dashboard/tokens" size="xs">{th('overview.quickStart.tokensLink')}</Anchor>{' '}
            {th('overview.quickStart.httpMid')}{' '}
            <span className="ds-mono" style={{ background: 'var(--ds-surface-raised)', padding: '1px 4px', borderRadius: 3 }}>
              /api/client/v1/tracing/sessions
            </span>
          </Text>
        </Stack>
      </CollapsibleInfo>

      {/* Analytics Section */}
      <div className="ds-card ds-card-pad-lg" aria-busy={refreshing} style={{ opacity: refreshing ? 0.7 : 1 }}>
        <div style={{ marginBottom: 16 }}>
          <div className="ds-h3">{th('overview.analytics.title')}</div>
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            {th('overview.analytics.subtitle')}
          </div>
        </div>

        {/* Daily trend */}
        <div className="ds-h4" style={{ marginBottom: 10 }}>{th('overview.analytics.trendTitle')}</div>
        {trendRows.length > 1 ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 14,
              marginBottom: 18,
            }}
          >
            <div role="img" aria-label={th('overview.analytics.trendSessions')}>
              <div className="ds-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {th('overview.analytics.trendSessions')}
              </div>
              <AreaChart
                h={180}
                data={trendRows}
                dataKey="day"
                series={[{ name: 'sessions', label: th('overview.analytics.series.sessions'), color: 'teal.6' }]}
                curveType="monotone"
                connectNulls={false}
                withDots={trendRows.length <= 31}
                gridAxis="x"
                tickLine="x"
                valueFormatter={(value) => formatHealthCount(value, locale)}
              />
            </div>
            <div role="img" aria-label={th('overview.analytics.trendTokens')}>
              <div className="ds-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {th('overview.analytics.trendTokens')}
              </div>
              <AreaChart
                h={180}
                data={trendRows}
                dataKey="day"
                series={[{ name: 'tokens', label: th('overview.analytics.series.tokens'), color: 'blue.6' }]}
                curveType="monotone"
                connectNulls={false}
                withDots={trendRows.length <= 31}
                gridAxis="x"
                tickLine="x"
                valueFormatter={(value) => formatHealthCount(value, locale)}
              />
            </div>
          </div>
        ) : (
          <div className="ds-empty" style={{ padding: 24, marginBottom: 18 }}>
            <span className="ds-muted" style={{ fontSize: 13 }}>
              {th('overview.analytics.trendEmpty')}
            </span>
          </div>
        )}

        {/* Status, Models, Tools Breakdown */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: 14,
          }}
        >
          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconChartBar size={16} />
              </ThemeIcon>
              <div className="ds-h4">{th('overview.analytics.statusBreakdown')}</div>
            </Group>
            <Stack gap={8}>
              {(analytics?.statuses || []).map((item) => (
                <Group key={item.status} justify="space-between">
                  <Badge size="sm" variant="light" radius="xl" color={resolveStatusColor(item.status)}>
                    {(item.status || th('common.unknown')).toUpperCase()}
                  </Badge>
                  <Text size="sm" fw={500}>{formatNumber(item.count)}</Text>
                </Group>
              ))}
              {(analytics?.statuses || []).length === 0 && (
                <Text size="sm" c="dimmed">
                  {th('overview.analytics.noStatus')}
                </Text>
              )}
            </Stack>
          </div>
          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconCpu size={16} />
              </ThemeIcon>
              <div className="ds-h4">{th('overview.analytics.topModels')}</div>
            </Group>
            <Stack gap={8}>
              {(analytics?.models || []).slice(0, 6).map((item) => (
                <Group key={item.model} justify="space-between">
                  <Text size="sm" lineClamp={1}>
                    {item.model}
                  </Text>
                  <Badge size="sm" variant="light" color="grape">
                    {formatNumber(item.sessionsCount)}
                  </Badge>
                </Group>
              ))}
              {(analytics?.models || []).length === 0 && (
                <Text size="sm" c="dimmed">
                  {th('overview.analytics.noModels')}
                </Text>
              )}
            </Stack>
          </div>
          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="orange">
                <IconPlug size={16} />
              </ThemeIcon>
              <div className="ds-h4">{th('overview.analytics.toolSummary')}</div>
            </Group>
            <Stack gap={8}>
              {toolItems.slice(0, 6).map((item) => (
                <Group
                  key={item.toolName}
                  justify="space-between"
                  align="center">
                  <Stack gap={0}>
                    <Text size="sm" fw={500}>
                      {item.toolName}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {th('overview.analytics.callsAndErrors', {
                        calls: formatNumber(item.totalCalls),
                        errors: formatNumber(item.errorCalls),
                      })}
                    </Text>
                  </Stack>
                  <Badge
                    size="sm"
                    variant="light"
                    color={item.errorRate && item.errorRate > 0.1 ? 'red' : 'green'}>
                    {formatPercent(item.errorRate)}
                  </Badge>
                </Group>
              ))}
              {toolItems.length === 0 && (
                <Text size="sm" c="dimmed">
                  {th('overview.analytics.noTools')}
                </Text>
              )}
            </Stack>
          </div>

          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="blue">
                <IconRobot size={16} />
              </ThemeIcon>
              <div className="ds-h4">{th('overview.analytics.topConsumers')}</div>
            </Group>
            <Stack gap={8}>
              {agentAnalytics.slice(0, 6).map((item: AgentTracingAgentSummary) => (
                <Group key={item.name} justify="space-between" align="center">
                  <Stack gap={0}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {item.label || item.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {th('overview.analytics.consumerLine', {
                        sessions: formatNumber(item.sessionsCount),
                        tokens: formatNumber(item.averageTokensPerSession),
                      })}
                    </Text>
                  </Stack>
                  <Badge size="sm" variant="light" color="blue">
                    {formatNumber(item.totalTokens)}
                  </Badge>
                </Group>
              ))}
              {agentAnalytics.length === 0 && (
                <Text size="sm" c="dimmed">
                  {th('overview.analytics.noConsumers')}
                </Text>
              )}
            </Stack>
          </div>
        </div>
      </div>

      {/* Recent Sessions — agents themselves live in the left sub-nav */}
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-row-between" style={{ marginBottom: 16 }}>
          <div>
            <div className="ds-h3">{th('overview.recent.title')}</div>
            <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              {th('overview.recent.subtitle')}
            </div>
          </div>
          <Group gap="xs">
            <Button
              variant="light"
              onClick={() => router.push('/dashboard/tracing/threads')}
              rightSection={<IconArrowUpRight size={14} />}>
              {th('overview.recent.browseThreads')}
            </Button>
            <Button
              variant="light"
              onClick={() => handleShowAllSessions()}
              rightSection={<IconArrowUpRight size={14} />}>
              {th('overview.recent.showAll')}
            </Button>
          </Group>
        </div>

        <SessionTable
          sessions={recentSessions}
          onRowClick={(sessionId) => handleRowClick(sessionId)}
          onThreadClick={(threadId) => router.push(`/dashboard/tracing/threads/${threadId}`)}
          loading={loading}
        />
      </div>
    </PageContainer>
  );
}
