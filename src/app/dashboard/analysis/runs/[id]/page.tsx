'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Group, Loader, Paper, Progress, Stack, Text } from '@mantine/core';
import { IconArrowLeft, IconDownload } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import type { AnalysisDecisionAggregateView, AnalysisRunItemView, AnalysisRunView } from '@/components/analysis/types';
import { downloadFile, fieldDistributions, itemsToCsv } from '@/components/analysis/analysisReport';
import { decisionBadgeClass, formatAnswer, pct as pctOf } from '@/components/analysis/decisionUi';

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

/** Fixed rotation for the answer segments; existing theme tokens only. */
const SEGMENT_COLORS = ['var(--ds-accent)', 'var(--ds-info)', 'var(--ds-warn)', 'var(--ds-err)', 'var(--ds-ok)', 'var(--ds-text-muted)'];

/** Max decision chips shown in one items-table cell. */
const MAX_DECISION_CHIPS = 3;

/** One question of the Decisions card: stacked answer bar + legend. */
function DecisionRow({ name, agg }: { name: string; agg: AnalysisDecisionAggregateView }) {
  const entries = Object.entries(agg.counts).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div>
      <Group justify="space-between" mb={6} wrap="nowrap">
        <Text size="xs" fw={600} className="ds-mono">{name}</Text>
        <Group gap={6} wrap="nowrap">
          {agg.needsReview > 0 ? <span className="ds-badge ds-badge-warn" title="Answers flagged for review">⚑ {agg.needsReview}</span> : null}
          <span className="ds-faint" style={{ fontSize: 12 }}>avg {pctOf(agg.avgConfidence)}</span>
          {agg.avgScore !== undefined && agg.avgScore !== null ? <span className="ds-faint" style={{ fontSize: 12 }}>avg level {agg.avgScore.toFixed(1)}</span> : null}
        </Group>
      </Group>
      <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--ds-border-soft)' }}>
        {total > 0 ? entries.map(([answer, n], idx) => (
          <div
            key={answer}
            title={`${answer}: ${n}`}
            style={{ width: `${(n / total) * 100}%`, background: SEGMENT_COLORS[idx % SEGMENT_COLORS.length] }}
          />
        )) : null}
      </div>
      <Group gap={6} mt={6} style={{ flexWrap: 'wrap' }}>
        {entries.map(([answer, n], idx) => (
          <span key={answer} className="ds-badge" title={`${answer}: ${n}`}>
            <span className="ds-badge-dot" style={{ background: SEGMENT_COLORS[idx % SEGMENT_COLORS.length] }} />
            {answer} · {n}
          </span>
        ))}
        {agg.refused > 0 ? <span className="ds-badge ds-badge-warn">refused · {agg.refused}</span> : null}
        {entries.length === 0 && agg.refused === 0 ? <span className="ds-faint" style={{ fontSize: 11 }}>no answers</span> : null}
      </Group>
    </div>
  );
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
    {
      key: 'decisions',
      label: 'Decisions',
      render: (i) => {
        const entries = Object.entries(i.decisions ?? {});
        if (entries.length === 0) return <span className="ds-faint">—</span>;
        return (
          <Group gap={4} style={{ flexWrap: 'wrap' }}>
            {entries.slice(0, MAX_DECISION_CHIPS).map(([k, d]) => (
              <span key={k} className={decisionBadgeClass(d)} title={`${k}: ${formatAnswer(d)} · ${pctOf(d.confidence)}`}>
                {k}: {formatAnswer(d)} · {pctOf(d.confidence)}
              </span>
            ))}
            {entries.length > MAX_DECISION_CHIPS ? <span className="ds-faint" style={{ fontSize: 11 }}>+{entries.length - MAX_DECISION_CHIPS}</span> : null}
          </Group>
        );
      },
    },
    {
      key: 'review',
      label: 'Review',
      render: (i) => (i.needsReview ? <span className="ds-badge ds-badge-warn" title={i.reviewReason === 'spot_check' ? 'Spot-check' : 'Low confidence'}>⚑</span> : <span className="ds-faint">—</span>),
    },
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
  const decisionAggs = agg?.decisions ? Object.entries(agg.decisions) : [];
  // Decision fields are shown in the Decisions card, not in the field breakdown.
  const distributions = items.length > 0 ? fieldDistributions(items, new Set(decisionAggs.map(([k]) => k))) : [];

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
        {/* Only runs that asked a decision model have a review queue to point at. */}
        {agg?.needsReview !== undefined && decisionAggs.length > 0 ? (
          <Link href={`/dashboard/analysis/review?definition=${encodeURIComponent(run.definitionKey)}`} style={{ color: 'inherit', textDecoration: 'none' }}>
            <StatTile label="Needs review" value={agg.needsReview} />
          </Link>
        ) : null}
      </div>

      {decisionAggs.length > 0 ? (
        <Paper withBorder radius="md" p="md" mb="md">
          <Text size="sm" fw={600} mb={4}>Decisions</Text>
          <Text size="xs" c="dimmed" mb="sm">How the decision model answered each question across this run.</Text>
          <Stack gap="md">
            {decisionAggs.map(([name, d]) => <DecisionRow key={name} name={name} agg={d} />)}
          </Stack>
        </Paper>
      ) : null}

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
        rowHref={(i) => (i.resultId ? `/dashboard/analysis/results/${i.resultId}` : null)}
        search={itemsCtl.search}
        pagination={itemsCtl.pagination}
        footerLeft={itemsCtl.footerLeft('conversations')}
        empty={{ title: inProgress ? 'Working…' : 'No items', description: inProgress ? 'Results appear here as each conversation is analyzed.' : 'This run produced no conversation results.' }}
      />
    </PageContainer>
  );
}
