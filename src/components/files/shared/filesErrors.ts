/**
 * The sentence a failed Files call is shown as. A code that means one fixed thing gets a translated message
 * (`FILES_ERROR_CODE_KEYS`); a refusal that carries details of its own (a quota, the agents that keep a bucket in use,
 * a limit, the form field a provider setting is wrong in, a storage driver's own explanation) shows the server's words
 * (`FILES_ERROR_CODES_IN_SERVER_WORDS`); a lost connection and a missing item are told in the viewer's language, and so
 * is a missing permission, unless the refusal gives a reason of its own (a file of somebody else's session), which is
 * shown. Every code in `FILES_ERROR_CODES` is in exactly one of the two lists (tested), so a code the server adds cannot
 * be forgotten silently.
 */

import { isFilesApiError, type FilesApiError, type FilesErrorCode } from '../filesApi';

/** A translator bound to `useTranslations('files.common')`. */
export type FilesTranslator = (key: string, values?: Record<string, string | number | undefined | null>) => string;

/** The `files.common` key of each error `code` that has a fixed message. */
export const FILES_ERROR_CODE_KEYS: Readonly<Record<string, string>> = {
  bucket_not_found: 'errors.bucketNotFound',
  file_not_found: 'errors.fileNotFound',
  bucket_inactive: 'errors.bucketInactive',
  bucket_deleting: 'errors.bucketDeleting',
  bucket_not_empty: 'errors.bucketNotEmpty',
  prefix_locked: 'errors.prefixLocked',
  duplicate_key: 'errors.duplicateKey',
  provider_missing: 'errors.providerMissing',
  provider_unassigned: 'errors.providerUnassigned',
  provider_inactive: 'errors.providerInactive',
  provider_invalid: 'errors.providerInvalid',
  markdown_unavailable: 'errors.markdownUnavailable',
  conversion_unsupported: 'errors.conversionUnsupported',
  archive_too_large: 'errors.archiveTooLarge',
  import_in_progress: 'errors.importInProgress',
  storage_location_shared: 'errors.storageLocationShared',
  object_too_large: 'errors.objectTooLarge',
  queue_unavailable: 'errors.queueUnavailable',
  file_too_large: 'errors.fileTooLarge',
  invalid_content_type: 'errors.invalidContentType',
  preview_unsupported: 'errors.previewUnsupported',
  storage_unavailable: 'errors.storageUnavailable',
  storage_timeout: 'errors.storageTimeout',
  internal_error: 'errors.generic',
  // Raised by filesApi itself: an answer that could not be read, a local file the browser could not read.
  invalid_response: 'errors.generic',
  read_failed: 'errors.readFailed',
};

/**
 * The codes whose sentence is the server's own, because it says more than the code does: the agents that keep a
 * bucket in use, the content type an upload was refused for, the rule a request broke (`invalid_request`), the figures
 * of a quota or a size limit, what a storage driver reported in words fit to show, and the form field of a provider
 * setting the console refuses.
 */
export const FILES_ERROR_CODES_IN_SERVER_WORDS: readonly FilesErrorCode[] = [
  'bucket_in_use',
  'content_type_not_allowed',
  'invalid_request',
  'provider_mismatch',
  'quota_exceeded',
  'conversion_too_large',
  'storage_failure',
  'provider_settings_invalid',
  'provider_endpoint_not_allowed',
];

/** Where a failed call was made, for the codes whose sentence depends on it. */
export type FilesErrorContext = 'providerTest' | 'importFromStorage' | 'deleteBucket';

/**
 * The `files.common` key of a code in the place it was met, where that place has its own sentence: another bucket
 * using the storage location means "cannot be imported" in the import dialog and "cannot be deleted with its files,
 * delete the bucket without them or the other bucket first" in the delete dialog. Both are the server's sentences
 * (tested against `storageLocationSharedError`), in the viewer's language.
 */
export const FILES_CONTEXT_ERROR_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  importFromStorage: { storage_location_shared: 'errors.storageLocationSharedImport' },
  deleteBucket: { storage_location_shared: 'errors.storageLocationSharedDelete' },
};

/** The gates' own refusal ("Forbidden", "Forbidden: files requires write permission"): it says no more than the viewer's language does. */
const GATE_REFUSAL = /^forbidden\b/i;

/**
 * The reason a 403 gives in words of its own, or null. Some refusals say more than "no": a file of a session somebody
 * else started ("This session was started by someone else, and you are not allowed to view it."), a bucket that holds
 * such files ("... so it cannot be deleted with its files."). Those answers carry the sentence and no code to
 * translate it by, so the sentence is what is shown. It is read from the body of the answer, never from `message`,
 * which falls back to the status line when the body had none.
 */
function refusalSentence(error: FilesApiError): string | null {
  const body = error.payload;
  if (!body || typeof body !== 'object') return null;
  const { message, error: reason } = body as { message?: unknown; error?: unknown };
  const sentence = [message, reason].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
  return sentence && !GATE_REFUSAL.test(sentence) ? sentence : null;
}

/**
 * `context: 'providerTest'` words a 403 as "you need provider access to test" (testing a provider needs provider
 * access, which Files access alone does not give). Elsewhere a 403 shows the reason its answer states in words
 * (`refusalSentence`) and otherwise "you do not have permission". The other contexts word the codes in
 * `FILES_CONTEXT_ERROR_KEYS`.
 */
export function filesErrorMessage(error: unknown, t: FilesTranslator, context?: FilesErrorContext): string {
  if (!isFilesApiError(error)) return t('errors.generic');
  // A file too large to preview and a type that cannot be previewed are one code; the server says which in `reason`.
  if (error.code === 'preview_unsupported' && error.reason === 'too_large') return t('errors.previewTooLarge');
  const codeKey = error.code
    ? ((context ? FILES_CONTEXT_ERROR_KEYS[context]?.[error.code] : undefined) ?? FILES_ERROR_CODE_KEYS[error.code])
    : undefined;
  if (codeKey) return t(codeKey);
  if (error.status === 0) return t('errors.network');
  if (error.status === 403) {
    if (context === 'providerTest') return t('errors.providerAccess');
    return refusalSentence(error) ?? t('errors.forbidden');
  }
  if (error.status === 404) return t('errors.notFound');
  return error.message.trim() || t('errors.generic');
}
