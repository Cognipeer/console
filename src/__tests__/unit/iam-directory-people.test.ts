// @vitest-environment jsdom
/**
 * The Principals list as the one place to manage people, groups and API tokens:
 * what the three segments show, how filters and search reach the server and the
 * address bar, the Add menu, the row menu and its confirmations, and what a
 * read-only viewer is not offered.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { CAPS_ADMIN, CAPS_READ_ONLY, directoryRoutes, listHandler, PEOPLE } from '../helpers/iamDirectoryFixtures';

const nav = vi.hoisted(() => ({
  search: '',
  cache: new Map<string, URLSearchParams>(),
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/iam',
}));

import PrincipalsTab from '@/components/iam/principals/PrincipalsTab';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => {
  window.history.replaceState(null, '', '/dashboard/iam?tab=principals');
});
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
  nav.router.push.mockClear();
  nav.router.replace.mockClear();
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

async function renderTab(options: { search?: string; caps?: unknown; extra?: Array<[string, string | RegExp, RouteHandler]> } = {}) {
  nav.search = options.search ?? 'tab=principals';
  window.history.replaceState(null, '', `/dashboard/iam?${nav.search}`);
  api = installApiMock([...directoryRoutes(options.caps ?? CAPS_ADMIN), ...(options.extra ?? [])]);
  mounted = await mount(createElement(PrincipalsTab, { canManage: true }));
  await settle(120);
}

const rowOf = (name: string) => qa<HTMLTableRowElement>('tbody tr').find((r) => r.textContent?.includes(name));
const kebabOf = (row: HTMLElement) => qa<HTMLButtonElement>('button', row).at(-1)!;
const menuItems = () => qa('[role="menuitem"]').map((i) => i.textContent?.trim());
/** The requests of the table (the pickers of the filter bar ask for 20 at a time). */
const listCalls = () => api.to('GET', '/api/iam/principals').filter((c) => c.query.limit !== '20');
const search = () => new URLSearchParams(window.location.search);

async function openRowMenu(name: string) {
  const row = rowOf(name);
  if (!row) throw new Error(`no row for ${name}`);
  await click(kebabOf(row));
  await settle(50);
}

describe('the People segment', () => {
  it('lists people with their role, status, type and source, and asks for the exact total once', async () => {
    await renderTab();
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0]?.query).toEqual({ type: 'user', limit: '25', count: '1' });

    const t = text();
    for (const person of PEOPLE) expect(t).toContain(person.label);
    expect(t).toContain('olive@example.com');
    // role, status, type and source columns
    const owner = rowOf('Olive Owner')!.textContent!;
    expect(owner).toContain('Owner');
    expect(owner).toContain('Active');
    expect(owner).toContain('Person');
    expect(owner).toContain('Local');
    expect(rowOf('Ivy Invited')!.textContent).toContain('Invited');
    expect(rowOf('ci-pipeline')!.textContent).toContain('Service account');
    const sso = rowOf('Sam Sso')!;
    expect(sso.textContent).toContain('SSO (OIDC)');
    expect(q('[aria-label="Managed by a directory"]', sso)).not.toBeNull();
    // "1-6 of 6" comes from the exact total
    expect(t).toContain('1-6 of 6');
  });

  it('shows the section header of every column the spec names', async () => {
    await renderTab();
    const headers = qa('thead th').map((th) => th.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Person', 'Role', 'Status', 'Type', 'Source', 'Created', 'Policies']));
  });

  it('turns the address bar into a view: filters, sort and search reach the server', async () => {
    await renderTab({ search: 'tab=principals&role=admin,user&status=invited&kind=person&source=local&sort=email&dir=desc&q=ivy' });
    expect(listCalls()[0]?.query).toMatchObject({
      type: 'user',
      q: 'ivy',
      role: 'admin,user',
      status: 'invited',
      kind: 'person',
      source: 'local',
      sort: 'email',
      dir: 'desc',
      count: '1',
    });
    expect(text()).toContain('Ivy Invited');
    expect(text()).not.toContain('Ann Lee');
  });

  it('filters people by group and by project, and groups by project (the server names them group and project)', async () => {
    await renderTab({ search: 'tab=principals&group=g-eng&project=p-a' });
    expect(listCalls()[0]?.query).toMatchObject({ type: 'user', group: 'g-eng', project: 'p-a' });
    // the group behind the id is looked up for the filter chip
    expect(api.to('GET', '/api/iam/principals').some((c) => c.query.type === 'group' && c.query.ids === 'g-eng')).toBe(true);
    expect(buttonByText('Reset filters')).toBeDefined();
    await mounted.unmount();

    await renderTab({ search: 'tab=principals&principalType=group&project=p-b' });
    expect(listCalls()[0]?.query).toMatchObject({ type: 'group', project: 'p-b' });
    expect(buttonByText('Reset filters')).toBeDefined();
  });

  it('resets every filter and the search with one click, in the view and in the address bar', async () => {
    await renderTab({ search: 'tab=principals&status=invited&q=ivy' });
    expect(buttonByText('Reset filters')).toBeDefined();
    await click(buttonByText('Reset filters'));
    await settle(60);
    const last = listCalls().at(-1)!;
    expect(last.query).toEqual({ type: 'user', limit: '25', count: '1' });
    expect(search().get('status')).toBeNull();
    expect(search().get('q')).toBeNull();
    expect(search().get('tab')).toBe('principals');
    expect(text()).toContain('Ann Lee');
  });

  it('searches on the server after a pause and writes the search into the address bar', async () => {
    await renderTab();
    const box = q<HTMLInputElement>('.ds-toolbar-search input')!;
    await setInput(box, 'ann');
    await settle(450);
    const last = listCalls().at(-1)!;
    expect(last.query).toMatchObject({ type: 'user', q: 'ann', count: '1' });
    expect(search().get('q')).toBe('ann');
    expect(text()).toContain('Ann Lee');
    expect(text()).not.toContain('Olive Owner');
  });

  it('says so when nothing matches, and offers to reset', async () => {
    await renderTab({ search: 'tab=principals&q=zzz' });
    expect(text()).toContain('No matches');
    expect(buttonByText('Reset filters')).toBeDefined();
  });

  it('pages on the server: the total is asked for once, the next page keeps it', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'user', id: `u${i}`, label: `Person ${String(i).padStart(2, '0')}`, sublabel: `p${i}@example.com`, role: 'user', status: 'active', kind: 'person', authProvider: 'local', managed: false, policyCount: 0,
    }));
    await renderTab({
      extra: [
        [
          'GET',
          '/api/iam/principals',
          (c) => {
            const offset = c.query.cursor ? Number(c.query.cursor) : 0;
            const limit = Number(c.query.limit);
            return { items: many.slice(offset, offset + limit), nextCursor: offset + limit < many.length ? String(offset + limit) : null, ...(c.query.count === '1' ? { total: many.length } : {}) };
          },
        ],
      ],
    });
    expect(text()).toContain('1-25 of 60');
    await click(buttonByText('Next'));
    await settle(80);
    const second = listCalls().at(-1)!;
    expect(second.query.cursor).toBeTruthy();
    expect(second.query.count).toBeUndefined();
    expect(text()).toContain('26-50 of 60');
    expect(text()).toContain('Person 25');
  });

  it('keeps the error and a retry when the list cannot be loaded', async () => {
    let fail = true;
    await renderTab({ extra: [['GET', '/api/iam/principals', () => (fail ? jsonResponse({ error: 'boom' }, 500) : { items: [], nextCursor: null })]] });
    expect(text()).toContain('Could not load the list');
    fail = false;
    await click(buttonByText('Try again'));
    await settle(60);
    expect(listCalls().length).toBeGreaterThanOrEqual(2);
  });
});

describe('the segments', () => {
  it('switches to groups: their own columns, no people filters, the URL follows', async () => {
    await renderTab({ search: 'tab=principals&status=invited' });
    const groups = qa<HTMLLabelElement>('label').find((l) => l.textContent === 'Groups')!;
    await click(groups);
    await settle(80);
    const last = listCalls().at(-1)!;
    expect(last.query).toEqual({ type: 'group', limit: '25', count: '1' });
    expect(text()).toContain('Engineering');
    expect(text()).toContain('Directory staff');
    const headers = qa('thead th').map((th) => th.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Group', 'Source', 'Workspace role', 'Members', 'Policies']));
    expect(rowOf('Directory staff')!.textContent).toContain('LDAP');
    expect(search().get('principalType')).toBe('group');
    expect(search().get('status')).toBeNull();
  });

  it('lists API tokens with their owner, project, scope and status, and notes where personal tokens live', async () => {
    await renderTab({ search: 'tab=principals&principalType=token' });
    // (the owner filter searches people too: pick the table's own request)
    expect(listCalls().find((c) => c.query.type === 'token')?.query).toMatchObject({ type: 'token', limit: '25', count: '1' });
    const headers = qa('thead th').map((th) => th.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Token', 'Owner', 'Project', 'Scope', 'Status', 'Last used', 'Expires', 'Created']));
    const ci = rowOf('ci-token')!.textContent!;
    expect(ci).toContain('Ann Lee');
    expect(ci).toContain('Alpha');
    expect(ci).toContain('Scoped');
    const bot = rowOf('bot-token')!.textContent!;
    expect(bot).toContain('Service account');
    expect(bot).toContain('Owner disabled');
    expect(bot).toContain('Unscoped');
    expect(bot).toContain('Expired');
    expect(q('[data-testid="token-note"]')?.textContent).toContain('API Tokens page');
  });
});

describe('the Add menu', () => {
  it('offers the five creations to someone who manages people', async () => {
    await renderTab();
    await click(q('[data-testid="add-menu"]'));
    await settle(60);
    const items = menuItems();
    for (const label of ['Invite a person', 'Create a service account', 'Import service accounts (CSV)', 'New group', 'New API token']) {
      expect(items.some((i) => i?.startsWith(label)), label).toBe(true);
    }
  });

  it('opens a full-screen form and writes it into the address bar; closing clears it', async () => {
    await renderTab();
    await click(q('[data-testid="add-menu"]'));
    await settle(60);
    await click(qa('[role="menuitem"]').find((i) => i.textContent?.includes('Invite a person')));
    await settle(80);
    expect(q('.form-overlay')?.textContent).toContain('Invite a person');
    expect(search().get('new')).toBe('person');

    await click(buttonByText('Cancel'));
    await settle(50);
    expect(q('.form-overlay')).toBeNull();
    expect(search().get('new')).toBeNull();
  });

  it('a deep link opens the form straight away', async () => {
    await renderTab({ search: 'tab=principals&new=service' });
    expect(q('.form-overlay')?.textContent).toContain('Create a service account');
  });

  it('is absent for a read-only viewer, who is offered nothing to change', async () => {
    // the server's verdicts per row for this viewer: nothing allowed
    const none = { editProfile: { allowed: false, reason: 'forbidden' }, changeRole: { allowed: false, reason: 'forbidden' }, delete: { allowed: false, reason: 'forbidden' } };
    await renderTab({
      caps: CAPS_READ_ONLY,
      extra: [['GET', '/api/iam/principals', (c) => ({ items: c.query.type === 'user' ? PEOPLE.map((p) => ({ ...p, allowedActions: none })) : [], nextCursor: null, total: PEOPLE.length })]],
    });
    expect(q('[data-testid="add-menu"]')).toBeNull();
    await openRowMenu('Ann Lee');
    expect(menuItems()).toEqual(['Open']);
  });

  it('an older server that sends no verdicts per row: the cheap facts of the row decide, and a read-only viewer gets nothing', async () => {
    await renderTab({ caps: CAPS_READ_ONLY, extra: [['GET', '/api/iam/principals', listHandler({ withActions: false })]] });
    await openRowMenu('Ann Lee');
    expect(menuItems()).toEqual(['Open']);
    await mounted.unmount();
    await renderTab({ extra: [['GET', '/api/iam/principals', listHandler({ withActions: false })]] });
    await openRowMenu('Ann Lee');
    expect(menuItems()).toContain('Change role');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Open'));
  });
});

describe('the row menu', () => {
  it('offers what the row itself says is possible for an ordinary person', async () => {
    await renderTab();
    await openRowMenu('Ann Lee');
    expect(menuItems()).toEqual([
      'Open',
      'Edit profile',
      'Change role',
      'Edit access',
      'Disable',
      'Add to projects',
      'Add to groups',
      'New token',
      'Delete',
    ]);
  });

  it('offers nothing of the owner\'s but opening it: the server denies every change to an admin', async () => {
    await renderTab();
    await openRowMenu('Olive Owner');
    expect(menuItems()).toEqual(['Open']);
  });

  it('follows the server over the facts of the row (a verdict the row alone could not know)', async () => {
    // Ann is an ordinary person, but for this viewer the server says her role may not be changed
    await renderTab({
      extra: [['GET', '/api/iam/principals', (c) => ({
        items: c.query.type === 'user' ? PEOPLE.filter((p) => p.id === 'u-ann').map((p) => ({ ...p, allowedActions: { editProfile: { allowed: true }, changeRole: { allowed: false, reason: 'forbidden' }, disable: { allowed: true }, delete: { allowed: false, reason: 'forbidden' } } })) : [],
        nextCursor: null,
        total: 1,
      })]],
    });
    await openRowMenu('Ann Lee');
    expect(menuItems()).toEqual(['Open', 'Edit profile', 'Disable']);
  });

  it('never offers the signed-in person a change to their own role, disabling or deleting themself', async () => {
    await renderTab();
    await openRowMenu('Ada Admin');
    const items = menuItems();
    for (const forbidden of ['Change role', 'Disable', 'Delete']) expect(items).not.toContain(forbidden);
    expect(items).toContain('Edit profile');
  });

  it('locks a directory account: no profile edit, no delete (disable is the way)', async () => {
    await renderTab();
    await openRowMenu('Sam Sso');
    const items = menuItems();
    expect(items).not.toContain('Edit profile');
    expect(items).not.toContain('Delete');
    expect(items).toContain('Disable');
    expect(items).toContain('Change role');
  });

  it('works the same from the facts of the row on a server that sends no verdicts', async () => {
    await renderTab({ extra: [['GET', '/api/iam/principals', listHandler({ withActions: false })]] });
    await openRowMenu('Olive Owner');
    const owner = menuItems();
    for (const forbidden of ['Change role', 'Disable', 'Delete', 'Edit access']) expect(owner).not.toContain(forbidden);
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Open'));
    await settle(60);
  });

  it('offers the invitation link only while the invitation is pending, and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderTab({ extra: [['POST', '/api/users/u-invited/invitation-link', () => ({ invitationUrl: 'https://x/accept?t=9' })]] });
    await openRowMenu('Ann Lee');
    expect(menuItems()).not.toContain('Copy invitation link');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Open'));
    await settle(30);
    await mounted.unmount();

    await renderTab({ extra: [['POST', '/api/users/u-invited/invitation-link', () => ({ invitationUrl: 'https://x/accept?t=9' })]] });
    await openRowMenu('Ivy Invited');
    expect(menuItems()).toContain('Copy invitation link');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Copy invitation link'));
    await settle(80);
    expect(api.to('POST', '/api/users/u-invited/invitation-link')).toHaveLength(1);
    expect(writeText).toHaveBeenCalledWith('https://x/accept?t=9');
  });

  it('asks before disabling, then disables and refreshes the list', async () => {
    await renderTab({ extra: [['POST', '/api/users/u-ann/disable', () => ({ user: { _id: 'u-ann', status: 'disabled' } })]] });
    const before = listCalls().length;
    await openRowMenu('Ann Lee');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Disable'));
    await settle(80);
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Disable this account?');
    expect(dialog.textContent).toContain('Ann Lee');
    await setInput(q<HTMLInputElement>('input[placeholder="e.g. Left the company"]', dialog)!, 'Left the company');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Disable'));
    await settle(120);
    const calls = api.to('POST', '/api/users/u-ann/disable');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reason: 'Left the company' });
    expect(listCalls().length).toBeGreaterThan(before);
  });

  it('asks to type the address before deleting, and says what is cleaned up', async () => {
    await renderTab({ extra: [['DELETE', '/api/users/u-ann', () => ({ message: 'ok', cleanup: { revokedTokens: 1, removedGroupMemberships: 1, removedProjectMemberships: 1 } })]] });
    await openRowMenu('Ann Lee');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Delete'));
    await settle(80);
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Delete this account?');
    expect(dialog.textContent).toContain('API tokens are revoked');
    const confirm = () => qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Delete')!;
    expect(confirm().disabled).toBe(true);
    await setInput(q<HTMLInputElement>('input[placeholder="ann@example.com"]', dialog)!, 'ann@example.com');
    expect(confirm().disabled).toBe(false);
    await click(confirm());
    await settle(120);
    expect(api.to('DELETE', '/api/users/u-ann')).toHaveLength(1);
  });

  it('shows the failure inside the confirmation, worded for the person', async () => {
    await renderTab({ extra: [['POST', '/api/users/u-ann/enable', () => jsonResponse({ error: 'x', code: 'higher_privileges' }, 403)]] });
    // an enable is offered for a disabled person: serve one
    api.on('GET', '/api/iam/principals', (c) =>
      c.query.type === 'user'
        ? { items: [{ ...PEOPLE[2], status: 'disabled' }], nextCursor: null, total: 1 }
        : { items: [], nextCursor: null },
    );
    await click(qa<HTMLButtonElement>('button[aria-label="Refresh"]')[0]);
    await settle(120);
    await openRowMenu('Ann Lee');
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Enable'));
    await settle(80);
    await click(qa<HTMLButtonElement>('button', q('[role="dialog"]')!).find((b) => b.textContent === 'Enable'));
    await settle(120);
    expect(q('[role="dialog"]')?.textContent).toContain('This account has more privileges than yours.');
  });
});

describe('opening a principal', () => {
  it('opens the page of a person from a row', async () => {
    await renderTab();
    await click(q('tbody tr button[aria-label^="Open details of Ann Lee"]'));
    await settle(50);
    expect(nav.router.push).toHaveBeenCalledWith('/dashboard/iam/principals/user/u-ann');
  });

  it('sends a link from before the pages (principalType and principalId in the list address) to the page', async () => {
    await renderTab({ search: 'tab=principals&principalType=user&principalId=u-ann&edit=profile' });
    expect(nav.router.replace).toHaveBeenCalledWith('/dashboard/iam/principals/user/u-ann?edit=profile');
  });

  it('keeps the list when there is no principal in the address', async () => {
    await renderTab();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });
});
