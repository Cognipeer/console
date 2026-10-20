'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ActionIcon, Alert, Button, Group, Text, Tooltip, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconDownload, IconFileOff, IconFilterOff, IconFolder, IconFolderPlus, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import DataGrid, { type DataGridColumn, type DataGridEmpty, type DataGridFilter } from '@/components/common/ui/DataGrid';
import { useLocale, useTranslations } from '@/lib/i18n';
import type { FileRecordView } from '@/lib/services/files';
import type { BatchDeleteResult, BucketDetail, ObjectVariant } from '../filesApi';
import {
  FILE_KINDS,
  FileKindChip,
  FileKindIcon,
  filesErrorMessage,
  formatBytes,
  MarkdownStatusBadge,
  RelativeTime,
  useFileKindLabels,
  type FileKind,
} from '../shared';
import { flattenObjectPages, useArchiveObjects, useDownloadObject, useObjects } from '../useFilesQueries';
import { copyToClipboard } from './clipboard';
import DeleteFilesDialog from './DeleteFilesDialog';
import FileRowMenu from './FileRowMenu';
import {
  CellHit,
  createdByWho,
  ExpiryCell,
  FolderPath,
  SessionBadge,
  SessionLinkCell,
  UploaderCell,
} from './FileBrowseParts';
import type { SessionFileFilter } from './fileBrowse';
import { isSessionFile } from './fileBrowse';
import {
  ARCHIVE_MAX_KEYS,
  buildRows,
  fileRowsOf,
  folderOfKey,
  listingQuery,
  modifiedAt,
  selectedVisibleKeys,
  selectionState,
  showsSessionColumns,
  toggleSelection,
  type FilesRow,
} from './filesTabModel';
import {
  hasListingFilters,
  hrefWithQuery,
  isFlatListing,
  parseFilesTabState,
  withFilesTabState,
  type BucketUrlPatch,
} from './filesTabState';
import StateCard from './StateCard';
import styles from './bucket.module.css';

export interface BucketFilesTabProps {
  bucket: BucketDetail;
  /** Draw the controls that change files (a hint: the server decides). */
  canWrite: boolean;
  /** Open the upload screen for `folder` (`''` is the bucket root, otherwise no leading slash and one trailing slash). */
  onOpenUpload: (folder: string) => void;
  /** Open the file drawer for the file with this key. */
  onOpenFile: (key: string) => void;
  /** Open "Import from storage" (offered by an empty bucket; the page hosts the dialog). Without it the action is not drawn. */
  onOpenImport?: () => void;
}

/** How long typing in the search waits before it becomes the address (and a request). */
export const SEARCH_DEBOUNCE_MS = 300;

interface DeleteTarget {
  keys: string[];
  fileName?: string;
}

/**
 * The Files tab: the folder path, search, type and "show" filters (all of it in the address), the files and
 * sub-folders of the folder as a grid with a selection for the bulk bar, "Load more" paging and the empty, loading
 * and failed states. The file drawer, the upload screen and the import dialog belong to the page; this tab asks for
 * them through its props.
 */
export function BucketFilesTab({ bucket, canWrite, onOpenUpload, onOpenFile, onOpenImport }: BucketFilesTabProps) {
  const t = useTranslations('files');
  const tb = useTranslations('files.bucket');
  const tc = useTranslations('files.common');
  const locale = useLocale();
  const kindLabels = useFileKindLabels();
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();
  const paramsText = searchParams?.toString() ?? '';
  const state = useMemo(() => parseFilesTabState(new URLSearchParams(paramsText)), [paramsText]);

  const bucketKey = bucket.key;
  // Files are changed only by someone who may write, in a bucket that takes changes (active, not being deleted).
  const editable = canWrite && bucket.status === 'active' && bucket.deleting !== true;

  /* ── The address ─────────────────────────────────────────────────────── */

  const update = useCallback(
    (patch: BucketUrlPatch, mode: 'replace' | 'push' = 'replace') => {
      const href = hrefWithQuery(pathname, withFilesTabState(paramsText, patch));
      if (mode === 'push') router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [pathname, paramsText, router],
  );

  const openFolder = useCallback((path: string) => update({ path }, 'push'), [update]);

  // The search box keeps what is typed; the address follows a moment later.
  const [searchText, setSearchText] = useState(state.q);
  const lastPushedQ = useRef(state.q);
  useEffect(() => {
    // The address changed on its own (Back, a link): show its search.
    if (state.q === lastPushedQ.current) return;
    lastPushedQ.current = state.q;
    setSearchText(state.q);
  }, [state.q]);
  useEffect(() => {
    const next = searchText.trim();
    if (next === state.q) return;
    const timer = window.setTimeout(() => {
      lastPushedQ.current = next;
      update({ q: next });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText, state.q, update]);

  const clearFilters = () => update({ q: '', type: null, show: 'all' });

  /* ── The listing ─────────────────────────────────────────────────────── */

  const listing = useObjects(bucketKey, listingQuery(state));
  const pages = listing.data?.pages;
  const { items, folders } = useMemo(() => flattenObjectPages(pages), [pages]);
  const rows = useMemo(() => buildRows({ items, folders, state }), [items, folders, state]);
  const fileRows = useMemo(() => fileRowsOf(rows), [rows]);
  const fileKeys = useMemo(() => fileRows.map((row) => row.record.key), [fileRows]);
  const sessionColumns = showsSessionColumns(state, fileRows.map((row) => row.record));
  const flat = isFlatListing(state);
  const now = new Date();

  /* ── Selection ───────────────────────────────────────────────────────── */

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const listingSignature = [bucketKey, state.path, state.q, state.type ?? '', state.show].join('\n');
  // Another folder, search or filter is another list: nothing stays selected from the last one.
  useEffect(() => {
    setSelected(new Set());
  }, [listingSignature]);

  const selectedKeys = useMemo(() => selectedVisibleKeys(selected, fileKeys), [selected, fileKeys]);
  const allState = selectionState(selected, fileKeys);
  const selectedRowIds = useMemo(() => new Set(selectedKeys.map((key) => `file:${key}`)), [selectedKeys]);

  const toggleAll = () => setSelected(allState === 'all' ? new Set() : new Set(fileKeys));
  const clearSelection = () => setSelected(new Set());

  /* ── Actions ─────────────────────────────────────────────────────────── */

  const download = useDownloadObject();
  const archive = useArchiveObjects();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const fail = (title: string, error: unknown) =>
    notifications.show({ color: 'red', title, message: filesErrorMessage(error, tc) });

  const downloadFile = (record: FileRecordView, variant: ObjectVariant) =>
    download.mutate(
      { bucketKey, key: record.key, fileName: record.name, variant },
      { onError: (error) => fail(tb('errors.downloadFailed'), error) },
    );

  const copyKey = async (record: FileRecordView) => {
    const copied = await copyToClipboard(record.key);
    notifications.show(copied ? { color: 'teal', message: tb('row.keyCopied') } : { color: 'red', message: tb('row.copyFailed') });
  };

  const downloadSelected = () =>
    archive.mutate({ bucketKey, keys: selectedKeys }, { onError: (error) => fail(tb('errors.downloadFailed'), error) });

  const tooManyForZip = selectedKeys.length > ARCHIVE_MAX_KEYS;

  const finishedDelete = (result: BatchDeleteResult) => {
    const gone = new Set(result.deleted);
    setSelected((current) => new Set([...current].filter((key) => !gone.has(key))));
  };

  /* ── Columns ─────────────────────────────────────────────────────────── */

  const openRow = (row: FilesRow) => {
    if (row.kind === 'folder') openFolder(row.path);
    else onOpenFile(row.record.key);
  };

  const columns: DataGridColumn<FilesRow>[] = [
    {
      key: 'select',
      width: 44,
      label: (
        <input
          type="checkbox"
          className="ds-checkbox"
          aria-label={tb('columns.selectAll')}
          checked={allState === 'all'}
          disabled={fileKeys.length === 0}
          ref={(element) => {
            if (element) element.indeterminate = allState === 'some';
          }}
          onChange={toggleAll}
        />
      ),
      render: (row) =>
        row.kind === 'file' ? (
          <CellHit>
            <input
              type="checkbox"
              className="ds-checkbox"
              aria-label={tb('row.select', { name: row.record.name })}
              checked={selected.has(row.record.key)}
              onChange={() => setSelected((current) => toggleSelection(current, row.record.key))}
            />
          </CellHit>
        ) : null,
    },
    {
      key: 'name',
      label: tb('columns.name'),
      render: (row) => {
        if (row.kind === 'folder') {
          const { name, path } = row;
          return (
            <div className={styles.nameCell}>
              <IconFolder size={20} stroke={1.6} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--ds-text-muted)' }} />
              <UnstyledButton
                type="button"
                className={styles.nameButton}
                aria-label={t('browse.openFolder', { name })}
                onClick={(event) => {
                  event.stopPropagation();
                  openFolder(path);
                }}
              >
                {name}
              </UnstyledButton>
            </div>
          );
        }
        const { record } = row;
        // A person's name, never their id; none when the Uploaded-by column already says it.
        const who = createdByWho(record, sessionColumns);
        // A flat list holds files from several folders: say which one.
        const folder = flat ? folderOfKey(record.key) : '';
        return (
          <div className={styles.nameCell}>
            <FileKindIcon file={{ contentType: record.contentType, name: record.name, key: record.key }} />
            <div className={styles.nameStack}>
              <div className={styles.nameLine}>
                <UnstyledButton
                  type="button"
                  className={styles.nameButton}
                  title={record.key}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenFile(record.key);
                  }}
                >
                  {record.name}
                </UnstyledButton>
                {isSessionFile(record) ? <SessionBadge /> : null}
              </div>
              {folder || who ? (
                <span className={styles.nameMeta} title={record.createdBy}>
                  {folder ? <span className="ds-mono">{folder}</span> : null}
                  {folder && who ? ' · ' : null}
                  {who ? t('createdBy', { who }) : null}
                </span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'size',
      label: tb('columns.size'),
      align: 'right',
      render: (row) => (row.kind === 'file' ? <span className="ds-mono">{formatBytes(row.record.size)}</span> : <span className="ds-faint">—</span>),
    },
    {
      key: 'type',
      label: tb('columns.type'),
      render: (row) =>
        row.kind === 'file' ? (
          <FileKindChip file={{ contentType: row.record.contentType, name: row.record.name, key: row.record.key }} />
        ) : (
          <span className="ds-badge">{t('browse.folderRow')}</span>
        ),
    },
    {
      key: 'markdown',
      label: tb('columns.markdown'),
      render: (row) =>
        row.kind === 'file' ? (
          <MarkdownStatusBadge status={row.record.markdownStatus} error={row.record.markdownError} />
        ) : (
          <span className="ds-faint">—</span>
        ),
    },
    ...(sessionColumns
      ? ([
          {
            key: 'session',
            label: t('columns.session'),
            render: (row) => (row.kind === 'file' ? <SessionLinkCell record={row.record} agentId={row.record.agentId} /> : <span className="ds-faint">—</span>),
          },
          {
            key: 'expires',
            label: t('columns.expires'),
            render: (row) => (row.kind === 'file' ? <ExpiryCell record={row.record} now={now} locale={locale} /> : <span className="ds-faint">—</span>),
          },
          {
            key: 'uploadedBy',
            label: t('columns.uploadedBy'),
            render: (row) => (row.kind === 'file' ? <UploaderCell record={row.record} /> : <span className="ds-faint">—</span>),
          },
        ] satisfies DataGridColumn<FilesRow>[])
      : []),
    {
      key: 'modified',
      label: tb('columns.modified'),
      render: (row) => (row.kind === 'file' ? <RelativeTime value={modifiedAt(row.record)} /> : <span className="ds-faint">—</span>),
    },
    {
      key: 'actions',
      width: 56,
      align: 'right',
      label: <VisuallyHidden>{tb('columns.actions')}</VisuallyHidden>,
      render: (row) =>
        row.kind === 'file' ? (
          <FileRowMenu
            record={row.record}
            canDelete={editable}
            onDownload={downloadFile}
            onCopyKey={(record) => void copyKey(record)}
            onDelete={(record) => setDeleteTarget({ keys: [record.key], fileName: record.name })}
          />
        ) : null,
    },
  ];

  /* ── Toolbar, states, footer ─────────────────────────────────────────── */

  const filters: DataGridFilter[] = [
    {
      value: state.type ?? 'all',
      onChange: (value) => update({ type: value === 'all' ? null : (value as FileKind) }),
      options: [
        { value: 'all', label: kindLabels.all },
        ...FILE_KINDS.map((kind) => ({ value: kind, label: kindLabels[kind] })),
      ],
      width: 150,
      ariaLabel: tb('toolbar.typeLabel'),
    },
    {
      value: state.show,
      onChange: (value) => update({ show: value as SessionFileFilter }),
      options: [
        { value: 'all', label: t('filter.all') },
        { value: 'session', label: t('filter.session') },
        { value: 'other', label: t('filter.other') },
      ],
      width: 150,
      ariaLabel: t('filter.label'),
    },
  ];

  const bulkBar =
    selectedKeys.length > 0 ? (
      <div className={styles.bulkBar} role="group" aria-label={tb('bulk.label')}>
        <span className={styles.bulkCount} role="status">
          {tb('bulk.selected', { count: selectedKeys.length })}
        </span>
        <Tooltip label={tb('bulk.downloadLimit', { max: ARCHIVE_MAX_KEYS })} disabled={!tooManyForZip} withArrow>
          <span>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconDownload size={14} />}
              loading={archive.isPending}
              disabled={tooManyForZip}
              onClick={downloadSelected}
            >
              {tb('bulk.download')}
            </Button>
          </span>
        </Tooltip>
        {editable ? (
          <Button
            size="xs"
            variant="default"
            color="red"
            leftSection={<IconTrash size={14} />}
            onClick={() => setDeleteTarget({ keys: selectedKeys })}
          >
            {tb('bulk.delete')}
          </Button>
        ) : null}
        <ActionIcon variant="subtle" color="gray" size="md" radius="md" aria-label={tb('bulk.clear')} onClick={clearSelection}>
          <IconX size={14} />
        </ActionIcon>
      </div>
    ) : null;

  const uploadHere = editable ? { label: tb('empty.uploadHere'), icon: <IconUpload size={14} />, onClick: () => onOpenUpload(state.path) } : undefined;
  const empty: DataGridEmpty = hasListingFilters(state)
    ? {
        icon: <IconFilterOff size={22} stroke={1.6} />,
        title: tb('empty.noMatches'),
        description: tb('empty.noMatchesHint'),
        primaryAction: { label: tb('empty.clearFilters'), onClick: clearFilters },
      }
    : {
        icon: <IconFolder size={22} stroke={1.6} />,
        title: t('browse.emptyFolder'),
        ...(uploadHere ? { primaryAction: uploadHere } : {}),
      };

  const loadedCount = fileRows.length;
  const isBucketEmpty =
    !listing.isPending && !listing.isError && rows.length === 0 && !listing.hasNextPage && state.path === '' && !hasListingFilters(state);

  const header = (
    <div className={styles.pathRow}>
      <FolderPath prefix={state.path} onOpen={openFolder} />
    </div>
  );

  const dialog = (
    <DeleteFilesDialog
      opened={deleteTarget !== null}
      bucketKey={bucketKey}
      keys={deleteTarget?.keys ?? []}
      fileName={deleteTarget?.fileName}
      onClose={() => setDeleteTarget(null)}
      onFinished={finishedDelete}
    />
  );

  if (listing.isError && !listing.data) {
    return (
      <>
        {header}
        <StateCard
          tone="error"
          icon={<IconAlertTriangle size={22} stroke={1.6} />}
          title={tb('error.title')}
          description={filesErrorMessage(listing.error, tc)}
        >
          <Button size="sm" variant="default" loading={listing.isFetching} onClick={() => void listing.refetch()}>
            {tb('error.retry')}
          </Button>
        </StateCard>
        {dialog}
      </>
    );
  }

  if (isBucketEmpty) {
    return (
      <>
        <StateCard
          icon={<IconFolderPlus size={22} stroke={1.6} />}
          title={tb('emptyBucket.title')}
          description={editable ? tb('emptyBucket.hint') : tb('emptyBucket.hintReadOnly')}
        >
          {editable ? (
            <Group gap="xs" justify="center">
              <Button size="sm" color="teal" leftSection={<IconUpload size={14} />} onClick={() => onOpenUpload('')}>
                {tb('emptyBucket.upload')}
              </Button>
              {onOpenImport ? (
                <Button size="sm" variant="default" onClick={onOpenImport}>
                  {tb('emptyBucket.import')}
                </Button>
              ) : null}
            </Group>
          ) : null}
        </StateCard>
        {dialog}
      </>
    );
  }

  return (
    <>
      {header}
      {flat ? (
        <Text size="xs" c="dimmed" mb="xs">
          {tb('toolbar.flatHint', { folder: state.path || t('browse.rootLabel') })}
        </Text>
      ) : null}
      {listing.isError ? (
        <Alert className={styles.inlineAlert} color="red" icon={<IconFileOff size={16} />} role="alert">
          <Group justify="space-between" gap="sm" wrap="wrap">
            <span>{filesErrorMessage(listing.error, tc)}</span>
            <Button size="xs" variant="default" loading={listing.isFetching} onClick={() => void listing.refetch()}>
              {tb('error.retry')}
            </Button>
          </Group>
        </Alert>
      ) : null}
      <DataGrid<FilesRow>
        records={rows}
        rowKey={(row) => row.id}
        columns={columns}
        loading={listing.isPending}
        refreshing={listing.isRefetching && !listing.isFetchingNextPage}
        onRowClick={openRow}
        selected={selectedRowIds}
        search={{ value: searchText, onChange: setSearchText, placeholder: tb('toolbar.search') }}
        filters={filters}
        toolbarRight={bulkBar}
        empty={empty}
        footerLeft={loadedCount === 1 ? tb('footer.showingOne') : tb('footer.showingMany', { count: loadedCount })}
        footerRight={
          listing.hasNextPage ? (
            <Button size="xs" variant="default" loading={listing.isFetchingNextPage} onClick={() => void listing.fetchNextPage()}>
              {tb('footer.loadMore')}
            </Button>
          ) : null
        }
      />
      {dialog}
    </>
  );
}
