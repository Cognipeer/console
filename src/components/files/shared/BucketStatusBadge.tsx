'use client';

import { Tooltip, UnstyledButton } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useTranslations } from '@/lib/i18n';

export interface BucketStatusBadgeProps {
  /** `status` of the bucket. */
  status: string;
  /** A delete-with-files job is running: shown instead of the status. */
  deleting?: boolean;
  /**
   * Why the last delete-with-files run stopped before the bucket was gone (`deleteError`): shown instead of the
   * status, with the reason one hover or focus away.
   */
  deleteError?: string | null;
}

/** Active / Disabled / Deleting / Deletion failed in the viewer's language (the plain `StatusBadge` labels are English). */
export default function BucketStatusBadge({ status, deleting, deleteError }: BucketStatusBadgeProps) {
  const t = useTranslations('files.common');
  if (deleting) return <StatusBadge status="warn" label={t('bucketStatus.deleting')} />;
  if (deleteError) {
    const label = t('bucketStatus.deleteFailed');
    return (
      <span className="ds-badge ds-badge-err">
        <span className="ds-badge-dot" />
        {label}
        <Tooltip label={deleteError} multiline w={280} withArrow>
          <UnstyledButton type="button" aria-label={`${label}: ${deleteError}`} style={{ display: 'inline-flex', cursor: 'help' }}>
            <IconInfoCircle size={13} aria-hidden="true" />
          </UnstyledButton>
        </Tooltip>
      </span>
    );
  }
  if (status === 'active') return <StatusBadge status="active" label={t('bucketStatus.active')} />;
  return <StatusBadge status="paused" label={t('bucketStatus.disabled')} />;
}
