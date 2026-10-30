'use client';

/**
 * The Documents tab's list: the open folder's folders first, then its documents, in ONE grid. Above it the folder
 * path with the open folder's own menu; in the rows, the Access column (admins), the ⋯ menus and the bulk move.
 *
 * The page owns the documents (loading, paging, OCR progress, re-ingest) and hands over how a document row is
 * drawn (`documentColumns`) and its own actions; the library adds the folders around them and everything that
 * changes the structure. Rules of who sees what live in `libraryModel.ts`.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Badge, Button, Group, Menu, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconDots,
  IconExternalLink,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderSymlink,
  IconLock,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';
import DataGrid, {
  RowActionItems,
  type DataGridColumn,
  type DataGridProps,
  type DataGridRowAction,
} from '@/components/common/ui/DataGrid';
import { useConfirm } from '@/components/common/confirm';
import { documentNode, folderNode, ragErrorMessage, ragAccessApi, type RagFolderView } from '@/components/rag/access/ragAccessApi';
import type { RagPermissionTarget } from '@/components/rag/access/RagPermissionEditor';
import RagFolderForm, { type FolderFlow } from './RagFolderForm';
import RagFolderPath from './RagFolderPath';
import {
  accessCellOf,
  childFolders,
  contentsLabel,
  documentActions as libraryDocumentActions,
  folderActions,
  folderChain,
  formatWhen,
  isPathOnly,
  isSyncedFolder,
  libraryLine,
  libraryRows,
  locationLabel,
  movableItems,
  type AccessCell,
  type DocumentActionId,
  type FolderActionId,
  type LibraryAction,
  type LibraryRow,
  type LibraryViewer,
  type RagLibraryDocument,
} from './libraryModel';
import { useRagNodeStates } from './useRagNodeStates';

/** What the page hands to the grid's toolbar and footer: the search, the status filter, refresh and paging. */
export interface RagLibraryChrome {
  search: NonNullable<DataGridProps<never>['search']>;
  filters?: DataGridProps<never>['filters'];
  onRefresh?: () => void;
  refreshing?: boolean;
  pagination?: DataGridProps<never>['pagination'];
  footerLeft?: ReactNode;
}

export interface RagLibraryProps<D extends RagLibraryDocument> {
  moduleKey: string;
  moduleName: string;
  viewer: LibraryViewer;
  /** Access control is on for the knowledge base. */
  accessEnabled: boolean;
  /** Every folder the viewer may see (names only for the ones that are path-only). */
  folders: RagFolderView[];
  /** The open folder; null = the top level. */
  openFolderId: string | null;
  onOpenFolder: (folderId: string | null) => void;
  /** The documents of the open place (or of a search), one page. */
  documents: D[];
  /** How many the listing holds; null while another place is still loading. */
  docTotal: number | null;
  /** The search in force; a search spans every folder. */
  searchTerm: string;
  /** A search or a status filter narrows the list. */
  filtered: boolean;
  page: number;
  loading: boolean;
  chrome: RagLibraryChrome;
  /** How the page draws a document: columns `fileName`, `chunks`, `status`, `indexedAt`, `createdAt`. */
  documentColumns: DataGridColumn<D>[];
  /** The page's own actions of a document (Re-ingest, Re-extract, Delete), already limited to what the viewer may do. */
  documentActions: (doc: D) => Array<DataGridRowAction<D>>;
  /** Shown instead of the grid (the path stays, so a failing place can be left). */
  errorView?: ReactNode;
  /** Bumped after permissions changed anywhere: the Access column reads again. */
  accessRefreshKey: number;
  onEditPermissions: (target: RagPermissionTarget) => void;
  onOpenConnector: (connectorId: string) => void;
  /** After a change the server accepted: the page reads folders and documents again. */
  onChanged: () => Promise<void> | void;
}

const NO_FOLDERS: RagFolderView[] = [];

const FOLDER_ICONS: Record<FolderActionId, ReactNode> = {
  open: <IconFolderOpen size={14} />,
  permissions: <IconLock size={14} />,
  rename: <IconPencil size={14} />,
  move: <IconFolderSymlink size={14} />,
  delete: <IconTrash size={14} />,
  connector: <IconExternalLink size={14} />,
};

const DOCUMENT_ICONS: Record<DocumentActionId, ReactNode> = {
  permissions: <IconLock size={14} />,
  move: <IconFolderSymlink size={14} />,
  connector: <IconExternalLink size={14} />,
};

/** A model action as a menu row of the grid. */
function gridActions<Id extends string, R>(
  items: Array<LibraryAction<Id>>,
  icons: Record<Id, ReactNode>,
  run: (id: Id) => void,
): Array<DataGridRowAction<R>> {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    icon: icons[item.id],
    color: item.id === 'delete' ? ('red' as const) : undefined,
    disabled: item.disabled,
    disabledReason: item.disabledReason,
    onClick: () => run(item.id),
  }));
}

/** A page-owned action of a document as an action of a library row: the handlers get the document back. */
function documentRowAction<D, R>(action: DataGridRowAction<D>, doc: D): DataGridRowAction<R> {
  return {
    ...action,
    onClick: action.onClick ? () => action.onClick!(doc) : undefined,
    disabled: typeof action.disabled === 'function' ? () => (action.disabled as (row: D) => boolean)(doc) : action.disabled,
    hidden: typeof action.hidden === 'function' ? () => (action.hidden as (row: D) => boolean)(doc) : action.hidden,
  };
}

function Dash() {
  return <Text size="xs" c="dimmed">—</Text>;
}

function FolderNameCell({ folder, onOpen }: { folder: RagFolderView; onOpen: () => void }) {
  const pathOnly = isPathOnly(folder);
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon size={28} radius="md" variant="light" color={pathOnly ? 'gray' : 'yellow'}>
        <IconFolder size={15} />
      </ThemeIcon>
      <UnstyledButton onClick={onOpen} aria-label={`Open folder ${folder.name}`} style={{ minWidth: 0 }}>
        <Text
          size="sm"
          fw={pathOnly ? 400 : 500}
          fs={pathOnly ? 'italic' : undefined}
          c={pathOnly ? 'dimmed' : undefined}
          lineClamp={1}
        >
          {folder.name}
        </Text>
      </UnstyledButton>
      {pathOnly ? <Text size="xs" c="dimmed">path only</Text> : null}
      {isSyncedFolder(folder) ? <Badge variant="light" color="blue" size="xs">Synced</Badge> : null}
    </Group>
  );
}

function AccessLabel({ cell }: { cell: AccessCell }) {
  if (cell.tone === 'inherit') return <Text size="sm" c="dimmed">{cell.label}</Text>;
  if (cell.tone === 'own') return <Text size="sm">{cell.label}</Text>;
  if (cell.tone === 'synced') return <Badge variant="light" color="blue" size="sm">{cell.label}</Badge>;
  // Own or synced with no entry at all: nobody reads it, except admins who hold the admin exception.
  return (
    <Tooltip label="Readable by nobody except admins with the admin exception" withArrow multiline w={220}>
      <Badge variant="light" color="orange" size="sm">{cell.label}</Badge>
    </Tooltip>
  );
}

export default function RagLibrary<D extends RagLibraryDocument>({
  moduleKey,
  moduleName,
  viewer,
  accessEnabled,
  folders,
  openFolderId,
  onOpenFolder,
  documents,
  docTotal,
  searchTerm,
  filtered,
  page,
  loading,
  chrome,
  documentColumns,
  documentActions,
  errorView,
  accessRefreshKey,
  onEditPermissions,
  onOpenConnector,
  onChanged,
}: RagLibraryProps<D>) {
  const { confirm } = useConfirm();
  const searching = searchTerm.trim() !== '';
  const hasFolders = folders.length > 0;
  const [flow, setFlow] = useState<FolderFlow | null>(null);
  const [selection, setSelection] = useState<Set<string>>(() => new Set());

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder._id, folder])), [folders]);
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of folders) {
      if (folder.parentId) counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
    }
    return counts;
  }, [folders]);
  const openFolder = openFolderId ? folderById.get(openFolderId) ?? null : null;
  const children = useMemo(() => childFolders(folders, openFolderId), [folders, openFolderId]);
  // The folders list ahead of the documents on the first page; a search looks across all folders and lists documents only.
  const shownFolders = !searching && page === 1 ? children : NO_FOLDERS;
  const rows = useMemo(() => libraryRows(shownFolders, documents), [shownFolders, documents]);

  // A selection belongs to the rows on screen: another place, page or search leaves nothing selected.
  const selected = useMemo(() => {
    const onScreen = new Set(rows.map((row) => row.key));
    return new Set([...selection].filter((key) => onScreen.has(key)));
  }, [selection, rows]);

  const nodes = useRagNodeStates(moduleKey, {
    enabled: viewer.canAdmin,
    folderIds: shownFolders.map((folder) => folder._id),
    documentIds: documents.map((doc) => doc._id),
    refreshKey: accessRefreshKey,
  });

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const changed = async () => {
    setSelection(new Set());
    try {
      await onChanged();
    } catch {
      /* the page reads again on its own */
    }
  };

  const deleteFolder = async (folder: RagFolderView) => {
    const ok = await confirm({
      title: 'Delete this folder?',
      message: `“${folder.name}” is empty. It is removed together with its own permissions; no document is touched.`,
      confirmLabel: 'Delete folder',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await ragAccessApi.deleteFolder(moduleKey, folder._id);
      notifications.show({ color: 'green', title: 'Folder deleted', message: `${folder.name} was removed.` });
      // Deleting the place that is open leaves it for the one above.
      if (openFolderId === folder._id) onOpenFolder(folder.parentId || null);
      await changed();
    } catch (error) {
      notifications.show({ color: 'red', title: 'Folder not deleted', message: ragErrorMessage(error, 'The folder could not be deleted.') });
    }
  };

  const runFolderAction = (id: FolderActionId, folder: RagFolderView) => {
    switch (id) {
      case 'open':
        onOpenFolder(folder._id);
        break;
      case 'permissions':
        onEditPermissions({ node: folderNode(folder._id), name: folder.name, path: folder.path });
        break;
      case 'rename':
        setFlow({ kind: 'rename', folder });
        break;
      case 'move':
        setFlow({ kind: 'move', items: { folders: [folder], documents: [], skipped: 0 } });
        break;
      case 'delete':
        void deleteFolder(folder);
        break;
      case 'connector':
        if (folder.source?.connectorId) onOpenConnector(folder.source.connectorId);
        break;
      default:
        break;
    }
  };

  const runDocumentAction = (id: DocumentActionId, doc: D) => {
    const folder = doc.folderId ? folderById.get(doc.folderId) : undefined;
    switch (id) {
      case 'permissions':
        onEditPermissions({ node: documentNode(doc._id), name: doc.fileName, path: folder?.path ?? '' });
        break;
      case 'move':
        setFlow({ kind: 'move', items: { folders: [], documents: [doc], skipped: 0 } });
        break;
      case 'connector':
        if (folder?.source?.connectorId) onOpenConnector(folder.source.connectorId);
        break;
      default:
        break;
    }
  };

  const rowActions = (row: LibraryRow<D>): Array<DataGridRowAction<LibraryRow<D>>> => {
    if (row.kind === 'folder') {
      const { folder } = row;
      return gridActions<FolderActionId, LibraryRow<D>>(
        folderActions(viewer, folder, childCounts.get(folder._id) ?? 0),
        FOLDER_ICONS,
        (id) => runFolderAction(id, folder),
      );
    }
    const { doc } = row;
    const connectorId = doc.folderId ? folderById.get(doc.folderId)?.source?.connectorId : undefined;
    const own = libraryDocumentActions(viewer, doc, { hasFolders, connectorId });
    const run = (id: DocumentActionId) => runDocumentAction(id, doc);
    return [
      ...gridActions<DocumentActionId, LibraryRow<D>>(own.before, DOCUMENT_ICONS, run),
      ...documentActions(doc).map((action) => documentRowAction<D, LibraryRow<D>>(action, doc)),
      ...gridActions<DocumentActionId, LibraryRow<D>>(own.after, DOCUMENT_ICONS, run),
    ];
  };

  /* ── Columns ───────────────────────────────────────────────────────────── */

  const documentColumn = (key: string) => documentColumns.find((column) => column.key === key);
  const documentCell = (key: string, doc: D): ReactNode => documentColumn(key)?.render(doc) ?? <Dash />;

  const columns: Array<DataGridColumn<LibraryRow<D>>> = [
    {
      key: 'name',
      label: 'Name',
      render: (row) => (row.kind === 'folder'
        ? <FolderNameCell folder={row.folder} onOpen={() => onOpenFolder(row.folder._id)} />
        : (documentColumn('fileName')?.render(row.doc) ?? <Text size="sm" fw={500}>{row.doc.fileName}</Text>)),
    },
    ...(searching
      ? [{
        key: 'location',
        label: 'Location',
        render: (row: LibraryRow<D>) => (row.kind === 'document'
          ? <Text size="xs" c="dimmed">{locationLabel(folders, row.doc.folderId)}</Text>
          : <Dash />),
      }]
      : []),
    ...(viewer.canAdmin
      ? [{
        key: 'access',
        label: 'Access',
        width: 150,
        render: (row: LibraryRow<D>) => <AccessLabel cell={accessCellOf(row, nodes[row.key])} />,
      }]
      : []),
    {
      key: 'contents',
      label: 'Contents',
      align: 'center',
      width: 110,
      render: (row) => {
        if (row.kind === 'document') return documentCell('chunks', row.doc);
        const label = contentsLabel(row.folder, childCounts.get(row.folder._id) ?? 0);
        return label ? <Text size="sm">{label}</Text> : <Dash />;
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (row) => (row.kind === 'document' ? documentCell('status', row.doc) : <Dash />),
    },
    {
      key: 'indexedAt',
      label: 'Indexed At',
      render: (row) => (row.kind === 'document' ? documentCell('indexedAt', row.doc) : <Dash />),
    },
    {
      key: 'createdAt',
      label: 'Created',
      render: (row) => (row.kind === 'document'
        ? documentCell('createdAt', row.doc)
        : isPathOnly(row.folder)
          ? <Dash />
          : <Text size="xs" c="dimmed">{formatWhen(row.folder.updatedAt ?? row.folder.createdAt)}</Text>),
    },
  ];

  /* ── Chrome around the grid ────────────────────────────────────────────── */

  const showPath = hasFolders || openFolderId !== null;
  const chain = folderChain(folders, openFolderId);
  const crumbs = chain
    ? chain.map((folder) => ({ id: folder._id, name: folder.name }))
    // The folder is not in the list (yet): the path still says there is one.
    : openFolderId ? [{ id: openFolderId, name: 'Folder' }] : [];

  const openMenuActions = openFolder
    ? folderActions(viewer, openFolder, childCounts.get(openFolder._id) ?? 0).filter((action) => action.id !== 'open')
    : [];
  const pathMenu = openFolder && openMenuActions.length > 0 ? (
    <Menu withinPortal position="bottom-start" withArrow>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Folder actions">
          <IconDots size={16} stroke={1.7} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <RowActionItems
          actions={gridActions<FolderActionId, RagFolderView>(openMenuActions, FOLDER_ICONS, (id) => runFolderAction(id, openFolder))}
          row={openFolder}
        />
      </Menu.Dropdown>
    </Menu>
  ) : null;

  const newFolderButton = viewer.canChangeStructure ? (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconFolderPlus size={14} />}
      onClick={() => setFlow({ kind: 'create', parentId: openFolderId })}
    >
      New folder
    </Button>
  ) : null;

  const empty = filtered
    ? { icon: <IconFileText size={28} />, title: 'No document matches', description: 'Try a different search or status filter.' }
    : openFolderId !== null
      ? {
        icon: <IconFolder size={28} />,
        title: 'This folder is empty',
        description: viewer.canWrite ? 'Ingest a document above with this folder selected.' : 'Nothing has been added here yet.',
      }
      : {
        icon: <IconFileText size={28} />,
        title: 'No documents yet',
        description: viewer.canWrite ? 'Ingest your first document above.' : 'Nothing has been added here yet.',
      };

  // Only where there is somewhere to move to: a knowledge base without folders keeps the list as it was.
  const selectable = viewer.canChangeStructure && hasFolders;

  return (
    <>
      {showPath ? (
        <RagFolderPath
          moduleName={moduleName}
          chain={crumbs}
          onOpen={onOpenFolder}
          menu={pathMenu}
          summary={libraryLine({ folderCount: children.length, docTotal, search: searchTerm })}
        />
      ) : null}

      {errorView ?? (
        <DataGrid<LibraryRow<D>>
          records={rows}
          rowKey={(row) => row.key}
          loading={loading}
          columns={columns}
          search={chrome.search}
          filters={chrome.filters}
          toolbarRight={newFolderButton}
          rowActions={rowActions}
          selectable={selectable}
          selected={selected}
          onSelectionChange={setSelection}
          bulkActions={selectable
            ? [
              {
                label: 'Move…',
                icon: <IconFolderSymlink size={14} />,
                onClick: (picked) => setFlow({ kind: 'move', items: movableItems(picked) }),
              },
              { label: 'Clear', onClick: () => setSelection(new Set()) },
            ]
            : undefined}
          onRefresh={chrome.onRefresh}
          refreshing={chrome.refreshing}
          empty={empty}
          pagination={chrome.pagination}
          footerLeft={chrome.footerLeft}
        />
      )}

      <RagFolderForm
        flow={flow}
        moduleKey={moduleKey}
        moduleName={moduleName}
        folders={folders}
        accessEnabled={accessEnabled}
        onClose={() => setFlow(null)}
        onChanged={changed}
      />
    </>
  );
}

