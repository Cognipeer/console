'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button, Group, Loader, Modal, Progress, Select, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import RedTeamRunCompare from '@/components/redteam/RedTeamRunCompare';
import type { RedTeamAttemptView, RedTeamOutcome, RedTeamRunView } from '@/components/redteam/types';

const RUN_STATUS_BADGE: Record<string, string> = {
  completed: 'ds-badge-teal',
  running: 'ds-badge-info',
  failed: 'ds-badge-err',
  pending: 'ds-badge',
  cancelled: 'ds-badge-warn',
};

const OUTCOME_BADGE: Record<RedTeamOutcome, string> = {
  safe: 'ds-badge-teal',
  vulnerable: 'ds-badge-err',
  needs_review: 'ds-badge-warn',
};

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'ds-badge-err',
  high: 'ds-badge-err',
  medium: 'ds-badge-warn',
  low: 'ds-badge',
};

function pct(value?: number): string {
  return value === undefined || value === null ? '—' : `${Math.round(value * 100)}%`;
}

function effectiveOutcome(a: RedTeamAttemptView): RedTeamOutcome {
  return a.review?.outcome ?? a.outcome;
}

export default function RedTeamRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<RedTeamRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [reviewing, setReviewing] = useState<RedTeamAttemptView | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<RedTeamOutcome>('safe');
  const [reviewNote, setReviewNote] = useState('');
  const [savingReview, setSavingReview] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await fetch(`/api/redteam/runs/${runId}`, { cache: 'no-store' });
      if (res.status === 404) { setNotFound(true); return; }
      const data = await res.json();
      setRun(data.run ?? null);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  // Poll while the scan is still running.
  const active = run?.status === 'pending' || run?.status === 'running';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(timer);
  }, [active, load]);

  const openReview = (a: RedTeamAttemptView) => {
    setReviewing(a);
    setReviewOutcome(effectiveOutcome(a));
    setReviewNote(a.review?.note ?? '');
  };

  const submitReview = async () => {
    if (!reviewing || !runId) return;
    setSavingReview(true);
    try {
      const res = await fetch(`/api/redteam/runs/${runId}/attempts/${encodeURIComponent(reviewing.attemptId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: reviewOutcome, note: reviewNote.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Review failed');
      setRun(data.run ?? run);
      notifications.show({ title: 'Verdict updated', message: `${reviewing.probeKey} → ${reviewOutcome}`, color: 'teal' });
      setReviewing(null);
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Review failed', color: 'red' });
    } finally {
      setSavingReview(false);
    }
  };

  const columns: DataGridColumn<RedTeamAttemptView>[] = [
    { key: 'probe', label: 'Probe', render: (a) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500 }}>{a.probeKey}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{a.attemptId}</span>
      </div>
    ) },
    { key: 'category', label: 'OWASP', render: (a) => <span className="ds-faint" style={{ fontSize: 11 }}>{a.category}</span> },
    { key: 'severity', label: 'Severity', render: (a) => <span className={`ds-badge ${SEVERITY_BADGE[a.severity] ?? ''}`}>{a.severity}</span> },
    { key: 'outcome', label: 'Verdict', render: (a) => {
      const eff = effectiveOutcome(a);
      return (
        <Group gap={4}>
          <span className={`ds-badge ${OUTCOME_BADGE[eff]}`}>{eff.replace('_', ' ')}</span>
          {a.review ? <span className="ds-badge" title="Human-reviewed">✓ reviewed</span> : null}
        </Group>
      );
    } },
    { key: 'decided', label: 'Decided by', render: (a) => <span className="ds-mono ds-faint" style={{ fontSize: 11 }}>{a.decidedBy}</span> },
    { key: 'confidence', label: 'Conf.', render: (a) => <span>{pct(a.confidence)}</span> },
  ];

  const attempts: RedTeamAttemptView[] = Array.isArray(run?.attempts) ? run.attempts : [];
  const attemptsCtl = useTableControls(attempts, {
    searchText: (a) => `${a.probeKey} ${a.attemptId} ${a.category} ${a.severity} ${a.decidedBy} ${effectiveOutcome(a)}`,
    searchPlaceholder: 'Filter by probe, verdict, or severity…',
  });

  const backButton = (
    <Button variant="default" size="sm" leftSection={<IconArrowLeft size={14} />} onClick={() => router.push('/dashboard/redteam/runs')}>
      Back to scans
    </Button>
  );

  if (loading) {
    return <PageContainer><Group justify="center" mt={80}><Loader /></Group></PageContainer>;
  }
  if (notFound || !run) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="Scan not found" actions={backButton} />
        <Text c="dimmed" size="sm">This scan could not be found.</Text>
      </PageContainer>
    );
  }

  const agg = run.aggregate;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Red Team · Scan"
        title={run.campaignKey}
        subtitle={
          <span>
            Target <span className="ds-mono">{run.targetRef}</span> ({run.targetKind}){' '}
            · <span className={`ds-badge ${RUN_STATUS_BADGE[run.status] ?? ''}`}>{run.status}</span>
            {active ? <span className="ds-faint" style={{ marginLeft: 8 }}>· {run.progress.completed}/{run.progress.total} attempts</span> : null}
          </span>
        }
        actions={backButton}
      />

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>{run.error}</div>
      ) : null}

      {active ? (
        <div style={{ marginBottom: 16 }}>
          <Group justify="space-between" mb={4}>
            <Text size="xs" c="dimmed">Scanning… {run.progress.completed + run.progress.failed}/{run.progress.total} attempts</Text>
          </Group>
          <Progress
            value={run.progress.total ? ((run.progress.completed + run.progress.failed) / run.progress.total) * 100 : 0}
            animated
          />
        </div>
      ) : null}

      <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Attack success rate" value={agg ? pct(agg.attackSuccessRate) : '—'} />
        <StatTile label="Resilience" value={agg ? pct(agg.resilienceScore) : '—'} />
        <StatTile label="Vulnerable" value={agg ? agg.vulnerable : '—'} />
        <StatTile label="Needs review" value={agg ? agg.needsReview : '—'} />
      </div>

      <DataGrid<RedTeamAttemptView>
        records={attemptsCtl.records}
        rowKey={(a) => a.attemptId}
        columns={columns}
        search={attemptsCtl.search}
        pagination={attemptsCtl.pagination}
        footerLeft={attemptsCtl.footerLeft('attempts')}
        empty={{ title: 'No attempts', description: active ? 'Scan in progress…' : 'This scan produced no attempts.' }}
        rowActions={(a) => [
          { id: 'review', label: 'Review / override', onClick: () => openReview(a) },
        ]}
      />

      <RedTeamRunCompare run={run} />

      <Modal opened={reviewing !== null} onClose={() => setReviewing(null)} title="Review verdict" centered size="lg">
        {reviewing ? (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={500}>{reviewing.probeKey} · {reviewing.category}</Text>
              <Text size="xs" c="dimmed">Machine verdict: {reviewing.outcome.replace('_', ' ')} ({reviewing.decidedBy}, {pct(reviewing.confidence)})</Text>
              {reviewing.error ? (
                <Text size="xs" c="red" mt={4}>Target error: {reviewing.error}</Text>
              ) : null}
            </div>

            <div>
              <Text size="xs" fw={600} mb={4}>Signals</Text>
              {reviewing.signals.length === 0 ? (
                <Text size="xs" c="dimmed">No detector signals — the target call failed before any detector ran.</Text>
              ) : (
                <Stack gap={4}>
                  {reviewing.signals.map((s, i) => (
                    <Text key={`${s.detectorKey}-${i}`} size="xs" c="dimmed">
                      <span className={`ds-badge ${s.hit ? 'ds-badge-err' : s.gate === 'safe' ? 'ds-badge-teal' : ''}`}>{s.detectorKey}</span>{' '}
                      {s.error ? `error: ${s.error}` : `${s.hit ? 'hit' : 'no-hit'} · score ${pct(s.score)} · conf ${pct(s.confidence)} — ${s.rationale}`}
                    </Text>
                  ))}
                </Stack>
              )}
            </div>

            <div>
              <Text size="xs" fw={600} mb={4}>Transcript</Text>
              {reviewing.transcript.length === 0 ? (
                <Text size="xs" c="dimmed">No transcript captured.</Text>
              ) : (
              <Stack gap={6}>
                {reviewing.transcript.map((t, i) => (
                  <div key={i} className="ds-card ds-card-pad-sm">
                    <Text size="xs" fw={600}>▸ attacker</Text>
                    <Text size="xs" c="dimmed" mb={4} style={{ whiteSpace: 'pre-wrap' }}>{t.user}</Text>
                    <Text size="xs" fw={600}>◂ target</Text>
                    <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{t.assistant}</Text>
                  </div>
                ))}
              </Stack>
              )}
            </div>

            <Select
              label="Override outcome"
              data={[
                { value: 'safe', label: 'Safe' },
                { value: 'vulnerable', label: 'Vulnerable' },
                { value: 'needs_review', label: 'Needs review' },
              ]}
              value={reviewOutcome}
              onChange={(v) => setReviewOutcome((v as RedTeamOutcome) ?? 'safe')}
            />
            <Textarea label="Note" value={reviewNote} onChange={(e) => setReviewNote(e.currentTarget.value)} autosize minRows={2} />

            <Group justify="flex-end">
              <Button variant="default" onClick={() => setReviewing(null)}>Cancel</Button>
              <Button color="teal" loading={savingReview} onClick={submitReview}>Save verdict</Button>
            </Group>
          </Stack>
        ) : null}
      </Modal>
    </PageContainer>
  );
}
