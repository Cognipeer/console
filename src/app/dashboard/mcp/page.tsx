'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconApi,
  IconEdit,
  IconEye,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateMcpModal from '@/components/mcp/CreateMcpModal';
import type { McpServerView } from '@/lib/services/mcp';

const AUTH_LABELS: Record<string, string> = {
  none: 'None',
  token: 'Bearer',
  header: 'Header',
  basic: 'Basic',
};

const SOURCE_LABELS: Record<string, string> = {
  openapi: 'OpenAPI',
  remote: 'Remote MCP',
  stdio: 'Package',
};

export default function McpServersPage() {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServerView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const router = useRouter();

  const loadServers = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mcp', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setServers(data.servers ?? []);
      }
    } catch (err) {
      console.error('Failed to load MCP servers', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadServers();
  }, []);

  const handleToggleStatus = async (s: McpServerView) => {
    try {
      const newStatus = s.status === 'active' ? 'disabled' : 'active';
      const res = await fetch(`/api/mcp/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update server');
      notifications.show({
        title: newStatus === 'active' ? 'Server enabled' : 'Server disabled',
        message: `"${s.name}" has been ${newStatus === 'active' ? 'enabled' : 'disabled'}`,
        color: newStatus === 'active' ? 'teal' : 'orange',
      });
      await loadServers();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to update',
        color: 'red',
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/mcp/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Server deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadServers();
    } catch (err) {
      notifications.show({
        title: 'Error',
        message: err instanceof Error ? err.message : 'Failed to delete',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    return servers.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !s.name.toLowerCase().includes(q) &&
          !(s.description ?? '').toLowerCase().includes(q) &&
          !s.key.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [servers, query, statusFilter]);

  const totalServers = servers.length;
  const activeServers = servers.filter((s) => s.status === 'active').length;
  const totalTools = servers.reduce((sum, s) => sum + (s.tools?.length ?? 0), 0);
  const totalRequests = servers.reduce(
    (sum, s) => sum + (s.totalRequests ?? 0),
    0,
  );

  const columns: DataGridColumn<McpServerView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (s) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {s.name}
          </span>
          {s.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {s.description.length > 60
                ? `${s.description.slice(0, 60)}…`
                : s.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {s.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      render: (s) => {
        const target = s.sourceType === 'remote'
          ? s.remoteConfig?.url ?? ''
          : s.sourceType === 'stdio'
            ? `${s.stdioConfig?.runtime ?? 'npx'} ${s.stdioConfig?.packageName ?? ''}`
            : s.upstreamBaseUrl ?? '';
        return (
          <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
            <span className="ds-badge">{SOURCE_LABELS[s.sourceType] ?? 'OpenAPI'}</span>
            <span className="ds-mono ds-muted" style={{ fontSize: 11.5 }}>
              {target.length > 40 ? `${target.slice(0, 40)}…` : target}
            </span>
          </div>
        );
      },
    },
    {
      key: 'access',
      label: 'Access',
      render: (s) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span className="ds-badge">
            {s.exposure?.accessMode === 'public' ? 'Public URL' : 'API token'}
          </span>
          <span className="ds-faint" style={{ fontSize: 11 }}>
            {(s.exposure?.protocols ?? [])
              .map((p) => (p === 'streamable-http' ? 'HTTP' : 'SSE'))
              .join(' + ') || 'HTTP + SSE'}
            {' · '}
            {AUTH_LABELS[s.upstreamAuth?.type] ?? 'None'}
          </span>
        </div>
      ),
    },
    {
      key: 'tools',
      label: 'Tools',
      align: 'right',
      render: (s) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {s.tools?.length ?? 0}
        </span>
      ),
    },
    {
      key: 'requests',
      label: 'Requests',
      align: 'right',
      render: (s) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {s.totalRequests?.toLocaleString() ?? '—'}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (s) => (
        <StatusBadge status={s.status === 'active' ? 'active' : 'paused'} />
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · MCP"
        title="MCP Servers"
        subtitle="Expose APIs as Model Context Protocol servers. Each server proxies an upstream API and exposes its endpoints as MCP tools."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New MCP server
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Total servers" value={totalServers} icon={<IconApi size={14} />} />
        <StatTile label="Active" value={activeServers} />
        <StatTile label="Tools exposed" value={totalTools} />
        <StatTile
          label="Total requests"
          value={totalRequests.toLocaleString()}
        />
      </div>

      <DataGrid<McpServerView>
        records={filtered}
        loading={loading}
        rowKey={(s) => s.id}
        onRowClick={(s) => router.push(`/dashboard/mcp/${s.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        filters={[
          {
            value: statusFilter,
            onChange: setStatusFilter,
            ariaLabel: 'Filter by status',
            width: 140,
            options: [
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ]}
        onRefresh={loadServers}
        empty={{
          icon: <IconApi size={26} stroke={1.7} />,
          title: 'No MCP servers yet',
          description:
            'Create your first MCP server by providing an OpenAPI specification. Tools will be auto-generated from your API endpoints.',
          primaryAction: {
            label: 'Create your first MCP server',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${totalServers} servers`}
        rowActions={(s) => [
          {
            id: 'view',
            label: 'View',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/mcp/${s.id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => router.push(`/dashboard/mcp/${s.id}`),
          },
          {
            id: 'toggle',
            label: s.status === 'active' ? 'Disable' : 'Enable',
            icon:
              s.status === 'active' ? (
                <IconPlayerPause size={14} />
              ) : (
                <IconPlayerPlay size={14} />
              ),
            onClick: () => void handleToggleStatus(s),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(s),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete MCP server"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This
          will permanently remove the server and all its associated tools. This action
          cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>
            Delete
          </Button>
        </Group>
      </Modal>

      <CreateMcpModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(s) => {
          void loadServers();
          router.push(`/dashboard/mcp/${s.id}`);
        }}
      />
    </PageContainer>
  );
}
