'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBook2,
  IconDatabase,
  IconFileText,
  IconPlus,
  IconPuzzle,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import StatusBadge from '@/components/common/ui/StatusBadge';
import CreateRagModuleModal from '@/components/rag/CreateRagModuleModal';

interface RagModuleView {
  _id: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  chunkConfig: {
    strategy: string;
    chunkSize: number;
    chunkOverlap: number;
  };
  status: string;
  totalDocuments?: number;
  totalChunks?: number;
  createdAt?: string;
}

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function strategyLabel(strategy: string) {
  switch (strategy) {
    case 'recursive_character':
      return 'Recursive';
    case 'token':
      return 'Token';
    default:
      return strategy;
  }
}

export default function RagDashboardPage() {
  const router = useRouter();
  const [modules, setModules] = useState<RagModuleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RagModuleView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const loadModules = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/rag/modules', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load RAG modules');
      const data = await res.json();
      setModules(data.modules ?? []);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load RAG modules',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadModules();
  }, [loadModules]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/rag/modules/${encodeURIComponent(deleteTarget.key)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error ?? 'Failed to delete module');
      }
      notifications.show({
        color: 'green',
        title: 'RAG module deleted',
        message: `${deleteTarget.name} has been removed.`,
      });
      setModules((prev) => prev.filter((m) => m.key !== deleteTarget.key));
      setDeleteTarget(null);
    } catch (error) {
      notifications.show({
        color: 'red',
        title: 'Unable to delete module',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleCreated = (ragModule: Record<string, unknown>) => {
    setCreateModalOpen(false);
    router.push(`/dashboard/rag/${encodeURIComponent(ragModule.key as string)}`);
  };

  const filtered = useMemo(() => {
    return modules.filter((m) => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !m.name.toLowerCase().includes(q) &&
          !m.key.toLowerCase().includes(q) &&
          !(m.description ?? '').toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [modules, query, statusFilter]);

  const totalDocs = modules.reduce((sum, m) => sum + (m.totalDocuments ?? 0), 0);
  const totalChunks = modules.reduce((sum, m) => sum + (m.totalChunks ?? 0), 0);
  const activeCount = modules.filter((m) => m.status === 'active').length;

  const columns: DataGridColumn<RagModuleView>[] = [
    {
      key: 'name',
      label: 'Module',
      render: (m) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {m.name}
          </span>
          <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>
            {m.key}
          </span>
        </div>
      ),
    },
    {
      key: 'strategy',
      label: 'Strategy',
      render: (m) => (
        <span className="ds-badge">{strategyLabel(m.chunkConfig.strategy)}</span>
      ),
    },
    {
      key: 'chunk',
      label: 'Chunk',
      render: (m) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {m.chunkConfig.chunkSize}/{m.chunkConfig.chunkOverlap}
        </span>
      ),
    },
    {
      key: 'documents',
      label: 'Documents',
      align: 'right',
      render: (m) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {m.totalDocuments ?? 0}
        </span>
      ),
    },
    {
      key: 'chunks',
      label: 'Chunks',
      align: 'right',
      render: (m) => (
        <span
          className="ds-mono"
          style={{ fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}
        >
          {m.totalChunks ?? 0}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (m) => (
        <StatusBadge status={m.status === 'active' ? 'active' : 'paused'} />
      ),
    },
    {
      key: 'created',
      label: 'Created',
      render: (m) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(m.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Data · Knowledge"
        title="Knowledge Engine"
        subtitle="Manage retrieval-augmented generation modules — ingest documents, query knowledge, and monitor usage."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={() => setCreateModalOpen(true)}
          >
            Create module
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total modules"
          icon={<IconBook2 size={14} stroke={1.7} />}
          value={modules.length}
        />
        <StatTile
          label="Active"
          icon={<IconPuzzle size={14} stroke={1.7} />}
          value={activeCount}
        />
        <StatTile
          label="Total documents"
          icon={<IconFileText size={14} stroke={1.7} />}
          value={totalDocs}
        />
        <StatTile
          label="Total chunks"
          icon={<IconDatabase size={14} stroke={1.7} />}
          value={totalChunks}
        />
      </div>

      <DataGrid<RagModuleView>
        records={filtered}
        loading={loading}
        rowKey={(m) => m.key}
        onRowClick={(m) =>
          router.push(`/dashboard/rag/${encodeURIComponent(m.key)}`)
        }
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
        onRefresh={loadModules}
        refreshing={refreshing}
        empty={{
          icon: <IconBook2 size={26} stroke={1.7} />,
          title: 'No RAG modules yet',
          description:
            'Create your first RAG module to start ingesting documents and querying knowledge.',
          primaryAction: {
            label: 'Create module',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: () => setCreateModalOpen(true),
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${modules.length} modules`}
        rowActions={(m) => [
          {
            id: 'open',
            label: 'Open module',
            icon: <IconBook2 size={14} />,
            onClick: () =>
              router.push(`/dashboard/rag/${encodeURIComponent(m.key)}`),
          },
          { divider: true },
          {
            id: 'delete',
            label: 'Delete',
            icon: <IconTrash size={14} />,
            color: 'red',
            onClick: () => setDeleteTarget(m),
          },
        ]}
      />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete RAG module"
        centered
        size="sm"
      >
        <Text size="sm" mb="lg">
          Delete RAG module <strong>{deleteTarget?.name}</strong>? This will remove
          the module and its index configuration. Documents in the vector index will
          not be deleted automatically.
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

      <CreateRagModuleModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleCreated}
      />
    </PageContainer>
  );
}
