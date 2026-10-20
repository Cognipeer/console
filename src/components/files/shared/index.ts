/**
 * The pieces every Files screen shares. Import from here (or from the file) rather than rebuilding them:
 * the chips, the icon, the formatters and the error wording are what keep the screens consistent.
 */

export { default as BucketStatusBadge, type BucketStatusBadgeProps } from './BucketStatusBadge';
export {
  BUCKET_DESCRIPTION_MAX,
  BUCKET_NAME_MAX,
  BUCKET_PREFIX_MAX,
  bucketDescriptionFault,
  bucketNameFault,
  bucketPrefixFault,
  normalizeBucketPrefix,
  type BucketDescriptionFault,
  type BucketNameFault,
  type BucketPrefixFault,
} from './bucketRules';
export { default as CopyButton, type CopyButtonProps } from './CopyButton';
export { FileKindChip, FileKindIcon, useFileKindLabels, type FileKindChipProps, type FileKindIconProps } from './FileKindIcon';
export {
  FILE_KINDS,
  PREVIEW_MAX_BYTES,
  canPreviewMarkdown,
  fileKindOf,
  hasMarkdownCopy,
  markdownFileName,
  previewKindOf,
  type FileKind,
  type FileLike,
  type PreviewKind,
} from './fileKind';
export {
  FILES_CONTEXT_ERROR_KEYS,
  FILES_ERROR_CODE_KEYS,
  FILES_ERROR_CODES_IN_SERVER_WORDS,
  filesErrorMessage,
  type FilesErrorContext,
  type FilesTranslator,
} from './filesErrors';
export { formatBytes, formatCount } from './format';
export { DELETE_STALLED_AFTER_MS, MARKDOWN_STALLED_AFTER_MS, isQuietFor, timeOf } from './jobClock';
export { providerHref } from './links';
export { default as MarkdownStatusBadge, type MarkdownStatusBadgeProps } from './MarkdownStatusBadge';
export { default as ProviderHealthChip, type ProviderHealthChipProps } from './ProviderHealthChip';
export { default as ReadOnlyHint, type ReadOnlyHintProps } from './ReadOnlyHint';
export { default as RelativeTime, type RelativeTimeProps } from './RelativeTime';
export { saveBlob } from './saveBlob';
export { default as StorageLocation, type StorageLocationProps } from './StorageLocation';
export { useNow } from './useNow';
