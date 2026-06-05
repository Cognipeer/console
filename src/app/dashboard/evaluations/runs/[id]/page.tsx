'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Paper, Progress, Text } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import type { EvalRunItemView, EvalRunView } from '@/components/evaluations/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

function pct(value?: number): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

export default function EvaluationRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<EvalRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/evaluation/runs/${runId}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data = await res.json();
        const r = data.run ?? null;
        if (cancelled) return;
        setRun(r);
        // Keep polling while the run is still being processed in the background.
        if (r && (r.status === 'pending' || r.status === 'running')) {
          timer = setTimeout(() => void poll(), 2000);
        }
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const itemColumns: DataGridColumn<EvalRunItemView>[] = [
    { key: 'item', label: 'Item', render: (i) => <span className="ds-mono" style={{ fontSize: 12 }}>{i.itemId}</span> },
    {
      key: 'result',
      label: 'Result',
      render: (i) =>
        i.error
          ? <span className="ds-badge ds-badge-err">error</span>
          : <span className={`ds-badge ${i.passed ? 'ds-badge-teal' : 'ds-badge-err'}`}>{i.passed ? 'pass' : 'fail'}</span>,
    },
    { key: 'score', label: 'Score', render: (i) => <span>{pct(i.score)}</span> },
    {
      key: 'scorers',
      label: 'Scorers',
      render: (i) => (
        <Group gap={4}>
          {(i.scores ?? []).map((s, idx) => (
            <span key={`${s.scorerType}-${idx}`} className={`ds-badge ${s.error ? 'ds-badge-err' : s.passed ? 'ds-badge-teal' : 'ds-badge-warn'}`}>
              {s.scorerType}: {s.error ? 'err' : pct(s.score)}
            </span>
          ))}
        </Group>
      ),
    },
    {
      key: 'output',
      label: 'Output',
      render: (i) => {
        const text = i.error ? i.error : (i.output?.text ?? '');
        const short = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        return <span className="ds-muted" style={{ fontSize: 12 }} title={text}>{short || '—'}</span>;
      },
    },
  ];

  const items: EvalRunItemView[] = Array.isArray(run?.items) ? run.items : [];
  const itemsCtl = useTableControls(items, {
    searchText: (i) => `${i.itemId} ${i.error ?? ''} ${i.output?.text ?? ''}`,
    searchPlaceholder: 'Filter by item, output, or error…',
  });

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/evaluations')}>
      Back to evaluations
    </Button>
  );

  if (loading) {
    return (
      <PageContainer>
        <Group justify="center" mt={80}><Loader /></Group>
      </PageContainer>
    );
  }

  if (notFound || !run) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Evaluations" title="Run not found" actions={backButton} />
        <Text c="dimmed" size="sm">This evaluation run could not be found.</Text>
      </PageContainer>
    );
  }

  const agg = run.aggregate;
  const progress = run.progress ?? { total: 0, completed: 0, failed: 0 };
  const inProgress = run.status === 'pending' || run.status === 'running';
  const done = progress.completed + progress.failed;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations · Run"
        title={run.suiteKey}
        subtitle={
          <span>
            Target <span className="ds-mono">{run.targetKey}</span> · Dataset <span className="ds-mono">{run.datasetKey}</span>{' '}
            · <span className={`ds-badge ${RUN_STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span>
          </span>
        }
        actions={backButton}
      />

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>
          {run.error}
        </div>
      ) : null}

      {inProgress ? (
        <Paper withBorder radius="md" p="md" mb="md">
          <Group gap="sm" mb={6}>
            <Loader size="xs" />
            <Text size="sm" fw={600}>{run.status === 'pending' ? 'Queued…' : 'Running…'}</Text>
            <Text size="sm" c="dimmed">{done} / {progress.total} items{progress.failed ? ` · ${progress.failed} failed` : ''}</Text>
          </Group>
          <Progress value={progress.total ? (done / progress.total) * 100 : 0} animated />
        </Paper>
      ) : null}

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Pass rate" value={agg ? `${agg.passed}/${agg.total} (${pct(agg.passRate)})` : '—'} />
        <StatTile label="Avg score" value={agg ? pct(agg.avgScore) : '—'} />
        <StatTile label="Failed (errored)" value={agg ? agg.failed : '—'} />
        <StatTile label="Avg latency" value={agg?.avgLatencyMs != null ? `${Math.round(agg.avgLatencyMs)} ms` : '—'} />
      </div>

      <DataGrid<EvalRunItemView>
        records={itemsCtl.records}
        rowKey={(i) => i.itemId}
        columns={itemColumns}
        search={itemsCtl.search}
        pagination={itemsCtl.pagination}
        footerLeft={itemsCtl.footerLeft('items')}
        empty={{ title: inProgress ? 'Working…' : 'No items', description: inProgress ? 'Results appear here as each item is scored.' : 'This run produced no item results.' }}
      />
    </PageContainer>
  );
}
