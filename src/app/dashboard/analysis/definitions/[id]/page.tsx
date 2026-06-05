'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconPencil, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateDefinitionModal from '@/components/analysis/CreateDefinitionModal';
import type { AnalysisDefinitionView, AnalysisRunView, ModelOption } from '@/components/analysis/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal', running: 'ds-badge-info', failed: 'ds-badge-err', pending: 'ds-badge', cancelled: 'ds-badge-warn',
};
function pct(value?: number | null): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
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

export default function AnalysisDefinitionDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [def, setDef] = useState<AnalysisDefinitionView | null>(null);
  const [runs, setRuns] = useState<AnalysisRunView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadRuns = async (definitionKey: string) => {
    const res = await fetch(`/api/analysis/runs?definitionKey=${encodeURIComponent(definitionKey)}`, { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  const loadDef = async (): Promise<AnalysisDefinitionView | null> => {
    if (!id) return null;
    const res = await fetch(`/api/analysis/definitions/${id}`, { cache: 'no-store' });
    if (res.status === 404) { setNotFound(true); return null; }
    if (!res.ok) return null;
    const d = (await res.json()).definition ?? null;
    setDef(d);
    return d;
  };

  useEffect(() => {
    (async () => {
      try {
        const d = await loadDef();
        if (d) await loadRuns(d.key);
        const mRes = await fetch('/api/models?category=llm', { cache: 'no-store' });
        if (mRes.ok) setModels(((await mRes.json()).models ?? []).map((m: { key: string; name: string }) => ({ value: m.key, label: m.name })));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const runNow = async () => {
    if (!def) return;
    setRunning(true);
    try {
      const res = await fetch(`/api/analysis/definitions/${encodeURIComponent(def.key)}/run`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Run failed');
      notifications.show({ title: 'Run started', message: 'Analysis is running in the background.', color: 'teal' });
      if (data.run?.id) router.push(`/dashboard/analysis/runs/${data.run.id}`);
      else await loadRuns(def.key);
    } catch (err) {
      notifications.show({ title: 'Run failed', message: err instanceof Error ? err.message : 'Run failed', color: 'red' });
    } finally {
      setRunning(false);
    }
  };

  const onDelete = async () => {
    if (!def) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/analysis/definitions/${def.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete');
      notifications.show({ title: 'Deleted', message: `"${def.name}" was deleted`, color: 'red' });
      router.push('/dashboard/analysis');
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Failed to delete', color: 'red' });
      setDeleting(false);
    }
  };

  const runColumns: DataGridColumn<AnalysisRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'analyzed', label: 'Analyzed', render: (r) => <span>{r.aggregate ? `${r.aggregate.completed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'judge', label: 'Avg judge', render: (r) => <span>{pct(r.aggregate?.avgJudgeScore)}</span> },
    { key: 'acc', label: 'Avg accuracy', render: (r) => <span>{pct(r.aggregate?.avgExtractionAccuracy)}</span> },
    { key: 'started', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/analysis')}>
      Back to analysis
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !def) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Analysis" title="Definition not found" actions={backButton} />
        <Text c="dimmed" size="sm">This analysis definition could not be found.</Text>
      </PageContainer>
    );
  }

  const modeLabels = ['extract', def.modes.store ? 'store' : null, def.modes.accuracy ? 'accuracy' : null, def.modes.judge ? 'judge' : null].filter(Boolean).join(', ');

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis · Definition"
        title={def.name}
        subtitle={<span>Definition <span className="ds-mono">{def.key}</span></span>}
        actions={
          <Group gap="xs">
            {backButton}
            <Button size="sm" color="teal" loading={running} leftSection={<IconPlayerPlay size={14} />} onClick={() => void runNow()}>
              {running ? 'Running…' : 'Run analysis'}
            </Button>
            <Button size="sm" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditOpen(true)}>Edit</Button>
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => setDeleteOpen(true)}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={def.name} />
          <Row label="Key" value={def.key} mono />
          <Row label="Fields" value={def.fieldSet.map((f) => `${f.key}:${f.type}`).join(', ') || '—'} />
          <Row label="Modes" value={modeLabels} />
          <Row label="Extraction model" value={def.extractionModelKey ?? '—'} mono />
          {def.modes.judge ? <Row label="Judge model" value={def.judgeModelKey ?? '—'} mono /> : null}
          {def.modes.judge ? <Row label="Judge rubric" value={def.modes.judge.rubric || '—'} /> : null}
          <Row label="Schedule" value={def.schedule?.enabled ? def.schedule.cron : 'manual'} mono />
          <Row label="Description" value={def.description || '—'} />
        </Stack>
      </Paper>

      <Text fw={600} size="sm" mb="xs">Runs for this definition</Text>
      <DataGrid<AnalysisRunView>
        records={runs}
        rowKey={(r) => r.id}
        columns={runColumns}
        onRowClick={(r) => router.push(`/dashboard/analysis/runs/${r.id}`)}
        empty={{ icon: <IconPlayerPlay size={26} stroke={1.7} />, title: 'No runs yet', description: 'Run this definition to see results here.' }}
      />

      <CreateDefinitionModal
        opened={editOpen}
        editing={def}
        models={models}
        onClose={() => setEditOpen(false)}
        onCreated={(d) => { setDef(d); setEditOpen(false); }}
      />

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete definition" centered size="sm">
        <Text size="sm" mb="lg">Delete <strong>{def.name}</strong>? This cannot be undone.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button color="red" loading={deleting} onClick={() => void onDelete()}>Delete</Button>
        </Group>
      </Modal>
    </PageContainer>
  );
}
