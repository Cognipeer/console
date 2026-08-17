'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Text, Tooltip } from '@mantine/core';
import { IconBook, IconEye, IconRobot } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { formatNumber, formatRelativeTime } from '@/lib/utils/tracingUtils';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

interface AgentRecord {
  name: string;
  sessionsCount: number;
  latestSessionAt: string | null;
  latestStatus: string | null;
}

interface AgentsResponse {
  agents: AgentRecord[];
  total: number;
}

// The directory endpoint is a lightweight "top N by recent activity" list
// (sub-nav/pickers use it too), not a paginated one — a generous cap covers
// realistic per-tenant agent counts without adding server-side pagination.
const DIRECTORY_LIMIT = 200;

export default function TracingAgentsPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchAgents = useCallback(
    async (isRefresh = false, signal?: AbortSignal) => {
      try {
        if (isRefresh) setRefreshing(true);
        else setLoading(true);

        const response = await fetch(
          `/api/tracing/agents?limit=${DIRECTORY_LIMIT}`,
          { signal, cache: 'no-store' },
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || 'Failed to fetch agents');
        }
        const data: AgentsResponse = await response.json();
        setAgents(data.agents || []);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error('Failed to load agents:', error);
        setAgents([]);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchAgents(false, controller.signal);
    return () => controller.abort();
  }, [fetchAgents]);

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (q && !a.name.toLowerCase().includes(q)) return false;
      if (statusFilter !== 'all' && (a.latestStatus || 'unknown') !== statusFilter) return false;
      return true;
    });
  }, [agents, query, statusFilter]);

  const columns: DataGridColumn<AgentRecord>[] = [
    {
      key: 'name',
      label: 'Agent',
      render: (a) => (
        <Tooltip label={a.name} withArrow>
          <span
            className="ds-row ds-gap-xs"
            style={{ fontSize: 12.5, color: 'var(--ds-text)' }}
          >
            <IconRobot size={14} stroke={1.7} />
            {a.name}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'sessions',
      label: 'Sessions',
      align: 'right',
      render: (a) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {formatNumber(a.sessionsCount)}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Latest status',
      render: (a) => (
        <StatusBadge
          status={
            a.latestStatus === 'success'
              ? 'ok'
              : a.latestStatus === 'error'
                ? 'err'
                : a.latestStatus === 'running'
                  ? 'info'
                  : 'paused'
          }
          label={(a.latestStatus || 'unknown').toUpperCase()}
        />
      ),
    },
    {
      key: 'latest',
      label: 'Last session',
      render: (a) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {a.latestSessionAt ? formatRelativeTime(a.latestSessionAt) : '—'}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Tracing"
        title="Agents"
        subtitle="Every agent that has reported a tracing session in the last 30 days, ranked by recent activity."
        actions={
          <Button
            variant="default"
            size="sm"
            leftSection={<IconBook size={14} stroke={1.7} />}
            onClick={() => openDocs('api-tracing')}
          >
            Docs
          </Button>
        }
      />

      <DataGrid<AgentRecord>
        records={filteredAgents}
        loading={loading}
        rowKey={(a) => a.name}
        onRowClick={(a) =>
          router.push(`/dashboard/tracing/agents/${encodeURIComponent(a.name)}`)
        }
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Search by agent name…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by latest status',
            width: 160,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'success', label: 'Success' },
              { value: 'error', label: 'Error' },
              { value: 'running', label: 'Running' },
            ],
          },
        ]}
        onRefresh={() => void fetchAgents(true)}
        refreshing={refreshing}
        empty={{
          icon: <IconRobot size={26} stroke={1.7} />,
          title: 'No agents found',
          description: 'Agents will appear once they report their first tracing session.',
        }}
        footerLeft={
          <Text size="xs" c="dimmed">
            {formatNumber(filteredAgents.length)} of {formatNumber(agents.length)} agents
          </Text>
        }
        rowActions={(a) => [
          {
            id: 'view',
            label: 'View agent',
            icon: <IconEye size={14} />,
            onClick: () =>
              router.push(`/dashboard/tracing/agents/${encodeURIComponent(a.name)}`),
          },
        ]}
      />
    </PageContainer>
  );
}
