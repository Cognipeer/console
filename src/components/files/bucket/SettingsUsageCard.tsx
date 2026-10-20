'use client';

import { Button, Text } from '@mantine/core';
import { IconFiles, IconDatabase, IconFileUpload } from '@tabler/icons-react';
import { DetailCard } from '@/components/common/ui/DetailShell';
import StatTile from '@/components/common/ui/StatTile';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { BucketDetail } from '../filesApi';
import { filesErrorMessage, formatBytes, formatCount } from '../shared';
import { useFilesLimits } from '../useFilesQueries';
import { quotaOf, type Gauge } from './settingsModel';
import styles from './bucket.module.css';

interface UsageGaugeProps {
  label: string;
  /** "1.2 GB of 10 GB". */
  valueText: string;
  gauge: Gauge;
  unlimitedText: string;
}

/** A labelled bar: how much of a limit is used. An unlimited quota has no bar, only a sentence. */
function UsageGauge({ label, valueText, gauge, unlimitedText }: UsageGaugeProps) {
  const fill = gauge.tone === 'err' ? styles.gaugeErr : gauge.tone === 'warn' ? styles.gaugeWarn : '';
  return (
    <div>
      <div className={styles.gaugeHead}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span className="ds-muted">{valueText}</span>
      </div>
      {gauge.percent === null ? (
        <Text size="xs" c="dimmed">
          {unlimitedText}
        </Text>
      ) : (
        <div
          className={styles.gaugeTrack}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={gauge.percent}
          aria-valuetext={valueText}
        >
          <div className={`${styles.gaugeFill} ${fill}`.trim()} style={{ width: `${gauge.percent}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Usage: what this bucket holds, the project's storage and file limits (the quota is the whole project's, not only
 * this bucket's), and the largest file an upload into it can carry.
 */
export default function SettingsUsageCard({ bucket }: { bucket: BucketDetail }) {
  const t = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const limitsQuery = useFilesLimits({ bucketKey: bucket.key });
  const limits = limitsQuery.data;
  const quota = quotaOf(limits);

  return (
    <DetailCard title={t('usage.title')} description={t('usage.description')}>
      <div className="ds-stat-grid">
        <StatTile
          label={t('usage.files')}
          icon={<IconFiles size={13} stroke={1.7} aria-hidden="true" />}
          value={formatCount(bucket.stats?.fileCount, locale)}
        />
        <StatTile
          label={t('usage.stored')}
          icon={<IconDatabase size={13} stroke={1.7} aria-hidden="true" />}
          value={formatBytes(bucket.stats?.totalBytes)}
        />
        <StatTile
          label={t('usage.maxFile')}
          icon={<IconFileUpload size={13} stroke={1.7} aria-hidden="true" />}
          value={limits ? formatBytes(limits.maxFileBytes) : '—'}
        />
      </div>
      {limitsQuery.isError && !limits ? (
        <div role="alert" style={{ marginTop: 14, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <Text size="sm" c="dimmed">
            {t('usage.limitsFailed', { reason: filesErrorMessage(limitsQuery.error, tc) })}
          </Text>
          <Button size="xs" variant="default" loading={limitsQuery.isFetching} onClick={() => void limitsQuery.refetch()}>
            {t('usage.retry')}
          </Button>
        </div>
      ) : null}
      {quota ? (
        <div className={styles.gauges}>
          <UsageGauge
            label={t('usage.projectStorage')}
            valueText={
              quota.storage.limit === null
                ? formatBytes(quota.storage.used)
                : t('usage.of', { used: formatBytes(quota.storage.used), limit: formatBytes(quota.storage.limit) })
            }
            gauge={quota.storage}
            unlimitedText={t('usage.noStorageLimit')}
          />
          <UsageGauge
            label={t('usage.projectFiles')}
            valueText={
              quota.files.limit === null
                ? formatCount(quota.files.used, locale)
                : t('usage.of', { used: formatCount(quota.files.used, locale), limit: formatCount(quota.files.limit, locale) })
            }
            gauge={quota.files}
            unlimitedText={t('usage.noFilesLimit')}
          />
        </div>
      ) : null}
    </DetailCard>
  );
}
