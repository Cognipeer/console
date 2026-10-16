'use client';

import { useEffect, useMemo, useState } from 'react';
import { Text } from '@mantine/core';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import {
  DELIVERY_RETENTION_DAYS,
  LIBRARY_KIND,
  deliveriesBeyondRetention,
  deliveryCodeKey,
  groupDeliveries,
  type DeliveryDto,
  type DeliveryStatus,
} from './incidentModel';

interface Props {
  incidentId: string;
  /** When the incident fired: an empty log of an older one is explained by the retention, not by "nothing was sent". */
  firedAt?: string | null;
  /** Changes whenever the incident does (a new status can mean a new notification). */
  refreshKey: string;
}

const STATUS_CLASS: Record<DeliveryStatus, string> = {
  sent: 'ds-badge ds-badge-ok',
  failed: 'ds-badge ds-badge-err',
  suppressed: 'ds-badge',
};

/** Who was notified about the incident, per channel: every attempt, what became of it, and why one was held back. */
export default function DeliveryTimeline({ incidentId, firedAt, refreshKey }: Props) {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const [rows, setRows] = useState<DeliveryDto[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/alerts/incidents/${encodeURIComponent(incidentId)}/deliveries`, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('deliveries');
        return (await res.json()) as { deliveries?: DeliveryDto[] };
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setRows(data.deliveries ?? []);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [incidentId, refreshKey]);

  const groups = useMemo(() => groupDeliveries(rows ?? []), [rows]);
  const kindLabel = (kind: string) => {
    if (kind === LIBRARY_KIND) return t('ux.deliveries.sharedChannel');
    const known = ['email', 'webhook', 'slack', 'teams', 'pagerduty'];
    return known.includes(kind) ? ta(`channelTypes.${kind}`) : kind;
  };
  // A known code reads as its localized sentence, whether the row stored it as the reason or as the error text.
  const codeText = (attempt: DeliveryDto) => {
    const key = deliveryCodeKey(attempt);
    return key ? t(`ux.deliveries.reason.${key}`) : null;
  };

  return (
    <DetailCard title={t('ux.deliveries.title')} description={t('ux.deliveries.description')}>
      {failed && !rows ? (
        <Text size="sm" c="dimmed">
          {t('ux.deliveries.unavailable')}
        </Text>
      ) : rows && groups.length === 0 ? (
        <Text size="sm" c="dimmed">
          {deliveriesBeyondRetention(firedAt)
            ? t('ux.deliveries.emptyExpired', { days: DELIVERY_RETENTION_DAYS })
            : t('ux.deliveries.empty')}
        </Text>
      ) : (
        <div className="ds-col ds-gap-md">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="ds-row-between" style={{ marginBottom: 6, gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  {group.name ?? kindLabel(group.kind)}
                  {group.name ? (
                    <>
                      {' '}
                      <span className="ds-faint" style={{ fontWeight: 400 }}>· {kindLabel(group.kind)}</span>
                    </>
                  ) : null}
                </span>
                <span className="ds-faint" style={{ fontSize: 12 }}>
                  {t('ux.deliveries.summary', { sent: group.sent, failed: group.failed, suppressed: group.suppressed })}
                </span>
              </div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid var(--ds-border-soft)' }}>
                {group.attempts.map((attempt) => (
                  <li key={attempt._id} style={{ padding: '4px 0 4px 12px' }}>
                    <div className="ds-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <span className={STATUS_CLASS[attempt.status]}>{t(`ux.deliveries.status.${attempt.status}`)}</span>
                      <span style={{ fontSize: 12.5 }}>{t(`ux.deliveries.trigger.${attempt.trigger}`)}</span>
                      <span className="ds-faint" style={{ fontSize: 12 }}>
                        {formatDateTime(attempt.attemptAt, locale)}
                      </span>
                    </div>
                    {attempt.status === 'suppressed' && codeText(attempt) ? (
                      <Text size="xs" c="dimmed">
                        {codeText(attempt)}
                      </Text>
                    ) : null}
                    {attempt.status === 'failed' ? (
                      <Text size="xs" c="red" style={{ wordBreak: 'break-word' }}>
                        {codeText(attempt) ?? (attempt.error || t('ux.deliveries.unknownError'))}
                      </Text>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </DetailCard>
  );
}
