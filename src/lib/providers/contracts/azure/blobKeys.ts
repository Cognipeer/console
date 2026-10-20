/**
 * Blob names: what a caller's key may be, how the provider's own prefix is built, and the small value
 * helpers the upload path needs. Pure functions, no SDK.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { invalidKeyError } from './blobErrors';

export const MAX_BLOB_NAME_LENGTH = 1024;
export const MAX_BLOB_PATH_SEGMENTS = 254;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when a path segment would be resolved or refused by the URL layer: `.`/`..`, control characters, lone surrogates. */
function isUnsafeSegment(segment: string): boolean {
  return segment === '.' || segment === '..' || CONTROL_CHARS.test(segment) || LONE_SURROGATE.test(segment);
}

/**
 * A caller-supplied key made safe to append to the tenant prefix.
 *
 * The SDK resolves `.` and `..` path segments when it builds the request URL, so `a/../b`
 * would not be stored under `a/` at all: a `..` that survived this function could climb out of
 * `<prefix>/<tenant>/<provider>/` into another tenant's blobs in the same container. Segments
 * `.` and `..` are therefore rejected outright (not rewritten), as are control characters and
 * lone surrogates (the SDK's URL encoder throws on them).
 */
export function sanitizeBlobKey(rawKey: string): string {
  if (typeof rawKey !== 'string') throw invalidKeyError();
  const normalized = rawKey.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || CONTROL_CHARS.test(normalized) || LONE_SURROGATE.test(normalized)) throw invalidKeyError();
  for (const segment of normalized.split('/')) {
    if (segment === '.' || segment === '..') throw invalidKeyError();
  }
  return normalized;
}

/**
 * The prefix of a listing. A trailing slash is kept (one of them): `docs/` asks for the folder, `docs` for
 * every name that starts with those letters, and the caller said which.
 */
export function sanitizeListPrefix(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return '';
  const key = sanitizeBlobKey(raw);
  return /[\\/]$/.test(raw.trim()) ? `${key}/` : key;
}

/** `<prefix>/<tenantId>/<providerKey>/`, every part checked like a key. Empty parts are skipped. */
export function buildBasePrefix(parts: ReadonlyArray<string | undefined>): string {
  const segments: string[] = [];
  for (const part of parts) {
    const trimmed = part?.trim();
    if (!trimmed) continue;
    for (const segment of trimmed.replace(/\\/g, '/').split('/')) {
      const clean = segment.trim();
      if (!clean) continue;
      if (isUnsafeSegment(clean)) {
        throw new ProviderSettingsError('prefix', 'The prefix must not contain "." or ".." segments or control characters.');
      }
      segments.push(clean);
    }
  }
  return segments.length > 0 ? `${segments.join('/')}/` : '';
}

/** The service limits on a blob name: 1024 characters, 254 path segments. */
export function assertBlobNameLimits(blobName: string): string {
  if (blobName.length > MAX_BLOB_NAME_LENGTH || blobName.split('/').length > MAX_BLOB_PATH_SEGMENTS) {
    throw invalidKeyError('the blob name would exceed 1024 characters or 254 path segments.');
  }
  return blobName;
}

/** Same shape as the other drivers: `<slug>-<timestamp>-<8 hex>.<ext>`. */
export function generateKey(fileName?: string): string {
  if (!fileName) return `${Date.now()}-${randomUUID()}`;
  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const slug = (baseName.length > 0 ? baseName : 'file').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  return `${slug}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

/**
 * A value Node will put in a header: printable ASCII only. A CR/LF or a non-ASCII character makes
 * the request throw before it is sent, so an odd content type is dropped (the blob is stored as
 * `application/octet-stream`) instead of failing the upload.
 */
export function asciiHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 255 && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : undefined;
}

export function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** List responses carry an unquoted ETag, property reads a quoted one; callers compare them. */
export function quoteEtag(etag: string | undefined): string | undefined {
  if (!etag) return undefined;
  return etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"`;
}
