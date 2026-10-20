'use client';

import { Group, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import CopyButton from './CopyButton';

export interface StorageLocationProps {
  /**
   * Where the files physically are (`s3://bucket/prefix/...`), as the server describes it. `null` = this server's
   * disk, which has no address to show; `undefined` = not known (yet).
   */
  location: string | null | undefined;
  /** Hide the copy button (a preview that is still being typed). */
  copyable?: boolean;
}

/** A storage location in monospace, copyable; the local disk is named in words and warned about. */
export default function StorageLocation({ location, copyable = true }: StorageLocationProps) {
  const t = useTranslations('files.common');

  if (location === undefined) return <span className="ds-faint">—</span>;

  if (location === null) {
    return (
      <div>
        <Text size="sm">{t('storage.thisServerDisk')}</Text>
        <Text size="xs" c="dimmed">
          {t('storage.thisServerDiskHint')}
        </Text>
      </div>
    );
  }

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Text className="ds-mono" size="xs" style={{ wordBreak: 'break-all', minWidth: 0 }}>
        {location}
      </Text>
      {copyable ? <CopyButton value={location} label={t('storage.copy')} /> : null}
    </Group>
  );
}
