/**
 * The file drawer's rules as pure functions: which preview a file gets, how its origin and checksum are worded,
 * how much text is drawn, and the API snippets printed for it. No React in here, so the rules are tested alone.
 */

import { clientApiRoutes } from '../filesApi';
import { previewKindOf, type PreviewKind } from '../shared/fileKind';

export type DetailTab = 'preview' | 'markdown' | 'details';

export const DETAIL_TABS: readonly DetailTab[] = ['preview', 'markdown', 'details'];

/** The most text the preview draws. A longer file is cut here; the download has all of it. */
export const PREVIEW_TEXT_CHARS = 200_000;

/**
 * Why the files of a bucket cannot be changed (`null`: they can). A disabled bucket keeps its files readable and
 * takes nothing new; one that a "delete with its files" job is working on is disabled as well, but enabling it
 * would not help, so the two are told apart.
 */
export type BucketLock = 'disabled' | 'deleting';

export function bucketLockOf(bucket: { status?: string; deleting?: boolean }): BucketLock | null {
  if (bucket.deleting === true) return 'deleting';
  return bucket.status === 'active' ? null : 'disabled';
}

/** The folder part of a key with its trailing slash (`reports/2026/q3.pdf` -> `reports/2026/`); `''` at the bucket root. */
export function folderOfKey(key: string): string {
  const slash = key.lastIndexOf('/');
  return slash < 0 ? '' : key.slice(0, slash + 1);
}

/** The last segment of a key: what the drawer is titled with until the record has loaded. */
export function baseNameOfKey(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1) || key;
}

/* ── Origin and checksum ─────────────────────────────────────────────────── */

export type FileOrigin = 'upload' | 'agent_output' | 'import';

/**
 * Where the file came from: `agent_output` (an agent wrote it to its sandbox), `import` (an object that was already
 * in the provider and was registered as a file afterwards). A record that names no origin, or one this screen does
 * not know yet, counts as an upload.
 */
export function originOf(record: { origin?: string | null }): FileOrigin {
  return record.origin === 'agent_output' || record.origin === 'import' ? record.origin : 'upload';
}

export type ChecksumKind = 'sha256' | 'other';

/** The local-disk and GridFS drivers store the SHA-256 as 64 hex digits; any other value is shown as a plain checksum. */
export function checksumKind(value: string): ChecksumKind {
  return /^[0-9a-f]{64}$/i.test(value.trim()) ? 'sha256' : 'other';
}

/* ── Preview ─────────────────────────────────────────────────────────────── */

export type PreviewPlan =
  | { kind: PreviewKind }
  /** `type`: the content type has no inline preview. `size`: it has one, but the file is over the preview limit. */
  | { kind: 'none'; reason: 'type' | 'size' };

export function previewPlanOf(file: { contentType?: string | null; size?: number | null }): PreviewPlan {
  const kind = previewKindOf(file);
  if (kind) return { kind };
  // `previewKindOf` answers "none" for a previewable type that is over the limit as well: tell the two apart.
  return previewKindOf({ contentType: file.contentType }) ? { kind: 'none', reason: 'size' } : { kind: 'none', reason: 'type' };
}

export interface CappedText {
  text: string;
  /** The length of the whole text. */
  total: number;
  truncated: boolean;
}

/** The first `max` characters of `text`, never cutting a surrogate pair in half. */
export function capText(text: string, max: number = PREVIEW_TEXT_CHARS): CappedText {
  if (text.length <= max) return { text, total: text.length, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), total: text.length, truncated: true };
}

/* ── API snippets ────────────────────────────────────────────────────────── */

function hexEscape(char: string): string {
  try {
    const encoded = encodeURIComponent(char);
    // `encodeURIComponent` leaves ! ' ( ) * as they are; a shell does not.
    return encoded === char ? `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}` : encoded;
  } catch {
    return '%EF%BF%BD';
  }
}

/**
 * The address made safe to paste between double quotes in a shell: everything but plain URL characters is
 * percent-encoded, so no character of a file key can end the quotes or start an expansion. The server reads the
 * percent-encoded address as the same one.
 */
export function shellSafeUrl(url: string): string {
  // The `u` flag makes a character outside the BMP (an emoji in a file name) one match, not two broken halves.
  return url.replace(/[^A-Za-z0-9\-._~:/?&=%@+,;#]/gu, hexEscape);
}

export type ApiSnippetId = 'download' | 'downloadMarkdown' | 'delete';

export interface ApiSnippet {
  id: ApiSnippetId;
  code: string;
}

const AUTH_HEADER = '-H "Authorization: Bearer YOUR_API_TOKEN"';

/**
 * The calls of the client API for one file: download it (and its Markdown copy when it has one) and delete it.
 * Written with a placeholder token and a fixed output name, so nothing of the record but its key reaches the text.
 */
export function apiSnippets(origin: string, bucketKey: string, key: string, options: { markdown?: boolean } = {}): ApiSnippet[] {
  const base = origin.replace(/\/+$/, '');
  const address = (path: string) => `"${shellSafeUrl(`${base}${path}`)}"`;
  const snippets: ApiSnippet[] = [
    {
      id: 'download',
      code: `curl ${AUTH_HEADER} \\\n  ${address(clientApiRoutes.download(bucketKey, key))} \\\n  -o downloaded-file`,
    },
  ];
  if (options.markdown) {
    snippets.push({
      id: 'downloadMarkdown',
      code: `curl ${AUTH_HEADER} \\\n  ${address(clientApiRoutes.download(bucketKey, key, 'markdown'))} \\\n  -o downloaded-file.md`,
    });
  }
  snippets.push({
    id: 'delete',
    code: `curl -X DELETE ${AUTH_HEADER} \\\n  ${address(clientApiRoutes.object(bucketKey, key))}`,
  });
  return snippets;
}
