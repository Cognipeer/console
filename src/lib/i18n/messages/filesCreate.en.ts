/**
 * Document Store "Create bucket" screen: provider cards, name and key, prefix, storage location, status.
 * Registered in `en.ts` as `files.create`; shared wording (file types, health, API
 * errors, copy) is in `filesCommon.en.ts`.
 *
 * Every key needs a twin in `filesCreate.tr.ts` (typed `typeof filesCreateEn`, so a
 * missing or extra key fails tsc) and its Turkish must differ from the English:
 * `agent-files-ui.test.ts` checks both for the whole `files` namespace.
 */
export const filesCreateEn = {
  title: 'Create bucket',
  subtitle: 'Document Store',
  // "· optional" after the label of a field that may stay empty.
  optional: 'optional',
  provider: {
    title: 'Storage provider',
    description: 'Choose where the files of this bucket are kept. Only providers that are switched on can be chosen.',
    groupLabel: 'Storage provider',
    localDisk: 'Files stay on this server’s disk, not shared across replicas.',
    notActive: 'This provider is not active, so a bucket cannot be created on it.',
    add: 'Add a file provider',
    refresh: 'Refresh providers',
    retry: 'Retry',
    askAdmin: 'Ask an administrator to add a file provider.',
    noneTitle: 'No file provider yet',
    noneDescription:
      'A bucket stores its files on a provider: S3, an S3-compatible store, Azure Blob, MongoDB GridFS or this server’s disk.',
    noneUsable: 'None of these providers can take a bucket right now. Switch one on in the Providers area, or add another.',
    noneUsableAskAdmin: 'None of these providers can take a bucket right now. Ask an administrator to switch one on.',
    loadFailedTitle: 'Couldn’t load the providers',
    localWarningTitle: 'Files stay on this server’s disk',
    localWarning:
      'They are not shared between replicas, so a deployment with more than one replica will not see all of them. Choose an object store for files that several servers need.',
  },
  bucket: {
    title: 'Bucket',
    description: 'How the bucket is named in the console, the API and the SDK.',
    nameLabel: 'Name',
    namePlaceholder: 'Marketing assets',
    keyLabel: 'Key',
    keyPlaceholder: 'marketing-assets',
    keyHint: 'Made from the name, and yours to edit. Lowercase letters, numbers, hyphens and underscores. It cannot be changed later.',
    descriptionLabel: 'Description',
    descriptionPlaceholder: 'What is kept here, and for whom',
  },
  location: {
    title: 'Location',
    description: 'Where inside the provider the files of this bucket are kept.',
    prefixLabel: 'Prefix inside the provider',
    prefixHint: 'Left empty, the key is used. It cannot be changed once the bucket has files.',
    previewTitle: 'Files will be stored at',
    // The place of a file's own name at the end of the example path.
    fileKey: '<file key>',
    choose: 'Choose a provider to see where the files will be stored.',
    unknown: 'This provider does not say where it keeps files.',
  },
  status: {
    title: 'Status',
    description: 'A disabled bucket keeps its files readable and accepts nothing new.',
    activeLabel: 'Active',
    activeDescription: 'Let this bucket take uploads. Turn it off to create the bucket disabled.',
  },
  summary: {
    bucketTitle: 'This bucket',
    provider: 'Provider',
    key: 'Key',
    prefix: 'Prefix path',
    status: 'Status',
    readyTitle: 'Ready to create',
    providerChosen: 'Storage provider chosen',
    nameAndKey: 'Name and key',
    prefixValid: 'Prefix is valid',
    ready: '{done} of {total} ready',
  },
  actions: {
    create: 'Create bucket',
  },
  errors: {
    title: 'Couldn’t create the bucket',
    generic: 'The bucket could not be created. Try again.',
    nameRequired: 'Give the bucket a name.',
    nameTooLong: 'The name can have at most {max} characters.',
    descriptionTooLong: 'The description can have at most {max} characters.',
    keyRequired: 'The bucket needs a key.',
    keyInvalid: 'Use lowercase letters, numbers, hyphens and underscores only.',
    keyTooLong: 'The key can have at most {max} characters.',
    keyTaken: 'A bucket with the key “{key}” already exists. Choose another key.',
    prefixInvalid: 'A prefix cannot contain “..”, backslashes or control characters.',
    prefixTooLong: 'The prefix can have at most {max} characters.',
    providerRequired: 'Choose a storage provider.',
    providerUnusable: 'This provider can no longer take a bucket. Choose another one.',
  },
  success: {
    title: 'Bucket created',
    message: '{name} is ready for files.',
  },
};
