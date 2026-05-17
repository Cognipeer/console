'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconApi,
  IconCloud,
  IconEdit,
  IconEye,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTool,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateToolModal from '@/components/tools/CreateToolModal';
import type { ToolView } from '@/lib/services/tools';

const TYPE_LABEL: Record<string, string> = {
  openapi: 'OpenAPI',
  mcp: 'MCP',
};

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolView[]>([]);
  const [loading, setLoading] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ToolView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const router = useRouter();

  const loadTools = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tools', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setTools(data.tools ?? []);
      }
    } catch (err) {
      console.error('Failed to load tools', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTools();
  }, []);

  const handleToggleStatus = async (t: ToolView) => {
    try {
      const newStatus = t.status === 'active' ? 'disabled' : 'active';
      const res = await fetch(`/api/tools/${t.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update tool');
      notifications.show({
        title: newStatus === 'active' ? 'Tool enabled' : 'Tool disabled',
        message: `"${t.name}" has been ${newStatus === 'active' ? 'enabled' : 'disabled'}`,
        color: newStatus === 'active' ? 'teal' : 'orange',
      });
      await loadTools();
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
      const res = await fetch(`/api/tools/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({
        title: 'Tool deleted',
        message: `"${deleteTarget.name}" was deleted`,
        color: 'red',
      });
      setDeleteTarget(null);
      await loadTools();
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
    return tools.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !t.name.toLowerCase().includes(q) &&
          !(t.description ?? '').toLowerCase().includes(q) &&
          !t.key.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [tools, query, typeFilter, statusFilter]);

  const totalTools = tools.length;
  const activeTools = tools.filter((t) => t.status === 'active').length;
  const disabledTools = totalTools - activeTools;
  const totalActions = tools.reduce((sum, t) => sum + (t.actions?.length ?? 0), 0);

  const columns: DataGridColumn<ToolView>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (t) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {t.name}
          </span>
          {t.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {t.description.length > 60
                ? `${t.description.slice(0, 60)}…`
                : t.description}
            </span>
          ) : (
            <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
              {t.key}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (t) => (
        <span
          className={`ds-badge ${t.type === 'openapi' ? 'ds-badge-info' : 'ds-badge-teal'}`}
        >
          {t.type === 'openapi' ? (
            <IconApi size={10} stroke={2} />
          ) : (
            <IconCloud size={10} stroke={2} />
          )}
          {TYPE_LABEL[t.type] ?? t.type}
        </span>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (t) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {t.actions?.length ?? 0}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (t) => (
        <StatusBadge status={t.status === 'active' ? 'active' : 'paused'} />
      ),
    },
    {
      key: 'key',
      label: 'Key',
      render: (t) => (
        <span className="ds-mono ds-faint" style={{ fontSize: 12 }}>
          {t.key}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Tools"
        title="Tools"
        subtitle="Manage tools from OpenAPI specs or MCP servers. Tools are available for agents and direct API execution."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateModalOpen(true)}
          >
            New tool
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Total tools" value={totalTools} icon={<IconTool size={14} />} />
        <StatTile label="Active" value={activeTools} />
        <StatTile label="Disabled" value={disabledTools} />
        <StatTile label="Total actions" value={totalActions} />
      </div>

      <DataGrid<ToolView>
        records={filtered}
        loading={loading}
        rowKey={(t) => t.id}
        onRowClick={(t) => router.push(`/dashboard/tools/${t.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        filters={[
          {
            value: typeFilter,
            onChange: setTypeFilter,
            ariaLabel: 'Filter by type',
            width: 140,
            options: [
              { value: 'all', label: 'All types' },
              { value: 'openapi', label: 'OpenAPI' },
              { value: 'mcp', label: 'MCP' },
            ],
          },
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
        onRefresh={loadTools}
        empty={{
          icon: <IconTool size={26} stroke={1.7} />,
          title: 'No tools yet',
          description:
            'Add your first tool by importing an OpenAPI specification or connecting to an MCP server. Tools can be used by agents or called directly via the API.',
          primaryAction: {
            label: 'Create your first tool',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${totalTools} tools`}
        rowActions={(t) => [
          {
            id: 'view',
            label: 'View',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/tools/${t.id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => router.push(`/dashboard/tools/${t.id}`),
          },
          {
            id: 'toggle',
            label: t.status === 'active' ? 'Disable' : 'Enable',
            icon:
              t.status === 'active' ? (
                <IconPlayerPause size={14} />
              ) : (
                <IconPlayerPlay size={14} />
              ),
            onClick: () => void handleToggleStatus(t),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(t),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete tool"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This
          will remove the tool and all its actions. Agents that reference this tool
          will no longer have access to it. This action cannot be undone.
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

      <CreateToolModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={(t) => {
          void loadTools();
          router.push(`/dashboard/tools/${t.id}`);
        }}
      />
    </PageContainer>
  );
}
