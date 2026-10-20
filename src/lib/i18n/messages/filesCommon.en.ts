/**
 * Document Store (Files): the wording every Files screen shares — file types,
 * Markdown conversion states, provider health, bucket status, where files are
 * stored, copy, the read-only hint and the messages of API errors. Kept in its
 * own file and registered in `en.ts` as `files.common`; the screens' own wording
 * lives in the sibling modules (`filesList`, `filesCreate`, `filesBucket`,
 * `filesUpload`, `filesDetail`).
 *
 * "PDF" is not a key: it reads the same in every language and is drawn as it is.
 */
export const filesCommonEn = {
  kind: {
    all: 'All types',
    image: 'Image',
    text: 'Text',
    office: 'Office document',
    other: 'Other',
  },
  markdown: {
    ready: 'Ready',
    pending: 'Converting…',
    failed: 'Failed',
    skipped: 'Not converted',
    failureTitle: 'The Markdown conversion failed',
    failureUnknown: 'No reason was recorded.',
  },
  health: {
    ok: 'Connected',
    failed: 'Test failed',
    untested: 'Not tested yet',
    builtin: 'Built-in',
    inactive: 'Disabled',
    builtinNote: 'No test needed',
    testedAt: 'Tested {when}',
    openProvider: 'Open provider',
    failedReason: 'The last connection test failed.',
    inactiveReason: 'This provider is disabled, so its buckets cannot be used.',
    untestedReason: 'The connection has not been tested yet.',
  },
  bucketStatus: {
    active: 'Active',
    disabled: 'Disabled',
    deleting: 'Deleting…',
    deleteFailed: 'Deletion failed',
  },
  storage: {
    thisServerDisk: 'This server’s disk',
    thisServerDiskHint: 'The files stay on this server and are not shared between replicas.',
    // The storage provider does not say where it keeps files (its settings name no bucket or container yet).
    unknown: 'Not known',
    unknownHint: 'The provider does not say where it keeps files yet. Check its settings.',
    copy: 'Copy storage location',
  },
  copy: {
    copy: 'Copy',
    copied: 'Copied',
  },
  readOnly: {
    hint: 'You have read-only access to the Document Store, so actions that change files are hidden.',
  },
  errors: {
    generic: 'Something went wrong. Try again.',
    network: 'The server could not be reached. Check your connection and try again.',
    forbidden: 'You do not have permission to do this.',
    notFound: 'This item no longer exists.',
    providerAccess: 'You need provider access to test this connection.',
    fileTooLarge: 'The file is larger than the upload limit.',
    archiveTooLarge: 'The selected files are too large to download together. Select fewer files.',
    previewUnsupported: 'No preview is available for this file type.',
    previewTooLarge: 'This file is too large to preview. Download it instead.',
    conversionUnsupported: 'This file type cannot be converted to Markdown.',
    markdownUnavailable: 'This file has no Markdown copy.',
    prefixLocked: 'The prefix cannot be changed while the bucket has files.',
    bucketInactive: 'This bucket is disabled. Enable it to make changes.',
    bucketDeleting: 'This bucket is being deleted, so it cannot be changed.',
    bucketNotEmpty: 'This bucket still holds files.',
    duplicateKey: 'A bucket with this key already exists.',
    providerInactive: 'The storage provider of this bucket is disabled.',
    providerMissing: 'The storage provider of this bucket no longer exists.',
    providerUnassigned: 'The storage provider of this bucket is not available to this project.',
    providerInvalid: 'The provider of this bucket is not a file storage provider.',
    bucketNotFound: 'This bucket does not exist or was deleted.',
    fileNotFound: 'This file no longer exists.',
    readFailed: 'The file could not be read. Check that it still exists and try again.',
    objectTooLarge: 'The file is larger than the server can read at once, so it cannot be downloaded or previewed.',
    invalidContentType: 'The file type of this upload is not valid.',
    importInProgress: 'An import is already running for this bucket. Wait for it to finish.',
    queueUnavailable: 'The background queue is not available. Try again in a moment.',
    storageUnavailable: 'The storage provider is temporarily unavailable. Try again in a moment.',
    storageTimeout: 'The storage provider did not answer in time. Try again in a moment.',
    // The two sentences below are the server's own, in the viewer's language.
    storageLocationShared: 'Another bucket uses this storage location.',
    storageLocationSharedImport: 'Another bucket uses this storage location, so objects in it cannot be imported.',
    storageLocationSharedDelete:
      'Another bucket uses this storage location. Delete the bucket without its files, or remove the other bucket first.',
  },
};
