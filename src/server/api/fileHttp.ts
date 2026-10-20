/**
 * How the Document Store routes and the client Files API answer when a file operation fails, and the response
 * headers they share. One place, so a missing bucket, a switched-off bucket or a storage outage reads the same
 * on both surfaces.
 *
 * The service refuses with a `FileServiceError` (status, code, message). Everything else that can come out of a
 * file call is sorted here:
 *
 * - an open circuit breaker or a timeout: 503 / 504, with a fixed sentence (the breaker's own text names the
 *   tenant and provider);
 * - a missing object: 404 "File not found" - by the driver's typed signal (`object_missing`, `BlobNotFound`,
 *   `NoSuchKey`, `ENOENT`, a 404 status with a "not found" message), and as a last resort by the wording, for
 *   drivers that only say it in words;
 * - a key the store refuses (the driver's typed `invalid_key` / `InvalidFileKey`): 400 `invalid_request` with its
 *   message, which says what to change;
 * - a failure the S3 or Azure driver has put into words for people, or a provider setting or endpoint the
 *   console refuses: 502 with that message, which is written to be shown (no keys, no raw XML, no server paths);
 * - anything else from a call that talks to the provider: 502 with a generic sentence, the details only in the
 *   log (an SDK error can carry a request URL, a file-system path or a header).
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { createLogger } from '@/lib/core/logger';
import { fileTooLargeBody } from '@/lib/services/files/uploadLimits';
import {
  GENERIC_STORAGE_MESSAGE,
  MISSING_WORDING,
  STORAGE_TIMEOUT_MESSAGE,
  STORAGE_UNAVAILABLE_MESSAGE,
  isCircuitOpenError,
  isCuratedStorageError,
  isFileServiceError,
  isInvalidKeyError,
  isObjectMissingError,
  isRequestTimeoutError,
  type FileServiceErrorCode,
} from '@/lib/services/files/errors';
import { contentDisposition, type ContentDispositionType } from '@/lib/utils/contentDisposition';
import { isProviderConfigError } from './providerConfigErrors';

type Logger = ReturnType<typeof createLogger>;

export interface FileErrorAnswer {
  status: number;
  body: { error: string; code: string; [extra: string]: unknown };
  /** Nothing in this module recognised the error: log it in full. */
  unexpected: boolean;
}

/** What the answer says for the codes whose message the routes always worded the same way. */
const PUBLIC_MESSAGES: Partial<Record<FileServiceErrorCode, string>> = {
  bucket_not_found: 'Bucket not found',
  file_not_found: 'File not found',
};

/** Messages the file service threw as plain errors before it typed them: a service double or an older caller may still. */
const LEGACY_REFUSALS: ReadonlyArray<[message: string, code: FileServiceErrorCode, status: number]> = [
  ['File bucket not found.', 'bucket_not_found', 404],
  ['File record not found.', 'file_not_found', 404],
  ['File bucket is not active.', 'bucket_inactive', 409],
  ['File provider is not active.', 'provider_inactive', 409],
  ['Markdown conversion not available for this file.', 'markdown_unavailable', 409],
  ['Bucket contains files. Remove files or use force delete.', 'bucket_not_empty', 409],
];

// The wording of a storage failure (`GENERIC_STORAGE_MESSAGE` ...) and the signals that tell what went wrong
// (`isObjectMissingError` ...) are the file service's: the background jobs store the same sentences.
export { GENERIC_STORAGE_MESSAGE, STORAGE_TIMEOUT_MESSAGE, STORAGE_UNAVAILABLE_MESSAGE };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

function typed(code: FileServiceErrorCode, status: number, message: string, details?: Record<string, unknown>): FileErrorAnswer {
  return { status, body: { error: PUBLIC_MESSAGES[code] ?? message, code, ...details }, unexpected: false };
}

function storageFailure(status: number, code: string, message: string, extra?: Record<string, unknown>, unexpected = false): FileErrorAnswer {
  return { status, body: { error: message, code, ...extra }, unexpected };
}

export interface FileErrorOptions {
  /** The call talks to the storage provider: an error nobody recognises is then the provider's failure (502), not ours (500). */
  storage?: boolean;
  /** The route reads a JSON body: a `SyntaxError` is then a body that is not JSON (400). */
  body?: boolean;
}

/** The status and body a failed file call is answered with. */
export function describeFileError(error: unknown, options: FileErrorOptions = {}): FileErrorAnswer {
  if (isFileServiceError(error)) {
    return typed(error.code, error.status, error.message, error.details);
  }

  const legacy = LEGACY_REFUSALS.find(([message]) => messageOf(error) === message);
  if (legacy) return typed(legacy[1], legacy[2], legacy[0]);

  if (options.body && error instanceof SyntaxError) {
    return typed('invalid_request', 400, 'The request body must be valid JSON.');
  }

  if (isCircuitOpenError(error)) {
    return storageFailure(503, 'storage_unavailable', STORAGE_UNAVAILABLE_MESSAGE);
  }
  if (isRequestTimeoutError(error)) {
    return storageFailure(504, 'storage_timeout', STORAGE_TIMEOUT_MESSAGE);
  }

  if (isObjectMissingError(error)) {
    return typed('file_not_found', 404, 'File not found');
  }

  // A key the store refuses (too long for it, empty, text it cannot write) is the caller's to change, on every driver.
  if (isInvalidKeyError(error)) {
    return typed('invalid_request', 400, error.message);
  }

  // Failures worded for people.
  if (isProviderConfigError(error)) {
    return storageFailure(502, 'storage_failure', error.message, { field: error.field });
  }
  if (isCuratedStorageError(error)) {
    return storageFailure(502, 'storage_failure', error.message);
  }
  // A driver that says "not found" only in words.
  if (MISSING_WORDING.test(messageOf(error))) {
    return typed('file_not_found', 404, 'File not found');
  }

  return options.storage
    ? storageFailure(502, 'storage_failure', GENERIC_STORAGE_MESSAGE, undefined, true)
    : storageFailure(500, 'internal_error', 'Internal server error', undefined, true);
}

/**
 * Answers a failed file call and logs it: the details of an error nobody recognised, a line for an outage, and
 * nothing for a plain refusal (a missing bucket is not an incident).
 */
export function sendFileError(
  reply: FastifyReply,
  error: unknown,
  options: FileErrorOptions & { logger: Logger; action: string },
): FastifyReply {
  const answer = describeFileError(error, options);
  if (answer.unexpected) {
    options.logger.error(`File ${options.action} failed`, { error });
  } else if (answer.status >= 500) {
    options.logger.warn(`File ${options.action} failed`, { code: answer.body.code, error: messageOf(error) });
  }
  return reply.code(answer.status).send(answer.body);
}

/**
 * The `metadata` of an upload is a set of named values (an object), or absent. A text or a list would be stored as
 * something other than what was sent (a text as an object of its characters).
 */
export function isUploadMetadata(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value));
}

/**
 * `Content-Disposition` for a file name, and `X-Content-Type-Options: nosniff`: the bytes are served as the type
 * stored with them, and the browser is not left to guess a more active one. A file is for the caller who asked
 * for it: `Cache-Control: private, no-store` keeps a shared cache or a proxy from keeping the body (a stored key
 * keeps the extension of its file, which is what such caches go by), on every path that serves a file's bytes.
 */
export function setFileDownloadHeaders(reply: FastifyReply, fileName: string, type: ContentDispositionType = 'attachment'): void {
  reply.header('Content-Disposition', contentDisposition(fileName, type));
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cache-Control', 'private, no-store');
}

/**
 * The route-level error handler of an upload route: a request body over the route's limit is a file that is too
 * large, in the API's own words. Any other error is handed on to the server's handler, as if the route had none.
 */
export function uploadRouteErrorHandler(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
    return reply.code(413).send(fileTooLargeBody());
  }
  throw error;
}
