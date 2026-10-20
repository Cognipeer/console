'use client';

import { Alert, Button, Skeleton } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { SkeletonRegion } from '@/components/common/ui/Skeletons';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import {
  canPreviewMarkdown,
  CopyButton,
  filesErrorMessage,
  formatBytes,
  MarkdownStatusBadge,
  PREVIEW_MAX_BYTES,
  ReadOnlyHint,
} from '../shared';
import { useConvertObject, useObjectText } from '../useFilesQueries';
import BucketLockHint from './BucketLockHint';
import type { BucketLock } from './detailModel';
import TextBlock from './TextBlock';
import styles from './FileDetailDrawer.module.css';

export interface MarkdownPanelProps {
  bucketKey: string;
  record: FileRecordView;
  /** A hint only (see `useFilesAccess`); the server decides. */
  canWrite: boolean;
  /** The bucket takes no changes (disabled, or being deleted): no conversion can be started, and the panel says why. */
  lock?: BucketLock | null;
  /** A conversion was started: the host refreshes what it shows. */
  onStarted: () => void;
}

function MarkdownText({ bucketKey, record }: { bucketKey: string; record: FileRecordView }) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const query = useObjectText(bucketKey, record.key, 'markdown');
  if (query.isPending) {
    return (
      <SkeletonRegion label={t('markdown.loading')}>
        <Skeleton height={180} radius="md" />
      </SkeletonRegion>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} role="alert">
        {filesErrorMessage(query.error, tc)}
      </Alert>
    );
  }
  return (
    <>
      <div className={styles.copyRow}>
        <CopyButton value={query.data} label={t('markdown.copy')} />
      </div>
      <TextBlock text={query.data} label={t('markdown.textLabel', { name: record.name })} emptyLabel={t('markdown.empty')} />
    </>
  );
}

/**
 * The Markdown copy of the file: where the conversion stands, why it failed, the copy's text (as plain text),
 * and, for someone who may change files, the button that (re)starts the conversion. A conversion that is still
 * running is followed by the drawer's record query, which polls while it is pending.
 */
export default function MarkdownPanel({ bucketKey, record, canWrite, lock = null, onStarted }: MarkdownPanelProps) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const convert = useConvertObject();
  const status = record.markdownStatus;

  const start = () => {
    if (convert.isPending) return;
    convert.mutate({ bucketKey, key: record.key }, { onSuccess: () => onStarted() });
  };

  const action = (label: string) =>
    canWrite && lock === null ? (
      <Button
        type="button"
        size="xs"
        variant="light"
        mt="sm"
        leftSection={<IconRefresh size={14} />}
        loading={convert.isPending}
        onClick={start}
      >
        {label}
      </Button>
    ) : (
      <div className={styles.block}>{canWrite && lock ? <BucketLockHint lock={lock} /> : <ReadOnlyHint />}</div>
    );

  return (
    <div>
      <div className={styles.statusRow} role="status">
        <MarkdownStatusBadge status={status} error={record.markdownError} />
        {status === 'succeeded' && typeof record.markdownSize === 'number' ? (
          <span className={styles.statusText}>{t('markdown.size', { size: formatBytes(record.markdownSize) })}</span>
        ) : null}
      </div>

      {status === 'succeeded' ? (
        <div className={styles.block}>
          {canPreviewMarkdown(record) ? (
            <MarkdownText bucketKey={bucketKey} record={record} />
          ) : (
            <p className={styles.note}>{t('markdown.tooLarge', { limit: formatBytes(PREVIEW_MAX_BYTES) })}</p>
          )}
        </div>
      ) : null}

      {status === 'pending' ? <p className={styles.note}>{t('markdown.pendingHint')}</p> : null}

      {status === 'failed' ? (
        <div className={styles.block}>
          <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} title={tc('markdown.failureTitle')}>
            <p className={styles.reason}>{record.markdownError?.trim() || tc('markdown.failureUnknown')}</p>
          </Alert>
          {action(t('markdown.retry'))}
        </div>
      ) : null}

      {status !== 'succeeded' && status !== 'pending' && status !== 'failed' ? (
        <div className={styles.block}>
          <p className={styles.note}>{t('markdown.noneHint')}</p>
          {action(t('markdown.convert'))}
        </div>
      ) : null}

      {convert.isError ? (
        <div className={styles.block}>
          <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} role="alert">
            {filesErrorMessage(convert.error, tc)}
          </Alert>
        </div>
      ) : null}
    </div>
  );
}
