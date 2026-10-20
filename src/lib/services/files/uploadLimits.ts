/**
 * How large an upload may be, as the routes and the limits endpoint see it.
 *
 * A file travels as base64 inside a JSON body, so the request is a third larger than the file. The limit the
 * server accepts for the body is derived from the configured file limit (`FILE_UPLOAD_MAX_MB`) and not from the
 * server-wide body size, so a file at the limit gets through while a body far past it is refused before it is read.
 */

import { getConfig } from '@/lib/core/config';

const MIB = 1024 * 1024;

/** Room for the JSON around the data: file name, content type, metadata, key. */
export const UPLOAD_BODY_OVERHEAD_BYTES = 64 * 1024;

/** The configured upload limit in bytes (at least 1 MB). */
export function uploadMaxBytes(): number {
  return Math.max(1, getConfig().limits.fileUploadMaxMb) * MIB;
}

/** The configured upload limit in whole megabytes, as the messages quote it. */
export function uploadMaxMb(): number {
  return Math.max(1, getConfig().limits.fileUploadMaxMb);
}

/** The `bodyLimit` of an upload route: the file limit as base64, plus the JSON around it. */
export function uploadBodyLimit(): number {
  return Math.ceil(uploadMaxBytes() * (4 / 3)) + UPLOAD_BODY_OVERHEAD_BYTES;
}

/** The largest file a request body of `bodyLimit` bytes can carry once it is base64-encoded. */
export function fileBytesFitting(bodyLimit: number): number {
  return Math.max(0, Math.floor(((bodyLimit - UPLOAD_BODY_OVERHEAD_BYTES) * 3) / 4));
}

/** What the upload routes answer when the request body is past `uploadBodyLimit()`. */
export function fileTooLargeBody(): { error: string; code: 'file_too_large' } {
  return { error: `File is larger than the ${uploadMaxMb()} MB upload limit.`, code: 'file_too_large' };
}
