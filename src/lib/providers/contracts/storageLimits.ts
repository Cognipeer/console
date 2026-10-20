import { getConfig } from '@/lib/core/config';

const MIB = 1024 * 1024;

/**
 * Ceiling for buffering one stored object in memory: twice the upload limit, at least 100 MiB.
 *
 * The storage drivers hand a download back as one Buffer, so an object that is far larger than anything the
 * console accepts (a file put there by another tool, or a provider pointed at a shared bucket) must not be read
 * to the end. Twice the configured upload limit leaves room for the Markdown copy and for objects uploaded
 * before the limit was lowered; the floor keeps small limits from refusing ordinary files.
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
