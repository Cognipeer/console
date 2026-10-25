'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Menu, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { IconArrowLeft, IconChevronDown, IconPencil, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateSuiteModal from '@/components/evaluations/CreateSuiteModal';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { configVersionTag, runVersionTag } from '@/components/agents/agentVersionTag';
import { AGENT_TEST_ACCESS_HINT, useAgentTestAccess } from '@/components/agents/useAgentTestAccess';
import { useAgentVersionOptions } from '@/components/agents/useAgentVersionOptions';
import type { AgentRevision } from '@/lib/shared/agentRevision';
import type { EvalDatasetView, EvalRunView, EvalSuiteView, EvalTargetView, ModelOption } from '@/components/evaluations/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal', running: 'ds-badge-info', failed: 'ds-badge-err', pending: 'ds-badge', cancelled: 'ds-badge-warn',
};

function pct(value?: number): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}
function fmtDate(value?: string): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" style={{ minWidth: 160 }}>{label}</Text>
      <Text size="sm" className={mono ? 'ds-mono' : undefined} style={{ textAlign: 'right' }}>{value}</Text>
    </Group>
  );
}

export default function EvaluationSuiteDetailPage() {
  const router = useRouter();
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [suite, setSuite] = useState<EvalSuiteView | null>(null);
  const [runs, setRuns] = useState<EvalRunView[]>([]);
  const [targets, setTargets] = useState<EvalTargetView[]>([]);
  const [datasets, setDatasets] = useState<EvalDatasetView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const { canRunAgentTests } = useAgentTestAccess();
  const target = suite ? targets.find((t) => t.key === suite.targetKey) : undefined;
  const isAgentTarget = target?.kind === 'agent';
  // Running an agent suite needs Write on Agents; the server refuses it otherwise.
  const runBlocked = isAgentTarget && !canRunAgentTests;
  const agentVersions = useAgentVersionOptions(target?.agentKey, isAgentTarget && !runBlocked);

  const loadRuns = async (suiteKey: string) => {
    const res = await fetch(`/api/evaluation/runs?suiteKey=${encodeURIComponent(suiteKey)}`, { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  const loadSuite = async (): Promise<EvalSuiteView | null> => {
    if (!id) return null;
    const res = await fetch(`/api/evaluation/suites/${id}`, { cache: 'no-store' });
    if (res.status === 404) { setNotFound(true); return null; }
    if (!res.ok) return null;
    const s = (await res.json()).suite ?? null;
    setSuite(s);
    return s;
  };

  useEffect(() => {
    (async () => {
      try {
        const s = await loadSuite();
        if (s) await loadRuns(s.key);
        const [tRes, dRes, mRes] = await Promise.all([
          fetch('/api/evaluation/targets', { cache: 'no-store' }),
          fetch('/api/evaluation/datasets', { cache: 'no-store' }),
          fetch('/api/models?category=llm', { cache: 'no-store' }),
        ]);
        if (tRes.ok) setTargets((await tRes.json()).targets ?? []);
        if (dRes.ok) setDatasets((await dRes.json()).datasets ?? []);
        if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** No `revision` runs the target's default; one given overrides it for this run only. */
  const runNow = async (revision?: AgentRevision) => {
    if (!suite) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/evaluation/suites/${encodeURIComponent(suite.key)}/run`, {
        method: 'POST',
        ...(revision !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentVersion: revision }) }
          : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Run failed');
      notifications.show({ title: 'Run started', message: 'Evaluation is running in the background.', color: 'teal' });
      if (data.run?.id) router.push(`/dashboard/evaluations/runs/${data.run.id}`);
      else await loadRuns(suite.key);
    } catch (err) {
      notifications.show({ title: 'Run failed', message: err instanceof Error ? err.message : 'Run failed', color: 'red' });
    } finally {
      setRunning(false);
    }
  };

  const onDelete = async () => {
    if (!suite) return;
    const done = await deleteResource({
      noun: tq('nouns.evaluationSuite'),
      name: suite.name,
      type: 'evaluation-suite',
      id: suite.id,
      action: async () => {
        const res = await fetch(`/api/evaluation/suites/${suite.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: `"${suite.name}" was deleted`, color: 'red' });
    router.push('/dashboard/evaluations/suites');
  };

  const runColumns: DataGridColumn<EvalRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'pass', label: 'Pass rate', render: (r) => <span>{r.aggregate ? `${r.aggregate.passed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'score', label: 'Avg score', render: (r) => <span>{r.aggregate ? pct(r.aggregate.avgScore) : '—'}</span> },
    { key: 'agent', label: 'Agent', render: (r) => {
      const runTarget = targets.find((t) => t.key === r.targetKey);
      // The agent the run recorded; runs from before it was kept name the target's current agent.
      const agentKey = r.agentRevision?.agentKey ?? (runTarget?.kind === 'agent' ? runTarget.agentKey : undefined);
      const tag = runVersionTag(r.agentRevision);
      // A model or retrieval run has neither; a run from before the revision was recorded has the name alone.
      if (!agentKey && !tag) return <span className="ds-faint">—</span>;
      return (
        <span className="ds-mono ds-muted" style={{ fontSize: 12 }}>
          <AgentWithVersion name={agentKey} tag={tag} />
        </span>
      );
    } },
    { key: 'started', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/evaluations/suites')}>
      Back to suites
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !suite) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Evaluations" title="Suite not found" actions={backButton} />
        <Text c="dimmed" size="sm">This evaluation suite could not be found.</Text>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations · Suite"
        title={suite.name}
        subtitle={<span>Suite <span className="ds-mono">{suite.key}</span></span>}
        actions={
          <Group gap="xs">
            {backButton}
            {isAgentTarget && !runBlocked ? (
              <Button.Group>
                <Button size="sm" color="teal" loading={running} leftSection={<IconPlayerPlay size={14} />} onClick={() => void runNow()}>
                  {running ? 'Running…' : 'Run now'}
                </Button>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Button size="sm" color="teal" px={8} disabled={running} aria-label="Run on another agent version">
                      <IconChevronDown size={14} />
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Run once on…</Menu.Label>
                    <Menu.Item onClick={() => void runNow('published')}>
                      Published version{agentVersions.publishedVersion != null ? ` (v${agentVersions.publishedVersion})` : ''}
                    </Menu.Item>
                    <Menu.Item onClick={() => void runNow('draft')}>Draft</Menu.Item>
                    {agentVersions.versions.length > 0 ? <Menu.Divider /> : null}
                    {agentVersions.versions.map((entry) => (
                      <Menu.Item key={entry.version} onClick={() => void runNow(entry.version)}>
                        v{entry.version}{entry.published ? ' · published' : ''}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              </Button.Group>
            ) : (
              <Tooltip label={AGENT_TEST_ACCESS_HINT} disabled={!runBlocked} withArrow multiline w={240}>
                {/* `data-disabled`, not `disabled`: a native one swallows the hover the tooltip needs. */}
                <Button
                  size="sm"
                  color="teal"
                  loading={running}
                  leftSection={<IconPlayerPlay size={14} />}
                  data-disabled={runBlocked || undefined}
                  aria-disabled={runBlocked || undefined}
                  onClick={runBlocked ? (event) => event.preventDefault() : () => void runNow()}
                >
                  {running ? 'Running…' : 'Run now'}
                </Button>
              </Tooltip>
            )}
            <Button size="sm" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => void onDelete()}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={suite.name} />
          <Row label="Key" value={suite.key} mono />
          <Row label="Target" value={target?.name ?? suite.targetKey} mono />
          {target?.kind === 'agent' ? (
            <Row label="Agent" value={<AgentWithVersion name={target.agentKey ?? '—'} tag={configVersionTag(target.agentVersion)} />} mono />
          ) : null}
          <Row label="Dataset" value={datasets.find((d) => d.key === suite.datasetKey)?.name ?? suite.datasetKey} mono />
          <Row label="Scorers" value={<Group gap={4} justify="flex-end">{suite.scorers.map((s) => <span key={s.type} className="ds-badge ds-badge-teal">{s.type}</span>)}</Group>} />
          {suite.judgeModelKey ? <Row label="Judge model" value={suite.judgeModelKey} mono /> : null}
          {suite.embeddingModelKey ? <Row label="Embedding model" value={suite.embeddingModelKey} mono /> : null}
          <Row label="Description" value={suite.description || '—'} />
        </Stack>
      </Paper>

      <Text fw={600} size="sm" mb="xs">Runs for this suite</Text>
      <DataGrid<EvalRunView>
        records={runs}
        rowKey={(r) => r.id}
        columns={runColumns}
        onRowClick={(r) => router.push(`/dashboard/evaluations/runs/${r.id}`)}
        empty={{ icon: <IconPlayerPlay size={26} stroke={1.7} />, title: 'No runs yet', description: 'Run this suite to see results here.' }}
      />

      <CreateSuiteModal
        opened={editOpen}
        editing={suite}
        targets={targets}
        datasets={datasets}
        models={models}
        onClose={() => setEditOpen(false)}
        onCreated={(s) => { setSuite(s); setEditOpen(false); }}
      />


      <div style={{ marginTop: 16 }}>
        <ResourceUsageSection type="evaluation-suite" id={suite.id} />
      </div>
    </PageContainer>
  );
}
