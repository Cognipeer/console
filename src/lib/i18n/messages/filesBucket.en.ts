/**
 * Document Store bucket page: header and the Files, Settings and API tabs. `en.ts` keeps the two refusal titles the bucket list uses next to this module.
 * Registered in `en.ts` as `files.bucket`; shared wording (file types, health, API
 * errors, copy) is in `filesCommon.en.ts`.
 *
 * Every key needs a twin in `filesBucket.tr.ts` (typed `typeof filesBucketEn`, so a
 * missing or extra key fails tsc) and its Turkish must differ from the English:
 * `agent-files-ui.test.ts` checks both for the whole `files` namespace.
 *
 * There is no plural machinery: a sentence that changes with a number is a `…One` / `…Many`
 * pair, and the screen picks. The "API" tab label reads the same in every language and is drawn
 * as it is, so it is not a key.
 */
export const filesBucketEn = {
  header: {
    back: 'Back to Document Store',
    statsOne: '1 file · {size}',
    statsMany: '{count} files · {size}',
  },
  tabs: {
    files: 'Files',
    settings: 'Settings',
  },
  actions: {
    refresh: 'Refresh',
    upload: 'Upload',
    more: 'More actions',
    enable: 'Enable',
    disable: 'Disable',
    // Opens the import dialog (a bucket filled from outside the console lists nothing until it is imported).
    import: 'Import from storage…',
    // Opens the delete dialog, where the choice about the files is made.
    delete: 'Delete bucket…',
    enabled: '{name} accepts uploads again.',
    disabledDone: '{name} keeps its files readable and accepts nothing new.',
    kept: '{name} is kept and switched on again.',
  },
  banner: {
    disabled:
      'This bucket is disabled. Its files can still be browsed and downloaded, but files cannot be uploaded, imported or deleted until you enable it.',
    enable: 'Enable bucket',
    deleting: 'This bucket is being deleted. Its files are being removed from the storage provider, so nothing can be changed until that finishes.',
    // The deletion has been quiet for so long that the background run was probably lost (the server restarted).
    deletingStalled:
      'The deletion has not finished for a while. If the server was restarted since, the background run may have been lost. Delete again to continue where it stopped; files already removed stay removed.',
    deleteAgain: 'Delete again',
    // The last "delete with its files" run stopped before the bucket was gone; the reason is shown under the title.
    deleteFailedTitle: 'Deleting this bucket did not finish',
    deleteFailedHint: 'Files that were already removed stay removed. Try again once the cause is fixed, or keep the bucket.',
    deleteRetry: 'Try again',
    keep: 'Keep the bucket',
  },
  toolbar: {
    search: 'Search files by name…',
    typeLabel: 'Filter by file type',
    // {folder} is the folder being searched (or "Bucket root"): a search or a type filter looks into every sub-folder.
    flatHint: 'Matches from {folder} and its sub-folders are shown as one list.',
  },
  columns: {
    name: 'Name',
    size: 'Size',
    type: 'Type',
    markdown: 'Markdown copy',
    modified: 'Modified',
    actions: 'Actions',
    selectAll: 'Select all files in this list',
  },
  row: {
    select: 'Select {name}',
    // The name of a row's menu button: it says which file the menu is for.
    menuFor: 'Actions for {name}',
    downloadOriginal: 'Download original',
    downloadMarkdown: 'Download Markdown',
    copyKey: 'Copy key',
    delete: 'Delete…',
    keyCopied: 'Key copied',
    copyFailed: 'The key could not be copied to the clipboard.',
  },
  bulk: {
    label: 'Actions for the selected files',
    selected: '{count} selected',
    download: 'Download as .zip',
    downloadLimit: 'Up to {max} files can be downloaded together. Select fewer files.',
    delete: 'Delete…',
    clear: 'Clear selection',
  },
  empty: {
    noMatches: 'No files match',
    noMatchesHint: 'No file matches the current search and filters. Change them or clear the filters.',
    clearFilters: 'Clear filters',
    uploadHere: 'Upload here',
  },
  emptyBucket: {
    title: 'This bucket has no files yet',
    hint: 'Upload files to start, or import the objects that are already in the storage provider.',
    hintReadOnly: 'Files uploaded to this bucket will appear here.',
    upload: 'Upload files',
    import: 'Import from storage…',
  },
  error: {
    title: 'The files could not be loaded',
    retry: 'Retry',
  },
  footer: {
    showingOne: 'Showing 1 file',
    showingMany: 'Showing {count} files',
    loadMore: 'Load more',
  },
  errors: {
    downloadFailed: 'The download failed',
  },
  state: {
    loading: 'Loading the bucket…',
    notFoundTitle: 'Bucket not found',
    notFoundBody: 'This bucket does not exist or was deleted.',
    errorTitle: 'The bucket could not be loaded',
    retry: 'Retry',
    backToList: 'Back to Document Store',
  },
  general: {
    title: 'General',
    description: 'The name and description people see, and whether the bucket accepts changes.',
    name: 'Name',
    nameRequired: 'Enter a name for the bucket.',
    nameTooLong: 'The name can have at most {max} characters.',
    descriptionLabel: 'Description',
    descriptionTooLong: 'The description can have at most {max} characters.',
    status: 'Status',
    statusActive: 'Active',
    statusActiveHint: 'The bucket accepts uploads and imports.',
    statusDisabled: 'Disabled',
    statusDisabledHint: 'Files stay readable and downloadable, but nothing new is accepted.',
    save: 'Save changes',
    saved: 'Bucket saved',
  },
  storage: {
    title: 'Storage',
    description: 'Where this bucket keeps its files. The provider itself is managed in Providers.',
    provider: 'Provider',
    providerMissing: 'The provider of this bucket is not available.',
    openProvider: 'Open provider',
    testNow: 'Test now',
    testOk: 'The connection works ({latency})',
    testFailed: 'The connection test failed',
    testNone: 'The test did not return a result.',
    prefix: 'Prefix inside the provider',
    prefixPlaceholder: 'for example team/documents',
    prefixRoot: 'The root of the storage (no prefix)',
    prefixHint:
      'The files of this bucket are stored under this prefix. An empty prefix stores them at the root. It can be changed until the bucket has files.',
    prefixLocked: 'The prefix is fixed because this bucket has files; changing it would leave them behind in the old location.',
    prefixSave: 'Save prefix',
    prefixSaved: 'Prefix saved',
    prefixDots: 'A prefix cannot contain “..” or use “.” as a folder name.',
    prefixControl: 'A prefix cannot contain backslashes or control characters.',
    prefixTooLong: 'The prefix can have at most {max} characters.',
    location: 'Location in the storage',
    key: 'Bucket key',
    copyKey: 'Copy the bucket key',
  },
  usage: {
    title: 'Usage',
    description: 'What this bucket holds, and how much of the project’s limits is used.',
    files: 'Files',
    stored: 'Stored size',
    maxFile: 'Maximum file size',
    projectStorage: 'Project storage',
    projectFiles: 'Project files',
    of: '{used} of {limit}',
    noStorageLimit: 'No storage limit is set for this project.',
    noFilesLimit: 'No file-count limit is set for this project.',
    limitsFailed: 'The project limits could not be loaded: {reason}',
    retry: 'Retry',
  },
  danger: {
    title: 'Danger zone',
    descriptionEmpty: 'This bucket has no files. Deleting it removes the bucket only, and cannot be undone.',
    descriptionOne: 'This bucket holds 1 file in {provider}. When you delete the bucket you choose whether the file is deleted too. This cannot be undone.',
    descriptionMany:
      'This bucket holds {count} files in {provider}. When you delete the bucket you choose whether the files are deleted too. This cannot be undone.',
    button: 'Delete bucket…',
    buttonAgain: 'Delete again…',
    usedBy: 'This bucket cannot be deleted while these agents keep their session files in it:',
    chooseAnother: 'Open each agent’s Files settings and choose another bucket, then delete this one.',
    inProgress: 'This bucket is being deleted. Its files are being removed from the storage provider.',
    stalled:
      'The deletion has not finished for a while; the background run may have been lost. Delete again to continue where it stopped.',
    lastFailed: 'The last attempt to delete this bucket failed: {reason}',
  },
  // Deleting the bucket (the dialog opened from the header menu and from the danger zone).
  delete: {
    title: 'Delete bucket',
    question: 'Delete the bucket “{name}”?',
    noFiles: 'The bucket is empty, so only the bucket itself is removed. This cannot be undone.',
    filesIntroOne: 'This bucket holds 1 file, stored in {provider}. Choose what happens to it.',
    filesIntroMany: 'This bucket holds {count} files, stored in {provider}. Choose what happens to them.',
    // The numbers said the bucket was empty and the server found files: there is no count to name.
    filesIntroSome: 'This bucket holds files, stored in {provider}. Choose what happens to them.',
    choiceLabel: 'What happens to the files',
    withFilesOne: 'Delete the bucket and its file',
    withFilesMany: 'Delete the bucket and its {count} files',
    withFilesSome: 'Delete the bucket and its files',
    withFilesNoteOne: 'The file is removed from {provider} in the background. This cannot be undone.',
    withFilesNoteMany: 'The files are removed from {provider} in the background. This cannot be undone.',
    bucketOnly: 'Delete the bucket only',
    bucketOnlyNoteOne: 'The file stays in {provider} and keeps counting toward the project’s storage.',
    bucketOnlyNoteMany: 'The files stay in {provider} and keep counting toward the project’s storage.',
    previousFailure: 'The last attempt to delete this bucket with its files stopped: {reason}',
    previousFailureHint: 'Files that were already removed stay removed.',
    blockedOne: 'An agent keeps its session files in this bucket, so it cannot be deleted yet.',
    blockedMany: '{count} agents keep their session files in this bucket, so it cannot be deleted yet.',
    agentsLabel: 'Agents using this bucket',
    blockedHint: 'Open each agent’s Files settings, choose another bucket for its session files, then come back and delete this one.',
    alreadyDeleting: 'This bucket is already being deleted. Its files are removed in the background and the bucket disappears when that is done.',
    stalled:
      'The deletion has not finished for a while. If the server was restarted since, the background run may have been lost. Deleting again continues where it stopped; files already removed stay removed.',
    deleteAgain: 'Delete again',
    cancel: 'Cancel',
    confirm: 'Delete bucket',
    close: 'Close',
    deleted: 'Bucket “{name}” deleted',
    deletedKeepingFiles: 'Bucket “{name}” deleted. Its files stay in {provider}.',
    started: 'Deleting “{name}”. Its files are being removed in the background.',
    errors: {
      notEmpty: 'The bucket now contains files. Choose what happens to them, or cancel.',
    },
  },
  // Deleting files (the dialog opened from a row's menu and from the bulk bar).
  deleteFiles: {
    titleOne: 'Delete file',
    titleMany: 'Delete files',
    questionOne: 'Delete “{name}”?',
    questionMany: 'Delete {count} files?',
    consequence: 'The files are removed from the storage provider together with their Markdown copies. This cannot be undone.',
    progress: 'Deleting… {done} of {total}',
    cancel: 'Cancel',
    confirm: 'Delete',
    close: 'Close',
    doneOne: 'File deleted',
    doneMany: '{count} files deleted',
    partial: '{deleted} deleted, {failed} could not be deleted.',
    noneOne: 'The file could not be deleted.',
    noneMany: 'None of the {count} files could be deleted.',
    failedList: 'Files that were not deleted',
    more: '…and {count} more',
  },
  // "Import from storage": registers the objects that already sit in the provider as files.
  import: {
    title: 'Import from storage',
    intro:
      'Register the objects that already sit in the storage provider under this bucket’s location as files. Use it when the storage was filled from outside the console.',
    scansLabel: 'Location that will be scanned',
    safe: 'Nothing in the storage is changed or deleted. Objects that already have a file record are skipped.',
    markdownNote: 'Imported files come without a Markdown copy. Convert them from the file’s details when you need one.',
    start: 'Start import',
    cancel: 'Cancel',
    running: 'Scanning the storage…',
    scanned: 'Scanned',
    imported: 'Imported',
    skipped: 'Skipped',
    stop: 'Stop',
    stopped: 'The import was stopped. You can continue where it left off.',
    resume: 'Continue',
    failedTitle: 'The import stopped with an error',
    retry: 'Retry',
    doneImported: 'Import finished. Files added: {count}.',
    doneNothing: 'Import finished. Nothing new was found: every object already has a file record.',
    close: 'Close',
  },
  // The API tab: how to reach this bucket from code.
  api: {
    docs: 'Docs',
    languageLabel: 'Language',
    disabledNote: 'This bucket is disabled. Listing and downloading work, but uploads and deletes are refused until it is enabled.',
    // {operation} is the title of the call and {language} the language of the sample.
    sampleLabel: '{operation}, {language} sample',
    copySample: 'Copy the sample for “{operation}”',
    connect: {
      title: 'Connect from code',
      description: 'Use the client API to upload, list, download and delete this bucket’s files from your own code.',
      baseUrl: 'Base URL',
      copyBaseUrl: 'Copy the base URL',
      bucketKey: 'Bucket key',
      copyBucketKey: 'Copy the bucket key',
      auth: 'Authorization header',
      copyAuth: 'Copy the authorization header',
      authHint: 'Send an API token that may use the Document Store in this header.',
      createToken: 'Create a token',
    },
    examples: {
      title: 'Examples',
      description: 'Every call is filled in with this bucket’s key. Replace YOUR_API_TOKEN with a token of yours.',
    },
    requirements: {
      curl: 'Needs curl. The upload samples also use jq and base64.',
      typescript: 'Install the SDK with npm install @cognipeer/console-sdk. Needs Node.js 18 or later.',
      python: 'Uses the httpx package (pip install httpx).',
    },
    operations: {
      list: {
        title: 'List files',
        text: 'Returns up to 50 files per request. Pass the nextCursor of the answer as cursor to get the next page.',
      },
      listFolder: {
        title: 'List a folder',
        text: 'A prefix ending in a slash lists that folder: the files directly in it come back in files and its sub-folders in folders.',
      },
      upload: {
        title: 'Upload a file',
        text: 'Send the file as a base64 data URL in a JSON body. Keep the key from the answer: download and delete need it. Set convertToMarkdown to also store a Markdown copy.',
      },
      uploadToFolder: {
        title: 'Upload into a folder',
        text: 'A keyHint that ends in a slash puts the file in that folder. The file keeps a generated unique name inside it.',
      },
      download: {
        title: 'Download a file',
        text: 'Use the file’s key. It is one path segment, so its slashes are encoded. Add variant=markdown to get the Markdown copy.',
      },
      delete: {
        title: 'Delete a file',
        text: 'Deletes the file together with its Markdown copy. Use the file’s key.',
      },
    },
    keys: {
      title: 'File keys',
      // {example} is a key as the server generates it.
      description:
        'A file’s key is generated when it is uploaded (for example {example}), not built from the name you send. Read it from the answer of an upload or of a list call.',
      uploadAnswer: 'An upload answers with the stored file:',
      uploadAnswerLabel: 'Example answer of an upload',
      copyUploadAnswer: 'Copy the example answer of an upload',
      listAnswer: 'A list answers with files, folders and the cursor of the next page:',
      listAnswerLabel: 'Example answer of a list call',
      copyListAnswer: 'Copy the example answer of a list call',
    },
  },
};
