'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Text } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import type { AnalysisRunItemView, AnalysisRunView } from '@/components/analysis/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

function pct(value?: number | null): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

function fieldsSummary(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return '—';
  return entries.map(([k, v]) => `${k}=${v === null || v === undefined ? '∅' : String(v)}`).join(', ');
}

export default function AnalysisRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<AnalysisRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/analysis/runs/${runId}`, { cache: 'no-store' });
        if (res.status === 404) { if (!cancelled) setNotFound(true); return; }
        const data = await res.json();
        if (!cancelled) setRun(data.run ?? null);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runId]);

  const itemColumns: DataGridColumn<AnalysisRunItemView>[] = [
    { key: 'conv', label: 'Conversation', render: (i) => <span className="ds-mono" style={{ fontSize: 12 }}>{i.conversationKey}</span> },
    {
      key: 'result',
      label: 'Result',
      render: (i) =>
        i.error
          ? <span className="ds-badge ds-badge-err">error</span>
          : <span className={`ds-badge ${i.passed ? 'ds-badge-teal' : 'ds-badge-warn'}`}>{i.passed ? 'pass' : i.missing.length ? `missing ${i.missing.length}` : 'fail'}</span>,
    },
    { key: 'fields', label: 'Extracted', render: (i) => <span className="ds-muted" style={{ fontSize: 12 }} title={fieldsSummary(i.extractedFields)}>{i.error ? i.error : fieldsSummary(i.extractedFields)}</span> },
    { key: 'judge', label: 'Judge', render: (i) => (i.judge ? <span className={`ds-badge ${i.judge.error ? 'ds-badge-err' : i.judge.passed ? 'ds-badge-teal' : 'ds-badge-warn'}`}>{i.judge.error ? 'err' : pct(i.judge.score)}</span> : <span className="ds-faint">—</span>) },
    { key: 'acc', label: 'Accuracy', render: (i) => (i.accuracy && i.accuracy.comparedCount > 0 ? <span className={`ds-badge ${i.accuracy.score === 1 ? 'ds-badge-teal' : i.accuracy.score === 0 ? 'ds-badge-err' : 'ds-badge-warn'}`}>{pct(i.accuracy.score)}</span> : <span className="ds-faint">—</span>) },
  ];

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/analysis')}>
      Back to analysis
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }

  if (notFound || !run) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Analysis" title="Run not found" actions={backButton} />
        <Text c="dimmed" size="sm">This analysis run could not be found.</Text>
      </PageContainer>
    );
  }

  const agg = run.aggregate;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis · Run"
        title={run.definitionKey}
        subtitle={<span><span className={`ds-badge ${RUN_STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span></span>}
        actions={backButton}
      />

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>{run.error}</div>
      ) : null}

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Analyzed" value={agg ? `${agg.completed}/${agg.total} (${pct(agg.passRate)})` : '—'} />
        <StatTile label="Avg judge score" value={pct(agg?.avgJudgeScore)} />
        <StatTile label="Avg accuracy" value={pct(agg?.avgExtractionAccuracy)} />
        <StatTile label="Failed (errored)" value={agg ? agg.failed : '—'} />
      </div>

      <DataGrid<AnalysisRunItemView>
        records={run.items}
        rowKey={(i) => i.conversationKey}
        columns={itemColumns}
        footerLeft={`${run.items.length} conversations`}
        empty={{ title: 'No items', description: 'This run produced no conversation results.' }}
      />
    </PageContainer>
  );
}
