'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@mantine/core';
import {
  IconEdit,
  IconEye,
  IconHistory,
  IconPlus,
  IconTemplate,
  IconVariable,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import PromptEditorModal from '@/components/prompts/PromptEditorModal';
import { usePromptList, usePromptStats } from '@/lib/api/queries/prompts';
import type { PromptView } from '@/lib/services/prompts';

function formatDate(value?: string | Date) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function PromptsPage() {
  const promptsQuery = usePromptList();
  const statsQuery = usePromptStats();
  const prompts = useMemo<PromptView[]>(() => promptsQuery.data ?? [], [promptsQuery.data]);
  const dashboardData = statsQuery.data ?? null;
  // Only the first load shows the table's loading state; a background refetch (after a save) keeps the rows.
  const loading = promptsQuery.isPending;
  const dashboardLoading = statsQuery.isPending;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<PromptView | null>(null);
  const [query, setQuery] = useState('');
  const router = useRouter();

  const openCreateModal = () => {
    setEditingPrompt(null);
    setEditorOpen(true);
  };

  const openEditModal = (prompt: PromptView) => {
    setEditingPrompt(prompt);
    setEditorOpen(true);
  };

  // The editor saves through the mutation hooks, which refresh the list and its stats.
  const handleSaved = () => {
    setEditorOpen(false);
    setEditingPrompt(null);
  };

  const stalePromptCount = prompts.filter((prompt) => {
    const reference = prompt.updatedAt ?? prompt.createdAt;
    if (!reference) return false;
    const ts = new Date(reference).getTime();
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts > 30 * 24 * 60 * 60 * 1000;
  }).length;

  const filtered = useMemo(() => {
    if (!query) return prompts;
    const q = query.toLowerCase();
    return prompts.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q),
    );
  }, [prompts, query]);

  const columns: DataGridColumn<PromptView>[] = [
    {
      key: 'name',
      label: 'Prompt',
      render: (p) => (
        <div className="ds-col" style={{ gap: 2, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>
            {p.name}
          </span>
          {p.description ? (
            <span className="ds-faint" style={{ fontSize: 11.5, maxWidth: 320 }}>
              {p.description.length > 60
                ? `${p.description.slice(0, 60)}…`
                : p.description}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'key',
      label: 'Key',
      render: (p) => (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          {p.key}
        </span>
      ),
    },
    {
      key: 'version',
      label: 'Version',
      render: (p) => (
        <span className="ds-badge ds-badge-teal">v{p.currentVersion ?? 1}</span>
      ),
    },
    {
      key: 'updated',
      label: 'Updated',
      render: (p) => (
        <span className="ds-faint" style={{ fontSize: 12.5 }}>
          {formatDate(p.updatedAt ?? p.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Build · Prompts"
        title="Prompt Studio"
        subtitle="Organize prompt templates and reusable system instructions."
        actions={
          <Button
            color="teal"
            size="sm"
            leftSection={<IconPlus size={14} stroke={1.7} />}
            onClick={openCreateModal}
          >
            Create prompt
          </Button>
        }
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile
          label="Total prompts"
          icon={<IconTemplate size={14} stroke={1.7} />}
          value={
            dashboardLoading
              ? '—'
              : (dashboardData?.overview.totalPrompts ?? prompts.length)
          }
        />
        <StatTile
          label="Total versions"
          icon={<IconHistory size={14} stroke={1.7} />}
          value={
            dashboardLoading ? '—' : (dashboardData?.overview.totalVersions ?? '—')
          }
        />
        <StatTile
          label="Variable prompts"
          icon={<IconVariable size={14} stroke={1.7} />}
          value={
            dashboardLoading
              ? '—'
              : (dashboardData?.overview.totalVariablePrompts ?? '—')
          }
        />
        <StatTile
          label="Stale (30d+)"
          value={dashboardLoading ? '—' : stalePromptCount}
        />
      </div>

      <DataGrid<PromptView>
        records={filtered}
        loading={loading}
        rowKey={(p) => p.id}
        onRowClick={(p) => router.push(`/dashboard/prompts/${p.id}`)}
        columns={columns}
        search={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter by name, key, or description…',
        }}
        onRefresh={() => {
          void promptsQuery.refetch();
          void statsQuery.refetch();
        }}
        empty={{
          icon: <IconTemplate size={26} stroke={1.7} />,
          title: 'No prompts yet',
          description: 'Create your first prompt template to get started.',
          primaryAction: {
            label: 'Create prompt',
            icon: <IconPlus size={14} stroke={1.7} />,
            onClick: openCreateModal,
          },
        }}
        footerLeft={`Showing ${filtered.length} of ${prompts.length} prompts`}
        rowActions={(p) => [
          {
            id: 'view',
            label: 'View details',
            icon: <IconEye size={14} />,
            onClick: () => router.push(`/dashboard/prompts/${p.id}`),
          },
          {
            id: 'edit',
            label: 'Edit',
            icon: <IconEdit size={14} />,
            onClick: () => openEditModal(p),
          },
        ]}
      />

      <PromptEditorModal
        opened={editorOpen}
        onClose={() => setEditorOpen(false)}
        prompt={editingPrompt}
        onSaved={handleSaved}
      />
    </PageContainer>
  );
}
