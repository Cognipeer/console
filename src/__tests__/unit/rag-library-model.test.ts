/**
 * The rules behind the Documents tab's library, without a DOM: which folders a place lists, where a folder can
 * move, what the Access column says, who gets which menu item, how a selection moves, and the tab the page opens.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FOLDER_NOT_EMPTY,
  TOP_LEVEL,
  accessCell,
  accessCellOf,
  childFolders,
  contentsLabel,
  displayPath,
  documentActions,
  folderActions,
  folderChain,
  folderChoices,
  folderNameProblem,
  folderParamOf,
  inBatches,
  knownPlace,
  libraryLine,
  libraryRows,
  locationLabel,
  movableItems,
  moveIsNoop,
  placeOf,
  plural,
  sharedPlace,
  withDescendants,
  type LibraryRow,
  type LibraryViewer,
} from '@/components/rag/library/libraryModel';
import { MoveFailedError, moveLibraryItems } from '@/components/rag/library/libraryActions';
import { isRagPageTab, parseRagPageTab, visibleRagPageTab } from '@/components/rag/library/pageTabs';
import {
  ALL_FOLDERS,
  ARCHIVE,
  HANDBOOK,
  LEAVE,
  LEAVE_DOC,
  ONBOARDING,
  POLICIES,
  SALARY,
  SITE,
  SITE_DOC,
  folder,
} from '../helpers/ragLibraryFixtures';

const ADMIN: LibraryViewer = { canWrite: true, canAdmin: true, canChangeStructure: true };
const WRITER: LibraryViewer = { canWrite: true, canAdmin: false, canChangeStructure: true };
const WRITER_ACCESS_ON: LibraryViewer = { canWrite: true, canAdmin: false, canChangeStructure: false };
const READER: LibraryViewer = { canWrite: false, canAdmin: false, canChangeStructure: false };

const ids = (items: Array<{ id: string }>) => items.map((item) => item.id);

describe('folders of a place', () => {
  it('lists the folders directly in a place by name, numbers in order', () => {
    const folders = [folder({ _id: 'a', name: 'Part 10' }), folder({ _id: 'b', name: 'part 2' }), folder({ _id: 'c', name: 'Beta' }), ...ALL_FOLDERS];
    expect(childFolders(folders, null).map((f) => f.name)).toEqual(['Archive', 'Beta', 'HR Site', 'Onboarding', 'part 2', 'Part 10', 'Policies']);
    expect(childFolders(ALL_FOLDERS, 'f-policies').map((f) => f.name)).toEqual(['Leave']);
    expect(childFolders(ALL_FOLDERS, 'f-leave')).toEqual([]);
  });

  it('walks the chain from the top level to a folder, and says so when the chain is broken', () => {
    expect(folderChain(ALL_FOLDERS, null)).toEqual([]);
    expect(folderChain(ALL_FOLDERS, 'f-leave')!.map((f) => f.name)).toEqual(['Policies', 'Leave']);
    expect(folderChain(ALL_FOLDERS, 'missing')).toBeNull();
    // A folder whose parent is not in the list (the viewer cannot see it), and a loop.
    expect(folderChain([folder({ _id: 'x', name: 'X', parentId: 'gone' })], 'x')).toBeNull();
    expect(folderChain([folder({ _id: 'a', name: 'A', parentId: 'b' }), folder({ _id: 'b', name: 'B', parentId: 'a' })], 'a')).toBeNull();
  });

  it('writes a path with spaces around the slashes, and says where a document sits', () => {
    expect(displayPath(LEAVE)).toBe('Policies / Leave');
    expect(displayPath(folder({ _id: 'z', name: 'Solo', path: '' }))).toBe('Solo');
    expect(locationLabel(ALL_FOLDERS, undefined)).toBe('Top level');
    expect(locationLabel(ALL_FOLDERS, 'f-leave')).toBe('Policies / Leave');
    expect(locationLabel(ALL_FOLDERS, 'not-listed')).toBe('—');
  });

  it('finds everything below some folders, the folders themselves included', () => {
    expect([...withDescendants(ALL_FOLDERS, ['f-policies'])].sort()).toEqual(['f-leave', 'f-policies']);
    expect([...withDescendants(ALL_FOLDERS, ['f-leave'])]).toEqual(['f-leave']);
    expect([...withDescendants(ALL_FOLDERS, [])]).toEqual([]);
  });
});

describe('the places a select offers', () => {
  it('puts the top level first and the folders by path', () => {
    const choices = folderChoices(ALL_FOLDERS);
    expect(choices[0]).toEqual({ value: TOP_LEVEL, label: 'Top level' });
    expect(choices.slice(1).map((c) => c.label)).toEqual(['Archive', 'HR Site', 'Onboarding', 'Policies', 'Policies / Leave']);
  });

  it('leaves out folders that are only a name to the viewer', () => {
    const folders = [folder({ _id: 'p', name: 'Policies', pathOnly: true }), folder({ _id: 't', name: 'Travel', parentId: 'p', path: 'Policies/Travel' })];
    expect(folderChoices(folders).map((c) => c.value)).toEqual([TOP_LEVEL, 't']);
  });

  it('leaves out moved folders with everything below them, and the folders a source owns when asked', () => {
    expect(folderChoices(ALL_FOLDERS, { exclude: ['f-policies'] }).map((c) => c.value)).toEqual([
      TOP_LEVEL, 'f-archive', 'f-site', 'f-onboarding',
    ]);
    expect(folderChoices(ALL_FOLDERS, { exclude: ['f-policies'], skipSynced: true }).map((c) => c.value)).toEqual([
      TOP_LEVEL, 'f-archive', 'f-onboarding',
    ]);
  });

  it('maps a select value to a folder id and falls back to the top level for a folder that is gone', () => {
    expect(placeOf(TOP_LEVEL)).toBeNull();
    expect(placeOf(null)).toBeNull();
    expect(placeOf('f-leave')).toBe('f-leave');
    expect(knownPlace(ALL_FOLDERS, 'f-leave')).toBe('f-leave');
    expect(knownPlace(ALL_FOLDERS, 'deleted')).toBeNull();
    expect(knownPlace([folder({ _id: 'p', name: 'P', pathOnly: true })], 'p')).toBeNull();
    expect(knownPlace(ALL_FOLDERS, null)).toBeNull();
  });
});

describe('folder names', () => {
  it('accepts a plain name and the server\'s limits', () => {
    expect(folderNameProblem('Policies')).toBeNull();
    expect(folderNameProblem('  Policies  ')).toBeNull();
    expect(folderNameProblem('a'.repeat(200))).toBeNull();
  });

  it('refuses what the server refuses, with a reason', () => {
    expect(folderNameProblem('')).toBe('Enter a name.');
    expect(folderNameProblem('   ')).toBe('Enter a name.');
    expect(folderNameProblem('a'.repeat(201))).toMatch(/at most 200 characters/);
    expect(folderNameProblem('HR/Policies')).toMatch(/“\/”/);
    expect(folderNameProblem('bad\u0007name')).toMatch(/control characters/);
    expect(folderNameProblem('..')).toMatch(/cannot be/);
    expect(folderNameProblem('.')).toMatch(/cannot be/);
  });
});

describe('rows and their text', () => {
  it('lists folders ahead of documents, each with a key the node states are read by', () => {
    const rows = libraryRows([POLICIES], [HANDBOOK]);
    expect(rows.map((row) => row.key)).toEqual(['folder:f-policies', 'document:d-handbook']);
    expect(rows.map((row) => row.kind)).toEqual(['folder', 'document']);
  });

  it('counts a folder\'s items as its folders plus its documents, and counts nothing for a path-only folder', () => {
    expect(contentsLabel(POLICIES, 1)).toBe('3 items');
    expect(contentsLabel(ARCHIVE, 0)).toBe('0 items');
    expect(contentsLabel(folder({ _id: 'x', name: 'X', documents: 1 }), 0)).toBe('1 item');
    expect(contentsLabel(folder({ _id: 'p', name: 'P', pathOnly: true, documents: 40 }), 3)).toBeNull();
    // A server that sends no document count counts the folders it can.
    expect(contentsLabel(folder({ _id: 'x', name: 'X', documents: undefined }), 2)).toBe('2 items');
  });

  it('says what a place holds, and what a search found', () => {
    expect(libraryLine({ folderCount: 3, docTotal: 4 })).toBe('3 folders, 4 documents');
    expect(libraryLine({ folderCount: 1, docTotal: 1 })).toBe('1 folder, 1 document');
    expect(libraryLine({ folderCount: 3, docTotal: null })).toBe('3 folders');
    expect(libraryLine({ folderCount: 3, docTotal: 2, search: ' salary ' })).toBe('2 documents match “salary”');
    expect(libraryLine({ folderCount: 3, docTotal: 1, search: 'salary' })).toBe('1 document matches “salary”');
    expect(libraryLine({ folderCount: 3, docTotal: null, search: 'salary' })).toBe('Searching…');
    expect(plural(0, 'item')).toBe('0 items');
  });

  it('asks for the open folder\'s documents, and for every folder\'s while searching', () => {
    expect(folderParamOf(false, null)).toBe('root');
    expect(folderParamOf(false, 'f-policies')).toBe('f-policies');
    expect(folderParamOf(true, 'f-policies')).toBeUndefined();
    expect(folderParamOf(true, null)).toBeUndefined();
  });
});

describe('the Access column', () => {
  it('says where permissions come from and how many entries they name', () => {
    expect(accessCell({})).toEqual({ tone: 'inherit', label: 'Inherited' });
    expect(accessCell({ mode: 'inherit', entries: 0 })).toEqual({ tone: 'inherit', label: 'Inherited' });
    expect(accessCell({ mode: 'own', entries: 3 })).toEqual({ tone: 'own', label: 'Own · 3' });
    expect(accessCell({ mode: 'own', entries: 0 })).toEqual({ tone: 'nobody', label: 'Nobody' });
    expect(accessCell({ mode: 'own' })).toEqual({ tone: 'own', label: 'Own' });
    expect(accessCell({ mode: 'own', managed: 'sync', entries: 23 })).toEqual({ tone: 'synced', label: 'Synced · 23' });
    // A synced item without permissions of its own follows its folder: not "nobody".
    expect(accessCell({ mode: 'inherit', managed: 'sync', entries: 0 })).toEqual({ tone: 'synced', label: 'Synced' });
    expect(accessCell({ mode: 'own', managed: 'sync', entries: 0 })).toEqual({ tone: 'syncedNobody', label: 'Synced · nobody' });
    expect(accessCell({ managed: 'sync' })).toEqual({ tone: 'synced', label: 'Synced' });
  });

  it('reads the row until the node states arrive, then trusts them', () => {
    const rows: Record<string, LibraryRow> = {
      folder: { kind: 'folder', key: 'folder:f-policies', folder: POLICIES },
      document: { kind: 'document', key: 'document:d-salary', doc: SALARY },
      plain: { kind: 'document', key: 'document:d-handbook', doc: HANDBOOK },
      synced: { kind: 'document', key: 'document:d-site', doc: SITE_DOC },
    };
    expect(accessCellOf(rows.folder, undefined).label).toBe('Own');
    expect(accessCellOf(rows.folder, { mode: 'own', entries: 3 }).label).toBe('Own · 3');
    expect(accessCellOf(rows.document, undefined).label).toBe('Own');
    expect(accessCellOf(rows.plain, undefined).label).toBe('Inherited');
    expect(accessCellOf(rows.synced, undefined).label).toBe('Synced');
    // A save changed it: the state read after it wins over the row read before.
    expect(accessCellOf(rows.plain, { mode: 'own', entries: 2 }).label).toBe('Own · 2');
    expect(accessCellOf(rows.folder, { mode: 'inherit', entries: 0 }).label).toBe('Inherited');
  });
});

describe('who gets which menu item', () => {
  it('gives an admin the whole menu of a folder, and disables Delete while it holds anything', () => {
    const empty = folderActions(ADMIN, ARCHIVE, 0);
    expect(ids(empty)).toEqual(['open', 'permissions', 'rename', 'move', 'delete']);
    expect(empty.map((a) => a.label)).toEqual(['Open', 'Permissions…', 'Rename…', 'Move…', 'Delete']);
    expect(empty.find((a) => a.id === 'delete')!.disabled).toBeUndefined();

    const withDocuments = folderActions(ADMIN, POLICIES, 0).find((a) => a.id === 'delete')!;
    expect(withDocuments).toMatchObject({ disabled: true, disabledReason: FOLDER_NOT_EMPTY });
    expect(folderActions(ADMIN, ARCHIVE, 2).find((a) => a.id === 'delete')).toMatchObject({ disabled: true });
  });

  it('gives a writer the structure items only while access control is off', () => {
    expect(ids(folderActions(WRITER, ARCHIVE, 0))).toEqual(['open', 'rename', 'move', 'delete']);
    // With it on, the folder name opens the folder and there is nothing else to offer.
    expect(folderActions(WRITER_ACCESS_ON, ARCHIVE, 0)).toEqual([]);
    expect(folderActions(READER, ARCHIVE, 0)).toEqual([]);
  });

  it('gives a folder a source owns only Open, read-only permissions and the connector', () => {
    const synced = folderActions(ADMIN, SITE, 0);
    expect(ids(synced)).toEqual(['open', 'permissions', 'connector']);
    expect(synced.find((a) => a.id === 'permissions')!.label).toBe('Permissions (read-only)');
    // A writer without admin rights still reaches the connector; a reader gets no menu.
    expect(ids(folderActions(WRITER, SITE, 0))).toEqual(['open', 'connector']);
    expect(folderActions(READER, SITE, 0)).toEqual([]);
    // No connector id, no link to it.
    const orphan = folder({ _id: 'o', name: 'Orphan', aclManaged: 'sync', source: undefined });
    expect(ids(folderActions(ADMIN, orphan, 0))).toEqual(['open', 'permissions']);
  });

  it('gives a folder that is only a name no menu at all', () => {
    expect(folderActions(ADMIN, folder({ _id: 'p', name: 'Policies', pathOnly: true }), 1)).toEqual([]);
  });

  it('puts permissions and move ahead of the page\'s document actions, and the connector behind them', () => {
    expect(documentActions(ADMIN, SALARY, { hasFolders: true })).toEqual({
      before: [{ id: 'permissions', label: 'Permissions…' }, { id: 'move', label: 'Move…' }],
      after: [],
    });
    const synced = documentActions(ADMIN, SITE_DOC, { hasFolders: true, connectorId: 'conn-1' });
    expect(synced.before).toEqual([{ id: 'permissions', label: 'Permissions (read-only)' }]);
    expect(synced.after).toEqual([{ id: 'connector', label: 'Open connector' }]);
  });

  it('offers no move where there is nowhere to move to, and none to anyone who may not change the structure', () => {
    expect(ids(documentActions(WRITER, HANDBOOK, { hasFolders: false }).before)).toEqual([]);
    expect(ids(documentActions(WRITER, HANDBOOK, { hasFolders: true }).before)).toEqual(['move']);
    expect(documentActions(WRITER_ACCESS_ON, HANDBOOK, { hasFolders: true })).toEqual({ before: [], after: [] });
    expect(documentActions(READER, HANDBOOK, { hasFolders: true })).toEqual({ before: [], after: [] });
    // A synced document without a known connector has nothing behind the page's actions.
    expect(documentActions(ADMIN, SITE_DOC, { hasFolders: true }).after).toEqual([]);
    expect(documentActions(READER, SITE_DOC, { hasFolders: true, connectorId: 'conn-1' }).after).toEqual([]);
  });
});

describe('moving a selection', () => {
  const rows: LibraryRow[] = [
    { kind: 'folder', key: 'folder:f-onboarding', folder: ONBOARDING },
    { kind: 'folder', key: 'folder:f-site', folder: SITE },
    { kind: 'folder', key: 'folder:f-p', folder: folder({ _id: 'f-p', name: 'Only a name', pathOnly: true }) },
    { kind: 'document', key: 'document:d-handbook', doc: HANDBOOK },
    { kind: 'document', key: 'document:d-site', doc: SITE_DOC },
  ];

  it('takes what can move and counts what a source owns or the viewer only sees the name of', () => {
    const items = movableItems(rows);
    expect(items.folders.map((f) => f._id)).toEqual(['f-onboarding']);
    expect(items.documents.map((d) => d._id)).toEqual(['d-handbook']);
    expect(items.skipped).toBe(3);
  });

  it('knows when every item is already where it would go', () => {
    expect(sharedPlace({ folders: [ONBOARDING, ARCHIVE], documents: [HANDBOOK] })).toBeNull();
    expect(sharedPlace({ folders: [LEAVE], documents: [LEAVE_DOC] })).toBeUndefined();
    expect(sharedPlace({ folders: [], documents: [LEAVE_DOC] })).toBe('f-leave');
    expect(sharedPlace({ folders: [], documents: [] })).toBeUndefined();
    expect(moveIsNoop({ folders: [ONBOARDING], documents: [HANDBOOK] }, null)).toBe(true);
    expect(moveIsNoop({ folders: [ONBOARDING], documents: [HANDBOOK] }, 'f-policies')).toBe(false);
    expect(moveIsNoop({ folders: [LEAVE], documents: [] }, 'f-policies')).toBe(true);
    expect(moveIsNoop({ folders: [LEAVE], documents: [HANDBOOK] }, 'f-policies')).toBe(false);
  });

  it('cuts ids into requests of at most 500', () => {
    expect(inBatches(Array.from({ length: 1203 }, (_, i) => `d${i}`)).map((batch) => batch.length)).toEqual([500, 500, 203]);
    expect(inBatches([])).toEqual([]);
    expect(inBatches(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

describe('moving through the API', () => {
  const documents = (count: number) => Array.from({ length: count }, (_, i) => ({ _id: `d${i}`, fileName: `doc-${i}.txt` }));

  it('moves folders first, one request each, then documents in runs of 500', async () => {
    const order: string[] = [];
    const api = {
      updateFolder: vi.fn(async (_key: string, id: string, input: { parentId?: string | null }) => {
        order.push(`folder ${id} -> ${String(input.parentId)}`);
        return folder({ _id: id, name: id });
      }),
      moveDocuments: vi.fn(async (_key: string, documentIds: string[], folderId: string | null) => {
        order.push(`documents ${documentIds.length} -> ${String(folderId)}`);
        return documentIds.length;
      }),
    };
    const outcome = await moveLibraryItems('kb', { folders: [ONBOARDING, ARCHIVE], documents: documents(1203) }, 'f-policies', api);
    expect(order).toEqual([
      'folder f-onboarding -> f-policies',
      'folder f-archive -> f-policies',
      'documents 500 -> f-policies',
      'documents 500 -> f-policies',
      'documents 203 -> f-policies',
    ]);
    expect(outcome).toEqual({ folders: 2, documents: 1203 });
  });

  it('sends the top level as null, and counts only the documents the server really moved', async () => {
    const api = {
      updateFolder: vi.fn(async () => folder({ _id: 'x', name: 'x' })),
      moveDocuments: vi.fn(async () => 1),
    };
    const outcome = await moveLibraryItems('kb', { folders: [LEAVE], documents: documents(3) }, null, api);
    expect(api.updateFolder).toHaveBeenCalledWith('kb', 'f-leave', { parentId: null });
    expect(api.moveDocuments).toHaveBeenCalledWith('kb', ['d0', 'd1', 'd2'], null);
    expect(outcome).toEqual({ folders: 1, documents: 1 });
  });

  it('stops at the first refusal and says how much had moved', async () => {
    const api = {
      updateFolder: vi.fn(async (_key: string, id: string) => {
        if (id === 'f-archive') throw new Error('A folder with this name already exists here');
        return folder({ _id: id, name: id });
      }),
      moveDocuments: vi.fn(async () => 1),
    };
    const failure = await moveLibraryItems('kb', { folders: [ONBOARDING, ARCHIVE, LEAVE], documents: documents(2) }, 'f-policies', api).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveFailedError);
    expect(failure).toMatchObject({ message: 'A folder with this name already exists here', moved: 1, total: 5 });
    // Nothing after the refused folder was sent.
    expect(api.updateFolder).toHaveBeenCalledTimes(2);
    expect(api.moveDocuments).not.toHaveBeenCalled();
  });
});

describe('the tab the page opens', () => {
  it('knows the six tabs and falls back to the overview for anything else', () => {
    for (const tab of ['overview', 'documents', 'playground', 'usage', 'history', 'access']) {
      expect(isRagPageTab(tab)).toBe(true);
      expect(parseRagPageTab(tab)).toBe(tab);
    }
    expect(parseRagPageTab(null)).toBe('overview');
    expect(parseRagPageTab(undefined)).toBe('overview');
    expect(parseRagPageTab('')).toBe('overview');
    expect(parseRagPageTab('admin')).toBe('overview');
    expect(isRagPageTab(3)).toBe(false);
  });

  it('keeps the Access tab for admins, waits for a level that is not known yet, and sends everyone else to the overview', () => {
    expect(visibleRagPageTab('access', { canAdmin: true, levelKnown: true })).toBe('access');
    expect(visibleRagPageTab('access', { canAdmin: false, levelKnown: false })).toBe('access');
    expect(visibleRagPageTab('access', { canAdmin: false, levelKnown: true })).toBe('overview');
    expect(visibleRagPageTab('documents', { canAdmin: false, levelKnown: true })).toBe('documents');
  });
});
