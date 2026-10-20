/**
 * Why a file operation was refused, in a form the routes can answer with.
 *
 * The file service throws `FileServiceError` for every refusal that is the caller's or the configuration's to fix:
 * a missing or switched-off bucket, a provider that cannot take files, a file over the limit, a type that is not
 * accepted, a request that is not valid. `status` is the HTTP status the Document Store and the client API answer
 * with, `code` the stable word a client switches on, `message` a sentence that is safe to show.
 *
 * A failure of the storage itself (the provider's SDK, the network, an open circuit breaker) is not wrapped here:
 * the file circuit breaker and the retry rules read those errors as the drivers threw them. The routes turn them
 * into a status and a safe message in one place (`server/api/fileHttp.ts`); the background jobs, which have no
 * response to send, store `describeFailure(error)` on the record or the bucket instead.
 */

import { CircuitOpenError, RequestTimeoutError } from '@/lib/core/resilience';
import { isAzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import { isS3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { isStorageInvalidKeyError, isStorageObjectTooLargeError } from '@/lib/providers/contracts/storageLimits';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';

export type FileServiceErrorCode =
  | 'bucket_not_found'
  | 'file_not_found'
  | 'bucket_inactive'
  | 'bucket_deleting'
  | 'bucket_not_empty'
  | 'prefix_locked'
  | 'duplicate_key'
  | 'provider_missing'
  | 'provider_unassigned'
  | 'provider_inactive'
  | 'provider_invalid'
  | 'provider_mismatch'
  | 'markdown_unavailable'
  | 'conversion_unsupported'
  | 'conversion_too_large'
  | 'archive_too_large'
  | 'import_in_progress'
  | 'storage_location_shared'
  | 'object_too_large'
  | 'quota_exceeded'
  | 'queue_unavailable'
  | 'file_too_large'
  | 'content_type_not_allowed'
  | 'invalid_content_type'
  | 'invalid_request'
  | 'preview_unsupported';

export class FileServiceError extends Error {
  readonly code: FileServiceErrorCode;

  readonly status: number;

  /** More fields for the response body (a refusal's `reason`, say); never anything that is not safe to show. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: FileServiceErrorCode,
    status: number,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'FileServiceError';
    this.code = code;
    this.status = status;
    if (options?.details) this.details = options.details;
  }
}

/** Also true for a copy of this module loaded twice (a reset module registry), which `instanceof` would miss. */
export function isFileServiceError(error: unknown): error is FileServiceError {
  if (error instanceof FileServiceError) return true;
  return error instanceof Error
    && error.name === 'FileServiceError'
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { status?: unknown }).status === 'number';
}

/** A write to a switched-off bucket: the bucket keeps its files readable and takes nothing new. */
export function bucketInactiveError(): FileServiceError {
  return new FileServiceError('bucket_inactive', 409, 'File bucket is not active.');
}

/**
 * A change to a bucket whose files are being deleted: it only goes away, or is deleted again after a failure. A
 * deletion the queue lost (a restart) never ends by itself: removing the bucket with `force` (its files stay) is the
 * way out.
 */
export function bucketDeletingError(): FileServiceError {
  return new FileServiceError('bucket_deleting', 409, 'The bucket is being deleted.');
}

/** What a bucket refuses to do to a storage location that another bucket also keeps files in. */
export type SharedStorageAction = 'import' | 'delete';

const SHARED_STORAGE_MESSAGES: Readonly<Record<SharedStorageAction, string>> = {
  import: 'Another bucket uses this storage location, so objects in it cannot be imported.',
  delete: 'Another bucket uses this storage location. Delete the bucket without its files, or remove the other bucket first.',
};

/**
 * A location shared with another bucket cannot be imported from or emptied: what is in it is not all this bucket's.
 * The message says what to do instead.
 */
export function storageLocationSharedError(action: SharedStorageAction): FileServiceError {
  return new FileServiceError('storage_location_shared', 409, SHARED_STORAGE_MESSAGES[action]);
}

// ── Storage failures ─────────────────────────────────────────────────────────

export const GENERIC_STORAGE_MESSAGE = 'The storage provider request failed.';
export const STORAGE_UNAVAILABLE_MESSAGE = 'The storage provider is temporarily unavailable. Try again in a moment.';
export const STORAGE_TIMEOUT_MESSAGE = 'The storage provider did not answer in time. Try again in a moment.';

/** The wording of a driver that says "no such object" only in words. */
export const MISSING_WORDING = /\b(?:not found|does not exist)\b/i;

/** Codes a driver gives (or Node, for the local disk) when the object itself is not there. */
const OBJECT_MISSING_CODES = new Set(['object_missing', 'BlobNotFound', 'NoSuchKey', 'ENOENT']);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function statusOf(error: unknown): number | undefined {
  const carrier = error as { statusCode?: unknown; status?: unknown } | null;
  const status = carrier?.statusCode ?? carrier?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * The driver's typed signal that the object is not in the provider. A missing container or bucket has codes of its
 * own and is not this: it is a provider that is set up wrongly, whatever its message says.
 */
export function hasObjectMissingCode(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && OBJECT_MISSING_CODES.has(code);
}

/** The object the call asked for is not in the provider: by the driver's typed signal, or a 404 that says so. */
export function isObjectMissingError(error: unknown): boolean {
  return hasObjectMissingCode(error) || (statusOf(error) === 404 && MISSING_WORDING.test(messageOf(error)));
}

/** An open circuit breaker. */
export function isCircuitOpenError(error: unknown): boolean {
  return error instanceof CircuitOpenError || (error as { name?: unknown } | null)?.name === 'CircuitOpenError';
}

/** A call that did not answer in time. */
export function isRequestTimeoutError(error: unknown): boolean {
  return error instanceof RequestTimeoutError || (error as { name?: unknown } | null)?.name === 'RequestTimeoutError';
}

/**
 * The store refuses the key itself - it is empty, longer than the store allows, or text it cannot write - whichever
 * driver says so: the typed refusal of S3 (`invalid_key`), of Azure (`InvalidFileKey`) and of the local-disk and
 * GridFS drivers. It is the caller's key to change, not a failure of the store.
 */
export function isInvalidKeyError(error: unknown): error is Error {
  if (isStorageInvalidKeyError(error)) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return (isS3OperationError(error) && code === 'invalid_key') || (isAzureBlobError(error) && code === 'InvalidFileKey');
}

/**
 * A failure the S3, Azure, local-disk or GridFS driver has put into words for people, or a provider setting or
 * endpoint the console refuses: its message is written to be shown (no keys, no raw XML, no server paths).
 */
export function isCuratedStorageError(error: unknown): error is Error {
  return isS3OperationError(error)
    || isAzureBlobError(error)
    || isStorageObjectTooLargeError(error)
    || isStorageInvalidKeyError(error)
    || error instanceof ProviderSettingsError
    || error instanceof ProviderEndpointError;
}

/**
 * A sentence about a failed file operation that is safe to keep on a record or a bucket and show later: a refusal
 * of the service and the drivers' curated messages as they are, a fixed sentence for an outage or a timeout, and
 * the generic one for anything else (an SDK error can carry a request URL, a file-system path or a header; the
 * caller logs those in full).
 */
export function describeFailure(error: unknown): string {
  if (isFileServiceError(error)) return error.message;
  if (isCircuitOpenError(error)) return STORAGE_UNAVAILABLE_MESSAGE;
  if (isRequestTimeoutError(error)) return STORAGE_TIMEOUT_MESSAGE;
  if (isObjectMissingError(error)) return 'The file is missing from the storage provider.';
  if (isCuratedStorageError(error)) return error.message;
  return GENERIC_STORAGE_MESSAGE;
}
