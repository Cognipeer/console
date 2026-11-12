'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Text } from '@mantine/core';
import { EntityHealthCharts, buildFailingSessionsHref } from '@/components/tracing/health';
import { formatDateTime } from '@/components/iam/timeFormat';
import { useIncidentHealthSeries } from '@/lib/api/queries/alerts';
import { useLocale, useTranslations } from '@/lib/i18n';
import { DetailCard } from '@/components/common/ui/DetailShell';
import { CardSkeleton } from '@/components/common/ui/Skeletons';
import { formatMetricValue, metricUnit, operatorSymbol, type AlertCatalog } from '../alertCatalog';
import type { IncidentDto } from '../alertTypes';
import { rowMode } from '../incidentUi';
import { incidentChartRange } from './incidentModel';

interface Props {
  incident: IncidentDto;
  catalog: AlertCatalog;
  entity: { type: string | null; key: string } | null;
}

/**
 * The entity's health around the incident: the entity-health charts of the tracing health page, over a window
 * that starts a few hours before the firing and ends shortly after the incident did. The firing is marked on the
 * charts; the condition that fired is spelled out above them. Only agents have a health series in the core build.
 */
export default function IncidentMetricChart({ incident, catalog, entity }: Props) {
  const t = useTranslations('incidents');
  const ta = useTranslations('alerts');
  const locale = useLocale();
  const supported = entity?.type === 'agent' && Boolean(entity.key);
  const range = useMemo(() => incidentChartRange(incident), [incident]);
  const agent = supported ? entity!.key : '';
  const fromIso = range ? new Date(range.fromMs).toISOString() : '';
  const toIso = range ? new Date(range.toMs).toISOString() : '';
  const query = useIncidentHealthSeries(agent, fromIso, toIso, Boolean(agent && range));
  const series = query.data ?? null;
  const state = query.isError ? 'error' : query.isFetching ? 'loading' : 'idle';

  const withMarker = useMemo(() => {
    if (!series) return null;
    const firedMs = Date.parse(incident.firedAt);
    const markers = [...(series.markers ?? []).filter((marker) => marker.type !== 'incident' || Math.abs(marker.t - firedMs) > 60_000)];
    if (Number.isFinite(firedMs)) markers.push({ t: firedMs, type: 'incident', label: incident.ruleName });
    return { ...series, markers };
  }, [series, incident.firedAt, incident.ruleName]);

  if (!supported || !range) return null;

  const mode = rowMode(incident);
  const unit = metricUnit(catalog, incident.metric);
  const operator = incident.metadata?.operator as string | undefined;
  const condition =
    mode === 'threshold'
      ? t('ux.chart.condition', { operator: operatorSymbol(operator), threshold: formatMetricValue(incident.threshold, unit, locale), value: formatMetricValue(incident.actualValue, unit, locale) })
      : ta(`mode.${mode}`);
  const sessionsHref = buildFailingSessionsHref(agent, range);

  return (
    <DetailCard title={t('ux.chart.title')} description={t('ux.chart.description', { from: formatDateTime(new Date(range.fromMs).toISOString(), locale), to: formatDateTime(new Date(range.toMs).toISOString(), locale) })}>
      <div className="ds-row-between" style={{ gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <Text size="sm">{condition}</Text>
        <Link href={sessionsHref}>{t('ux.chart.failingSessions')}</Link>
      </div>
      {state === 'loading' && !withMarker ? <CardSkeleton /> : null}
      {state === 'error' && !withMarker ? (
        <Text size="sm" c="dimmed">
          {t('ux.chart.unavailable')}
        </Text>
      ) : null}
      {withMarker ? <EntityHealthCharts series={withMarker} chartHeight={180} /> : null}
    </DetailCard>
  );
}
