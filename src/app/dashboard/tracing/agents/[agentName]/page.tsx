'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBook,
  IconRefresh,
  IconRobot,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import SessionTable from '@/components/tracing/SessionTable';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  humanize,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

dayjs.extend(relativeTime);

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
  };
}

function statusVariant(status: string | null | undefined): 'ok' | 'warn' | 'err' | 'info' {
  if (!status) return 'info';
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'success' || s === 'ok' || s === 'active') return 'ok';
  if (s === 'failed' || s === 'error' || s === 'err') return 'err';
  if (s === 'warning' || s === 'warn' || s === 'degraded') return 'warn';
  return 'info';
}

export default function AgentTracingAgentPage() {
  const params = useParams<{ agentName: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AgentOverviewResponse | null>(null);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

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

  const fetchOverview = useCallback(async (isRefresh = false) => {
    if (!agentName) return;

    try {
      if (isRefresh) setRefreshing(true);
      setLoading(true);
      setError(null);

      const params = buildDashboardDateSearchParams(dateFilter);
      params.append('timezone', timezone);

      const response = await fetch(`/api/tracing/agents/${encodeURIComponent(agentName)}/overview?${params}`);
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Failed to fetch agent overview');
      }

      const payload = await response.json();
      setData(payload);
    } catch (err: unknown) {
      console.error('Agent overview fetch error:', err);
      const message = err instanceof Error ? err.message : 'Failed to fetch agent overview';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [agentName, dateFilter, timezone]);

  useEffect(() => {
    void fetchOverview();
  }, [fetchOverview]);

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
    return (
      <Center h={400}>
        <Loader size="lg" />
      </Center>
    );
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

  return (
    <DetailShell
      backHref="/dashboard/tracing"
      backLabel="Back to tracing"
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
          {agent?.latestStatus ? (
            <StatusBadge
              status={statusVariant(agent.latestStatus)}
              label={agent.latestStatus.toUpperCase()}
            />
          ) : null}
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
            {formatNumber(agent?.sessionsCount || 0)} sessions tracked
          </span>
          {agent?.latestSessionAt ? (
            <>
              <span className="ds-faint">·</span>
              <span>Last active {dayjs(agent.latestSessionAt).fromNow()}</span>
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
            Docs
          </Button>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => fetchOverview(true)}
            loading={refreshing}
          >
            Refresh
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
          label="Total sessions"
          value={formatNumber(totals.sessionsCount)}
          delta={`All-time: ${formatNumber(agent?.sessionsCount || 0)}`}
        />
        <StatTile
          label="Total events"
          value={formatNumber(totals.totalEvents)}
          delta={`Avg duration: ${formatDuration(totals.averageDurationMs)}`}
        />
        <StatTile
          label="Total tokens"
          value={formatNumber(totals.totalTokens)}
          delta={`Avg per session: ${formatNumber(totals.averageTokensPerSession)}`}
        />
        <StatTile
          label="Tool error rate"
          value={formatPercent(toolTotals.errorRate)}
          delta={`Total calls: ${formatNumber(toolTotals.totalCalls)}`}
        />
      </div>

      {/* Token breakdown */}
      <DetailCard
        title="Token breakdown"
        description="Input, output, and cached input usage for this agent in the selected range."
      >
        <div className="ds-stat-grid">
          <StatTile
            label="Input tokens"
            value={formatNumber(totals.totalInputTokens)}
            delta={`Avg per session: ${formatNumber(totals.averageInputTokensPerSession)}`}
          />
          <StatTile
            label="Output tokens"
            value={formatNumber(totals.totalOutputTokens)}
            delta={`Avg per session: ${formatNumber(totals.averageOutputTokensPerSession)}`}
          />
          <StatTile
            label="Cached input"
            value={formatNumber(totals.totalCachedInputTokens)}
            delta={`Cache share: ${formatPercent(
              totals.totalInputTokens > 0
                ? totals.totalCachedInputTokens / totals.totalInputTokens
                : 0,
            )}`}
          />
        </div>
      </DetailCard>

      {/* Two-column: Status + Versions */}
      <DetailTwoCol>
        <DetailCard
          title="Status breakdown"
          actions={
            <span className="ds-badge">{formatNumber(statusEntriesTotal)}</span>
          }
        >
          {statusEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              No status data available.
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
          title="Versions"
          actions={
            <span className="ds-badge">
              {formatNumber(agent?.versions.length || 0)} versions
            </span>
          }
        >
          {versionEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              No version information yet.
            </Center>
          ) : (
            <Stack gap={6}>
              {versionEntries.map((item) => (
                <Group key={item.version || 'unknown'} justify="space-between">
                  <Text size="sm">{item.version || 'Unknown'}</Text>
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
          title="Top models"
          actions={
            <span className="ds-badge">
              {formatNumber(modelEntries.length)} entries
            </span>
          }
        >
          {modelEntries.length === 0 ? (
            <Center h={120} c="dimmed">
              No model usage recorded.
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
          title="Tool summary"
          actions={
            <span className="ds-badge">
              {formatNumber(toolItems.length)} entries
            </span>
          }
        >
          {toolItems.length === 0 ? (
            <Center h={120} c="dimmed">
              No tool calls recorded.
            </Center>
          ) : (
            <Stack gap={6}>
              {toolItems.slice(0, 10).map((item) => (
                <Group key={item.toolName} justify="space-between" align="center">
                  <Stack gap={0}>
                    <Text size="sm" fw={500}>{item.toolName}</Text>
                    <Text size="xs" c="dimmed">
                      {formatNumber(item.totalCalls)} calls · {formatNumber(item.errorCalls)} errors
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

      {/* Recent trend table */}
      <DetailCard
        title="Recent trend (last 30 days)"
        actions={
          <span className="ds-badge">{formatNumber(dailyRows.length)} days</span>
        }
      >
        <ScrollArea>
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Sessions</Table.Th>
                <Table.Th>Events</Table.Th>
                <Table.Th>Tokens</Table.Th>
                <Table.Th>Avg duration</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {dailyRows.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Center c="dimmed" py="sm">
                      No activity in the selected range.
                    </Center>
                  </Table.Td>
                </Table.Tr>
              ) : (
                dailyRows.map((row) => (
                  <Table.Tr key={row.date}>
                    <Table.Td>{dayjs(row.date).format('MMM D, YYYY')}</Table.Td>
                    <Table.Td>{formatNumber(row.sessionsCount)}</Table.Td>
                    <Table.Td>{formatNumber(row.totalEvents)}</Table.Td>
                    <Table.Td>{formatNumber(row.totalTokens)}</Table.Td>
                    <Table.Td>{formatDuration(row.averageDurationMs)}</Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </DetailCard>

      {/* Recent sessions */}
      <DetailCard
        title="Recent sessions"
        description="Latest runs reported by this agent."
        actions={
          <Button
            variant="light"
            size="xs"
            rightSection={<IconArrowUpRight size={14} />}
            onClick={handleShowAllSessions}
          >
            Show all sessions
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
          Need to instrument another agent? Use the tracing ingestion endpoint at{' '}
          <span className="ds-mono">/api/client/tracing/sessions</span>
          {' '}with your API token from{' '}
          <Anchor href="/dashboard/tokens">API Tokens</Anchor>.
          {' '}See our{' '}
          <Anchor component="button" onClick={() => openDocs('examples-tracing')}>
            LangChain/LangGraph integration examples
          </Anchor>
          {' '}for quick setup.
        </Text>
      </DetailCard>
    </DetailShell>
  );
}
