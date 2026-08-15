'use client';

/**
 * Cost Management — per-agent spend.
 *
 * Answers "which agent costs what" from the same usage rollup the model view
 * reads. Agents appear here via trace ingestion (agentKey attribution), so an
 * agent is visible as soon as it reports traces — regardless of whether its
 * model calls went through the gateway. Rows expand to the agent's per-model
 * split; agents with unpriced models are flagged (their spend reads low).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Group,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import Link from 'next/link';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { resolveDashboardDateFilter } from '@/lib/utils/dashboardDateFilter';
import { useTranslations } from '@/lib/i18n';

interface AgentCostModelSplit {
  modelKey: string;
  status: 'hub' | 'external' | 'unpriced';
  requests: number;
  totalTokens: number;
  costUsd: number;
}

interface AgentCostEntry {
  agentKey: string;
  requests: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  models: AgentCostModelSplit[];
  hasUnpricedUsage: boolean;
}

interface AgentCosts {
  fromDay?: string;
  toDay?: string;
  totals: { requests: number; totalTokens: number; costUsd: number };
  entries: AgentCostEntry[];
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

const STATUS_COLOR: Record<AgentCostModelSplit['status'], string> = {
  hub: 'teal',
  external: 'blue',
  unpriced: 'orange',
};

export default function AgentCostsPage() {
  const t = useTranslations('navigation');
  const [data, setData] = useState<AgentCosts | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const resolved = resolveDashboardDateFilter(dateFilter.period, {
        from: dateFilter.dateRange[0] ?? undefined,
        to: dateFilter.dateRange[1] ?? undefined,
      });
      if (resolved.from) params.set('from', resolved.from.toISOString());
      if (resolved.to) params.set('to', resolved.to.toISOString());
      const response = await fetch(`/api/cost/agents?${params.toString()}`);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
      setData(await response.json());
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Agent costs failed',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (agentKey: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(agentKey)) next.delete(agentKey);
      else next.add(agentKey);
      return next;
    });
  };

  const unpricedAgents = (data?.entries ?? []).filter((entry) => entry.hasUnpricedUsage).length;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Cost"
        title={`${t('cost')} — Agents`}
        subtitle="Spend attributed to each agent from its observability traces"
      />

      <Group justify="space-between" mb="md">
        <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
        {data ? (
          <Text size="sm" c="dimmed">
            Total spend <Text component="span" fw={700}>{formatUsd(data.totals.costUsd)}</Text>
          </Text>
        ) : null}
      </Group>

      {unpricedAgents > 0 ? (
        <Alert
          color="orange"
          icon={<IconAlertTriangle size={16} />}
          title={`${unpricedAgents} agent(s) use models without pricing`}
          mb="md"
        >
          Their spend reads lower than reality. Set reference prices on the{' '}
          <Link href="/dashboard/cost/pricing">Pricing</Link> page.
        </Alert>
      ) : null}

      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={28} />
            <Table.Th>Agent</Table.Th>
            <Table.Th ta="right">Model calls</Table.Th>
            <Table.Th ta="right">Tokens</Table.Th>
            <Table.Th ta="right">Spend</Table.Th>
            <Table.Th>Models</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(data?.entries ?? []).map((entry) => {
            const isOpen = expanded.has(entry.agentKey);
            const label = entry.agentKey || 'Unattributed (gateway)';
            return (
              <Table.Tr key={entry.agentKey || '<none>'} style={{ cursor: 'pointer' }} onClick={() => toggle(entry.agentKey)}>
                <Table.Td>
                  {isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600}>{label}</Text>
                    {entry.hasUnpricedUsage ? (
                      <Tooltip label="Uses models without pricing — spend reads low">
                        <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                      </Tooltip>
                    ) : null}
                  </Group>
                  {isOpen ? (
                    <Table mt="xs" withRowBorders={false}>
                      <Table.Tbody>
                        {entry.models.map((split) => (
                          <Table.Tr key={split.modelKey}>
                            <Table.Td p={2}>
                              <Badge size="xs" color={STATUS_COLOR[split.status]} variant="light">
                                {split.modelKey}
                              </Badge>
                            </Table.Td>
                            <Table.Td p={2} ta="right">
                              <Text size="xs" c="dimmed">{formatCount(split.totalTokens)} tok</Text>
                            </Table.Td>
                            <Table.Td p={2} ta="right">
                              <Text size="xs">{split.status === 'unpriced' ? '—' : formatUsd(split.costUsd)}</Text>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  ) : null}
                </Table.Td>
                <Table.Td ta="right">{formatCount(entry.modelCalls || entry.requests)}</Table.Td>
                <Table.Td ta="right">{formatCount(entry.totalTokens)}</Table.Td>
                <Table.Td ta="right">
                  <Text size="sm" fw={600}>{formatUsd(entry.costUsd)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {entry.models.slice(0, 3).map((split) => split.modelKey).join(', ')}
                    {entry.models.length > 3 ? ` +${entry.models.length - 3}` : ''}
                  </Text>
                </Table.Td>
              </Table.Tr>
            );
          })}
          {!loading && (data?.entries.length ?? 0) === 0 ? (
            <Table.Tr>
              <Table.Td colSpan={6}>
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  No agent usage observed in this window. Agents appear here once they report traces.
                </Text>
              </Table.Td>
            </Table.Tr>
          ) : null}
        </Table.Tbody>
      </Table>
    </PageContainer>
  );
}
