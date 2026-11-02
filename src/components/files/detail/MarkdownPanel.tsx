'use client';

import { useState } from 'react';
import { Alert, Button, Skeleton } from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconScan } from '@tabler/icons-react';
import OcrSettingsFields from '@/components/extraction/OcrSettingsFields';
import { compactOcr, ocrResultLabel, type OcrSettings } from '@/components/extraction/ocrForm';
import { SkeletonRegion } from '@/components/common/ui/Skeletons';
import { useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import {
  canPreviewMarkdown,
  CopyButton,
  filesErrorMessage,
  formatBytes,
  hasMarkdownCopy,
  isQuietFor,
  MARKDOWN_STALLED_AFTER_MS,
  MarkdownStatusBadge,
  PREVIEW_MAX_BYTES,
  ReadOnlyHint,
  useNow,
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
 * The Markdown copy of the file: where the conversion stands, why it failed or was skipped, the copy's text (as plain
 * text), and, for someone who may change files, the button that (re)starts the conversion.
 *
 * The copy is judged by the copy itself (`markdownKey`), not by the status of the last conversion: a re-conversion
 * that failed or was skipped leaves the earlier copy readable, and one that is running does not take it away. A
 * conversion that is running is followed by the drawer's record query, which polls while it is pending; one that has
 * been pending for so long that its job was probably lost (a restart drops the queue) can be started again.
 */
export default function MarkdownPanel({ bucketKey, record, canWrite, lock = null, onStarted }: MarkdownPanelProps) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const tOcr = useTranslations('ocrSettings');
  const convert = useConvertObject();
  // The OCR options of the next run: opened on demand, starting from what the file was last converted with.
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrDraft, setOcrDraft] = useState<OcrSettings | undefined>(record.markdownExtraction?.ocr);
  const lastRun = record.markdownExtraction?.result;
  const status = record.markdownStatus;
  const copy = hasMarkdownCopy(record);
  const now = useNow(30_000, status === 'pending');
  const lost = status === 'pending' && isQuietFor(record.updatedAt ?? record.createdAt, MARKDOWN_STALLED_AFTER_MS, now);
  const reason = record.markdownError?.trim() || null;
  const ocrBadge = copy ? ocrResultLabel(tOcr, lastRun) : undefined;

  const start = () => {
    if (convert.isPending) return;
    // Options that were opened replace the file's own settings for this run (off = the plain conversion); closed, the file keeps its own.
    const ocr = ocrOpen ? (compactOcr(ocrDraft) ?? null) : undefined;
    convert.mutate({ bucketKey, key: record.key, ...(ocr !== undefined ? { ocr } : {}) }, { onSuccess: () => onStarted() });
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

  const mayConvert = canWrite && lock === null;
  /** The switch that opens the OCR options of the next run, and the options themselves. */
  const ocrOptions = (label: string) =>
    mayConvert ? (
      <div className={styles.block}>
        <Button
          type="button"
          size="xs"
          variant="subtle"
          leftSection={<IconScan size={14} />}
          aria-expanded={ocrOpen}
          onClick={() => setOcrOpen((open) => !open)}
        >
          {label}
        </Button>
        {ocrOpen ? (
          <div className={styles.block}>
            <OcrSettingsFields value={ocrDraft} onChange={setOcrDraft} showImages disabled={convert.isPending} />
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div>
      <div className={styles.statusRow} role="status">
        <MarkdownStatusBadge status={status} error={record.markdownError} />
        {ocrBadge ? (
          <span className="ds-badge ds-badge-info" title={lastRun?.warnings?.length ? lastRun.warnings.join(', ') : undefined}>
            {ocrBadge}
          </span>
        ) : null}
        {copy && typeof record.markdownSize === 'number' ? (
          <span className={styles.statusText}>{t('markdown.size', { size: formatBytes(record.markdownSize) })}</span>
        ) : null}
      </div>

      {status === 'pending' ? (
        <div className={styles.block}>
          <p className={styles.note}>{lost ? t('markdown.pendingStale') : t('markdown.pendingHint')}</p>
          {lost ? ocrOptions(t('markdown.ocrOptions')) : null}
          {lost ? action(t('markdown.convertAgain')) : null}
        </div>
      ) : null}

      {status === 'failed' ? (
        <div className={styles.block}>
          <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} title={tc('markdown.failureTitle')}>
            <p className={styles.reason}>{reason || tc('markdown.failureUnknown')}</p>
          </Alert>
          {copy ? <p className={styles.note}>{t('markdown.keptCopy')}</p> : null}
        </div>
      ) : null}

      {/* A skipped conversion says why (a file over the limit); the earlier copy, if any, is still there. */}
      {status === 'skipped' && reason ? (
        <div className={styles.block}>
          <p className={styles.note}>{reason}</p>
          {copy ? <p className={styles.note}>{t('markdown.keptCopy')}</p> : null}
        </div>
      ) : null}

      {copy ? (
        <div className={styles.block}>
          {canPreviewMarkdown(record) ? (
            <MarkdownText bucketKey={bucketKey} record={record} />
          ) : (
            <p className={styles.note}>{t('markdown.tooLarge', { limit: formatBytes(PREVIEW_MAX_BYTES) })}</p>
          )}
        </div>
      ) : null}

      {status === 'failed' ? ocrOptions(t('markdown.ocrOptions')) : null}
      {status === 'failed' ? <div className={styles.block}>{action(t('markdown.retry'))}</div> : null}

      {/* Nothing converted yet, or a conversion that was skipped: one can be started (again, when a copy is there). */}
      {status !== 'pending' && status !== 'failed' && !(copy && status === 'succeeded') ? (
        <div className={styles.block}>
          {copy ? null : <p className={styles.note}>{t('markdown.noneHint')}</p>}
          {ocrOptions(t('markdown.ocrOptions'))}
          {action(copy ? t('markdown.convertAgain') : t('markdown.convert'))}
        </div>
      ) : null}

      {/* A current copy needs nothing more; reading it again with OCR (a scan the first run missed) is asked for explicitly. */}
      {status === 'succeeded' && copy ? (
        <>
          {ocrOptions(t('markdown.ocrAgain'))}
          {ocrOpen && mayConvert ? <div className={styles.block}>{action(t('markdown.convertAgain'))}</div> : null}
        </>
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
