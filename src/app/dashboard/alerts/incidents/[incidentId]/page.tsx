'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Button,
  Center,
  Loader,
  Stack,
  Text,
  Textarea,
  Timeline,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconEye,
  IconFlame,
  IconLock,
  IconMessage,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';
import DetailShell, {
  DetailCard,
  DetailTwoCol,
} from '@/components/common/ui/DetailShell';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';

interface IncidentNote {
  userId: string;
  userName: string;
  content: string;
  createdAt: string;
}

interface Incident {
  _id: string;
  ruleName: string;
  ruleId: string;
  alertEventId: string;
  metric: string;
  threshold: number;
  actualValue: number;
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
  assignedTo?: string;
  notes: IncidentNote[];
  firedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  resolvedBy?: string;
  metadata?: Record<string, unknown>;
}

const METRIC_LABELS: Record<string, string> = {
  error_rate: 'Error Rate',
  avg_latency_ms: 'Avg Latency',
  p95_latency_ms: 'P95 Latency',
  total_cost: 'Total Cost',
  total_requests: 'Total Requests',
  gpu_cache_usage: 'GPU Cache',
  request_queue_depth: 'Queue Depth',
  guardrail_fail_rate: 'Fail Rate',
  guardrail_avg_latency_ms: 'Avg Latency',
  guardrail_total_evaluations: 'Total Evals',
  rag_avg_latency_ms: 'Avg Latency',
  rag_total_queries: 'Total Queries',
  rag_failed_documents: 'Failed Docs',
  mcp_error_rate: 'Error Rate',
  mcp_avg_latency_ms: 'Avg Latency',
  mcp_total_requests: 'Total Requests',
  evaluation_pass_rate: 'Pass Rate',
  evaluation_avg_score: 'Avg Score',
  analysis_pass_rate: 'Pass Rate',
  analysis_avg_judge_score: 'Avg Judge Score',
  analysis_avg_accuracy: 'Avg Accuracy',
  redteam_attack_success_rate: 'Attack Success Rate',
  redteam_resilience_score: 'Resilience Score',
};

const METRIC_UNITS: Record<string, string> = {
  error_rate: '%',
  avg_latency_ms: 'ms',
  p95_latency_ms: 'ms',
  total_cost: 'USD',
  total_requests: '',
  gpu_cache_usage: '%',
  request_queue_depth: '',
  guardrail_fail_rate: '%',
  guardrail_avg_latency_ms: 'ms',
  guardrail_total_evaluations: '',
  rag_avg_latency_ms: 'ms',
  rag_total_queries: '',
  rag_failed_documents: '',
  mcp_error_rate: '%',
  mcp_avg_latency_ms: 'ms',
  mcp_total_requests: '',
  evaluation_pass_rate: '%',
  evaluation_avg_score: '%',
  analysis_pass_rate: '%',
  analysis_avg_judge_score: '%',
  analysis_avg_accuracy: '%',
  redteam_attack_success_rate: '%',
  redteam_resilience_score: '%',
};

const MODULE_LABELS: Record<string, string> = {
  models: 'Model Hub',
  inference: 'Model Monitoring',
  guardrails: 'Guardrail',
  rag: 'Knowledge Engine',
  mcp: 'MCP Servers',
  evaluation: 'Evaluation',
  analysis: 'Analysis',
  redteam: 'Red Team',
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  investigating: 'Investigating',
  resolved: 'Resolved',
  closed: 'Closed',
};

const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  eq: '=',
};

function inferModule(metric: string): string {
  if (
    ['error_rate', 'avg_latency_ms', 'p95_latency_ms', 'total_cost', 'total_requests'].includes(
      metric,
    )
  )
    return 'models';
  if (['gpu_cache_usage', 'request_queue_depth'].includes(metric)) return 'inference';
  if (metric.startsWith('guardrail_')) return 'guardrails';
  if (metric.startsWith('rag_')) return 'rag';
  if (metric.startsWith('mcp_')) return 'mcp';
  if (metric.startsWith('evaluation_')) return 'evaluation';
  if (metric.startsWith('analysis_')) return 'analysis';
  if (metric.startsWith('redteam_')) return 'redteam';
  return 'models';
}

function statusBadgeVariant(status: Incident['status']) {
  switch (status) {
    case 'open':
      return 'err' as const;
    case 'acknowledged':
      return 'info' as const;
    case 'investigating':
      return 'paused' as const;
    case 'resolved':
      return 'ok' as const;
    case 'closed':
      return 'paused' as const;
    default:
      return 'info' as const;
  }
}

function severityBadgeClass(severity: Incident['severity']): string {
  switch (severity) {
    case 'critical':
      return 'ds-badge ds-badge-err';
    case 'warning':
      return 'ds-badge ds-badge-warn';
    case 'info':
      return 'ds-badge ds-badge-info';
    default:
      return 'ds-badge';
  }
}

const STATUS_ICONS: Record<string, typeof IconAlertTriangle> = {
  open: IconFlame,
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
};

export default function IncidentDetailPage() {
  const params = useParams<{ incidentId: string }>();
  const router = useRouter();
  const t = useTranslations('incidents');
  const incidentId = params?.incidentId;

  const [incident, setIncident] = useState<Incident | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [statusActionInflight, setStatusActionInflight] = useState<string | null>(null);

  const fetchIncident = useCallback(
    async (silent = false) => {
      if (!incidentId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/alerts/incidents/${incidentId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || 'Failed to load incident');
        }
        const data = await res.json();
        setIncident(data.incident);
      } catch (err) {
        notifications.show({
          color: 'red',
          title: t('error'),
          message: err instanceof Error ? err.message : t('error'),
        });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [incidentId, t],
  );

  useEffect(() => {
    void fetchIncident();
  }, [fetchIncident]);

  const handleStatusChange = async (newStatus: string) => {
    if (!incident) return;
    setStatusActionInflight(newStatus);
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || 'Failed to update status');
      }
      const data = await res.json();
      setIncident(data.incident);
      notifications.show({
        color: 'teal',
        title: t('statusUpdated'),
        message: t('statusUpdatedMessage', {
          status: STATUS_LABELS[newStatus] || newStatus,
        }),
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: t('error'),
        message: err instanceof Error ? err.message : t('statusUpdateError'),
      });
    } finally {
      setStatusActionInflight(null);
    }
  };

  const handleAddNote = async () => {
    if (!incident || !noteContent.trim()) return;
    setNoteLoading(true);
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      });
      if (!res.ok) throw new Error('Failed to add note');
      const data = await res.json();
      setIncident(data.incident);
      setNoteContent('');
      notifications.show({
        color: 'teal',
        title: t('noteAdded'),
        message: t('noteAddedMessage'),
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: t('error'),
        message: err instanceof Error ? err.message : t('noteError'),
      });
    } finally {
      setNoteLoading(false);
    }
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="md" />
      </Center>
    );
  }

  if (!incident) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">{t('notFound') || 'Incident not found'}</Text>
          <Button
            leftSection={<IconArrowLeft size={16} />}
            onClick={() => router.push('/dashboard/alerts/incidents')}
          >
            {t('backToIncidents') || 'Back to incidents'}
          </Button>
        </Stack>
      </Center>
    );
  }

  const mod = inferModule(incident.metric);
  const scope = incident.metadata?.scope as Record<string, string> | undefined;
  const operator = incident.metadata?.operator as string | undefined;
  const windowMin = incident.metadata?.windowMinutes as number | undefined;
  const sampleCount = incident.metadata?.sampleCount as number | undefined;
  const StatusIcon = STATUS_ICONS[incident.status] ?? IconAlertTriangle;
  const closed = incident.status === 'resolved' || incident.status === 'closed';
  const metricLabel = METRIC_LABELS[incident.metric] ?? incident.metric;
  const metricUnit = METRIC_UNITS[incident.metric] ?? '';

  const actions = (
    <>
      <Button
        variant="default"
        size="sm"
        leftSection={<IconRefresh size={14} stroke={1.7} />}
        loading={refreshing}
        onClick={() => void fetchIncident(true)}
      >
        Refresh
      </Button>
      {!closed ? (
        <>
          {incident.status === 'open' ? (
            <Button
              variant="default"
              size="sm"
              color="blue"
              leftSection={<IconEye size={13} stroke={1.7} />}
              loading={statusActionInflight === 'acknowledged'}
              onClick={() => void handleStatusChange('acknowledged')}
            >
              {t('acknowledge')}
            </Button>
          ) : null}
          {incident.status === 'open' || incident.status === 'acknowledged' ? (
            <Button
              variant="default"
              size="sm"
              color="violet"
              leftSection={<IconSearch size={13} stroke={1.7} />}
              loading={statusActionInflight === 'investigating'}
              onClick={() => void handleStatusChange('investigating')}
            >
              {t('investigate')}
            </Button>
          ) : null}
          <Button
            color="teal"
            size="sm"
            leftSection={<IconCheck size={13} stroke={1.7} />}
            loading={statusActionInflight === 'resolved'}
            onClick={() => void handleStatusChange('resolved')}
          >
            {t('resolve')}
          </Button>
          <Button
            variant="default"
            size="sm"
            leftSection={<IconLock size={13} stroke={1.7} />}
            loading={statusActionInflight === 'closed'}
            onClick={() => void handleStatusChange('closed')}
          >
            {t('close')}
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <DetailShell
      backHref="/dashboard/alerts/incidents"
      backLabel={t('backToIncidents') || 'Back to incidents'}
      icon={
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 10,
            background: 'var(--ds-accent-soft)',
            color: 'var(--ds-accent)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <StatusIcon size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1
            className="ds-h2"
            style={{ margin: 0, whiteSpace: 'nowrap', maxWidth: 540, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {incident.ruleName}
          </h1>
          <StatusBadge
            status={statusBadgeVariant(incident.status)}
            label={STATUS_LABELS[incident.status] ?? incident.status}
          />
          <span className={severityBadgeClass(incident.severity)}>
            {SEVERITY_LABELS[incident.severity] ?? incident.severity}
          </span>
          <span className="ds-badge ds-badge-info">{MODULE_LABELS[mod] ?? mod}</span>
        </>
      }
      meta={
        <>
          <span className="ds-mono">{metricLabel}</span>
          <span className="ds-faint">·</span>
          <span style={{ color: 'var(--ds-warn)', fontWeight: 600 }}>
            {Number(incident.actualValue).toFixed(2)}
            {metricUnit}
          </span>
          <span className="ds-faint">vs</span>
          <span className="ds-mono">
            {OPERATOR_SYMBOLS[operator ?? 'gt'] ?? '>'} {incident.threshold}
            {metricUnit}
          </span>
          <span className="ds-faint">·</span>
          <span>Fired {new Date(incident.firedAt).toLocaleString()}</span>
        </>
      }
      actions={actions}
    >
      <DetailTwoCol narrowAside>
        <Stack gap="md">
          <DetailCard title="Detection">
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <tbody>
                  <DetailRow label={t('metric')} value={metricLabel} />
                  <DetailRow
                    label={t('actualValue')}
                    value={
                      <span style={{ color: 'var(--ds-warn)', fontWeight: 600 }}>
                        {Number(incident.actualValue).toFixed(2)}
                        {metricUnit}
                      </span>
                    }
                  />
                  <DetailRow
                    label={t('condition')}
                    value={
                      <span className="ds-mono">
                        {OPERATOR_SYMBOLS[operator ?? 'gt'] ?? '>'} {incident.threshold}
                        {metricUnit}
                      </span>
                    }
                  />
                  {windowMin ? (
                    <DetailRow label={t('window')} value={`${windowMin} min`} />
                  ) : null}
                  {sampleCount != null ? (
                    <DetailRow label={t('samples')} value={String(sampleCount)} />
                  ) : null}
                  {scope?.modelKey ? (
                    <DetailRow label={t('model')} value={scope.modelKey} mono />
                  ) : null}
                  {scope?.serverKey ? (
                    <DetailRow label={t('server')} value={scope.serverKey} mono />
                  ) : null}
                  {scope?.guardrailKey ? (
                    <DetailRow label={t('guardrail')} value={scope.guardrailKey} mono />
                  ) : null}
                  {scope?.ragModuleKey ? (
                    <DetailRow label={t('ragModule')} value={scope.ragModuleKey} mono />
                  ) : null}
                </tbody>
              </table>
            </div>
          </DetailCard>

          <DetailCard title={t('notesTitle')}>
            {incident.notes.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('noNotes')}
              </Text>
            ) : (
              <Timeline
                active={incident.notes.length - 1}
                bulletSize={24}
                lineWidth={2}
              >
                {incident.notes.map((note, idx) => (
                  <Timeline.Item
                    key={idx}
                    bullet={<IconMessage size={12} />}
                    title={note.userName}
                  >
                    <Text size="xs" c="dimmed">
                      {new Date(note.createdAt).toLocaleString()}
                    </Text>
                    <Text size="sm" mt={4}>
                      {note.content}
                    </Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}

            <Stack gap="xs" mt="md">
              <Textarea
                placeholder={t('addNotePlaceholder')}
                value={noteContent}
                onChange={(e) => setNoteContent(e.currentTarget.value)}
                minRows={2}
                maxRows={6}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  color="teal"
                  size="sm"
                  leftSection={<IconMessage size={13} stroke={1.7} />}
                  onClick={() => void handleAddNote()}
                  loading={noteLoading}
                  disabled={!noteContent.trim()}
                >
                  {t('addNote')}
                </Button>
              </div>
            </Stack>
          </DetailCard>
        </Stack>

        <Stack gap="md">
          <DetailCard title={t('timeline')}>
            <Stack gap={6}>
              <TimelineRow
                label={t('firedAt')}
                value={new Date(incident.firedAt).toLocaleString()}
              />
              {incident.acknowledgedAt ? (
                <TimelineRow
                  label={t('acknowledgedAt')}
                  value={new Date(incident.acknowledgedAt).toLocaleString()}
                />
              ) : null}
              {incident.resolvedAt ? (
                <TimelineRow
                  label={t('resolvedAt')}
                  value={
                    <>
                      {new Date(incident.resolvedAt).toLocaleString()}
                      {incident.resolvedBy ? (
                        <span className="ds-faint"> · by {incident.resolvedBy}</span>
                      ) : null}
                    </>
                  }
                />
              ) : null}
              {incident.closedAt ? (
                <TimelineRow
                  label={t('closedAt')}
                  value={new Date(incident.closedAt).toLocaleString()}
                />
              ) : null}
            </Stack>
          </DetailCard>

          <DetailCard title="Identifiers">
            <div
              className="ds-row-between"
              style={{ padding: '6px 0', fontSize: 12.5 }}
            >
              <span className="ds-muted">Incident ID</span>
              <span className="ds-mono" style={{ fontSize: 11.5 }}>
                {incident._id.slice(0, 12)}…
              </span>
            </div>
            <div
              className="ds-row-between"
              style={{ padding: '6px 0', fontSize: 12.5 }}
            >
              <span className="ds-muted">Rule ID</span>
              <span className="ds-mono" style={{ fontSize: 11.5 }}>
                {incident.ruleId.slice(0, 12)}…
              </span>
            </div>
            <div
              className="ds-row-between"
              style={{ padding: '6px 0', fontSize: 12.5 }}
            >
              <span className="ds-muted">Event ID</span>
              <span className="ds-mono" style={{ fontSize: 11.5 }}>
                {incident.alertEventId.slice(0, 12)}…
              </span>
            </div>
            {incident.assignedTo ? (
              <div
                className="ds-row-between"
                style={{ padding: '6px 0', fontSize: 12.5 }}
              >
                <span className="ds-muted">Assigned to</span>
                <span>{incident.assignedTo}</span>
              </div>
            ) : null}
          </DetailCard>
        </Stack>
      </DetailTwoCol>
    </DetailShell>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <tr>
      <td style={{ width: '40%', verticalAlign: 'top' }}>
        <span className="ds-muted" style={{ fontSize: 12.5 }}>
          {label}
        </span>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <span
          className={mono ? 'ds-mono' : undefined}
          style={{ fontSize: 12.5, wordBreak: 'break-word' }}
        >
          {value}
        </span>
      </td>
    </tr>
  );
}

function TimelineRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="ds-eyebrow" style={{ fontSize: 10.5 }}>
        {label}
      </span>
      <span style={{ fontSize: 12.5 }}>{value}</span>
    </div>
  );
}
