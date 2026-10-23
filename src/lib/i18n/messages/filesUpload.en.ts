/**
 * Document Store "Upload files" screen: drop zone, queue, destination, Markdown option, summary.
 * Registered in `en.ts` as `files.upload`; shared wording (file types, health, API
 * errors, copy) is in `filesCommon.en.ts`.
 *
 * Every key needs a twin in `filesUpload.tr.ts` (typed `typeof filesUploadEn`, so a
 * missing or extra key fails tsc) and its Turkish must differ from the English:
 * `agent-files-ui.test.ts` checks both for the whole `files` namespace.
 */
export const filesUploadEn = {
  title: 'Upload files',
  sections: {
    files: 'Files',
    filesHelp: 'Add the files to upload. You can rename a file until it is sent.',
    destination: 'Destination',
    destinationHelp: 'Where in the bucket the files are stored.',
    processing: 'Processing',
    processingHelp: 'What happens to the files once they are stored.',
  },
  drop: {
    title: 'Drop files here',
    release: 'Release to add the files',
    or: 'or',
    browse: 'Browse files',
    inputLabel: 'Choose files to upload',
    limitSize: 'Up to {size} per file',
    limitCount: 'up to {count} files at once',
    anyType: 'any file type',
    allowedTypes: 'allowed types: {types}',
    moreTypes: '+{count} more',
    storageLeft: '{size} of storage left',
    checking: 'Checking the upload limits…',
    limitsFailed: 'The upload limits could not be loaded. The server checks each file when it arrives.',
  },
  notices: {
    overflow: 'Not added: {count}. At most {max} files can be queued at once.',
    folders: 'Skipped folders: {count}. Folders cannot be uploaded; add the files inside them instead.',
    duplicates: 'Already in the list: {count}.',
  },
  blocked: {
    disabled: 'This bucket is disabled, so files cannot be uploaded. Enable the bucket first.',
  },
  queue: {
    label: 'Files to upload',
    empty: 'No files added yet.',
    nameLabel: 'Name of {file}',
    remove: 'Remove {file}',
    retry: 'Retry',
    retryFile: 'Retry uploading {file}',
    progressLabel: 'Upload progress of {file}',
    savedAs: 'Saved as {key}',
    storedAs: 'Stored as {key}',
  },
  status: {
    ready: 'Ready',
    waiting: 'Waiting…',
    uploading: 'Uploading · {percent}%',
    saving: 'Saving…',
    done: 'Uploaded',
    failed: 'Failed: {message}',
    tooLarge: 'Too large (limit {limit})',
    typeNotAllowed: 'Type not allowed ({type})',
    nameRequired: 'Enter a file name',
    nameSlash: 'The name cannot contain “/”; use the folder field for folders',
    contentTypeInvalid: 'Not a valid content type',
  },
  destination: {
    folderLabel: 'Folder',
    folderPlaceholder: 'Bucket root',
    folderHint: 'Leave empty for the bucket root. Use / to nest folders, for example reports/2026.',
    root: 'bucket root',
    unique: 'Each file gets a unique suffix, so nothing is overwritten. The name you give is kept for display and download.',
    errors: {
      dotSegments: 'A folder cannot contain “.” or “..”.',
      controlChars: 'A folder cannot contain control characters.',
      tooLong: 'The folder path is too long (at most {max} characters).',
    },
  },
  processing: {
    convert: 'Convert to Markdown',
    convertHint:
      'Works for PDF, Word, PowerPoint (.pptx), Excel, HTML and text files such as CSV and JSON. Other files, such as images, are stored without a Markdown copy. A Markdown copy is stored next to the file it is made from; the original is never changed.',
    background:
      'Conversion runs in the background after the upload. Its status shows in the file list and in the file details, where a failed conversion can be retried.',
    advanced: 'Advanced',
    contentType: 'Content type',
    contentTypeHint: 'Only for a single file. Leave empty to use the type the browser detected.',
  },
  summary: {
    upload: 'Upload',
    files: 'Files',
    filesSome: '{total} ({ready} can upload)',
    totalSize: 'Total size',
    destination: 'Destination',
    markdown: 'Markdown copy',
    on: 'On',
    off: 'Off',
    preflight: 'Pre-flight',
    storageWarning: '{size} to upload, but the project has {left} of storage left. The server refuses what does not fit.',
    filesWarning: '{count} to upload, but the project’s file limit has room for {left}. The server refuses what does not fit.',
  },
  checks: {
    selected: 'Files selected',
    folder: 'Destination folder is valid',
    sizeOk: 'Every file is within the size limit',
    sizeOver: 'Over the size limit: {count}',
    typesOk: 'Every file has an allowed type',
    typesOver: 'Type not allowed: {count}',
    namesOver: 'Name or content type to fix: {count}',
  },
  footer: {
    ready: '{ready} of {total} ready',
    uploaded: '{done} of {total} uploaded',
  },
  actions: {
    upload: 'Upload',
    uploadOne: 'Upload 1 file',
    uploadMany: 'Upload {count} files',
    uploading: 'Uploading…',
    done: 'Done',
    cancel: 'Cancel',
    close: 'Close',
  },
  confirm: {
    title: 'Stop uploading?',
    message: 'Some files are still uploading. If you close now, those uploads are cancelled. Files that already finished stay in the bucket.',
    stop: 'Cancel uploads and close',
    keep: 'Keep uploading',
  },
};
