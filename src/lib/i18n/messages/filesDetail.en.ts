/**
 * Document Store file drawer: Preview, Markdown and Details tabs, actions, API snippets.
 * Registered in `en.ts` as `files.detail`; shared wording (file types, health, API
 * errors, copy) is in `filesCommon.en.ts`.
 *
 * Every key needs a twin in `filesDetail.tr.ts` (typed `typeof filesDetailEn`, so a
 * missing or extra key fails tsc) and its Turkish must differ from the English:
 * `agent-files-ui.test.ts` checks both for the whole `files` namespace. For that reason
 * "Markdown" (the name of the tab) is not a key: it reads the same in every language and
 * is drawn as it is, like "PDF".
 */
export const filesDetailEn = {
  tabs: {
    preview: 'Preview',
    details: 'Details',
  },
  meta: {
    root: 'Bucket root',
    added: 'Added {when}',
  },
  actions: {
    close: 'Close',
    download: 'Download',
    downloadMarkdown: 'Download Markdown',
    copyKey: 'Copy key',
    keyCopied: 'Key copied',
    delete: 'Delete…',
    dismiss: 'Dismiss',
  },
  state: {
    loading: 'Loading the file…',
    notFound: 'This file no longer exists. It may have been deleted.',
    retry: 'Try again',
  },
  // Why a file of this bucket cannot be changed from here (the bucket page's banner says it behind the drawer).
  locked: {
    disabled: 'This bucket is disabled, so its files can be viewed and downloaded but not deleted or converted. Enable the bucket to change them.',
    deleting: 'This bucket is being deleted, so nothing in it can be changed.',
  },
  preview: {
    loading: 'Loading the preview…',
    none: 'No preview for this type',
    noneHint: 'Download the file to open it.',
    tooLarge: 'This file is larger than {limit}, so it is not previewed. Download it to open it.',
    failed: 'The preview could not be loaded.',
    frameTitle: 'Preview of {name}',
    textLabel: 'Text of {name}',
    empty: 'This file is empty.',
    truncated: 'Showing the first {shown} of {total} characters. Download the file to read the rest.',
  },
  markdown: {
    loading: 'Loading the Markdown…',
    size: 'Markdown copy · {size}',
    pendingHint: 'The conversion runs in the background. This page updates by itself when it finishes.',
    noneHint: 'This file has no Markdown copy.',
    retry: 'Retry conversion',
    convert: 'Convert to Markdown',
    tooLarge: 'The Markdown copy is larger than {limit}, so it is not shown here. Download it instead.',
    empty: 'The Markdown copy is empty.',
    copy: 'Copy Markdown',
    textLabel: 'Markdown of {name}',
  },
  details: {
    name: 'Name',
    key: 'Key',
    copyKey: 'Copy key of {name}',
    size: 'Size',
    sizeExact: '{size} ({bytes} bytes)',
    contentType: 'Content type',
    checksum: 'Checksum',
    checksumSha256: 'Checksum (SHA-256)',
    copyChecksum: 'Copy checksum',
    notRecorded: 'Not recorded',
    origin: 'Origin',
    originUpload: 'Upload',
    originAgent: 'Agent output',
    originImport: 'Imported from storage',
    uploadedBy: 'Uploaded by',
    created: 'Created',
    updated: 'Updated',
  },
  api: {
    title: 'Use this file from the API',
    hint: 'Call these with an API token that has access to the Document Store. The key is a single part of the address, so its slashes are encoded.',
    download: 'Download the file',
    downloadMarkdown: 'Download the Markdown copy',
    delete: 'Delete the file',
    copy: 'Copy the snippet: {what}',
  },
  delete: {
    noun: 'file',
    withMarkdown: 'Its Markdown copy is deleted with it.',
    doneTitle: 'File deleted',
    doneMessage: '{name} has been removed',
  },
};
