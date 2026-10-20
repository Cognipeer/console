'use client';

import { Group, Text } from '@mantine/core';
import { useTranslations } from '@/lib/i18n';
import CopyButton from './CopyButton';

export interface StorageLocationProps {
  /**
   * Where the files physically are (`s3://bucket/prefix/...`), as the server describes it. `null` = no address to
   * show: this server's disk, or a provider whose settings name no bucket or container yet (see `localDisk`);
   * `undefined` = not loaded (yet).
   */
  location: string | null | undefined;
  /**
   * Whether the provider keeps its files on this server's disk, which is what a `null` location then means. `false`
   * (an S3 or Azure provider whose settings are incomplete, or a provider that is gone) words it as not known.
   * Left out, a `null` location is the server's disk.
   */
  localDisk?: boolean;
  /** Hide the copy button (a preview that is still being typed). */
  copyable?: boolean;
}

/** A path, then " · " and the host of the server that has it: how the S3 drivers tell two servers with one bucket name apart. */
const HOST_SUFFIX = /^(.*\/) \u00b7 [^/\s]+$/;

/** The location without the server named after it, for the copy button: `s3://docs/team/ · minio.local:9000` -> `s3://docs/team/`. */
export function locationPathOf(location: string): string {
  return HOST_SUFFIX.exec(location)?.[1] ?? location;
}

/**
 * A storage location in monospace, copyable (the path alone is copied, without the server named after it); the local
 * disk is named in words and warned about.
 */
export default function StorageLocation({ location, localDisk = true, copyable = true }: StorageLocationProps) {
  const t = useTranslations('files.common');

  if (location === undefined) return <span className="ds-faint">—</span>;

  if (location === null) {
    return (
      <div>
        <Text size="sm">{localDisk ? t('storage.thisServerDisk') : t('storage.unknown')}</Text>
        <Text size="xs" c="dimmed">
          {localDisk ? t('storage.thisServerDiskHint') : t('storage.unknownHint')}
        </Text>
      </div>
    );
  }

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Text className="ds-mono" size="xs" style={{ wordBreak: 'break-all', minWidth: 0 }}>
        {location}
      </Text>
      {copyable ? <CopyButton value={locationPathOf(location)} label={t('storage.copy')} /> : null}
    </Group>
  );
}
