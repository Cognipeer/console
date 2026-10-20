/**
 * The bucket page's address: which tab is open and, on the Files tab, which folder, search, file type and
 * session filter, and which file's drawer is open. All of it lives in the query string
 * (`?tab=&path=&q=&type=&show=&file=`), so the Back button, a shared link and a reload land where the person was.
 *
 * Pure functions: the page and the Files tab read the state with `parseFilesTabState` (and the open file with
 * `readOpenFile`) and write a change with `withFilesTabState` (the other parameters of the address are kept as
 * they are). Defaults are left out of the address (`show=all`, an empty search...), so the plain URL of a bucket
 * stays short.
 */

import { FILE_KINDS, type FileKind } from '../shared/fileKind';
import { normalizePrefix, type SessionFileFilter } from './fileBrowse';

export const BUCKET_TABS = ['files', 'settings', 'api'] as const;
export type BucketTab = (typeof BUCKET_TABS)[number];

/** The page used to have Overview / Files / Usage tabs: their names still open the tab that took their place. */
const TAB_ALIASES: Readonly<Record<string, BucketTab>> = { overview: 'settings', usage: 'api' };

/** The tab an address asks for; the Files tab when it names none (or one that does not exist). */
export function resolveBucketTab(raw: string | null | undefined): BucketTab {
  const value = (raw ?? '').trim().toLowerCase();
  if ((BUCKET_TABS as readonly string[]).includes(value)) return value as BucketTab;
  return TAB_ALIASES[value] ?? 'files';
}

/** What the Files tab shows. */
export interface FilesTabState {
  /** The folder: `''` is the bucket root, otherwise no leading slash and one trailing slash. */
  path: string;
  /** The name search; a search lists matches under `path` flat. */
  q: string;
  /** Only files of this kind; like a search, it lists flat. */
  type: FileKind | null;
  /** Session files, the others, or both. */
  show: SessionFileFilter;
}

export const DEFAULT_FILES_TAB_STATE: FilesTabState = { path: '', q: '', type: null, show: 'all' };

/** The longest search the address carries. */
export const MAX_SEARCH_LENGTH = 200;

/** Anything that reads parameters by name (`URLSearchParams`, Next's read-only variant). */
export interface ParamReader {
  get(name: string): string | null;
}

/** A folder path from the address; a path that climbs out of the bucket (`.` / `..` segments) is the root. */
function readPath(raw: string | null): string {
  const path = normalizePrefix(raw);
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  return path;
}

/** The Files tab's state as an address carries it. A value that means nothing is the default. */
export function parseFilesTabState(params: ParamReader | null | undefined): FilesTabState {
  if (!params) return { ...DEFAULT_FILES_TAB_STATE };
  const type = (params.get('type') ?? '').trim().toLowerCase();
  const show = (params.get('show') ?? '').trim().toLowerCase();
  return {
    path: readPath(params.get('path')),
    q: (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    type: (FILE_KINDS as readonly string[]).includes(type) ? (type as FileKind) : null,
    show: show === 'session' || show === 'other' ? show : 'all',
  };
}

/**
 * The key of the file whose drawer the address asks to open (`?file=<key>`), or `null`. The key is the file's
 * whole key, folders included; it is not checked against anything here: a key that names no file opens the
 * drawer on its "no longer exists" message.
 */
export function readOpenFile(params: ParamReader | null | undefined): string | null {
  const key = (params?.get('file') ?? '').trim();
  return key === '' ? null : key;
}

/**
 * A change to the address: the Files tab's state, the tab, and the file whose drawer is open (`null` closes it).
 * A key that is left out stays as it is.
 */
export type BucketUrlPatch = Partial<FilesTabState> & { tab?: BucketTab; file?: string | null };

function setOrDelete(params: URLSearchParams, name: string, value: string | null | undefined): void {
  if (value) params.set(name, value);
  else params.delete(name);
}

/**
 * The query string (without the `?`) after `patch` is applied to `current`. Parameters the page does not own
 * stay; a default value removes its parameter.
 */
export function withFilesTabState(current: { toString(): string } | null | undefined, patch: BucketUrlPatch): string {
  const params = new URLSearchParams(current ? current.toString() : '');
  // The Files tab is the default one: its address carries no `tab`.
  if (patch.tab !== undefined) {
    if (patch.tab === 'files') params.delete('tab');
    else params.set('tab', patch.tab);
  }
  if (patch.path !== undefined) setOrDelete(params, 'path', readPath(patch.path));
  if (patch.q !== undefined) setOrDelete(params, 'q', patch.q.trim().slice(0, MAX_SEARCH_LENGTH));
  if (patch.type !== undefined) setOrDelete(params, 'type', patch.type);
  if (patch.show !== undefined) setOrDelete(params, 'show', patch.show === 'all' ? null : patch.show);
  if (patch.file !== undefined) setOrDelete(params, 'file', patch.file?.trim());
  return params.toString();
}

/** `pathname` with a query string, or just `pathname` when there is none. */
export function hrefWithQuery(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}

/** True when the Files tab lists matches (a search or a type): flat, with no folder rows. */
export function isFlatListing(state: Pick<FilesTabState, 'q' | 'type'>): boolean {
  return Boolean(state.q || state.type);
}

/** True when anything narrows the listing beyond the folder itself. */
export function hasListingFilters(state: FilesTabState): boolean {
  return isFlatListing(state) || state.show !== 'all';
}
