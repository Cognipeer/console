'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Badge, Button, Center, Stack, Text, Textarea, Timeline } from '@mantine/core';
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
  IconRestore,
  IconSearch,
  IconUserCheck,
  IconUserMinus,
} from '@tabler/icons-react';
import DetailShell, { DetailCard, DetailTwoCol } from '@/components/common/ui/DetailShell';
import { DetailSkeleton } from '@/components/common/ui/Skeletons';
import { formatDateTime } from '@/components/iam/timeFormat';
import LoadError from '@/components/alerts/LoadError';
import { isAbortError, readApiError } from '@/components/alerts/apiError';
import {
  entityHref,
  entityOf,
  entityTypeLabel,
  formatMetricValue,
  formatMinutes,
  inferModule,
  metricLabel,
  metricUnit,
  moduleColor,
  moduleLabel,
  operatorSymbol,
} from '@/components/alerts/alertCatalog';
import { useAlertMeta } from '@/components/alerts/useAlertMeta';
import { userLabel as resolveUserLabel, useUserDirectory } from '@/components/alerts/useUserDirectory';
import type { IncidentDto, IncidentStatus } from '@/components/alerts/alertTypes';
import {
  INCIDENT_TRANSITIONS,
  describeRowValue,
  internalPath,
  rowMode,
  severityBadgeClass,
  statusActionKey,
  statusBadgeClass,
  timelineEntries,
  translateServerNotes,
  type TimelineEntry,
} from '@/components/alerts/incidentUi';
import { useLocale, useTranslations } from '@/lib/i18n';

const STATUS_ICONS: Record<IncidentStatus, typeof IconFlame> = {
  open: IconFlame,
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
};

const ACTION_ICONS: Record<IncidentStatus, typeof IconFlame> = {
  open: IconRestore,
  acknowledged: IconEye,
  investigating: IconSearch,
  resolved: IconCheck,
  closed: IconLock,
};

export default function IncidentDetailPage() {
  const params = useParams<{ incidentId: string }>();
  const router = useRouter();
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const incidentId = params?.incidentId;
  const { catalog } = useAlertMeta();
  const directory = useUserDirectory();

  const [incident, setIncident] = useState<IncidentDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  const [noteLoading, setNoteLoading] = useState(false);
  const [inflight, setInflight] = useState<string | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const load = useCallback(
    async (silent = false) => {
      if (!incidentId) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const res = await fetch(`/api/alerts/incidents/${encodeURIComponent(incidentId)}`, { cache: 'no-store', signal: controller.signal });
        if (res.status === 404) {
          setNotFound(true);
          setIncident(null);
          return;
        }
        if (!res.ok) throw new Error(await readApiError(res, t('loadError')));
        const data = (await res.json()) as { incident: IncidentDto };
        setIncident(data.incident);
        setNotFound(false);
        setError(null);
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : t('loadError'));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [incidentId, t],
  );

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const patchIncident = async (body: Record<string, unknown>, key: string, failure: string) => {
    if (!incident) return;
    setInflight(key);
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readApiError(res, failure));
      const data = (await res.json()) as { incident: IncidentDto };
      setIncident(data.incident);
      return data.incident;
    } catch (err) {
      notifications.show({ color: 'red', title: t('error'), message: err instanceof Error ? err.message : failure });
    } finally {
      setInflight(null);
    }
    return undefined;
  };

  const changeStatus = async (status: IncidentStatus) => {
    const updated = await patchIncident({ status }, status, t('statusUpdateError'));
    if (updated) {
      notifications.show({ color: 'teal', title: t('statusUpdated'), message: t('statusUpdatedMessage', { status: t(`status.${status}`) }) });
    }
  };

  const assign = async (assignee: 'me' | null) => {
    const updated = await patchIncident({ assignedTo: assignee }, 'assign', t('assignError'));
    if (updated) {
      notifications.show({ color: 'teal', title: t('assignUpdated'), message: assignee ? t('assignedToYou') : t('unassigned') });
    }
  };

  const addNote = async () => {
    if (!incident || !noteContent.trim()) return;
    setNoteLoading(true);
    try {
      const res = await fetch(`/api/alerts/incidents/${incident._id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: noteContent }),
      });
      if (!res.ok) throw new Error(await readApiError(res, t('noteError')));
      const data = (await res.json()) as { incident: IncidentDto };
      setIncident(data.incident);
      setNoteContent('');
      notifications.show({ color: 'teal', title: t('noteAdded'), message: t('noteAddedMessage') });
    } catch (err) {
      notifications.show({ color: 'red', title: t('error'), message: err instanceof Error ? err.message : t('noteError') });
    } finally {
      setNoteLoading(false);
    }
  };

  if (loading) return <DetailSkeleton tabs={0} actions={2} />;

  if (notFound || !incident) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          {error ? <LoadError message={error} onRetry={() => void load()} /> : <Text c="dimmed">{t('notFound')}</Text>}
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/alerts/incidents')}>
            {t('backToIncidents')}
          </Button>
        </Stack>
      </Center>
    );
  }

  const moduleId = inferModule(catalog, incident.metric, incident.module);
  const unit = metricUnit(catalog, incident.metric);
  const label = metricLabel(catalog, incident.metric, ta);
  const entity = entityOf(incident);
  const entityLink = entity ? entityHref(entity.type, entity.key) : null;
  const operator = incident.metadata?.operator as string | undefined;
  const windowMinutes = (incident.context?.windowMinutes ?? (incident.metadata?.windowMinutes as number | undefined)) || undefined;
  const sampleCount = incident.metadata?.sampleCount as number | undefined;
  const mode = rowMode(incident);
  const StatusIcon = STATUS_ICONS[incident.status] ?? IconAlertTriangle;
  const lastValue = incident.lastValue ?? incident.actualValue;
  const { value: valueText, compare: compareText } = describeRowValue(incident, catalog, ta, locale);
  // An absence incident stores a request count, not a metric value: its peak and latest value are counts too.
  const formatStored = (value: number | null | undefined) => formatMetricValue(value, mode === 'absence' ? '' : unit, locale);

  const userLabel = (id: string | null | undefined, serverName?: string | null): string =>
    resolveUserLabel(id, directory, { you: t('you'), system: t('system') }, serverName);

  // The translated type reads lowercase inside sentences ("agent"); as a row label it starts a capital.
  const typeLabel = entity ? entityTypeLabel(entity.type, ta) : '—';
  const entityRowLabel = typeLabel === '—' ? t('entity') : `${typeLabel.charAt(0).toLocaleUpperCase(locale)}${typeLabel.slice(1)}`;

  const entityChip = entity ? (
    entityLink ? (
      <Link href={entityLink} style={{ textDecoration: 'none' }}>
        <span className="ds-badge ds-badge-info">
          <span className="ds-mono">{entity.key}</span>
        </span>
      </Link>
    ) : (
      <span className="ds-badge">
        <span className="ds-mono">{entity.key}</span>
      </span>
    )
  ) : null;

  // Separators go only between the items that are present.
  const metaItems: Array<{ key: string; node: ReactNode }> = [
    { key: 'metric', node: <span className="ds-mono">{label}</span> },
    ...(entityChip ? [{ key: 'entity', node: entityChip }] : []),
    {
      key: 'value',
      node: (
        <span>
          <span style={{ color: 'var(--ds-warn)', fontWeight: 600 }}>{valueText}</span>
          {compareText ? <span className="ds-faint"> {compareText}</span> : null}
        </span>
      ),
    },
    { key: 'fired', node: <span>{t('firedOn', { time: formatDateTime(incident.firedAt, locale) })}</span> },
  ];

  const actions = (
    <>
      <Button variant="default" size="sm" leftSection={<IconRefresh size={14} stroke={1.7} />} loading={refreshing} onClick={() => void load(true)}>
        {t('refresh')}
      </Button>
      {INCIDENT_TRANSITIONS[incident.status].map((status) => {
        const Icon = ACTION_ICONS[status];
        const primary = status === 'resolved';
        return (
          <Button
            key={status}
            size="sm"
            color={primary ? 'teal' : undefined}
            variant={primary ? 'filled' : 'default'}
            leftSection={<Icon size={13} stroke={1.7} />}
            loading={inflight === status}
            disabled={inflight !== null && inflight !== status}
            onClick={() => void changeStatus(status)}
          >
            {t(statusActionKey(status, incident.status))}
          </Button>
        );
      })}
      {incident.assignedTo ? (
        <Button variant="default" size="sm" leftSection={<IconUserMinus size={13} stroke={1.7} />} loading={inflight === 'assign'} onClick={() => void assign(null)}>
          {t('unassign')}
        </Button>
      ) : (
        <Button variant="default" size="sm" leftSection={<IconUserCheck size={13} stroke={1.7} />} loading={inflight === 'assign'} onClick={() => void assign('me')}>
          {t('assignToMe')}
        </Button>
      )}
    </>
  );

  const correlations = incident.context?.correlations ?? [];
  const signatures = incident.context?.errorSignatures ?? [];
  const failing = incident.context?.failingSessions ?? null;
  const failingPath = internalPath(failing?.listPath);
  const versionChange = incident.context?.versionChange ?? null;
  const firstSeenMs = versionChange?.firstSeenAt ? Date.parse(versionChange.firstSeenAt) : Number.NaN;
  const firedMs = Date.parse(incident.firedAt);
  const versionFirstSeen = Number.isFinite(firstSeenMs) && Number.isFinite(firedMs) && firstSeenMs <= firedMs
    ? t('versionFirstSeen', { duration: formatMinutes(Math.max(1, Math.round((firedMs - firstSeenMs) / 60_000)), ta) })
    : null;
  const contextNotes = translateServerNotes(incident.context?.notes, ta, locale === 'en');
  const hasContext = Boolean(versionChange || signatures.length || failing || correlations.length || contextNotes.length);

  const entries = timelineEntries(incident);
  const rulePath = `/dashboard/alerts?edit=${encodeURIComponent(incident.ruleId)}`;
  const relatedPath = `/dashboard/alerts/incidents?ruleId=${encodeURIComponent(incident.ruleId)}${entity ? `&entityKey=${encodeURIComponent(entity.key)}` : ''}&status=all`;

  return (
    <DetailShell
      backHref="/dashboard/alerts/incidents"
      backLabel={t('backToIncidents')}
      icon={
        <div style={{ width: 48, height: 48, borderRadius: 10, background: 'var(--ds-accent-soft)', color: 'var(--ds-accent)', display: 'grid', placeItems: 'center' }}>
          <StatusIcon size={22} stroke={1.7} />
        </div>
      }
      title={
        <>
          <h1 className="ds-h2" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
            {incident.ruleName}
          </h1>
          <span className={statusBadgeClass(incident.status)}>{t(`status.${incident.status}`)}</span>
          <span className={severityBadgeClass(incident.severity)}>{t(`severity.${incident.severity}`)}</span>
          <Badge size="sm" variant="light" color={moduleColor(moduleId)}>
            {moduleLabel(moduleId, ta)}
          </Badge>
          {incident.autoResolved ? <span className="ds-badge ds-badge-teal">{t('autoResolved')}</span> : null}
        </>
      }
      meta={
        <>
          {metaItems.map((item, index) => (
            <Fragment key={item.key}>
              {index > 0 ? <span className="ds-faint">·</span> : null}
              {item.node}
            </Fragment>
          ))}
        </>
      }
    >
      {/* Six actions would squeeze the title column in the header, so they sit in a toolbar of their own. */}
      <div className="ds-row ds-gap-sm" style={{ marginBottom: 14 }}>
        {actions}
      </div>
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <LoadError message={error} onRetry={() => void load(true)} />
        </div>
      ) : null}
      <DetailTwoCol narrowAside>
        <Stack gap="md">
          <DetailCard title={t('detection')}>
            <div className="ds-tbl-wrap">
              <table className="ds-tbl">
                <tbody>
                  <DetailRow label={t('metric')} value={label} />
                  <DetailRow label={t('detectionMode')} value={ta(`mode.${mode}`)} />
                  {entity ? (
                    <DetailRow label={entityRowLabel} value={entityChip} />
                  ) : null}
                  <DetailRow label={t('actualValue')} value={<span style={{ color: 'var(--ds-warn)', fontWeight: 600 }}>{valueText}</span>} />
                  {incident.peakValue != null ? <DetailRow label={t('peakValue')} value={formatStored(incident.peakValue)} /> : null}
                  {incident.lastValue != null && incident.lastValue !== incident.actualValue ? (
                    <DetailRow label={t('lastValue')} value={formatStored(lastValue)} />
                  ) : null}
                  {incident.baselineValue != null ? (
                    <DetailRow label={t('baselineValue')} value={formatStored(incident.baselineValue)} />
                  ) : null}
                  {mode === 'threshold' ? (
                    <DetailRow
                      label={t('condition')}
                      value={
                        <span className="ds-mono">
                          {operatorSymbol(operator)} {formatMetricValue(incident.threshold, unit, locale)}
                        </span>
                      }
                    />
                  ) : null}
                  {windowMinutes ? <DetailRow label={t('window')} value={formatMinutes(windowMinutes, ta)} /> : null}
                  {sampleCount != null ? <DetailRow label={t('samples')} value={String(sampleCount)} /> : null}
                </tbody>
              </table>
            </div>
          </DetailCard>

          <DetailCard title={t('contextTitle')} description={t('contextDescription')}>
            {!hasContext ? (
              <Text size="sm" c="dimmed">
                {t('noContext')}
              </Text>
            ) : (
              <Stack gap="md">
                {versionChange ? (
                  <ContextBlock title={t('versionChange')}>
                    <Text size="sm">
                      <span className="ds-mono">{versionChange.from ?? t('versionNone')}</span> → <span className="ds-mono">{versionChange.to ?? t('versionNone')}</span>
                    </Text>
                    {versionFirstSeen ? (
                      <Text size="xs" c="dimmed" mt={2}>
                        {versionFirstSeen}
                      </Text>
                    ) : null}
                  </ContextBlock>
                ) : null}
                {signatures.length > 0 ? (
                  <ContextBlock title={t('errorSignatures')}>
                    <Stack gap={6}>
                      {signatures.map((signature) => (
                        <div key={signature.message} className="ds-row-between" style={{ gap: 12, alignItems: 'flex-start' }}>
                          <Text size="sm" className="ds-mono" style={{ wordBreak: 'break-word' }}>
                            {signature.message}
                          </Text>
                          <span className="ds-badge">{t('occurrences', { count: signature.count })}</span>
                        </div>
                      ))}
                    </Stack>
                  </ContextBlock>
                ) : null}
                {failing ? (
                  <ContextBlock title={t('failingSessions')}>
                    {failingPath ? (
                      <Link href={failingPath}>{t('failingSessionsLink', { count: failing.count })}</Link>
                    ) : (
                      <Text size="sm">{t('failingSessionsCount', { count: failing.count })}</Text>
                    )}
                  </ContextBlock>
                ) : null}
                {correlations.length > 0 ? (
                  <ContextBlock title={t('correlations')}>
                    <div className="ds-tbl-wrap">
                      <table className="ds-tbl">
                        <thead>
                          <tr>
                            <th>{t('correlationEntity')}</th>
                            <th>{t('metric')}</th>
                            <th style={{ textAlign: 'right' }}>{t('actualValue')}</th>
                            <th style={{ textAlign: 'right' }}>{t('baselineValue')}</th>
                            <th style={{ textAlign: 'right' }}>{t('ratio')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {correlations.map((entry) => {
                            const href = entityHref(entry.entityType, entry.entityKey);
                            const entryUnit = metricUnit(catalog, entry.metric);
                            return (
                              <tr key={`${entry.entityType}:${entry.entityKey}:${entry.metric}`}>
                                <td>
                                  <span className="ds-mono">{href ? <Link href={href}>{entry.entityKey}</Link> : entry.entityKey}</span>
                                  <div className="ds-faint" style={{ fontSize: 11 }}>
                                    {entityTypeLabel(entry.entityType, ta)}
                                  </div>
                                </td>
                                <td>{metricLabel(catalog, entry.metric, ta)}</td>
                                <td style={{ textAlign: 'right' }}>{formatMetricValue(entry.value, entryUnit, locale)}</td>
                                <td style={{ textAlign: 'right' }}>{formatMetricValue(entry.baseline, entryUnit, locale)}</td>
                                <td style={{ textAlign: 'right' }}>{entry.ratio == null ? '—' : `${entry.ratio.toFixed(1)}×`}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </ContextBlock>
                ) : null}
                {contextNotes.length > 0 ? (
                  <ContextBlock title={t('contextNotes')}>
                    <Stack gap={4}>
                      {contextNotes.map((note) => (
                        <Text key={note} size="sm">
                          {note}
                        </Text>
                      ))}
                    </Stack>
                  </ContextBlock>
                ) : null}
              </Stack>
            )}
          </DetailCard>

          <DetailCard title={t('activity')}>
            <Timeline active={entries.length - 1} bulletSize={24} lineWidth={2}>
              {entries.map((entry, index) => (
                <Timeline.Item key={`${entry.kind}-${entry.at}-${index}`} bullet={<TimelineBullet entry={entry} />} title={timelineTitle(entry, t, userLabel)}>
                  <Text size="xs" c="dimmed">
                    {formatDateTime(entry.at, locale)}
                  </Text>
                  {entry.content ? (
                    <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {entry.content}
                    </Text>
                  ) : null}
                </Timeline.Item>
              ))}
            </Timeline>

            <Stack gap="xs" mt="md">
              <Textarea
                aria-label={t('addNote')}
                placeholder={t('addNotePlaceholder')}
                value={noteContent}
                maxLength={4000}
                onChange={(event) => setNoteContent(event.currentTarget.value)}
                minRows={2}
                maxRows={6}
                autosize
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button color="teal" size="sm" leftSection={<IconMessage size={13} stroke={1.7} />} onClick={() => void addNote()} loading={noteLoading} disabled={!noteContent.trim()}>
                  {t('addNote')}
                </Button>
              </div>
            </Stack>
          </DetailCard>
        </Stack>

        <Stack gap="md">
          <DetailCard title={t('linksTitle')}>
            <Stack gap={8}>
              <Link href={rulePath}>{t('openRule')}</Link>
              {entityLink ? <Link href={entityLink}>{t('openEntityHealth')}</Link> : null}
              <Link href={relatedPath}>{t('relatedIncidents')}</Link>
            </Stack>
          </DetailCard>

          <DetailCard title={t('identifiers')}>
            <KeyValue label={t('incidentId')} value={<span className="ds-mono">{incident._id.slice(0, 12)}…</span>} />
            <KeyValue label={t('ruleId')} value={<span className="ds-mono">{incident.ruleId.slice(0, 12)}…</span>} />
            <KeyValue label={t('eventId')} value={<span className="ds-mono">{incident.alertEventId.slice(0, 12)}…</span>} />
            <KeyValue label={t('assignedTo')} value={incident.assignedTo ? userLabel(incident.assignedTo, incident.assignedToName) : t('unassignedLabel')} />
          </DetailCard>
        </Stack>
      </DetailTwoCol>
    </DetailShell>
  );
}

function timelineTitle(entry: TimelineEntry, t: (key: string, values?: Record<string, string | number>) => string, userLabel: (id: string | null | undefined, serverName?: string | null) => string): string {
  switch (entry.kind) {
    case 'fired':
      return t('timelineFired');
    case 'acknowledged':
      return entry.by ? t('timelineAcknowledgedBy', { user: userLabel(entry.by, entry.byName) }) : t('timelineAcknowledged');
    case 'resolved':
      return entry.system ? t('timelineResolvedBySystem') : entry.by ? t('timelineResolvedBy', { user: userLabel(entry.by, entry.byName) }) : t('timelineResolved');
    case 'closed':
      return t('timelineClosed');
    default:
      return entry.by ?? t('timelineNote');
  }
}

function TimelineBullet({ entry }: { entry: TimelineEntry }) {
  switch (entry.kind) {
    case 'fired':
      return <IconFlame size={12} />;
    case 'acknowledged':
      return <IconEye size={12} />;
    case 'resolved':
      return <IconCheck size={12} />;
    case 'closed':
      return <IconLock size={12} />;
    default:
      return <IconMessage size={12} />;
  }
}

function ContextBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="ds-eyebrow" style={{ display: 'flex', fontSize: 10.5, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ds-row-between" style={{ padding: '6px 0', fontSize: 12.5 }}>
      <span className="ds-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <tr>
      <td style={{ width: '40%', verticalAlign: 'top' }}>
        <span className="ds-muted" style={{ fontSize: 12.5 }}>
          {label}
        </span>
      </td>
      <td style={{ verticalAlign: 'top' }}>
        <span style={{ fontSize: 12.5, wordBreak: 'break-word' }}>{value}</span>
      </td>
    </tr>
  );
}
