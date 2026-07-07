'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stack,
  Card,
  Group,
  Text,
  Paper,
  SimpleGrid,
  Badge,
  Alert,
  Loader,
  Center,
  Button,
  TextInput,
  Select,
  Anchor,
  Table,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { IconInfoCircle, IconRefresh, IconCalendar } from '@tabler/icons-react';
import SessionTable from '@/components/tracing/SessionTable';
import {
  formatNumber,
  formatPercent,
  formatDuration,
  calcCacheHitRate,
} from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import type { DashboardOverview } from '@/lib/services/agentTracing';

export default function AgentTracing() {
  const { openDocs } = useDocsDrawer();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<[Date | null, Date | null]>([null, null]);
  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [dashboardData, setDashboardData] = useState<DashboardOverview | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      if (dateRange[0]) params.append('from', dateRange[0].toISOString());
      if (dateRange[1]) params.append('to', dateRange[1].toISOString());

      const response = await fetch(`/api/tracing/dashboard?${params.toString()}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch dashboard data');
      }

      const data = await response.json();
      setDashboardData(data as DashboardOverview);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'An error occurred';
      setError(message);
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const handleRefresh = () => {
    fetchDashboard();
  };

  const filteredSessions = useMemo(() => {
    if (!dashboardData?.recentSessions) return [];
    
    let sessions = [...dashboardData.recentSessions];
    
    if (agentFilter) {
      sessions = sessions.filter(s => 
        s.agentName?.toLowerCase().includes(agentFilter.toLowerCase())
      );
    }
    
    if (statusFilter) {
      sessions = sessions.filter(s => s.status === statusFilter);
    }
    
    return sessions;
  }, [dashboardData, agentFilter, statusFilter]);

  const totals = dashboardData?.analytics?.totals ?? {
    sessionsCount: 0,
    totalEvents: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalDurationMs: 0,
    averageTokensPerSession: 0,
    averageDurationMs: 0,
  };
  const toolTotals = dashboardData?.analytics?.tools?.totals ?? {
    totalCalls: 0,
    errorCalls: 0,
    successCalls: 0,
    errorRate: 0,
  };

  if (error) {
    return (
      <Alert icon={<IconInfoCircle size={16} />} color="red" title="Error">
        {error}
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      {/* Getting Started Info */}
      <Card withBorder shadow="sm" p="md">
        <Group align="flex-start" gap="sm">
          <IconInfoCircle size={20} color="var(--mantine-color-blue-6)" style={{ marginTop: 4 }} />
          <Stack gap={6}>
            <Text fw={600}>Instrument your agents</Text>
            <Text size="sm" c="dimmed">
              Generate an API key under API Tokens and POST your agent payloads to{' '}
              <Text component="span" ff="monospace">/api/client/tracing/sessions</Text>
              {' '}to stream tracing data from any stack.
              {' '}See our{' '}
              <Anchor component="button" onClick={() => openDocs('examples-tracing')}>
                LangChain/LangGraph integration examples
              </Anchor>
              {' '}for quick setup.
            </Text>
          </Stack>
        </Group>
      </Card>

      {/* Filters and Actions */}
      <Card withBorder shadow="sm" p="md">
        <Group justify="space-between" align="flex-end" gap="sm">
          <Group gap="sm" wrap="wrap">
            <DatePickerInput
              type="range"
              label="Date Range"
              placeholder="Pick dates range"
              value={dateRange}
              onChange={(value) => setDateRange(value as [Date | null, Date | null])}
              leftSection={<IconCalendar size={16} />}
              clearable
              style={{ minWidth: 250 }}
            />
            <TextInput
              label="Agent Filter"
              placeholder="Filter by agent name"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.currentTarget.value)}
              style={{ minWidth: 200 }}
            />
            <Select
              label="Status"
              placeholder="All statuses"
              data={[
                { value: 'success', label: 'Success' },
                { value: 'error', label: 'Error' },
                { value: 'running', label: 'Running' },
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
              clearable
              style={{ minWidth: 150 }}
            />
          </Group>
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={handleRefresh}
            loading={loading}
          >
            Refresh
          </Button>
        </Group>
      </Card>

      {/* Analytics Overview */}
      {loading && !dashboardData ? (
        <Center h={200}>
          <Loader size="sm" />
        </Center>
      ) : dashboardData ? (
        <Stack gap="md">
          {/* Key Metrics */}
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Total Sessions
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(totals.sessionsCount ?? 0)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Total Tokens
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(totals.totalTokens ?? 0)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Avg per session: {formatNumber(totals.averageTokensPerSession ?? 0)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Avg Duration
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatDuration(totals.averageDurationMs ?? 0)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Total: {formatDuration(totals.totalDurationMs ?? 0)}
              </Text>
            </Paper>
            <Paper withBorder p="md" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Tool Calls
              </Text>
              <Text fz={28} fw={700} mt={8}>
                {formatNumber(toolTotals.totalCalls ?? 0)}
              </Text>
              <Text size="xs" c="dimmed" mt={4}>
                Error rate: {formatPercent(toolTotals.errorRate ?? 0)}
              </Text>
            </Paper>
            {totals.totalCachedInputTokens ? (
              <Paper withBorder p="md" radius="md">
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Prompt Cache Hit Rate
                </Text>
                <Text fz={28} fw={700} mt={8}>
                  {formatPercent(calcCacheHitRate(totals.totalInputTokens, totals.totalCachedInputTokens))}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  {formatNumber(totals.totalCachedInputTokens)} cached tokens
                </Text>
              </Paper>
            ) : null}
          </SimpleGrid>

          {/* Recent Sessions */}
          <Card withBorder shadow="sm" p="md">
            <Stack gap="md">
              <Group justify="space-between" align="center">
                <Text fw={600}>Recent Sessions</Text>
                <Badge size="sm" variant="light">
                  {filteredSessions.length} sessions
                </Badge>
              </Group>
              <SessionTable sessions={filteredSessions} loading={loading} />
            </Stack>
          </Card>

          {/* Recent Agents */}
          {dashboardData.recentAgents && dashboardData.recentAgents.length > 0 && (
            <Card withBorder shadow="sm" p="md">
              <Stack gap="md">
                <Group justify="space-between" align="center">
                  <Stack gap={0}>
                    <Text fw={600}>Recently Active Agents</Text>
                    <Text size="sm" c="dimmed">
                      Showing up to {dashboardData.recentAgents.length} agents by recent activity
                    </Text>
                  </Stack>
                  <Text size="xs" c="dimmed">
                    Total tracked: {formatNumber(dashboardData.recentAgentsTotal)}
                  </Text>
                </Group>
                <Table.ScrollContainer minWidth={480}>
                  <Table verticalSpacing="xs" highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Agent</Table.Th>
                        <Table.Th ta="right">Sessions</Table.Th>
                        <Table.Th ta="right">Tokens</Table.Th>
                        <Table.Th ta="right">Avg / session</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {dashboardData.recentAgents.slice(0, 6).map((agent) => (
                        <Table.Tr key={agent.name}>
                          <Table.Td>
                            <Text size="sm" fw={500} lineClamp={1}>
                              {agent.label || agent.name}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="xs" c="dimmed">{formatNumber(agent.sessionsCount)}</Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Badge size="xs" variant="light" color="blue">
                              {formatNumber(agent.totalTokens)}
                            </Badge>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="xs" c="dimmed">{formatNumber(agent.averageTokensPerSession)}</Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Stack>
            </Card>
          )}
        </Stack>
      ) : (
        <Center h={200}>
          <Text c="dimmed">No data available</Text>
        </Center>
      )}
    </Stack>
  );
}
