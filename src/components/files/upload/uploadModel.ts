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
import type { FileLimits } from '../filesApi';

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

/** The longest name (the last segment) of a key the server generates, in UTF-8 bytes: `MAX_GENERATED_NAME_BYTES` there. */
const KEY_NAME_MAX_BYTES = 200;
/** The unique part of a key, `-<time in milliseconds: 13 digits>-<8 hex digits>`, in bytes. */
const KEY_UNIQUE_BYTES = 23;
/** The most of a file's extension a key keeps, in UTF-8 bytes: `MAX_KEY_EXTENSION_BYTES` there. */
const KEY_EXTENSION_MAX_BYTES = 32;

const encoder = new TextEncoder();

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** The extension a key keeps: no character without a UTF-8 form (a surrogate with no partner), cut between characters after 32 bytes. */
function keptExtension(text: string): string {
  let bytes = 0;
  let kept = '';
  for (const character of text) {
    if (character.length === 1 && character >= '\uD800' && character <= '\uDFFF') continue;
    const size = utf8Length(character);
    if (bytes + size > KEY_EXTENSION_MAX_BYTES) break;
    kept += character;
    bytes += size;
  }
  return kept;
}

/** Letters that do not decompose into a base letter and marks, spelled the way a reader would type them in ASCII. */
const ASCII_SPELLING: Record<string, string> = { ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th' };

/** Lower-case text with its accents dropped (`Şirket Özeti` -> `sirket ozeti`), as the server does for a key. */
function foldToAscii(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[ıßæœøłđðþ]/g, (char) => ASCII_SPELLING[char] ?? char);
}

/**
 * What the server makes of a file name when it builds the object key (`generateFileRelativeKey`): the path is
 * dropped, control characters and leading dots go, the rest is lower-cased with its accents dropped (`ş` becomes
 * `s`, `ı` becomes `i`) and everything outside `a-z 0-9 - _` becomes a dash. The key then carries a unique suffix (`-<time>-<id>`) between the two parts. The name of the key
 * is kept within what a store takes (200 bytes): the extension is cut after 32 bytes and the stem gives way, never
 * the unique part. A test compares this with the server's own function, so a change there cannot slip by unnoticed.
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
  const fullStem =
    foldToAscii(base)
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'file';
  const kept = keptExtension(ext);
  // The stem is ASCII, so a character is a byte.
  const room = KEY_NAME_MAX_BYTES - KEY_UNIQUE_BYTES - utf8Length(kept);
  const stem = fullStem.slice(0, room).replace(/-+$/, '') || 'file';
  return { stem, extension: kept };
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
  limits: FileLimits | null | undefined,
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
  /**
   * Every row that is fit to go, whatever has become of it since (waiting, uploading, stored, failed or not sent yet):
   * the run the person set up, which is what the summary describes. `readyIds` shrinks while a run is under way.
   */
  sendable: number;
  sendableBytes: number;
  tooLarge: number;
  typeNotAllowed: number;
  /** Rows whose name or content type is not usable. */
  nameProblems: number;
}

export function summarizeQueue(items: readonly QueueItem[], limits: FileLimits | null | undefined): QueueSummary {
  const summary: QueueSummary = {
    total: items.length,
    uploading: 0,
    done: 0,
    failed: 0,
    waiting: 0,
    readyIds: [],
    readyBytes: 0,
    sendable: 0,
    sendableBytes: 0,
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
      summary.sendable += 1;
      summary.sendableBytes += item.file.size;
      continue;
    }
    const issue = fileIssue(item, limits);
    if (!issue) {
      summary.sendable += 1;
      summary.sendableBytes += item.file.size;
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
export function storageLeft(limits: FileLimits | null | undefined): number | null {
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
  limits: FileLimits | null | undefined,
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
