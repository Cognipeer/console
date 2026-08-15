'use client';

/**
 * Cost → Prescriptions — automated analysis reports.
 *
 * The product surface of the prescriptions engine: once a subject (agent /
 * model / workspace) has accumulated enough traced data, a report can be
 * generated (or auto-generated for every stale eligible subject). Each
 * report is a battery of deterministic detectors — findings with evidence,
 * severity, honest savings estimates, and a prescribed action.
 *
 * Data:
 *   GET  /api/prescriptions               (report list; polled while running)
 *   GET  /api/prescriptions/eligibility   (which subjects have enough data)
 *   POST /api/prescriptions               (enqueue one report → 202)
 *   POST /api/prescriptions/auto-run      (enqueue all stale eligible → 202)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconPlayerPlay,
  IconRefresh,
  IconStethoscope,
} from '@tabler/icons-react';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { DetailCard } from '@/components/common/ui/DetailShell';
import FormShell, { FormField, FormSection } from '@/components/common/ui/FormShell';

interface ReportRow {
  _id: string;
  subjectKind: 'agent' | 'model' | 'workspace';
  subjectName?: string | null;
  windowDays: number;
  status: 'pending' | 'running' | 'ready' | 'failed';
  error?: string | null;
  findings: Array<{ severity: 'info' | 'warn' | 'critical'; estMonthlySavingsUsd: number | null }>;
  createdAt?: string;
}

interface EligibilityEntry {
  subjectKind: 'agent' | 'model' | 'workspace';
  subjectName?: string;
  sessionsCount: number;
  eligible: boolean;
  lastReportId?: string;
  lastReportAt?: string;
  stale: boolean;
}

interface Eligibility {
  windowDays: number;
  minSessions: number;
  staleDays: number;
  entries: EligibilityEntry[];
}

const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
];

function subjectLabel(row: { subjectKind: string; subjectName?: string | null }): string {
  return row.subjectKind === 'workspace' ? 'Workspace' : `${row.subjectName ?? '?'}`;
}

function statusBadge(status: ReportRow['status']) {
  const color = status === 'ready' ? 'teal' : status === 'failed' ? 'red' : 'yellow';
  return <Badge size="sm" color={color} variant="light">{status}</Badge>;
}

export default function PrescriptionsPage() {
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoRunNote, setAutoRunNote] = useState<string | null>(null);

  // New-analysis overlay state
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [subjectKind, setSubjectKind] = useState<'agent' | 'model' | 'workspace'>('agent');
  const [subjectName, setSubjectName] = useState<string>('');
  const [windowDays, setWindowDays] = useState('14');
  const [submitting, setSubmitting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const [rRes, eRes] = await Promise.all([
        fetch('/api/prescriptions?limit=100', { cache: 'no-store' }),
        fetch('/api/prescriptions/eligibility', { cache: 'no-store' }),
      ]);
      if (rRes.ok) setReports(((await rRes.json()).reports ?? []) as ReportRow[]);
      if (eRes.ok) setEligibility((await eRes.json()) as Eligibility);
      if (!rRes.ok) setError('Failed to load reports');
      else setError(null);
    } catch {
      setError('Failed to load reports');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while any report is in flight.
  const hasInFlight = useMemo(
    () => reports.some((r) => r.status === 'pending' || r.status === 'running'),
    [reports],
  );
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (hasInFlight) {
      pollRef.current = setInterval(() => void load(), 2500);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasInFlight, load]);

  const agentOptions = useMemo(
    () =>
      (eligibility?.entries ?? [])
        .filter((e) => e.subjectKind === 'agent' && e.subjectName)
        .map((e) => ({
          value: e.subjectName!,
          label: `${e.subjectName} (${e.sessionsCount.toLocaleString()} sessions)`,
        })),
    [eligibility],
  );

  const enqueue = useCallback(
    async (kind: 'agent' | 'model' | 'workspace', name?: string, window?: string) => {
      const res = await fetch('/api/prescriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectKind: kind,
          subjectName: name || undefined,
          windowDays: Number(window ?? windowDays),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to enqueue analysis');
      }
      await load();
    },
    [load, windowDays],
  );

  const submitOverlay = useCallback(async () => {
    setSubmitting(true);
    try {
      await enqueue(subjectKind, subjectKind === 'workspace' ? undefined : subjectName, windowDays);
      setOverlayOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enqueue analysis');
    } finally {
      setSubmitting(false);
    }
  }, [enqueue, subjectKind, subjectName, windowDays]);

  const autoRun = useCallback(async () => {
    setAutoRunning(true);
    setAutoRunNote(null);
    try {
      const res = await fetch('/api/prescriptions/auto-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const body = await res.json();
        const n = (body.enqueued ?? []).length;
        setAutoRunNote(n > 0 ? `Enqueued ${n} report(s).` : 'Nothing to do — no stale eligible subjects.');
        await load();
      } else {
        setAutoRunNote('Auto-run failed.');
      }
    } catch {
      setAutoRunNote('Auto-run failed.');
    } finally {
      setAutoRunning(false);
    }
  }, [load]);

  const eligibleStale = useMemo(
    () => (eligibility?.entries ?? []).filter((e) => e.eligible && e.stale),
    [eligibility],
  );

  return (
    <PageContainer>
      <PageHeader
        title="Prescriptions"
        subtitle="Automated analysis over observed traffic: deterministic detectors turn tracing + cost evidence into findings with prescribed actions. Numbers come from detectors only — nothing is estimated by a model."
        actions={
          <Group gap="xs">
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              loading={autoRunning}
              onClick={() => void autoRun()}
              title="Generate a report for every eligible subject whose latest report is stale"
            >
              Analyze stale ({eligibleStale.length})
            </Button>
            <Button
              leftSection={<IconStethoscope size={16} />}
              onClick={() => setOverlayOpen(true)}
            >
              New analysis
            </Button>
          </Group>
        }
      />

      {error ? (
        <Alert color="red" icon={<IconInfoCircle size={16} />} mb="md">{error}</Alert>
      ) : null}
      {autoRunNote ? (
        <Alert color="blue" icon={<IconInfoCircle size={16} />} mb="md" withCloseButton onClose={() => setAutoRunNote(null)}>
          {autoRunNote}
        </Alert>
      ) : null}

      {loading ? (
        <Group justify="center" py="xl"><Loader size="sm" /></Group>
      ) : (
        <>
          <DetailCard
            title="Eligibility"
            description={
              eligibility
                ? `Subjects with ≥${eligibility.minSessions} sessions in the last ${eligibility.windowDays} days qualify for automatic analysis; a ready report older than ${eligibility.staleDays} days counts as stale.`
                : 'Eligibility unavailable.'
            }
          >
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Subject</Table.Th>
                  <Table.Th>Sessions</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last report</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(eligibility?.entries ?? []).map((entry) => (
                  <Table.Tr key={`${entry.subjectKind}:${entry.subjectName ?? ''}`}>
                    <Table.Td>
                      <Group gap={6}>
                        <Badge size="xs" variant="default">{entry.subjectKind}</Badge>
                        <Text size="sm">{subjectLabel(entry)}</Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>{entry.sessionsCount.toLocaleString()}</Table.Td>
                    <Table.Td>
                      {entry.eligible ? (
                        <Badge size="sm" color={entry.stale ? 'yellow' : 'teal'} variant="light">
                          {entry.stale ? 'analysis due' : 'up to date'}
                        </Badge>
                      ) : (
                        <Badge size="sm" color="gray" variant="light">not enough data</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {entry.lastReportId ? (
                        <Link href={`/dashboard/cost/prescriptions/${entry.lastReportId}`}>
                          <Text size="sm" c="blue">
                            {entry.lastReportAt ? new Date(entry.lastReportAt).toLocaleString() : 'view'}
                          </Text>
                        </Link>
                      ) : (
                        <Text size="sm" c="dimmed">—</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {entry.eligible ? (
                        <Button
                          size="compact-xs"
                          variant="light"
                          leftSection={<IconPlayerPlay size={13} />}
                          onClick={() =>
                            void enqueue(entry.subjectKind, entry.subjectName).catch((err) =>
                              setError(err instanceof Error ? err.message : 'Failed'),
                            )
                          }
                        >
                          Analyze
                        </Button>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </DetailCard>

          <DetailCard title="Reports" description="Newest first. In-flight reports refresh automatically.">
            {reports.length === 0 ? (
              <Text size="sm" c="dimmed" py="md">
                No reports yet — run your first analysis from the header, or wait for a subject to accumulate enough data.
              </Text>
            ) : (
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Subject</Table.Th>
                    <Table.Th>Window</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Findings</Table.Th>
                    <Table.Th>Est. savings</Table.Th>
                    <Table.Th>Created</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {reports.map((report) => {
                    const critical = report.findings?.filter((f) => f.severity === 'critical').length ?? 0;
                    const warned = report.findings?.filter((f) => f.severity === 'warn').length ?? 0;
                    const savings = (report.findings ?? []).reduce(
                      (sum, f) => sum + (f.estMonthlySavingsUsd ?? 0),
                      0,
                    );
                    return (
                      <Table.Tr key={report._id}>
                        <Table.Td>
                          <Link href={`/dashboard/cost/prescriptions/${report._id}`}>
                            <Group gap={6}>
                              <Badge size="xs" variant="default">{report.subjectKind}</Badge>
                              <Text size="sm" c="blue">{subjectLabel(report)}</Text>
                            </Group>
                          </Link>
                        </Table.Td>
                        <Table.Td>{report.windowDays}d</Table.Td>
                        <Table.Td>
                          <Group gap={6}>
                            {statusBadge(report.status)}
                            {report.status === 'failed' && report.error ? (
                              <Text size="xs" c="red" title={report.error} lineClamp={1} maw={220}>
                                {report.error}
                              </Text>
                            ) : null}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          {report.status === 'ready' ? (
                            <Group gap={6}>
                              {critical > 0 ? <Badge size="sm" color="red" variant="light">{critical} critical</Badge> : null}
                              {warned > 0 ? <Badge size="sm" color="yellow" variant="light">{warned} warn</Badge> : null}
                              {critical === 0 && warned === 0 ? <Badge size="sm" color="teal" variant="light">clean</Badge> : null}
                            </Group>
                          ) : (
                            <Text size="sm" c="dimmed">—</Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {report.status === 'ready' && savings > 0 ? (
                            <Text size="sm" fw={600}>${savings.toFixed(2)}/mo</Text>
                          ) : (
                            <Text size="sm" c="dimmed">—</Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {report.createdAt ? new Date(report.createdAt).toLocaleString() : '—'}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
          </DetailCard>
        </>
      )}

      <FormShell
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        title="New analysis"
        subtitle="Runs the deterministic detector battery over the subject's observed window. Generation is asynchronous — the report appears in the list and refreshes on its own."
        icon={<IconStethoscope size={20} />}
        primaryAction={{
          label: 'Run analysis',
          loading: submitting,
          disabled: subjectKind !== 'workspace' && !subjectName.trim(),
          onClick: () => void submitOverlay(),
        }}
      >
        <FormSection title="Subject" description="What the report is about.">
          <FormField label="Kind">
            <Select
              data={[
                { value: 'agent', label: 'Agent' },
                { value: 'model', label: 'Model' },
                { value: 'workspace', label: 'Workspace (all traffic)' },
              ]}
              value={subjectKind}
              onChange={(v) => {
                setSubjectKind((v as typeof subjectKind) ?? 'agent');
                setSubjectName('');
              }}
              allowDeselect={false}
            />
          </FormField>
          {subjectKind === 'agent' ? (
            <FormField label="Agent" hint="Agents observed in the eligibility window.">
              <Select
                data={agentOptions}
                value={subjectName || null}
                onChange={(v) => setSubjectName(v ?? '')}
                searchable
                placeholder="Pick an agent"
              />
            </FormField>
          ) : null}
          {subjectKind === 'model' ? (
            <FormField label="Model name" hint="Exact model name as it appears in tracing (e.g. gpt-5.6-terra).">
              <TextInput
                value={subjectName}
                onChange={(e) => setSubjectName(e.currentTarget.value)}
                placeholder="model name"
              />
            </FormField>
          ) : null}
        </FormSection>
        <FormSection title="Window" description="How far back the detectors look.">
          <FormField label="Analysis window">
            <Select data={WINDOWS} value={windowDays} onChange={(v) => setWindowDays(v ?? '14')} allowDeselect={false} />
          </FormField>
        </FormSection>
      </FormShell>
    </PageContainer>
  );
}
