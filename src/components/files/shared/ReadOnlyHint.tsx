'use client';

import { Alert, Group, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';

export interface ReadOnlyHintProps {
  /** `inline`: one quiet line (beside the actions that are missing). `banner`: a note across the page. */
  variant?: 'inline' | 'banner';
}

/**
 * Says why the write controls are not there. Only a hint: the server decides what a person may do,
 * and shows the same words (`useFilesAccess().canWrite` is the cue to render this).
 */
export default function ReadOnlyHint({ variant = 'inline' }: ReadOnlyHintProps) {
  const t = useTranslations('files.common');

  if (variant === 'banner') {
    return (
      <Alert variant="light" color="gray" icon={<IconLock size={16} />} role="note">
        {t('readOnly.hint')}
      </Alert>
    );
  }

  return (
    <Group gap={6} wrap="nowrap" role="note">
      <IconLock size={14} aria-hidden="true" />
      <Text size="xs" c="dimmed">
        {t('readOnly.hint')}
      </Text>
    </Group>
  );
}
