'use client';

import Link from 'next/link';
import type { ReactNode } from "react";
import { Button, CloseButton, Stack, Text } from '@mantine/core';
import { IconBellOff, IconCheck, IconEye, IconUserCheck } from '@tabler/icons-react';
import { formatDateTime, formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  entityHref,
  entityOf,
  entityTypeLabel,
  formatDurationBetween,
  metricLabel,
  type AlertCatalog,
} from '../alertCatalog';
import type { IncidentDto, IncidentStatus } from '../alertTypes';
import { canTransition, describeRowValue, isSnoozed, severityBadgeClass, statusBadgeClass } from '../incidentUi';
import { canSnooze } from '../incident/incidentModel';

interface Props {
  incident: IncidentDto;
  catalog: AlertCatalog;
  links: Record<string, string | null>;
  userLabel: (id: string | null | undefined, serverName?: string | null) => string;
  busy?: boolean;
  onClose: () => void;
  onStatus: (status: IncidentStatus) => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onAssignMe: () => void;
}

/** Side panel of the inbox: the incident at a glance and its primary actions; the list stays usable next to it. */
export default function PreviewPane({ incident, catalog, links, userLabel, busy, onClose, onStatus, onSnooze, onUnsnooze, onAssignMe }: Props) {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const entity = entityOf(incident);
  const href = entity ? entityHref(entity.type, entity.key, links) : null;
  const value = describeRowValue(incident, catalog, ta, locale);
  const snoozed = isSnoozed(incident);
  const detailHref = `/dashboard/alerts/incidents/${incident._id}`;

  return (
    <aside className="ds-card ds-card-pad" aria-label={t('ux.preview.title')} style={{ position: 'sticky', top: 12, maxHeight: 'calc(100vh - 24px)', overflowY: 'auto' }}>
      <div className="ds-row-between" style={{ alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <Link href={detailHref} style={{ color: 'inherit', textDecoration: 'none' }}>
            <Text fw={700} size="md" style={{ overflowWrap: 'anywhere' }}>
              {incident.ruleName}
            </Text>
          </Link>
          <div className="ds-row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span className={statusBadgeClass(incident.status)}>{t(`status.${incident.status}`)}</span>
            <span className={severityBadgeClass(incident.severity)}>{t(`severity.${incident.severity}`)}</span>
            {snoozed ? <span className="ds-badge">{t('ux.snooze.badge')}</span> : null}
          </div>
        </div>
        <CloseButton aria-label={t('ux.preview.close')} onClick={onClose} />
      </div>

      <Stack gap={6} mt="md">
        <Row label={t('metric')} value={metricLabel(catalog, incident.metric, ta)} />
        {entity ? (
          <Row
            label={entity.type ? entityTypeLabel(entity.type, ta) : t('entity')}
            value={
              href ? (
                <Link href={href}>
                  <span className="ds-mono">{entity.key}</span>
                </Link>
              ) : (
                <span className="ds-mono">{entity.key}</span>
              )
            }
          />
        ) : null}
        <Row label={t('actualValue')} value={<span style={{ color: 'var(--ds-warn)', fontWeight: 600 }}>{value.value}</span>} />
        {value.compare ? <Row label={t('ux.preview.compare')} value={value.compare} /> : null}
        <Row label={t('columns.fired')} value={<span title={formatDateTime(incident.firedAt, locale)}>{formatRelative(incident.firedAt, locale)}</span>} />
        <Row label={t('columns.duration')} value={formatDurationBetween(incident.firedAt, incident.resolvedAt ?? incident.closedAt ?? null)} />
        <Row label={t('assignedTo')} value={incident.assignedTo ? userLabel(incident.assignedTo, incident.assignedToName) : t('unassignedLabel')} />
        {snoozed ? <Row label={t('ux.snooze.until')} value={formatDateTime(incident.snoozedUntil, locale)} /> : null}
        {incident.notes?.length ? <Row label={t('ux.preview.notes')} value={String(incident.notes.length)} /> : null}
      </Stack>

      <div className="ds-row" style={{ gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
        {canTransition(incident.status, 'acknowledged') ? (
          <Button size="xs" variant="default" leftSection={<IconEye size={13} />} disabled={busy} onClick={() => onStatus('acknowledged')}>
            {t('acknowledge')}
          </Button>
        ) : null}
        {canTransition(incident.status, 'resolved') ? (
          <Button size="xs" color="teal" leftSection={<IconCheck size={13} />} disabled={busy} onClick={() => onStatus('resolved')}>
            {t('resolve')}
          </Button>
        ) : null}
        {snoozed ? (
          <Button size="xs" variant="default" leftSection={<IconBellOff size={13} />} disabled={busy} onClick={onUnsnooze}>
            {t('ux.snooze.clear')}
          </Button>
        ) : canSnooze(incident.status) ? (
          <Button size="xs" variant="default" leftSection={<IconBellOff size={13} />} disabled={busy} onClick={onSnooze}>
            {t('ux.snooze.button')}
          </Button>
        ) : null}
        {!incident.assignedTo ? (
          <Button size="xs" variant="default" leftSection={<IconUserCheck size={13} />} disabled={busy} onClick={onAssignMe}>
            {t('assignToMe')}
          </Button>
        ) : null}
        <Button component={Link} href={detailHref} size="xs" variant="light">
          {t('viewDetail')}
        </Button>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ds-row-between" style={{ gap: 12, fontSize: 12.5, alignItems: 'flex-start' }}>
      <span className="ds-muted" style={{ flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}
