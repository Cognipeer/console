'use client';

import { SegmentedControl, Text } from '@mantine/core';
import StatTile from '@/components/common/ui/StatTile';
import { useTranslations } from '@/lib/i18n';
import type { IncidentStatsDto } from '../alertTypes';
import { STATS_RANGES, formatDurationMs, type StatsRange } from './inboxModel';

interface Props {
  range: StatsRange;
  onRangeChange: (range: StatsRange) => void;
  stats: IncidentStatsDto | null;
  failed: boolean;
}

/** Open / acknowledged now, and for the chosen range what was fired and resolved plus the median time to acknowledge and resolve. */
export default function InboxKpis({ range, onRangeChange, stats, failed }: Props) {
  const t = useTranslations('incidents');
  const dash = '—';
  const count = (value: number | undefined) => (stats ? String(value ?? 0) : dash);
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="ds-row-between" style={{ marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <Text size="xs" c="dimmed">
          {failed ? t('ux.kpi.unavailable') : t('ux.kpi.note')}
        </Text>
        <SegmentedControl
          size="xs"
          value={range}
          onChange={(value) => onRangeChange(value as StatsRange)}
          aria-label={t('ux.kpi.range')}
          data={STATS_RANGES.map((value) => ({ value, label: t(`ux.kpi.ranges.${value}`) }))}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <StatTile label={t('ux.kpi.open')} value={count(stats?.open)} />
        <StatTile label={t('ux.kpi.acknowledged')} value={count(stats?.acknowledged)} />
        <StatTile label={t('ux.kpi.fired', { range: t(`ux.kpi.ranges.${range}`) })} value={count(stats?.firedInRange)} />
        <StatTile label={t('ux.kpi.resolved', { range: t(`ux.kpi.ranges.${range}`) })} value={count(stats?.resolvedInRange)} />
        <StatTile label={t('ux.kpi.mtta')} value={stats ? formatDurationMs(stats.mttaMs) : dash} delta={stats && stats.mttaMs != null ? t('ux.kpi.median', { count: stats.mttaSample }) : undefined} />
        <StatTile label={t('ux.kpi.mttr')} value={stats ? formatDurationMs(stats.mttrMs) : dash} delta={stats && stats.mttrMs != null ? t('ux.kpi.median', { count: stats.mttrSample }) : undefined} />
      </div>
      {stats?.capped ? (
        <Text size="xs" c="dimmed" mt={6}>
          {t('ux.kpi.capped')}
        </Text>
      ) : null}
    </div>
  );
}
