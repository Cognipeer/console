'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconAlertCircle,
  IconArrowUpRight,
  IconBook,
  IconCalendar,
  IconInfoCircle,
  IconRefresh,
  IconTimeline,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import SessionTable from '@/components/tracing/SessionTable';
import {
  formatNumber,
  formatDuration,
  formatPercent,
  humanize,
  resolveStatusColor,
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
      totalTokens: number;
      totalDurationMs: number;
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

export default function AgentTracingAgentPage() {
  const params = useParams<{ agentName: string }>();
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AgentOverviewResponse | null>(null);
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);

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

  const rangeParams = useMemo(() => {
    const [start, end] = dateRange || [];
    return {
      from: start ? dayjs(start).startOf('day').toISOString() : undefined,
      to: end ? dayjs(end).endOf('day').toISOString() : undefined,
    };
  }, [dateRange]);

  const fetchOverview = async (isRefresh = false) => {
    if (!agentName) return;

    try {
      if (isRefresh) setRefreshing(true);
      setLoading(!data || !isRefresh);
      setError(null);

      const params = new URLSearchParams();
      if (rangeParams.from) params.append('from', rangeParams.from);
      if (rangeParams.to) params.append('to', rangeParams.to);
      params.append('timezone', timezone);

      const response = await fetch(`/api/tracing/agents/${encodeURIComponent(agentName)}/overview?${params}`);
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Failed to fetch agent overview');
      }

      const payload = await response.json();
      setData(payload);
    } catch (err: any) {
      console.error('Agent overview fetch error:', err);
      setError(err.message || 'Failed to fetch agent overview');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentName, rangeParams.from, rangeParams.to, timezone]);

  const handleShowAllSessions = () => {
    router.push(`/dashboard/tracing/sessions?agent=${encodeURIComponent(agentName)}`);
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/dashboard/tracing/sessions/${encodeURIComponent(sessionId)}`);
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
    totalTokens: 0,
    totalDurationMs: 0,
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

  return (
    <Stack gap="lg">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md" align="flex-start">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'teal', to: 'cyan', deg: 135 }}
            >
              <IconTimeline size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>{agent?.label ?? agentName}</Title>
              <Text size="sm" c="dimmed" mt={4}>
                Agent overview, recent sessions, and tool/model analytics.
              </Text>
            </div>
          </Group>

          <Group gap="sm">
            <Button
              onClick={() => openDocs('api-tracing')}
              variant="light"
              leftSection={<IconBook size={16} />}
            >
              Docs
            </Button>
            <DatePickerInput
              type="range"
              value={dateRange}
              clearable
              onChange={(value) => setDateRange(value as [Date | null, Date | null])}
              w={260}
              placeholder="Select Date Range"
              valueFormat="MMM D, YYYY"
              leftSection={<IconCalendar size={16} stroke={1.5} />}
              radius="md"
            />
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={() => fetchOverview(true)}
              loading={refreshing}
            >
              Refresh
            </Button>
          </Group>
        </Group>
      </Paper>

      {error && (
        <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      <Card withBorder shadow="sm" p="lg">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <Stack gap={4}>
              <Text fw={700} size="xl">
                {agent?.label || agentName}
              </Text>
              <Group gap="xs" align="center">
                {agent?.latestStatus && (
                  <Badge color={resolveStatusColor(agent.latestStatus)} size="sm">
                    {humanize(agent.latestStatus)}
                  </Badge>
                )}
                {agent?.latestVersion && (
                  <Badge size="sm" variant="light" color="gray">
                    v{agent.latestVersion}
                  </Badge>
                )}
              </Group>
              {agent?.latestSessionAt && (
                <Text size="sm" c="dimmed">
                  Last active {dayjs(agent.latestSessionAt).fromNow()}
                </Text>
              )}
              <Text size="sm" c="dimmed">
                Total sessions tracked: {formatNumber(agent?.sessionsCount || 0)}
              </Text>
            </Stack>
          </Group>
        </Stack>
      </Card>

      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group align="center" gap="sm">
            <IconInfoCircle size={20} color="var(--mantine-color-blue-6)" />
            <Stack gap={0}>
              <Text fw={600}>Agent summary</Text>
              <Text size="sm" c="dimmed">
                Recent activity snapshot for this agent.
              </Text>
            </Stack>
          </Group>

          {loading ? (
            <Center h={160}>
              <Loader size="sm" />
            </Center>
          ) : (
            <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
              <Paper withBorder radius="md" p="md">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Total sessions
                </Text>
                <Text fz={28} fw={700} mt={8}>
                  {formatNumber(totals.sessionsCount)}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  All-time: {formatNumber(agent?.sessionsCount || 0)}
                </Text>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Total events
                </Text>
                <Text fz={28} fw={700} mt={8}>
                  {formatNumber(totals.totalEvents)}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  Avg duration: {formatDuration(totals.averageDurationMs)}
                </Text>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Total tokens
                </Text>
                <Text fz={28} fw={700} mt={8}>
                  {formatNumber(totals.totalTokens)}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  Avg per session: {formatNumber(totals.averageTokensPerSession)}
                </Text>
              </Paper>
              <Paper withBorder radius="md" p="md">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Tool error rate
                </Text>
                <Text fz={28} fw={700} mt={8}>
                  {formatPercent(toolTotals.errorRate)}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  Total calls: {formatNumber(toolTotals.totalCalls)}
                </Text>
              </Paper>
            </SimpleGrid>
          )}
        </Stack>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card withBorder shadow="sm" p="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text fw={600}>Status breakdown</Text>
              <Badge size="sm" color="gray" variant="light">
                {formatNumber(statusEntries.reduce((sum, item) => sum + (item.count || 0), 0))}
              </Badge>
            </Group>
            {loading ? (
              <Center h={160}>
                <Loader size="sm" />
              </Center>
            ) : statusEntries.length === 0 ? (
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
          </Stack>
        </Card>

        <Card withBorder shadow="sm" p="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text fw={600}>Versions</Text>
              <Badge size="sm" variant="light" color="gray">
                {formatNumber(agent?.versions.length || 0)} versions
              </Badge>
            </Group>
            {loading ? (
              <Center h={160}>
                <Loader size="sm" />
              </Center>
            ) : versionEntries.length === 0 ? (
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
          </Stack>
        </Card>
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Card withBorder shadow="sm" p="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text fw={600}>Top models</Text>
              <Badge size="sm" variant="light" color="gray">
                {formatNumber(modelEntries.length)} entries
              </Badge>
            </Group>
            {loading ? (
              <Center h={160}>
                <Loader size="sm" />
              </Center>
            ) : modelEntries.length === 0 ? (
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
          </Stack>
        </Card>

        <Card withBorder shadow="sm" p="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Text fw={600}>Tool summary</Text>
              <Badge size="sm" variant="light" color="gray">
                {formatNumber(toolItems.length)} entries
              </Badge>
            </Group>
            {loading ? (
              <Center h={160}>
                <Loader size="sm" />
              </Center>
            ) : toolItems.length === 0 ? (
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
          </Stack>
        </Card>
      </SimpleGrid>

      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Text fw={600}>Recent trend (last 30 days)</Text>
            <Badge size="sm" variant="light" color="gray">
              {formatNumber(dailyRows.length)} days
            </Badge>
          </Group>
          {loading ? (
            <Center h={200}>
              <Loader size="sm" />
            </Center>
          ) : (
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
          )}
        </Stack>
      </Card>

      <Card withBorder shadow="sm" p="md">
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Stack gap={0}>
              <Text fw={600}>Recent sessions</Text>
              <Text size="sm" c="dimmed">
                Latest runs reported by this agent.
              </Text>
            </Stack>
            <Button
              variant="light"
              rightSection={<IconArrowUpRight size={16} />}
              onClick={handleShowAllSessions}
            >
              Show all sessions
            </Button>
          </Group>

          <SessionTable
            sessions={(data?.recentSessions || []).map((session) => ({
              sessionId: session.sessionId,
              agentName,
              status: session.status,
              startedAt: session.startedAt,
              durationMs: session.durationMs ?? undefined,
              totalEvents: session.totalEvents ?? undefined,
              totalTokens: session.totalTokens ?? undefined,
            }))}
            onRowClick={handleSessionClick}
            loading={loading && !data}
          />
        </Stack>
      </Card>

      <Card withBorder shadow="sm" p="md">
        <Text size="sm" c="dimmed">
          Need to instrument another agent? Use the tracing ingestion endpoint at{' '}
          <Text component="span" ff="monospace">
            /api/client/tracing/sessions
          </Text>
          {' '}with your API token from{' '}
          <Anchor href="/dashboard/settings">Settings → API Tokens</Anchor>.
          {' '}See our{' '}
          <Anchor component="button" onClick={() => openDocs('examples-tracing')}>
            LangChain/LangGraph integration examples
          </Anchor>
          {' '}for quick setup.
        </Text>
      </Card>
    </Stack>
  );
}
