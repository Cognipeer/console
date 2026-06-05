'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Stack,
  Group,
  Text,
  Button,
  Loader,
  Center,
  Badge,
  Table,
  Anchor,
  ThemeIcon,
  Box,
} from '@mantine/core';
import {
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
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import SessionTable from '@/components/tracing/SessionTable';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import CollapsibleInfo from '@/components/layout/CollapsibleInfo';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  resolveStatusColor,
} from '@/lib/utils/tracingUtils';
import { useTranslations } from '@/lib/i18n';
import type { AgentTracingAgentSummary, DashboardOverview } from '@/lib/services/agentTracing';

dayjs.extend(relativeTime);

type DashboardData = DashboardOverview;

export default function AgentTracingPage() {
  const router = useRouter();
  const t = useTranslations('tracings');
  const tNav = useTranslations('navigation');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(
    null,
  );
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const fetchDashboard = useCallback(async (isRefresh = false, signal?: AbortSignal) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const params = buildDashboardDateSearchParams(dateFilter);
      params.append('timezone', timezone);

      const response = await fetch(`/api/tracing/dashboard?${params}`, { signal });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Dashboard fetch error:', errorData);
        throw new Error(errorData.error || 'Failed to fetch dashboard data');
      }

      const data = (await response.json()) as DashboardData;
      setDashboardData(data);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      console.error('Error fetching dashboard:', error);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [dateFilter, timezone]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDashboard(false, controller.signal);
    return () => controller.abort();
  }, [fetchDashboard]);

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

  const handleAgentClick = (agentName: string) => {
    router.push(`/dashboard/tracing/agents/${encodeURIComponent(agentName)}`);
  };

  if (loading) {
    return (
      <Center h={400}>
        <Loader size="lg" color="teal" />
      </Center>
    );
  }

  const recentAgents = dashboardData?.recentAgents || [];
  const recentAgentsTotal = dashboardData?.recentAgentsTotal || 0;
  const recentSessions = dashboardData?.recentSessions || [];
  const analytics = dashboardData?.analytics;
  const totals = analytics?.totals || {
    sessionsCount: 0,
    totalTokens: 0,
    totalEvents: 0,
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
  const dailyRows = (analytics?.daily || []).slice(-7);
  const errorRateHigh = toolTotals.errorRate > 0.1;

  return (
    <PageContainer>
      {/* Header */}
      <PageHeader
        eyebrow="Operate · Tracing"
        title={tNav('agentTracing')}
        subtitle={t('list.subtitle')}
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="default"
              size="sm"
              onClick={() => fetchDashboard(true)}
              loading={refreshing}
              leftSection={<IconRefresh size={14} stroke={1.7} />}>
              Refresh
            </Button>
          </>
        }
      />

      {/* Stat tiles */}
      <div className="ds-stat-grid">
        <StatTile
          label="Total Sessions"
          icon={<IconActivity size={14} stroke={1.7} />}
          value={formatNumber(totals.sessionsCount)}
          delta={`Active agents: ${formatNumber(recentAgentsTotal)}`}
        />
        <StatTile
          label="Total Tokens"
          icon={<IconCpu size={14} stroke={1.7} />}
          value={formatNumber(totals.totalTokens)}
          delta={`Avg: ${formatNumber(totals.averageTokensPerSession)}/session`}
        />
        <StatTile
          label="Total Events"
          icon={<IconMessage size={14} stroke={1.7} />}
          value={formatNumber(totals.totalEvents)}
          delta={`Avg duration: ${formatDuration(totals.averageDurationMs)}`}
        />
        <StatTile
          label="Tool Error Rate"
          icon={<IconAlertTriangle size={14} stroke={1.7} />}
          value={
            <span style={{ color: errorRateHigh ? 'var(--ds-err)' : 'var(--ds-ok)' }}>
              {formatPercent(toolTotals.errorRate)}
            </span>
          }
          delta={`${formatNumber(toolTotals.totalCalls)} total calls`}
        />
      </div>

      {/* Quick Start Info Card */}
      <CollapsibleInfo
        title="Instrument your agents quickly"
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
            View SDK
          </Button>
        }
      >
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Install{' '}
            <Anchor
              href="https://www.npmjs.com/package/@cognipeer/agent-sdk"
              target="_blank"
              rel="noopener noreferrer"
              size="xs"
            >
              @cognipeer/agent-sdk
            </Anchor>{' '}
            to instrument your Node.js agent in minutes. The SDK automatically
            creates sessions, events, and payload timelines.
          </Text>
          <Text size="xs" c="dimmed">
            Prefer HTTP? Generate an API key under{' '}
            <Anchor href="/dashboard/tokens" size="xs">API Tokens</Anchor>{' '}
            and POST your agent payloads to{' '}
            <span className="ds-mono" style={{ background: 'var(--ds-surface-raised)', padding: '1px 4px', borderRadius: 3 }}>
              /api/client/tracing/sessions
            </span>
          </Text>
        </Stack>
      </CollapsibleInfo>

      {/* Analytics Section */}
      <div className="ds-card ds-card-pad-lg">
        <div style={{ marginBottom: 16 }}>
          <div className="ds-h3">Workspace Analytics</div>
          <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
            Usage summaries across all agents
          </div>
        </div>

        {/* Daily Trend */}
        <div className="ds-h4" style={{ marginBottom: 10 }}>Recent Trend (Last 7 Days)</div>
        <div className="ds-tbl-wrap" style={{ marginBottom: 18 }}>
          <table className="ds-tbl">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Sessions</th>
                <th style={{ textAlign: 'right' }}>Events</th>
                <th style={{ textAlign: 'right' }}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {dailyRows.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <div className="ds-empty" style={{ padding: 24 }}>
                      <span className="ds-muted" style={{ fontSize: 13 }}>
                        No activity in the selected range.
                      </span>
                    </div>
                  </td>
                </tr>
              ) : (
                dailyRows.map((row) => (
                  <tr key={row.date}>
                    <td style={{ fontSize: 12.5, fontWeight: 500 }}>
                      {dayjs(row.date).format('MMM D, YYYY')}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        textAlign: 'right',
                        fontSize: 12.5,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatNumber(row.sessionsCount)}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        textAlign: 'right',
                        fontSize: 12.5,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatNumber(row.totalEvents)}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        textAlign: 'right',
                        fontSize: 12.5,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatNumber(row.totalTokens)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

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
              <div className="ds-h4">Status Breakdown</div>
            </Group>
            <Stack gap={8}>
              {(analytics?.statuses || []).map((item) => (
                <Group key={item.status} justify="space-between">
                  <Badge size="sm" variant="light" radius="xl" color={resolveStatusColor(item.status)}>
                    {(item.status || 'Unknown').toUpperCase()}
                  </Badge>
                  <Text size="sm" fw={500}>{formatNumber(item.count)}</Text>
                </Group>
              ))}
              {(analytics?.statuses || []).length === 0 && (
                <Text size="sm" c="dimmed">
                  No status data available.
                </Text>
              )}
            </Stack>
          </div>
          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconCpu size={16} />
              </ThemeIcon>
              <div className="ds-h4">Top Models</div>
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
                  No model usage captured.
                </Text>
              )}
            </Stack>
          </div>
          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="orange">
                <IconPlug size={16} />
              </ThemeIcon>
              <div className="ds-h4">Tool Summary</div>
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
                      {formatNumber(item.totalCalls)} calls ·{' '}
                      {formatNumber(item.errorCalls)} errors
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
                  No tool calls recorded.
                </Text>
              )}
            </Stack>
          </div>

          <div className="ds-card ds-card-pad">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="blue">
                <IconRobot size={16} />
              </ThemeIcon>
              <div className="ds-h4">Top Token Consumers</div>
            </Group>
            <Stack gap={8}>
              {agentAnalytics.slice(0, 6).map((item: AgentTracingAgentSummary) => (
                <Group key={item.name} justify="space-between" align="center">
                  <Stack gap={0}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {item.label || item.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatNumber(item.sessionsCount)} sessions · avg {formatNumber(item.averageTokensPerSession)} tokens
                    </Text>
                  </Stack>
                  <Badge size="sm" variant="light" color="blue">
                    {formatNumber(item.totalTokens)}
                  </Badge>
                </Group>
              ))}
              {agentAnalytics.length === 0 && (
                <Text size="sm" c="dimmed">
                  No agent-level token data available.
                </Text>
              )}
            </Stack>
          </div>
        </div>
      </div>

      {/* Recent Agents */}
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-row-between" style={{ marginBottom: 16 }}>
          <div>
            <Group gap="sm">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconRobot size={18} />
              </ThemeIcon>
              <div>
                <div className="ds-h3">Recently Active Agents</div>
                <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  Showing up to {recentAgents.length} agents by recent activity
                </div>
              </div>
            </Group>
          </div>
          <StatusBadge status="info" label={`${formatNumber(recentAgentsTotal)} total`} withDot={false} />
        </div>

        {recentAgents.length === 0 ? (
          <Center py="xl">
            <Stack gap="md" align="center">
              <ThemeIcon size={60} radius="xl" variant="light" color="gray">
                <IconRobot size={30} />
              </ThemeIcon>
              <Text size="sm" c="dimmed">No agents have reported activity yet.</Text>
            </Stack>
          </Center>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 14,
            }}
          >
            {recentAgents.map((item) => {
              const statusColor = resolveStatusColor(item.latestStatus);
              return (
                <div
                  key={item.name}
                  className="ds-card ds-card-pad"
                  style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleAgentClick(item.name)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleAgentClick(item.name);
                    }
                  }}>

                  <Stack gap={8}>
                    <Group justify="space-between" align="center">
                      <Group gap="sm">
                        <ThemeIcon size={32} radius="md" variant="light" color="teal">
                          <IconRobot size={16} />
                        </ThemeIcon>
                        <Text fw={600} lineClamp={1}>
                          {item.label || item.name}
                        </Text>
                      </Group>
                      {item.latestStatus && (
                        <Badge size="sm" variant="light" radius="xl" color={statusColor}>
                          {item.latestStatus.toUpperCase()}
                        </Badge>
                      )}
                    </Group>
                    <Stack gap={4}>
                      <Group gap="lg" wrap="wrap">
                        <Text size="xs" c="dimmed">
                          <Text component="span" fw={500} c="dark">{formatNumber(item.sessionsCount)}</Text> sessions
                        </Text>
                        {item.latestSessionAt && (
                          <Text size="xs" c="dimmed">
                            Last: {dayjs(item.latestSessionAt).fromNow()}
                          </Text>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        <Text component="span" fw={500} c="dark">{formatNumber(item.totalTokens)}</Text> tokens · avg {formatNumber(item.averageTokensPerSession)}/session
                      </Text>
                    </Stack>
                  </Stack>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Sessions */}
      <div className="ds-card ds-card-pad-lg">
        <div className="ds-row-between" style={{ marginBottom: 16 }}>
          <div>
            <div className="ds-h3">Recent Sessions</div>
            <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
              Latest agent execution sessions
            </div>
          </div>
          <Group gap="xs">
            <Button
              variant="light"
              onClick={() => router.push('/dashboard/tracing/threads')}
              rightSection={<IconArrowUpRight size={14} />}>
              Browse Threads
            </Button>
            <Button
              variant="light"
              onClick={() => handleShowAllSessions()}
              rightSection={<IconArrowUpRight size={14} />}>
              Show All Sessions
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
