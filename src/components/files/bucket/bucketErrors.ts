/**
 * The words of a failed bucket call. A refusal that names the agents keeping session files in the bucket
 * (`bucket_in_use`) carries the server's own sentence and the agents; everything else is the shared wording
 * (`filesErrorMessage`), which also shows the reason of a 403 that gives one: a delete that asks for the files to go
 * too is refused when the bucket holds the files of sessions somebody else started and the caller may not manage, and
 * the server says so in a sentence of its own. `context` words the codes that read differently in one place, such as
 * the delete dialog's sentence for a storage location another bucket uses (`'deleteBucket'`).
 */

import { isFilesApiError } from '../filesApi';
import { filesErrorMessage, type FilesErrorContext, type FilesTranslator } from '../shared';
import { bucketRefusalMessage } from './fileBrowse';

export function bucketErrorMessage(error: unknown, tc: FilesTranslator, context?: FilesErrorContext): string {
  if (isFilesApiError(error) && error.code === 'bucket_in_use') return bucketRefusalMessage(error);
  return filesErrorMessage(error, tc, context);
}

/** The bucket is gone (the page was open while it was deleted, or the link is wrong). */
export function isBucketGone(error: unknown): boolean {
  return isFilesApiError(error) && (error.status === 404 || error.code === 'bucket_not_found');
}
