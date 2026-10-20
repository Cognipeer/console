'use client';

import { ActionIcon, Button, Progress, Text, TextInput } from '@mantine/core';
import { IconCircleCheck, IconX } from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import type { FilesLimits } from '../filesApi';
import { FileKindIcon, formatBytes } from '../shared';
import {
  effectiveContentType,
  fileIssue,
  previewObjectKey,
  type FileIssue,
  type QueueItem,
} from './uploadModel';
import styles from './UploadFilesForm.module.css';

export interface UploadQueueProps {
  items: readonly QueueItem[];
  limits: FilesLimits | undefined;
  /** The folder the next run sends to (normalised), for the key previews. */
  folder: string;
  /** A failed row may be retried now (the destination is valid and the screen may write). */
  canRetry: boolean;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}

type Tone = 'neutral' | 'error' | 'ok';

interface StatusView {
  text: string;
  tone: Tone;
  /** 0..100 while a file is going out. */
  percent?: number;
}

function QueueRow({ item, limits, folder, canRetry, onRename, onRemove, onRetry }: Omit<UploadQueueProps, 'items'> & { item: QueueItem }) {
  const t = useTranslations('files.upload');

  const issue = fileIssue(item, limits);
  const editable = (item.status === 'queued' || item.status === 'failed') && !item.waiting;
  const percent = Math.round(item.progress * 100);

  const issueText = (found: FileIssue): string => {
    switch (found.kind) {
      case 'too_large':
        return t('status.tooLarge', { limit: formatBytes(found.limit) });
      case 'type_not_allowed':
        return t('status.typeNotAllowed', { type: found.type });
      case 'name_required':
        return t('status.nameRequired');
      case 'name_slash':
        return t('status.nameSlash');
      default:
        return t('status.contentTypeInvalid');
    }
  };

  const status: StatusView = (() => {
    if (item.status === 'uploading') {
      return percent >= 100 ? { text: t('status.saving'), tone: 'neutral', percent } : { text: t('status.uploading', { percent }), tone: 'neutral', percent };
    }
    if (item.status === 'done') return { text: t('status.done'), tone: 'ok' };
    if (item.waiting) return { text: t('status.waiting'), tone: 'neutral' };
    if (issue) return { text: issueText(issue), tone: 'error' };
    if (item.status === 'failed') return { text: t('status.failed', { message: item.error ?? '' }), tone: 'error' };
    return { text: t('status.ready'), tone: 'neutral' };
  })();

  const nameInvalid = issue?.kind === 'name_required' || issue?.kind === 'name_slash';
  const savedAs =
    item.status === 'done'
      ? t('queue.storedAs', { key: item.record?.key ?? '' })
      : item.name.trim() && !item.name.includes('/')
        ? t('queue.savedAs', { key: previewObjectKey(folder, item.name) })
        : null;

  return (
    <li className={styles.row}>
      <div className={styles.name}>
        {editable ? (
          <TextInput
            size="xs"
            value={item.name}
            aria-label={t('queue.nameLabel', { file: item.file.name })}
            error={nameInvalid ? true : undefined}
            autoComplete="off"
            spellCheck={false}
            leftSection={<FileKindIcon file={{ contentType: effectiveContentType(item), name: item.name }} size={14} />}
            leftSectionWidth={40}
            onChange={(event) => onRename(item.id, event.currentTarget.value)}
          />
        ) : (
          <span className={styles.nameStatic}>{item.name}</span>
        )}
        {savedAs ? <span className={`${styles.savedAs} ds-mono`}>{savedAs}</span> : null}
      </div>

      <span className={styles.size}>{formatBytes(item.file.size)}</span>

      <div className={styles.status}>
        <span
          className={status.tone === 'error' ? styles.statusError : status.tone === 'ok' ? styles.statusDone : undefined}
        >
          {status.text}
        </span>
        {status.percent !== undefined ? (
          <Progress value={status.percent} size="xs" aria-label={t('queue.progressLabel', { file: item.name })} />
        ) : null}
      </div>

      <div className={styles.actions}>
        {item.status === 'done' ? (
          <IconCircleCheck size={18} color="var(--ds-ok)" aria-hidden="true" />
        ) : (
          <>
            {item.status === 'failed' && !issue && !item.waiting ? (
              <Button
                type="button"
                size="compact-xs"
                variant="light"
                disabled={!canRetry}
                aria-label={t('queue.retryFile', { file: item.name })}
                onClick={() => onRetry(item.id)}
              >
                {t('queue.retry')}
              </Button>
            ) : null}
            <ActionIcon
              type="button"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={t('queue.remove', { file: item.name })}
              onClick={() => onRemove(item.id)}
            >
              <IconX size={14} />
            </ActionIcon>
          </>
        )}
      </div>
    </li>
  );
}

/** The files of the batch, one row each: name (editable), size, status with progress, Retry and Remove. */
export default function UploadQueue({ items, ...rest }: UploadQueueProps) {
  const t = useTranslations('files.upload');
  if (items.length === 0) {
    return (
      <Text size="xs" c="dimmed" mt="sm">
        {t('queue.empty')}
      </Text>
    );
  }
  return (
    <ul className={styles.list} aria-label={t('queue.label')}>
      {items.map((item) => (
        <QueueRow key={item.id} item={item} {...rest} />
      ))}
    </ul>
  );
}
