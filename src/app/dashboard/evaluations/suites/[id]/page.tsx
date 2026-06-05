'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPencil, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateSuiteModal from '@/components/evaluations/CreateSuiteModal';
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  const runNow = async () => {
    if (!suite) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/evaluation/suites/${encodeURIComponent(suite.key)}/run`, { method: 'POST' });
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
    setDeleting(true);
    try {
      const res = await fetch(`/api/evaluation/suites/${suite.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${suite.name}" was deleted`, color: 'red' });
      router.push('/dashboard/evaluations/suites');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
      setDeleting(false);
    }
  };

  const runColumns: DataGridColumn<EvalRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'pass', label: 'Pass rate', render: (r) => <span>{r.aggregate ? `${r.aggregate.passed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'score', label: 'Avg score', render: (r) => <span>{r.aggregate ? pct(r.aggregate.avgScore) : '—'}</span> },
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
            <Button size="sm" color="teal" loading={running} leftSection={<IconPlayerPlay size={14} />} onClick={() => void runNow()}>
              {running ? 'Running…' : 'Run now'}
            </Button>
            <Button size="sm" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={suite.name} />
          <Row label="Key" value={suite.key} mono />
          <Row label="Target" value={targets.find((t) => t.key === suite.targetKey)?.name ?? suite.targetKey} mono />
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

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete suite" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{suite.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
