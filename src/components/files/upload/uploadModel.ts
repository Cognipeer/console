/**
 * The "Upload files" screen as pure functions: the queue's rows and their rules, the folder a file goes to, the
 * key it will be stored under, what the limits say about it and the numbers of the summary panel. No React and
 * no browser objects beyond the `File` shape, so every rule is unit tested without a DOM.
 *
 * The server decides every one of these again when the file arrives (size, type, folder and name rules);
 * checking here only saves a round trip and lets the screen flag a file BEFORE anything is sent.
 */

import { isMimeAllowed } from '@/lib/services/agents/sessionFilesConfig';
import type { FileRecordView } from '@/lib/services/files';
import type { FilesLimits } from '../filesApi';

/** How many files are sent at the same time. */
export const UPLOAD_CONCURRENCY = 2;

/** How many files one batch can hold (rows that are not uploaded yet). */
export const MAX_QUEUE_FILES = 20;

/** The server refuses a folder path longer than this. */
export const FOLDER_MAX_LENGTH = 512;

/** What the browser reports for a file whose type it does not know; the upload sends it as is. */
export const UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

/* ── The queue ───────────────────────────────────────────────────────────── */

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

/** One row of the upload queue. */
export interface QueueItem {
  id: string;
  file: File;
  /** The name the file is stored under (shown and downloaded as); editable until the upload starts. */
  name: string;
  /** Overrides the type the browser detected; empty = use the detected one. Only offered for a single file. */
  contentType: string;
  status: UploadStatus;
  /** Handed to the scheduler and waiting for a free slot (`status` is still `queued`). */
  waiting: boolean;
  /** 0..1 while uploading. */
  progress: number;
  /** The ready sentence of a failure. */
  error?: string;
  /** The record the server created, once `done`. */
  record?: FileRecordView;
}

/** Two picks of the same file (same name, size and modification time) are one row. */
export function fileIdentity(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/** The type the upload sends: the override, else the browser's, else a generic one. */
export function effectiveContentType(item: Pick<QueueItem, 'file' | 'contentType'>): string {
  return item.contentType.trim() || item.file.type || UNKNOWN_CONTENT_TYPE;
}

/* ── The destination ─────────────────────────────────────────────────────── */

export type FolderProblem = 'dot_segments' | 'control_chars' | 'too_long';

export interface ParsedFolder {
  /** The folder as the upload takes it: `''` is the bucket root, otherwise no leading slash and one trailing slash. */
  folder: string;
  /** Why the server would refuse it, or null. */
  problem: FolderProblem | null;
}

/**
 * A folder the way the upload route reads it (`composeUploadKeyHint`): backslashes are slashes, repeated slashes
 * collapse, it may not climb (`.` or `..`), carry control characters or run past 512 characters.
 */
export function parseFolder(raw: string): ParsedFolder {
  const slashed = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  let problem: FolderProblem | null = null;
  if (slashed.length > FOLDER_MAX_LENGTH) problem = 'too_long';
  else if (slashed.split('/').some((segment) => segment === '.' || segment === '..')) problem = 'dot_segments';
  else if (Array.from(slashed).some((char) => char.charCodeAt(0) < 32)) problem = 'control_chars';
  const rooted = slashed.replace(/^\/+/, '');
  return { folder: rooted ? (rooted.endsWith('/') ? rooted : `${rooted}/`) : '', problem };
}

/* ── The key a file gets ─────────────────────────────────────────────────── */

function baseName(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Like `path.extname`: from the last dot to the end, nothing for a name without one. */
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/**
 * What the server makes of a file name when it builds the object key (`generateFileRelativeKey`): the path is
 * dropped, control characters and leading dots go, the rest is lower-cased and everything outside `a-z 0-9 - _`
 * becomes a dash. The key then carries a unique suffix (`-<time>-<id>`) between the two parts. A test compares
 * this with the server's own function, so a change there cannot slip by unnoticed.
 */
export function keyStem(fileName: string): { stem: string; extension: string } {
  const stripped = Array.from(baseName(fileName.trim()))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .replace(/^\.+/, '')
    .slice(0, 255);
  if (!stripped) return { stem: 'uploaded-file', extension: '' };
  const ext = extension(stripped);
  const base = stripped.slice(0, stripped.length - ext.length) || 'file';
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';
  return { stem, extension: ext };
}

/** The key a file will be stored under, with the unique suffix shown as an ellipsis: `reports/2026/q3-report-….pdf`. */
export function previewObjectKey(folder: string, fileName: string): string {
  const { stem, extension: ext } = keyStem(fileName);
  return `${folder}${stem}-…${ext}`;
}

/* ── What a file may be ──────────────────────────────────────────────────── */

export type FileIssue =
  | { kind: 'too_large'; limit: number }
  | { kind: 'type_not_allowed'; type: string }
  | { kind: 'name_required' }
  | { kind: 'name_slash' }
  | { kind: 'content_type_invalid' };

/** The shape the upload route accepts as a content type (`type/subtype`, parameters ignored). */
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

export function isValidContentType(value: string): boolean {
  return CONTENT_TYPE_PATTERN.test(value.split(';')[0]!.trim());
}

/**
 * Why a file cannot be sent as it stands, or null. Only a file that has not been stored is judged (queued or
 * failed): the limits arrive after the files may have been picked, so this is computed again on every render.
 */
export function fileIssue(
  item: Pick<QueueItem, 'file' | 'name' | 'contentType' | 'status'>,
  limits: FilesLimits | null | undefined,
): FileIssue | null {
  if (item.status !== 'queued' && item.status !== 'failed') return null;
  if (limits && item.file.size > limits.maxFileBytes) return { kind: 'too_large', limit: limits.maxFileBytes };
  const type = effectiveContentType(item);
  const allowed = limits?.allowedMimeTypes;
  if (allowed && allowed.length > 0 && !isMimeAllowed(type, allowed)) return { kind: 'type_not_allowed', type };
  if (!item.name.trim()) return { kind: 'name_required' };
  if (item.name.includes('/')) return { kind: 'name_slash' };
  if (item.contentType.trim() && !isValidContentType(item.contentType)) return { kind: 'content_type_invalid' };
  return null;
}

/* ── The summary ─────────────────────────────────────────────────────────── */

export interface QueueSummary {
  /** Every row, uploaded ones included. */
  total: number;
  uploading: number;
  done: number;
  failed: number;
  /** Rows waiting for a free slot (already handed to the scheduler). */
  waiting: number;
  /** What the primary action sends: queued or failed rows with no issue that are not scheduled yet. */
  readyIds: string[];
  readyBytes: number;
  tooLarge: number;
  typeNotAllowed: number;
  /** Rows whose name or content type is not usable. */
  nameProblems: number;
}

export function summarizeQueue(items: readonly QueueItem[], limits: FilesLimits | null | undefined): QueueSummary {
  const summary: QueueSummary = {
    total: items.length,
    uploading: 0,
    done: 0,
    failed: 0,
    waiting: 0,
    readyIds: [],
    readyBytes: 0,
    tooLarge: 0,
    typeNotAllowed: 0,
    nameProblems: 0,
  };
  for (const item of items) {
    if (item.status === 'uploading') summary.uploading += 1;
    if (item.status === 'done') summary.done += 1;
    if (item.status === 'failed') summary.failed += 1;
    if (item.waiting) {
      summary.waiting += 1;
      continue;
    }
    const issue = fileIssue(item, limits);
    if (!issue) {
      if (item.status === 'queued' || item.status === 'failed') {
        summary.readyIds.push(item.id);
        summary.readyBytes += item.file.size;
      }
      continue;
    }
    if (issue.kind === 'too_large') summary.tooLarge += 1;
    else if (issue.kind === 'type_not_allowed') summary.typeNotAllowed += 1;
    else summary.nameProblems += 1;
  }
  return summary;
}

/** Bytes still free in the project's storage; null when it is unlimited or unknown. */
export function storageLeft(limits: FilesLimits | null | undefined): number | null {
  if (!limits) return null;
  const { limitBytes, usedBytes } = limits.quota;
  return limitBytes === null ? null : Math.max(0, limitBytes - usedBytes);
}

export type QuotaWarning = { kind: 'storage'; left: number } | { kind: 'files'; left: number };

/**
 * Whether the files that are about to go would not fit in what the project has left. Only a warning: the
 * server counts the quota itself and refuses the file that does not fit.
 */
export function quotaWarning(
  limits: FilesLimits | null | undefined,
  bytes: number,
  count: number,
): QuotaWarning | null {
  if (!limits || count === 0) return null;
  const left = storageLeft(limits);
  if (left !== null && bytes > left) return { kind: 'storage', left };
  const filesLimit = limits.quota.filesLimit;
  if (filesLimit !== null) {
    const filesLeft = Math.max(0, filesLimit - limits.quota.filesUsed);
    if (count > filesLeft) return { kind: 'files', left: filesLeft };
  }
  return null;
}

/** The allowed types as a short list for the hint: the first few, how many were left out, and the whole list for a tooltip. */
export function summarizeTypes(allowed: readonly string[], max = 6): { shown: string; hidden: number; all: string } {
  const unique = Array.from(new Set(allowed.map((type) => type.trim()).filter(Boolean)));
  return { shown: unique.slice(0, max).join(', '), hidden: Math.max(0, unique.length - max), all: unique.join(', ') };
}

/* ── A drop ──────────────────────────────────────────────────────────────── */

export interface DroppedItemLike {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): { isDirectory: boolean } | null;
}

export interface DroppedLike {
  files: ArrayLike<File>;
  items?: ArrayLike<DroppedItemLike> | null;
}

/**
 * The files of a drop, and how many folders came with them. A dropped folder cannot be read as a file (the
 * read fails), so it is counted and left out. Must run inside the drop event: the browser empties the data
 * transfer afterwards.
 */
export function collectDropped(dropped: DroppedLike): { files: File[]; folders: number } {
  const items = dropped.items;
  if (items && items.length > 0) {
    const files: File[] = [];
    let folders = 0;
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        folders += 1;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    return { files, folders };
  }
  return { files: Array.from(dropped.files), folders: 0 };
}
