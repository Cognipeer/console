/**
 * Platform file and vector providers: the marker, the read-only note and the pieces of the vector and files pages
 * that know about them. Registered in `en.ts` as `platformStorage`; the twin is `platformStorage.tr.ts`.
 */
export const platformStorageEn = {
  badge: 'Platform',
  note: 'Provided by the platform and counted against your plan storage. It cannot be edited, tested or deleted here.',
  vector: {
    storedSize: 'Stored size',
    storedSizeHint: 'An estimate of what the vectors of this index take. It counts against your plan storage.',
    alwaysCreate: 'An index on this provider is always created new. Attaching an existing index is not available.',
  },
  files: {
    providerHint: 'Files are kept by the platform and count against your plan storage.',
  },
};
