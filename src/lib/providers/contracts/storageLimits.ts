import { getConfig } from '@/lib/core/config';

const MIB = 1024 * 1024;

/**
 * Ceiling for buffering one stored object in memory: twice the upload limit, at least 100 MiB.
 *
 * The storage drivers hand a download back as one Buffer, so an object that is far larger than anything the
 * console accepts (a file put there by another tool, or a provider pointed at a shared bucket) must not be read
 * to the end. Twice the configured upload limit leaves room for the Markdown copy and for objects uploaded
 * before the limit was lowered; the floor keeps small limits from refusing ordinary files.
 *
 * It is the default for every `downloadFile` call. A caller that reads objects the upload limit never applied to
 * states its own bound with `downloadFile(key, { maxBytes })` (see `resolveDownloadCeiling`).
 */
export function maxStorageDownloadBytes(): number {
  const uploadMaxBytes = Math.max(1, getConfig().limits.fileUploadMaxMb) * MIB;
  return Math.max(2 * uploadMaxBytes, 100 * MIB);
}

/**
 * A stored object is larger than the server reads into memory at once (`maxStorageDownloadBytes`). The local-disk and
 * GridFS drivers throw it before they read; its message is written for people and is safe to show. Not retryable:
 * asking again reads the same object.
 */
export class StorageObjectTooLargeError extends Error {
  readonly code = 'object_too_large';

  readonly retryable = false;

  constructor(limitBytes: number = maxStorageDownloadBytes()) {
    super(`The object is larger than the ${Math.round(limitBytes / MIB)} MB this server reads into memory at once.`);
    this.name = 'StorageObjectTooLargeError';
  }
}

export function isStorageObjectTooLargeError(error: unknown): error is StorageObjectTooLargeError {
  return error instanceof StorageObjectTooLargeError
    || ((error as { name?: unknown } | null)?.name === 'StorageObjectTooLargeError'
      && (error as { code?: unknown }).code === 'object_too_large');
}

/** A UTF-16 surrogate with no partner: text that has no UTF-8 form, so no store or file system can keep it under that name. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

/**
 * A key the store cannot take: empty, or text that has no UTF-8 form. The local-disk and GridFS drivers throw it before
 * they touch the store (S3 and Azure have typed errors of their own for the same refusal: `invalid_key` and
 * `InvalidFileKey`). Its message is written for people. Not retryable, and no sign that the store is unwell: asking again
 * fails the same way, so it must not count towards opening the circuit breaker of the provider.
 */
export class StorageInvalidKeyError extends Error {
  readonly code = 'invalid_key';

  readonly statusCode = 400;

  readonly retryable = false;

  constructor(detail?: string) {
    super(detail ? `Invalid file key provided: ${detail}` : 'Invalid file key provided.');
    this.name = 'StorageInvalidKeyError';
  }
}

export function isStorageInvalidKeyError(error: unknown): error is StorageInvalidKeyError {
  return error instanceof StorageInvalidKeyError
    || ((error as { name?: unknown } | null)?.name === 'StorageInvalidKeyError'
      && (error as { code?: unknown }).code === 'invalid_key');
}
