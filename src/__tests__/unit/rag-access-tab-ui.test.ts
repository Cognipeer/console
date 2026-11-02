// @vitest-environment jsdom
/**
 * The Access tab of a knowledge base in a DOM, against a mocked `fetch`: the two switches (their confirms and what a
 * change sends), the default access, the summary tiles with the list of what nobody can read, the connectors that
 * bring permissions in, and the loading, failed and reloaded states of those cards. The chip in the page's header
 * that leads here is checked at the end.
 */

import { createElement as h, Fragment, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RagAccessChip } from '@/components/rag/access/RagAccessChip';
import { RagAccessTab, type RagAccessTabProps } from '@/components/rag/access/RagAccessTab';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { until } from '../helpers/filesUploadDetailHarness';

const notify = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: notify }));
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) =>
    h('a', { href: props.href, className: props.className }, props.children),
}));

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

const counts = (over: Partial<{ total: number; own: number; synced: number; closed: number }> = {}) => ({
  total: 0,
  own: 0,
  synced: 0,
  closed: 0,
  ...over,
});

function summaryView(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    adminBypass: true,
    root: { entries: 0, openToEveryone: true },
    folders: counts({ total: 5, own: 3, synced: 1 }),
    documents: counts({ total: 40, own: 2, synced: 23, closed: 1 }),
    closed: [] as unknown[],
    closedComplete: true,
    directories: [] as unknown[],
    ...over,
  };
}

const rootAcl = (entries: Array<{ principal: string; kind: string; label?: string }> = []) => ({
  node: { type: 'module', id: 'kb' },
  mode: 'own',
  entries,
  effective: { node: { type: 'module', id: 'kb' }, entries, ...(entries.length === 0 ? { openToEveryone: true } : {}) },
});

const FOLDERS = [
  { _id: 'f-policies', name: 'Policies', path: 'Policies', aclMode: 'own' },
  { _id: 'f-leave', parentId: 'f-policies', name: 'Leave', path: 'Policies/Leave', aclMode: 'own' },
];

interface Setup {
  summary?: unknown;
  acl?: unknown;
  people?: (key: string) => unknown;
}

function install(setup: Setup = {}) {
  api = installApiMock([
    ['GET', '/api/rag/modules/kb/access/summary', () => ({ summary: setup.summary ?? summaryView() })],
    ['GET', '/api/rag/modules/kb/acl', () => ({ acl: setup.acl ?? rootAcl() })],
    ['GET', '/api/rag/modules/kb/folders', () => ({ folders: FOLDERS })],
    ['POST', '/api/rag/modules/kb/access/audience', (call) => ({
      audience: Object.fromEntries(((call.body as { principals: string[] }).principals).map((key) => [key, { kind: 'group', label: `Name of ${key}`, exists: true, people: 3 }])),
    })],
    ['GET', /^\/api\/rag\/identity\/domains\/[^/]+\/people$/, (call) => setup.people?.(call.path.split('/')[5] ?? '') ?? jsonResponse({ error: 'no people' }, 500)],
    ['PATCH', '/api/rag/modules/kb', (call) => ({ module: { key: 'kb', ...(call.body as object) } })],
  ]);
}

function props(over: Partial<RagAccessTabProps> = {}): RagAccessTabProps {
  return {
    moduleKey: 'kb',
    moduleName: 'HR Policies',
    access: { enabled: false },
    refreshKey: 0,
    onModuleChanged: vi.fn(),
    onEditPermissions: vi.fn(),
    onShowFolder: vi.fn(),
    ...over,
  };
}

async function open(tabProps: RagAccessTabProps, setup: Setup = {}) {
  install(setup);
  mounted = await mount(h(RagAccessTab, tabProps));
  await until(() => text().includes('Folders with own permissions') || text().includes('could not be loaded'), 'the tab');
}

const switchOf = (label: string) =>
  qa<HTMLInputElement>('input[type="checkbox"]').find((input) => [...(input.labels ?? [])].some((l) => l.textContent?.includes(label)))!;

const card = (title: string) => q(`section[aria-label="${title}"]`)!;

const patches = () => api.to('PATCH', '/api/rag/modules/kb').map((call) => call.body);

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('the cards', () => {
  it('lists them in order: permissions, default access, tiles, check, connectors', async () => {
    await open(props());
    const page = text();
    const at = (needle: string) => page.indexOf(needle);
    expect(at('Document permissions')).toBeGreaterThanOrEqual(0);
    expect(at('Document permissions')).toBeLessThan(at('Default access'));
    expect(at('Default access')).toBeLessThan(at('Folders with own permissions'));
    expect(at('Folders with own permissions')).toBeLessThan(at('Check access'));
    expect(at('Check access')).toBeLessThan(at('Permissions from connectors'));
  });

  it('shows the four counts of the summary', async () => {
    await open(props(), { summary: summaryView({ folders: counts({ total: 5, own: 3, synced: 1, closed: 0 }), documents: counts({ total: 1240, own: 2, synced: 1102, closed: 1 }) }) });
    const page = text();
    expect(page).toMatch(/3\s*Folders with own permissions/);
    expect(page).toMatch(/2\s*Documents with own permissions/);
    expect(page).toMatch(/1,102\s*Synced from connectors/);
    expect(page).toContain('plus 1 folder');
    expect(page).toMatch(/1\s*Readable by nobody/);
  });
});

describe('the switches', () => {
  it('shows the stored state and the wording of each switch', async () => {
    await open(props({ access: { enabled: true, adminBypass: false } }));
    expect(switchOf('Enforce document permissions').checked).toBe(true);
    expect(switchOf('Admins of this knowledge engine read everything').checked).toBe(false);
    const page = text();
    expect(page).toContain('When off, everyone who can open this knowledge engine reads every document, as today.');
    expect(page).toContain('Applies to search, answers, agent tools and downloads. Admins always see every document on the management screens.');
  });

  it('treats an absent admin exception as on, and an absent access setting as off', async () => {
    await open(props({ access: undefined }));
    expect(switchOf('Enforce document permissions').checked).toBe(false);
    expect(switchOf('Admins of this knowledge engine read everything').checked).toBe(true);
  });

  it('asks first, then turns enforcement on and tells the page', async () => {
    const onModuleChanged = vi.fn();
    await open(props({ access: { enabled: false }, onModuleChanged }));
    await click(switchOf('Enforce document permissions'));
    await until(() => text().includes('become readable only by the people and groups they name'), 'the confirm');
    expect(text()).toContain('Everything else follows the default access below.');
    expect(patches()).toHaveLength(0);
    await click(buttonByText('Turn on'));
    await until(() => patches().length === 1, 'the request');
    expect(patches()[0]).toEqual({ access: { enabled: true } });
    await until(() => onModuleChanged.mock.calls.length === 1, 'the reload');
    // Until the page's module says so, the switch shows what was saved.
    expect(switchOf('Enforce document permissions').checked).toBe(true);
  });

  it('asks first, then turns enforcement off', async () => {
    const onModuleChanged = vi.fn();
    await open(props({ access: { enabled: true }, onModuleChanged }));
    await click(switchOf('Enforce document permissions'));
    await until(() => text().includes('The permissions stay stored and apply again when you turn this back on.'), 'the confirm');
    await click(buttonByText('Turn off'));
    await until(() => patches().length === 1, 'the request');
    expect(patches()[0]).toEqual({ access: { enabled: false } });
    expect(onModuleChanged).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when the confirm is cancelled', async () => {
    const onModuleChanged = vi.fn();
    await open(props({ access: { enabled: false }, onModuleChanged }));
    await click(switchOf('Enforce document permissions'));
    await until(() => text().includes('become readable only by'), 'the confirm');
    await click(buttonByText('Cancel'));
    await until(() => !text().includes('become readable only by'), 'the dialog to close');
    expect(patches()).toHaveLength(0);
    expect(onModuleChanged).not.toHaveBeenCalled();
    expect(switchOf('Enforce document permissions').checked).toBe(false);
  });

  it('keeps an admin exception that was turned off when enforcement changes', async () => {
    await open(props({ access: { enabled: false, adminBypass: false } }));
    await click(switchOf('Enforce document permissions'));
    await until(() => text().includes('become readable only by'), 'the confirm');
    await click(buttonByText('Turn on'));
    await until(() => patches().length === 1, 'the request');
    expect(patches()[0]).toEqual({ access: { enabled: true, adminBypass: false } });
  });

  it('asks before the admin exception is turned off, and sends the enforcement as it is', async () => {
    const onModuleChanged = vi.fn();
    await open(props({ access: { enabled: true }, onModuleChanged }));
    await click(switchOf('Admins of this knowledge engine read everything'));
    await until(() => text().includes('will then read only what the permissions allow'), 'the confirm');
    await click(buttonByText('Remove the exception'));
    await until(() => patches().length === 1, 'the request');
    expect(patches()[0]).toEqual({ access: { enabled: true, adminBypass: false } });
    expect(onModuleChanged).toHaveBeenCalledTimes(1);
  });

  it('turns the admin exception back on without asking', async () => {
    await open(props({ access: { enabled: false, adminBypass: false } }));
    await click(switchOf('Admins of this knowledge engine read everything'));
    await until(() => patches().length === 1, 'the request');
    expect(patches()[0]).toEqual({ access: { enabled: false, adminBypass: true } });
    expect(text()).not.toContain('Remove the admin exception?');
  });

  it('says why a change failed and leaves the page alone', async () => {
    const onModuleChanged = vi.fn();
    await open(props({ access: { enabled: false }, onModuleChanged }));
    api.on('PATCH', '/api/rag/modules/kb', () => jsonResponse({ error: 'Switching access control of a knowledge base needs Knowledge Engine admin', code: 'access_denied' }, 403));
    await click(switchOf('Enforce document permissions'));
    await until(() => text().includes('become readable only by'), 'the confirm');
    await click(buttonByText('Turn on'));
    await until(() => notify.show.mock.calls.length === 1, 'the notification');
    expect(notify.show.mock.calls[0]![0]).toMatchObject({
      color: 'red',
      title: 'Could not change access control',
      message: 'Switching access control of a knowledge base needs Knowledge Engine admin',
    });
    expect(onModuleChanged).not.toHaveBeenCalled();
    expect(switchOf('Enforce document permissions').checked).toBe(false);
  });

  it('follows the module when the page reloads it', async () => {
    function Harness() {
      const [access, setAccess] = useState<RagAccessTabProps['access']>({ enabled: false });
      return h(Fragment, null,
        h('button', { onClick: () => setAccess({ enabled: true, adminBypass: false }) }, 'reload module'),
        h(RagAccessTab, props({ access })));
    }
    install();
    mounted = await mount(h(Harness));
    await until(() => text().includes('Folders with own permissions'), 'the tab');
    expect(switchOf('Enforce document permissions').checked).toBe(false);
    await click(buttonByText('reload module'));
    expect(switchOf('Enforce document permissions').checked).toBe(true);
    expect(switchOf('Admins of this knowledge engine read everything').checked).toBe(false);
  });
});

describe('the default access', () => {
  it('says everyone who can open the knowledge engine reads when the root names nobody', async () => {
    await open(props());
    const section = card('Default access');
    expect(section.textContent).toContain('Folders and documents without their own permissions can be read by:');
    expect(section.textContent).toContain('Everyone who can open this knowledge engine');
  });

  it('lists who the root names, by their live name', async () => {
    await open(props(), {
      acl: rootAcl([
        { principal: 'group:g1', kind: 'group', label: 'HR' },
        { principal: 'email:legal@example.com', kind: 'email', label: 'legal@example.com' },
      ]),
    });
    await until(() => card('Default access').textContent!.includes('Group Name of group:g1'), 'the names');
    const section = card('Default access');
    expect(section.textContent).toContain('legal@example.com');
    expect(section.textContent).not.toContain('Everyone who can open this knowledge engine');
  });

  it('cuts a long list', async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({ principal: `group:g${index}`, kind: 'group', label: `Team ${index}` }));
    await open(props(), { acl: rootAcl(entries) });
    expect(qa('[role="listitem"]', card('Default access'))).toHaveLength(6);
    expect(card('Default access').textContent).toContain('and 3 more');
  });

  it('opens the permission editor for the root', async () => {
    const onEditPermissions = vi.fn();
    await open(props({ onEditPermissions }));
    await click(buttonByText('Edit…', card('Default access')));
    expect(onEditPermissions).toHaveBeenCalledWith({ node: 'module', name: 'HR Policies' });
  });
});

describe('readable by nobody', () => {
  const closed = [
    { type: 'folder', id: 'f-leave', name: 'Leave', path: 'Policies/Leave' },
    { type: 'document', id: 'd1', name: 'holiday-calendar-2026.xlsx', folderId: 'f-policies' },
    { type: 'document', id: 'd2', name: 'draft.docx' },
  ];

  it('offers the list only when something is closed, and lists it on Show', async () => {
    await open(props(), { summary: summaryView({ folders: counts({ closed: 1 }), documents: counts({ closed: 2 }), closed }) });
    expect(text()).toMatch(/3\s*Readable by nobody/);
    expect(q('section[aria-label="Readable by nobody"]')).toBeNull();
    await click(buttonByText('Show'));
    await until(() => q('section[aria-label="Readable by nobody"]') !== null, 'the list');
    const section = card('Readable by nobody');
    expect(section.textContent).toContain('Only admins of this knowledge engine can read these, because the admin exception is on.');
    expect(section.textContent).toContain('The same goes for whatever inherits from them.');
    expect(section.textContent).toContain('Leave');
    expect(section.textContent).toContain('holiday-calendar-2026.xlsx');
    // Where each one is.
    await until(() => section.textContent!.includes('In Policies'), 'the folder names');
    expect(section.textContent).toContain('Policies / Leave');
    expect(section.textContent).toContain('At the top level');
    expect(section.textContent).not.toContain('The first 50 are shown.');
    await click(buttonByText('Hide'));
    expect(q('section[aria-label="Readable by nobody"]')).toBeNull();
  });

  it('opens the folder of each one: the folder itself, the folder of a document, or the top level', async () => {
    const onShowFolder = vi.fn();
    await open(props({ onShowFolder }), { summary: summaryView({ folders: counts({ closed: 1 }), documents: counts({ closed: 2 }), closed }) });
    await click(buttonByText('Show'));
    await until(() => q('section[aria-label="Readable by nobody"]') !== null, 'the list');
    const section = card('Readable by nobody');
    await click(buttonByText('Open', qa('[role="listitem"]', section)[0]));
    await click(buttonByText('Open', qa('[role="listitem"]', section)[1]));
    await click(buttonByText('Open', qa('[role="listitem"]', section)[2]));
    expect(onShowFolder.mock.calls).toEqual([['f-leave'], ['f-policies'], [null]]);
  });

  it('says so when the scan stopped before the end', async () => {
    await open(props(), { summary: summaryView({ documents: counts({ closed: 120 }), closed, closedComplete: false }) });
    await click(buttonByText('Show'));
    await until(() => text().includes('The first 50 are shown.'), 'the note');
  });

  it('says that not even admins read them when the admin exception is off', async () => {
    await open(props({ access: { enabled: true, adminBypass: false } }), { summary: summaryView({ documents: counts({ closed: 1 }), closed: [closed[1]] }) });
    await click(buttonByText('Show'));
    await until(() => text().includes('not even admins of this knowledge engine'), 'the note');
  });

  it('has no Show when nothing is closed', async () => {
    await open(props(), { summary: summaryView({ folders: counts(), documents: counts() }) });
    expect(buttonByText('Show')).toBeUndefined();
  });
});

describe('permissions from connectors', () => {
  const directory = { key: 'sp', label: 'HR SharePoint', connectorId: 'conn-1', documents: 23, folders: 0 };
  const peopleOf = (matched: number, users: number) => () => ({
    users: [],
    total: users,
    summary: { directoryUsers: users, matchedUsers: matched, consolePeople: 50, matchedPeople: 40, groups: 5, rules: [], defaults: true, matchGroupsByExternalId: true },
  });

  it('says there is none when no connector brings permissions', async () => {
    await open(props());
    expect(card('Permissions from connectors').textContent).toContain('No connector brings permissions into this knowledge engine.');
  });

  it('lists the directory with what it keeps, how many people matched, and a link to the connector', async () => {
    await open(props(), { summary: summaryView({ directories: [directory] }), people: peopleOf(1102, 1240) });
    await until(() => card('Permissions from connectors').textContent!.includes('1,102 of 1,240 people matched'), 'the people');
    const section = card('Permissions from connectors');
    expect(section.textContent).toContain('HR SharePoint · 23 documents keep their source permissions');
    const link = qa<HTMLAnchorElement>('a', section).find((a) => a.textContent === 'Open connector')!;
    expect(link.getAttribute('href')).toBe('/dashboard/connectors/conn-1?tab=people');
    // Only the count is asked for, not the people.
    const call = api.to('GET', '/api/rag/identity/domains/sp/people')[0]!;
    expect(call.query.limit).toBe('1');
  });

  it('leaves the people line out for an admin of the project only (403), and the link out for a system without a connector', async () => {
    await open(props(), {
      summary: summaryView({ directories: [{ key: 'api', label: 'Partner system (API)', documents: 2, folders: 1 }] }),
      people: () => jsonResponse({ error: 'Identity directories are managed by Knowledge Engine admins of the workspace', code: 'access_denied' }, 403),
    });
    await until(() => api.to('GET', '/api/rag/identity/domains/api/people').length === 1, 'the request');
    await until(() => !card('Permissions from connectors').textContent!.includes('Counting people'), 'the answer');
    const section = card('Permissions from connectors');
    expect(section.textContent).toContain('Partner system (API) · 2 documents and 1 folder keep their source permissions');
    expect(section.textContent).not.toContain('people matched');
    expect(section.textContent).not.toContain('could not be counted');
    expect(qa('a', section)).toHaveLength(0);
  });

  it('says when the people could not be counted for another reason', async () => {
    await open(props(), { summary: summaryView({ directories: [directory] }), people: () => jsonResponse({ error: 'boom' }, 500) });
    await until(() => card('Permissions from connectors').textContent!.includes('could not be counted'), 'the note');
  });
});

describe('loading and failing', () => {
  it('says what failed instead of showing an empty card, and loads again on Retry', async () => {
    install();
    api.on('GET', '/api/rag/modules/kb/access/summary', () => jsonResponse({ error: 'The summary is unavailable' }, 500));
    mounted = await mount(h(RagAccessTab, props()));
    await until(() => text().includes('The access summary could not be loaded.'), 'the error');
    expect(text()).toContain('The summary is unavailable');
    // The connectors card reads the same summary and says so too.
    expect(card('Permissions from connectors').textContent).toContain('The connectors could not be loaded.');
    api.on('GET', '/api/rag/modules/kb/access/summary', () => ({ summary: summaryView() }));
    await click(buttonByText('Retry', q('section[aria-label="Permissions from connectors"]')!));
    await until(() => text().includes('Folders with own permissions'), 'the tiles');
    expect(text()).not.toContain('The access summary could not be loaded.');
  });

  it('says the default access could not be loaded, and the rest still works', async () => {
    install();
    api.on('GET', '/api/rag/modules/kb/acl', () => jsonResponse({ error: 'Not now' }, 500));
    mounted = await mount(h(RagAccessTab, props()));
    await until(() => text().includes('The default access could not be loaded.'), 'the error');
    expect(card('Default access').textContent).toContain('Not now');
    expect(card('Default access').textContent).not.toContain('Everyone who can open this knowledge engine');
    await until(() => text().includes('Folders with own permissions'), 'the tiles');
  });

  it('loads every view again when the page bumps the refresh key', async () => {
    function Harness() {
      const [key, setKey] = useState(0);
      return h(Fragment, null, h('button', { onClick: () => setKey((n) => n + 1) }, 'bump'), h(RagAccessTab, props({ refreshKey: key })));
    }
    install();
    mounted = await mount(h(Harness));
    await until(() => text().includes('Folders with own permissions'), 'the tab');
    expect(api.to('GET', '/api/rag/modules/kb/access/summary')).toHaveLength(1);
    expect(api.to('GET', '/api/rag/modules/kb/acl')).toHaveLength(1);
    await click(buttonByText('bump'));
    await until(() => api.to('GET', '/api/rag/modules/kb/access/summary').length === 2, 'the summary again');
    await until(() => api.to('GET', '/api/rag/modules/kb/acl').length === 2, 'the default access again');
  });
});

describe('the chip in the header', () => {
  it('says access control is on and opens the Access tab when clicked', async () => {
    const onClick = vi.fn();
    mounted = await mount(h(RagAccessChip, { enabled: true, onClick }));
    expect(text()).toContain('Access control: On');
    await click(buttonByText('Access control: On'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('says access control is off', async () => {
    mounted = await mount(h(RagAccessChip, { enabled: false, onClick: vi.fn() }));
    expect(text()).toContain('Access control: Off');
    expect(buttonByText('Access control: Off')?.getAttribute('type')).toBe('button');
  });
});
