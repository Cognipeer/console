/**
 * The sentence a failed Files call is shown as. A code that means one fixed thing gets a translated message;
 * a refusal that carries its own details (a quota, the agents that keep a bucket in use) shows the server's
 * words; a lost connection, a missing permission and a missing item are told in the viewer's language.
 */

import { isFilesApiError } from '../filesApi';

/** A translator bound to `useTranslations('files.common')`. */
export type FilesTranslator = (key: string, values?: Record<string, string | number | undefined | null>) => string;

/** The `files.common` key of each error `code` that has a fixed message. */
export const FILES_ERROR_CODE_KEYS: Readonly<Record<string, string>> = {
  bucket_not_found: 'errors.bucketNotFound',
  bucket_inactive: 'errors.bucketInactive',
  provider_inactive: 'errors.providerInactive',
  prefix_locked: 'errors.prefixLocked',
  file_too_large: 'errors.fileTooLarge',
  archive_too_large: 'errors.archiveTooLarge',
  preview_unsupported: 'errors.previewUnsupported',
  conversion_unsupported: 'errors.conversionUnsupported',
  storage_location_shared: 'errors.storageLocationShared',
  object_too_large: 'errors.objectTooLarge',
  // Raised by filesApi itself: an answer that could not be read, a local file the browser could not read.
  invalid_response: 'errors.generic',
  read_failed: 'errors.readFailed',
};

/** Where a failed call was made, for the codes whose sentence depends on it. */
export type FilesErrorContext = 'providerTest' | 'importFromStorage' | 'deleteBucket';

/**
 * The `files.common` key of a code in the place it was met, where that place has its own sentence: another bucket
 * using the storage location means "cannot be imported" in the import dialog and "cannot be deleted with its files"
 * in the delete dialog.
 */
export const FILES_CONTEXT_ERROR_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  importFromStorage: { storage_location_shared: 'errors.storageLocationSharedImport' },
  deleteBucket: { storage_location_shared: 'errors.storageLocationSharedDelete' },
};

/**
 * `context: 'providerTest'` words a 403 as "you need provider access to test" (testing a provider needs provider
 * access, which Files access alone does not give). The other contexts word the codes in `FILES_CONTEXT_ERROR_KEYS`.
 */
export function filesErrorMessage(error: unknown, t: FilesTranslator, context?: FilesErrorContext): string {
  if (!isFilesApiError(error)) return t('errors.generic');
  const codeKey = error.code
    ? ((context ? FILES_CONTEXT_ERROR_KEYS[context]?.[error.code] : undefined) ?? FILES_ERROR_CODE_KEYS[error.code])
    : undefined;
  if (codeKey) return t(codeKey);
  if (error.status === 0) return t('errors.network');
  if (error.status === 403) return t(context === 'providerTest' ? 'errors.providerAccess' : 'errors.forbidden');
  if (error.status === 404) return t('errors.notFound');
  return error.message.trim() || t('errors.generic');
}
