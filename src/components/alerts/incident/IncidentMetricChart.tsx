'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Text } from '@mantine/core';
import { EntityHealthCharts, buildFailingSessionsHref, type EntityHealthSeriesPayload } from '@/components/tracing/health';
import { formatDateTime } from '@/components/iam/timeFormat';
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
  const [series, setSeries] = useState<EntityHealthSeriesPayload | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const supported = entity?.type === 'agent' && Boolean(entity.key);
  const range = useMemo(() => incidentChartRange(incident), [incident]);
  const rangeKey = range ? `${range.fromMs}:${range.toMs}` : '';
  const agent = supported ? entity!.key : '';

  useEffect(() => {
    if (!agent || !range) return;
    const controller = new AbortController();
    setState('loading');
    const query = new URLSearchParams({ from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString() });
    fetch(`/api/tracing/agents/${encodeURIComponent(agent)}/health?${query.toString()}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('health');
        return (await res.json()) as EntityHealthSeriesPayload;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setSeries(data);
        setState('idle');
      })
      .catch(() => {
        if (!controller.signal.aborted) setState('error');
      });
    return () => controller.abort();
    // the range is covered by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, rangeKey]);

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
