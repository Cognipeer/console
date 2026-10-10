// @vitest-environment jsdom
/**
 * The Principals and Audit tabs, rendered for real (jsdom) against contract-shaped
 * API answers: what an admin sees and the exact requests the UI sends.
 */

import { createElement, Fragment } from 'react';
import { Notifications, notifications } from '@mantine/notifications';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import AuditTab from '@/components/iam/audit/AuditTab';
import PrincipalsTab from '@/components/iam/principals/PrincipalsTab';

// ── contract-shaped answers ──────────────────────────────────────────────

const CATALOG = {
  services: [
    { id: 'models', labelKey: 'iam.service.models', adminService: false },
    { id: 'agents', labelKey: 'iam.service.agents', adminService: false },
    { id: 'iam', labelKey: 'iam.service.iam', adminService: true },
  ],
  actions: [],
  resourceTypes: [],
  contextAttrs: [],
  channels: ['dashboard', 'api', 'portal'],
};

const USERS = [
  { type: 'user', id: 'u-ann', label: 'Ann Lee', sublabel: 'ann@example.com', role: 'owner', status: 'active', policyCount: 2 },
  { type: 'user', id: 'u-bob', label: 'Bob Ray', sublabel: 'bob@example.com', role: 'user', status: 'disabled', policyCount: 0 },
  { type: 'user', id: 'u-cy', label: 'Cy Doe', sublabel: 'cy@example.com', role: 'admin', status: 'active', policyCount: 0 },
];
const GROUPS = [
  { type: 'group', id: 'g-eng', label: 'Engineering', sublabel: 'Platform team', memberCount: 42, policyCount: 1 },
  { type: 'group', id: 'g-sales', label: 'Sales', sublabel: '', memberCount: 7, policyCount: 0 },
];
const TOKENS = [{ type: 'token', id: 't-ci', label: 'CI pipeline', sublabel: 'cp_8f2a… · Ann Lee', status: 'active', policyCount: 0 }];

const DETAIL: Record<string, unknown> = {
  'user:u-ann': {
    principal: { type: 'user', id: 'u-ann', label: 'Ann Lee', sublabel: 'ann@example.com', role: 'owner', status: 'active', email: 'ann@example.com', authProvider: 'local', canLogin: true },
    effective: [
      { service: 'models', level: 'admin', sources: [{ kind: 'role', label: 'owner', level: 'admin' }] },
      { service: 'agents', level: 'write', sources: [{ kind: 'group', label: 'Engineering', level: 'write' }, { kind: 'policy', label: 'p-notebooks', level: 'write' }] },
      { service: 'iam', level: 'none', sources: [] },
    ],
    groups: [{ id: 'g-eng', name: 'Engineering' }],
    projects: [{ id: 'proj-a', name: 'Alpha', role: 'project_admin', via: 'direct' }, { id: 'proj-b', name: 'Beta', role: 'member', via: 'group', groupName: 'Engineering' }],
    policies: [
      { policyId: 'p-notebooks', name: 'Allow notebooks', description: '', effect: 'permit', enabled: true, spec: { effect: 'permit', principals: { groups: ['g-eng'] }, actions: ['agents.write'], resources: { any: true } }, cedar: '', statementCount: 1, createdAt: '', updatedAt: '', updatedBy: '', updatedByLabel: '' },
    ],
    tokens: [{ id: 't-ci', label: 'CI pipeline', prefix: 'cp_8f2a', projectId: null, scoped: true, createdAt: null, expiresAt: null, lastUsedAt: null, status: 'active' }],
  },
  'group:g-eng': {
    principal: { type: 'group', id: 'g-eng', label: 'Engineering', sublabel: 'Platform team', memberCount: 42, source: 'local', tenantRole: null },
    effective: [{ service: 'agents', level: 'write', sources: [{ kind: 'group', label: 'Engineering', level: 'write' }] }],
    groups: [],
    projects: [],
    policies: [],
    tokens: null,
  },
  'token:t-ci': {
    principal: { type: 'token', id: 't-ci', label: 'CI pipeline', sublabel: 'cp_8f2a…', role: 'owner', status: 'active', ownerId: 'u-ann', ownerLabel: 'Ann Lee', scope: { models: 'read' }, expiresAt: null, lastUsedAt: null },
    effective: [{ service: 'models', level: 'read', sources: [{ kind: 'token-scope', label: 'Token scope', level: 'read' }] }],
    groups: [],
    projects: [],
    policies: [],
    tokens: null,
  },
};

const DENIALS = [
  { id: 'a1', at: '2026-10-09T10:00:00.000Z', kind: 'denials', principal: { type: 'user', id: 'u-bob', label: 'Bob Ray' }, service: 'models', action: 'models.write', route: '/api/models/m1', method: 'PUT', code: 'forbidden', decisionId: 'dec-0001', summary: 'Denied PUT /api/models/m1: models needs write because no rule allows it' },
  { id: 'a2', at: '2026-10-09T09:00:00.000Z', kind: 'denials', principal: { type: 'token', id: 't-ci', label: 'CI pipeline' }, service: 'iam', action: 'security', route: '/api/internal/x', method: 'GET', code: 'route_not_declared', summary: 'Blocked: GET /api/internal/x has no authorization declaration' },
  // the engine could not decide (HTTP 503): not a policy answer
  { id: 'a3', at: '2026-10-09T08:00:00.000Z', kind: 'denials', principal: { type: 'user', id: 'u-bob', label: 'Bob Ray' }, service: 'agents', action: 'agents.read', route: '/api/agents', method: 'GET', code: 'authorization_unavailable', decisionId: 'dec-0003', summary: 'Refused GET /api/agents: authorization was temporarily unavailable', text: { key: 'unavailable', params: { route: 'GET /api/agents' } } },
];
const CHANGES = [
  { id: 'c1', at: '2026-10-08T10:00:00.000Z', kind: 'changes', principal: null, actor: 'ann@example.com', service: 'iam', action: 'iam.policy.create', policyId: 'p-notebooks', summary: 'Created policy "Allow notebooks" (permit)' },
  { id: 'c2', at: '2026-10-08T09:00:00.000Z', kind: 'changes', principal: null, actor: 'ann@example.com', service: 'tokens', action: 'token.restrictions.updated', summary: 'Changed the restrictions of token "CI pipeline"' },
];

const page = <T>(items: T[], cursor: string | undefined, size: number, next: (offset: number) => string) => {
  const offset = cursor ? Number(cursor.replace('o', '')) : 0;
  const slice = items.slice(offset, offset + size);
  return { items: slice, nextCursor: offset + size < items.length ? next(offset + size) : null };
};

/** The defaults first, a test's own handlers after them: the mock lets the last matching route win. */
function routes(extra: Array<[string, string | RegExp, RouteHandler]> = []): Array<[string, string | RegExp, RouteHandler]> {
  const defaults: Array<[string, string | RegExp, RouteHandler]> = [
    ['GET', '/api/iam/catalog', () => CATALOG],
    [
      'GET',
      '/api/iam/principals',
      (c) => {
        const all = c.query.type === 'group' ? GROUPS : c.query.type === 'token' ? TOKENS : USERS;
        const needle = (c.query.q ?? '').toLowerCase();
        const items = needle ? all.filter((i) => `${i.label} ${i.sublabel}`.toLowerCase().includes(needle)) : all;
        return page(items, c.query.cursor, Number(c.query.limit ?? 25), (o) => `o${o}`);
      },
    ],
    [
      'GET',
      /^\/api\/iam\/principals\/(user|group|token)\/[^/]+$/,
      (c) => {
        const [, , , , type, id] = c.path.split('/');
        const detail = DETAIL[`${type}:${decodeURIComponent(id!)}`];
        return detail ?? jsonResponse({ error: 'Principal not found', code: 'principal_not_found' }, 404);
      },
    ],
    [
      'GET',
      '/api/iam/audit',
      (c) => {
        const all = c.query.kind === 'changes' ? CHANGES : DENIALS;
        const items = all.filter((i) => (!c.query.service || i.service === c.query.service) && (!c.query.principalId || i.principal?.id === c.query.principalId));
        return page(items, c.query.cursor, Number(c.query.limit ?? 25), (o) => `o${o}`);
      },
    ],
  ];
  return [...defaults, ...extra];
}

// ── harness ──────────────────────────────────────────────────────────────

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());

afterEach(async () => {
  notifications.clean();
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
  window.history.replaceState(null, '', '/');
});

async function render(
  element: ReturnType<typeof createElement>,
  extra: Array<[string, string | RegExp, RouteHandler]> = [],
  search = '',
  locale = 'en',
) {
  nav.search = search;
  api = installApiMock(routes(extra));
  mounted = await mount(element, locale);
  await settle(250);
}

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });

const rowsText = () => qa('table.ds-tbl tbody tr').map((r) => r.textContent ?? '');
const principalCalls = () => api.to('GET', '/api/iam/principals');
const lastQuery = (calls: ReturnType<ApiMock['to']>) => calls[calls.length - 1]?.query ?? {};

// ── Principals ───────────────────────────────────────────────────────────

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('PrincipalsTab', () => {
  it('lists the users of the first page, 25 at a time, with role and status', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    expect(principalCalls()[0]?.query).toEqual({ type: 'user', limit: '25' });
    const rows = rowsText();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Ann Lee');
    expect(rows[0]).toContain('ann@example.com');
    expect(rows[0]).toContain('Owner');
    expect(rows[1]).toContain('Disabled');
    expect(rows[2]).toContain('Admin');
  });

  it('searches on the server, once, after the typing stops', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    const before = principalCalls().length;
    const input = q<HTMLInputElement>('.ds-toolbar-search input')!;
    await setInput(input, 'b');
    await setInput(input, 'bo');
    await setInput(input, 'bob');
    await settle(500);
    expect(principalCalls().length).toBe(before + 1);
    expect(lastQuery(principalCalls())).toEqual({ type: 'user', q: 'bob', limit: '25' });
    expect(rowsText()).toHaveLength(1);
    expect(rowsText()[0]).toContain('Bob Ray');
  });

  it('says so when nothing matches', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await setInput(q<HTMLInputElement>('.ds-toolbar-search input')!, 'nobody');
    await settle(500);
    expect(text()).toContain('No matches');
    expect(text()).toContain('Nothing matches "nobody"');
  });

  it('pages forward with the cursor the server gave, and back without it', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }), [
      [
        'GET',
        '/api/iam/principals',
        (c) =>
          c.query.cursor === 'page-2'
            ? { items: [USERS[2]], nextCursor: null }
            : { items: [USERS[0], USERS[1]], nextCursor: 'page-2' },
      ],
    ]);
    expect(rowsText()).toHaveLength(2);
    await click(buttonByText(/^Next$/));
    await settle(250);
    expect(lastQuery(principalCalls())).toEqual({ type: 'user', limit: '25', cursor: 'page-2' });
    expect(rowsText()).toHaveLength(1);
    expect(text()).toContain('Page 2');
    expect(buttonByText(/^Next$/)?.hasAttribute('disabled')).toBe(true);
    await click(buttonByText(/^Previous$/));
    await settle(250);
    expect(lastQuery(principalCalls())).toEqual({ type: 'user', limit: '25' });
    expect(text()).toContain('Page 1');
  });

  it('switches to groups, with member counts, and starts over on page 1', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await click(qa('label').find((l) => l.textContent === 'Groups') ?? null);
    await settle(250);
    expect(lastQuery(principalCalls())).toEqual({ type: 'group', limit: '25' });
    const rows = rowsText();
    expect(rows[0]).toContain('Engineering');
    expect(rows[0]).toContain('42');
    expect(rows[0]).toContain('Platform team');
    expect(text()).toContain('A group grants access to all of its members');
  });

  it('opens the detail drawer: effective permissions with their sources, groups, projects, policies, tokens', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    const detailCalls = api.to('GET', '/api/iam/principals/user/u-ann');
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]?.query).toEqual({});
    const t = text();
    expect(t).toContain('Effective permissions');
    expect(t).toContain('Model Hub'); // service label from the built-in names (the catalog key has no message)
    expect(t).toContain('Role: Owner'); // the role source, in the user's language
    expect(t).toContain('Group: Engineering');
    expect(t).toContain('Policy: Allow notebooks'); // the policy id of the source is turned into the policy name
    expect(t).toContain('Alpha');
    expect(t).toContain('Via group Engineering');
    expect(t).toContain('Allow notebooks');
    expect(t).toContain('cp_8f2a…');
    // actions
    const hrefs = qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/iam?tab=check&principalType=user&principalId=u-ann');
    expect(hrefs).toContain('/dashboard/iam?tab=policies&new=1&principalType=user&principalId=u-ann');
    expect(hrefs).toContain('/dashboard/iam?tab=policies&policyId=p-notebooks');
    // the open principal is mirrored into the address bar
    expect(window.location.search).toContain('principalType=user');
    expect(window.location.search).toContain('principalId=u-ann');
  });

  it('shows "Create policy" to admins only', async () => {
    await render(createElement(PrincipalsTab, { canManage: false }));
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    expect(text()).toContain('Effective permissions');
    expect(text()).not.toContain('Create policy');
    expect(text()).toContain('Simulate access');
  });

  it('goes from a group chip into the group and back', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    const chip = qa<HTMLButtonElement>('.mantine-Drawer-body button').find((b) => b.textContent === 'Engineering');
    await click(chip);
    await settle(300);
    expect(api.to('GET', '/api/iam/principals/group/g-eng')).toHaveLength(1);
    expect(window.location.search).toContain('principalType=group');
    await click(qa<HTMLButtonElement>('button[aria-label="Back"]')[0]);
    await settle(300);
    expect(window.location.search).toContain('principalType=user');
    expect(text()).toContain('ann@example.com');
  });

  it('opens an owned token and its owner', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    await click(qa<HTMLButtonElement>('.mantine-Drawer-body button').find((b) => b.textContent?.includes('CI pipeline')));
    await settle(300);
    expect(api.to('GET', '/api/iam/principals/token/t-ci')).toHaveLength(1);
    expect(text()).toContain('Owner');
    expect(text()).toContain('Scoped');
    // the owner is a link back to the user
    await click(qa<HTMLButtonElement>('.mantine-Drawer-body button').find((b) => b.textContent === 'Ann Lee'));
    await settle(300);
    expect(window.location.search).toContain('principalType=user');
  });

  it('closes the drawer and removes the principal from the address bar', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }));
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    expect(window.location.search).toContain('principalId=u-ann');
    await click(q('.mantine-Drawer-close'));
    await settle(200);
    expect(window.location.search).not.toContain('principalId');
    expect(window.location.search).not.toContain('principalType');
  });

  it('?principalType=group&principalId=… opens that group straight away, on the right segment', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }), [], '?tab=principals&principalType=group&principalId=g-eng');
    expect(api.to('GET', '/api/iam/principals/group/g-eng')).toHaveLength(1);
    expect(principalCalls()[0]?.query.type).toBe('group');
    expect(text()).toContain('Effective permissions');
  });

  it('tells the admin when the principal of a link is gone', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }), [], '?principalType=user&principalId=u-gone');
    expect(text()).toContain('This principal no longer exists.');
  });

  it('carries the load error in the grid and retries on request', async () => {
    let fail = true;
    await render(createElement(PrincipalsTab, { canManage: true }), [
      ['GET', '/api/iam/principals', () => (fail ? jsonResponse({ error: 'Database timeout', code: 'internal' }, 500) : { items: USERS, nextCursor: null })],
    ]);
    expect(text()).toContain('Could not load the list');
    expect(text()).toContain('Database timeout');
    expect(text()).not.toContain('No users yet');
    fail = false;
    await click(buttonByText(/Try again/));
    await settle(250);
    expect(rowsText()).toHaveLength(3);
  });

  it('explains a missing read permission', async () => {
    await render(createElement(PrincipalsTab, { canManage: false }), [
      ['GET', '/api/iam/principals', () => jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403)],
    ]);
    expect(text()).toContain('You need read access to the IAM service');
  });

  it('renders in Turkish', async () => {
    await render(createElement(PrincipalsTab, { canManage: true }), [], '', 'tr');
    expect(text()).toContain('Kullanıcılar');
    expect(text()).toContain('Sahip'); // role badge
    await click(buttonByText(/Ann Lee/));
    await settle(300);
    expect(text()).toContain('Etkin izinler');
  });
});

// ── Audit ────────────────────────────────────────────────────────────────

const auditCalls = () => api.to('GET', '/api/iam/audit');

describe('AuditTab', () => {
  it('lists the denials: who, what, the request and the decision that opens the Access check', async () => {
    await render(createElement(AuditTab));
    expect(auditCalls()[0]?.query).toEqual({ kind: 'denials', limit: '25' });
    const rows = rowsText();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Bob Ray');
    expect(rows[0]).toContain('Model Hub');
    expect(rows[0]).toContain('Write'); // `models.write`: the service name already says "models"
    expect(rows[0]).toContain('PUT /api/models/m1');
    expect(rows[0]).toContain('Forbidden');
    expect(rows[1]).toContain('Route not declared');
    // a request the engine could not decide is said as such - not as a rule that denied it
    expect(rows[2]).toContain('Engine unavailable');
    expect(rows[2]).toContain('Refused GET /api/agents: authorization was temporarily unavailable');
    expect(rows[2]).not.toContain('Forbidden');
    const hrefs = qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/iam?tab=check&decisionId=dec-0001');
    // its decision id opens the Access check too, which explains that there was no policy answer
    expect(hrefs).toContain('/dashboard/iam?tab=check&decisionId=dec-0003');
    // the principal opens in the Principals tab
    expect(hrefs).toContain('/dashboard/iam?tab=principals&principalType=user&principalId=u-bob');
    expect(hrefs).toContain('/dashboard/iam?tab=principals&principalType=token&principalId=t-ci');
  });

  it('says how long denials look back when no date range is picked', async () => {
    await render(createElement(AuditTab));
    expect(text()).toContain('Without a date range the last 30 days are shown.');
    expect(qa<HTMLInputElement>('input, button').some((e) => e.getAttribute('placeholder') === 'Last 30 days' || e.textContent === 'Last 30 days')).toBe(true);
  });

  it('switches between denials and policy changes (there is no monitor view any more)', async () => {
    await render(createElement(AuditTab));
    expect(qa('label').map((l) => l.textContent)).toEqual(expect.arrayContaining(['Denials', 'Policy changes']));
    expect(qa('label').map((l) => l.textContent)).not.toContain('Monitor');
    await click(qa('label').find((l) => l.textContent === 'Policy changes') ?? null);
    await settle(250);
    expect(auditCalls().pop()?.query).toEqual({ kind: 'changes', limit: '25' });
    expect(rowsText()[0]).toContain('ann@example.com');
    expect(rowsText()[0]).toContain('Policy created');
    expect(rowsText()[0]).toContain('Created policy "Allow notebooks"');
    expect(qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'))).toContain('/dashboard/iam?tab=policies&policyId=p-notebooks');
    // a token's restriction edit has a plain-words label, not the raw event name
    expect(rowsText()[1]).toContain('Token restrictions changed');
    expect(rowsText()[1]).not.toContain('token.restrictions.updated');

    await click(qa('label').find((l) => l.textContent === 'Denials') ?? null);
    await settle(250);
    expect(auditCalls().pop()?.query).toEqual({ kind: 'denials', limit: '25' });
  });

  it('shows a short id for a person or token that no longer has a name, the whole id on hover', async () => {
    const gone = 'bfc9decb-1383-4c0d-a4a6-89f184c250e5';
    await render(createElement(AuditTab), [
      [
        'GET',
        '/api/iam/audit',
        () => ({
          items: [{ ...DENIALS[1], id: 'a9', principal: { type: 'token', id: gone, label: gone } }],
          nextCursor: null,
        }),
      ],
    ]);
    const row = rowsText()[0];
    expect(row).toContain('bfc9decb');
    expect(row).not.toContain(gone);
    expect(qa('[title]').some((el) => el.getAttribute('title') === gone)).toBe(true);
  });

  it('pages with the cursor of the server', async () => {
    await render(createElement(AuditTab), [
      [
        'GET',
        '/api/iam/audit',
        (c) => (c.query.cursor === 'next' ? { items: [DENIALS[1]], nextCursor: null } : { items: [DENIALS[0]], nextCursor: 'next' }),
      ],
    ]);
    expect(rowsText()).toHaveLength(1);
    await click(buttonByText(/^Next$/));
    await settle(250);
    expect(auditCalls().pop()?.query).toEqual({ kind: 'denials', limit: '25', cursor: 'next' });
    expect(rowsText()[0]).toContain('Route not declared');
  });

  it('applies the filters of a link: view, service and principal (named after a lookup)', async () => {
    await render(
      createElement(AuditTab),
      [],
      '?tab=audit&kind=denials&service=agents&principalType=user&principalId=u-ann',
    );
    expect(auditCalls()[0]?.query).toEqual({
      kind: 'denials',
      service: 'agents',
      principalType: 'user',
      principalId: 'u-ann',
      limit: '25',
    });
    // the link only carries the id: the filter shows the name once the principal is looked up
    expect(api.to('GET', '/api/iam/principals/user/u-ann').length).toBeGreaterThan(0);
    expect(qa<HTMLInputElement>('input').some((i) => i.value === 'Ann Lee')).toBe(true);
    expect(buttonByText(/Clear filters/)).toBeDefined();
  });

  it('drops a principal the view cannot be filtered by (a token under policy changes)', async () => {
    await render(createElement(AuditTab), [], '?kind=changes&principalType=token&principalId=t-ci');
    expect(auditCalls()[0]?.query).toEqual({ kind: 'changes', limit: '25' });
  });

  it('clears the filters but keeps the view', async () => {
    await render(createElement(AuditTab), [], '?kind=changes&service=iam');
    await click(buttonByText(/Clear filters/));
    await settle(250);
    expect(auditCalls().pop()?.query).toEqual({ kind: 'changes', limit: '25' });
  });

  it('opens an old link to the removed monitor view on the denials instead', async () => {
    await render(createElement(AuditTab), [], '?tab=audit&kind=monitor&service=agents');
    expect(auditCalls()[0]?.query).toEqual({ kind: 'denials', service: 'agents', limit: '25' });
  });

  it('exports the same filters as CSV and hands the file to the browser', async () => {
    const created: Blob[] = [];
    const anchors: HTMLAnchorElement[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
      created.push(b);
      return 'blob:csv';
    };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this);
    });
    await render(
      createElement(AuditTab),
      [
        [
          'GET',
          '/api/iam/audit/export',
          () => new Response('time,kind\n2026-10-09,denials\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="iam-audit-denials-2026-10-09.csv"' } }),
        ],
      ],
      '?kind=denials&service=models',
    );
    await click(buttonByText(/Export CSV/));
    await settle(200);
    expect(api.to('GET', '/api/iam/audit/export')[0]?.query).toEqual({ kind: 'denials', service: 'models' });
    expect(created).toHaveLength(1);
    expect(await readBlob(created[0]!)).toContain('time,kind');
    expect(anchors[0]?.getAttribute('download')).toBe('iam-audit-denials-2026-10-09.csv');
  });

  it('tells the admin when the export failed', async () => {
    // the app mounts <Notifications /> in its root layout; a test has to do it itself
    await render(createElement(Fragment, null, createElement(Notifications, null), createElement(AuditTab)), [
      ['GET', '/api/iam/audit/export', () => jsonResponse({ error: 'Too many rows', code: 'internal' }, 500)],
    ]);
    await click(buttonByText(/Export CSV/));
    await settle(200);
    expect(text()).toContain('Could not export the audit trail');
    expect(text()).toContain('Too many rows');
  });

  it('carries the load error in the grid, and a retry', async () => {
    let fail = true;
    await render(createElement(AuditTab), [
      ['GET', '/api/iam/audit', () => (fail ? jsonResponse({ error: 'Forbidden', code: 'forbidden' }, 403) : { items: DENIALS, nextCursor: null })],
    ]);
    expect(text()).toContain('You need read access to the IAM service to view the audit trail.');
    expect(text()).not.toContain('No denials');
    fail = false;
    await click(buttonByText(/Try again/));
    await settle(250);
    expect(rowsText()).toHaveLength(DENIALS.length);
  });

  it('says plainly that nothing was refused, with no hint about a monitor mode', async () => {
    await render(createElement(AuditTab), [['GET', '/api/iam/audit', () => ({ items: [], nextCursor: null })]]);
    expect(text()).toContain('No denials');
    expect(text()).toContain('The policy engine has not refused any request in this period.');
    expect(text()).not.toMatch(/monitor mode|Nothing to report/i);
  });

  it('renders in Turkish', async () => {
    await render(createElement(AuditTab), [], '', 'tr');
    expect(text()).toContain('Reddedilenler');
    expect(text()).toContain('Yetkisiz'); // the `forbidden` code
    expect(text()).toContain('CSV olarak dışa aktar');
  });
});
