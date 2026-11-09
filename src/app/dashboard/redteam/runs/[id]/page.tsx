'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Group, List, Loader, Modal, Progress, Select, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowLeft, IconPlayerStop } from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import DataGrid, { type DataGridColumn } from '@/components/common/ui/DataGrid';
import { useTableControls } from '@/components/common/ui/useTableControls';
import AgentWithVersion from '@/components/agents/AgentWithVersion';
import { runVersionTag } from '@/components/agents/agentVersionTag';
import RedTeamRunCompare from '@/components/redteam/RedTeamRunCompare';
import {
  INCONCLUSIVE_REASON_TEXT,
  REVIEW_BLOCK_HINT,
  attemptKeyFor,
  effectiveOutcome,
  inconclusiveReasons,
  isActiveStatus,
  isFailedAttempt,
  partialLabel,
  pct,
  reviewBlockedReason,
} from '@/components/redteam/helpers';
import { OUTCOME_BADGE, runStatusBadgeClass, severityBadgeClass } from '@/components/redteam/severity';
import type { RedTeamAttemptView, RedTeamOutcome, RedTeamRunView } from '@/components/redteam/types';
import { owaspCategoryLabel } from '@/lib/services/redteam/owasp';
import { RUN_LIMITS } from '@/lib/services/redteam/limits';

type LoadError = 'not-found' | 'forbidden' | 'error' | null;

const POLL_MS = 2500;

export default function RedTeamRunDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const runId = params?.id;
  const [run, setRun] = useState<RedTeamRunView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError>(null);
  // A poll that fails keeps what is on screen and only says so.
  const [pollFailed, setPollFailed] = useState(false);
  const [viewing, setViewing] = useState<RedTeamAttemptView | null>(null);
  const [reviewOutcome, setReviewOutcome] = useState<RedTeamOutcome>('safe');
  const [reviewNote, setReviewNote] = useState('');
  const [savingReview, setSavingReview] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const hasRun = useRef(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!runId || inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`/api/redteam/runs/${runId}`, { cache: 'no-store' });
      if (res.status === 404) { hasRun.current = false; setRun(null); setLoadError('not-found'); return; }
      if (res.status === 403) { hasRun.current = false; setRun(null); setLoadError('forbidden'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      hasRun.current = Boolean(data.run);
      setRun(data.run ?? null);
      setLoadError(data.run ? null : 'not-found');
      setPollFailed(false);
    } catch {
      if (hasRun.current) setPollFailed(true);
      else setLoadError('error');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { void load(); }, [load]);

  // Poll while the scan is pending or running; the timer goes away once it finishes.
  const active = isActiveStatus(run?.status);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const retry = () => {
    setLoading(true);
    setLoadError(null);
    void load();
  };

  const openAttempt = (a: RedTeamAttemptView) => {
    setViewing(a);
    setReviewOutcome(effectiveOutcome(a));
    setReviewNote(a.review?.note ?? '');
  };

  const submitReview = async () => {
    if (!viewing || !runId) return;
    setSavingReview(true);
    try {
      const key = attemptKeyFor(viewing);
      const res = await fetch(`/api/redteam/runs/${runId}/attempts/${encodeURIComponent(key)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: reviewOutcome, note: reviewNote.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Review failed');
      if (data.run) setRun(data.run);
      notifications.show({ title: 'Verdict updated', message: `${viewing.probeKey} → ${reviewOutcome}`, color: 'teal' });
      setViewing(null);
      void load();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Review failed', color: 'red' });
    } finally {
      setSavingReview(false);
    }
  };

  const cancelScan = async () => {
    if (!runId) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/redteam/runs/${runId}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not stop the scan');
      if (data.run) setRun(data.run);
      notifications.show({ title: 'Stopping the scan', message: 'Finished attempts are kept.', color: 'teal' });
      setConfirmCancel(false);
      void load();
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : 'Could not stop the scan', color: 'red' });
      // The scan may have finished in the meantime; show where it stands.
      setConfirmCancel(false);
      void load();
    } finally {
      setCancelling(false);
    }
  };

  const columns: DataGridColumn<RedTeamAttemptView>[] = [
    { key: 'probe', label: 'Probe', render: (a) => (
      <div className="ds-col" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500 }}>{a.probeKey}</span>
        <span className="ds-faint ds-mono" style={{ fontSize: 11 }}>{a.attemptId}</span>
      </div>
    ) },
    { key: 'category', label: 'OWASP', render: (a) => <span className="ds-faint" style={{ fontSize: 11 }}>{owaspCategoryLabel(a.category)}</span> },
    { key: 'severity', label: 'Severity', render: (a) => <span className={severityBadgeClass(a.severity)}>{a.severity}</span> },
    { key: 'outcome', label: 'Verdict', render: (a) => {
      if (isFailedAttempt(a)) {
        return <span className="ds-badge ds-badge-err" title={a.error}>failed — target error</span>;
      }
      const eff = effectiveOutcome(a);
      return (
        <Group gap={4}>
          <span className={`ds-badge ${OUTCOME_BADGE[eff]}`}>{eff.replace('_', ' ')}</span>
          {a.partial ? <span className="ds-badge ds-badge-warn" title={a.error}>{partialLabel(a)}</span> : null}
          {a.review ? <span className="ds-badge" title="Human-reviewed">✓ reviewed</span> : null}
        </Group>
      );
    } },
    { key: 'decided', label: 'Decided by', render: (a) => <span className="ds-mono ds-faint" style={{ fontSize: 11 }}>{a.decidedBy}</span> },
    { key: 'confidence', label: 'Conf.', render: (a) => <span>{pct(a.confidence)}</span> },
  ];

  const attempts: RedTeamAttemptView[] = Array.isArray(run?.attempts) ? run.attempts : [];
  const attemptsCtl = useTableControls(attempts, {
    searchText: (a) => `${attemptKeyFor(a)} ${a.category} ${a.severity} ${a.decidedBy} ${effectiveOutcome(a)}`,
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
  if (loadError === 'not-found' || (!run && loadError === null)) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="Scan not found" actions={backButton} />
        <Text c="dimmed" size="sm">This scan could not be found.</Text>
      </PageContainer>
    );
  }
  if (loadError === 'forbidden') {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="No access" actions={backButton} />
        <Text c="dimmed" size="sm">You do not have access to this scan.</Text>
      </PageContainer>
    );
  }
  if (loadError === 'error' || !run) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operate · Red Team" title="Could not load the scan" actions={backButton} />
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title="Something went wrong">
          <Group justify="space-between">
            <Text size="sm">The scan could not be loaded.</Text>
            <Button size="xs" variant="default" onClick={retry}>Retry</Button>
          </Group>
        </Alert>
      </PageContainer>
    );
  }

  const agg = run.aggregate;
  const reasons = inconclusiveReasons(agg);
  const warnings = Array.isArray(run.warnings) ? run.warnings : [];
  const skipped = run.skippedAttempts ?? 0;
  const notApplicable = run.notApplicableAttempts ?? 0;
  const viewingBlock = viewing ? reviewBlockedReason(run, viewing) : null;

  const cancelButton = active ? (
    <Button
      variant="default"
      size="sm"
      color="red"
      leftSection={<IconPlayerStop size={14} />}
      disabled={Boolean(run.cancelRequested)}
      onClick={() => setConfirmCancel(true)}
    >
      {run.cancelRequested ? 'Stopping…' : 'Cancel scan'}
    </Button>
  ) : null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operate · Red Team · Scan"
        title={run.campaignKey}
        subtitle={
          <span>
            Target <span className="ds-mono"><AgentWithVersion name={run.targetRef} tag={runVersionTag(run.agentRevision)} /></span> ({run.targetKind}){' '}
            · <span className={runStatusBadgeClass(run.status)}>{run.status}</span>
            {active ? <span className="ds-faint" style={{ marginLeft: 8 }}>· {run.progress.completed}/{run.progress.total} attempts</span> : null}
          </span>
        }
        actions={<>{cancelButton}{backButton}</>}
      />

      {pollFailed ? (
        <Text size="xs" c="yellow.8" mb="sm" data-testid="redteam-poll-warning">
          Could not refresh this scan just now. Showing the last data; retrying.
        </Text>
      ) : null}

      {run.error ? (
        <div className="ds-card ds-card-pad-sm" style={{ marginBottom: 16, color: 'var(--mantine-color-red-6)' }}>{run.error}</div>
      ) : null}

      {run.agentRevision?.draftChanged ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="The draft changed during this scan">
          The agent&apos;s draft was saved while this scan was in progress, so later attempts may have attacked a
          different configuration than earlier ones. Re-run the scan to get a result for one configuration.
        </Alert>
      ) : null}

      {reasons.length > 0 ? (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Inconclusive result" data-testid="redteam-inconclusive">
          <Text size="sm" mb={4}>Do not rely on the rates below.</Text>
          <List size="sm" spacing={2}>
            {reasons.map((r) => <List.Item key={r}>{INCONCLUSIVE_REASON_TEXT[r] ?? r}</List.Item>)}
          </List>
        </Alert>
      ) : null}

      {warnings.length > 0 ? (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />} mb="md" title="Notes on this scan" data-testid="redteam-warnings">
          <List size="sm" spacing={2}>
            {warnings.map((w, i) => <List.Item key={`${i}-${w}`}>{w}</List.Item>)}
          </List>
        </Alert>
      ) : null}

      {skipped > 0 || notApplicable > 0 ? (
        <Text size="xs" c="dimmed" mb="md" data-testid="redteam-not-run">
          Not run:
          {skipped > 0 ? ` ${skipped} skipped (a scan runs at most ${RUN_LIMITS.maxAttemptsPerRun} attempts)` : ''}
          {skipped > 0 && notApplicable > 0 ? ' ·' : ''}
          {notApplicable > 0 ? ` ${notApplicable} not applicable to this target` : ''}.
        </Text>
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
        rowKey={attemptKeyFor}
        columns={columns}
        search={attemptsCtl.search}
        pagination={attemptsCtl.pagination}
        footerLeft={attemptsCtl.footerLeft('attempts')}
        empty={{ title: 'No attempts', description: active ? 'Scan in progress…' : 'This scan produced no attempts.' }}
        onRowClick={openAttempt}
        rowActions={(a) => {
          const block = reviewBlockedReason(run, a);
          return [
            { id: 'view', label: 'View details', onClick: () => openAttempt(a) },
            {
              id: 'review',
              label: 'Review / override',
              disabled: block !== null,
              disabledReason: block ? REVIEW_BLOCK_HINT[block] : undefined,
              onClick: () => openAttempt(a),
            },
          ];
        }}
      />

      <RedTeamRunCompare run={run} />

      <Modal opened={viewing !== null} onClose={() => setViewing(null)} title={viewingBlock ? 'Attempt details' : 'Review verdict'} centered size="lg">
        {viewing ? (
          <Stack gap="md">
            <div>
              <Text size="sm" fw={500}>{viewing.probeKey} · {owaspCategoryLabel(viewing.category)}</Text>
              <Text size="xs" c="dimmed" className="ds-mono">{attemptKeyFor(viewing)}</Text>
              <Text size="xs" c="dimmed">Machine verdict: {viewing.outcome.replace('_', ' ')} ({viewing.decidedBy}, {pct(viewing.confidence)})</Text>
              {viewing.partial ? (
                <Text size="xs" c="yellow.8" mt={4}>{partialLabel(viewing)}: the verdict is based on the turns that completed.</Text>
              ) : null}
              {viewing.error ? (
                <Text size="xs" c="red" mt={4}>Target error: {viewing.error}</Text>
              ) : null}
            </div>

            <div>
              <Text size="xs" fw={600} mb={4}>Signals</Text>
              {viewing.signals.length === 0 ? (
                <Text size="xs" c="dimmed">No detector signals — the target call failed before any detector ran.</Text>
              ) : (
                <Stack gap={4}>
                  {viewing.signals.map((s, i) => (
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
              {viewing.restricted ? (
                <Text size="xs" c="dimmed" data-testid="redteam-attempt-restricted">
                  Hidden: this attempt used knowledge base documents you cannot read.
                </Text>
              ) : viewing.transcript.length === 0 ? (
                <Text size="xs" c="dimmed">No transcript captured.</Text>
              ) : (
              <Stack gap={6}>
                {viewing.transcript.map((t, i) => (
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

            {viewingBlock ? (
              <>
                <Text size="xs" c="dimmed">{REVIEW_BLOCK_HINT[viewingBlock]}</Text>
                <Group justify="flex-end">
                  <Button variant="default" onClick={() => setViewing(null)}>Close</Button>
                </Group>
              </>
            ) : (
              <>
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
                  <Button variant="default" onClick={() => setViewing(null)}>Cancel</Button>
                  <Button color="teal" loading={savingReview} onClick={submitReview}>Save verdict</Button>
                </Group>
              </>
            )}
          </Stack>
        ) : null}
      </Modal>

      <Modal opened={confirmCancel} onClose={() => setConfirmCancel(false)} title="Cancel this scan?" centered>
        <Stack gap="md">
          <Text size="sm">
            The scan stops after the attempts that are running now. Attempts that already finished are kept and the
            scan ends as cancelled.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmCancel(false)}>Keep running</Button>
            <Button color="red" loading={cancelling} onClick={() => void cancelScan()}>Cancel scan</Button>
          </Group>
        </Stack>
      </Modal>
    </PageContainer>
  );
}
