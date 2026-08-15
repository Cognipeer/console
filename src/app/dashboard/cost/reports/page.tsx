'use client';

/**
 * Cost Reports — spend over time.
 *
 * Model-service spend aggregated into daily / weekly / monthly buckets with
 * top models and agents for the range. Viewable per project or across all
 * projects, with the shared dashboard date filter.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Table,
  Text,
} from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { resolveDashboardDateFilter } from '@/lib/utils/dashboardDateFilter';

type Granularity = 'daily' | 'weekly' | 'monthly';
type Scope = 'project' | 'all';

interface ReportBucket {
  bucket: string;
  requests: number;
  errors: number;
  totalTokens: number;
  costUsd: number;
}

interface CostReport {
  granularity: Granularity;
  fromDay?: string;
  toDay?: string;
  totals: { requests: number; totalTokens: number; costUsd: number };
  series: ReportBucket[];
  topModels: Array<{ modelKey: string; requests: number; totalTokens: number; costUsd: number }>;
  topAgents: Array<{ agentKey: string; requests: number; totalTokens: number; costUsd: number }>;
}

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  });
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export default function CostReportsPage() {
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [scope, setScope] = useState<Scope>('project');
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const [data, setData] = useState<CostReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ granularity });
      const resolved = resolveDashboardDateFilter(dateFilter.period, {
        from: dateFilter.dateRange[0] ?? undefined,
        to: dateFilter.dateRange[1] ?? undefined,
      });
      if (resolved.from) params.set('from', resolved.from.toISOString());
      if (resolved.to) params.set('to', resolved.to.toISOString());
      if (scope === 'all') params.set('scope', 'all');
      const response = await fetch(`/api/cost/reports?${params.toString()}`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      setData(await response.json());
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Cost report failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, [granularity, scope, dateFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const chartData = (data?.series ?? []).map((bucket) => ({
    bucket: bucket.bucket,
    Spend: Number(bucket.costUsd.toFixed(4)),
  }));

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Cost"
        title="Cost Reports"
        subtitle="Spend over time — daily, weekly or monthly, per project or across all projects."
      />

      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap="sm">
          <SegmentedControl
            value={scope}
            onChange={(value) => setScope(value as Scope)}
            data={[
              { value: 'project', label: 'This project' },
              { value: 'all', label: 'All projects' },
            ]}
          />
          <SegmentedControl
            value={granularity}
            onChange={(value) => setGranularity(value as Granularity)}
            data={[
              { value: 'daily', label: 'Daily' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
          <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
        </Group>
        {data ? (
          <Group gap="lg">
            <Text size="sm" c="dimmed">
              Total spend <Text component="span" fw={700}>{formatUsd(data.totals.costUsd)}</Text>
            </Text>
            <Text size="sm" c="dimmed">
              Requests <Text component="span" fw={700}>{formatCount(data.totals.requests)}</Text>
            </Text>
            <Text size="sm" c="dimmed">
              Tokens <Text component="span" fw={700}>{formatCount(data.totals.totalTokens)}</Text>
            </Text>
          </Group>
        ) : null}
      </Group>

      <Paper withBorder p="md" mb="md">
        {chartData.length > 0 ? (
          <BarChart
            h={260}
            data={chartData}
            dataKey="bucket"
            series={[{ name: 'Spend', color: 'teal.6' }]}
            valueFormatter={(value) => formatUsd(value)}
            withLegend={false}
          />
        ) : (
          <Text size="sm" c="dimmed" ta="center" py="xl">
            {loading ? 'Loading…' : 'No spend recorded in this range.'}
          </Text>
        )}
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
        <Paper withBorder p="md">
          <Text size="sm" fw={600} mb="xs">Top models</Text>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Model</Table.Th>
                <Table.Th ta="right">Requests</Table.Th>
                <Table.Th ta="right">Tokens</Table.Th>
                <Table.Th ta="right">Spend</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(data?.topModels ?? []).map((model) => (
                <Table.Tr key={model.modelKey}>
                  <Table.Td><Text size="sm">{model.modelKey}</Text></Table.Td>
                  <Table.Td ta="right">{formatCount(model.requests)}</Table.Td>
                  <Table.Td ta="right">{formatCount(model.totalTokens)}</Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={600}>{formatUsd(model.costUsd)}</Text></Table.Td>
                </Table.Tr>
              ))}
              {!loading && (data?.topModels.length ?? 0) === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="sm" c="dimmed" ta="center" py="md">No model usage in range.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : null}
            </Table.Tbody>
          </Table>
        </Paper>
        <Paper withBorder p="md">
          <Text size="sm" fw={600} mb="xs">Top agents</Text>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Agent</Table.Th>
                <Table.Th ta="right">Requests</Table.Th>
                <Table.Th ta="right">Tokens</Table.Th>
                <Table.Th ta="right">Spend</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(data?.topAgents ?? []).map((agent) => (
                <Table.Tr key={agent.agentKey}>
                  <Table.Td><Text size="sm">{agent.agentKey}</Text></Table.Td>
                  <Table.Td ta="right">{formatCount(agent.requests)}</Table.Td>
                  <Table.Td ta="right">{formatCount(agent.totalTokens)}</Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={600}>{formatUsd(agent.costUsd)}</Text></Table.Td>
                </Table.Tr>
              ))}
              {!loading && (data?.topAgents.length ?? 0) === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="sm" c="dimmed" ta="center" py="md">No agent-attributed usage in range.</Text>
                  </Table.Td>
                </Table.Tr>
              ) : null}
            </Table.Tbody>
          </Table>
        </Paper>
      </SimpleGrid>

      <Paper withBorder p="md">
        <Text size="sm" fw={600} mb="xs">Buckets</Text>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{granularity === 'monthly' ? 'Month' : granularity === 'weekly' ? 'Week of' : 'Day'}</Table.Th>
              <Table.Th ta="right">Requests</Table.Th>
              <Table.Th ta="right">Errors</Table.Th>
              <Table.Th ta="right">Tokens</Table.Th>
              <Table.Th ta="right">Spend</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...(data?.series ?? [])].reverse().map((bucket) => (
              <Table.Tr key={bucket.bucket}>
                <Table.Td><Text size="sm">{bucket.bucket}</Text></Table.Td>
                <Table.Td ta="right">{formatCount(bucket.requests)}</Table.Td>
                <Table.Td ta="right">{bucket.errors > 0 ? formatCount(bucket.errors) : '—'}</Table.Td>
                <Table.Td ta="right">{formatCount(bucket.totalTokens)}</Table.Td>
                <Table.Td ta="right"><Text size="sm" fw={600}>{formatUsd(bucket.costUsd)}</Text></Table.Td>
              </Table.Tr>
            ))}
            {!loading && (data?.series.length ?? 0) === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="sm" c="dimmed" ta="center" py="md">No spend recorded in this range.</Text>
                </Table.Td>
              </Table.Tr>
            ) : null}
          </Table.Tbody>
        </Table>
      </Paper>
    </PageContainer>
  );
}
