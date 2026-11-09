'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Group, Loader, Paper, Progress, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowLeft, IconPlayerStop } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { runVersionTag } from '@/components/agents/agentVersionTag';
import EvaluationRunCompare from '@/components/evaluations/EvaluationRunCompare';
import EvaluationRunItemDrawer from '@/components/evaluations/EvaluationRunItemDrawer';
import {
  OUTCOME_BADGE,
  PASS_RATE_HINT,
  deriveErrorRate,
  isRunActive,
  itemOutcome,
  readErrorMessage,
  scoreOutcome,
  scoredCount,
} from '@/components/evaluations/runViewHelpers';
import type { EvalRunCancelView, EvalRunItemView, EvalRunView } from '@/components/evaluations/types';

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

function usd(value?: number): string {
  return value === undefined || value === null ? '—' : `$${value.toFixed(4)}`;
}

function itemTokens(i: EvalRunItemView): number | undefined {
  const u = i.usage;
  if (!u) return undefined;
  // Cached tokens are a subset of the input: never added on top.
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
}

export default function EvaluationRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<EvalRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The last status we saw decides whether a failed poll is worth retrying.
    let lastStatus: string | undefined;

    const poll = async () => {
      let retry = false;
      try {
        const res = await fetch(`/api/evaluation/runs/${runId}`, { cache: 'no-store' });
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        if (!res.ok) {
          // A 500 or a dropped request is not "not found": keep what we have, say so, and try again.
          setLoadError(await readErrorMessage(res, 'Could not load the run'));
          retry = lastStatus === undefined || isRunActive(lastStatus);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const r: EvalRunView | null = data.run ?? null;
        setLoadError(null);
        if (r) {
          setRun(r);
          lastStatus = r.status;
          // Keep polling while the run is still being processed in the background.
          retry = isRunActive(r.status);
        } else {
          setNotFound(true);
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the run');
        retry = lastStatus === undefined || isRunActive(lastStatus);
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (retry) timer = setTimeout(() => void poll(), 2000);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, pollTick]);

  const cancelRun = async () => {
    if (!run) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/evaluation/runs/${run.id}/cancel`, { method: 'POST' });
      if (res.status === 409) {
        notifications.show({ title: 'Run already finished', message: await readErrorMessage(res, 'Run already finished'), color: 'yellow' });
      } else if (!res.ok) {
        throw new Error(await readErrorMessage(res, 'Cancel failed'));
      } else {
        const data = (await res.json()) as EvalRunCancelView;
        if (data.run) setRun(data.run);
        notifications.show({
          title: data.outcome === 'cancelled' ? 'Run cancelled' : 'Cancellation requested',
          message: data.outcome === 'cancelled'
            ? 'The run had not started yet.'
            : 'Items already in flight will finish; no new items will start.',
          color: 'teal',
        });
      }
      setConfirmingCancel(false);
      // Re-read the stored run and resume polling until it settles.
      setPollTick((n) => n + 1);
    } catch (err) {
      notifications.show({ title: 'Cancel failed', message: err instanceof Error ? err.message : 'Cancel failed', color: 'red' });
    } finally {
      setCancelling(false);
    }
  };

  const itemColumns: DataGridColumn<EvalRunItemView>[] = [
    { key: 'item', label: 'Item', render: (i) => <span className="ds-mono" style={{ fontSize: 12 }}>{i.itemId}</span> },
    {
      key: 'result',
      label: 'Result',
      render: (i) => {
        const outcome = itemOutcome(i);
        return <span className={`ds-badge ${outcome === 'fail' ? 'ds-badge-err' : OUTCOME_BADGE[outcome]}`}>{outcome}</span>;
      },
    },
    { key: 'score', label: 'Score', render: (i) => <span>{i.error || i.skipped ? '—' : pct(i.score)}</span> },
    {
      key: 'scorers',
      label: 'Scorers',
      render: (i) => (
        <Group gap={4}>
          {(i.scores ?? []).map((s, idx) => {
            const so = scoreOutcome(s);
            return (
              <span key={`${s.scorerType}-${idx}`} className={`ds-badge ${OUTCOME_BADGE[so]}`} title={s.error ?? (so === 'skipped' ? String(s.detail?.reason ?? 'Does not apply to this item') : undefined)}>
                {s.scorerType}: {so === 'error' ? 'err' : so === 'skipped' ? 'skipped' : pct(s.score)}
              </span>
            );
          })}
        </Group>
      ),
    },
    {
      key: 'tools',
      label: 'Tools',
      render: (i) => {
        const calls = i.output?.toolCalls;
        if (!calls || calls.length === 0) return <span className="ds-faint">—</span>;
        return (
          <span className="ds-badge ds-badge-info" title={calls.map((c) => c.name).join(', ')}>
            {calls.length} {calls.length === 1 ? 'call' : 'calls'}
          </span>
        );
      },
    },
    {
      key: 'tokens',
      label: 'Tokens',
      render: (i) => {
        const tokens = itemTokens(i);
        return <span className="ds-muted" style={{ fontSize: 12 }}>{tokens === undefined ? '—' : tokens.toLocaleString()}</span>;
      },
    },
    {
      key: 'cost',
      label: 'Cost',
      render: (i) => (
        <span className="ds-muted ds-mono" style={{ fontSize: 12 }}>{i.usage?.costUsd === undefined ? '—' : usd(i.usage.costUsd)}</span>
      ),
    },
    {
      key: 'output',
      label: 'Output',
      render: (i) => {
        if (i.restricted) {
          return (
            <span className="ds-muted" style={{ fontSize: 12 }} data-testid="eval-item-restricted">
              Hidden: used knowledge base documents you cannot read
            </span>
          );
        }
        const text = i.error ? i.error : (i.output?.text ?? '');
        const short = text.length > 120 ? `${text.slice(0, 120)}…` : text;
        return <span className="ds-muted" style={{ fontSize: 12 }}>{short || '—'}</span>;
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

  if (!notFound && !run && loadError) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Evaluations" title="Run" actions={backButton} />
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Could not load this run">
          <Text size="sm" mb="xs">{loadError}</Text>
          <Text size="xs" c="dimmed" mb="xs">Retrying automatically.</Text>
          <Button size="xs" variant="default" onClick={() => setPollTick((n) => n + 1)}>Retry now</Button>
        </Alert>
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
  // Cost stats are present only when at least one item reported provider usage.
  const hasCost = agg?.totalCostUsd != null;
  // Prefer the server's count of items that reported usage; older runs: count the loaded items.
  const usageItemCount = agg?.usageItems ?? items.filter((i) => i.usage).length;
  const errorRate = deriveErrorRate(agg);
  const skippedCount = agg?.skipped ?? 0;
  const cancelRequested = Boolean(run.cancelRequestedAt) && inProgress;
  const selectedItem = selectedItemId ? items.find((i) => i.itemId === selectedItemId) ?? null : null;
  const hasScoringCost = agg?.scoringCostUsd != null || agg?.scoringTokens != null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Evaluations · Run"
        title={run.suiteKey}
        subtitle={
          <span>
            Target <span className="ds-mono">{run.targetKey}</span>
            {run.agentRevision ? (
              <>
                {' '}· Agent{' '}
                <span className="ds-mono"><AgentWithVersion name={run.agentRevision.agentKey} tag={runVersionTag(run.agentRevision)} /></span>
              </>
            ) : null}
            {' '}· Dataset <span className="ds-mono">{run.datasetKey}</span>
            {' '}· <span className={`ds-badge ${RUN_STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span>
          </span>
        }
        actions={backButton}
      />

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>
          {run.error}
        </div>
      ) : null}

      {loadError ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Could not refresh this run">
          {loadError}{inProgress ? ' Retrying automatically.' : ''}
        </Alert>
      ) : null}

      {run.itemsTruncated ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Item details were shortened">
          This run was too large to store in full, so some item output or scorer details were cut or left out. The totals above are complete.
        </Alert>
      ) : null}

      {run.agentRevision?.draftChanged ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="The draft changed during this run">
          The agent&apos;s draft was saved while this run was in progress, so later items may have run a different
          configuration than earlier ones. Re-run to get a result for one configuration.
        </Alert>
      ) : null}

      {inProgress ? (
        <Paper withBorder radius="md" p="md" mb="md">
          <Group gap="sm" mb={6}>
            <Loader size="xs" />
            <Text size="sm" fw={600}>
              {cancelRequested ? 'Cancellation requested…' : run.status === 'pending' ? 'Queued…' : 'Running…'}
            </Text>
            <Text size="sm" c="dimmed">{done} / {progress.total} items{progress.failed ? ` · ${progress.failed} failed` : ''}</Text>
            {!cancelRequested && !confirmingCancel ? (
              <Button size="compact-xs" color="red" variant="light" leftSection={<IconPlayerStop size={12} />} ml="auto" onClick={() => setConfirmingCancel(true)}>
                Cancel run
              </Button>
            ) : null}
          </Group>
          {cancelRequested ? (
            <Text size="xs" c="dimmed" mb={6}>Items already in flight will finish; no new items will start. The run keeps the results so far.</Text>
          ) : null}
          {confirmingCancel && !cancelRequested ? (
            <Alert color="red" variant="light" mb={8} title="Cancel this run?">
              <Text size="sm" mb="xs">
                {run.status === 'pending'
                  ? 'The run has not started and will be cancelled right away.'
                  : 'No new items will start. Items already in flight finish, and the run keeps the results so far.'}
              </Text>
              <Group gap="xs">
                <Button size="xs" color="red" loading={cancelling} onClick={() => void cancelRun()}>Yes, cancel run</Button>
                <Button size="xs" variant="default" disabled={cancelling} onClick={() => setConfirmingCancel(false)}>Keep running</Button>
              </Group>
            </Alert>
          ) : null}
          <Progress value={progress.total ? (done / progress.total) * 100 : 0} animated />
        </Paper>
      ) : null}

      <div className="ds-stat-grid" style={{ marginBottom: hasCost ? 6 : 16 }}>
        <Tooltip label={PASS_RATE_HINT} multiline w={280} withArrow>
          <div>
            <StatTile label="Pass rate" value={agg ? `${agg.passed}/${scoredCount(agg)} (${pct(agg.passRate)})` : '—'} />
          </div>
        </Tooltip>
        <StatTile label="Avg score" value={agg ? pct(agg.avgScore) : '—'} />
        <Tooltip label="Items the target or a scorer failed on (failed / total). They are not part of the pass rate." multiline w={260} withArrow>
          <div>
            <StatTile label="Errored" value={agg ? `${agg.failed} (${pct(errorRate)})` : '—'} />
          </div>
        </Tooltip>
        {agg && skippedCount > 0 ? <StatTile label="Skipped" value={skippedCount} /> : null}
        {agg && (agg.truncatedCount ?? 0) > 0 ? <StatTile label="Output cut off" value={agg.truncatedCount ?? 0} /> : null}
        <StatTile label="Avg latency" value={agg?.avgLatencyMs != null ? `${Math.round(agg.avgLatencyMs)} ms` : '—'} />
        {hasCost ? (
          <>
            <StatTile label="Total cost" value={usd(agg?.totalCostUsd)} />
            <StatTile label="Total tokens" value={agg?.totalTokens != null ? agg.totalTokens.toLocaleString() : '—'} />
            <StatTile
              label="Avg cost / item"
              value={usageItemCount > 0 && agg?.totalCostUsd != null ? usd(agg.totalCostUsd / usageItemCount) : '—'}
            />
          </>
        ) : null}
      </div>
      {hasCost ? (
        <Text size="xs" c="dimmed" mb="md">
          Costs are measured from real usage reported by the model provider during replay.
          {hasScoringCost
            ? ` Judge spend is separate: ${agg?.scoringCostUsd != null ? usd(agg.scoringCostUsd) : '—'}${agg?.scoringTokens != null ? ` · ${agg.scoringTokens.toLocaleString()} tokens` : ''}.`
            : ''}
        </Text>
      ) : hasScoringCost ? (
        <Text size="xs" c="dimmed" mb="md">
          Judge spend (separate from the target): {agg?.scoringCostUsd != null ? usd(agg.scoringCostUsd) : '—'}
          {agg?.scoringTokens != null ? ` · ${agg.scoringTokens.toLocaleString()} tokens` : ''}.
        </Text>
      ) : null}

      <DataGrid<EvalRunItemView>
        records={itemsCtl.records}
        rowKey={(i) => i.itemId}
        columns={itemColumns}
        search={itemsCtl.search}
        pagination={itemsCtl.pagination}
        footerLeft={itemsCtl.footerLeft('items')}
        onRowClick={(i) => setSelectedItemId(i.itemId)}
        empty={{ title: inProgress ? 'Working…' : 'No items', description: inProgress ? 'Results appear here as each item is scored.' : 'This run produced no item results.' }}
      />

      <EvaluationRunItemDrawer item={selectedItem} onClose={() => setSelectedItemId(null)} />

      <EvaluationRunCompare run={run} />
    </PageContainer>
  );
}
