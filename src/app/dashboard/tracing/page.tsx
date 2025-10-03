'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  Stack,
  Group,
  Text,
  Button,
  SimpleGrid,
  Paper,
  Loader,
  Center,
  Badge,
  Divider,
  Table,
  ScrollArea,
  Anchor,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconCalendar,
  IconInfoCircle,
  IconPlug,
  IconRefresh,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import SessionTable from '@/components/tracing/SessionTable';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  resolveStatusColor,
} from '@/lib/utils/tracingUtils';
import Link from 'next/link';
import { useTranslations } from '@/lib/i18n';

dayjs.extend(relativeTime);

interface DashboardData {
  recentSessions: any[];
  recentAgents: any[];
  recentAgentsTotal: number;
  analytics: {
    totals: {
      sessionsCount: number;
      totalTokens: number;
      totalEvents: number;
      averageTokensPerSession: number;
      averageDurationMs: number;
      totalDurationMs: number;
    };
    tools: {
      totals: {
        totalCalls: number;
        errorCalls: number;
        errorRate: number;
      };
      items: Array<{
        toolName: string;
        totalCalls: number;
        errorCalls: number;
        errorRate: number;
      }>;
    };
    statuses: Array<{ status: string; count: number }>;
    models: Array<{ model: string; sessionsCount: number }>;
    versions: Array<{ version: string; sessionsCount: number }>;
    daily: Array<{
      date: string;
      sessionsCount: number;
      totalEvents: number;
      totalTokens: number;
    }>;
  };
}

export default function AgentTracingPage() {
  const router = useRouter();
  const t = useTranslations('tracings');
  const tNav = useTranslations('navigation');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(
    null,
  );
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([
    null,
    null,
  ]);

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const rangeParams = useMemo(() => {
    const [start, end] = dateRange || [];
    return {
      from: start ? dayjs(start).startOf('day').toISOString() : undefined,
      to: end ? dayjs(end).endOf('day').toISOString() : undefined,
    };
  }, [dateRange]);

  const fetchDashboard = async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const params = new URLSearchParams();
      if (rangeParams.from) params.append('from', rangeParams.from);
      if (rangeParams.to) params.append('to', rangeParams.to);
      params.append('timezone', timezone);

      const response = await fetch(`/api/tracing/dashboard?${params}`);

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Dashboard fetch error:', errorData);
        throw new Error(errorData.error || 'Failed to fetch dashboard data');
      }

      const data = await response.json();
      console.log('Dashboard data:', data);
      setDashboardData(data);
    } catch (error) {
      console.error('Error fetching dashboard:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, [rangeParams.from, rangeParams.to, timezone]);

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
        <Loader size="lg" />
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
  const dailyRows = (analytics?.daily || []).slice(-7);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>{tNav('agentTracing')}</Title>
          <Text size="sm" c="dimmed" mt={4}>
            {t('list.subtitle')}
          </Text>
        </div>
      </Group>

      {/* Info Card */}
      <Card withBorder shadow="sm" p="md">
        <Group align="flex-start" gap="sm">
          <IconInfoCircle
            size={20}
            color="var(--mantine-color-blue-6)"
            style={{ marginTop: 4 }}
          />
          <Stack gap={6}>
            <Text fw={600}>Instrument your agents quickly</Text>
            <Text size="sm" c="dimmed">
              Install{' '}
              <Anchor
                href="https://www.npmjs.com/package/@cognipeer/agent-sdk"
                target="_blank"
                rel="noopener noreferrer">
                @cognipeer/agent-sdk
              </Anchor>{' '}
              to instrument your Node.js agent in minutes. The SDK automatically
              creates sessions, events, and payload timelines.
            </Text>
            <Text size="sm" c="dimmed">
              Prefer HTTP? Generate an API key under{' '}
              <Anchor href="/dashboard/settings">Settings → API Tokens</Anchor>{' '}
              and POST your agent payloads to{' '}
              <Text component="span" ff="monospace">
                /api/client/tracing/sessions
              </Text>{' '}
              to stream tracing data from any stack.
            </Text>
          </Stack>
        </Group>
      </Card>

      {/* Analytics Card */}
      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div>
              <Text fw={600}>Workspace Analytics</Text>
              <Text size="sm" c="dimmed">
                Usage summaries across all agents
              </Text>
            </div>
            <Group gap="sm" align="flex-end">
              <DatePickerInput
                type="range"
                value={dateRange}
                clearable
                onChange={(value) =>
                  setDateRange(value as [Date | null, Date | null])
                }
                label="Date range"
                w={260}
                placeholder="Select Date Range"
                valueFormat="MMM D, YYYY"
                leftSection={<IconCalendar size={16} stroke={1.5} />}
              />
              <Button
                variant="light"
                color="blue"
                onClick={() => fetchDashboard(true)}
                loading={refreshing}
                leftSection={<IconRefresh size={16} />}>
                Refresh
              </Button>
            </Group>
          </Group>

          {/* Metrics Grid */}
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Total Sessions
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(totals.sessionsCount)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Total Tokens
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(totals.totalTokens)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Avg per session: {formatNumber(totals.averageTokensPerSession)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Total Events
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(totals.totalEvents)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Avg duration: {formatDuration(totals.averageDurationMs)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Tool Error Rate
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatPercent(toolTotals.errorRate)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Total calls: {formatNumber(toolTotals.totalCalls)}
              </Text>
            </Paper>
          </SimpleGrid>

          {/* Daily Trend */}
          <Divider label="Recent trend (last 7 days)" labelPosition="center" />
          <ScrollArea>
            <Table striped highlightOnHover withColumnBorders>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Sessions</Table.Th>
                  <Table.Th>Events</Table.Th>
                  <Table.Th>Tokens</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {dailyRows.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Center c="dimmed" py="sm">
                        No activity in the selected range.
                      </Center>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  dailyRows.map((row) => (
                    <Table.Tr key={row.date}>
                      <Table.Td>
                        {dayjs(row.date).format('MMM D, YYYY')}
                      </Table.Td>
                      <Table.Td>{formatNumber(row.sessionsCount)}</Table.Td>
                      <Table.Td>{formatNumber(row.totalEvents)}</Table.Td>
                      <Table.Td>{formatNumber(row.totalTokens)}</Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>

          {/* Status, Models, Tools Breakdown */}
          <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">
                Status Breakdown
              </Text>
              <Stack gap={6}>
                {(analytics?.statuses || []).map((item) => (
                  <Group key={item.status} justify="space-between">
                    <Text size="sm">{item.status || 'Unknown'}</Text>
                    <Badge size="sm" color="blue">
                      {formatNumber(item.count)}
                    </Badge>
                  </Group>
                ))}
                {(analytics?.statuses || []).length === 0 && (
                  <Text size="sm" c="dimmed">
                    No status data available.
                  </Text>
                )}
              </Stack>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">
                Top Models
              </Text>
              <Stack gap={6}>
                {(analytics?.models || []).slice(0, 6).map((item) => (
                  <Group key={item.model} justify="space-between">
                    <Text size="sm" lineClamp={1}>
                      {item.model}
                    </Text>
                    <Badge size="sm" color="grape">
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
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text fw={600} mb="sm">
                Tool Summary
              </Text>
              <Stack gap={6}>
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
                      color={
                        item.errorRate && item.errorRate > 0.1 ? 'red' : 'green'
                      }>
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
            </Paper>
          </SimpleGrid>
        </Stack>
      </Card>

      {/* Recent Agents */}
      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Stack gap={0}>
              <Text fw={600}>Recently Active Agents</Text>
              <Text size="sm" c="dimmed">
                Showing up to {recentAgents.length} agents by recent activity
              </Text>
            </Stack>
            <Text size="xs" c="dimmed">
              Total tracked: {formatNumber(recentAgentsTotal)}
            </Text>
          </Group>

          {recentAgents.length === 0 ? (
            <Center h={160} c="dimmed">
              No agents have reported activity yet.
            </Center>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
              {recentAgents.map((item: any) => {
                const statusColor = resolveStatusColor(item.latestStatus);
                return (
                  <Card
                    key={item.name}
                    withBorder
                    shadow="xs"
                    radius="md"
                    p="md">
                    <Stack gap={8}>
                      <Group justify="space-between" align="center">
                        <Text fw={600} lineClamp={1}>
                          {item.label || item.name}
                        </Text>
                        {item.latestStatus && (
                          <Badge size="sm" color={statusColor}>
                            {item.latestStatus}
                          </Badge>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {formatNumber(item.sessionsCount)} sessions
                      </Text>
                      {item.latestSessionAt && (
                        <Text size="xs" c="dimmed">
                          Last session {dayjs(item.latestSessionAt).fromNow()}
                        </Text>
                      )}
                      <Button
                        variant="light"
                        onClick={() => handleAgentClick(item.name)}>
                        View Agent Details
                      </Button>
                    </Stack>
                  </Card>
                );
              })}
            </SimpleGrid>
          )}
        </Stack>
      </Card>

      {/* Recent Sessions */}
      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Text fw={600}>Recent Sessions</Text>
            <Button variant="light" onClick={() => handleShowAllSessions()}>
              Show All Sessions
            </Button>
          </Group>

          <SessionTable
            sessions={recentSessions}
            onRowClick={(sessionId) => handleRowClick(sessionId)}
            loading={loading}
          />
        </Stack>
      </Card>
    </Stack>
  );
}
