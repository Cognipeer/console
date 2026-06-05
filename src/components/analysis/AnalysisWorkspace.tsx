'use client';

/**
 * Analysis workspace — renders one sub-section (definitions / conversations /
 * runs). The sub-sections live in the left service sub-nav
 * (`SUBNAV_CONFIG.analysis`), each as its own route, so this component is
 * mounted by the per-section page with the matching `section` prop instead of
 * switching in-page tabs.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconClipboardText,
  IconMessages,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconReportAnalytics,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import CreateDefinitionModal from '@/components/analysis/CreateDefinitionModal';
import IngestConversationsModal from '@/components/analysis/IngestConversationsModal';
import RunDefinitionModal, { type RunSelectionPayload } from '@/components/analysis/RunDefinitionModal';
import type {
  AnalysisConversationView,
  AnalysisDefinitionView,
  AnalysisRunView,
  ModelOption,
} from '@/components/analysis/types';

export type AnalysisSection = 'definitions' | 'conversations' | 'runs';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

function pct(value?: number | null): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

export default function AnalysisWorkspace({ section }: { section: AnalysisSection }) {
  const router = useRouter();
  const [definitions, setDefinitions] = useState<AnalysisDefinitionView[]>([]);
  const [conversations, setConversations] = useState<AnalysisConversationView[]>([]);
  const [runs, setRuns] = useState<AnalysisRunView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [definitionModal, setDefinitionModal] = useState(false);
  const [editDefinition, setEditDefinition] = useState<AnalysisDefinitionView | null>(null);
  const [runModalDef, setRunModalDef] = useState<AnalysisDefinitionView | null>(null);
  const [ingestModal, setIngestModal] = useState(false);
  const [deleteItem, setDeleteItem] = useState<{ kind: AnalysisSection; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadAll = async () => {
    setRefreshing(true);
    try {
      const [dRes, cRes, rRes, mRes] = await Promise.all([
        fetch('/api/analysis/definitions', { cache: 'no-store' }),
        fetch('/api/analysis/conversations', { cache: 'no-store' }),
        fetch('/api/analysis/runs', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);
      if (dRes.ok) setDefinitions((await dRes.json()).definitions ?? []);
      if (cRes.ok) setConversations((await cRes.json()).conversations ?? []);
      if (rRes.ok) setRuns((await rRes.json()).runs ?? []);
      if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
    } catch (err) {
      console.error('Failed to load analysis', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadRuns = async () => {
    const res = await fetch('/api/analysis/runs', { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Kick off a run with an explicit conversation selection (from the Run modal).
  // Returns the new run id (and navigates to its live view) or null on failure.
  const runWithSelection = async (definitionKey: string, selection: RunSelectionPayload): Promise<string | null> => {
    const res = await fetch(`/api/analysis/definitions/${encodeURIComponent(definitionKey)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selection }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      notifications.show({ title: 'Run failed', message: data.error || 'Run failed', color: 'red' });
      return null;
    }
    notifications.show({ title: 'Run started', message: 'Analysis is running in the background.', color: 'teal' });
    if (data.run?.id) {
      router.push(`/dashboard/analysis/runs/${data.run.id}`);
      return data.run.id as string;
    }
    await loadRuns();
    return null;
  };

  const confirmDelete = async () => {
    if (!deleteItem) return;
    const path = deleteItem.kind === 'definitions' ? 'definitions' : 'conversations';
    setDeleting(true);
    try {
      const res = await fetch(`/api/analysis/${path}/${deleteItem.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${deleteItem.name}" was deleted`, color: 'red' });
      setDeleteItem(null);
      await loadAll();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
    } finally {
      setDeleting(false);
    }
  };

  const definitionsCtl = useTableControls(definitions, {
    searchText: (d) => `${d.name} ${d.key} ${d.extractionModelKey ?? ''}`,
    searchPlaceholder: 'Filter by name, key, or model…',
  });
  const conversationsCtl = useTableControls(conversations, {
    searchText: (c) => `${c.name ?? ''} ${c.key} ${c.source} ${(c.tags ?? []).join(' ')}`,
    searchPlaceholder: 'Filter by name, key, source, or tag…',
  });
  const runsCtl = useTableControls(runs, {
    searchText: (r) => `${r.definitionKey} ${r.status}`,
    searchPlaceholder: 'Filter by definition or status…',
  });

  const definitionColumns: DataGridColumn<AnalysisDefinitionView>[] = [
    { key: 'name', label: 'Name', render: (d) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{d.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{d.key}</span>
      </div>
    ) },
    { key: 'fields', label: 'Fields', render: (d) => <span>{d.fieldSet.length}</span> },
    { key: 'modes', label: 'Modes', render: (d) => (
      <Group gap={4}>
        <span className="ds-badge ds-badge-info">extract</span>
        {d.modes.store ? <span className="ds-badge">store</span> : null}
        {d.modes.judge ? <span className="ds-badge ds-badge-teal">judge</span> : null}
        {d.modes.accuracy ? <span className="ds-badge ds-badge-teal">accuracy</span> : null}
      </Group>
    ) },
    { key: 'model', label: 'Extraction model', render: (d) => <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{d.extractionModelKey ?? '—'}</span> },
    { key: 'schedule', label: 'Schedule', render: (d) => (d.schedule?.enabled ? <span className="ds-badge ds-badge-teal ds-mono">{d.schedule.cron}</span> : <span className="ds-faint">—</span>) },
  ];

  const conversationColumns: DataGridColumn<AnalysisConversationView>[] = [
    { key: 'name', label: 'Name', render: (c) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{c.name || c.key}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{c.key}</span>
      </div>
    ) },
    { key: 'turns', label: 'Turns', render: (c) => <span>{c.transcript.length}</span> },
    { key: 'tags', label: 'Tags', render: (c) => (
      (c.tags ?? []).length > 0
        ? <Group gap={4}>{(c.tags ?? []).map((t) => <span key={t} className="ds-badge ds-badge-info">{t}</span>)}</Group>
        : <span className="ds-faint">—</span>
    ) },
    { key: 'source', label: 'Source', render: (c) => <span className="ds-badge">{c.source}</span> },
    { key: 'analyzed', label: 'Last analyzed', render: (c) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(c.lastAnalyzedAt)}</span> },
    { key: 'created', label: 'Ingested', render: (c) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(c.createdAt)}</span> },
  ];

  const runColumns: DataGridColumn<AnalysisRunView>[] = [
    { key: 'def', label: 'Definition', render: (r) => <span className="ds-mono" style={{ fontSize: 12 }}>{r.definitionKey}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'pass', label: 'Analyzed', render: (r) => <span>{r.aggregate ? `${r.aggregate.completed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'judge', label: 'Avg judge', render: (r) => <span>{pct(r.aggregate?.avgJudgeScore)}</span> },
    { key: 'acc', label: 'Avg accuracy', render: (r) => <span>{pct(r.aggregate?.avgExtractionAccuracy)}</span> },
    { key: 'created', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const actionButton = useMemo(() => {
    if (section === 'runs') return null;
    if (section === 'definitions') {
      return (
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={() => setDefinitionModal(true)}>
          New definition
        </Button>
      );
    }
    return (
      <Button color="teal" size="sm" leftSection={<IconUpload size={14} stroke={1.7} />} onClick={() => setIngestModal(true)}>
        Ingest conversations
      </Button>
    );
  }, [section]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis"
        title="Conversation Analysis"
        subtitle="Extract structured fields from conversations, judge quality against a rubric, and score accuracy against ground truth — then track results over runs."
        actions={actionButton}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Definitions" icon={<IconClipboardText size={14} stroke={1.7} />} value={definitions.length} />
        <StatTile label="Conversations" icon={<IconMessages size={14} stroke={1.7} />} value={conversations.length} />
        <StatTile label="Runs" icon={<IconReportAnalytics size={14} stroke={1.7} />} value={runs.length} />
        <StatTile label="Analyzed" value={conversations.filter((c) => c.lastAnalyzedAt).length} />
      </div>

      {section === 'definitions' && (
        <DataGrid<AnalysisDefinitionView>
          records={definitionsCtl.records}
          loading={loading}
          rowKey={(d) => d.id}
          columns={definitionColumns}
          search={definitionsCtl.search}
          pagination={definitionsCtl.pagination}
          footerLeft={definitionsCtl.footerLeft('definitions')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(d) => router.push(`/dashboard/analysis/definitions/${d.id}`)}
          empty={{
            icon: <IconClipboardText size={26} stroke={1.7} />,
            title: 'No definitions yet',
            description: 'A definition declares the fields to extract and which modes (judge / accuracy / store) to apply.',
            primaryAction: { label: 'New definition', icon: <IconPlus size={14} />, onClick: () => setDefinitionModal(true) },
          }}
          rowActions={(d) => [
            { id: 'run', label: 'Run analysis', icon: <IconPlayerPlay size={14} />, onClick: () => setRunModalDef(d) },
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditDefinition(d) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ kind: 'definitions', id: d.id, name: d.name }) },
          ]}
        />
      )}

      {section === 'conversations' && (
        <DataGrid<AnalysisConversationView>
          records={conversationsCtl.records}
          loading={loading}
          rowKey={(c) => c.id}
          columns={conversationColumns}
          search={conversationsCtl.search}
          pagination={conversationsCtl.pagination}
          footerLeft={conversationsCtl.footerLeft('conversations')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(c) => router.push(`/dashboard/analysis/conversations/${c.id}`)}
          empty={{
            icon: <IconMessages size={26} stroke={1.7} />,
            title: 'No conversations yet',
            description: 'Ingest transcripts (from an external export or platform traffic) to analyze them.',
            primaryAction: { label: 'Ingest conversations', icon: <IconUpload size={14} />, onClick: () => setIngestModal(true) },
          }}
          rowActions={(c) => [
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ kind: 'conversations', id: c.id, name: c.name || c.key }) },
          ]}
        />
      )}

      {section === 'runs' && (
        <DataGrid<AnalysisRunView>
          records={runsCtl.records}
          loading={loading}
          rowKey={(r) => r.id}
          columns={runColumns}
          search={runsCtl.search}
          pagination={runsCtl.pagination}
          footerLeft={runsCtl.footerLeft('runs')}
          onRowClick={(r) => router.push(`/dashboard/analysis/runs/${r.id}`)}
          onRefresh={loadAll}
          refreshing={refreshing}
          empty={{
            icon: <IconReportAnalytics size={26} stroke={1.7} />,
            title: 'No runs yet',
            description: 'Run a definition from the Definitions section to see results here.',
          }}
        />
      )}

      <Modal opened={deleteItem !== null} onClose={() => setDeleteItem(null)} title="Delete" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{deleteItem?.name}</strong>? This action cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteItem(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateDefinitionModal
        opened={definitionModal || !!editDefinition}
        editing={editDefinition}
        onClose={() => { setDefinitionModal(false); setEditDefinition(null); }}
        models={models}
        onCreated={() => void loadAll()}
      />
      <IngestConversationsModal opened={ingestModal} onClose={() => setIngestModal(false)} onIngested={() => void loadAll()} />
      <RunDefinitionModal
        opened={runModalDef !== null}
        definition={runModalDef}
        conversations={conversations}
        onClose={() => setRunModalDef(null)}
        onRun={runWithSelection}
      />
    </PageContainer>
  );
}
