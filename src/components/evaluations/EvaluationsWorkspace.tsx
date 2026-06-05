'use client';

/**
 * Evaluations workspace — renders one sub-section (targets / datasets / suites /
 * runs / api). The sub-sections live in the left service sub-nav
 * (`SUBNAV_CONFIG.evaluations`), each as its own route, so this component is
 * mounted by the per-section page with the matching `section` prop instead of
 * switching in-page tabs.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChecklist,
  IconDatabase,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconRobot,
  IconTrash,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import CreateTargetModal from '@/components/evaluations/CreateTargetModal';
import CreateDatasetModal from '@/components/evaluations/CreateDatasetModal';
import CreateSuiteModal from '@/components/evaluations/CreateSuiteModal';
import EvaluationApiUsage from '@/components/evaluations/EvaluationApiUsage';
import type {
  EvalDatasetView,
  EvalRunView,
  EvalSuiteView,
  EvalTargetView,
  ModelOption,
} from '@/components/evaluations/types';

export type EvaluationSection = 'targets' | 'datasets' | 'suites' | 'runs' | 'api';

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

function pct(value?: number): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

export default function EvaluationsWorkspace({ section }: { section: EvaluationSection }) {
  const router = useRouter();
  const [targets, setTargets] = useState<EvalTargetView[]>([]);
  const [datasets, setDatasets] = useState<EvalDatasetView[]>([]);
  const [suites, setSuites] = useState<EvalSuiteView[]>([]);
  const [runs, setRuns] = useState<EvalRunView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const [targetModal, setTargetModal] = useState(false);
  const [datasetModal, setDatasetModal] = useState(false);
  const [suiteModal, setSuiteModal] = useState(false);
  const [editTarget, setEditTarget] = useState<EvalTargetView | null>(null);
  const [editSuite, setEditSuite] = useState<EvalSuiteView | null>(null);
  const [editDataset, setEditDataset] = useState<EvalDatasetView | null>(null);
  const [deleteItem, setDeleteItem] = useState<{ kind: EvaluationSection; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadAll = async () => {
    setRefreshing(true);
    try {
      const [tRes, dRes, sRes, rRes, mRes] = await Promise.all([
        fetch('/api/evaluation/targets', { cache: 'no-store' }),
        fetch('/api/evaluation/datasets', { cache: 'no-store' }),
        fetch('/api/evaluation/suites', { cache: 'no-store' }),
        fetch('/api/evaluation/runs', { cache: 'no-store' }),
        fetch('/api/models?category=llm', { cache: 'no-store' }),
      ]);
      if (tRes.ok) setTargets((await tRes.json()).targets ?? []);
      if (dRes.ok) setDatasets((await dRes.json()).datasets ?? []);
      if (sRes.ok) setSuites((await sRes.json()).suites ?? []);
      if (rRes.ok) setRuns((await rRes.json()).runs ?? []);
      if (mRes.ok) {
        setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      }
    } catch (err) {
      console.error('Failed to load evaluations', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadRuns = async () => {
    const res = await fetch('/api/evaluation/runs', { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Poll while any dataset is still generating in the background.
  const hasGenerating = datasets.some(
    (d) => d.metadata?.generation?.status === 'pending' || d.metadata?.generation?.status === 'running',
  );
  useEffect(() => {
    if (!hasGenerating) return;
    const timer = setInterval(() => { void loadAll(); }, 4000);
    return () => clearInterval(timer);
  }, [hasGenerating]);

  const runSuiteNow = async (suite: EvalSuiteView) => {
    setRunningKey(suite.key);
    try {
      const res = await fetch(`/api/evaluation/suites/${encodeURIComponent(suite.key)}/run`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Run failed');
      // Async: the run executes in the background. Jump to the run detail page,
      // which polls until it finishes.
      notifications.show({ title: 'Run started', message: 'Evaluation is running in the background.', color: 'teal' });
      if (data.run?.id) router.push(`/dashboard/evaluations/runs/${data.run.id}`);
      else await loadRuns();
    } catch (err) {
      notifications.show({ title: 'Run failed', message: err instanceof Error ? err.message : 'Run failed', color: 'red' });
    } finally {
      setRunningKey(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteItem) return;
    const path =
      deleteItem.kind === 'targets' ? 'targets' : deleteItem.kind === 'datasets' ? 'datasets' : 'suites';
    setDeleting(true);
    try {
      const res = await fetch(`/api/evaluation/${path}/${deleteItem.id}`, { method: 'DELETE' });
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

  const targetName = (key: string) => targets.find((t) => t.key === key)?.name ?? key;
  const datasetName = (key: string) => datasets.find((d) => d.key === key)?.name ?? key;

  const targetsCtl = useTableControls(targets, {
    searchText: (t) => `${t.name} ${t.key} ${t.kind} ${t.modelKey ?? ''} ${t.agentKey ?? ''}`,
    searchPlaceholder: 'Filter by name, key, or model…',
  });
  const datasetsCtl = useTableControls(datasets, {
    searchText: (d) => `${d.name} ${d.key} ${d.source}`,
    searchPlaceholder: 'Filter by name, key, or source…',
  });
  const suitesCtl = useTableControls(suites, {
    searchText: (s) => `${s.name} ${s.key} ${targetName(s.targetKey)} ${datasetName(s.datasetKey)}`,
    searchPlaceholder: 'Filter by name, target, or dataset…',
  });
  const runsCtl = useTableControls(runs, {
    searchText: (r) => `${r.suiteKey} ${r.status}`,
    searchPlaceholder: 'Filter by suite or status…',
  });

  const targetColumns: DataGridColumn<EvalTargetView>[] = [
    { key: 'name', label: 'Name', render: (t) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{t.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{t.key}</span>
      </div>
    ) },
    { key: 'kind', label: 'Kind', render: (t) => <span className="ds-badge ds-badge-info">{t.kind}</span> },
    { key: 'ref', label: 'Model / Agent', render: (t) => (
      <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>{t.modelKey ?? t.agentKey ?? '—'}</span>
    ) },
    { key: 'created', label: 'Created', render: (t) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(t.createdAt)}</span> },
  ];

  const datasetColumns: DataGridColumn<EvalDatasetView>[] = [
    { key: 'name', label: 'Name', render: (d) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{d.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{d.key}</span>
      </div>
    ) },
    { key: 'items', label: 'Items', render: (d) => {
      const gen = d.metadata?.generation;
      if (gen && (gen.status === 'pending' || gen.status === 'running')) {
        return <Group gap={6}><Loader size={12} /><span className="ds-faint" style={{ fontSize: 12 }}>Generating… (~{gen.requested})</span></Group>;
      }
      if (gen?.status === 'failed') {
        return <span className="ds-badge ds-badge-red" title={gen.error}>Failed</span>;
      }
      return <span>{d.items.length}</span>;
    } },
    { key: 'source', label: 'Source', render: (d) => <span className="ds-badge">{d.source}</span> },
    { key: 'created', label: 'Created', render: (d) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(d.createdAt)}</span> },
  ];

  const suiteColumns: DataGridColumn<EvalSuiteView>[] = [
    { key: 'name', label: 'Name', render: (s) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500, color: 'var(--ds-text)' }}>{s.name}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{s.key}</span>
      </div>
    ) },
    { key: 'target', label: 'Target', render: (s) => <span className="ds-muted" style={{ fontSize: 12 }}>{targetName(s.targetKey)}</span> },
    { key: 'dataset', label: 'Dataset', render: (s) => <span className="ds-muted" style={{ fontSize: 12 }}>{datasetName(s.datasetKey)}</span> },
    { key: 'scorers', label: 'Scorers', render: (s) => (
      <Group gap={4}>{s.scorers.map((sc) => <span key={sc.type} className="ds-badge ds-badge-teal">{sc.type}</span>)}</Group>
    ) },
  ];

  const runColumns: DataGridColumn<EvalRunView>[] = [
    { key: 'suite', label: 'Suite', render: (r) => <span className="ds-mono" style={{ fontSize: 12 }}>{r.suiteKey}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'pass', label: 'Pass rate', render: (r) => <span>{r.aggregate ? `${r.aggregate.passed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'score', label: 'Avg score', render: (r) => <span>{r.aggregate ? pct(r.aggregate.avgScore) : '—'}</span> },
    { key: 'created', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const actionButton = useMemo(() => {
    if (section === 'runs' || section === 'api') return null;
    const label = section === 'targets' ? 'New target' : section === 'datasets' ? 'New dataset' : 'New suite';
    const onClick = () => {
      if (section === 'targets') setTargetModal(true);
      else if (section === 'datasets') setDatasetModal(true);
      else setSuiteModal(true);
    };
    return (
      <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={onClick}>
        {label}
      </Button>
    );
  }, [section]);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations"
        title="Evaluations"
        subtitle="Offline testing for agents and models. Define targets and datasets, score them with assertions or an LLM judge, and track results over runs."
        actions={actionButton}
      />

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Targets" icon={<IconRobot size={14} stroke={1.7} />} value={targets.length} />
        <StatTile label="Datasets" icon={<IconDatabase size={14} stroke={1.7} />} value={datasets.length} />
        <StatTile label="Suites" icon={<IconChecklist size={14} stroke={1.7} />} value={suites.length} />
        <StatTile label="Runs" value={runs.length} />
      </div>

      {section === 'targets' && (
        <DataGrid<EvalTargetView>
          records={targetsCtl.records}
          loading={loading}
          rowKey={(t) => t.id}
          columns={targetColumns}
          search={targetsCtl.search}
          pagination={targetsCtl.pagination}
          footerLeft={targetsCtl.footerLeft('targets')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(t) => router.push(`/dashboard/evaluations/targets/${t.id}`)}
          empty={{
            icon: <IconRobot size={26} stroke={1.7} />,
            title: 'No targets yet',
            description: 'A target is the agent, model, or endpoint under test.',
            primaryAction: { label: 'New target', icon: <IconPlus size={14} />, onClick: () => setTargetModal(true) },
          }}
          rowActions={(t) => [
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditTarget(t) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ kind: 'targets', id: t.id, name: t.name }) },
          ]}
        />
      )}

      {section === 'datasets' && (
        <DataGrid<EvalDatasetView>
          records={datasetsCtl.records}
          loading={loading}
          rowKey={(d) => d.id}
          columns={datasetColumns}
          search={datasetsCtl.search}
          pagination={datasetsCtl.pagination}
          footerLeft={datasetsCtl.footerLeft('datasets')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(d) => router.push(`/dashboard/evaluations/datasets/${d.id}`)}
          empty={{
            icon: <IconDatabase size={26} stroke={1.7} />,
            title: 'No datasets yet',
            description: 'A dataset is a set of test cases (inputs and optional expectations).',
            primaryAction: { label: 'New dataset', icon: <IconPlus size={14} />, onClick: () => setDatasetModal(true) },
          }}
          rowActions={(d) => [
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditDataset(d) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ kind: 'datasets', id: d.id, name: d.name }) },
          ]}
        />
      )}

      {section === 'suites' && (
        <DataGrid<EvalSuiteView>
          records={suitesCtl.records}
          loading={loading}
          rowKey={(s) => s.id}
          columns={suiteColumns}
          search={suitesCtl.search}
          pagination={suitesCtl.pagination}
          footerLeft={suitesCtl.footerLeft('suites')}
          onRefresh={loadAll}
          refreshing={refreshing}
          onRowClick={(s) => router.push(`/dashboard/evaluations/suites/${s.id}`)}
          empty={{
            icon: <IconChecklist size={26} stroke={1.7} />,
            title: 'No suites yet',
            description: 'A suite binds a target to a dataset with one or more scorers.',
            primaryAction: { label: 'New suite', icon: <IconPlus size={14} />, onClick: () => setSuiteModal(true) },
          }}
          rowActions={(s) => [
            {
              id: 'run',
              label: runningKey === s.key ? 'Running…' : 'Run',
              icon: <IconPlayerPlay size={14} />,
              disabled: runningKey !== null,
              onClick: () => void runSuiteNow(s),
            },
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditSuite(s) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => setDeleteItem({ kind: 'suites', id: s.id, name: s.name }) },
          ]}
        />
      )}

      {section === 'runs' && (
        <DataGrid<EvalRunView>
          records={runsCtl.records}
          loading={loading}
          rowKey={(r) => r.id}
          columns={runColumns}
          search={runsCtl.search}
          pagination={runsCtl.pagination}
          footerLeft={runsCtl.footerLeft('runs')}
          onRowClick={(r) => router.push(`/dashboard/evaluations/runs/${r.id}`)}
          onRefresh={loadAll}
          refreshing={refreshing}
          empty={{
            icon: <IconPlayerPlay size={26} stroke={1.7} />,
            title: 'No runs yet',
            description: 'Run a suite from the Suites section to see results here.',
          }}
        />
      )}

      {section === 'api' && <EvaluationApiUsage suiteKey={suites[0]?.key} />}

      <Modal opened={deleteItem !== null} onClose={() => setDeleteItem(null)} title="Delete" centered size="sm">
        <Text size="sm" mb="lg">
          Delete <strong>{deleteItem?.name}</strong>? This action cannot be undone.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteItem(null)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={confirmDelete}>Delete</Button>
        </Group>
      </Modal>

      <CreateTargetModal
        opened={targetModal || !!editTarget}
        editing={editTarget}
        onClose={() => { setTargetModal(false); setEditTarget(null); }}
        models={models}
        onCreated={() => void loadAll()}
      />
      <CreateDatasetModal
        opened={datasetModal || !!editDataset}
        editing={editDataset}
        models={models}
        onClose={() => { setDatasetModal(false); setEditDataset(null); }}
        onCreated={() => void loadAll()}
      />
      <CreateSuiteModal
        opened={suiteModal || !!editSuite}
        editing={editSuite}
        onClose={() => { setSuiteModal(false); setEditSuite(null); }}
        targets={targets}
        datasets={datasets}
        models={models}
        onCreated={() => void loadAll()}
      />
    </PageContainer>
  );
}
