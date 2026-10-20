'use client';

import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';

export interface BucketStatusBadgeProps {
  /** `status` of the bucket. */
  status: string;
  /** A delete-with-files job is running: shown instead of the status. */
  deleting?: boolean;
}

/** Active / Disabled / Deleting in the viewer's language (the plain `StatusBadge` labels are English). */
export default function BucketStatusBadge({ status, deleting }: BucketStatusBadgeProps) {
  const t = useTranslations('files.common');
  if (deleting) return <StatusBadge status="warn" label={t('bucketStatus.deleting')} />;
  if (status === 'active') return <StatusBadge status="active" label={t('bucketStatus.active')} />;
  return <StatusBadge status="paused" label={t('bucketStatus.disabled')} />;
}
