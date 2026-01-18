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
  ThemeIcon,
  Box,
  Progress,
  RingProgress,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconCalendar,
  IconInfoCircle,
  IconPlug,
  IconRefresh,
  IconActivity,
  IconCpu,
  IconMessage,
  IconAlertTriangle,
  IconRobot,
  IconChartBar,
  IconBook,
  IconExternalLink,
  IconArrowUpRight,
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
  const dailyRows = (analytics?.daily || []).slice(-7);

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}>
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}>
              <IconActivity size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>{tNav('agentTracing')}</Title>
              <Text size="sm" c="dimmed" mt={4}>
                {t('list.subtitle')}
              </Text>
            </div>
          </Group>
          <Group gap="sm">
            <DatePickerInput
              type="range"
              value={dateRange}
              clearable
              onChange={(value) =>
                setDateRange(value as [Date | null, Date | null])
              }
              w={260}
              placeholder="Select Date Range"
              valueFormat="MMM D, YYYY"
              leftSection={<IconCalendar size={16} stroke={1.5} />}
              radius="md"
            />
            <Button
              variant="light"
              onClick={() => fetchDashboard(true)}
              loading={refreshing}
              leftSection={<IconRefresh size={16} />}>
              Refresh
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* Stats Cards */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Sessions
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {formatNumber(totals.sessionsCount)}
              </Text>
              <Text size="xs" c="dimmed">
                Active agents: {formatNumber(recentAgentsTotal)}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconActivity size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Tokens
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="blue">
                {formatNumber(totals.totalTokens)}
              </Text>
              <Text size="xs" c="dimmed">
                Avg: {formatNumber(totals.averageTokensPerSession)}/session
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="blue">
              <IconCpu size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Total Events
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="violet">
                {formatNumber(totals.totalEvents)}
              </Text>
              <Text size="xs" c="dimmed">
                Avg duration: {formatDuration(totals.averageDurationMs)}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="violet">
              <IconMessage size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Tool Error Rate
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c={toolTotals.errorRate > 0.1 ? 'red' : 'green'}>
                {formatPercent(toolTotals.errorRate)}
              </Text>
              <Text size="xs" c="dimmed">
                {formatNumber(toolTotals.totalCalls)} total calls
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color={toolTotals.errorRate > 0.1 ? 'red' : 'green'}>
              <IconAlertTriangle size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Quick Start Info Card */}
      <Paper withBorder radius="lg" p="lg" style={{ background: 'var(--mantine-color-blue-0)', borderColor: 'var(--mantine-color-blue-2)' }}>
        <Group align="flex-start" gap="md">
          <ThemeIcon size={40} radius="md" variant="light" color="blue">
            <IconInfoCircle size={20} />
          </ThemeIcon>
          <Stack gap={6} style={{ flex: 1 }}>
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
              <Text component="span" ff="monospace" style={{ backgroundColor: 'var(--mantine-color-gray-1)', padding: '2px 6px', borderRadius: 4 }}>
                /api/client/tracing/sessions
              </Text>
            </Text>
          </Stack>
          <Button 
            variant="light" 
            color="blue" 
            component="a" 
            href="https://www.npmjs.com/package/@cognipeer/agent-sdk" 
            target="_blank"
            rightSection={<IconExternalLink size={14} />}>
            View SDK
          </Button>
        </Group>
      </Paper>

      {/* Analytics Section */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="lg">
          <div>
            <Text fw={600} size="lg">Workspace Analytics</Text>
            <Text size="sm" c="dimmed">Usage summaries across all agents</Text>
          </div>
        </Group>

        {/* Daily Trend */}
        <Text fw={600} size="sm" mb="sm">Recent Trend (Last 7 Days)</Text>
        <Box mb="lg" style={{ borderRadius: 'var(--mantine-radius-md)', overflow: 'hidden' }}>
          <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
            <Table.Thead style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
              <Table.Tr>
                <Table.Th style={{ fontWeight: 600 }}>Date</Table.Th>
                <Table.Th style={{ fontWeight: 600 }}>Sessions</Table.Th>
                <Table.Th style={{ fontWeight: 600 }}>Events</Table.Th>
                <Table.Th style={{ fontWeight: 600 }}>Tokens</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {dailyRows.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Center c="dimmed" py="lg">
                      No activity in the selected range.
                    </Center>
                  </Table.Td>
                </Table.Tr>
              ) : (
                dailyRows.map((row) => (
                  <Table.Tr key={row.date}>
                    <Table.Td>
                      <Text size="sm" fw={500}>{dayjs(row.date).format('MMM D, YYYY')}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="teal" size="md">{formatNumber(row.sessionsCount)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="violet" size="md">{formatNumber(row.totalEvents)}</Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="blue" size="md">{formatNumber(row.totalTokens)}</Badge>
                    </Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </Box>

        {/* Status, Models, Tools Breakdown */}
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="md">
          <Paper withBorder p="md" radius="lg">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="blue">
                <IconChartBar size={16} />
              </ThemeIcon>
              <Text fw={600}>Status Breakdown</Text>
            </Group>
            <Stack gap={8}>
              {(analytics?.statuses || []).map((item) => (
                <Group key={item.status} justify="space-between">
                  <Text size="sm">{item.status || 'Unknown'}</Text>
                  <Badge size="sm" variant="light" color={resolveStatusColor(item.status)}>
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
          <Paper withBorder p="md" radius="lg">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="grape">
                <IconCpu size={16} />
              </ThemeIcon>
              <Text fw={600}>Top Models</Text>
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
          </Paper>
          <Paper withBorder p="md" radius="lg">
            <Group gap="sm" mb="md">
              <ThemeIcon size={32} radius="md" variant="light" color="orange">
                <IconPlug size={16} />
              </ThemeIcon>
              <Text fw={600}>Tool Summary</Text>
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
          </Paper>
        </SimpleGrid>
      </Paper>

      {/* Recent Agents */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" align="center" mb="md">
          <div>
            <Group gap="sm">
              <ThemeIcon size={32} radius="md" variant="light" color="teal">
                <IconRobot size={18} />
              </ThemeIcon>
              <div>
                <Text fw={600} size="lg">Recently Active Agents</Text>
                <Text size="sm" c="dimmed">
                  Showing up to {recentAgents.length} agents by recent activity
                </Text>
              </div>
            </Group>
          </div>
          <Badge size="lg" variant="light" color="teal">
            {formatNumber(recentAgentsTotal)} total
          </Badge>
        </Group>

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
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
            {recentAgents.map((item: any) => {
              const statusColor = resolveStatusColor(item.latestStatus);
              return (
                <Paper
                  key={item.name}
                  withBorder
                  radius="lg"
                  p="md"
                  style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                  onClick={() => handleAgentClick(item.name)}>
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
                        <Badge size="sm" variant="light" color={statusColor}>
                          {item.latestStatus}
                        </Badge>
                      )}
                    </Group>
                    <Group gap="lg">
                      <Text size="xs" c="dimmed">
                        <Text component="span" fw={500} c="dark">{formatNumber(item.sessionsCount)}</Text> sessions
                      </Text>
                      {item.latestSessionAt && (
                        <Text size="xs" c="dimmed">
                          Last: {dayjs(item.latestSessionAt).fromNow()}
                        </Text>
                      )}
                    </Group>
                  </Stack>
                </Paper>
              );
            })}
          </SimpleGrid>
        )}
      </Paper>

      {/* Recent Sessions */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" align="center" mb="md">
          <div>
            <Text fw={600} size="lg">Recent Sessions</Text>
            <Text size="sm" c="dimmed">Latest agent execution sessions</Text>
          </div>
          <Button 
            variant="light" 
            onClick={() => handleShowAllSessions()}
            rightSection={<IconArrowUpRight size={14} />}>
            Show All Sessions
          </Button>
        </Group>

        <SessionTable
          sessions={recentSessions}
          onRowClick={(sessionId) => handleRowClick(sessionId)}
          loading={loading}
        />
      </Paper>
    </Stack>
  );
}
