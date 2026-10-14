// @vitest-environment jsdom
/**
 * The portal side of the IAM center, rendered for real (jsdom) against contract-
 * shaped responses: the built-in portal rules in the policy list, the portal
 * channel in the editor, the actions a portal checks, the Access check of opening
 * a portal and of running an agent through one, and a replayed portal denial that
 * names its policies and says which of them has changed since.
 */

import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  setInput,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { CATALOG, defaultRoutes, MANAGED } from '../helpers/iamCenterFixtures';

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import AccessCheckTab from '@/components/iam/check/AccessCheckTab';
import PoliciesTab from '@/components/iam/policies/PoliciesTab';
import { loadCatalog } from '@/components/iam/useIamCatalog';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

// ── fixtures: a workspace that has portals ───────────────────────────────

const PORTAL_CATALOG = {
  ...CATALOG,
  services: [
    ...CATALOG.services,
    { id: 'portals', labelKey: 'iamApi.services.portals', adminService: true, label: 'Portals', category: 'admin' },
  ],
  actions: [
    ...CATALOG.actions.map((a) => (a.id === 'agent.invoke' ? { ...a, enforcedIn: ['portal'] } : a)),
    {
      id: 'portal.use', kind: 'resource', level: 'read', service: 'portals', resourceType: 'portal', verb: 'use',
      labelKey: 'iamApi.action.verb.use', labelParams: { type: 'portal' }, enforcedIn: ['portal'],
    },
  ],
  resourceTypes: [...CATALOG.resourceTypes, { type: 'portal', service: 'portals', labelKey: 'resources.types.portal' }],
};

const PORTAL_RULES = [
  {
    id: 'managed:portal:use', name: 'People on a portal\'s access list can open it', description: 'The list grants.',
    nameKey: 'iamApi.managed.portal-use.name', descriptionKey: 'iamApi.managed.portal-use.description',
    group: 'portal', effect: 'permit', cedar: '@managed("portal") permit(principal is User, action == Action::"portal.use", resource is Portal);',
  },
  {
    id: 'managed:portal:use-boundary', name: 'Only the access list opens a portal', description: 'Nobody else.',
    nameKey: 'iamApi.managed.portal-use-boundary.name', descriptionKey: 'iamApi.managed.portal-use-boundary.description',
    group: 'portal', effect: 'forbid', cedar: '@managed("portal") forbid(principal, action == Action::"portal.use", resource is Portal);',
  },
];

const PORTAL = { id: 'P1', key: 'branch', name: 'Branch assistant', status: 'enabled', mode: 'selected', userCount: 3, groupCount: 1 };
const ANN = { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [{ id: 'g-sales', name: 'Sales' }], tokenScope: null, status: null };

const DENIED_BY_LIST = {
  allowed: false,
  reasons: [{ cedarId: 'managed:portal:use-boundary', policyId: null, managed: true, name: 'Only the access list opens a portal', effect: 'forbid' }],
  defaultDeny: false,
  principalSummary: ANN,
  projectId: null,
  ownerSafety: false,
  enforcedAtGate: true,
  errors: [],
  portal: PORTAL,
};

const portalRoutes = (extra: Array<[string, string | RegExp, () => unknown]> = []) => [
  ...defaultRoutes(),
  ['GET', '/api/iam/catalog', () => PORTAL_CATALOG],
  ['GET', '/api/resources', (c: { query: Record<string, string> }) => ({
    items: c.query.type === 'portal'
      ? [{ type: 'portal', id: 'P1', key: 'branch', name: 'Branch assistant' }]
      : [{ type: c.query.type, id: 'a-support', key: 'support', name: 'Support bot', projectName: 'Alpha' }],
    total: 1,
  })],
  ['POST', '/api/iam/simulate', () => DENIED_BY_LIST],
  ...extra,
] as never;

async function renderCheck(search = '', routes = portalRoutes(), locale = 'en') {
  nav.search = search;
  api = installApiMock(routes);
  await loadCatalog(true); // the catalog is cached per page load: each test brings its own
  mounted = await mount(createElement(AccessCheckTab, { canManage: true }), locale);
  await settle(250);
}

async function renderPolicies(search = '', routes = portalRoutes()) {
  nav.search = search;
  api = installApiMock(routes);
  await loadCatalog(true);
  mounted = await mount(createElement(PoliciesTab, { canManage: true }));
  await settle(250);
}

/** Types into a Mantine searchable Select and picks the first matching option of THAT select's list. */
async function pick(input: HTMLInputElement, search: string, optionText: string | RegExp) {
  await click(input);
  if (search) await setInput(input, search);
  await settle(450);
  const listId = input.getAttribute('aria-controls');
  const scope: ParentNode = (listId && document.getElementById(listId)) || document.body;
  const option = qa('[role="option"]', scope).find((o) =>
    typeof optionText === 'string' ? o.textContent?.includes(optionText) : optionText.test(o.textContent ?? ''),
  );
  expect(option, `option ${String(optionText)}`).toBeTruthy();
  await click(option);
}

// ── the policy list and the editor ───────────────────────────────────────

describe('the built-in policies', () => {
  it('lists the portal rules in a group of their own, with what they are for', async () => {
    await renderPolicies('', portalRoutes([['GET', '/api/iam/policies', () => ({ managed: [...MANAGED, ...PORTAL_RULES], custom: [] })]]));
    const t = text();
    expect(t).toContain('Portals');
    expect(t).toContain('Who may open a portal and run agents in it is decided by the portal access list.');
    expect(t).toContain('Only the access list opens a portal');
    // after the boundaries, before nothing else
    expect(t.indexOf('Boundaries')).toBeLessThan(t.indexOf('Only the access list opens a portal'));
    expect(q('[data-testid="managed-portal-group"]')).not.toBeNull();
  });

  it('shows no Portals group when the server reports no portal rules', async () => {
    await renderPolicies();
    expect(q('[data-testid="managed-portal-group"]')).toBeNull();
  });
});

describe('the policy editor', () => {
  it('offers the Portal channel like the others, without a "reserved" note, and says what it covers', async () => {
    await renderPolicies();
    await click(buttonByText('Create policy'));
    await settle(80);
    const overlay = q('.form-overlay')!;
    // Conditions start collapsed for a new rule
    await click(qa('[role="button"][aria-expanded="false"]', overlay).find((e) => e.textContent?.includes('Conditions')));
    await settle(30);
    expect(overlay.textContent).toContain('Channels · optionalDashboardAPIPortal');
    expect(overlay.textContent).not.toMatch(/reserved/i);
    expect(overlay.textContent).toContain('Portal is a person using a portal.');
    expect(overlay.textContent).toContain('Read covers opening a portal and Write covers running its agents.');
  });

  it('marks the actions a portal checks, and picks a portal like any resource', async () => {
    await renderPolicies();
    await click(buttonByText('Create policy'));
    await settle(80);
    const overlay = q('.form-overlay')!;
    await click(qa('button', overlay).find((b) => b.textContent?.startsWith('Specific actions')));
    await settle(30);
    const badges = qa('[data-testid="enforced-in-portal"]', overlay);
    expect(badges.map((b) => b.textContent)).toEqual(['Checked in portals', 'Checked in portals']);
    // the two actions that carry it
    const rows = badges.map((b) => b.closest('label')?.textContent ?? '');
    expect(rows.some((r) => r.includes('portal.use'))).toBe(true);
    expect(rows.some((r) => r.includes('agent.invoke'))).toBe(true);
    // a tool action does not
    expect(overlay.textContent).toContain('tool.execute');
    expect(badges.some((b) => b.closest('label')?.textContent?.includes('tool.execute'))).toBe(false);
  });

  it('"block someone from this portal" opens a deny rule about that portal, ready for the person', async () => {
    await renderPolicies('tab=policies&new=1&resourceType=portal&resourceId=P1&resourceLabel=Branch+assistant');
    const overlay = q('.form-overlay')!;
    expect(overlay).not.toBeNull();
    const t = overlay.textContent ?? '';
    expect(t).toContain('Portals: Branch assistant'); // the Where pill
    expect(t).toContain('Selected actions (1)Portals · Use'); // the action
    expect(t).toMatch(/SummaryPolicyEffectDenyStatusEnabled/); // a deny rule
    expect(t).toContain('via Portal'); // in the portal channel
  });
});

// ── the Access check ─────────────────────────────────────────────────────

describe('the Access check of opening a portal', () => {
  it('asks about the portal itself, in the portal channel, and shows what its access list is', async () => {
    await renderCheck();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'portal', 'Portals · Use');
    expect(text()).toContain('Existing resource');
    await pick(q<HTMLInputElement>('input[placeholder="Search by name, key or ID"]')!, 'branch', 'Branch assistant');
    await click(buttonByText('Check access'));
    await settle(100);

    const calls = api.to('POST', '/api/iam/simulate');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      principal: { type: 'user', id: 'u-ann' },
      action: 'portal.use',
      resource: { kind: 'resource', type: 'portal', id: 'P1' },
      context: { channel: 'portal' },
    });
    expect(api.to('GET', '/api/resources')[0].query).toMatchObject({ type: 'portal' });

    const t = text();
    expect(t).toContain('Denied');
    // the deciding rule in plain words, with the way to change the list
    expect(t).toContain('Only the access list opens a portal');
    expect(t).toContain('The portal access list does not admit this person, and nothing else can open a portal or run its agents.');
    // the portal's facts: name and audience (counts, never names)
    const card = q('[data-testid="check-portal"]')!;
    expect(card.textContent).toContain('Branch assistant');
    expect(card.textContent).toContain('3 people and 1 groups on the access list');
    expect(qa<HTMLAnchorElement>('a').filter((a) => a.getAttribute('href') === '/dashboard/portals/P1').length).toBeGreaterThan(0);
    // it is a real decision of a real runtime: no "not enforced" note
    expect(t).not.toContain('a real request is not held to it yet');
  });

  it('says a portal that is open to everyone, and one that is switched off', async () => {
    const open = { ...DENIED_BY_LIST, allowed: true, reasons: [], defaultDeny: false, portal: { ...PORTAL, mode: 'all', status: 'disabled' } };
    await renderCheck('tab=check&principalType=user&principalId=u-ann&action=portal.use&resourceType=portal&resourceId=P1&channel=portal',
      portalRoutes([['POST', '/api/iam/simulate', () => open]]));
    await settle(200);
    const card = q('[data-testid="check-portal"]')!;
    expect(card.textContent).toContain('Open to everyone in the workspace');
    expect(card.textContent).toContain('Switched off');
  });

  it('a link that names only the portal prefills the form and waits for the person', async () => {
    await renderCheck('tab=check&action=portal.use&resourceType=portal&resourceId=P1&resourceLabel=Branch+assistant&channel=portal');
    await settle(200);
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    expect(q<HTMLInputElement>('input[placeholder="Search users"]')).not.toBeNull();
    expect(text()).toContain('Branch assistant');
    // choosing the person completes it
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await click(buttonByText('Check access'));
    await settle(100);
    expect(api.to('POST', '/api/iam/simulate')[0].body).toMatchObject({
      action: 'portal.use', resource: { kind: 'resource', type: 'portal', id: 'P1' }, context: { channel: 'portal' },
    });
  });

  it('tells a token it cannot open portals, and offers no portal channel for it', async () => {
    await renderCheck();
    await click(qa<HTMLLabelElement>('label').find((l) => l.textContent === 'API token'));
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'portal', 'Portals · Use');
    expect(q('[data-testid="token-portal-note"]')?.textContent).toContain('API tokens cannot open portals');
    await click(buttonByText(/^Context/));
    const channel = qa<HTMLInputElement>('input').find((i) => i.value === 'API')!;
    await click(channel);
    await settle(30);
    const options = qa('[role="option"]', document.getElementById(channel.getAttribute('aria-controls') ?? '') ?? document.body).map((o) => o.textContent);
    expect(options).toEqual(['Dashboard', 'API']);
  });
});

describe('the Access check of running an agent through a portal', () => {
  it('asks which portal, and sends it with the portal channel', async () => {
    await renderCheck();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    await pick(q<HTMLInputElement>('input[placeholder="Search by name, key or ID"]')!, 'sup', 'Support bot');
    // the dashboard playground runs agents too: nothing forces the portal channel
    await click(buttonByText('Check access'));
    await settle(100);
    expect(api.to('POST', '/api/iam/simulate')[0].body).toMatchObject({ context: { channel: 'dashboard' } });
    expect((api.to('POST', '/api/iam/simulate')[0].body as { context: Record<string, string> }).context.portalId).toBeUndefined();

    expect(text()).toContain('Through portal');
    await pick(q<HTMLInputElement>('input[placeholder="Search portals"]')!, 'branch', 'Branch assistant');
    await click(buttonByText('Check access'));
    await settle(100);
    const calls = api.to('POST', '/api/iam/simulate');
    expect(calls[1].body).toEqual({
      principal: { type: 'user', id: 'u-ann' },
      action: 'agent.invoke',
      resource: { kind: 'resource', type: 'agent', id: 'a-support' },
      context: { channel: 'portal', portalId: 'P1' },
    });
    expect(text()).toContain('Agents: Support bot · Portals: Branch assistant');
  });

  it('does not offer a portal where there are none (the catalog says the action is not checked in portals)', async () => {
    await renderCheck('', [...defaultRoutes(), ['POST', '/api/iam/simulate', () => DENIED_BY_LIST]] as never);
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    expect(text()).toContain('Existing resource');
    expect(text()).not.toContain('Through portal');
  });

  it('asks for the portal when the portal channel is chosen by hand', async () => {
    await renderCheck();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    await pick(q<HTMLInputElement>('input[placeholder="Search by name, key or ID"]')!, 'sup', 'Support bot');
    await click(buttonByText(/^Context/));
    await pick(qa<HTMLInputElement>('input').find((i) => i.value === 'Dashboard')!, '', 'Portal');
    await settle(30);
    await click(buttonByText('Check access'));
    await settle(60);
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    expect(text()).toContain('Choose the portal the agent is run through.');
  });
});

describe('replaying a refusal of the portal runtime', () => {
  const decision = (policies: unknown[], simulate: unknown = DENIED_BY_LIST) =>
    portalRoutes([
      [
        'GET',
        /^\/api\/iam\/decisions\/[^/]+$/,
        () => ({
          decisionId: 'dec-portal-1',
          at: '2026-10-10T09:00:00.000Z',
          principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' },
          service: 'portals',
          required: '',
          route: '/api/portal/branch/info',
          method: 'GET',
          code: 'forbidden',
          channel: 'portal',
          resource: { type: 'portal', id: 'P1', label: 'Branch assistant' },
          simulateInput: {
            principal: { type: 'user', id: 'u-ann' },
            action: 'portal.use',
            resource: { kind: 'resource', type: 'portal', id: 'P1' },
            context: { channel: 'portal', at: '2026-10-10T09:00:00.000Z' },
          },
          policyIds: (policies as Array<{ policyId: string }>).map((p) => p.policyId),
          policies,
          reasons: [],
        }),
      ],
      ['POST', '/api/iam/simulate', () => simulate],
    ]);

  it('replays the check on the portal, in its channel, and names what was asked', async () => {
    await renderCheck('tab=check&decisionId=dec-portal-1', decision([]));
    await settle(250);
    expect(api.to('POST', '/api/iam/simulate')[0].body).toEqual({
      principal: { type: 'user', id: 'u-ann' },
      action: 'portal.use',
      resource: { kind: 'resource', type: 'portal', id: 'P1' },
      context: { channel: 'portal', at: '2026-10-10T09:00:00.000Z' },
    });
    const header = q('[data-testid="decision-resource"]')!.textContent ?? '';
    expect(header).toContain('Portals: Branch assistant');
    expect(text()).toContain('Channel: Portal');
    // a portal refusal is not "needed read on Portals"
    expect(text()).not.toContain('needed Read on');
  });

  it('shows the names of the policies that decided - not their ids - and links the ones that still exist', async () => {
    const policies = [
      { policyId: 'p-9f2a77c1e0aa', name: 'Contractors cannot open portals', status: 'active' },
    ];
    await renderCheck('tab=check&decisionId=dec-portal-1', decision(policies));
    await settle(250);
    const list = q('[data-testid="decision-policies"]')!;
    expect(list.textContent).toContain('Contractors cannot open portals');
    expect(list.textContent).not.toContain('p-9f2a77c1e0aa');
    const link = qa<HTMLAnchorElement>('a', list).find((a) => a.textContent === 'Contractors cannot open portals')!;
    expect(link.getAttribute('href')).toBe('/dashboard/iam?tab=policies&policyId=p-9f2a77c1e0aa');
    expect(q('[data-testid="decision-stale"]')).toBeNull();
  });

  it('says a deciding policy has been switched off or deleted since, and what the policies say now', async () => {
    const policies = [
      { policyId: 'p-off', name: 'Weekend freeze', status: 'disabled' },
      { policyId: 'p-gone', name: 'Old contractor rule', status: 'deleted' },
      { policyId: 'p-ghost-12345678', name: null, status: 'deleted' },
    ];
    const allowedNow = { ...DENIED_BY_LIST, allowed: true, reasons: [], defaultDeny: false };
    await renderCheck('tab=check&decisionId=dec-portal-1', decision(policies, allowedNow));
    await settle(250);
    const stale = q('[data-testid="decision-stale"]')!.textContent ?? '';
    expect(stale).toContain('A policy that decided this has changed since');
    expect(stale).toContain('Switched off since: Weekend freeze');
    expect(stale).toContain('Deleted since: Old contractor rule, p-ghost-');
    expect(stale).toContain('With the policies as they are now, this request would be allowed.');

    const statuses = qa('[data-testid="decision-policy"]').map((e) => [e.getAttribute('data-status'), e.textContent]);
    expect(statuses).toEqual([
      ['disabled', 'Weekend freezeSwitched off'],
      ['deleted', 'Old contractor ruleDeleted'],
      ['deleted', 'p-ghost-Deleted'], // no name was ever kept: a short id, not a link
    ]);
    // a policy that is gone cannot be opened
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/iam?tab=policies&policyId=p-gone')).toBe(false);
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/iam?tab=policies&policyId=p-off')).toBe(true);
  });

  it('says it is still denied when the policies as they are now still refuse it', async () => {
    await renderCheck('tab=check&decisionId=dec-portal-1', decision([{ policyId: 'p-gone', name: 'Old rule', status: 'deleted' }]));
    await settle(250);
    expect(q('[data-testid="decision-stale"]')!.textContent).toContain('With the policies as they are now, it is still denied.');
  });
});

describe('in Turkish', () => {
  it('words the portal Access check and the stale policy note with no raw keys', async () => {
    await renderCheck('tab=check&decisionId=dec-portal-1', portalRoutes([
      [
        'GET',
        /^\/api\/iam\/decisions\/[^/]+$/,
        () => ({
          decisionId: 'dec-portal-1', at: '2026-10-10T09:00:00.000Z', principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' },
          service: 'portals', required: '', route: '', method: '', code: 'forbidden', channel: 'portal',
          resource: { type: 'portal', id: 'P1', label: 'Şube asistanı' },
          simulateInput: { principal: { type: 'user', id: 'u-ann' }, action: 'portal.use', resource: { kind: 'resource', type: 'portal', id: 'P1' }, context: { channel: 'portal' } },
          policyIds: ['p-off'], policies: [{ policyId: 'p-off', name: 'Hafta sonu kuralı', status: 'disabled' }], reasons: [],
        }),
      ],
    ]), 'tr');
    await settle(250);
    const t = text();
    expect(t).toContain('Bu kararı veren bir politika sonradan değişti');
    expect(t).toContain('Sonradan kapatıldı: Hafta sonu kuralı');
    expect(t).toContain('Kanal: Portal');
    expect(t).toContain('Portalın erişim listesi bu kişiyi kabul etmiyor');
    expect(t).not.toMatch(/iamCenter\.[a-zA-Z]/);
  });
});
