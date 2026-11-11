'use client';

/**
 * Evaluations workspace — renders one sub-section (targets / datasets / suites /
 * runs / api). The sub-sections live in the left service sub-nav
 * (`SUBNAV_CONFIG.evaluations`), each as its own route, so this component is
 * mounted by the per-section page with the matching `section` prop instead of
 * switching in-page tabs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import {
  IconCamera,
  IconChecklist,
  IconDatabase,
  IconFileImport,
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
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag, runVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import CreateTargetModal from '@/components/evaluations/CreateTargetModal';
import CreateDatasetModal from '@/components/evaluations/CreateDatasetModal';
import CreateSuiteModal from '@/components/evaluations/CreateSuiteModal';
import EvaluationApiUsage from '@/components/evaluations/EvaluationApiUsage';
import {
  RUN_LIST_MAX,
  RUN_PAGE_SIZE,
  appendRunPage,
  deriveErrorRate,
  isRunActive,
  readErrorMessage,
  refreshRunList,
  runRefreshLimit,
  scoredCount,
} from '@/components/evaluations/runViewHelpers';
import type {
  EvalDatasetView,
  EvalRunView,
  EvalSuiteView,
  EvalTargetView,
  ModelOption,
} from '@/components/evaluations/types';

export type EvaluationSection = 'targets' | 'datasets' | 'suites' | 'runs' | 'api';

type ListName = 'targets' | 'datasets' | 'suites' | 'runs';
type LoadErrors = Partial<Record<ListName, string>>;

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
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const [targets, setTargets] = useState<EvalTargetView[]>([]);
  const [datasets, setDatasets] = useState<EvalDatasetView[]>([]);
  const [suites, setSuites] = useState<EvalSuiteView[]>([]);
  const [runs, setRuns] = useState<EvalRunView[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  // How many runs are on screen, for refreshes that run from timers (a closure would see a stale count).
  const runsLoadedRef = useRef(0);
  // One message per failed list, so a 500 never reads as "nothing here yet".
  const [loadErrors, setLoadErrors] = useState<LoadErrors>({});
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const { canRunAgentTests } = useAgentTestAccess();

  const [targetModal, setTargetModal] = useState(false);
  const [datasetModal, setDatasetModal] = useState(false);
  const [suiteModal, setSuiteModal] = useState(false);
  const [editTarget, setEditTarget] = useState<EvalTargetView | null>(null);
  const [editSuite, setEditSuite] = useState<EvalSuiteView | null>(null);
  const [editDataset, setEditDataset] = useState<EvalDatasetView | null>(null);

  const setListError = (name: ListName, message: string | null) => {
    setLoadErrors((prev) => {
      if ((prev[name] ?? null) === message) return prev;
      const next = { ...prev };
      if (message === null) delete next[name];
      else next[name] = message;
      return next;
    });
  };

  /** Re-reads every run already on screen (summaries: items are left out by the server). */
  const loadRuns = async () => {
    const limit = runRefreshLimit(runsLoadedRef.current);
    try {
      const res = await fetch(`/api/evaluation/runs?limit=${limit}`, { cache: 'no-store' });
      if (!res.ok) {
        setListError('runs', await readErrorMessage(res, 'Could not load runs'));
        return;
      }
      const data = await res.json();
      const page: EvalRunView[] = data.runs ?? [];
      setRuns((prev) => refreshRunList(prev, page, limit));
      setRunsTotal(typeof data.total === 'number' ? data.total : page.length);
      setListError('runs', null);
    } catch (err) {
      setListError('runs', err instanceof Error ? err.message : 'Could not load runs');
    }
  };

  const loadMoreRuns = async () => {
    setLoadingMoreRuns(true);
    try {
      const res = await fetch(`/api/evaluation/runs?limit=${RUN_PAGE_SIZE}&skip=${runs.length}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await readErrorMessage(res, 'Could not load more runs'));
      const data = await res.json();
      setRuns((prev) => appendRunPage(prev, data.runs ?? []));
      if (typeof data.total === 'number') setRunsTotal(data.total);
    } catch (err) {
      notifications.show({ title: 'Could not load more runs', message: err instanceof Error ? err.message : 'Request failed', color: 'red' });
    } finally {
      setLoadingMoreRuns(false);
    }
  };

  const loadAll = async () => {
    setRefreshing(true);
    // A failed refresh must not wipe what is already on screen: only replace a list on success.
    const fetchList = async <T,>(name: Exclude<ListName, 'runs'>, url: string, pick: (body: Record<string, unknown>) => T[], set: (v: T[]) => void) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          setListError(name, await readErrorMessage(res, `Could not load ${name}`));
          return;
        }
        set(pick(await res.json()));
        setListError(name, null);
      } catch (err) {
        console.error(`Failed to load ${name}`, err);
        setListError(name, err instanceof Error ? err.message : `Could not load ${name}`);
      }
    };
    try {
      await Promise.all([
        fetchList('targets', '/api/evaluation/targets', (b) => (b.targets as EvalTargetView[]) ?? [], setTargets),
        fetchList('datasets', '/api/evaluation/datasets', (b) => (b.datasets as EvalDatasetView[]) ?? [], setDatasets),
        fetchList('suites', '/api/evaluation/suites', (b) => (b.suites as EvalSuiteView[]) ?? [], setSuites),
        loadRuns(),
        (async () => {
          try {
            const mRes = await fetch('/api/models?category=llm', { cache: 'no-store' });
            if (mRes.ok) {
              setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
            }
          } catch (err) {
            console.error('Failed to load models', err);
          }
        })(),
      ]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  // Poll while any dataset is still being built in the background
  // (generation or traffic-snapshot job).
  const hasGenerating = datasets.some((d) => {
    const gen = d.metadata?.generation?.status;
    const snap = (d.metadata?.snapshot as { status?: string } | undefined)?.status;
    return gen === 'pending' || gen === 'running' || snap === 'pending' || snap === 'running';
  });
  useEffect(() => {
    if (!hasGenerating) return;
    const timer = setInterval(() => { void loadAll(); }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasGenerating]);

  // Runs execute in the background: keep the list fresh while any listed run is queued or running.
  useEffect(() => {
    runsLoadedRef.current = runs.length;
  }, [runs.length]);

  // Only the rows a refresh re-reads count: a run past that window would keep the timer alive forever.
  const hasActiveRuns = runs.slice(0, RUN_LIST_MAX).some((r) => isRunActive(r.status));
  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = setInterval(() => { void loadRuns(); }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActiveRuns]);

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

  const confirmDelete = async (item: { kind: EvaluationSection; id: string; name: string }) => {
    const path = item.kind === 'targets' ? 'targets' : item.kind === 'datasets' ? 'datasets' : 'suites';
    const kinds = {
      targets: { noun: 'evaluationTarget', type: 'evaluation-target' },
      datasets: { noun: 'evaluationDataset', type: 'evaluation-dataset' },
      suites: { noun: 'evaluationSuite', type: 'evaluation-suite' },
    } as const;
    const kind = kinds[path];
    const done = await deleteResource({
      noun: tq(`nouns.${kind.noun}`),
      name: item.name,
      type: kind.type,
      id: item.id,
      action: async () => {
        const res = await fetch(`/api/evaluation/${path}/${item.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: `"${item.name}" was deleted`, color: 'red' });
    await loadAll();
  };

  const targetByKey = (key: string) => targets.find((t) => t.key === key);
  const targetName = (key: string) => targetByKey(key)?.name ?? key;
  /** Running an agent suite needs Write on Agents; the server refuses it otherwise. */
  const agentRunBlocked = (suite: EvalSuiteView) => !canRunAgentTests && targetByKey(suite.targetKey)?.kind === 'agent';
  const datasetName = (key: string) => datasets.find((d) => d.key === key)?.name ?? key;

  const targetsCtl = useTableControls(targets, {
    searchText: (t) => `${t.name} ${t.key} ${t.kind} ${t.modelKey ?? ''} ${t.agentKey ?? ''} ${t.ragModuleKey ?? ''}`,
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
    { key: 'ref', label: 'Reference', render: (t) => (
      <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
        {t.kind === 'agent'
          ? <AgentWithVersion name={t.agentKey ?? '—'} tag={configVersionTag(t.agentVersion)} />
          : t.modelKey ?? t.ragModuleKey ?? '—'}
      </span>
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
        return <span className="ds-badge ds-badge-err" title={gen.error}>Failed</span>;
      }
      const snap = d.metadata?.snapshot as { status?: string; error?: string } | undefined;
      if (snap && (snap.status === 'pending' || snap.status === 'running')) {
        return <Group gap={6}><Loader size={12} /><span className="ds-faint" style={{ fontSize: 12 }}>Snapshotting…</span></Group>;
      }
      if (snap?.status === 'failed') {
        return <span className="ds-badge ds-badge-err" title={snap.error}>Failed</span>;
      }
      return <span>{d.itemCount}</span>;
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
    { key: 'target', label: 'Target', render: (s) => {
      const target = targetByKey(s.targetKey);
      return (
        <span className="ds-muted" style={{ fontSize: 12 }}>
          <AgentWithVersion name={targetName(s.targetKey)} tag={target?.kind === 'agent' ? configVersionTag(target.agentVersion) : null} />
        </span>
      );
    } },
    { key: 'dataset', label: 'Dataset', render: (s) => <span className="ds-muted" style={{ fontSize: 12 }}>{datasetName(s.datasetKey)}</span> },
    { key: 'scorers', label: 'Scorers', render: (s) => (
      <Group gap={4}>{s.scorers.map((sc) => <span key={sc.type} className="ds-badge ds-badge-teal">{sc.type}</span>)}</Group>
    ) },
  ];

  // Cost is only recorded when the target's provider reports usage — hide the
  // column entirely when no listed run carries it, instead of an all-dash column.
  const anyRunHasCost = runs.some((r) => r.aggregate?.totalCostUsd != null);
  const runColumns: DataGridColumn<EvalRunView>[] = [
    { key: 'suite', label: 'Suite', render: (r) => <span className="ds-mono" style={{ fontSize: 12 }}>{r.suiteKey}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'pass', label: 'Pass rate', render: (r) => (
      <span title="Pass rate excludes errored and skipped items.">
        {r.aggregate ? `${r.aggregate.passed}/${scoredCount(r.aggregate)} (${pct(r.aggregate.passRate)})` : '—'}
        {r.aggregate && r.aggregate.failed > 0 ? (
          <span className="ds-faint" style={{ fontSize: 11 }}>{` · ${r.aggregate.failed} errored (${pct(deriveErrorRate(r.aggregate))})`}</span>
        ) : null}
      </span>
    ) },
    { key: 'score', label: 'Avg score', render: (r) => <span>{r.aggregate ? pct(r.aggregate.avgScore) : '—'}</span> },
    ...(anyRunHasCost
      ? [{
          key: 'cost',
          label: 'Cost',
          render: (r: EvalRunView) => (
            <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
              {r.aggregate?.totalCostUsd != null ? `$${r.aggregate.totalCostUsd.toFixed(4)}` : '—'}
            </span>
          ),
        } satisfies DataGridColumn<EvalRunView>]
      : []),
    { key: 'agent', label: 'Agent', render: (r) => {
      const target = targetByKey(r.targetKey);
      // The agent the run recorded; runs from before it was kept name the target's current agent.
      const agentKey = r.agentRevision?.agentKey ?? (target?.kind === 'agent' ? target.agentKey : undefined);
      const tag = runVersionTag(r.agentRevision);
      // A model or retrieval run has neither; a run from before the revision was recorded has the name alone.
      if (!agentKey && !tag) return <span className="ds-faint">—</span>;
      return (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          <AgentWithVersion name={agentKey} tag={tag} />
        </span>
      );
    } },
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
      <Group gap="xs">
        {section === 'datasets' && (
          <>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconFileImport size={14} stroke={1.7} />}
              onClick={() => router.push('/dashboard/evaluations/datasets/import')}
            >
              Import
            </Button>
            <Button
              variant="default"
              size="sm"
              leftSection={<IconCamera size={14} stroke={1.7} />}
              onClick={() => router.push('/dashboard/evaluations/snapshots/new')}
            >
              Create from traffic
            </Button>
          </>
        )}
        <Button color="teal" size="sm" leftSection={<IconPlus size={14} stroke={1.7} />} onClick={onClick}>
          {label}
        </Button>
      </Group>
    );
  }, [section, router]);

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
        <StatTile label="Runs" value={Math.max(runsTotal, runs.length)} />
      </div>

      {/* Per-list load error: shown instead of the empty state, with a retry. */}
      {section !== 'api' && loadErrors[section] && ((): boolean => {
        const list = section === 'targets' ? targets : section === 'datasets' ? datasets : section === 'suites' ? suites : runs;
        return list.length === 0;
      })() ? (
        <Alert color="red" variant="light" mb="md" title={`Could not load ${section}`}>
          <Group justify="space-between" wrap="nowrap">
            <span>{loadErrors[section]}</span>
            <Button size="xs" variant="default" loading={refreshing} onClick={() => void loadAll()}>Retry</Button>
          </Group>
        </Alert>
      ) : null}

      {section === 'targets' && !(loadErrors.targets && targets.length === 0) && (
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
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => void confirmDelete({ kind: 'targets', id: t.id, name: t.name }) },
          ]}
        />
      )}

      {section === 'datasets' && !(loadErrors.datasets && datasets.length === 0) && (
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
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => void confirmDelete({ kind: 'datasets', id: d.id, name: d.name }) },
          ]}
        />
      )}

      {section === 'suites' && !(loadErrors.suites && suites.length === 0) && (
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
              disabled: runningKey !== null || agentRunBlocked(s),
              disabledReason: agentRunBlocked(s) ? AGENT_TEST_ACCESS_HINT : undefined,
              onClick: () => void runSuiteNow(s),
            },
            { id: 'edit', label: 'Edit', icon: <IconPencil size={14} />, onClick: () => setEditSuite(s) },
            { divider: true },
            { id: 'delete', label: 'Delete', icon: <IconTrash size={14} />, color: 'red', onClick: () => void confirmDelete({ kind: 'suites', id: s.id, name: s.name }) },
          ]}
        />
      )}

      {section === 'runs' && !(loadErrors.runs && runs.length === 0) && (
        <>
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
        {runs.length < runsTotal ? (
          <Group justify="center" mt="sm">
            <Button size="xs" variant="default" loading={loadingMoreRuns} onClick={() => void loadMoreRuns()}>
              Load more ({runs.length} of {runsTotal})
            </Button>
          </Group>
        ) : null}
        </>
      )}

      {section === 'api' && <EvaluationApiUsage suiteKey={suites[0]?.key} />}

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
