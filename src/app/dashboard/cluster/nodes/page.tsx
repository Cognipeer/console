'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Code, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconServer } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatTile from '@/components/common/ui/StatTile';
import type { INodeRecord, NodeStatus } from '@/lib/core/cluster';

interface ClusterOverview {
  thisNodeName: string;
  defaultNodeName: string;
  nodes: INodeRecord[];
}

function statusColor(status: NodeStatus): 'teal' | 'orange' | 'gray' {
  if (status === 'online') return 'teal';
  if (status === 'draining') return 'orange';
  return 'gray';
}

function formatTimestamp(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

export default function ClusterNodesPage() {
  const [nodes, setNodes] = useState<INodeRecord[]>([]);
  const [thisNodeName, setThisNodeName] = useState('');
  const [defaultNodeName, setDefaultNodeName] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

  const loadOverview = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch('/api/cluster/overview', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load cluster overview');
      const data = (await res.json()) as ClusterOverview;
      setNodes(data.nodes ?? []);
      setThisNodeName(data.thisNodeName);
      setDefaultNodeName(data.defaultNodeName);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Error',
        message: error instanceof Error ? error.message : 'Failed to load cluster overview',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    const id = setInterval(() => void loadOverview(true), 10_000);
    return () => clearInterval(id);
  }, [loadOverview]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter(
      (n) =>
        n.name.toLowerCase().includes(q)
        || (n.url ?? '').toLowerCase().includes(q)
        || n.role.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  const summary = useMemo(
    () => ({
      total: nodes.length,
      online: nodes.filter((n) => n.status === 'online').length,
      offline: nodes.filter((n) => n.status === 'offline').length,
      draining: nodes.filter((n) => n.status === 'draining').length,
    }),
    [nodes],
  );

  const columns: DataGridColumn<INodeRecord>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (row) => (
        <Group gap={6}>
          <Text fw={600}>{row.name}</Text>
          {row.name === thisNodeName ? (
            <Badge size="xs" color="blue" variant="light">this</Badge>
          ) : null}
          {row.name === defaultNodeName ? (
            <Badge size="xs" color="grape" variant="light">default</Badge>
          ) : null}
        </Group>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      render: (row) => <Badge variant="light">{row.role}</Badge>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => (
        <Badge color={statusColor(row.status)} variant="light">
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'url',
      label: 'URL',
      render: (row) => (row.url ? <Code>{row.url}</Code> : <Text c="dimmed">—</Text>),
    },
    {
      key: 'lastHeartbeat',
      label: 'Last heartbeat',
      render: (row) => (
        <Text size="sm" title={formatTimestamp(row.lastHeartbeatAt)}>
          {formatRelative(row.lastHeartbeatAt)}
        </Text>
      ),
    },
    {
      key: 'started',
      label: 'Started',
      render: (row) => (
        <Text size="sm" title={formatTimestamp(row.startedAt)}>
          {formatRelative(row.startedAt)}
        </Text>
      ),
    },
    {
      key: 'version',
      label: 'Version',
      render: (row) => <Text size="sm">{row.version ?? '—'}</Text>,
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        title="Cluster Nodes"
        subtitle="Processes that have registered with the cluster registry. Nodes report a heartbeat every 10 seconds."
      />

      <Group grow mb="md">
        <StatTile icon={<IconServer size={18} />} label="Total" value={String(summary.total)} />
        <StatTile icon={<IconServer size={18} />} label="Online" value={String(summary.online)} />
        <StatTile icon={<IconServer size={18} />} label="Offline" value={String(summary.offline)} />
        <StatTile icon={<IconServer size={18} />} label="Draining" value={String(summary.draining)} />
      </Group>

      <DataGrid<INodeRecord>
        records={filtered}
        rowKey={(row) => row.name}
        columns={columns}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => loadOverview(true)}
        search={{ value: query, onChange: setQuery, placeholder: 'Search nodes…' }}
        empty={{
          title: 'No nodes registered',
          description: 'Nodes register themselves when they boot.',
        }}
      />

      <Stack mt="md" gap={4}>
        <Text size="xs" c="dimmed">
          Default node: <Code>{defaultNodeName || '—'}</Code> — new instance assignments
          fall back to this node when not explicitly assigned.
        </Text>
      </Stack>
    </PageContainer>
  );
}
