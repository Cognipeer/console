/**
 * What a bucket's key, name, description, prefix and status may be: the one set of rules the creation and the update
 * of a bucket both go through, so a value that is refused on one is refused on the other. A value that breaks a rule
 * is a `FileServiceError` (400 `invalid_request`) whose message names the field.
 *
 * It also names the two bucket `metadata` keys the file service keeps for itself while a bucket is deleted together
 * with its files (`deleting`, `deleteError`). They live in the metadata because the bucket has no column for them; a
 * caller can neither set nor erase them.
 */

import { bucketDeletingError, bucketInactiveError, FileServiceError } from './errors';

/** The longest key a bucket is created with; the create screen holds to the same limit. */
export const BUCKET_KEY_MAX_LENGTH = 64;
export const BUCKET_NAME_MAX_LENGTH = 120;
export const BUCKET_DESCRIPTION_MAX_LENGTH = 1000;
export const BUCKET_PREFIX_MAX_LENGTH = 200;

/** Set while the "delete the bucket with its files" job runs. */
export const BUCKET_DELETING_KEY = 'deleting';
/** What the last failed "delete the bucket with its files" run left behind, in a sentence fit to show. */
export const BUCKET_DELETE_ERROR_KEY = 'deleteError';

const RESERVED_METADATA_KEYS: ReadonlySet<string> = new Set([BUCKET_DELETING_KEY, BUCKET_DELETE_ERROR_KEY]);

export type BucketStatus = 'active' | 'disabled';

/** The bucket fields a caller may change, validated and normalised (only the ones the caller named). */
export interface BucketFieldsPatch {
  name?: string;
  description?: string;
  status?: BucketStatus;
  prefix?: string;
  metadata?: Record<string, unknown>;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
// A description may run over several lines.
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function invalid(message: string): FileServiceError {
  return new FileServiceError('invalid_request', 400, message);
}

/** What a key is made of: the letters, digits, hyphens and underscores the create screen has always let through. */
const BUCKET_KEY_PATTERN = /^[a-z0-9_-]+$/;

/**
 * The key a bucket is created with. It is the bucket's address in every route (`/files/buckets/<key>`) and the folder
 * its files go in when no prefix is given, so a key that cannot sit in one URL segment (a slash, a dot segment, a
 * percent sign, a blank) or that is longer than a route takes would make a bucket nothing can reach, change or delete.
 */
export function parseBucketKey(value: unknown): string {
  if (typeof value !== 'string') throw invalid('key must be text.');
  const key = value.trim();
  if (key.length === 0) throw invalid('key is required.');
  if (key.length > BUCKET_KEY_MAX_LENGTH) throw invalid(`key must be at most ${BUCKET_KEY_MAX_LENGTH} characters.`);
  if (!BUCKET_KEY_PATTERN.test(key)) throw invalid('key can only hold lowercase letters, digits, hyphens and underscores.');
  return key;
}

export function parseBucketName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('name must be text.');
  const name = value.trim();
  if (name.length === 0) throw invalid('name is required.');
  if (name.length > BUCKET_NAME_MAX_LENGTH) throw invalid(`name must be at most ${BUCKET_NAME_MAX_LENGTH} characters.`);
  if (CONTROL_CHARACTERS.test(name)) throw invalid('name cannot contain control characters.');
  return name;
}

/** `null` clears the description. */
export function parseBucketDescription(value: unknown): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw invalid('description must be text.');
  const description = value.trim();
  if (description.length > BUCKET_DESCRIPTION_MAX_LENGTH) {
    throw invalid(`description must be at most ${BUCKET_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  if (TEXT_CONTROL_CHARACTERS.test(description)) throw invalid('description cannot contain control characters.');
  return description;
}

export function parseBucketStatus(value: unknown): BucketStatus {
  if (value === 'active' || value === 'disabled') return value;
  throw invalid('status must be "active" or "disabled".');
}

/**
 * The folder a bucket's objects live in inside its provider, without the slashes around it. Empty = the provider's
 * own root. A folder name cannot climb out (`..`), be empty (`a//b`) or carry a character the drivers do not take
 * in a key.
 */
export function parseBucketPrefix(value: unknown): string {
  if (typeof value !== 'string') throw invalid('prefix must be text.');
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (prefix.length > BUCKET_PREFIX_MAX_LENGTH) {
    throw invalid(`prefix must be at most ${BUCKET_PREFIX_MAX_LENGTH} characters.`);
  }
  if (prefix === '') return '';
  if (CONTROL_CHARACTERS.test(prefix) || prefix.includes('\\')) {
    throw invalid('prefix cannot contain control characters or backslashes.');
  }
  const folders = prefix.split('/');
  if (folders.some((folder) => folder === '')) throw invalid('prefix cannot contain empty folder names ("//").');
  if (prefix.includes('..') || folders.some((folder) => folder === '.')) {
    throw invalid('prefix cannot contain "." or ".." in a folder name.');
  }
  return prefix;
}

/** The metadata without the keys the file service keeps for itself. */
export function withoutReservedBucketMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !RESERVED_METADATA_KEYS.has(key)));
}

/** Only the keys the file service keeps for itself. */
export function reservedBucketMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => RESERVED_METADATA_KEYS.has(key)));
}

export function parseBucketMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('metadata must be an object.');
  return withoutReservedBucketMetadata(value as Record<string, unknown>);
}

/** The fields of a PATCH body: only what the body names, each one validated. */
export function parseBucketPatch(body: Record<string, unknown>): BucketFieldsPatch {
  const patch: BucketFieldsPatch = {};
  if (body.name !== undefined) patch.name = parseBucketName(body.name);
  if (body.description !== undefined) patch.description = parseBucketDescription(body.description);
  if (body.status !== undefined) patch.status = parseBucketStatus(body.status);
  if (body.prefix !== undefined) patch.prefix = parseBucketPrefix(body.prefix);
  if (body.metadata !== undefined) patch.metadata = parseBucketMetadata(body.metadata);
  return patch;
}

type WithMetadata = { metadata?: Record<string, unknown> | null };

/** The "delete the bucket with its files" job is running. */
export function isBucketDeleting(bucket: WithMetadata): boolean {
  return bucket.metadata?.[BUCKET_DELETING_KEY] === true;
}

/**
 * Why a bucket no longer takes files, as the error a write to it is refused with: it is switched off
 * (`bucket_inactive`), or it is being deleted or gone (`bucket_deleting`). `null`: it takes files. `current` is the
 * bucket as it is stored now, `null` when it is gone - what a job asks after it wrote something, to find out whether
 * the bucket was closed while it did.
 */
export function bucketClosedError(current: (WithMetadata & { status: string }) | null | undefined): FileServiceError | null {
  if (current && current.status === 'active' && !isBucketDeleting(current)) return null;
  return current && !isBucketDeleting(current) ? bucketInactiveError() : bucketDeletingError();
}

/** Why the last "delete the bucket with its files" run stopped, when it did. */
export function bucketDeleteError(bucket: WithMetadata): string | undefined {
  const error = bucket.metadata?.[BUCKET_DELETE_ERROR_KEY];
  return typeof error === 'string' && error.length > 0 ? error : undefined;
}
