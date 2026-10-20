'use client';

import { Group, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { BucketLock } from './detailModel';

export interface BucketLockHintProps {
  lock: BucketLock;
}

/**
 * Says why a file of this bucket cannot be changed from the drawer: the bucket is disabled, or is being deleted.
 * The sibling of `ReadOnlyHint`, which says the same about the person's access.
 */
export default function BucketLockHint({ lock }: BucketLockHintProps) {
  const t = useTranslations('files.detail');
  return (
    <Group gap={6} wrap="nowrap" role="note">
      <IconLock size={14} aria-hidden="true" />
      <Text size="xs" c="dimmed">
        {lock === 'deleting' ? t('locked.deleting') : t('locked.disabled')}
      </Text>
    </Group>
  );
}
