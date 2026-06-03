'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Text } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
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
    (async () => {
      try {
        const res = await fetch(`/api/evaluation/runs/${runId}`, { cache: 'no-store' });
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const data = await res.json();
        if (!cancelled) setRun(data.run ?? null);
      } catch {
        if (!cancelled) setNotFound(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
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
          {i.scores.map((s, idx) => (
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

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Pass rate" value={agg ? `${agg.passed}/${agg.total} (${pct(agg.passRate)})` : '—'} />
        <StatTile label="Avg score" value={agg ? pct(agg.avgScore) : '—'} />
        <StatTile label="Failed (errored)" value={agg ? agg.failed : '—'} />
        <StatTile label="Avg latency" value={agg?.avgLatencyMs != null ? `${Math.round(agg.avgLatencyMs)} ms` : '—'} />
      </div>

      <DataGrid<EvalRunItemView>
        records={run.items}
        rowKey={(i) => i.itemId}
        columns={itemColumns}
        footerLeft={`${run.items.length} items`}
        empty={{ title: 'No items', description: 'This run produced no item results.' }}
      />
    </PageContainer>
  );
}
