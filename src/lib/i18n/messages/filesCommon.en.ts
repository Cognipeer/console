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
  },
  storage: {
    thisServerDisk: 'This server’s disk',
    thisServerDiskHint: 'The files stay on this server and are not shared between replicas.',
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
    conversionUnsupported: 'This file type cannot be converted to Markdown.',
    prefixLocked: 'The prefix cannot be changed while the bucket has files.',
    bucketInactive: 'This bucket is disabled. Enable it to make changes.',
    providerInactive: 'The storage provider of this bucket is disabled.',
    bucketNotFound: 'This bucket does not exist or was deleted.',
    readFailed: 'The file could not be read. Check that it still exists and try again.',
    objectTooLarge: 'The file is larger than the server can read at once, so it cannot be downloaded or previewed.',
    storageLocationShared: 'Another bucket uses this storage location.',
    storageLocationSharedImport: 'Another bucket uses this storage location, so the objects in it cannot be imported.',
    storageLocationSharedDelete:
      'Another bucket uses this storage location, so this bucket cannot be deleted together with its files. Delete the other bucket first.',
  },
};
