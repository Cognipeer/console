'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useDeleteResource, ResourceUsageSection } from '@/components/common/confirm';
import { useTranslations } from '@/lib/i18n';
import { IconArrowLeft, IconPencil, IconPlayerPlay, IconTrash } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import CreateDefinitionModal from '@/components/analysis/CreateDefinitionModal';
import type { AnalysisDefinitionView, AnalysisRunView, CalibrationQuestionView, CalibrationView, ModelOption } from '@/components/analysis/types';
import { isDecisionType, pct as pctOf } from '@/components/analysis/decisionUi';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal', running: 'ds-badge-info', failed: 'ds-badge-err', pending: 'ds-badge', cancelled: 'ds-badge-warn',
};
function pct(value?: number | null): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}
/** Default flag threshold when the definition sets none (mirrors the engine). */
const DEFAULT_REVIEW_THRESHOLD = 0.7;

function sourceLabel(def: AnalysisDefinitionView): string {
  if (def.source?.kind === 'agent_sessions') return `Agent sessions · ${def.source.agentKeys.join(', ') || '—'}`;
  return 'Imported conversations';
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
  const deleteResource = useDeleteResource();
  const tq = useTranslations('common.confirm.qos');
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [def, setDef] = useState<AnalysisDefinitionView | null>(null);
  const [runs, setRuns] = useState<AnalysisRunView[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [running, setRunning] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [calibration, setCalibration] = useState<CalibrationView | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const loadRuns = async (definitionKey: string) => {
    const res = await fetch(`/api/analysis/runs?definitionKey=${encodeURIComponent(definitionKey)}`, { cache: 'no-store' });
    if (res.ok) setRuns((await res.json()).runs ?? []);
  };

  const loadCalibration = async (defId: string) => {
    const res = await fetch(`/api/analysis/definitions/${defId}/calibration`, { cache: 'no-store' });
    if (res.ok) setCalibration((await res.json()).calibration ?? null);
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
        if (d?.decisionModelKey) await loadCalibration(d.id);
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

  /** Set one question's flag threshold to the suggested value (the PATCH takes the whole field set). */
  const applyThreshold = async (q: CalibrationQuestionView) => {
    if (!def || q.suggestedThreshold === null) return;
    setApplying(q.key);
    try {
      const fieldSet = def.fieldSet.map((f) => (f.key === q.key ? { ...f, reviewBelow: q.suggestedThreshold as number } : f));
      const res = await fetch(`/api/analysis/definitions/${def.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldSet }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not apply the threshold');
      notifications.show({ title: 'Threshold updated', message: `${q.key} now flags answers below ${pctOf(q.suggestedThreshold)}.`, color: 'teal' });
      const d = await loadDef();
      if (d) await loadCalibration(d.id);
    } catch (err) {
      notifications.show({ title: 'Apply failed', message: err instanceof Error ? err.message : 'Apply failed', color: 'red' });
    } finally {
      setApplying(null);
    }
  };

  const onDelete = async () => {
    if (!def) return;
    const done = await deleteResource({
      noun: tq('nouns.analysisDefinition'),
      name: def.name,
      type: 'analysis-definition',
      id: def.id,
      action: async () => {
        const res = await fetch(`/api/analysis/definitions/${def.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(tq('deleteFailed'));
      },
    });
    if (!done) return;
    notifications.show({ title: 'Deleted', message: `"${def.name}" was deleted`, color: 'red' });
    router.push('/dashboard/analysis');
  };

  const runColumns: DataGridColumn<AnalysisRunView>[] = [
    { key: 'status', label: 'Status', render: (r) => <span className={`ds-badge ${RUN_STATUS_BADGE[r.status] ?? ''}`}>{r.status}</span> },
    { key: 'analyzed', label: 'Analyzed', render: (r) => <span>{r.aggregate ? `${r.aggregate.completed}/${r.aggregate.total} (${pct(r.aggregate.passRate)})` : '—'}</span> },
    { key: 'judge', label: 'Avg judge', render: (r) => <span>{pct(r.aggregate?.avgJudgeScore)}</span> },
    { key: 'acc', label: 'Avg accuracy', render: (r) => <span>{pct(r.aggregate?.avgExtractionAccuracy)}</span> },
    { key: 'started', label: 'Started', render: (r) => <span className="ds-faint" style={{ fontSize: 12 }}>{fmtDate(r.startedAt ?? r.createdAt)}</span> },
  ];

  const calibrationColumns: DataGridColumn<CalibrationQuestionView>[] = [
    { key: 'q', label: 'Question', render: (q) => <span className="ds-mono" style={{ fontSize: 12 }}>{q.key}</span> },
    { key: 'n', label: 'Reviewed', align: 'right', render: (q) => <span>{q.reviewed}</span> },
    { key: 'acc', label: 'Accuracy', align: 'right', render: (q) => <span>{pctOf(q.accuracy)}</span> },
    { key: 'conf', label: 'Avg confidence', align: 'right', render: (q) => <span>{pctOf(q.avgConfidence)}</span> },
    {
      key: 'err',
      label: 'ECE / MAE',
      align: 'right',
      render: (q) => <span title={q.type === 'score' ? 'Mean absolute error in levels' : 'Expected calibration error'}>{q.type === 'score' ? (q.mae === null || q.mae === undefined ? '—' : q.mae.toFixed(2)) : pctOf(q.ece)}</span>,
    },
    { key: 'th', label: 'Threshold', align: 'right', render: (q) => <span>{pctOf(q.threshold)}</span> },
    {
      key: 'sug',
      label: 'Suggested',
      align: 'right',
      render: (q) => {
        if (q.suggestedThreshold === null) return <span className="ds-faint">—</span>;
        const differs = Math.round(q.suggestedThreshold * 100) !== Math.round(q.threshold * 100);
        return (
          <Group gap={6} justify="flex-end" wrap="nowrap">
            <span>{pctOf(q.suggestedThreshold)}</span>
            {differs ? (
              <Button size="compact-xs" variant="light" loading={applying === q.key} onClick={() => void applyThreshold(q)}>Apply</Button>
            ) : null}
          </Group>
        );
      },
    },
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

  // With a decision model, Yes/No, Choice and Score fields are decided rather than extracted.
  const extracts = !def.decisionModelKey || def.fieldSet.some((f) => !isDecisionType(f.type));
  const modeLabels = [
    extracts ? 'extract' : null,
    def.decisionModelKey ? 'decide' : null,
    def.modes.store ? 'store' : null,
    def.modes.accuracy ? 'accuracy' : null,
    def.modes.judge ? 'judge' : null,
  ].filter(Boolean).join(', ');

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
            <Button size="sm" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => void onDelete()}>Delete</Button>
          </Group>
        }
      />

      <Paper withBorder radius="md" p="lg" maw={620} mb="lg">
        <Stack gap="sm">
          <Row label="Name" value={def.name} />
          <Row label="Key" value={def.key} mono />
          <Row label="Fields" value={def.fieldSet.map((f) => `${f.key}:${f.type}`).join(', ') || '—'} />
          <Row label="Modes" value={modeLabels} />
          <Row label="Source" value={sourceLabel(def)} />
          <Row label="Extraction model" value={def.extractionModelKey ?? '—'} mono />
          {def.decisionModelKey ? <Row label="Decision model" value={def.decisionModelKey} mono /> : null}
          {def.decisionModelKey ? <Row label="Review threshold" value={pctOf(def.review?.threshold ?? DEFAULT_REVIEW_THRESHOLD)} /> : null}
          {def.decisionModelKey ? <Row label="Spot-check" value={def.review?.spotCheckPct ? `${def.review.spotCheckPct}% of confident answers` : 'off'} /> : null}
          {def.modes.judge ? <Row label="Judge model" value={def.judgeModelKey ?? '—'} mono /> : null}
          {def.modes.judge ? <Row label="Judge rubric" value={def.modes.judge.rubric || '—'} /> : null}
          <Row label="Schedule" value={def.schedule?.enabled ? def.schedule.cron : 'manual'} mono />
          <Row label="Description" value={def.description || '—'} />
        </Stack>
      </Paper>

      {def.decisionModelKey ? (
        <Paper withBorder radius="md" p="lg" mb="lg">
          <Text fw={600} size="sm" mb={4}>Review quality</Text>
          {calibration && calibration.questions.some((q) => q.reviewed > 0) ? (
            <>
              <Text size="xs" c="dimmed" mb="sm">{calibration.reviewed} reviewed answers ({calibration.spotChecks} spot-checks)</Text>
              <DataGrid<CalibrationQuestionView>
                records={calibration.questions}
                rowKey={(q) => q.key}
                columns={calibrationColumns}
              />
            </>
          ) : (
            <Text size="sm" c="dimmed">Review some answers to see how often the model is right.</Text>
          )}
        </Paper>
      ) : null}

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


      <div style={{ marginTop: 16 }}>
        <ResourceUsageSection type="analysis-definition" id={def.id} />
      </div>
    </PageContainer>
  );
}
