'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Text } from '@mantine/core';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { formatRelative } from '@/components/iam/timeFormat';
import { useLocale, useTranslations } from '@/lib/i18n';
import { formatDurationMs } from '../inbox/inboxModel';
import { statusBadgeClass } from '../incidentUi';
import type { SimilarIncidentsDto } from '../alertTypes';

/** The server stops counting here; show "200+" rather than a figure that looks exact. */
const COUNT_CEILING = 200;

/** How often this rule fired on this entity over the last 30 days, how long those incidents took, and the latest few. */
export default function SimilarIncidentsCard({ incidentId, relatedPath }: { incidentId: string; relatedPath: string }) {
  const t = useTranslations('incidents');
  const locale = useLocale();
  const [data, setData] = useState<SimilarIncidentsDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setFailed(false);
    fetch(`/api/alerts/incidents/${encodeURIComponent(incidentId)}/similar`, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('similar');
        return (await res.json()) as SimilarIncidentsDto;
      })
      .then((body) => {
        if (!controller.signal.aborted) setData(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [incidentId]);

  return (
    <DetailCard title={t('ux.similar.title')} description={t('ux.similar.description')}>
      {failed ? (
        <Text size="sm" c="dimmed">
          {t('ux.similar.unavailable')}
        </Text>
      ) : !data ? (
        <Text size="sm" c="dimmed">
          {t('ux.loading')}
        </Text>
      ) : data.count30d === 0 ? (
        <Text size="sm">{t('ux.similar.first')}</Text>
      ) : (
        <div className="ds-col ds-gap-sm">
          <div className="ds-row-between" style={{ fontSize: 13 }}>
            <span className="ds-muted">{t('ux.similar.count')}</span>
            <strong>{data.count30d >= COUNT_CEILING ? `${COUNT_CEILING}+` : data.count30d}</strong>
          </div>
          <div className="ds-row-between" style={{ fontSize: 13 }}>
            <span className="ds-muted">{t('ux.similar.median')}</span>
            <strong>{formatDurationMs(data.medianDurationMs)}</strong>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.last.map((row) => (
              <li key={row.id} className="ds-row-between" style={{ padding: '4px 0', gap: 8, fontSize: 12.5 }}>
                <Link href={`/dashboard/alerts/incidents/${row.id}`}>{formatRelative(row.firedAt, locale)}</Link>
                <span className="ds-row" style={{ gap: 6 }}>
                  <span className="ds-faint">{row.resolvedAt ? formatDurationMs(Date.parse(row.resolvedAt) - Date.parse(row.firedAt)) : '—'}</span>
                  <span className={statusBadgeClass(row.status)}>{t(`status.${row.status}`)}</span>
                </span>
              </li>
            ))}
          </ul>
          <Link href={relatedPath}>{t('relatedIncidents')}</Link>
        </div>
      )}
    </DetailCard>
  );
}
