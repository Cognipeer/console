'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  Progress,
  RingProgress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  IconShieldCheck,
  IconShieldX,
  IconActivity,
  IconClockHour4,
  IconAlertTriangle,
  IconEye,
} from '@tabler/icons-react';
import type { IGuardrailEvaluationLog, IGuardrailEvalAggregate } from '@/lib/database';
import {
  buildDashboardDateSearchParams,
  type DashboardDateFilterState,
} from '@/lib/utils/dashboardDateFilter';

/* ── tiny helpers ── */
function fmtNumber(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function truncate(text: string | undefined, max = 80) {
  if (!text) return '—';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/* ── KPI mini card ── */
interface KpiProps {
  icon: React.ReactNode;
  color: string;
  label: string;
  value: string | number;
  highlight?: boolean;
}
function KpiCard({ icon, color, label, value, highlight }: KpiProps) {
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      style={highlight ? { borderColor: `var(--mantine-color-${color}-4)`, borderWidth: 2 } : undefined}
    >
      <Group gap="sm" wrap="nowrap">
        <ThemeIcon variant="light" color={color} size="lg" radius="md">
          {icon}
        </ThemeIcon>
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
          <Text fw={700} fz="lg" lh={1.2}>{value}</Text>
        </div>
      </Group>
    </Paper>
  );
}

/* ── severity badge ── */
function SeverityBadge({ severity }: { severity: string }) {
  const c = severity === 'high' ? 'red' : severity === 'medium' ? 'orange' : 'yellow';
  return <Badge size="xs" variant="light" color={c}>{severity}</Badge>;
}

/* ── main component ── */
interface Props {
  guardrailId: string;
  mode?: 'all' | 'overview' | 'logs';
  dateFilter?: DashboardDateFilterState;
}

export default function GuardrailEvaluationHistory({
  guardrailId,
  mode = 'all',
  dateFilter,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<IGuardrailEvaluationLog[]>([]);
  const [agg, setAgg] = useState<IGuardrailEvalAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = dateFilter
        ? buildDashboardDateSearchParams(dateFilter)
        : new URLSearchParams();
      params.set('limit', '100');
      params.set('groupBy', 'day');

      const res = await fetch(`/api/guardrails/${guardrailId}/evaluations?${params.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error ?? 'Failed to load evaluation history');
      }
      const data = await res.json();
      setLogs(data.logs ?? []);
      setAgg(data.aggregate ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [guardrailId, dateFilter]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <Center h={300}>
        <Loader size="sm" />
      </Center>
    );
  }

  if (error) {
    return (
      <Center h={200}>
        <Text c="red" size="sm">{error}</Text>
      </Center>
    );
  }

  const showOverview = mode === 'all' || mode === 'overview';
  const showLogs = mode === 'all' || mode === 'logs';
  const hasAggregate = Boolean(agg && agg.totalEvaluations > 0);

  if (showOverview && !hasAggregate) {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <IconEye size={32} color="var(--mantine-color-dimmed)" />
          <Text c="dimmed" size="sm">No evaluation data yet</Text>
          <Text c="dimmed" size="xs">Evaluations will appear here once the guardrail is used.</Text>
        </Stack>
      </Center>
    );
  }

  if (!showOverview && showLogs && logs.length === 0) {
    return (
      <Center h={200}>
        <Stack align="center" gap="xs">
          <IconEye size={32} color="var(--mantine-color-dimmed)" />
          <Text c="dimmed" size="sm">No evaluation logs found</Text>
          <Text c="dimmed" size="xs">Row-based evaluation records will appear here.</Text>
        </Stack>
      </Center>
    );
  }

  /* ── derived data ── */
  const passRate = agg?.passRate ?? 0;
  const failRate = 100 - passRate;

  const chartData = (agg?.timeseries ?? []).map((t) => ({
    period: t.period,
    Passed: t.passed,
    Failed: t.failed,
  }));

  const findingsByType = Object.entries(agg?.findingsByType ?? {}).sort((a, b) => b[1] - a[1]);
  const findingsBySeverity = Object.entries(agg?.findingsBySeverity ?? {}).sort((a, b) => b[1] - a[1]);
  const totalFindings = findingsByType.reduce((s, [, c]) => s + c, 0) || 1;

  return (
    <Stack gap="md">
      {showOverview && (
        <>
      {/* ── KPI cards ── */}
      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="md">
        <KpiCard
          icon={<IconActivity size={18} />}
          color="blue"
          label="Total Evaluations"
          value={fmtNumber(agg?.totalEvaluations ?? 0)}
        />
        <KpiCard
          icon={<IconShieldCheck size={18} />}
          color="teal"
          label="Passed"
          value={fmtNumber(agg?.passedCount ?? 0)}
        />
        <KpiCard
          icon={<IconShieldX size={18} />}
          color="red"
          label="Failed"
          value={fmtNumber(agg?.failedCount ?? 0)}
          highlight
        />
        <KpiCard
          icon={<IconAlertTriangle size={18} />}
          color="orange"
          label="Pass Rate"
          value={`${passRate.toFixed(1)}%`}
        />
        <KpiCard
          icon={<IconClockHour4 size={18} />}
          color="grape"
          label="Avg Latency"
          value={agg?.avgLatencyMs != null ? `${Math.round(agg.avgLatencyMs)} ms` : '—'}
        />
      </SimpleGrid>

      <Grid gutter="md">
        {/* ── Daily chart ── */}
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Text fw={600} mb="xs">Daily Evaluations</Text>
            {chartData.length > 1 ? (
              <AreaChart
                h={240}
                data={chartData}
                dataKey="period"
                series={[
                  { name: 'Passed', color: 'teal.5' },
                  { name: 'Failed', color: 'red.5' },
                ]}
                curveType="monotone"
                withDots={false}
                withGradient
                gridAxis="x"
                tickLine="x"
              />
            ) : (
              <Center h={200}>
                <Text c="dimmed" size="xs">Not enough data for a chart yet</Text>
              </Center>
            )}
          </Paper>
        </Grid.Col>

        {/* ── Pass / Fail donut ── */}
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder radius="md" p="md" h="100%">
            <Text fw={600} mb="sm">Pass / Fail Ratio</Text>
            <Center>
              <RingProgress
                size={150}
                thickness={16}
                roundCaps
                label={
                  <Text ta="center" fw={700} size="lg">{passRate.toFixed(0)}%</Text>
                }
                sections={[
                  { value: passRate, color: 'teal' },
                  { value: failRate, color: 'red' },
                ]}
              />
            </Center>
            <Group justify="center" gap="md" mt="sm">
              <Group gap={4}>
                <Badge size="xs" variant="dot" color="teal">Passed</Badge>
                <Text size="xs">{fmtNumber(agg?.passedCount ?? 0)}</Text>
              </Group>
              <Group gap={4}>
                <Badge size="xs" variant="dot" color="red">Failed</Badge>
                <Text size="xs">{fmtNumber(agg?.failedCount ?? 0)}</Text>
              </Group>
            </Group>
          </Paper>
        </Grid.Col>
      </Grid>

      {/* ── Findings breakdown ── */}
      <Grid gutter="md">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="md" p="md">
            <Text fw={600} mb="sm">Findings by Type</Text>
            {findingsByType.length === 0 ? (
              <Text c="dimmed" size="xs">No findings recorded</Text>
            ) : (
              <Stack gap="xs">
                {findingsByType.map(([type, count]) => (
                  <Group key={type} gap="xs" wrap="nowrap">
                    <Text size="sm" w={120} truncate>{type}</Text>
                    <Progress
                      value={(count / totalFindings) * 100}
                      color="blue"
                      size="md"
                      radius="xl"
                      style={{ flex: 1 }}
                    />
                    <Text size="xs" c="dimmed" w={40} ta="right">{count}</Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 6 }}>
          <Paper withBorder radius="md" p="md">
            <Text fw={600} mb="sm">Findings by Severity</Text>
            {findingsBySeverity.length === 0 ? (
              <Text c="dimmed" size="xs">No findings recorded</Text>
            ) : (
              <Stack gap="xs">
                {findingsBySeverity.map(([sev, count]) => {
                  const c = sev === 'high' ? 'red' : sev === 'medium' ? 'orange' : 'yellow';
                  return (
                    <Group key={sev} gap="xs" wrap="nowrap">
                      <Badge size="sm" variant="light" color={c} w={80}>{sev}</Badge>
                      <Progress
                        value={(count / totalFindings) * 100}
                        color={c}
                        size="md"
                        radius="xl"
                        style={{ flex: 1 }}
                      />
                      <Text size="xs" c="dimmed" w={40} ta="right">{count}</Text>
                    </Group>
                  );
                })}
              </Stack>
            )}
          </Paper>
        </Grid.Col>
      </Grid>
        </>
      )}

      {showLogs && (
        <>
      {/* ── Recent evaluation logs ── */}
      <Paper withBorder radius="md" p="md">
        <Text fw={600} mb="sm">Recent Evaluations</Text>
        <ScrollArea>
          <Table striped highlightOnHover fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Status</Table.Th>
                <Table.Th>Input</Table.Th>
                <Table.Th>Findings</Table.Th>
                <Table.Th>Severity</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Latency</Table.Th>
                <Table.Th>Date</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.map((log, i) => {
                const id = (log._id ?? i).toString();
                const topFinding = log.findings?.[0];
                const maxSev = log.findings?.reduce(
                  (best: string, f: { severity: string }) => {
                    const order = { high: 3, medium: 2, low: 1 } as Record<string, number>;
                    return (order[f.severity] ?? 0) > (order[best] ?? 0) ? f.severity : best;
                  },
                  'low',
                );
                return (
                  <Table.Tr key={id}>
                    <Table.Td>
                      <Badge
                        size="sm"
                        variant="light"
                        color={log.passed ? 'teal' : 'red'}
                      >
                        {log.passed ? 'Passed' : 'Failed'}
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ maxWidth: 260 }}>
                      <Tooltip label={log.inputText || '—'} multiline w={300}>
                        <Text size="xs" truncate>{truncate(log.inputText, 60)}</Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      {topFinding ? (
                        <Tooltip label={topFinding.message}>
                          <Text size="xs" truncate style={{ maxWidth: 160 }}>
                            {topFinding.type}
                            {log.findings.length > 1 && ` +${log.findings.length - 1}`}
                          </Text>
                        </Tooltip>
                      ) : (
                        <Text size="xs" c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {maxSev && !log.passed ? <SeverityBadge severity={maxSev} /> : <Text size="xs" c="dimmed">—</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{log.source ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">{log.latencyMs != null ? `${log.latencyMs}ms` : '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {log.createdAt ? new Date(log.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
              {logs.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={7}>
                    <Text ta="center" c="dimmed" size="sm" py="md">No evaluation logs found</Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Paper>
        </>
      )}
    </Stack>
  );
}
