/**
 * Document Store bucket list page: tiles, filters, table, empty and error states.
 * Registered in `en.ts` as `files.list`; shared wording (file types, health, API
 * errors, copy) is in `filesCommon.en.ts`.
 *
 * Every key needs a twin in `filesList.tr.ts` (typed `typeof filesListEn`, so a
 * missing or extra key fails tsc) and its Turkish must differ from the English:
 * `agent-files-ui.test.ts` checks both for the whole `files` namespace.
 */
export const filesListEn = {
  eyebrow: 'Data · Files',
  title: 'Document Store',
  subtitle: 'Buckets that hold files for agents, knowledge sources and the API.',
  actions: {
    docs: 'Docs',
    create: 'Create bucket',
    // The name of a row's menu button: it says which bucket the menu is for.
    menuFor: 'Actions for {name}',
    open: 'Open bucket',
    settings: 'Bucket settings',
    enable: 'Enable',
    disable: 'Disable',
    // Opens the bucket's Settings tab, where the delete (and the choice about its files) is confirmed.
    delete: 'Delete bucket…',
    // For a bucket whose deletion stopped with an error, or whose background run seems lost: same place, same dialog.
    deleteAgain: 'Delete again…',
  },
  tiles: {
    buckets: 'Buckets',
    active: 'Active',
    disabled: 'Disabled',
    files: 'Stored files',
    filesSize: '{size} in all buckets',
  },
  filters: {
    search: 'Search buckets by name, key or description…',
    providerLabel: 'Filter by provider',
    allProviders: 'All providers',
    statusLabel: 'Filter by status',
    anyStatus: 'Any status',
    clear: 'Clear filters',
  },
  columns: {
    bucket: 'Bucket',
    provider: 'Provider',
    files: 'Files',
    size: 'Size',
    status: 'Status',
    updated: 'Updated',
    actions: 'Actions',
  },
  provider: {
    unavailable: 'Provider unavailable',
  },
  footer: 'Showing {shown} of {total} buckets',
  toggle: {
    enabledTitle: 'Bucket enabled',
    enabledMessage: '{name} accepts uploads again.',
    disabledTitle: 'Bucket disabled',
    disabledMessage: '{name} keeps its files readable and accepts nothing new.',
  },
  error: {
    title: 'Couldn’t load buckets',
    // {status} is the HTTP status the server answered with.
    status: 'The server answered {status}. Your buckets were not changed.',
    retry: 'Retry',
    refreshTitle: 'Couldn’t refresh the list',
    staleNote: 'Showing the buckets loaded before.',
  },
  empty: {
    title: 'No buckets yet',
    description: 'Create your first bucket to store files for agents, knowledge sources and the API.',
    filteredTitle: 'No bucket matches',
    filteredDescription: 'Nothing fits the search and filters you set. Change them, or clear them to see every bucket.',
  },
  noProvider: {
    title: 'No file provider yet',
    description:
      'A bucket stores its files on a provider: S3, an S3-compatible store, Azure Blob, MongoDB GridFS or this server’s disk. Add one first.',
    add: 'Add a file provider',
    askAdmin: 'Ask an administrator to add a file provider, then create your first bucket.',
  },
  noUsableProvider: {
    title: 'No file provider can take a bucket',
    description: 'Every file provider is switched off, so a bucket cannot be created. Switch one on, or add another.',
    manage: 'Manage file providers',
    askAdmin: 'Ask an administrator to switch on a file provider, then create your first bucket.',
  },
};
