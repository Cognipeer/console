// @vitest-environment jsdom
/**
 * The Knowledge Engine module page with the library wired in, against a mocked `fetch`: the tab named in the address,
 * who gets the Access tab and the header chip, what the documents request asks for, the folder a search or an upload
 * goes to, and what the page reads again after a change. The three components of the access work (chip, tab,
 * permission editor) are probes here: they record the props the page gives them and call its handlers on request.
 */

import { act, createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import RagModulePage from '@/app/dashboard/rag/[key]/page';
import { buttonByText, click, installDomStubs, jsonResponse, mount, q, qa, setInput, settle, text, wait, type ApiMock, type Mounted, type RecordedCall } from '../helpers/iamCenterUi';
import { makeFile, until } from '../helpers/filesUploadDetailHarness';
import { ALL_FOLDERS, HANDBOOK, HOLIDAY, LEAVE_DOC, SALARY, SITE_DOC, doc, installKbApi, type FixtureDoc, type KbApiOptions } from '../helpers/ragLibraryFixtures';

interface ChipProps { enabled: boolean; onClick: () => void }
interface TabProps {
  moduleKey: string;
  moduleName: string;
  access: { enabled: boolean; adminBypass?: boolean } | null | undefined;
  refreshKey: number;
  onModuleChanged: () => void;
  onEditPermissions: (target: { node: string; name: string; path?: string }) => void;
  onShowFolder: (folderId: string | null) => void;
}
interface EditorProps {
  moduleKey: string;
  moduleName: string;
  target: { node: string; name: string; path?: string } | null;
  accessEnabled: boolean;
  adminBypass: boolean;
  onClose: () => void;
  onSaved: (acl: unknown) => void;
}

const probes = vi.hoisted(() => ({
  chip: vi.fn<(props: ChipProps) => unknown>(() => null),
  tab: vi.fn<(props: TabProps) => unknown>(() => null),
  editor: vi.fn<(props: EditorProps) => unknown>(() => null),
}));
vi.mock('@/components/rag/access/RagAccessChip', () => ({ RagAccessChip: (props: ChipProps) => probes.chip(props) }));
vi.mock('@/components/rag/access/RagAccessTab', () => ({ RagAccessTab: (props: TabProps) => probes.tab(props) }));
vi.mock('@/components/rag/access/RagPermissionEditor', () => ({ RagPermissionEditor: (props: EditorProps) => probes.editor(props) }));

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
// Stable objects: the page lists the router among its effects' dependencies, so a fresh one per render would loop.
const nav = vi.hoisted(() => ({
  params: { key: 'kb' },
  router: { push: vi.fn(), prefetch: () => undefined, replace: () => undefined },
  search: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  useParams: () => nav.params,
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/rag/kb',
  useSearchParams: () => nav.search,
}));
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => {
  installDomStubs();
  probes.chip.mockImplementation((props) => h('button', { type: 'button', onClick: props.onClick }, `chip ${props.enabled ? 'on' : 'off'}`));
  probes.tab.mockImplementation((props) => h('div', null,
    h('span', null, 'probe access tab'),
    h('button', { type: 'button', onClick: () => props.onShowFolder('f-policies') }, 'probe show Policies'),
    h('button', { type: 'button', onClick: () => props.onShowFolder(null) }, 'probe show top level'),
    h('button', { type: 'button', onClick: () => props.onModuleChanged() }, 'probe module changed'),
    h('button', { type: 'button', onClick: () => props.onEditPermissions({ node: 'module', name: props.moduleName }) }, 'probe edit default access')));
  probes.editor.mockImplementation((props) => (props.target
    ? h('div', null,
      h('span', null, `probe editor ${props.target.node}`),
      h('button', { type: 'button', onClick: () => props.onSaved({}) }, 'probe save'),
      h('button', { type: 'button', onClick: () => props.onClose() }, 'probe close'))
    : null));
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  notify.show.mockClear();
  nav.router.push.mockClear();
  for (const probe of Object.values(probes)) probe.mockClear();
  window.history.replaceState(null, '', '/');
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const DOCUMENTS = '/api/rag/modules/kb/documents';
const FOLDERS = '/api/rag/modules/kb/folders';
const NODES = '/api/rag/modules/kb/access/nodes';
const MODULE = '/api/rag/modules/kb';

interface OpenOptions extends Omit<KbApiOptions, 'level'> {
  level?: 'read' | 'write' | 'admin';
  /** The `?tab=` the page is opened with. */
  tab?: string;
}

async function open(options: OpenOptions = {}) {
  const { tab, ...kb } = options;
  nav.search = new URLSearchParams(tab ? `tab=${tab}` : '');
  api = installKbApi(kb);
  mounted = await mount(h(RagModulePage));
  await until(() => text().includes('HR Policies'), 'the page');
}

const tabLabels = () => qa<HTMLButtonElement>('[role="tab"]').map((t) => t.textContent ?? '');
const tabByLabel = (label: string) => qa<HTMLButtonElement>('[role="tab"]').find((t) => t.textContent?.includes(label));

/** Opens the Documents tab and waits until its documents and folders are drawn (`folders: false` for a module without any). */
async function documentsTab(options: { folders?: boolean } = {}) {
  await click(tabByLabel('Documents'));
  await until(() => text().includes('employee-handbook-2026.pdf'), 'the documents');
  if (options.folders !== false) await until(() => Boolean(q('button[aria-label^="Open folder"]')), 'the folders');
  await wait(30);
}

const rows = () => qa('tbody tr');
const folderRow = (name: string) => q(`button[aria-label="Open folder ${name}"]`)!.closest('tr') as HTMLElement;
const docRow = (fileName: string) => rows().find((tr) => tr.textContent?.includes(fileName))!;
const actionsOf = (row: Element) => q<HTMLButtonElement>('button[aria-label="Actions"]', row);
const documentRequests = () => api.to('GET', DOCUMENTS);
const lastDocumentRequest = () => documentRequests().at(-1)!;
const lastProps = <P>(probe: { mock: { calls: Array<[P]> } }) => probe.mock.calls.at(-1)![0];

async function openMenu(trigger: Element | null | undefined) {
  await click(trigger);
  await until(() => qa('[role="menuitem"]').length > 0, 'the menu');
  const items = qa('[role="menuitem"]');
  return {
    labels: items.map((i) => i.textContent?.trim()),
    item: (label: string) => items.find((i) => i.textContent?.trim() === label)!,
  };
}

/** The input behind a Mantine field label. */
const inputByLabel = <T extends HTMLElement = HTMLInputElement>(label: string) => {
  const found = qa('label').find((l) => l.textContent?.trim() === label) as HTMLLabelElement | undefined;
  return (found ? document.getElementById(found.htmlFor) : null) as T | null;
};

async function pickOption(input: HTMLElement, option: string) {
  await click(input);
  await wait(30);
  await click(qa('[role="option"]').find((o) => o.textContent?.trim() === option));
  await wait(30);
}

describe('the tab the page opens', () => {
  it('opens the one the address names, and gives an admin the Access tab', async () => {
    await open({ level: 'admin', tab: 'access', module: { access: { enabled: true, adminBypass: false } } });
    expect(tabLabels().some((label) => label.startsWith('Access'))).toBe(true);
    await until(() => text().includes('probe access tab'), 'the Access tab');

    // The tab gets the module as the page loaded it, and a counter that starts at zero.
    const props = lastProps<TabProps>(probes.tab);
    expect(props.moduleKey).toBe('kb');
    expect(props.moduleName).toBe('HR Policies');
    expect(props.access).toEqual({ enabled: true, adminBypass: false });
    expect(props.refreshKey).toBe(0);
  });

  it('opens the overview for a name it does not know', async () => {
    await open({ level: 'admin', tab: 'nonsense' });
    expect(text()).toContain('Text Extraction (OCR)');
    expect(probes.tab).not.toHaveBeenCalled();
  });

  it('sends a reader who follows a link to the Access tab to the overview', async () => {
    await open({ level: 'read', tab: 'access' });
    await until(() => text().includes('Text Extraction (OCR)'), 'the overview');
    expect(tabLabels().some((label) => label.startsWith('Access'))).toBe(false);
    expect(probes.tab).not.toHaveBeenCalled();
  });

  it('keeps the Access tab off the page of a writer too', async () => {
    await open({ level: 'write' });
    expect(tabLabels().some((label) => label.startsWith('Access'))).toBe(false);
    expect(probes.chip).not.toHaveBeenCalled();
    expect(text()).not.toContain('chip ');
  });

  it('writes the tab into the address and keeps the other parameters', async () => {
    window.history.replaceState(null, '', '/dashboard/rag/kb?mode=compact');
    await open({ level: 'admin' });
    await click(tabByLabel('Documents'));
    expect(window.location.search).toBe('?mode=compact&tab=documents');
    await click(tabByLabel('Playground'));
    expect(window.location.search).toBe('?mode=compact&tab=playground');
  });

  it('shows the access chip to admins, says whether access control is on, and opens the Access tab from it', async () => {
    await open({ level: 'admin', module: { access: { enabled: true } } });
    expect(text()).toContain('chip on');
    expect(lastProps<ChipProps>(probes.chip).enabled).toBe(true);
    await click(buttonByText('chip on'));
    await until(() => text().includes('probe access tab'), 'the Access tab');
    expect(window.location.search).toContain('tab=access');
  });

  it('says access control is off for a module that has no setting', async () => {
    await open({ level: 'admin' });
    expect(text()).toContain('chip off');
  });
});

describe('the Documents tab asks for one place at a time', () => {
  it('lists the folders of the top level ahead of its documents', async () => {
    await open({ level: 'write' });
    await documentsTab();
    expect(lastDocumentRequest().query).toMatchObject({ folderId: 'root', limit: '25', offset: '0' });
    expect(lastDocumentRequest().query.search).toBeUndefined();

    const names = rows().map((tr) => tr.textContent ?? '');
    expect(names[0]).toContain('Archive');
    expect(names[3]).toContain('Policies');
    expect(names[4]).toContain('employee-handbook-2026.pdf');
    expect(api.to('GET', FOLDERS)).toHaveLength(1);
    // The path takes the place of the module-wide count.
    expect(text()).toContain('4 folders, 3 documents');
    expect(text()).not.toContain('document(s) in this module');
  });

  it('opens a folder: its documents are asked for, the first page again', async () => {
    await open({ level: 'write', documents: { root: [HANDBOOK, SALARY, HOLIDAY], 'f-policies': [SALARY] } });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the request');

    expect(lastDocumentRequest().query).toMatchObject({ folderId: 'f-policies', offset: '0' });
    await until(() => text().includes('1 folder, 1 document'), 'the folder');
    // The subfolder is a row of the open place, the root's documents are not.
    expect(q('button[aria-label="Open folder Leave"]')).not.toBeNull();
    expect(text()).not.toContain('employee-handbook-2026.pdf');
    expect(text()).toContain('salary-bands-2026.xlsx');
  });

  it('shows no document of the place just left while the next one is on its way', async () => {
    await open({ level: 'write' });
    await documentsTab();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.on('GET', DOCUMENTS, async (call: RecordedCall) => {
      if (call.query.folderId === 'f-policies') await gate;
      const rowsOf = call.query.folderId === 'f-policies' ? [LEAVE_DOC] : [HANDBOOK, SALARY, HOLIDAY];
      return { documents: rowsOf, total: rowsOf.length, limit: 25, offset: 0 };
    });

    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the request');
    await wait(30);
    expect(text()).not.toContain('employee-handbook-2026.pdf');
    expect(text()).not.toContain('parental-leave.docx');

    release();
    await until(() => text().includes('parental-leave.docx'), 'the folder\'s documents');
    expect(text()).not.toContain('employee-handbook-2026.pdf');
  });

  it('drops the answer for a place that has been left already', async () => {
    await open({ level: 'write' });
    await documentsTab();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.on('GET', DOCUMENTS, async (call: RecordedCall) => {
      if (call.query.folderId === 'f-policies') await gate;
      const rowsOf = call.query.folderId === 'f-policies' ? [LEAVE_DOC] : [HANDBOOK, SALARY, HOLIDAY];
      return { documents: rowsOf, total: rowsOf.length, limit: 25, offset: 0 };
    });

    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => documentRequests().some((call) => call.query.folderId === 'f-policies'), 'the slow request');
    await click(q('button[aria-label="Up one level"]'));
    await until(() => text().includes('employee-handbook-2026.pdf'), 'the top level again');

    // The slow answer for Policies arrives last and must not replace the list on screen.
    release();
    await wait(80);
    expect(text()).toContain('employee-handbook-2026.pdf');
    expect(text()).not.toContain('parental-leave.docx');
  });

  it('shows a slow answer when no newer one is behind it, and drops one that arrives after a newer answer', async () => {
    await open({ level: 'admin' });
    await documentsTab();
    // Every read of the documents waits until the test answers it.
    const pending: Array<(rows: FixtureDoc[]) => void> = [];
    api.on('GET', DOCUMENTS, () => new Promise((resolve) => {
      pending.push((rowsOf) => resolve({ documents: rowsOf, total: rowsOf.length, limit: 25, offset: 0 }));
    }));
    // Two reads of the same place in flight: one from Refresh, one after a permission save.
    const issueTwo = async () => {
      const base = pending.length;
      await click(q('button[aria-label="Refresh"]'));
      await until(() => pending.length === base + 1, 'the first read');
      const menu = await openMenu(actionsOf(folderRow('Archive')));
      await click(menu.item('Permissions…'));
      await until(() => text().includes('probe editor folder:f-archive'), 'the editor');
      await click(buttonByText('probe save'));
      await until(() => pending.length === base + 2, 'the second read');
    };

    // The older read answers first, with no newer answer yet: it is shown (a server slower than the poll must not
    // leave the list frozen), and the newer one then replaces it.
    await issueTwo();
    pending[0]!([HOLIDAY]);
    await until(() => text().includes('holiday-calendar-2026.xlsx') && !text().includes('employee-handbook-2026.pdf'), 'the older answer');
    pending[1]!([SALARY]);
    await until(() => text().includes('salary-bands-2026.xlsx') && !text().includes('holiday-calendar-2026.xlsx'), 'the newer answer');

    // The newer read answers first: the older one, arriving late, must not bring back what it saw.
    await issueTwo();
    pending[3]!([HANDBOOK]);
    await until(() => text().includes('employee-handbook-2026.pdf'), 'the newer answer');
    pending[2]!([HOLIDAY]);
    await wait(80);
    expect(text()).toContain('employee-handbook-2026.pdf');
    expect(text()).not.toContain('holiday-calendar-2026.xlsx');
  });

  it('searches every folder: the request has no folder, and each result says where it is', async () => {
    await open({ level: 'write' });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the folder');

    await setInput(q<HTMLInputElement>('input[placeholder="Search all folders…"]')!, 'salary');
    await settle(450);
    await until(() => lastDocumentRequest().query.search === 'salary', 'the search');
    expect(lastDocumentRequest().query.folderId).toBeUndefined();
    await until(() => qa('thead th').some((th) => th.textContent === 'Location'), 'the Location column');
    expect(docRow('parental-leave.docx').textContent).toContain('Policies / Leave');
    expect(text()).toContain('2 documents match “salary”');
    // No folder rows while searching.
    expect(q('button[aria-label^="Open folder"]')).toBeNull();
  });

  it('keeps the place when only the status is filtered', async () => {
    await open({ level: 'write' });
    await documentsTab();
    const select = q<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'failed');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => lastDocumentRequest().query.status === 'failed', 'the request');
    expect(lastDocumentRequest().query.folderId).toBe('root');
  });

  it('leaves a folder that is gone when the lists are read again', async () => {
    await open({ level: 'write' });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the folder');

    // Someone deleted it meanwhile.
    api.on('GET', FOLDERS, () => ({ folders: ALL_FOLDERS.filter((f) => f._id !== 'f-policies' && f._id !== 'f-leave') }));
    await click(q('button[aria-label="Refresh"]'));
    await until(() => lastDocumentRequest().query.folderId === 'root', 'the top level');
    await until(() => text().includes('employee-handbook-2026.pdf'), 'the top level\'s documents');
  });

  it('keeps polling a document that is still being processed, in the folder it is in', async () => {
    const busy = doc({ _id: 'd-busy', fileName: 'quarterly-report.pdf', status: 'processing', folderId: 'f-policies' });
    await open({ level: 'write', documents: { root: [HANDBOOK], 'f-policies': [busy] } });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => text().includes('quarterly-report.pdf'), 'the folder\'s documents');
    const before = documentRequests().filter((call) => call.query.folderId === 'f-policies').length;
    await until(() => documentRequests().filter((call) => call.query.folderId === 'f-policies').length > before, 'the next poll', 8000);
  });
});

describe('without folders', () => {
  it('lists the documents as it always did, and a failing folders request makes no noise', async () => {
    await open({ folders: null });
    await documentsTab({ folders: false });
    expect(qa('button[aria-label="Actions"]')).toHaveLength(3);
    expect(q('nav[aria-label="Folder path"]')).toBeNull();
    expect(q('input[aria-label="Select all rows"]')).toBeNull();
    expect(q('input[placeholder="Search by file name…"]')).not.toBeNull();
    // The module-wide count is still the line above the list, and the upload has no folder to choose.
    expect(text()).toContain('3 document(s) in this module');
    expect(inputByLabel('Folder')).toBeNull();
    expect(notify.show).not.toHaveBeenCalled();
    // An unknown level does not ask for permission states.
    expect(api.to('POST', NODES)).toHaveLength(0);
    // The documents request still names the place: the top level.
    expect(lastDocumentRequest().query.folderId).toBe('root');
  });

  it('offers the first folder to anyone who may change the structure', async () => {
    await open({ level: 'write', folders: [] });
    await documentsTab({ folders: false });
    expect(buttonByText('New folder')).toBeDefined();
    const menu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    expect(menu.labels).toEqual(['Re-ingest', 'Delete']);
  });
});

describe('who gets which controls', () => {
  it('gives a reader the list and nothing to change', async () => {
    await open({ level: 'read' });
    await documentsTab();
    expect(qa('button[aria-label="Actions"]')).toHaveLength(0);
    expect(buttonByText('New folder')).toBeUndefined();
    expect(q('input[aria-label="Select all rows"]')).toBeNull();
    expect(qa('thead th').some((th) => th.textContent === 'Access')).toBe(false);
    // Nothing that writes: no Edit/Delete of the module, no ingest panel, no import or re-index. The export stays
    // while access control is off (it is a read then).
    for (const label of ['Edit', 'Delete', 'Import', 'Re-index All', 'Upload & Ingest']) expect(buttonByText(label)).toBeUndefined();
    expect(text()).not.toContain('Ingest Document');
    expect(buttonByText('Export')).toBeDefined();
    await wait(60);
    expect(api.to('POST', NODES)).toHaveLength(0);
  });

  it('gives a writer folders and moves while access control is off, and only the page\'s actions once it is on', async () => {
    await open({ level: 'write' });
    await documentsTab();
    expect(buttonByText('New folder')).toBeDefined();
    const folderMenu = await openMenu(actionsOf(folderRow('Archive')));
    expect(folderMenu.labels).toEqual(['Open', 'Rename…', 'Move…', 'Delete']);
    await mounted!.unmount();
    mounted = null;

    await open({ level: 'write', module: { access: { enabled: true } } });
    await documentsTab();
    expect(buttonByText('New folder')).toBeUndefined();
    expect(actionsOf(folderRow('Archive'))).toBeNull();
    const docMenu = await openMenu(actionsOf(docRow('employee-handbook-2026.pdf')));
    expect(docMenu.labels).toEqual(['Re-ingest', 'Delete']);
    // With access control on, an export or an import is for admins; the writer keeps re-index.
    expect(buttonByText('Export')).toBeUndefined();
    expect(buttonByText('Import')).toBeUndefined();
    expect(buttonByText('Re-index All')).toBeDefined();
  });

  it('gives an admin the Access column, the permission items, and the states of exactly the rows listed', async () => {
    await open({ level: 'admin', module: { access: { enabled: true } } });
    await documentsTab();
    await until(() => text().includes('Own · 3'), 'the permission states');
    expect(qa('thead th').some((th) => th.textContent === 'Access')).toBe(true);
    expect(api.to('POST', NODES).at(-1)!.body).toEqual({
      folderIds: ['f-archive', 'f-site', 'f-onboarding', 'f-policies'],
      documentIds: ['d-handbook', 'd-salary', 'd-holiday'],
    });
    const menu = await openMenu(actionsOf(docRow('salary-bands-2026.xlsx')));
    // This document has a stored original, so the page adds Re-extract.
    expect(menu.labels).toEqual(['Permissions…', 'Move…', 'Re-ingest', 'Re-extract', 'Delete']);
  });

  it('gives a document a connected source owns no Delete, and a way to the source', async () => {
    await open({ level: 'admin', documents: { root: [HANDBOOK], 'f-site': [SITE_DOC] } });
    await documentsTab();
    await click(q('button[aria-label="Open folder HR Site"]'));
    await until(() => text().includes('site-handbook.docx'), 'the folder\'s documents');
    const menu = await openMenu(actionsOf(docRow('site-handbook.docx')));
    expect(menu.labels).toEqual(['Permissions (read-only)', 'Re-ingest', 'Open connector']);
    await click(menu.item('Open connector'));
    expect(nav.router.push).toHaveBeenCalledWith('/dashboard/connectors/conn-1?tab=knowledge');
  });
});

describe('permissions', () => {
  it('opens the editor for a row with the node, the name and the folder path', async () => {
    await open({ level: 'admin', module: { access: { enabled: true, adminBypass: false } } });
    await documentsTab();
    expect(lastProps<EditorProps>(probes.editor).target).toBeNull();

    const menu = await openMenu(actionsOf(folderRow('Policies')));
    await click(menu.item('Permissions…'));
    await until(() => text().includes('probe editor folder:f-policies'), 'the editor');
    const props = lastProps<EditorProps>(probes.editor);
    expect(props.target).toEqual({ node: 'folder:f-policies', name: 'Policies', path: 'Policies' });
    expect(props.moduleKey).toBe('kb');
    expect(props.moduleName).toBe('HR Policies');
    expect(props.accessEnabled).toBe(true);
    // This module switched the admin exception off.
    expect(props.adminBypass).toBe(false);
  });

  it('reads the exception as on when the module does not say', async () => {
    await open({ level: 'admin' });
    await documentsTab();
    const props = lastProps<EditorProps>(probes.editor);
    expect(props.adminBypass).toBe(true);
    expect(props.accessEnabled).toBe(false);
  });

  it('closes the editor on a save and reads the folders, the documents and the states again', async () => {
    await open({ level: 'admin' });
    await documentsTab();
    await until(() => text().includes('Own · 3'), 'the permission states');
    const menu = await openMenu(actionsOf(docRow('salary-bands-2026.xlsx')));
    await click(menu.item('Permissions…'));
    await until(() => text().includes('probe editor document:d-salary'), 'the editor');
    expect(lastProps<EditorProps>(probes.editor).target).toEqual({ node: 'document:d-salary', name: 'salary-bands-2026.xlsx', path: '' });

    const before = { folders: api.to('GET', FOLDERS).length, documents: documentRequests().length, nodes: api.to('POST', NODES).length };
    await click(buttonByText('probe save'));
    await until(() => !text().includes('probe editor'), 'the editor to close');
    await until(() => api.to('POST', NODES).length === before.nodes + 1, 'the states to be read again');
    expect(api.to('GET', FOLDERS)).toHaveLength(before.folders + 1);
    expect(documentRequests()).toHaveLength(before.documents + 1);
  });

  it('closes the editor without reading anything when it is dismissed', async () => {
    await open({ level: 'admin' });
    await documentsTab();
    await until(() => text().includes('Own · 3'), 'the permission states');
    const menu = await openMenu(actionsOf(folderRow('Archive')));
    await click(menu.item('Permissions…'));
    await until(() => text().includes('probe editor folder:f-archive'), 'the editor');
    const before = { folders: api.to('GET', FOLDERS).length, nodes: api.to('POST', NODES).length };
    await click(buttonByText('probe close'));
    await until(() => !text().includes('probe editor'), 'the editor to close');
    await wait(60);
    expect(api.to('GET', FOLDERS)).toHaveLength(before.folders);
    expect(api.to('POST', NODES)).toHaveLength(before.nodes);
  });
});

describe('the Access tab and the Documents tab', () => {
  it('shows a folder in the Documents tab, leaving a search behind', async () => {
    await open({ level: 'admin', tab: 'access' });
    await until(() => text().includes('probe access tab'), 'the Access tab');
    await click(buttonByText('probe show Policies'));
    await until(() => text().includes('1 folder, 0 documents'), 'the folder');

    expect(window.location.search).toContain('tab=documents');
    expect(lastDocumentRequest().query).toMatchObject({ folderId: 'f-policies', offset: '0' });
    expect(lastDocumentRequest().query.search).toBeUndefined();
    expect(q('nav[aria-label="Folder path"]')!.textContent).toContain('Policies');
  });

  it('shows the top level for a null folder', async () => {
    await open({ level: 'admin' });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the folder');
    await click(tabByLabel('Access'));
    await until(() => text().includes('probe access tab'), 'the Access tab');
    await click(buttonByText('probe show top level'));
    await until(() => lastDocumentRequest().query.folderId === 'root', 'the top level');
  });

  it('opens the editor from the Access tab for the default access', async () => {
    await open({ level: 'admin', tab: 'access' });
    await until(() => text().includes('probe access tab'), 'the Access tab');
    await click(buttonByText('probe edit default access'));
    await until(() => text().includes('probe editor module'), 'the editor');
    expect(lastProps<EditorProps>(probes.editor).target).toEqual({ node: 'module', name: 'HR Policies' });
  });

  it('reads the module and the lists again when the tab changed the switches', async () => {
    await open({ level: 'admin', tab: 'access' });
    await until(() => text().includes('probe access tab'), 'the Access tab');
    const before = { module: api.to('GET', MODULE).length, folders: api.to('GET', FOLDERS).length, refresh: lastProps<TabProps>(probes.tab).refreshKey };
    await click(buttonByText('probe module changed'));
    await until(() => api.to('GET', MODULE).length === before.module + 1, 'the module');
    await until(() => api.to('GET', FOLDERS).length === before.folders + 1, 'the folders');
    // The tab itself is told to read again.
    await until(() => lastProps<TabProps>(probes.tab).refreshKey === before.refresh + 1, 'the counter');
  });
});

describe('uploading', () => {
  async function pasteText(name: string, content: string) {
    await click(qa('label').find((l) => l.textContent?.trim() === 'Paste Text'));
    await until(() => Boolean(inputByLabel('File Name')), 'the text form');
    await setInput(inputByLabel('File Name')!, name);
    await setInput(inputByLabel<HTMLTextAreaElement>('Content')!, content);
  }

  it('sends no folder to the top level, and the open folder once one is open', async () => {
    await open({ level: 'write' });
    await documentsTab();
    await pasteText('notes.txt', 'Some notes');
    expect(inputByLabel('Folder')!.value).toBe('Top level');
    await click(buttonByText('Ingest Document'));
    await until(() => api.to('POST', DOCUMENTS).length === 1, 'the request');
    const topLevel = api.to('POST', DOCUMENTS)[0]!.body as Record<string, unknown>;
    expect(topLevel.fileName).toBe('notes.txt');
    // Not even a null: the server reads a missing folder as the top level.
    expect('folderId' in topLevel).toBe(false);

    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the folder');
    await pasteText('rules.txt', 'Some rules');
    expect(inputByLabel('Folder')!.value).toBe('Policies');
    await click(buttonByText('Ingest Document'));
    await until(() => api.to('POST', DOCUMENTS).length === 2, 'the request');
    expect((api.to('POST', DOCUMENTS)[1]!.body as Record<string, unknown>).folderId).toBe('f-policies');
  });

  it('lets the upload go to another folder than the open one, and says which permissions it follows', async () => {
    await open({ level: 'write' });
    await documentsTab();
    expect(text()).toContain('New documents follow this folder\'s permissions.');
    await pasteText('notes.txt', 'Some notes');
    await pickOption(inputByLabel('Folder')!, 'Policies / Leave');
    expect(inputByLabel('Folder')!.value).toBe('Policies / Leave');
    await click(buttonByText('Ingest Document'));
    await until(() => api.to('POST', DOCUMENTS).length === 1, 'the request');
    expect((api.to('POST', DOCUMENTS)[0]!.body as Record<string, unknown>).folderId).toBe('f-leave');
  });

  it('reads the folders again after an upload, since the counts changed', async () => {
    await open({ level: 'write' });
    await documentsTab();
    const before = api.to('GET', FOLDERS).length;
    await pasteText('notes.txt', 'Some notes');
    await click(buttonByText('Ingest Document'));
    await until(() => api.to('GET', FOLDERS).length === before + 1, 'the folders to be read again');
  });

  it('sends the folder with an uploaded file as well', async () => {
    await open({ level: 'write' });
    await documentsTab();
    await click(q('button[aria-label="Open folder Policies"]'));
    await until(() => lastDocumentRequest().query.folderId === 'f-policies', 'the folder');

    const input = qa<HTMLInputElement>('input[type="file"]').find((el) => el.accept.includes('.pdf'))!;
    Object.defineProperty(input, 'files', { configurable: true, value: [makeFile('policy.txt', { type: 'text/plain' })] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => Boolean(buttonByText('Upload & Ingest')) && !(buttonByText('Upload & Ingest') as HTMLButtonElement).disabled, 'the file to be chosen');
    await click(buttonByText('Upload & Ingest'));
    await until(() => api.to('POST', DOCUMENTS).length === 1, 'the request');
    const body = api.to('POST', DOCUMENTS)[0]!.body as Record<string, unknown>;
    expect(body.fileName).toBe('policy.txt');
    expect(body.folderId).toBe('f-policies');
    expect(String(body.data)).toMatch(/^data:/);
  });

  it('follows a folder that was deleted back to the top level', async () => {
    await open({ level: 'write' });
    await documentsTab();
    await pasteText('notes.txt', 'Some notes');
    await pickOption(inputByLabel('Folder')!, 'Onboarding');
    // The folder disappears from the list before the upload.
    api.on('GET', FOLDERS, () => ({ folders: ALL_FOLDERS.filter((f) => f._id !== 'f-onboarding') }));
    await click(q('button[aria-label="Refresh"]'));
    await until(() => !q('button[aria-label="Open folder Onboarding"]'), 'the list to change');
    await click(buttonByText('Ingest Document'));
    await until(() => api.to('POST', DOCUMENTS).length === 1, 'the request');
    expect('folderId' in (api.to('POST', DOCUMENTS)[0]!.body as Record<string, unknown>)).toBe(false);
  });
});

describe('changing the structure from the page', () => {
  it('creates a folder and reads the lists again', async () => {
    await open({ level: 'write' });
    await documentsTab();
    const before = { folders: api.to('GET', FOLDERS).length, documents: documentRequests().length };
    await click(buttonByText('New folder'));
    await until(() => Boolean(q('.form-overlay')), 'the form');
    await setInput(q<HTMLInputElement>('input[aria-label="Folder name"]')!, 'Contracts');
    await click(buttonByText('Create folder', q('.form-overlay')!));
    await until(() => !q('.form-overlay'), 'the form to close');

    expect(api.to('POST', FOLDERS)[0]!.body).toEqual({ name: 'Contracts', parentId: null });
    expect(api.to('GET', FOLDERS)).toHaveLength(before.folders + 1);
    expect(documentRequests()).toHaveLength(before.documents + 1);
  });

  it('keeps the failure of a documents request in place of the list, with the path kept', async () => {
    await open({ level: 'write' });
    await documentsTab();
    api.on('GET', DOCUMENTS, () => jsonResponse({ error: 'boom' }, 500));
    // The page logs a failed load; it is the point of the test, not noise to show.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await click(q('button[aria-label="Open folder Policies"]'));
      await until(() => text().includes('Failed to load documents (HTTP 500)'), 'the error');
      expect(q('nav[aria-label="Folder path"]')).not.toBeNull();
      expect(q('table')).toBeNull();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
