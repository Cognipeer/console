'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Alert, TextInput, VisuallyHidden } from '@mantine/core';
import { IconAlertTriangle, IconFolder, IconUpload } from '@tabler/icons-react';
import { useConfirm } from '@/components/common/confirm';
import FormShell, { Checklist, FormSection, SummaryGroup, SummaryKV, ToggleList, ToggleRow } from '@/components/common/ui/FormShell';
import OcrSettingsFields from '@/components/extraction/OcrSettingsFields';
import { compactOcr, describeOcr, type OcrSettings } from '@/components/extraction/ocrForm';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { FileBucketView, FileRecordView } from '@/lib/services/files';
import { isFilesApiError } from '../filesApi';
import { formatBytes, filesErrorMessage, ReadOnlyHint } from '../shared';
import { useFilesAccess } from '../useFilesAccess';
import { useFilesInvalidation, useFilesLimits } from '../useFilesQueries';
import UploadDropZone from './UploadDropZone';
import UploadQueue from './UploadQueue';
import {
  FOLDER_MAX_LENGTH,
  isValidContentType,
  MAX_QUEUE_FILES,
  parseFolder,
  quotaWarning,
  summarizeQueue,
  type FolderProblem,
} from './uploadModel';
import { useUploadQueue } from './useUploadQueue';
import styles from './UploadFilesForm.module.css';

export interface UploadFilesFormProps {
  /** Draw the full-screen form. */
  opened: boolean;
  onClose: () => void;
  /** The bucket to upload into (the list item, the detail or the plain view all fit). */
  bucket: FileBucketView;
  /** The folder to upload into: `''` is the bucket root, otherwise no leading slash and one trailing slash. */
  folder: string;
  /**
   * The records the server created, once the queue has finished or the uploads were stopped (some files may have
   * failed: only the stored ones are listed). Not called when nothing was stored.
   */
  onUploaded: (records: FileRecordView[]) => void;
}

/** What the last pick or drop left out: shown under the drop zone until the next one. */
interface Notices {
  overflow: number;
  folders: number;
  duplicates: number;
}

const NO_NOTICES: Notices = { overflow: 0, folders: 0, duplicates: 0 };

/** A bucket a "delete with files" job is removing is disabled meanwhile; the list item and the detail carry the flag. */
function isDeleting(bucket: FileBucketView): boolean {
  return 'deleting' in bucket && bucket.deleting === true;
}

/**
 * The "Upload files" screen (a full-screen FormShell): pick or drop several files, check them against the
 * server's limits before anything is sent, send them two at a time and keep each file's outcome on its row.
 * Closing the screen is only mounted state: it starts empty every time it opens.
 */
export function UploadFilesForm(props: UploadFilesFormProps) {
  if (!props.opened) return null;
  return <UploadFilesFormBody {...props} />;
}

function UploadFilesFormBody({ onClose, bucket, folder: initialFolder, onUploaded }: UploadFilesFormProps) {
  const t = useTranslations('files.upload');
  const tc = useTranslations('files.common');
  const tOcr = useTranslations('ocrSettings');
  const locale = useLocale();
  const { canWrite } = useFilesAccess();
  const { confirm } = useConfirm();
  const invalidation = useFilesInvalidation();
  const limitsQuery = useFilesLimits({ bucketKey: bucket.key });
  const limits = limitsQuery.data;
  const limitsState = limitsQuery.isPending ? 'loading' : limits ? 'ready' : 'failed';

  const hintId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const [folderText, setFolderText] = useState(initialFolder);
  const [convert, setConvert] = useState(true);
  const [ocr, setOcr] = useState<OcrSettings | undefined>(undefined);
  const [notices, setNotices] = useState<Notices>(NO_NOTICES);

  const queue = useUploadQueue({
    bucketKey: bucket.key,
    describeError: (error) => {
      // The limit is known on this screen: say it, instead of the generic "larger than the limit".
      if (limits && isFilesApiError(error) && (error.code === 'file_too_large' || error.status === 413)) {
        return t('status.tooLarge', { limit: formatBytes(limits.maxFileBytes) });
      }
      return filesErrorMessage(error, tc);
    },
    onSettled: ({ records, aborted }) => {
      // A run that stored nothing leaves the bucket as it was, unless requests were cut off (stopping the uploads, taking
      // a row off the list): the server may have kept those, so the list, the numbers and the quota are read again.
      if (records.length === 0 && aborted === 0) return;
      void invalidation.bucketContent(bucket.key);
      if (records.length > 0) onUploaded(records);
    },
  });

  const parsed = parseFolder(folderText);
  const summary = summarizeQueue(queue.items, limits);
  const readyCount = summary.readyIds.length;
  const bucketOpen = bucket.status === 'active' && !isDeleting(bucket);
  const mayUpload = canWrite && bucketOpen;
  const canStart = mayUpload && !parsed.problem && limitsState !== 'loading' && !queue.busy && readyCount > 0;
  const warning = quotaWarning(limits, summary.readyBytes, readyCount);

  // The screen opens on its Browse button, as a dialog should take the focus in.
  useEffect(() => {
    browseRef.current?.focus();
  }, []);

  // A reload or a tab close would drop the files that are still going out.
  useEffect(() => {
    if (!queue.busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [queue.busy]);

  /* ── Closing ─────────────────────────────────────────────────────────── */

  // Escape reaches this screen's own listener even while the question below is open: one question at a time.
  const asking = useRef(false);
  const requestClose = async () => {
    if (asking.current) return;
    if (!queue.busy) {
      onClose();
      return;
    }
    asking.current = true;
    try {
      const stop = await confirm({
        title: t('confirm.title'),
        message: t('confirm.message'),
        tone: 'warning',
        confirmLabel: t('confirm.stop'),
        cancelLabel: t('confirm.keep'),
      });
      if (stop) {
        queue.cancelAll();
        onClose();
      }
    } finally {
      asking.current = false;
    }
  };

  /* ── Adding and starting ─────────────────────────────────────────────── */

  const addFiles = (files: File[], folders: number) => {
    const result = files.length > 0 ? queue.add(files) : { added: 0, duplicates: 0, overflow: 0 };
    setNotices({ overflow: result.overflow, folders, duplicates: result.duplicates });
  };

  const ocrSettings = convert ? compactOcr(ocr) : undefined;
  const settings = { folder: parsed.folder, convertToMarkdown: convert, ...(ocrSettings ? { ocr: ocrSettings } : {}) };

  const submit = () => {
    if (queue.busy) return;
    if (readyCount === 0) {
      // Nothing left to send: the primary button reads "Done".
      if (summary.done > 0) void requestClose();
      return;
    }
    if (!canStart) return;
    queue.start(summary.readyIds, settings);
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  /* ── Wording ─────────────────────────────────────────────────────────── */

  const folderProblem = (problem: FolderProblem): string => {
    switch (problem) {
      case 'dot_segments':
        return t('destination.errors.dotSegments');
      case 'control_chars':
        return t('destination.errors.controlChars');
      default:
        return t('destination.errors.tooLong', { max: FOLDER_MAX_LENGTH });
    }
  };

  const only = queue.items.length === 1 ? queue.items[0]! : null;
  const detectedType = only?.file.type || 'application/octet-stream';

  const footerStatus =
    summary.total === 0
      ? undefined
      : queue.busy || summary.done > 0
        ? t('footer.uploaded', { done: summary.done, total: summary.total })
        : t('footer.ready', { ready: readyCount, total: summary.total });

  const uploadLabel = readyCount === 1 ? t('actions.uploadOne') : t('actions.uploadMany', { count: readyCount });
  const primary = queue.busy
    ? { label: t('actions.uploading'), loading: true, disabled: true, onClick: submit }
    : readyCount > 0
      ? { label: uploadLabel, icon: <IconUpload size={13} />, disabled: !canStart, onClick: submit }
      : summary.done > 0
        ? { label: t('actions.done'), onClick: submit }
        : { label: t('actions.upload'), icon: <IconUpload size={13} />, disabled: true, onClick: submit };

  const checks = [
    { id: 'selected', label: t('checks.selected'), done: summary.total > 0 },
    { id: 'folder', label: t('checks.folder'), done: !parsed.problem },
    ...(limits
      ? [
          {
            id: 'size',
            label: summary.tooLarge > 0 ? t('checks.sizeOver', { count: summary.tooLarge }) : t('checks.sizeOk'),
            done: summary.tooLarge === 0,
          },
        ]
      : []),
    ...(limits?.allowedMimeTypes && limits.allowedMimeTypes.length > 0
      ? [
          {
            id: 'types',
            label: summary.typeNotAllowed > 0 ? t('checks.typesOver', { count: summary.typeNotAllowed }) : t('checks.typesOk'),
            done: summary.typeNotAllowed === 0,
          },
        ]
      : []),
    ...(summary.nameProblems > 0 ? [{ id: 'names', label: t('checks.namesOver', { count: summary.nameProblems }), done: false }] : []),
  ];

  // The summary describes the run: it keeps counting the files that are on their way or stored, not only those still to send.
  const filesValue = summary.sendable === summary.total ? String(summary.total) : t('summary.filesSome', { total: summary.total, ready: summary.sendable });

  const summaryPanel = (
    <>
      <SummaryGroup title={t('summary.upload')}>
        <SummaryKV label={t('summary.files')} value={summary.total > 0 ? filesValue : <span className="ds-faint">—</span>} />
        <SummaryKV label={t('summary.totalSize')} value={formatBytes(summary.sendableBytes)} />
        <SummaryKV label={t('summary.destination')} value={parsed.folder || t('destination.root')} mono />
        <SummaryKV label={t('summary.markdown')} value={convert ? t('summary.on') : t('summary.off')} />
        {ocrSettings ? <SummaryKV label={t('summary.ocr')} value={describeOcr(tOcr, ocrSettings)} /> : null}
      </SummaryGroup>
      <SummaryGroup title={t('summary.preflight')}>
        <Checklist items={checks} />
      </SummaryGroup>
      {warning ? (
        <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} role="note">
          {warning.kind === 'storage'
            ? t('summary.storageWarning', { size: formatBytes(summary.readyBytes), left: formatBytes(warning.left) })
            : t('summary.filesWarning', { count: readyCount, left: warning.left.toLocaleString(locale) })}
        </Alert>
      ) : null}
    </>
  );

  return (
    <FormShell
      open
      onClose={() => void requestClose()}
      icon={<IconUpload size={16} />}
      title={t('title')}
      subtitle={bucket.name}
      summary={summaryPanel}
      footerStatus={footerStatus}
      primaryAction={primary}
      secondaryAction={{ label: summary.done > 0 ? t('actions.close') : t('actions.cancel'), onClick: () => void requestClose() }}
    >
      <form ref={formRef} onSubmit={onSubmit} noValidate aria-label={t('title')}>
        {/* Enter in a field sends the form; the footer button is outside it, so the form needs its own submit. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />

        {!canWrite ? (
          <div className={styles.banner}>
            <ReadOnlyHint variant="banner" />
          </div>
        ) : null}
        {canWrite && !bucketOpen ? (
          <div className={styles.banner}>
            <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={16} />} role="note">
              {t('blocked.disabled')}
            </Alert>
          </div>
        ) : null}

        <FormSection number={1} title={t('sections.files')} description={t('sections.filesHelp')} done={summary.total > 0}>
          <UploadDropZone
            limits={limits}
            limitsState={limitsState}
            disabled={!mayUpload}
            onFiles={addFiles}
            browseRef={browseRef}
            hintId={hintId}
          />
          {notices.overflow > 0 ? (
            <p className={styles.notice} role="status">{t('notices.overflow', { count: notices.overflow, max: MAX_QUEUE_FILES })}</p>
          ) : null}
          {notices.folders > 0 ? <p className={styles.notice} role="status">{t('notices.folders', { count: notices.folders })}</p> : null}
          {notices.duplicates > 0 ? <p className={styles.notice} role="status">{t('notices.duplicates', { count: notices.duplicates })}</p> : null}
          <UploadQueue
            items={queue.items}
            limits={limits}
            folder={parsed.folder}
            canRetry={mayUpload && !parsed.problem}
            onRename={queue.rename}
            onRemove={queue.remove}
            onRetry={(id) => queue.start([id], settings)}
          />
        </FormSection>

        <FormSection number={2} title={t('sections.destination')} description={t('sections.destinationHelp')} done={!parsed.problem}>
          <div className={styles.destination}>
            <IconFolder size={16} aria-hidden="true" />
            <strong>{bucket.name}</strong>
            <span className={styles.destinationSep} aria-hidden="true">›</span>
            <span className="ds-mono">{parsed.folder || t('destination.root')}</span>
          </div>
          <TextInput
            label={t('destination.folderLabel')}
            description={t('destination.folderHint')}
            placeholder={t('destination.folderPlaceholder')}
            value={folderText}
            disabled={queue.busy}
            error={parsed.problem ? folderProblem(parsed.problem) : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setFolderText(event.currentTarget.value)}
          />
          <p className={styles.note}>{t('destination.unique')}</p>
        </FormSection>

        <FormSection number={3} title={t('sections.processing')} description={t('sections.processingHelp')} done>
          <ToggleList>
            <ToggleRow
              label={t('processing.convert')}
              description={
                <>
                  {t('processing.convertHint')} {t('processing.background')}
                </>
              }
              checked={convert}
              disabled={queue.busy}
              onChange={setConvert}
            />
          </ToggleList>
          {convert ? (
            <div className={styles.ocr}>
              <OcrSettingsFields value={ocr} onChange={setOcr} showImages disabled={queue.busy} />
              <p className={styles.note}>{t('processing.ocrHint')}</p>
            </div>
          ) : null}
          {only && (only.status === 'queued' || only.status === 'failed') && !only.waiting ? (
            <details className={styles.advanced}>
              <summary>{t('processing.advanced')}</summary>
              <div className={styles.advancedBody}>
                <TextInput
                  label={t('processing.contentType')}
                  description={t('processing.contentTypeHint')}
                  placeholder={detectedType}
                  value={only.contentType}
                  error={only.contentType.trim() && !isValidContentType(only.contentType) ? t('status.contentTypeInvalid') : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => queue.setContentType(only.id, event.currentTarget.value)}
                />
              </div>
            </details>
          ) : null}
        </FormSection>
      </form>
      <VisuallyHidden role="status" aria-live="polite">
        {footerStatus ?? ''}
      </VisuallyHidden>
    </FormShell>
  );
}
