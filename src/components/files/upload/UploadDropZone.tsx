'use client';

import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode, type Ref } from 'react';
import { Button } from '@mantine/core';
import { IconCloudUpload } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { FileLimits } from '../filesApi';
import { formatBytes } from '../shared';
import { collectDropped, MAX_QUEUE_FILES, storageLeft, summarizeTypes } from './uploadModel';
import styles from './UploadFilesForm.module.css';

export interface UploadDropZoneProps {
  limits: FileLimits | undefined;
  /** Where the limits stand: still loading, loaded, or could not be loaded. */
  limitsState: 'loading' | 'ready' | 'failed';
  /** Nothing can be added (no write access, the bucket is disabled). */
  disabled: boolean;
  /** The picked or dropped files, and how many folders came with a drop (they cannot be uploaded). */
  onFiles: (files: File[], folders: number) => void;
  /** The Browse button, so the screen can put the focus on it when it opens. */
  browseRef?: Ref<HTMLButtonElement>;
  /** Id of the hint line, for the screen reader. */
  hintId: string;
}

/** What the server will take, in one line: the size, how many files, the types and the storage that is left. */
function LimitsHint({ limits, state }: { limits: FileLimits | undefined; state: UploadDropZoneProps['limitsState'] }) {
  const t = useTranslations('files.upload');
  if (state === 'loading') return <>{t('drop.checking')}</>;
  if (state === 'failed' || !limits) return <>{t('drop.limitsFailed')}</>;

  const parts: ReactNode[] = [
    t('drop.limitSize', { size: formatBytes(limits.maxFileBytes) }),
    t('drop.limitCount', { count: MAX_QUEUE_FILES }),
  ];
  if (limits.allowedMimeTypes && limits.allowedMimeTypes.length > 0) {
    const types = summarizeTypes(limits.allowedMimeTypes);
    const text = types.hidden > 0 ? `${types.shown} ${t('drop.moreTypes', { count: types.hidden })}` : types.shown;
    parts.push(<span key="types" title={types.all}>{t('drop.allowedTypes', { types: text })}</span>);
  } else {
    parts.push(t('drop.anyType'));
  }
  const left = storageLeft(limits);
  if (left !== null) parts.push(t('drop.storageLeft', { size: formatBytes(left) }));

  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? ' · ' : ''}
          {part}
        </span>
      ))}
    </>
  );
}

/** A drop target and a Browse button for picking several files, with the upload limits under them. */
export default function UploadDropZone({ limits, limitsState, disabled, onFiles, browseRef, hintId }: UploadDropZoneProps) {
  const t = useTranslations('files.upload');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    // Always cancelled, even when nothing can be added: an uncancelled drop makes the browser open the file and leave the app.
    event.preventDefault();
    if (disabled) return;
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    // Moving over a child of the zone also fires a leave: only leaving the zone itself counts.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const { files, folders } = collectDropped(event.dataTransfer);
    onFiles(files, folders);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Cleared so that picking the same file again fires a change (the old dialog kept the previous pick).
    event.target.value = '';
    onFiles(files, 0);
  };

  const accept = limits?.allowedMimeTypes && limits.allowedMimeTypes.length > 0 ? limits.allowedMimeTypes.join(',') : undefined;

  return (
    <div
      className={[styles.drop, dragging ? styles.dropActive : '', disabled ? styles.dropDisabled : ''].filter(Boolean).join(' ')}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <IconCloudUpload size={30} stroke={1.5} className={styles.dropIcon} aria-hidden="true" />
      <div className={styles.dropTitle}>{dragging ? t('drop.release') : t('drop.title')}</div>
      <div className={styles.dropOr}>
        <span>{t('drop.or')}</span>
        <Button
          ref={browseRef}
          type="button"
          size="xs"
          variant="default"
          disabled={disabled}
          aria-describedby={hintId}
          onClick={() => inputRef.current?.click()}
        >
          {t('drop.browse')}
        </Button>
      </div>
      <div className={styles.hint} id={hintId}>
        <LimitsHint limits={limits} state={limitsState} />
      </div>
      <input ref={inputRef} type="file" multiple hidden accept={accept} aria-label={t('drop.inputLabel')} onChange={onPick} />
    </div>
  );
}
