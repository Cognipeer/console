/**
 * The sentences of the Access tab and the permission editor, in one place.
 *
 * The knowledge base page is English throughout (deliberately, like its sibling components), so these are literal
 * strings. Keeping the longer ones together makes a later translation pass mechanical and gives the screens and their
 * tests one wording.
 */

export const ACCESS_TEXT = {
  /* Document permissions card */
  enforceLabel: 'Enforce document permissions',
  enforceDescription: 'When off, everyone who can open this knowledge engine reads every document, as today.',
  enforceOnTitle: 'Enforce document permissions?',
  enforceOnMessage:
    'Folders and documents with their own permissions become readable only by the people and groups they name. Everything else follows the default access below.',
  enforceOnConfirm: 'Turn on',
  enforceOffTitle: 'Stop enforcing document permissions?',
  enforceOffMessage:
    'Everyone who can open this knowledge engine reads every document again. The permissions stay stored and apply again when you turn this back on.',
  enforceOffConfirm: 'Turn off',
  bypassLabel: 'Admins of this knowledge engine read everything',
  bypassDescription:
    'Applies to search, answers, agent tools and downloads. Admins always see every document on the management screens.',
  bypassOffTitle: 'Remove the admin exception?',
  bypassOffMessage:
    'Admins of this knowledge engine will then read only what the permissions allow in search, answers, agent tools and downloads. They still see every document on the management screens.',
  bypassOffConfirm: 'Remove the exception',
  changeFailed: 'Could not change access control',

  /* Default access card */
  defaultAccessIntro: 'Folders and documents without their own permissions can be read by:',
  everyoneDefault: 'Everyone who can open this knowledge engine',
  defaultAccessLoadFailed: 'The default access could not be loaded.',

  /* Summary tiles */
  closedNoteBypassOn:
    'Only admins of this knowledge engine can read these, because the admin exception is on. The same goes for whatever inherits from them.',
  closedNoteBypassOff:
    'Nobody can read these, not even admins of this knowledge engine: the admin exception is off. The same goes for whatever inherits from them.',
  closedTruncated: 'The first 50 are shown.',
  summaryLoadFailed: 'The access summary could not be loaded.',

  /* Check access */
  checkIntro: 'Find out why a person can or cannot read a document.',
  checkAccessOff:
    'Access control is off for this knowledge engine, so everyone who can open it reads every document. What follows is what the permissions say once it is turned on.',
  checkPickDocument: 'Pick a document to see whether they can read it.',
  checkIdentityNeedsWorkspace:
    'Keys and directory matches are shown to Knowledge Engine admins of the whole workspace.',
  checkNoMatches: 'No connector directory knows this person.',

  /* Permissions from connectors card */
  connectorsNone: 'No connector brings permissions into this knowledge engine.',
  connectorsLoadFailed: 'The connectors could not be loaded.',

  /* Permission editor */
  accessOffNote:
    'Access control is off for this knowledge engine: these permissions are stored and apply once it is turned on in the Access tab.',
  syncedTitle: 'Synced from a connected source',
  syncedNote: 'These permissions mirror the source and change only there.',
  syncedSaveReason: 'These permissions mirror the source and change only there.',
  inheritHint: 'Saving this deletes its own list.',
  ownDescription:
    'Replaces what it inherits. Its subfolders and documents that inherit follow this list. Starts as a copy of the inherited list.',
  nobodyTitle: 'Nobody can read the documents here.',
  bypassOnSentence: 'Admins of this knowledge engine still can, because the admin exception is on.',
  bypassOffSentence: 'Not even admins of this knowledge engine: the admin exception is off.',
  emptyConfirmTitle: 'Save a list nobody is on?',
  emptyConfirmLabel: 'Save anyway',
  rootDefaultRow: 'Everyone who can open this knowledge engine (the default)',
  listFull: 'A list holds at most 1,000 entries.',
  notChanged: 'Nothing has changed yet.',
  loadingAcl: 'The permissions are still loading.',
  aclLoadFailed: 'The permissions could not be loaded.',
  saved: 'Permissions saved',
  saveFailed: 'Permissions were not saved',
  directoryNeedsWorkspace: 'Directory people need Knowledge Engine admin rights for the whole workspace.',
  noDirectories:
    'No connector directory exists yet. Directories arrive with a connector that brings permissions, or through the API.',
  emailInvalid: 'Enter an e-mail address such as name@example.com.',
  emailTaken: 'This address is already in the list.',
} as const;
