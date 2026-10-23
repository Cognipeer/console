/**
 * The Files tab as pure functions: the listing it asks for, the rows it draws (folders first, then files), the
 * selection behind the bulk bar and the batching of a bulk delete. Kept apart from the component so the rules are
 * tested without a DOM.
 */

import type { FileRecordView } from '@/lib/services/files';
import type { BatchDeleteResult, ObjectsQuery } from '../filesApi';
import { applySessionFilter, filesInFolder, isSessionFile, purposeParam, subFolders } from './fileBrowse';
import { isFlatListing, type FilesTabState } from './filesTabState';

/** Files per page of the listing ("Load more" asks for the next). */
export const PAGE_SIZE = 50;
/** The most files one zip carries. */
export const ARCHIVE_MAX_KEYS = 50;
/** The most keys one batch-delete request carries. */
export const BATCH_DELETE_MAX_KEYS = 100;

/** The listing the state asks the server for. The folder is always sent (a search is then scoped to it). */
export function listingQuery(state: FilesTabState): ObjectsQuery {
  const purpose = purposeParam(state.show);
  return {
    prefix: state.path,
    limit: PAGE_SIZE,
    ...(state.q ? { search: state.q } : {}),
    ...(state.type ? { type: state.type } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

export interface FolderRow {
  kind: 'folder';
  id: string;
  name: string;
  /** The full prefix, ending in `/`. */
  path: string;
}

export interface FileRow {
  kind: 'file';
  id: string;
  record: FileRecordView;
}

export type FilesRow = FolderRow | FileRow;

/**
 * The rows of the grid. A folder listing shows the sub-folders (the ones the server named and any a nested key
 * implies) and the files directly in the folder; a search or a type listing is flat: only the matches, wherever
 * they are below the folder. The session filter is applied here again in case the server ignored it.
 */
export function buildRows(input: {
  items: readonly FileRecordView[];
  folders: readonly string[];
  state: FilesTabState;
}): FilesRow[] {
  const { state } = input;
  const items = applySessionFilter([...input.items], state.show);
  if (isFlatListing(state)) {
    return items.map((record) => ({ kind: 'file', id: `file:${record.key}`, record }));
  }
  const folders = subFolders(state.path, [...input.folders], items).map<FolderRow>((folder) => ({
    kind: 'folder',
    id: `folder:${folder.path}`,
    name: folder.name,
    path: folder.path,
  }));
  const files = filesInFolder(state.path, items).map<FileRow>((record) => ({
    kind: 'file',
    id: `file:${record.key}`,
    record,
  }));
  return [...folders, ...files];
}

export function fileRowsOf(rows: readonly FilesRow[]): FileRow[] {
  return rows.filter((row): row is FileRow => row.kind === 'file');
}

/** The folder a key sits in: `reports/2026/a.pdf` -> `reports/2026/`; `''` for a file at the root. */
export function folderOfKey(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash >= 0 ? key.slice(0, slash + 1) : '';
}

/** The session columns are drawn when the list is the session filter or holds a session file. */
export function showsSessionColumns(state: Pick<FilesTabState, 'show'>, records: ReadonlyArray<Pick<FileRecordView, 'purpose'>>): boolean {
  return state.show === 'session' || records.some(isSessionFile);
}

// The Markdown copy of a file can be downloaded when there is one (`markdownKey`): the status of the last conversion
// does not decide it (a failed or skipped re-conversion leaves the earlier copy). The rule is shared with the drawer.
export { hasMarkdownCopy } from '../shared/fileKind';

/** The time a file last changed (a file never updated has its creation time). */
export function modifiedAt(record: Pick<FileRecordView, 'updatedAt' | 'createdAt'>): Date | string | null {
  return record.updatedAt ?? record.createdAt ?? null;
}

/* ── Selection ───────────────────────────────────────────────────────────── */

export type SelectionState = 'none' | 'some' | 'all';

export function toggleSelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** How much of `keys` (the files on screen) is selected. */
export function selectionState(selected: ReadonlySet<string>, keys: readonly string[]): SelectionState {
  if (keys.length === 0) return 'none';
  const count = keys.filter((key) => selected.has(key)).length;
  if (count === 0) return 'none';
  return count === keys.length ? 'all' : 'some';
}

/** The selected keys that are still on screen, in screen order (a key the list no longer shows is not acted on). */
export function selectedVisibleKeys(selected: ReadonlySet<string>, keys: readonly string[]): string[] {
  return keys.filter((key) => selected.has(key));
}

/* ── Bulk delete ─────────────────────────────────────────────────────────── */

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export function mergeBatchResults(results: readonly BatchDeleteResult[]): BatchDeleteResult {
  return {
    deleted: results.flatMap((result) => result.deleted),
    failed: results.flatMap((result) => result.failed),
  };
}

/**
 * Deletes `keys` in requests of at most `batchSize`, one after the other, and accounts for every key: a key is
 * either in `deleted` or in `failed` with the reason. A request that fails as a whole (a lost connection, a
 * refusal) fails its own keys and the ones after it, and ends the run: the same refusal would meet the rest.
 */
export async function deleteInBatches(
  keys: readonly string[],
  deleteBatch: (batch: string[]) => Promise<BatchDeleteResult>,
  options: { batchSize?: number; describeError: (error: unknown) => string; onProgress?: (processed: number, total: number) => void },
): Promise<BatchDeleteResult> {
  const batches = chunk(keys, options.batchSize ?? BATCH_DELETE_MAX_KEYS);
  const results: BatchDeleteResult[] = [];
  let processed = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    try {
      results.push(await deleteBatch(batch));
    } catch (error) {
      const reason = options.describeError(error);
      const rest = batches.slice(index).flat();
      results.push({ deleted: [], failed: rest.map((key) => ({ key, error: reason })) });
      options.onProgress?.(keys.length, keys.length);
      break;
    }
    processed += batch.length;
    options.onProgress?.(processed, keys.length);
  }
  return mergeBatchResults(results);
}

/** The first `max` failures and how many more there are. */
export function previewFailures(
  failed: BatchDeleteResult['failed'],
  max = 5,
): { shown: BatchDeleteResult['failed']; more: number } {
  return { shown: failed.slice(0, max), more: Math.max(0, failed.length - max) };
}
