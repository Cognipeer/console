'use client';

import { useTranslations } from '@/lib/i18n';
import { ProviderHealthChip, providerHref } from '../shared';
import type { BucketListItem } from '../filesApi';
import { driverInfo } from './providerModel';

export interface BucketProviderCellProps {
  bucket: BucketListItem;
  /** The person may open the Providers area: a provider with a problem links there. */
  canManageProviders: boolean;
}

/**
 * The provider of a bucket in the list: its name, what kind of storage it is, and how it is doing. A provider that
 * cannot be used says why and links to its page, so the person does not have to guess from an upload that fails.
 */
export default function BucketProviderCell({ bucket, canManageProviders }: BucketProviderCellProps) {
  const t = useTranslations('files.list');
  const provider = bucket.provider;
  const driver = provider ? driverInfo(provider) : null;

  return (
    // A provider's own message (why a test failed) can be a long sentence: it wraps at this width instead of widening the column.
    <div className="ds-col" style={{ gap: 3, minWidth: 0, maxWidth: 380 }}>
      {provider ? (
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ds-text)' }}>{provider.label}</span>
      ) : (
        <span className="ds-faint" style={{ fontSize: 13 }}>
          {t('provider.unavailable')}
        </span>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 8, rowGap: 2 }}>
        {driver ? (
          <span className="ds-faint" style={{ fontSize: 12 }}>
            {driver.name}
          </span>
        ) : null}
        <ProviderHealthChip
          health={bucket.providerHealth}
          href={canManageProviders ? providerHref(provider) : null}
          showReason
        />
      </div>
    </div>
  );
}
