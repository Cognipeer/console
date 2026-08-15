'use client';

/**
 * Cost → Prescriptions → report detail.
 *
 * One report: header tiles (window totals), the findings with evidence and
 * prescribed actions (lifecycle: applied / dismissed / reopen), and the
 * optional LLM narrative — generated FROM the findings, clearly labeled as
 * narration, never a source of numbers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconCheck,
  IconExternalLink,
  IconInfoCircle,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import Link from 'next/link';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import { DetailCard } from '@/components/common/ui/DetailShell';

interface Finding {
  id: string;
  detector: string;
  category: 'cost' | 'reliability' | 'performance' | 'hygiene';
  severity: 'info' | 'warn' | 'critical';
  title: string;
  summary: string;
  evidence: Array<{ label: string; value: string }>;
  estMonthlySavingsUsd: number | null;
  prescription: { action: string; ctaLabel?: string; ctaHref?: string };
  status: 'open' | 'applied' | 'dismissed';
}

interface Report {
  _id: string;
  subjectKind: 'agent' | 'model' | 'workspace';
  subjectName?: string | null;
  windowDays: number;
  from?: string | null;
  to?: string | null;
  status: 'pending' | 'running' | 'ready' | 'failed';
  error?: string | null;
  totals?: {
    sessions: number | null;
    requests: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  } | null;
  findings: Finding[];
  narrative?: { text: string; modelKey: string; generatedAt: string } | null;
  createdAt?: string;
}

function severityColor(severity: Finding['severity']): string {
  return severity === 'critical' ? 'red' : severity === 'warn' ? 'yellow' : 'blue';
}

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

export default function PrescriptionReportPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const reportId = params?.id;

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
  const [narrativeModel, setNarrativeModel] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!reportId) return;
    try {
      const res = await fetch(`/api/prescriptions/${reportId}`, { cache: 'no-store' });
      if (res.status === 404) {
        setError('Report not found');
        return;
      }
      if (res.ok) {
        setReport((await res.json()) as Report);
        setError(null);
      }
    } catch {
      setError('Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while generation is in flight.
  const inFlight = report?.status === 'pending' || report?.status === 'running';
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (inFlight) pollRef.current = setInterval(() => void load(), 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [inFlight, load]);

  // Hub LLMs for the narrative writer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/models?category=llm', { cache: 'no-store' });
        if (res.ok && !cancelled) {
          const body = await res.json();
          setModels(
            ((body.models ?? []) as Array<{ key: string; name: string }>).map((m) => ({
              value: m.key,
              label: m.name,
            })),
          );
        }
      } catch {
        // Narrative stays unavailable without hub models — not an error state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setFindingStatus = useCallback(
    async (findingId: string, status: Finding['status']) => {
      if (!reportId) return;
      const res = await fetch(`/api/prescriptions/${reportId}/findings/${encodeURIComponent(findingId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) setReport((await res.json()) as Report);
    },
    [reportId],
  );

  const generateNarrative = useCallback(async () => {
    if (!reportId || !narrativeModel) return;
    setNarrating(true);
    try {
      const res = await fetch(`/api/prescriptions/${reportId}/narrative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelKey: narrativeModel }),
      });
      if (res.ok) {
        setReport((await res.json()) as Report);
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Narrative generation failed');
      }
    } catch {
      setError('Narrative generation failed');
    } finally {
      setNarrating(false);
    }
  }, [narrativeModel, reportId]);

  const totalSavings = useMemo(
    () => (report?.findings ?? []).reduce((sum, f) => sum + (f.estMonthlySavingsUsd ?? 0), 0),
    [report],
  );

  const subject = report
    ? report.subjectKind === 'workspace'
      ? 'Workspace'
      : `${report.subjectName ?? '?'}`
    : '';

  return (
    <PageContainer>
      <PageHeader
        title={report ? `Analysis: ${subject}` : 'Analysis report'}
        subtitle={
          report
            ? `${report.subjectKind} · last ${report.windowDays} days${report.createdAt ? ` · generated ${new Date(report.createdAt).toLocaleString()}` : ''}`
            : undefined
        }
        actions={
          <Button
            variant="default"
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => router.push('/dashboard/cost/prescriptions')}
          >
            All reports
          </Button>
        }
      />

      {error ? (
        <Alert color="red" icon={<IconInfoCircle size={16} />} mb="md">{error}</Alert>
      ) : null}

      {loading || !report ? (
        <Group justify="center" py="xl"><Loader size="sm" /></Group>
      ) : inFlight ? (
        <Alert color="blue" icon={<Loader size={14} />}>
          Analysis is running — detectors are reading the window&apos;s evidence. This page refreshes automatically.
        </Alert>
      ) : report.status === 'failed' ? (
        <Alert color="red" icon={<IconInfoCircle size={16} />}>
          Report generation failed{report.error ? `: ${report.error}` : '.'}
        </Alert>
      ) : (
        <Stack gap="md">
          <div className="ds-stat-grid">
            <StatTile label="Sessions" value={fmt(report.totals?.sessions)} />
            <StatTile label="Requests" value={fmt(report.totals?.requests)} />
            <StatTile label="Total tokens" value={fmt(report.totals?.totalTokens)} />
            <StatTile
              label="Window cost"
              value={report.totals?.costUsd != null ? `$${report.totals.costUsd.toFixed(2)}` : '—'}
            />
            <StatTile
              label="Est. savings"
              value={totalSavings > 0 ? `$${totalSavings.toFixed(2)}/mo` : '—'}
              delta="conservative, priced findings only"
            />
          </div>

          <DetailCard
            title="Narrative"
            description="An LLM narrates the findings below — it is generated from them and adds no numbers of its own."
            actions={
              <Group gap="xs">
                <Select
                  size="xs"
                  w={220}
                  data={models}
                  value={narrativeModel}
                  onChange={setNarrativeModel}
                  placeholder="Narrator model (hub)"
                  searchable
                />
                <Button
                  size="compact-sm"
                  variant="light"
                  leftSection={<IconSparkles size={14} />}
                  disabled={!narrativeModel}
                  loading={narrating}
                  onClick={() => void generateNarrative()}
                >
                  {report.narrative ? 'Regenerate' : 'Generate'}
                </Button>
              </Group>
            }
          >
            {report.narrative ? (
              <>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{report.narrative.text}</Text>
                <Text size="xs" c="dimmed" mt="xs">
                  Written by {report.narrative.modelKey} · {new Date(report.narrative.generatedAt).toLocaleString()}
                </Text>
              </>
            ) : (
              <Text size="sm" c="dimmed">
                No narrative yet. Pick a hub model and generate one — useful for sharing the report with people who won&apos;t read detector output.
              </Text>
            )}
          </DetailCard>

          {report.findings.length === 0 ? (
            <Alert color="teal" icon={<IconCheck size={16} />}>
              No findings — every detector stayed silent for this window. Either the subject is healthy, or there is not enough traced evidence yet (tool menus, system prompts and cache figures only exist when the tracer records them).
            </Alert>
          ) : (
            report.findings.map((finding) => (
              <DetailCard
                key={finding.id}
                title={
                  <Group gap={8}>
                    <Badge size="sm" color={severityColor(finding.severity)} variant="filled">
                      {finding.severity}
                    </Badge>
                    <Badge size="sm" variant="default">{finding.category}</Badge>
                    <Text fw={600}>{finding.title}</Text>
                    {finding.status !== 'open' ? (
                      <Badge size="sm" color={finding.status === 'applied' ? 'teal' : 'gray'} variant="light">
                        {finding.status}
                      </Badge>
                    ) : null}
                  </Group>
                }
                actions={
                  <Group gap={6}>
                    {finding.status !== 'applied' ? (
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="teal"
                        leftSection={<IconCheck size={13} />}
                        onClick={() => void setFindingStatus(finding.id, 'applied')}
                        title="Mark as applied — the next report on this subject shows whether the metric moved"
                      >
                        Applied
                      </Button>
                    ) : null}
                    {finding.status !== 'dismissed' ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        leftSection={<IconX size={13} />}
                        onClick={() => void setFindingStatus(finding.id, 'dismissed')}
                      >
                        Dismiss
                      </Button>
                    ) : (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        onClick={() => void setFindingStatus(finding.id, 'open')}
                      >
                        Reopen
                      </Button>
                    )}
                  </Group>
                }
              >
                <Stack gap="sm" style={finding.status === 'dismissed' ? { opacity: 0.55 } : undefined}>
                  <Text size="sm">{finding.summary}</Text>
                  {finding.evidence.length > 0 ? (
                    <Table withTableBorder={false} verticalSpacing={4}>
                      <Table.Tbody>
                        {finding.evidence.map((row, i) => (
                          <Table.Tr key={`${finding.id}-ev-${i}`}>
                            <Table.Td w={260}><Text size="xs" c="dimmed">{row.label}</Text></Table.Td>
                            <Table.Td><Text size="xs" ff="monospace">{row.value}</Text></Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  ) : null}
                  <Group justify="space-between" align="flex-end">
                    <Text size="sm" fw={500} style={{ flex: 1 }}>
                      Prescription: <Text span size="sm" fw={400}>{finding.prescription.action}</Text>
                    </Text>
                    <Group gap="xs">
                      {finding.estMonthlySavingsUsd != null && finding.estMonthlySavingsUsd > 0 ? (
                        <Badge color="teal" variant="light">~${finding.estMonthlySavingsUsd}/mo</Badge>
                      ) : null}
                      {finding.prescription.ctaHref ? (
                        <Link href={finding.prescription.ctaHref}>
                          <Button size="compact-xs" variant="default" rightSection={<IconExternalLink size={12} />}>
                            {finding.prescription.ctaLabel ?? 'Open'}
                          </Button>
                        </Link>
                      ) : null}
                    </Group>
                  </Group>
                </Stack>
              </DetailCard>
            ))
          )}
        </Stack>
      )}
    </PageContainer>
  );
}
