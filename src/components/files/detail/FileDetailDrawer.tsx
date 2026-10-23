'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, CopyButton as MantineCopyButton, Drawer, Skeleton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconCopy, IconDownload, IconMarkdown, IconTrash } from '@tabler/icons-react';
import { useDeleteResource } from '@/components/common/confirm/useDeleteResource';
import { SkeletonRegion } from '@/components/common/ui/Skeletons';
import TabsBar, { type TabsBarItem } from '@/components/common/ui/TabsBar';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { FileBucketView, FileRecordView } from '@/lib/services/files';
import { formatRelativeTime } from '@/components/providers/providerAccessModel';
import { isFilesApiError } from '../filesApi';
import { FileKindChip, FileKindIcon, filesErrorMessage, formatBytes, hasMarkdownCopy, ReadOnlyHint } from '../shared';
import { useFilesAccess } from '../useFilesAccess';
import { useDeleteObject, useDownloadObject, useObject } from '../useFilesQueries';
import BucketLockHint from './BucketLockHint';
import { baseNameOfKey, bucketLockOf, DETAIL_TABS, folderOfKey, type DetailTab } from './detailModel';
import DetailsPanel from './DetailsPanel';
import MarkdownPanel from './MarkdownPanel';
import PreviewPanel from './PreviewPanel';
import styles from './FileDetailDrawer.module.css';

export interface FileDetailDrawerProps {
  /** The bucket the file is in. */
  bucket: FileBucketView;
  /** The key of the file to show; `null` keeps the drawer closed. */
  fileKey: string | null;
  onClose: () => void;
  /** The file changed (a conversion was started or finished): the host refreshes what it shows. */
  onChanged: () => void;
  /**
   * The file was deleted from the drawer, which has already confirmed it with the person, refreshed the lists it was
   * in (the delete does that) and said so in a notification: the host closes the drawer (it need not refresh, and
   * should not announce the deletion again).
   */
  onDeleted: (key: string) => void;
}

interface BodyProps extends Omit<FileDetailDrawerProps, 'fileKey' | 'onClose'> {
  fileKey: string;
  /** A question is open above the drawer (the delete confirmation). */
  onAsking: (asking: boolean) => void;
}

function BodySkeleton({ label }: { label: string }) {
  return (
    <SkeletonRegion label={label}>
      <Skeleton height={14} width="55%" radius="sm" />
      <div className={styles.actions}>
        <Skeleton height={30} width={104} radius="sm" />
        <Skeleton height={30} width={88} radius="sm" />
      </div>
      <Skeleton height={34} mt="lg" radius="sm" />
      <Skeleton height={220} mt="md" radius="md" />
    </SkeletonRegion>
  );
}

function DrawerBody({ bucket, fileKey, onChanged, onDeleted, onAsking }: BodyProps) {
  const t = useTranslations('files.detail');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const { canWrite } = useFilesAccess();
  // A disabled bucket (or one being deleted) keeps its files readable and refuses every change: the drawer offers
  // none of them, as the bucket page does not.
  const lock = bucketLockOf(bucket);
  const canChange = canWrite && lock === null;
  const query = useObject(bucket.key, fileKey);
  const download = useDownloadObject();
  const removal = useDeleteObject();
  const deleteResource = useDeleteResource();
  const [tab, setTab] = useState<DetailTab>('preview');
  const [actionError, setActionError] = useState<string | null>(null);

  const record: FileRecordView | undefined = query.data;
  const gone = isFilesApiError(query.error) && query.error.status === 404;

  // A conversion that finished (or failed) while the drawer was open: what the host shows has changed as well.
  const markdownStatus = record?.markdownStatus;
  const previousStatus = useRef(markdownStatus);
  useEffect(() => {
    if (previousStatus.current === 'pending' && markdownStatus !== undefined && markdownStatus !== 'pending') onChanged();
    previousStatus.current = markdownStatus;
  }, [markdownStatus, onChanged]);

  const startDownload = (current: FileRecordView, variant: 'original' | 'markdown') => {
    setActionError(null);
    download.mutate(
      { bucketKey: bucket.key, key: current.key, fileName: current.name, variant },
      { onError: (error) => setActionError(filesErrorMessage(error, tc)) },
    );
  };

  const startDelete = async (current: FileRecordView) => {
    setActionError(null);
    onAsking(true);
    try {
      const removed = await deleteResource({
        noun: t('delete.noun'),
        name: current.name,
        extraWarning: current.markdownKey ? t('delete.withMarkdown') : undefined,
        action: async () => {
          try {
            await removal.mutateAsync({ bucketKey: bucket.key, key: current.key });
          } catch (error) {
            // The dialog shows what is thrown: say it in the viewer's language.
            throw new Error(filesErrorMessage(error, tc));
          }
        },
      });
      if (removed) {
        notifications.show({ color: 'green', title: t('delete.doneTitle'), message: t('delete.doneMessage', { name: current.name }) });
        onDeleted(current.key);
      }
    } finally {
      onAsking(false);
    }
  };

  let content: ReactNode;
  if (gone) {
    content = (
      <Alert variant="light" color="gray" icon={<IconAlertTriangle size={16} />} role="alert">
        {t('state.notFound')}
      </Alert>
    );
  } else if (!record && query.isError) {
    content = (
      <Alert variant="light" color="red" icon={<IconAlertTriangle size={16} />} role="alert">
        <p className={styles.reason}>{filesErrorMessage(query.error, tc)}</p>
        <Button type="button" size="xs" variant="light" color="red" mt="xs" onClick={() => void query.refetch()}>
          {t('state.retry')}
        </Button>
      </Alert>
    );
  } else if (!record) {
    content = <BodySkeleton label={t('state.loading')} />;
  } else {
    const folder = folderOfKey(record.key).replace(/\/$/, '');
    const created = record.createdAt ? new Date(record.createdAt) : null;
    const hasCreated = created !== null && !Number.isNaN(created.getTime());
    // "Markdown" is the name of a format and reads the same in every language, like "PDF": it is not a message.
    const tabLabels: Record<DetailTab, string> = { preview: t('tabs.preview'), markdown: 'Markdown', details: t('tabs.details') };
    const tabs: TabsBarItem[] = DETAIL_TABS.map((id) => ({ id, label: tabLabels[id] }));

    content = (
      <>
        <div className={styles.summary}>
          <FileKindChip file={record} />
          <span className={styles.sep} aria-hidden="true">·</span>
          <span>{formatBytes(record.size)}</span>
          <span className={styles.sep} aria-hidden="true">·</span>
          <span className="ds-mono">{folder || t('meta.root')}</span>
          {hasCreated ? (
            <>
              <span className={styles.sep} aria-hidden="true">·</span>
              <span title={created.toLocaleString(locale)}>{t('meta.added', { when: formatRelativeTime(created, locale) })}</span>
            </>
          ) : null}
        </div>

        <div className={styles.actions}>
          <Button
            type="button"
            size="xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            loading={download.isPending && download.variables?.variant !== 'markdown'}
            disabled={download.isPending}
            onClick={() => startDownload(record, 'original')}
          >
            {t('actions.download')}
          </Button>
          {hasMarkdownCopy(record) ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              leftSection={<IconMarkdown size={14} />}
              loading={download.isPending && download.variables?.variant === 'markdown'}
              disabled={download.isPending}
              onClick={() => startDownload(record, 'markdown')}
            >
              {t('actions.downloadMarkdown')}
            </Button>
          ) : null}
          <MantineCopyButton value={record.key} timeout={1800}>
            {({ copied, copy }) => (
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                onClick={copy}
              >
                {copied ? t('actions.keyCopied') : t('actions.copyKey')}
              </Button>
            )}
          </MantineCopyButton>
          {canChange ? (
            <Button
              type="button"
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={removal.isPending}
              onClick={() => void startDelete(record)}
            >
              {t('actions.delete')}
            </Button>
          ) : null}
        </div>

        {!canWrite ? (
          <div className={styles.block}>
            <ReadOnlyHint />
          </div>
        ) : lock ? (
          <div className={styles.block}>
            <BucketLockHint lock={lock} />
          </div>
        ) : null}

        {actionError ? (
          <div className={styles.block}>
            <Alert
              variant="light"
              color="red"
              icon={<IconAlertTriangle size={16} />}
              role="alert"
              withCloseButton
              closeButtonLabel={t('actions.dismiss')}
              onClose={() => setActionError(null)}
            >
              {actionError}
            </Alert>
          </div>
        ) : null}

        <TabsBar items={tabs} activeId={tab} onChange={(id) => setTab(id as DetailTab)} className={styles.tabs} />
        <div className={styles.panel} role="tabpanel" aria-label={tabLabels[tab]}>
          {tab === 'preview' ? <PreviewPanel bucketKey={bucket.key} record={record} /> : null}
          {tab === 'markdown' ? (
            <MarkdownPanel bucketKey={bucket.key} record={record} canWrite={canWrite} lock={lock} onStarted={onChanged} />
          ) : null}
          {tab === 'details' ? <DetailsPanel bucketKey={bucket.key} record={record} /> : null}
        </div>
      </>
    );
  }

  return (
    <>
      <Drawer.Header>
        <Drawer.Title>
          <span className={styles.title}>
            {record ? <FileKindIcon file={record} /> : null}
            <span className={styles.titleText}>{record?.name ?? baseNameOfKey(fileKey)}</span>
          </span>
        </Drawer.Title>
        <Drawer.CloseButton aria-label={t('actions.close')} />
      </Drawer.Header>
      <Drawer.Body className={styles.body}>{content}</Drawer.Body>
    </>
  );
}

/**
 * The drawer of one file (Preview, Markdown and Details tabs, with the actions on it). The host decides which
 * file is open: it passes the key (`null` = closed) and closes the drawer when `onClose` or `onDeleted` is called.
 */
export function FileDetailDrawer({ bucket, fileKey, onClose, onChanged, onDeleted }: FileDetailDrawerProps) {
  // The drawer slides out after `fileKey` became null: keep drawing that file until it is gone.
  const [shownKey, setShownKey] = useState(fileKey);
  if (fileKey !== null && fileKey !== shownKey) setShownKey(fileKey);
  // While the delete question is open above the drawer, Escape belongs to the question.
  const [asking, setAsking] = useState(false);

  return (
    <Drawer.Root opened={fileKey !== null} onClose={onClose} position="right" size={560} closeOnEscape={!asking}>
      <Drawer.Overlay />
      <Drawer.Content>
        {shownKey !== null ? (
          <DrawerBody
            key={shownKey}
            bucket={bucket}
            fileKey={shownKey}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onAsking={setAsking}
          />
        ) : null}
      </Drawer.Content>
    </Drawer.Root>
  );
}
