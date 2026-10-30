// @vitest-environment jsdom
/**
 * The permission editor in a DOM, against a mocked `fetch`: a node that inherits becoming one with its own list (a
 * copy of what it inherited), going back, the root and what an empty list means, adding people, groups, API
 * tokens, addresses and directory entries, removing them, a synced node that cannot change, the confirm before a list
 * nobody is on is saved, and what a save sends.
 */

import { createElement as h } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import {
  RagPermissionEditor,
  type RagPermissionEditorProps,
  type RagPermissionTarget,
} from '@/components/rag/access/RagPermissionEditor';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
  type RecordedCall,
} from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  notify.show.mockReset();
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/* ── fixtures ────────────────────────────────────────────────────────────── */

type Entry = { principal: string; kind: string; label?: string; managed?: 'sync' };

const GROUP_HR: Entry = { principal: 'group:g-hr', kind: 'group', label: 'HR' };
const ADA: Entry = { principal: 'user:u-ada', kind: 'user', label: 'Ada Example' };
const LEGAL: Entry = { principal: 'email:legal@example.com', kind: 'email', label: 'legal@example.com' };
const TEAM: Entry = { principal: 'x:sp:g:grp-hr', kind: 'external_group', label: 'HR Team' };
const BOT: Entry = { principal: 'token:t-bot', kind: 'token', label: 'HR chatbot' };
const INHERITED = [GROUP_HR, ADA, LEGAL];

const AUDIENCE: Record<string, unknown> = {
  'group:g-hr': { kind: 'group', label: 'HR', exists: true, people: 24 },
  'user:u-ada': { kind: 'user', label: 'Ada Example', detail: 'ada@example.com', exists: true, people: 1 },
  'email:legal@example.com': { kind: 'email', exists: true, people: 0 },
  'x:sp:g:grp-hr': { kind: 'external_group', label: 'HR Team', detail: 'HR SharePoint', exists: true, people: 14 },
  'token:t-bot': { kind: 'token', label: 'HR chatbot', exists: true, people: null },
  'x:sp:all': { kind: 'external_all', label: 'All members', detail: 'HR SharePoint', exists: true, people: null },
};

const FOLDERS = [
  { _id: 'f-policies', name: 'Policies', path: 'Policies', aclMode: 'own' },
  { _id: 'f-leave', parentId: 'f-policies', name: 'Leave', path: 'Policies/Leave', aclMode: 'inherit' },
  { _id: 'f-top', name: 'Archive', path: 'Archive', aclMode: 'inherit' },
  { _id: 'f-benefits', name: 'Benefits', path: 'Benefits', aclMode: 'own', aclManaged: 'sync', source: { kind: 'connector', connectorId: 'conn-1', sourceId: 's1', externalId: 'x1' } },
];

const ROOT_EFFECTIVE = { node: { type: 'module', id: 'kb' }, entries: [] as Entry[], openToEveryone: true };

function aclView(node: string, mode: 'own' | 'inherit', entries: Entry[], effective: unknown, managed?: 'sync') {
  const [type, id] = node === 'module' ? ['module', 'kb'] : (node.split(':') as [string, string]);
  return { node: { type, id }, mode, ...(managed ? { managed } : {}), entries: mode === 'own' ? entries : [], effective };
}

const ownEffective = (type: string, id: string, entries: Entry[]) => ({ node: { type, id }, entries });

/** What the server holds, by node. */
function nodes(): Record<string, unknown> {
  return {
    module: aclView('module', 'own', [GROUP_HR, LEGAL], ownEffective('module', 'kb', [GROUP_HR, LEGAL])),
    'folder:f-policies': aclView('folder:f-policies', 'own', INHERITED, ownEffective('folder', 'f-policies', INHERITED)),
    'folder:f-leave': aclView('folder:f-leave', 'inherit', [], ownEffective('folder', 'f-policies', INHERITED)),
    'folder:f-top': aclView('folder:f-top', 'inherit', [], ROOT_EFFECTIVE),
    'folder:f-benefits': aclView('folder:f-benefits', 'own', [{ ...TEAM, managed: 'sync' }], ownEffective('folder', 'f-benefits', [TEAM]), 'sync'),
    'document:d-1': aclView('document:d-1', 'inherit', [], ownEffective('folder', 'f-policies', INHERITED)),
  };
}

interface Setup {
  nodes?: Record<string, unknown>;
  /** What the head count says about a key, on top of the usual. */
  audience?: Record<string, unknown>;
  put?: (call: RecordedCall) => unknown;
  folders?: () => unknown;
  domains?: () => unknown;
}

function install(setup: Setup = {}) {
  const held = { ...nodes(), ...setup.nodes };
  api = installApiMock([
    ['GET', '/api/rag/modules/kb/acl', (call) => {
      const view = held[call.query.node ?? 'module'];
      return view ? { acl: view } : jsonResponse({ error: 'Folder not found', code: 'folder_not_found' }, 404);
    }],
    ['PUT', '/api/rag/modules/kb/acl', (call) => {
      if (setup.put) return setup.put(call);
      const body = call.body as { node: string; mode: 'own' | 'inherit'; entries: Array<{ principal: string; label?: string }> };
      return { acl: aclView(body.node, body.mode, body.entries.map((entry) => ({ ...entry, kind: 'user' })), ownEffective('folder', 'x', [])) };
    }],
    ['GET', '/api/rag/modules/kb/folders', () => setup.folders?.() ?? { folders: FOLDERS }],
    ['POST', '/api/rag/modules/kb/access/audience', (call) => {
      const known = { ...AUDIENCE, ...setup.audience };
      return {
        audience: Object.fromEntries(((call.body as { principals: string[] }).principals).filter((key) => key in known).map((key) => [key, known[key]])),
      };
    }],
    ['GET', '/api/rag/modules/kb/access/principals', (call) => {
      const all = {
        user: [{ principal: 'user:u-ada', kind: 'user', label: 'Ada Example', detail: 'ada@example.com' }, { principal: 'user:u-bob', kind: 'user', label: 'Bob Sample', detail: 'bob@example.com' }],
        group: [{ principal: 'group:g-hr', kind: 'group', label: 'HR', detail: '24 people' }, { principal: 'group:g-eng', kind: 'group', label: 'Engineering', detail: '60 people' }],
        token: [{ principal: 'token:t-bot', kind: 'token', label: 'HR chatbot', detail: 'cp_live_ab12' }],
      }[call.query.type as 'user' | 'group' | 'token'] ?? [];
      const words = (call.query.q ?? '').toLowerCase();
      return { items: all.filter((item) => item.label.toLowerCase().includes(words)) };
    }],
    ['GET', '/api/rag/identity/domains', () => setup.domains?.() ?? { domains: [{ key: 'sp', kind: 'generic', label: 'HR SharePoint', userMatch: [] }] }],
    ['GET', '/api/rag/identity/domains/sp/users', (call) => ({
      users: [
        { domain: 'sp', extId: 'ext-1', name: 'Ada Example', email: 'ada@example.com', type: 'member' },
        { domain: 'sp', extId: 'ext-2', name: 'Sam Guest', email: 'sam@partner.example.com', type: 'guest' },
      ].filter((user) => user.name.toLowerCase().includes((call.query.search ?? '').toLowerCase())),
      total: 2,
    })],
    ['GET', '/api/rag/identity/domains/sp/groups', () => ({
      groups: [{ id: 'grp-hr', name: 'HR Team', users: 14, console: [] }, { id: 'grp-raw', users: 3, console: [] }],
      total: 2,
    })],
  ]);
}

interface Handlers {
  onClose: Mock<RagPermissionEditorProps['onClose']>;
  onSaved: Mock<RagPermissionEditorProps['onSaved']>;
}

async function open(target: RagPermissionTarget, over: Partial<RagPermissionEditorProps> = {}, setup: Setup = {}): Promise<Handlers> {
  install(setup);
  const handlers: Handlers = { onClose: vi.fn<RagPermissionEditorProps['onClose']>(), onSaved: vi.fn<RagPermissionEditorProps['onSaved']>() };
  mounted = await mount(h(RagPermissionEditor, {
    moduleKey: 'kb',
    moduleName: 'HR Policies',
    target,
    accessEnabled: true,
    adminBypass: true,
    ...handlers,
    ...over,
  }));
  await until(() => text().includes('Permissions') && !q('[aria-label="Loading permissions"]'), 'the editor');
  return handlers;
}

const LEAVE: RagPermissionTarget = { node: 'folder:f-leave', name: 'Leave', path: 'Policies/Leave' };
const POLICIES: RagPermissionTarget = { node: 'folder:f-policies', name: 'Policies', path: 'Policies' };
const TOP: RagPermissionTarget = { node: 'folder:f-top', name: 'Archive', path: 'Archive' };
const BENEFITS: RagPermissionTarget = { node: 'folder:f-benefits', name: 'Benefits', path: 'Benefits' };
const ROOT: RagPermissionTarget = { node: 'module', name: 'HR Policies' };

const radio = (label: string) =>
  qa<HTMLInputElement>('input[type="radio"]').find((input) => [...(input.labels ?? [])].some((l) => l.textContent?.includes(label)))!;

const list = () => q('[role="list"][aria-label="Who can read"]');
const rows = () => (list() ? qa('[role="listitem"]', list()!) : []);
const rowTexts = () => rows().map((row) => row.textContent ?? '');
const removeIn = (row: HTMLElement) => buttonByText('Remove', row)!;

const tab = (name: string) => qa('[role="tab"]').find((t) => t.textContent === name)!;
const results = () => q('[role="list"][aria-label="Results"]');
const shown = (words: string) => (results()?.textContent ?? '').includes(words);
const resultRow = (name: string) => qa('[role="listitem"]', results() ?? document.body).find((row) => row.textContent?.includes(name))!;

async function search(label: string, words: string) {
  await setInput(q<HTMLInputElement>(`input[aria-label="${label}"]`)!, words);
  await settle(450);
}

const saveButton = () => buttonByText('Save') as HTMLButtonElement;
const puts = () => api.to('PUT', '/api/rag/modules/kb/acl');

async function save() {
  await click(saveButton());
  await until(() => puts().length > 0, 'the save');
  return puts()[0]!.body as { node: string; mode: string; entries: Array<{ principal: string; label?: string }> };
}

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('the screen', () => {
  it('renders nothing while there is no node to edit', async () => {
    install();
    mounted = await mount(h(RagPermissionEditor, {
      moduleKey: 'kb', moduleName: 'HR Policies', target: null, accessEnabled: true, adminBypass: true, onClose: vi.fn(), onSaved: vi.fn(),
    }));
    expect(q('.form-overlay')).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('is titled Permissions and names the node and where it is', async () => {
    await open(LEAVE);
    expect(q('.form-overlay')).not.toBeNull();
    expect(text()).toContain('Permissions');
    expect(text()).toContain('Folder · HR Policies / Policies / Leave');
  });

  it('names a document by its folder and its own name', async () => {
    await open({ node: 'document:d-1', name: 'handbook.pdf', path: 'Policies' });
    expect(text()).toContain('Document · HR Policies / Policies / handbook.pdf');
    expect(text()).toContain('Inherit from Policies');
  });

  it('summarises the node, where its permissions come from, the entries and the enforcement', async () => {
    await open(POLICIES, { accessEnabled: true, adminBypass: false });
    const page = text();
    expect(page).toMatch(/Permissions come from\s*Its own list/);
    expect(page).toMatch(/Entries\s*3 of 1,000/);
    expect(page).toMatch(/Enforcement\s*On/);
    expect(page).toMatch(/Admin exception\s*Off/);
  });

  it('says so when access control is off: the permissions are stored and apply once it is on', async () => {
    await open(POLICIES, { accessEnabled: false });
    expect(text()).toContain('Access control is off for this knowledge engine: these permissions are stored and apply once it is turned on in the Access tab.');
    expect(text()).toMatch(/Enforcement\s*Off · stored, not applied/);
  });
});

describe('a node that inherits', () => {
  it('says from which node, and who can read now, and shows no list of its own', async () => {
    await open(LEAVE);
    expect(text()).toContain('Where its permissions come from');
    expect(text()).toContain('Inherit from Policies');
    await until(() => text().includes('Now readable by Group HR, Ada Example and legal@example.com.'), 'the inherited readers');
    expect(text()).toContain('Give it its own permissions');
    expect(text()).toContain('Replaces what it inherits. Its subfolders and documents that inherit follow this list. Starts as a copy of the inherited list.');
    expect(radio('Inherit from').checked).toBe(true);
    expect(text()).not.toContain('Who can read');
    expect(text()).not.toContain('Nobody can read the documents here.');
    // What it inherits is already in the answer: nothing else is asked.
    expect(api.to('GET', '/api/rag/modules/kb/acl')).toHaveLength(1);
  });

  it('gives it its own list as a copy of what it inherited, and saves that', async () => {
    const { onSaved, onClose } = await open(LEAVE);
    await click(radio('Give it its own permissions'));
    await until(() => rows().length === 3, 'the copied list');
    await until(() => rowTexts().some((row) => row.includes('Group · 24 people')), 'the details');
    expect(rowTexts()[0]).toContain('HR');
    expect(text()).toContain('3 of 1,000');
    expect(text()).toContain('Unsaved changes');

    const body = await save();
    expect(body).toEqual({
      node: 'folder:f-leave',
      mode: 'own',
      entries: [
        { principal: 'group:g-hr', label: 'HR' },
        { principal: 'user:u-ada', label: 'Ada Example' },
        { principal: 'email:legal@example.com', label: 'legal@example.com' },
      ],
    });
    await until(() => onSaved.mock.calls.length === 1, 'the callback');
    expect(onSaved.mock.calls[0]![0]).toMatchObject({ mode: 'own' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notify.show.mock.calls[0]![0]).toMatchObject({ color: 'green', title: 'Permissions saved', message: 'Leave' });
  });

  it('copies a default nobody is named on as everyone, never as an empty list that would close the node', async () => {
    await open(TOP);
    expect(text()).toContain('Inherit from the default access');
    expect(text()).toContain('Now readable by everyone who can open this knowledge engine.');
    await click(radio('Give it its own permissions'));
    await until(() => rows().length === 1, 'the copy');
    expect(rowTexts()[0]).toContain('Everyone who can open this knowledge engine');
    expect(text()).not.toContain('Nobody can read the documents here.');
    expect((await save()).entries).toEqual([{ principal: 'everyone' }]);
  });

  it('has nothing to save until something changed', async () => {
    await open(LEAVE);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    await click(saveButton());
    expect(puts()).toHaveLength(0);
  });
});

describe('a node with its own list', () => {
  it('lists who can read, by name and with what each one reaches', async () => {
    await open(POLICIES);
    expect(text()).toContain('3 of 1,000');
    await until(() => rowTexts().some((row) => row.includes('Group · 24 people')), 'the details');
    const listed = rowTexts();
    expect(listed).toHaveLength(3);
    expect(listed.some((row) => row.includes('Ada Example') && row.includes('Person · ada@example.com'))).toBe(true);
    expect(listed.some((row) => row.includes('legal@example.com') && row.includes('E-mail · no console person with this address yet'))).toBe(true);
  });

  it('describes directory groups, API tokens and members of a directory', async () => {
    await open(POLICIES, {}, {
      nodes: { 'folder:f-policies': aclView('folder:f-policies', 'own', [TEAM, BOT, { principal: 'x:sp:all', kind: 'external_all', label: 'All members of HR SharePoint' }], ownEffective('folder', 'f-policies', [TEAM])) },
    });
    await until(() => rowTexts().some((row) => row.includes('HR SharePoint group · matches 14 console people')), 'the group');
    const listed = rowTexts();
    expect(listed.some((row) => row.includes('HR Team'))).toBe(true);
    expect(listed.some((row) => row.includes('HR chatbot') && row.includes('API token · for calls without a person'))).toBe(true);
    expect(listed.some((row) => row.includes('All members') && row.includes('HR SharePoint · guests not included'))).toBe(true);
  });

  it('marks an entry whose person, group or token is gone, and keeps the name it was saved with', async () => {
    const entries: Entry[] = [
      { principal: 'user:u-gone', kind: 'user', label: 'Old Name' },
      { principal: 'group:g-gone', kind: 'group', label: 'Old Group' },
      { principal: 'token:t-gone', kind: 'token', label: 'Old Token' },
    ];
    await open(POLICIES, {}, {
      nodes: { 'folder:f-policies': aclView('folder:f-policies', 'own', entries, ownEffective('folder', 'f-policies', [])) },
      audience: {
        'user:u-gone': { kind: 'user', exists: false, people: 0 },
        'group:g-gone': { kind: 'group', exists: false, people: 0 },
        'token:t-gone': { kind: 'token', exists: false, people: null },
      },
    });
    await until(() => rowTexts().some((row) => row.includes('Person · no longer exists')), 'the head count');
    const listed = rowTexts();
    expect(listed.some((row) => row.includes('Old Name') && row.includes('Person · no longer exists'))).toBe(true);
    expect(listed.some((row) => row.includes('Old Group') && row.includes('Group · no longer exists'))).toBe(true);
    expect(listed.some((row) => row.includes('Old Token') && row.includes('API token · no longer exists'))).toBe(true);
  });

  it('goes back to inheriting from the parent, says its own list is deleted, and saves that', async () => {
    await open(POLICIES);
    // Its parent is the root: the list it would inherit is the default access.
    await until(() => text().includes('Now readable by Group HR and legal@example.com.'), 'the parent list');
    expect(text()).toContain('Inherit from the default access');
    expect(text()).not.toContain('Saving this deletes its own list.');
    await click(radio('Inherit from'));
    expect(text()).toContain('Saving this deletes its own list.');
    expect(text()).not.toContain('Who can read');
    expect(api.to('GET', '/api/rag/modules/kb/acl').map((call) => call.query.node)).toEqual(['folder:f-policies', 'module']);
    expect(await save()).toEqual({ node: 'folder:f-policies', mode: 'inherit', entries: [] });
  });

  it('names its parent folder, and reads what that parent decides', async () => {
    await open(LEAVE, {}, {
      nodes: { 'folder:f-leave': aclView('folder:f-leave', 'own', [ADA], ownEffective('folder', 'f-leave', [ADA])) },
    });
    await until(() => text().includes('Inherit from Policies'), 'the parent');
    await until(() => text().includes('Now readable by Group HR, Ada Example and legal@example.com.'), 'the parent list');
    expect(api.to('GET', '/api/rag/modules/kb/acl').map((call) => call.query.node)).toEqual(['folder:f-leave', 'folder:f-policies']);
  });

  it('keeps its list when the person flips to inherit and back, and is then unchanged', async () => {
    await open(POLICIES);
    await click(radio('Inherit from'));
    expect(saveButton().getAttribute('aria-disabled')).toBeNull();
    await click(radio('Give it its own permissions'));
    expect(rows()).toHaveLength(3);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    expect(text()).not.toContain('Unsaved changes');
  });

  it('removes an entry', async () => {
    await open(POLICIES);
    await until(() => rows().length === 3, 'the list');
    await click(removeIn(rows().find((row) => row.textContent?.includes('Ada Example'))!));
    expect(rows()).toHaveLength(2);
    expect(text()).toContain('2 of 1,000');
    const body = await save();
    expect(body.entries.map((entry) => entry.principal)).toEqual(['group:g-hr', 'email:legal@example.com']);
  });

  it('falls back to "its parent" when the folders cannot be read', async () => {
    await open(LEAVE, {}, { folders: () => jsonResponse({ error: 'Not now' }, 500) });
    expect(text()).toContain('Inherit from its parent');
    // What it inherits now is still known from its own answer.
    await until(() => text().includes('Now readable by Group HR, Ada Example and legal@example.com.'), 'the readers');
  });
});

describe('an empty list', () => {
  async function emptied(over: Partial<RagPermissionEditorProps> = {}) {
    const handlers = await open(POLICIES, over);
    await until(() => rows().length === 3, 'the list');
    for (let left = 3; left > 0; left -= 1) await click(removeIn(rows()[0]!));
    return handlers;
  }

  it('warns that nobody can read, and that admins still can while the admin exception is on', async () => {
    await emptied({ adminBypass: true });
    expect(text()).toContain('Nobody can read the documents here.');
    expect(text()).toContain('Admins of this knowledge engine still can, because the admin exception is on.');
    expect(text()).toContain('0 of 1,000');
  });

  it('warns that not even admins can read when the admin exception is off', async () => {
    await emptied({ adminBypass: false });
    expect(text()).toContain('Nobody can read the documents here.');
    expect(text()).toContain('Not even admins of this knowledge engine: the admin exception is off.');
  });

  it('asks before saving it, and saves nothing when the answer is no', async () => {
    const { onClose } = await emptied();
    await click(saveButton());
    await until(() => text().includes('Save a list nobody is on?'), 'the confirm');
    expect(text()).toContain('Nobody can read the documents here. Admins of this knowledge engine still can, because the admin exception is on.');
    await click(buttonByText('Cancel', q('[role="dialog"]:not(.form-overlay)') ?? undefined));
    await until(() => !text().includes('Save a list nobody is on?'), 'the dialog to close');
    expect(puts()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('saves it, as a list with no entries, once confirmed', async () => {
    await emptied({ adminBypass: false });
    await click(saveButton());
    await until(() => text().includes('Save a list nobody is on?'), 'the confirm');
    expect(text()).toContain('Not even admins of this knowledge engine: the admin exception is off.');
    await click(buttonByText('Save anyway'));
    await until(() => puts().length === 1, 'the save');
    expect(puts()[0]!.body).toEqual({ node: 'folder:f-policies', mode: 'own', entries: [] });
  });
});

describe('the default access (the root)', () => {
  it('has no choice to inherit and is titled by the knowledge engine', async () => {
    await open(ROOT);
    expect(text()).toContain('Default access · HR Policies');
    expect(text()).not.toContain('Where its permissions come from');
    expect(radio('Inherit from')).toBeUndefined();
    expect(text()).toContain('Who can read');
    expect(text()).toContain('2 of 1,000');
    // Only its own answer is needed: it has no parent and no folders to look at.
    expect(api.calls.filter((call) => call.path.endsWith('/folders'))).toHaveLength(0);
  });

  it('reads as everyone when it names nobody, with no warning and no confirm on save', async () => {
    await open(ROOT);
    await until(() => rows().length === 2, 'the list');
    await click(removeIn(rows()[0]!));
    await click(removeIn(rows()[0]!));
    expect(text()).toContain('Everyone who can open this knowledge engine (the default)');
    expect(text()).not.toContain('Nobody can read the documents here.');
    await click(saveButton());
    await until(() => puts().length === 1, 'the save without a confirm');
    expect(puts()[0]!.body).toEqual({ node: 'module', mode: 'own', entries: [] });
    expect(text()).not.toContain('Save a list nobody is on?');
  });
});

describe('adding', () => {
  async function ownList() {
    return open(POLICIES, {}, { nodes: { 'folder:f-policies': aclView('folder:f-policies', 'own', [GROUP_HR], ownEffective('folder', 'f-policies', [GROUP_HR])) } });
  }

  it('offers everyone who can open the knowledge engine, once', async () => {
    await ownList();
    const everyone = qa('button').find((b) => b.getAttribute('aria-label') === 'Add Everyone who can open this knowledge engine')!;
    await click(everyone);
    expect(rowTexts().some((row) => row.includes('Everyone who can open this knowledge engine') && row.includes('Everyone · including calls without a person'))).toBe(true);
    expect(buttonByText('Added')).toBeDefined();
    expect((await save()).entries.map((entry) => entry.principal)).toEqual(['everyone', 'group:g-hr']);
  });

  it('finds people on the server, adds one with its name, and shows it as added', async () => {
    await ownList();
    await until(() => results() !== null, 'the first page');
    await search('Search people', 'ada');
    expect(api.to('GET', '/api/rag/modules/kb/access/principals').some((call) => call.query.type === 'user' && call.query.q === 'ada')).toBe(true);
    expect(resultRow('Ada Example').textContent).toContain('ada@example.com');
    expect(results()!.textContent).not.toContain('Bob Sample');
    await click(buttonByText('Add', resultRow('Ada Example')));
    expect(rowTexts().some((row) => row.includes('Ada Example'))).toBe(true);
    expect(buttonByText('Added', resultRow('Ada Example'))).toBeDefined();
    expect((await save()).entries).toEqual([{ principal: 'user:u-ada', label: 'Ada Example' }, { principal: 'group:g-hr', label: 'HR' }]);
  });

  it('adds a group', async () => {
    await ownList();
    await click(tab('Groups'));
    await until(() => shown('Engineering'), 'the groups');
    expect(resultRow('HR').textContent).toContain('Added');
    await click(buttonByText('Add', resultRow('Engineering')));
    expect((await save()).entries[0]).toEqual({ principal: 'group:g-eng', label: 'Engineering' });
  });

  it('adds an API token and says what it is for', async () => {
    await ownList();
    await click(tab('API tokens'));
    await until(() => shown('HR chatbot'), 'the tokens');
    expect(text()).toContain('An API token reads for calls without a person');
    await click(buttonByText('Add', resultRow('HR chatbot')));
    expect((await save()).entries[0]).toEqual({ principal: 'token:t-bot', label: 'HR chatbot' });
  });

  it('adds an e-mail address in its canonical form, and refuses what is not an address or is there already', async () => {
    await ownList();
    await click(tab('E-mail'));
    const input = q<HTMLInputElement>('input[aria-label="E-mail address"]')!;
    // The Add of this tab, not the one of the Everyone row above it.
    const add = () => buttonByText('Add', input.closest('[role="tabpanel"]') as HTMLElement) as HTMLButtonElement;
    expect(add().disabled).toBe(true);

    await setInput(input, 'not-an-address');
    expect(add().disabled).toBe(false);
    await click(add());
    expect(text()).toContain('Enter an e-mail address such as name@example.com.');
    expect(rows()).toHaveLength(1);

    await setInput(input, '  Legal@Example.COM ');
    expect(text()).not.toContain('Enter an e-mail address');
    await click(add());
    expect(input.value).toBe('');
    await until(() => rows().length === 2, 'the entry');
    await until(() => rowTexts().some((row) => row.includes('E-mail · no console person with this address yet')), 'the head count');

    await setInput(input, 'legal@example.com');
    await click(add());
    expect(text()).toContain('This address is already in the list.');
    expect(rows()).toHaveLength(2);

    expect((await save()).entries[0]).toEqual({ principal: 'email:legal@example.com', label: 'legal@example.com' });
  });

  it('adds a directory user, group, and all members, each with its label', async () => {
    await ownList();
    await click(tab('From a connector'));
    // One directory needs no choosing.
    await until(() => q('input[aria-label="Search users"]') !== null, 'the directory');
    await search('Search users', 'ada');
    expect(api.to('GET', '/api/rag/identity/domains/sp/users').some((call) => call.query.search === 'ada' && call.query.limit === '20')).toBe(true);
    await click(buttonByText('Add', resultRow('Ada Example')));

    await click(qa<HTMLElement>('label').find((l) => l.textContent === 'Groups')!);
    await until(() => shown('HR Team'), 'the groups');
    expect(resultRow('HR Team').textContent).toContain('HR SharePoint group · 14 people');
    // A group without a name is listed by its id.
    expect(results()!.textContent).toContain('grp-raw');
    await click(buttonByText('Add', resultRow('HR Team')));

    await click(qa<HTMLElement>('label').find((l) => l.textContent === 'All members')!);
    await until(() => text().includes('HR SharePoint · guests not included'), 'all members');
    await click(buttonByText('Add', resultRow('All members')));

    expect((await save()).entries).toEqual([
      { principal: 'x:sp:all', label: 'All members of HR SharePoint' },
      { principal: 'x:sp:g:grp-hr', label: 'HR Team' },
      { principal: 'x:sp:u:ext-1', label: 'Ada Example' },
      { principal: 'group:g-hr', label: 'HR' },
    ]);
  });

  it('marks a directory guest as one', async () => {
    await ownList();
    await click(tab('From a connector'));
    await until(() => q('input[aria-label="Search users"]') !== null, 'the directory');
    await until(() => shown('Sam Guest'), 'the users');
    expect(resultRow('Sam Guest').textContent).toContain('sam@partner.example.com · guest');
  });

  it('asks which directory when there are several', async () => {
    await open(POLICIES, {}, {
      domains: () => ({ domains: [{ key: 'sp', kind: 'generic', label: 'HR SharePoint', userMatch: [] }, { key: 'api', kind: 'generic', label: 'Partner system (API)', userMatch: [] }] }),
    });
    await click(tab('From a connector'));
    const choice = () => qa<HTMLInputElement>('input').find((input) => input.placeholder === 'Choose a directory');
    await until(() => choice() !== undefined, 'the choice');
    expect(q('input[aria-label="Search users"]')).toBeNull();
    // Nothing is asked of a directory before one is chosen.
    expect(api.calls.filter((call) => call.path.includes('/identity/domains/sp/'))).toHaveLength(0);

    await click(choice());
    await click(qa('[role="option"]').find((option) => option.textContent === 'HR SharePoint'));
    await until(() => q('input[aria-label="Search users"]') !== null, 'the directory');
    await until(() => shown('Ada Example'), 'its users');
  });

  it('says directory people need workspace admin rights when they are refused', async () => {
    await open(POLICIES, {}, { domains: () => jsonResponse({ error: 'Identity directories are managed by Knowledge Engine admins of the workspace', code: 'access_denied' }, 403) });
    await click(tab('From a connector'));
    await until(() => text().includes('Directory people need Knowledge Engine admin rights for the whole workspace.'), 'the message');
  });

  it('says there is no directory yet when there is none', async () => {
    await open(POLICIES, {}, { domains: () => ({ domains: [] }) });
    await click(tab('From a connector'));
    await until(() => text().includes('No connector directory exists yet.'), 'the message');
  });

  it('stops adding at 1,000 entries', async () => {
    const full = Array.from({ length: 1000 }, (_, index) => ({ principal: `email:person${index}@example.com`, kind: 'email', label: `person${index}@example.com` }));
    await open(POLICIES, {}, { nodes: { 'folder:f-policies': aclView('folder:f-policies', 'own', full, ownEffective('folder', 'f-policies', full)) } });
    expect(text()).toContain('1,000 of 1,000');
    expect(text()).toContain('A list holds at most 1,000 entries.');
    const everyone = qa<HTMLButtonElement>('button').find((b) => b.getAttribute('aria-label') === 'Add Everyone who can open this knowledge engine')!;
    expect(everyone.disabled).toBe(true);
    await until(() => results() !== null, 'the people');
    expect(qa<HTMLButtonElement>('button', results()!).filter((b) => b.textContent === 'Add').every((b) => b.disabled)).toBe(true);
  });
});

describe('a node a connected source owns', () => {
  it('says it mirrors the source, shows the list, and lets nothing change', async () => {
    await open(BENEFITS);
    expect(text()).toContain('Synced from a connected source');
    expect(text()).toContain('These permissions mirror the source and change only there.');
    await until(() => rows().length === 1, 'the list');
    expect(rowTexts()[0]).toContain('HR Team');
    expect((removeIn(rows()[0]!) as HTMLButtonElement).disabled).toBe(true);
    expect(radio('Give it its own permissions').disabled).toBe(true);
    expect(radio('Inherit from').disabled).toBe(true);
    const everyone = qa<HTMLButtonElement>('button').find((b) => b.getAttribute('aria-label') === 'Add Everyone who can open this knowledge engine')!;
    expect(everyone.disabled).toBe(true);
    expect(q<HTMLInputElement>('input[aria-label="Search people"]')!.disabled).toBe(true);
  });

  it('cannot be saved, and says why', async () => {
    await open(BENEFITS);
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    await click(saveButton());
    expect(puts()).toHaveLength(0);
  });
});

describe('a save that is refused', () => {
  it('shows the server’s sentence, names the entries it could not find, and stays open', async () => {
    const { onClose, onSaved } = await open(POLICIES, {}, {
      put: () => jsonResponse({
        error: 'Some entries name users, groups, tokens or directories that do not exist',
        code: 'principal_unknown',
        details: { principals: ['user:u-ada'] },
      }, 400),
    });
    await until(() => rows().length === 3, 'the list');
    await click(removeIn(rows()[2]!));
    await click(saveButton());
    await until(() => text().includes('do not exist'), 'the error');
    expect(text()).toContain('Some entries name users, groups, tokens or directories that do not exist: Ada Example.');
    expect(text()).toContain('Not saved');
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(notify.show).not.toHaveBeenCalled();
    // Still editable: the next change clears the message.
    await click(removeIn(rows()[0]!));
    expect(text()).not.toContain('do not exist');
  });
});

describe('loading', () => {
  it('says the permissions could not be loaded, offers Retry, and cannot save meanwhile', async () => {
    install();
    api.on('GET', '/api/rag/modules/kb/acl', () => jsonResponse({ error: 'Folder not found', code: 'folder_not_found' }, 404));
    mounted = await mount(h(RagPermissionEditor, {
      moduleKey: 'kb', moduleName: 'HR Policies', target: POLICIES, accessEnabled: true, adminBypass: true, onClose: vi.fn(), onSaved: vi.fn(),
    }));
    await until(() => text().includes('The permissions could not be loaded.'), 'the error');
    expect(text()).toContain('Folder not found');
    expect(saveButton().getAttribute('aria-disabled')).toBe('true');
    api.on('GET', '/api/rag/modules/kb/acl', () => ({ acl: nodes()['folder:f-policies'] }));
    await click(buttonByText('Retry'));
    await until(() => rows().length === 3, 'the list');
    expect(text()).not.toContain('The permissions could not be loaded.');
  });
});
