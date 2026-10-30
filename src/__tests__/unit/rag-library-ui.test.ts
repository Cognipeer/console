// @vitest-environment jsdom
/**
 * The Documents tab's library on its own, against a mocked `fetch`: one list of folders then documents, the Access
 * column, the ⋯ menus for every kind of row and viewer, the path, search, the bulk move and the folder changes. The
 * page's own pieces (columns, Re-ingest) are stand-ins here; the page test has the real ones.
 */

import { act, createElement as h, useState, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RagLibrary, { type RagLibraryProps } from '@/components/rag/library/RagLibrary';
import type { LibraryViewer } from '@/components/rag/library/libraryModel';
import type { RagFolderView } from '@/components/rag/access/ragAccessApi';
import type { DataGridColumn, DataGridRowAction } from '@/components/common/ui/DataGrid';
import { buttonByText, click, installDomStubs, jsonResponse, mount, q, qa, setInput, text, wait, type ApiMock, type Mounted } from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';
import {
  ALL_FOLDERS,
  ARCHIVE,
  HANDBOOK,
  HOLIDAY,
  LEAVE_DOC,
  SALARY,
  SITE_DOC,
  folder,
  installKbApi,
  type FixtureDoc,
} from '../helpers/ragLibraryFixtures';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
// Stable objects, as the page test has them: a fresh router per render would loop its effects.
const nav = vi.hoisted(() => ({
  router: { push: () => undefined, prefetch: () => undefined, replace: () => undefined },
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/rag/kb',
  useSearchParams: () => nav.search,
}));
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

const spies = {
  onOpenFolder: vi.fn(),
  onEditPermissions: vi.fn(),
  onOpenConnector: vi.fn(),
  onChanged: vi.fn(async () => undefined),
  onSearch: vi.fn(),
  reingest: vi.fn(),
  removeDocument: vi.fn(),
};

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  notify.show.mockClear();
  for (const spy of Object.values(spies)) spy.mockClear();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NODES = '/api/rag/modules/kb/access/nodes';
const FOLDERS = '/api/rag/modules/kb/folders';
const MOVE = '/api/rag/modules/kb/documents/move';

const ADMIN: LibraryViewer = { canWrite: true, canAdmin: true, canChangeStructure: true };
const WRITER: LibraryViewer = { canWrite: true, canAdmin: false, canChangeStructure: true };
const WRITER_ACCESS_ON: LibraryViewer = { canWrite: true, canAdmin: false, canChangeStructure: false };
const READER: LibraryViewer = { canWrite: false, canAdmin: false, canChangeStructure: false };

const ROOT_DOCS = [HANDBOOK, SALARY, HOLIDAY];
// A folder the viewer sees only the name of, because a folder below it is readable.
const LEGAL = folder({ _id: 'f-legal', name: 'Legal', path: 'Legal', pathOnly: true, documents: 0 });
const CONTRACTS = folder({ _id: 'f-contracts', name: 'Contracts', parentId: 'f-legal', path: 'Legal/Contracts', documents: 2 });
const DRAFTS = folder({ _id: 'f-drafts', name: 'Drafts', parentId: 'f-policies', path: 'Policies/Drafts', documents: 0 });

/** The columns the page hands over; each cell says which column it is. */
const documentColumns: Array<DataGridColumn<FixtureDoc>> = [
  { key: 'fileName', label: 'File', render: (doc) => h('span', null, doc.fileName) },
  { key: 'chunks', label: 'Chunks', render: (doc) => h('span', null, `${doc.chunkCount ?? 0} chunks`) },
  { key: 'status', label: 'Status', render: (doc) => h('span', null, `status ${doc.status}`) },
  { key: 'indexedAt', label: 'Indexed', render: () => h('span', null, 'indexed-cell') },
  { key: 'createdAt', label: 'Created', render: () => h('span', null, 'created-cell') },
];

/** The page's own actions, limited as the page limits them. */
const pageActions = (viewer: LibraryViewer) => (doc: FixtureDoc): Array<DataGridRowAction<FixtureDoc>> => [
  { id: 'reingest', label: 'Re-ingest', hidden: !viewer.canWrite, onClick: (row) => spies.reingest(row) },
  { id: 'delete', label: 'Delete', color: 'red', hidden: !viewer.canWrite || doc.aclManaged === 'sync', onClick: (row) => spies.removeDocument(row) },
];

interface Options {
  viewer?: LibraryViewer;
  accessEnabled?: boolean;
  folders?: RagFolderView[];
  openFolderId?: string | null;
  documents?: FixtureDoc[];
  docTotal?: number | null;
  searchTerm?: string;
  filtered?: boolean;
  page?: number;
  errorView?: ReactNode;
}

const Library = RagLibrary as unknown as ComponentType<RagLibraryProps<FixtureDoc>>;
const controls: { setDocuments: (documents: FixtureDoc[]) => void } = { setDocuments: () => undefined };

function Harness({ options }: { options: Options }) {
  const viewer = options.viewer ?? ADMIN;
  const [documents, setDocuments] = useState(options.documents ?? ROOT_DOCS);
  controls.setDocuments = setDocuments;
  return h(Library, {
    moduleKey: 'kb',
    moduleName: 'HR Policies',
    viewer,
    accessEnabled: options.accessEnabled ?? true,
    folders: options.folders ?? ALL_FOLDERS,
    openFolderId: options.openFolderId ?? null,
    onOpenFolder: spies.onOpenFolder,
    documents,
    docTotal: options.docTotal === undefined ? documents.length : options.docTotal,
    searchTerm: options.searchTerm ?? '',
    filtered: options.filtered ?? false,
    page: options.page ?? 1,
    loading: false,
    chrome: { search: { value: options.searchTerm ?? '', onChange: spies.onSearch, placeholder: 'Search all folders…' } },
    documentColumns,
    documentActions: pageActions(viewer),
    errorView: options.errorView,
    accessRefreshKey: 0,
    onEditPermissions: spies.onEditPermissions,
    onOpenConnector: spies.onOpenConnector,
    onChanged: spies.onChanged,
  });
}

async function open(options: Options = {}) {
  api = installKbApi();
  mounted = await mount(h(Harness, { options }));
  await wait(30);
}

const rows = () => qa('tbody tr');
const folderRow = (name: string) => q(`button[aria-label="Open folder ${name}"]`)!.closest('tr') as HTMLElement;
const docRow = (fileName: string) => rows().find((tr) => tr.textContent?.includes(fileName))!;
const actionsOf = (row: Element) => q<HTMLButtonElement>('button[aria-label="Actions"]', row);
const headers = () => qa('thead th').map((th) => th.textContent?.trim()).filter(Boolean);
const overlay = () => q('.form-overlay')!;
const field = (label: string) => q<HTMLInputElement>(`input[aria-label="${label}"]`, overlay())!;
const primary = (label: string) => buttonByText(label, overlay())!;
const isOff = (el: Element | undefined | null) => el?.getAttribute('aria-disabled') === 'true';

/** Opens the ⋯ menu behind `trigger` and reads it. */
async function openMenu(trigger: Element | null | undefined) {
  await click(trigger);
  await until(() => qa('[role="menuitem"]').length > 0, 'the menu');
  const items = qa('[role="menuitem"]');
  const item = (label: string) => items.find((i) => i.textContent?.trim() === label)!;
  return {
    labels: items.map((i) => i.textContent?.trim()),
    item,
    isOff: (label: string) => isOff(item(label)),
    close: async () => {
      await click(trigger);
      await wait(30);
    },
  };
}

async function choose(label: string, option: string) {
  await click(field(label));
  await wait(30);
  await click(qa('[role="option"]').find((o) => o.textContent?.trim() === option));
  await wait(30);
}

const tick = (row: Element) => click(q('input[type="checkbox"]', row));

describe('the list', () => {
  it('lists the folders of the place ahead of its documents, by name', async () => {
    await open();
    expect(rows()).toHaveLength(7);
    const body = q('tbody')!.textContent ?? '';
    const order = ['Archive', 'HR Site', 'Onboarding', 'Policies', 'employee-handbook-2026.pdf', 'salary-bands-2026.xlsx', 'holiday-calendar-2026.xlsx'];
    const at = order.map((name) => body.indexOf(name));
    expect(at.every((position) => position >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Leave is below Policies: it is not a row of the top level.
    expect(body).not.toContain('Leave');
  });

  it('has the Access column for admins, and the columns of a document come from the page', async () => {
    await open();
    expect(headers()).toEqual(['Name', 'Access', 'Contents', 'Status', 'Indexed At', 'Created']);
    const handbook = docRow('employee-handbook-2026.pdf');
    expect(handbook.textContent).toContain('64 chunks');
    expect(handbook.textContent).toContain('status indexed');
    expect(handbook.textContent).toContain('indexed-cell');
    expect(handbook.textContent).toContain('created-cell');
  });

  it('says what each folder holds, and when it was last changed', async () => {
    await open();
    // Items = child folders plus documents: Policies holds Leave and two documents.
    expect(folderRow('Policies').textContent).toContain('3 items');
    expect(folderRow('Onboarding').textContent).toContain('9 items');
    expect(folderRow('Archive').textContent).toContain('0 items');
    expect(folderRow('HR Site').textContent).toContain('23 items');
    expect(folderRow('Archive').textContent).toContain(new Date(ARCHIVE.updatedAt!).toLocaleString());
    // Folders have no status, and no indexing time.
    expect(folderRow('Archive').textContent).not.toContain('status ');
  });

  it('says in the path what the place holds', async () => {
    await open();
    const path = q('nav[aria-label="Folder path"]')!;
    expect(path.textContent).toContain('HR Policies');
    expect(text()).toContain('4 folders, 3 documents');
    // At the top level nothing is above, and the knowledge base is the page you are on.
    expect(q('button[aria-label="Up one level"]')).toBeNull();
    expect(q('[aria-current="page"]', path)!.textContent).toBe('HR Policies');
  });

  it('opens a folder by its name', async () => {
    await open();
    await click(q('button[aria-label="Open folder Policies"]'));
    expect(spies.onOpenFolder).toHaveBeenCalledWith('f-policies');
  });

  it('shows the permission state of every row for admins, read for exactly the rows listed', async () => {
    await open();
    await until(() => text().includes('Own · 3'), 'the permission states');
    expect(folderRow('Policies').textContent).toContain('Own · 3');
    expect(folderRow('Onboarding').textContent).toContain('Inherited');
    expect(folderRow('Archive').textContent).toContain('Inherited');
    expect(folderRow('HR Site').textContent).toContain('Synced · 5');
    expect(docRow('employee-handbook-2026.pdf').textContent).toContain('Inherited');
    expect(docRow('salary-bands-2026.xlsx').textContent).toContain('Own · 1');
    // Own permissions with nobody in them: nobody reads it but admins with the exception.
    expect(docRow('holiday-calendar-2026.xlsx').textContent).toContain('Nobody');

    const asked = api.to('POST', NODES);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toEqual({
      folderIds: ['f-archive', 'f-site', 'f-onboarding', 'f-policies'],
      documentIds: ['d-handbook', 'd-salary', 'd-holiday'],
    });
  });

  it('keeps the Access column and its request away from everyone but admins', async () => {
    for (const viewer of [READER, WRITER, WRITER_ACCESS_ON]) {
      await open({ viewer });
      await wait(60);
      expect(headers(), JSON.stringify(viewer)).toEqual(['Name', 'Contents', 'Status', 'Indexed At', 'Created']);
      expect(api.to('POST', NODES)).toHaveLength(0);
      await mounted!.unmount();
      mounted = null;
    }
  });

  it('draws a folder that is only a name without a menu, a count or anything to change', async () => {
    await open({ viewer: WRITER, folders: [LEGAL, CONTRACTS] });
    const row = folderRow('Legal');
    expect(row.textContent).toContain('path only');
    expect(row.textContent).not.toContain('items');
    expect(actionsOf(row)).toBeNull();
    // It can still be opened: the readable folders are below it.
    await click(q('button[aria-label="Open folder Legal"]'));
    expect(spies.onOpenFolder).toHaveBeenCalledWith('f-legal');
  });

  it('marks a folder a connected source owns', async () => {
    await open();
    expect(folderRow('HR Site').textContent).toContain('Synced');
    expect(folderRow('Policies').textContent).not.toContain('Synced');
  });

  it('draws a failing place with the path kept, instead of the grid', async () => {
    await open({ errorView: h('div', null, 'Could not load the documents') });
    expect(text()).toContain('Could not load the documents');
    expect(q('table')).toBeNull();
    expect(q('nav[aria-label="Folder path"]')).not.toBeNull();
  });
});

describe('inside a folder', () => {
  it('shows the way down and lets you go up, to any level', async () => {
    await open({ openFolderId: 'f-leave', documents: [LEAVE_DOC] });
    const path = q('nav[aria-label="Folder path"]')!;
    expect(path.textContent).toContain('HR Policies');
    expect(path.textContent).toContain('Policies');
    expect(q('[aria-current="page"]', path)!.textContent).toBe('Leave');
    expect(text()).toContain('0 folders, 1 document');

    // Only the open folder's own rows: Leave has no folders below it.
    expect(rows()).toHaveLength(1);

    await click(q('button[aria-label="Up one level"]'));
    expect(spies.onOpenFolder).toHaveBeenLastCalledWith('f-policies');
    await click(buttonByText('Policies', path));
    expect(spies.onOpenFolder).toHaveBeenLastCalledWith('f-policies');
    await click(buttonByText('HR Policies', path));
    expect(spies.onOpenFolder).toHaveBeenLastCalledWith(null);
  });

  it('goes from a first-level folder up to the top level', async () => {
    await open({ openFolderId: 'f-policies', documents: [] });
    await click(q('button[aria-label="Up one level"]'));
    expect(spies.onOpenFolder).toHaveBeenCalledWith(null);
    // Its subfolder is a row.
    expect(folderRow('Leave').textContent).toContain('1 item');
  });

  it('has the open folder\'s own menu at the end of the path', async () => {
    await open({ openFolderId: 'f-leave', documents: [LEAVE_DOC] });
    const menu = await openMenu(q('button[aria-label="Folder actions"]'));
    // Open is what the path already says; Delete waits until the folder is empty.
    expect(menu.labels).toEqual(['Permissions…', 'Rename…', 'Move…', 'Delete']);
    expect(menu.isOff('Delete')).toBe(true);
    await click(menu.item('Permissions…'));
    expect(spies.onEditPermissions).toHaveBeenCalledWith({ node: 'folder:f-leave', name: 'Leave', path: 'Policies/Leave' });
  });

  it('says a folder is empty, and what to do about it', async () => {
    await open({ openFolderId: 'f-archive', documents: [] });
    expect(text()).toContain('This folder is empty');
    expect(text()).toContain('Ingest a document above with this folder selected.');
    await mounted!.unmount();
    mounted = null;

    await open({ viewer: READER, openFolderId: 'f-archive', documents: [] });
    expect(text()).toContain('This folder is empty');
    expect(text()).toContain('Nothing has been added here yet.');
  });

  it('says so when a search or a filter found nothing, and when a knowledge base has no documents yet', async () => {
    await open({ openFolderId: 'f-archive', documents: [], filtered: true });
    expect(text()).toContain('No document matches');
    await mounted!.unmount();
    mounted = null;

    // No folder at all and no document: the list is as it was before folders, with no path.
    await open({ folders: [], documents: [] });
    expect(text()).toContain('No documents yet');
    expect(q('nav[aria-label="Folder path"]')).toBeNull();
  });
});

describe('a search', () => {
  it('spans every folder: documents only, with the folder each one is in', async () => {
    await open({ searchTerm: 'salary', documents: [SALARY, LEAVE_DOC], filtered: true });
    expect(headers()).toEqual(['Name', 'Location', 'Access', 'Contents', 'Status', 'Indexed At', 'Created']);
    expect(q('button[aria-label^="Open folder"]')).toBeNull();
    expect(docRow('salary-bands-2026.xlsx').textContent).toContain('Top level');
    expect(docRow('parental-leave.docx').textContent).toContain('Policies / Leave');
    expect(text()).toContain('2 documents match “salary”');
  });

  it('lists no folders on the later pages either', async () => {
    await open({ page: 2, documents: [HOLIDAY] });
    expect(q('button[aria-label^="Open folder"]')).toBeNull();
    expect(rows()).toHaveLength(1);
  });
});

describe('the menus of the rows', () => {
  it('gives an admin the whole menu of a folder, and a Delete that waits for it to be empty', async () => {
    await open();
    const policies = await openMenu(actionsOf(folderRow('Policies')));
    expect(policies.labels).toEqual(['Open', 'Permissions…', 'Rename…', 'Move…', 'Delete']);
    expect(policies.isOff('Delete')).toBe(true);
    await click(policies.item('Permissions…'));
    expect(spies.onEditPermissions).toHaveBeenCalledWith({ node: 'folder:f-policies', name: 'Policies', path: 'Policies' });
    await wait(30);

    const archive = await openMenu(actionsOf(folderRow('Archive')));
    expect(archive.labels).toEqual(['Open', 'Permissions…', 'Rename…', 'Move…', 'Delete']);
    expect(archive.isOff('Delete')).toBe(false);
    await click(archive.item('Open'));
    expect(spies.onOpenFolder).toHaveBeenCalledWith('f-archive');
  });

  it('gives a folder a source owns read-only permissions and a way to its connector', async () => {
    await open();
    const site = await openMenu(actionsOf(folderRow('HR Site')));
    expect(site.labels).toEqual(['Open', 'Permissions (read-only)', 'Open connector']);
    await click(site.item('Open connector'));
    expect(spies.onOpenConnector).toHaveBeenCalledWith('conn-1');
  });

  it('puts permissions and move ahead of the page\'s actions in a document\'s menu', async () => {
    await open();
    const salary = await openMenu(actionsOf(docRow('salary-bands-2026.xlsx')));
    expect(salary.labels).toEqual(['Permissions…', 'Move…', 'Re-ingest', 'Delete']);
    await click(salary.item('Re-ingest'));
    // The page's handler gets its own document back.
    expect(spies.reingest).toHaveBeenCalledWith(expect.objectContaining({ _id: 'd-salary' }));
  });

  it('names a document\'s folder when it asks for its permissions', async () => {
    await open();
    const top = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    await click(top.item('Permissions…'));
    expect(spies.onEditPermissions).toHaveBeenLastCalledWith({ node: 'document:d-handbook', name: 'employee-handbook-2026.pdf', path: '' });
    await mounted!.unmount();
    mounted = null;

    await open({ openFolderId: 'f-leave', documents: [LEAVE_DOC] });
    const inLeave = await openMenu(actionsOf(docRow('parental-leave.docx')));
    await click(inLeave.item('Permissions…'));
    expect(spies.onEditPermissions).toHaveBeenLastCalledWith({ node: 'document:d-leave', name: 'parental-leave.docx', path: 'Policies/Leave' });
  });

  it('gives a document a source owns read-only permissions, no Delete, and the connector behind the page\'s actions', async () => {
    await open({ openFolderId: 'f-site', documents: [SITE_DOC] });
    const menu = await openMenu(actionsOf(docRow('site-handbook.docx')));
    expect(menu.labels).toEqual(['Permissions (read-only)', 'Re-ingest', 'Open connector']);
    await click(menu.item('Open connector'));
    expect(spies.onOpenConnector).toHaveBeenCalledWith('conn-1');
  });

  it('gives a writer the structure items only while access control is off', async () => {
    await open({ viewer: WRITER, accessEnabled: false });
    const folderMenu = await openMenu(actionsOf(folderRow('Archive')));
    expect(folderMenu.labels).toEqual(['Open', 'Rename…', 'Move…', 'Delete']);
    await folderMenu.close();
    const docMenu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    expect(docMenu.labels).toEqual(['Move…', 'Re-ingest', 'Delete']);
  });

  it('leaves a writer with access control on only the page\'s actions', async () => {
    await open({ viewer: WRITER_ACCESS_ON });
    // No folder menu at all: the name opens the folder.
    expect(actionsOf(folderRow('Archive'))).toBeNull();
    expect(buttonByText('New folder')).toBeUndefined();
    expect(q('input[type="checkbox"]')).toBeNull();
    const docMenu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    expect(docMenu.labels).toEqual(['Re-ingest', 'Delete']);
  });

  it('gives a reader no menu at all', async () => {
    await open({ viewer: READER });
    expect(qa('button[aria-label="Actions"]')).toHaveLength(0);
    expect(buttonByText('New folder')).toBeUndefined();
    expect(q('input[type="checkbox"]')).toBeNull();
    expect(q('button[aria-label="Open folder Policies"]')).not.toBeNull();
  });

  it('offers no move where there is no folder to move to', async () => {
    await open({ folders: [], documents: ROOT_DOCS });
    const menu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    expect(menu.labels).toEqual(['Permissions…', 'Re-ingest', 'Delete']);
    await menu.close();
    // And no checkboxes: a selection would have nothing to do.
    expect(q('input[type="checkbox"]')).toBeNull();
    expect(buttonByText('New folder')).toBeDefined();
  });
});

describe('changing the structure', () => {
  it('creates a folder in the open one and has the page read again', async () => {
    await open({ openFolderId: 'f-policies', documents: [] });
    await click(buttonByText('New folder'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    expect(field('Location').value).toBe('Policies');
    await setInput(field('Folder name'), 'Travel');
    await click(primary('Create folder'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');

    expect(api.to('POST', FOLDERS)[0]!.body).toEqual({ name: 'Travel', parentId: 'f-policies' });
    // The library closes its own form.
    expect(q('.form-overlay')).toBeNull();
  });

  it('renames a folder from its menu', async () => {
    await open();
    const menu = await openMenu(actionsOf(folderRow('Archive')));
    await click(menu.item('Rename…'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    expect(field('Folder name').value).toBe('Archive');
    await setInput(field('Folder name'), 'Old files');
    await click(primary('Rename'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');

    expect(api.to('PATCH', '/api/rag/modules/kb/folders/f-archive')[0]!.body).toEqual({ name: 'Old files' });
    expect(q('.form-overlay')).toBeNull();
  });

  it('moves a document from its menu, to a place chosen in the form', async () => {
    await open();
    const menu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    await click(menu.item('Move…'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    expect(text()).toContain('Move 1 item');

    await click(field('Destination'));
    await wait(30);
    // Every folder but the ones a source owns.
    expect(qa('[role="option"]').map((o) => o.textContent?.trim())).toEqual(['Top level', 'Archive', 'Onboarding', 'Policies', 'Policies / Leave']);
    await click(qa('[role="option"]').find((o) => o.textContent?.trim() === 'Policies'));
    await click(primary('Move'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');

    expect(api.to('POST', MOVE)[0]!.body).toEqual({ documentIds: ['d-handbook'], folderId: 'f-policies' });
  });

  it('moves a folder from its menu, and the form says that access follows the new folder', async () => {
    await open();
    const menu = await openMenu(actionsOf(folderRow('Onboarding')));
    await click(menu.item('Move…'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    expect(text()).toContain('Items that inherit take the permissions of their new folder.');
    await choose('Destination', 'Archive');
    await click(primary('Move'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');
    expect(api.to('PATCH', '/api/rag/modules/kb/folders/f-onboarding')[0]!.body).toEqual({ parentId: 'f-archive' });
  });
});

describe('moving a selection', () => {
  it('selects rows, moves what can move, and leaves out what a source owns', async () => {
    await open();
    await tick(folderRow('Onboarding'));
    await tick(folderRow('HR Site'));
    await tick(docRow('employee-handbook-2026.pdf'));
    expect(text()).toContain('3 selected');

    await click(buttonByText('Move…'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    expect(text()).toContain('Move 2 items');
    expect(text()).toContain('1 selected item from a connected source is left out: it changes only in the source.');

    await choose('Destination', 'Policies');
    await click(primary('Move'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');

    // Folders first, one request each; the connected one never went.
    expect(api.to('PATCH', /folders\/[^/]+$/).map((call) => call.path)).toEqual(['/api/rag/modules/kb/folders/f-onboarding']);
    expect(api.to('PATCH', '/api/rag/modules/kb/folders/f-onboarding')[0]!.body).toEqual({ parentId: 'f-policies' });
    expect(api.to('POST', MOVE)[0]!.body).toEqual({ documentIds: ['d-handbook'], folderId: 'f-policies' });
    // A finished move leaves nothing selected.
    expect(text()).not.toMatch(/\d+ selected/);
  });

  it('clears the selection on request, and selects everything on screen at once', async () => {
    await open();
    await tick(folderRow('Archive'));
    expect(text()).toContain('1 selected');
    await click(buttonByText('Clear'));
    expect(text()).not.toMatch(/\d+ selected/);

    await click(q('input[aria-label="Select all rows"]'));
    expect(text()).toContain('7 selected');
  });

  it('drops from the selection what is no longer on screen', async () => {
    await open();
    await tick(docRow('employee-handbook-2026.pdf'));
    await tick(docRow('salary-bands-2026.xlsx'));
    expect(text()).toContain('2 selected');

    await act(async () => controls.setDocuments([SALARY, HOLIDAY]));
    expect(text()).toContain('1 selected');
    await act(async () => controls.setDocuments([HOLIDAY]));
    expect(text()).not.toMatch(/\d+ selected/);
  });
});

describe('deleting a folder', () => {
  it('asks first, then deletes an empty folder and has the page read again', async () => {
    await open();
    const menu = await openMenu(actionsOf(folderRow('Archive')));
    await click(menu.item('Delete'));
    await until(() => Boolean(buttonByText('Delete folder')), 'the question');
    expect(text()).toContain('Delete this folder?');
    expect(text()).toContain('“Archive” is empty.');
    // Nothing went out before the answer.
    expect(api.to('DELETE', /folders/)).toHaveLength(0);

    await click(buttonByText('Delete folder'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');
    expect(api.to('DELETE', '/api/rag/modules/kb/folders/f-archive')).toHaveLength(1);
    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'green', title: 'Folder deleted' }));
    // It was not the open folder: nothing to leave.
    expect(spies.onOpenFolder).not.toHaveBeenCalled();
  });

  it('does nothing when the question is answered no', async () => {
    await open();
    const menu = await openMenu(actionsOf(folderRow('Archive')));
    await click(menu.item('Delete'));
    await until(() => Boolean(buttonByText('Delete folder')), 'the question');
    await click(buttonByText('Cancel'));
    await wait(50);
    expect(api.to('DELETE', /folders/)).toHaveLength(0);
    expect(spies.onChanged).not.toHaveBeenCalled();
  });

  it('does not ask for a folder that is not empty', async () => {
    await open();
    const menu = await openMenu(actionsOf(folderRow('Policies')));
    expect(menu.isOff('Delete')).toBe(true);
    await click(menu.item('Delete'));
    await wait(50);
    expect(buttonByText('Delete folder')).toBeUndefined();
    expect(api.to('DELETE', /folders/)).toHaveLength(0);
  });

  it('says why the server refused, and does not read again', async () => {
    await open();
    await wait(0);
    api.on('DELETE', /^\/api\/rag\/modules\/kb\/folders\/[^/]+$/, () => jsonResponse({ error: 'The folder is not empty' }, 409));
    const menu = await openMenu(actionsOf(folderRow('Archive')));
    await click(menu.item('Delete'));
    await until(() => Boolean(buttonByText('Delete folder')), 'the question');
    await click(buttonByText('Delete folder'));
    await until(() => notify.show.mock.calls.length === 1, 'the notice');

    expect(notify.show).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', title: 'Folder not deleted', message: 'The folder is not empty' }));
    expect(spies.onChanged).not.toHaveBeenCalled();
  });

  it('leaves for the folder above when the open folder is the one deleted', async () => {
    await open({ openFolderId: 'f-drafts', folders: [...ALL_FOLDERS, DRAFTS], documents: [] });
    const menu = await openMenu(q('button[aria-label="Folder actions"]'));
    expect(menu.labels).toEqual(['Permissions…', 'Rename…', 'Move…', 'Delete']);
    expect(menu.isOff('Delete')).toBe(false);
    await click(menu.item('Delete'));
    await until(() => Boolean(buttonByText('Delete folder')), 'the question');
    await click(buttonByText('Delete folder'));
    await until(() => spies.onChanged.mock.calls.length === 1, 'the page to read again');

    expect(api.to('DELETE', '/api/rag/modules/kb/folders/f-drafts')).toHaveLength(1);
    expect(spies.onOpenFolder).toHaveBeenCalledWith('f-policies');
  });
});
