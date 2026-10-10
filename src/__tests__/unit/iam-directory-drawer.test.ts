// @vitest-environment jsdom
/**
 * The drawer of a person, a group and a token: what it loads and when, which
 * actions the server's `allowedActions` switch on or off (and why), the managed
 * banner, and the confirmations behind remove and revoke.
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
  settle,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { CAPS_ADMIN, directoryRoutes, personDetail } from '../helpers/iamDirectoryFixtures';
import { ACTION_DENIAL_REASONS, reasonKey } from '@/components/iam/principals/detailParts';
import { messages } from '@/lib/i18n/messages';

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import PrincipalsTab from '@/components/iam/principals/PrincipalsTab';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => window.history.replaceState(null, '', '/dashboard/iam?tab=principals'));
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

async function open(target: string, extra: Array<[string, string | RegExp, RouteHandler]> = [], search = '') {
  const [type, id] = target.split(':');
  nav.search = `tab=principals&principalType=${type}&principalId=${id}${search}`;
  window.history.replaceState(null, '', `/dashboard/iam?${nav.search}`);
  api = installApiMock([...directoryRoutes(CAPS_ADMIN), ...extra]);
  mounted = await mount(createElement(PrincipalsTab, { canManage: true }));
  await settle(250);
}

const drawer = () => q('[role="dialog"]')!;
const inDrawer = (sel: string) => q(sel, drawer());
const action = (id: string) => q<HTMLButtonElement>(`[data-testid="${id}"]`);
const detailCalls = (id: string) => api.calls.filter((c) => c.path === `/api/iam/principals/user/${id}`);

describe('a person', () => {
  it('shows the profile first, then the effective table (two requests, the second without the flag)', async () => {
    let skip = true;
    await open('user:u-ann', [
      [
        'GET',
        '/api/iam/principals/user/u-ann',
        (c) => {
          const lite = c.query.effective === '0' && skip;
          return lite
            ? personDetail('u-ann', { effective: [], effectiveSkipped: true })
            : personDetail('u-ann');
        },
      ],
    ]);
    const calls = detailCalls('u-ann');
    expect(calls.map((c) => c.query)).toEqual([{ effective: '0' }, {}]);
    expect(drawer().textContent).toContain('Model Hub');
    skip = false;
  });

  it('asks only once when the server ignores the flag and sends the table anyway', async () => {
    await open('user:u-ann');
    expect(detailCalls('u-ann')).toHaveLength(1);
    expect(drawer().textContent).toContain('Model Hub');
  });

  it('lists the profile facts, groups, projects and tokens, and has no link to a member page', async () => {
    await open('user:u-ann');
    const t = drawer().textContent!;
    expect(t).toContain('Ann Lee');
    expect(t).toContain('ann@example.com');
    expect(t).toContain('Engineering');
    expect(t).toContain('Alpha');
    expect(t).toContain('ci-token');
    expect(t).not.toContain('Open in Members');
    expect(qa('a[href*="/dashboard/members"]')).toHaveLength(0);
    expect(inDrawer('[data-testid="person-facts"]')?.textContent).toContain('Person');
  });

  it('switches on the actions the server allows, for an ordinary person', async () => {
    await open('user:u-ann');
    for (const id of ['act-edit-profile', 'act-change-role', 'act-edit-access', 'act-disable', 'act-delete']) {
      expect(action(id), id).not.toBeNull();
      expect(action(id)!.disabled, id).toBe(false);
    }
    expect(action('act-enable')).toBeNull();
  });

  it('switches off what the owner\'s record cannot take, but keeps the buttons visible', async () => {
    await open('user:u-owner');
    for (const id of ['act-change-role', 'act-edit-access', 'act-disable', 'act-delete', 'act-edit-profile']) {
      expect(action(id)!.disabled, id).toBe(true);
    }
  });

  it('switches off a change to the signed-in person\'s own role, disabling and deleting', async () => {
    await open('user:u-admin');
    expect(action('act-change-role')!.disabled).toBe(true);
    expect(action('act-disable')!.disabled).toBe(true);
    expect(action('act-delete')!.disabled).toBe(true);
    expect(action('act-edit-profile')!.disabled).toBe(false);
    expect(inDrawer('[data-testid="self-note"]')?.textContent).toContain('your own account');
  });

  it('tells a directory account apart: banner, locked profile and delete, disable still on', async () => {
    await open('user:u-sso');
    const banner = inDrawer('[data-testid="managed-banner"]');
    expect(banner?.textContent).toContain('Managed by your directory');
    expect(banner?.textContent).toContain('SSO (OIDC)');
    expect(action('act-edit-profile')!.disabled).toBe(true);
    expect(action('act-delete')!.disabled).toBe(true);
    expect(action('act-disable')!.disabled).toBe(false);
    expect(action('act-change-role')!.disabled).toBe(false);
  });

  it('offers Enable instead of Disable for a disabled account, and the invitation link while pending', async () => {
    await open('user:u-ann', [['GET', '/api/iam/principals/user/u-ann', () => personDetail('u-ann', { principal: { ...personDetail('u-ann').principal, status: 'disabled' } })]]);
    expect(action('act-enable')).not.toBeNull();
    expect(action('act-disable')).toBeNull();

    await mounted.unmount();
    await open('user:u-invited');
    expect(action('act-copy-link')).not.toBeNull();
  });

  it('shows a service account as such, with no email to show', async () => {
    await open('user:u-bot');
    const t = drawer().textContent!;
    expect(t).toContain('Service account');
    expect(t).toContain('No email address');
  });

  it('hides the write actions when the server said nothing about them (a read-only view)', async () => {
    await open('user:u-ann', [['GET', '/api/iam/principals/user/u-ann', () => personDetail('u-ann', { allowedActions: undefined, assignableRoles: undefined })]]);
    expect(action('act-change-role')).toBeNull();
    expect(inDrawer('[data-testid="manage-actions"]')).toBeNull();
  });

  it('removes a group membership behind a confirmation, then reloads the detail', async () => {
    await open('user:u-ann', [['DELETE', '/api/groups/g-eng/members/u-ann', () => ({ message: 'Member removed' })]]);
    const before = detailCalls('u-ann').length;
    await click(q('button[aria-label="Remove from Engineering"]', drawer()));
    await settle(80);
    const dialog = qa('[role="dialog"]').at(-1)!;
    expect(dialog.textContent).toContain('Remove from group?');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Remove'));
    await settle(150);
    expect(api.to('DELETE', '/api/groups/g-eng/members/u-ann')).toHaveLength(1);
    expect(detailCalls('u-ann').length).toBeGreaterThan(before);
  });

  it('does not offer to remove a directory group membership', async () => {
    await open('user:u-ann', [
      ['GET', '/api/iam/principals/user/u-ann', () => personDetail('u-ann', { groups: [{ id: 'g-dir', name: 'Directory staff', source: 'ldap', removable: false }] })],
    ]);
    expect(drawer().textContent).toContain('Directory staff');
    expect(q('button[aria-label^="Remove from"]', drawer())).toBeNull();
  });

  it('revokes one of the person\'s tokens through the tenant-wide revoke, behind a confirmation', async () => {
    await open('user:u-ann', [['POST', '/api/tokens/revoke', () => ({ requested: 1, revoked: 1, skipped: 0, failed: 0, results: [{ id: 't-ci', outcome: 'revoked' }] })]]);
    await click(q('button[aria-label="Revoke ci-token"]', drawer()));
    await settle(80);
    const dialog = qa('[role="dialog"]').at(-1)!;
    expect(dialog.textContent).toContain('Revoke this token?');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Revoke'));
    await settle(150);
    const calls = api.to('POST', '/api/tokens/revoke');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ ids: ['t-ci'] });
  });

  it('says why the tokens are not shown, and which are cut off', async () => {
    await open('user:u-owner', [['GET', '/api/iam/principals/user/u-owner', () => personDetail('u-owner', { tokens: [], tokensHidden: true })]]);
    expect(inDrawer('[data-testid="tokens-hidden"]')?.textContent).toContain('not visible to you');

    await mounted.unmount();
    await open('user:u-ann', [['GET', '/api/iam/principals/user/u-ann', () => personDetail('u-ann', { tokensTruncated: true, tokensTotal: 140 })]]);
    expect(inDrawer('[data-testid="section-tokens"]')?.textContent).toContain('Showing 1 of 140 tokens.');
    const seeAll = qa<HTMLAnchorElement>('a', drawer()).find((a) => a.textContent === 'See all');
    expect(seeAll?.getAttribute('href')).toBe('/dashboard/iam?tab=principals&principalType=token&ownerId=u-ann');
  });

  it('changes a direct project role and removes a direct membership; implicit and group projects are read-only', async () => {
    await open('user:u-ann', [
      ['PATCH', '/api/projects/p-a/members', () => ({ userProject: {} })],
      ['DELETE', '/api/projects/p-a/members', () => ({ success: true })],
    ]);
    await click(q('button[aria-label="Actions for Alpha"]', drawer()));
    await settle(60);
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Project admin'));
    await settle(100);
    expect(api.to('PATCH', '/api/projects/p-a/members')[0]?.body).toEqual({ userId: 'u-ann', role: 'project_admin' });

    await click(q('button[aria-label="Actions for Alpha"]', drawer()));
    await settle(60);
    await click(qa('[role="menuitem"]').find((i) => i.textContent === 'Remove from project'));
    await settle(80);
    await click(qa<HTMLButtonElement>('button', qa('[role="dialog"]').at(-1)!).find((b) => b.textContent === 'Remove'));
    await settle(120);
    expect(api.to('DELETE', '/api/projects/p-a/members')[0]?.body).toEqual({ userId: 'u-ann' });

    await mounted.unmount();
    await open('user:u-admin');
    // an admin reaches every project: nothing to edit, nothing to add
    expect(q('button[aria-label^="Actions for"]', drawer())).toBeNull();
    expect(buttonByText('Add to project')).toBeUndefined();
  });
});

describe('a group', () => {
  const MEMBERS = {
    items: [
      { userId: 'u-ann', label: 'Ann Lee', email: 'ann@example.com', role: 'user', status: 'active', kind: 'person', membershipSource: 'local' },
      { userId: 'u-gone', label: 'u-gone', membershipSource: 'local', missing: true },
    ],
    nextCursor: null,
    total: 2,
  };
  const membersRoute: [string, RegExp, RouteHandler] = ['GET', /^\/api\/iam\/principals\/group\/[^/]+\/members$/, () => MEMBERS];

  it('shows what the group gives, its members (orphans included) and its projects', async () => {
    await open('group:g-eng', [membersRoute]);
    const t = drawer().textContent!;
    expect(t).toContain('Engineering');
    expect(t).toContain('Agents: Read');
    expect(t).toContain('Ann Lee');
    expect(t).toContain('Deleted account');
    expect(t).toContain('1-2 of 2');
    expect(qa('[data-testid="group-project"]', drawer())).toHaveLength(1);
    expect(api.to('GET', '/api/iam/principals/group/g-eng/members')[0]?.query).toEqual({ limit: '50' });
  });

  it('removes the people ticked, and an orphan membership by id', async () => {
    await open('group:g-eng', [
      membersRoute,
      ['POST', '/api/users/bulk', () => ({ action: 'remove-from-group', dryRun: false, requested: 1, ok: 1, skipped: 0, failed: 0, results: [{ id: 'u-ann', outcome: 'ok' }] })],
      ['DELETE', '/api/groups/g-eng/members/u-gone', () => ({ message: 'ok' })],
    ]);
    const boxes = qa<HTMLInputElement>('[data-testid="group-member"] input[type="checkbox"]', drawer());
    await click(boxes[0]);
    await click(boxes[1]);
    await click(buttonByText('Remove selected'));
    await settle(150);
    expect(api.to('POST', '/api/users/bulk')[0]?.body).toEqual({ action: 'remove-from-group', ids: ['u-ann'], groupId: 'g-eng' });
    expect(api.to('DELETE', '/api/groups/g-eng/members/u-gone')).toHaveLength(1);
  });

  it('is read-only for a directory group, and says so', async () => {
    await open('group:g-dir', [membersRoute]);
    expect(inDrawer('[data-testid="directory-group-note"]')?.textContent).toContain('managed by your directory');
    expect(qa('[data-testid="group-member"] input[type="checkbox"]', drawer())).toHaveLength(0);
    expect(action('act-delete-group')!.disabled).toBe(true);
    expect(action('act-edit-group')!.disabled).toBe(false);
  });

  it('deletes a group behind a confirmation that counts the policies naming it', async () => {
    await open('group:g-eng', [membersRoute, ['DELETE', '/api/groups/g-eng', () => ({ message: 'Group deleted successfully' })]]);
    await click(action('act-delete-group'));
    await settle(80);
    const dialog = qa('[role="dialog"]').at(-1)!;
    expect(dialog.textContent).toContain('Delete this group?');
    expect(dialog.textContent).toContain('1 custom policies name this group');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Delete group'));
    await settle(150);
    expect(api.to('DELETE', '/api/groups/g-eng')).toHaveLength(1);
  });

  it('assigns the group to a project through a full-screen form', async () => {
    await open('group:g-eng', [membersRoute]);
    await click(buttonByText('Assign project'));
    await settle(150);
    expect(q('.form-overlay')?.textContent).toContain('Assign Engineering to a project');
    // Alpha is already assigned: only Beta is on offer
    expect(api.to('GET', '/api/projects').length).toBeGreaterThan(0);
  });
});

describe('a token', () => {
  it('shows its owner, project and badges, and offers edit and revoke', async () => {
    await open('token:t-ci');
    const t = drawer().textContent!;
    expect(t).toContain('ci-token');
    expect(t).toContain('Ann Lee');
    expect(t).toContain('Alpha');
    expect(t).toContain('Scoped');
    expect(action('act-edit-token')!.disabled).toBe(false);
    expect(action('act-revoke-token')!.disabled).toBe(false);
  });

  it('revokes by id, tenant-wide, then closes the drawer', async () => {
    await open('token:t-ci', [['POST', '/api/tokens/revoke', () => ({ requested: 1, revoked: 1, skipped: 0, failed: 0, results: [{ id: 't-ci', outcome: 'revoked' }] })]]);
    await click(action('act-revoke-token'));
    await settle(80);
    await click(qa<HTMLButtonElement>('button', qa('[role="dialog"]').at(-1)!).find((b) => b.textContent === 'Revoke'));
    await settle(200);
    expect(api.to('POST', '/api/tokens/revoke')[0]?.body).toEqual({ ids: ['t-ci'] });
    expect(new URLSearchParams(window.location.search).get('principalId')).toBeNull();
  });

  it('keeps a refusal inside the confirmation instead of closing', async () => {
    await open('token:t-ci', [['POST', '/api/tokens/revoke', () => ({ requested: 1, revoked: 0, skipped: 0, failed: 1, results: [{ id: 't-ci', outcome: 'failed', code: 'higher_privileges' }] })]]);
    await click(action('act-revoke-token'));
    await settle(80);
    await click(qa<HTMLButtonElement>('button', qa('[role="dialog"]').at(-1)!).find((b) => b.textContent === 'Revoke'));
    await settle(150);
    expect(qa('[role="dialog"]').at(-1)!.textContent).toContain('This account has more privileges than yours.');
  });

  it('opens the token form of the shared token screens on edit', async () => {
    await open('token:t-ci', [['GET', '/api/tokens/policy', () => ({ maxLifetimeDays: null, requireExpiry: false, expiryRequired: false, maxIpRanges: 10, clientIp: null, trustsForwardedHeaders: false })]]);
    await click(action('act-edit-token'));
    await settle(150);
    expect(new URLSearchParams(window.location.search).get('edit')).toBe('token');
    expect(q('.form-overlay')?.textContent).toContain('ci-token');
  });
});

describe('how a refusal is explained', () => {
  it('words every reason the server can give, and anything else as "forbidden"', () => {
    const reasons = (messages.en as unknown as { iamDirectory: { reasons: Record<string, string> } }).iamDirectory.reasons;
    for (const reason of ACTION_DENIAL_REASONS) expect(reasons[reason], reason).toBeTruthy();
    expect(reasonKey('owner_immutable')).toBe('owner_immutable');
    expect(reasonKey('something_new')).toBe('forbidden');
    expect(reasonKey(undefined)).toBe('forbidden');
  });
});

// The drawer survives a server that fails: the profile is replaced by an error with a retry.
describe('a failing detail', () => {
  it('shows the error and retries', async () => {
    let fail = true;
    await open('user:u-ann', [['GET', '/api/iam/principals/user/u-ann', () => (fail ? jsonResponse({ error: 'boom' }, 500) : personDetail('u-ann'))]]);
    expect(drawer().textContent).toContain('Could not load the details');
    fail = false;
    await click(buttonByText('Try again'));
    await settle(150);
    expect(drawer().textContent).toContain('Engineering');
  });
});
