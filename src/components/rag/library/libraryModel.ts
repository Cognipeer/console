/**
 * The model behind the Documents tab's library: one list of folders and documents, who may do what to a row, what
 * the Access column says, and the rules of the folder forms. Pure: no React, no network, so the rules are testable
 * on their own and the components only draw them.
 */

import type { RagAccessNodeState, RagFolderView } from '@/components/rag/access/ragAccessApi';

/** The folder select's value for the top level (a folder id can never be this). */
export const TOP_LEVEL = '__top__';
export const TOP_LEVEL_LABEL = 'Top level';
export const MAX_FOLDER_NAME_LENGTH = 200;
/** Documents per move request: the server refuses more. */
export const MOVE_BATCH_SIZE = 500;

/** What the library reads of a document row; the page's own row type has more. */
export interface RagLibraryDocument {
  _id: string;
  fileName: string;
  folderId?: string;
  aclMode?: 'own';
  aclManaged?: 'sync';
}

export type LibraryRow<D extends RagLibraryDocument = RagLibraryDocument> =
  | { kind: 'folder'; key: string; folder: RagFolderView }
  | { kind: 'document'; key: string; doc: D };

/** Row keys double as the keys of `ragAccessApi.nodes()`'s answer. */
export const folderRowKey = (id: string): string => `folder:${id}`;
export const documentRowKey = (id: string): string => `document:${id}`;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The same rendering the page gives a date. */
export function formatWhen(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/* ── Folders ─────────────────────────────────────────────────────────────── */

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const isPathOnly = (folder: Pick<RagFolderView, 'pathOnly'>): boolean => folder.pathOnly === true;

/** A folder a connected source owns: it is renamed, moved and deleted there, and mirrors the source's permissions. */
export const isSyncedFolder = (folder: Pick<RagFolderView, 'source' | 'aclManaged'>): boolean =>
  Boolean(folder.source) || folder.aclManaged === 'sync';

export const isSyncedDocument = (doc: Pick<RagLibraryDocument, 'aclManaged'>): boolean => doc.aclManaged === 'sync';

/** The folders directly in `parentId` (null = top level), by name. */
export function childFolders(folders: RagFolderView[], parentId: string | null): RagFolderView[] {
  return folders
    .filter((folder) => (folder.parentId || null) === parentId)
    .sort((a, b) => collator.compare(a.name, b.name));
}

/** The folders from the top level down to `id`, or null when `id` is not in the list or its chain is broken. */
export function folderChain(folders: RagFolderView[], id: string | null): RagFolderView[] | null {
  if (id === null) return [];
  const byId = new Map(folders.map((folder) => [folder._id, folder]));
  const chain: RagFolderView[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor) {
    if (seen.has(cursor)) return null;
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) return null;
    chain.unshift(folder);
    cursor = folder.parentId || null;
  }
  return chain;
}

/** "Policies / Leave": the folder's path as the lists show it. */
export function displayPath(folder: Pick<RagFolderView, 'path' | 'name'>): string {
  const parts = (folder.path || folder.name).split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : folder.name;
}

/** Where a document sits, for the Location column: the folder's path, "Top level", or a dash for a folder not in the list. */
export function locationLabel(folders: RagFolderView[], folderId: string | null | undefined): string {
  if (!folderId) return TOP_LEVEL_LABEL;
  const folder = folders.find((candidate) => candidate._id === folderId);
  return folder ? displayPath(folder) : '—';
}

/** `ids` and every folder below them. */
export function withDescendants(folders: RagFolderView[], ids: string[]): Set<string> {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const siblings = children.get(folder.parentId);
    if (siblings) siblings.push(folder._id);
    else children.set(folder.parentId, [folder._id]);
  }
  const all = new Set(ids);
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const child of children.get(id) ?? []) {
      if (all.has(child)) continue;
      all.add(child);
      stack.push(child);
    }
  }
  return all;
}

export interface FolderChoice {
  value: string;
  label: string;
}

/**
 * The places a select offers: the top level, then every folder by path. A folder the viewer only sees the name of
 * is never a place; `exclude` lists folders to leave out together with everything below them, `skipSynced` the
 * folders a source owns.
 */
export function folderChoices(
  folders: RagFolderView[],
  options: { exclude?: string[]; skipSynced?: boolean } = {},
): FolderChoice[] {
  const blocked = options.exclude && options.exclude.length > 0 ? withDescendants(folders, options.exclude) : new Set<string>();
  const places = folders
    .filter((folder) => !isPathOnly(folder) && !blocked.has(folder._id) && !(options.skipSynced && isSyncedFolder(folder)))
    .sort((a, b) => collator.compare(displayPath(a), displayPath(b)))
    .map((folder) => ({ value: folder._id, label: displayPath(folder) }));
  return [{ value: TOP_LEVEL, label: TOP_LEVEL_LABEL }, ...places];
}

/** The select's value of a place: a folder id, or null for the top level. */
export const placeOf = (value: string | null | undefined): string | null => (!value || value === TOP_LEVEL ? null : value);

/** The folder a place falls back to when the chosen folder is gone (deleted or moved out of sight). */
export function knownPlace(folders: RagFolderView[], id: string | null): string | null {
  if (id === null) return null;
  return folders.some((folder) => folder._id === id && !isPathOnly(folder)) ? id : null;
}

/* ── Folder names ────────────────────────────────────────────────────────── */

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Why `raw` is no folder name (the server's own rule), or null when it is one. */
export function folderNameProblem(raw: string): string | null {
  const name = raw.trim();
  if (!name) return 'Enter a name.';
  if (name.length > MAX_FOLDER_NAME_LENGTH) return `A name is at most ${MAX_FOLDER_NAME_LENGTH} characters.`;
  if (name.includes('/')) return 'A name cannot contain “/”.';
  if (CONTROL_RE.test(name)) return 'A name cannot contain control characters.';
  if (name === '.' || name === '..') return 'A name cannot be “.” or “..”.';
  return null;
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/**
 * The rows of the list: the open folder's folders first (the first page only, and not while a search spans every
 * folder), then the documents of the page.
 */
export function libraryRows<D extends RagLibraryDocument>(
  folders: RagFolderView[],
  documents: D[],
): LibraryRow<D>[] {
  return [
    ...folders.map((folder): LibraryRow<D> => ({ kind: 'folder', key: folderRowKey(folder._id), folder })),
    ...documents.map((doc): LibraryRow<D> => ({ kind: 'document', key: documentRowKey(doc._id), doc })),
  ];
}

/** "14 items" for a folder: the folders and documents directly in it. A folder the viewer only sees the name of has no count. */
export function contentsLabel(folder: RagFolderView, childFolderCount: number): string | null {
  if (isPathOnly(folder)) return null;
  const items = childFolderCount + (folder.documents ?? 0);
  return plural(items, 'item');
}

/** The line above the list: what the open location holds, or what a search found. */
export function libraryLine(input: { folderCount: number; docTotal: number | null; search?: string }): string {
  const search = input.search?.trim();
  if (search) {
    if (input.docTotal === null) return 'Searching…';
    return `${plural(input.docTotal, 'document')} ${input.docTotal === 1 ? 'matches' : 'match'} “${search}”`;
  }
  const folders = plural(input.folderCount, 'folder');
  return input.docTotal === null ? folders : `${folders}, ${plural(input.docTotal, 'document')}`;
}

/* ── Access column ───────────────────────────────────────────────────────── */

export interface AccessCell {
  tone: 'inherit' | 'own' | 'nobody' | 'synced' | 'syncedNobody';
  label: string;
}

/** What the Access column says of a row: where its permissions come from and how many entries they name. */
export function accessCell(input: { mode?: 'own' | 'inherit'; managed?: 'sync'; entries?: number }): AccessCell {
  const entries = typeof input.entries === 'number' ? input.entries : null;
  if (input.managed === 'sync') {
    // A synced item that says nothing of its own has the permissions of the folder it is in.
    if (input.mode !== 'own') return { tone: 'synced', label: 'Synced' };
    if (entries === 0) return { tone: 'syncedNobody', label: 'Synced · nobody' };
    return { tone: 'synced', label: entries === null ? 'Synced' : `Synced · ${entries}` };
  }
  if (input.mode === 'own') {
    if (entries === 0) return { tone: 'nobody', label: 'Nobody' };
    return { tone: 'own', label: entries === null ? 'Own' : `Own · ${entries}` };
  }
  return { tone: 'inherit', label: 'Inherited' };
}

/** The node states answer wins over what the row says (it is read after a save); the row is the fallback while it loads. */
export function accessCellOf(
  row: { kind: 'folder'; folder: RagFolderView } | { kind: 'document'; doc: RagLibraryDocument },
  state: RagAccessNodeState | undefined,
): AccessCell {
  const own = row.kind === 'folder'
    ? { mode: row.folder.aclMode, managed: row.folder.aclManaged }
    : { mode: row.doc.aclMode ?? ('inherit' as const), managed: row.doc.aclManaged };
  return accessCell({
    mode: state?.mode ?? own.mode,
    managed: state?.managed ?? own.managed,
    entries: state?.entries,
  });
}

/* ── Menus ───────────────────────────────────────────────────────────────── */

export interface LibraryViewer {
  /** Re-ingest and delete documents (also true while the level is not known: the server decides). */
  canWrite: boolean;
  /** Knowledge Engine admin: permissions and the Access column. */
  canAdmin: boolean;
  /** Create, rename, move and delete folders and move documents: writers while access control is off, admins while it is on. */
  canChangeStructure: boolean;
}

export type FolderActionId = 'open' | 'permissions' | 'rename' | 'move' | 'delete' | 'connector';

export interface LibraryAction<Id extends string> {
  id: Id;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}

export const FOLDER_NOT_EMPTY = 'Only an empty folder can be deleted';

/**
 * The ⋯ menu of a folder, in order. A reader gets none, and neither does a writer who may not change the structure
 * (the name itself opens the folder, so a menu of "Open" alone would say nothing).
 */
export function folderActions(
  viewer: LibraryViewer,
  folder: RagFolderView,
  childFolderCount: number,
): Array<LibraryAction<FolderActionId>> {
  if (isPathOnly(folder)) return [];
  const synced = isSyncedFolder(folder);
  const items: Array<LibraryAction<FolderActionId>> = [];
  if (viewer.canAdmin) items.push({ id: 'permissions', label: synced ? 'Permissions (read-only)' : 'Permissions…' });
  if (viewer.canChangeStructure && !synced) {
    items.push({ id: 'rename', label: 'Rename…' }, { id: 'move', label: 'Move…' });
    const occupied = childFolderCount > 0 || (folder.documents ?? 0) > 0;
    items.push({ id: 'delete', label: 'Delete', ...(occupied ? { disabled: true, disabledReason: FOLDER_NOT_EMPTY } : {}) });
  }
  if (synced && viewer.canWrite && folder.source?.connectorId) items.push({ id: 'connector', label: 'Open connector' });
  return items.length > 0 ? [{ id: 'open', label: 'Open' }, ...items] : [];
}

export type DocumentActionId = 'permissions' | 'move' | 'connector';

/**
 * The library's own items of a document's ⋯ menu: `before` goes ahead of the page's actions (Re-ingest, Re-extract,
 * Delete), `after` behind them. A document a source owns does not move.
 */
export function documentActions(
  viewer: LibraryViewer,
  doc: RagLibraryDocument,
  context: { hasFolders: boolean; connectorId?: string },
): { before: Array<LibraryAction<DocumentActionId>>; after: Array<LibraryAction<DocumentActionId>> } {
  const synced = isSyncedDocument(doc);
  const before: Array<LibraryAction<DocumentActionId>> = [];
  const after: Array<LibraryAction<DocumentActionId>> = [];
  if (viewer.canAdmin) before.push({ id: 'permissions', label: synced ? 'Permissions (read-only)' : 'Permissions…' });
  // With no folder at all there is nowhere else to move a document to.
  if (viewer.canChangeStructure && !synced && context.hasFolders) before.push({ id: 'move', label: 'Move…' });
  if (synced && viewer.canWrite && context.connectorId) after.push({ id: 'connector', label: 'Open connector' });
  return { before, after };
}

/* ── Moving ──────────────────────────────────────────────────────────────── */

export interface MoveItems<D extends RagLibraryDocument = RagLibraryDocument> {
  folders: RagFolderView[];
  documents: D[];
  /** Selected items a source owns: they move only there. */
  skipped: number;
}

/** The rows of a selection that can move, and how many were left out. */
export function movableItems<D extends RagLibraryDocument>(rows: Array<LibraryRow<D>>): MoveItems<D> {
  const items: MoveItems<D> = { folders: [], documents: [], skipped: 0 };
  for (const row of rows) {
    if (row.kind === 'folder') {
      if (isSyncedFolder(row.folder) || isPathOnly(row.folder)) items.skipped += 1;
      else items.folders.push(row.folder);
    } else if (isSyncedDocument(row.doc)) {
      items.skipped += 1;
    } else {
      items.documents.push(row.doc);
    }
  }
  return items;
}

export const moveCount = (items: Pick<MoveItems, 'folders' | 'documents'>): number =>
  items.folders.length + items.documents.length;

/** The place every item is in now (a folder id, null for the top level), or undefined when they are not all in one. */
export function sharedPlace(items: Pick<MoveItems, 'folders' | 'documents'>): string | null | undefined {
  const places = new Set<string>([
    ...items.folders.map((folder) => folder.parentId || ''),
    ...items.documents.map((doc) => doc.folderId || ''),
  ]);
  if (places.size !== 1) return undefined;
  const [only] = [...places];
  return only || null;
}

/** Moving to where all of them already are changes nothing. */
export function moveIsNoop(items: Pick<MoveItems, 'folders' | 'documents'>, destination: string | null): boolean {
  const place = sharedPlace(items);
  return place !== undefined && place === destination;
}

/** `ids` in runs of at most `size`. */
export function inBatches<T>(ids: T[], size = MOVE_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}

/* ── The documents request ───────────────────────────────────────────────── */

/**
 * `folderId` of the documents request: the open folder (`root` for the top level), or none while a search spans every
 * folder.
 */
export function folderParamOf(searching: boolean, openFolderId: string | null): string | undefined {
  return searching ? undefined : (openFolderId ?? 'root');
}
