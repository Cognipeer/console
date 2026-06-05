'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Paper, Progress, Text } from '@mantine/core';
import { IconArrowLeft, IconDownload } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import type { AnalysisRunItemView, AnalysisRunView } from '@/components/analysis/types';
import { downloadFile, fieldDistributions, itemsToCsv } from '@/components/analysis/analysisReport';

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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/analysis/runs/${runId}`, { cache: 'no-store' });
        if (res.status === 404) { if (!cancelled) setNotFound(true); return; }
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

  const items: AnalysisRunItemView[] = Array.isArray(run?.items) ? run.items : [];
  const itemsCtl = useTableControls(items, {
    searchText: (i) => `${i.conversationKey} ${i.error ?? ''} ${fieldsSummary(i.extractedFields)}`,
    searchPlaceholder: 'Filter by conversation or fields…',
  });

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
  const progress = run.progress ?? { total: 0, completed: 0, failed: 0 };
  const inProgress = run.status === 'pending' || run.status === 'running';
  const done = progress.completed + progress.failed;
  const distributions = items.length > 0 ? fieldDistributions(items) : [];

  const exportCsv = () => {
    downloadFile(`analysis-run-${run.definitionKey}-${runId}.csv`, itemsToCsv(items));
  };

  const headerActions = (
    <Group gap="xs">
      {items.length > 0 ? (
        <Button variant="default" size="sm" leftSection={<IconDownload size={14} />} onClick={exportCsv}>
          Export CSV
        </Button>
      ) : null}
      {backButton}
    </Group>
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Analysis · Run"
        title={run.definitionKey}
        subtitle={<span><span className={`ds-badge ${RUN_STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span></span>}
        actions={headerActions}
      />

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>{run.error}</div>
      ) : null}

      {inProgress ? (
        <Paper withBorder radius="md" p="md" mb="md">
          <Group gap="sm" mb={6}>
            <Loader size="xs" />
            <Text size="sm" fw={600}>{run.status === 'pending' ? 'Queued…' : 'Running…'}</Text>
            <Text size="sm" c="dimmed">{done} / {progress.total} conversations{progress.failed ? ` · ${progress.failed} failed` : ''}</Text>
          </Group>
          <Progress value={progress.total ? (done / progress.total) * 100 : 0} animated />
        </Paper>
      ) : null}

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Analyzed" value={agg ? `${agg.completed}/${agg.total} (${pct(agg.passRate)})` : '—'} />
        <StatTile label="Avg judge score" value={pct(agg?.avgJudgeScore)} />
        <StatTile label="Avg accuracy" value={pct(agg?.avgExtractionAccuracy)} />
        <StatTile label="Failed (errored)" value={agg ? agg.failed : '—'} />
      </div>

      {distributions.length > 0 ? (
        <Paper withBorder radius="md" p="md" mb="md">
          <Text size="sm" fw={600} mb={4}>Field breakdown</Text>
          <Text size="xs" c="dimmed" mb="sm">Value distribution across {items.filter((i) => !i.error).length} analyzed conversation(s).</Text>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {distributions.map((d) => (
              <div key={d.key} className="ds-card ds-card-pad-sm">
                <Text size="xs" fw={600} className="ds-mono" mb={6}>{d.key}</Text>
                <Group gap={4} mb={d.emptyCount ? 4 : 0} style={{ flexWrap: 'wrap' }}>
                  {d.buckets.slice(0, 8).map((b) => (
                    <span key={b.value} className="ds-badge ds-badge-info" title={`${b.value}: ${b.count}`}>
                      {b.value} · {b.count}
                    </span>
                  ))}
                  {d.buckets.length > 8 ? <span className="ds-faint" style={{ fontSize: 11 }}>+{d.buckets.length - 8} more</span> : null}
                  {d.buckets.length === 0 ? <span className="ds-faint" style={{ fontSize: 11 }}>no values</span> : null}
                </Group>
                {d.emptyCount ? <Text size="xs" c="dimmed">{d.emptyCount} empty</Text> : null}
              </div>
            ))}
          </div>
        </Paper>
      ) : null}

      <DataGrid<AnalysisRunItemView>
        records={itemsCtl.records}
        rowKey={(i) => i.conversationKey}
        columns={itemColumns}
        search={itemsCtl.search}
        pagination={itemsCtl.pagination}
        footerLeft={itemsCtl.footerLeft('conversations')}
        empty={{ title: inProgress ? 'Working…' : 'No items', description: inProgress ? 'Results appear here as each conversation is analyzed.' : 'This run produced no conversation results.' }}
      />
    </PageContainer>
  );
}
