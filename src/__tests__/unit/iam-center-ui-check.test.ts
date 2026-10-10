// @vitest-environment jsdom
/**
 * Access check tab, rendered for real (jsdom) against contract-shaped API
 * responses: the guided request form, the deep links (decision / principal) and
 * every part of the result card.
 */

import { createElement } from 'react';
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
} from '../helpers/iamCenterUi';
import { defaultRoutes } from '../helpers/iamCenterFixtures';

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

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());

const DENIED = {
  allowed: false,
  reasons: [],
  defaultDeny: true,
  principalSummary: { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [{ id: 'g-sales', name: 'Sales' }] },
  projectId: null,
};

function simulateRoutes(result: unknown = DENIED) {
  return [
    ['POST', '/api/iam/simulate', () => result],
    [
      'GET',
      /^\/api\/iam\/decisions\/[^/]+$/,
      () => ({
        decisionId: 'dec-12345678',
        at: '2026-10-08T09:30:00.000Z',
        principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' },
        service: 'agents',
        required: 'write',
        route: '/api/agents',
        method: 'POST',
        code: 'forbidden',
        simulateInput: {
          principal: { type: 'user', id: 'u-ann' },
          action: 'agents.write',
          resource: { kind: 'service', service: 'agents' },
          context: { channel: 'dashboard', ip: '203.0.113.7', at: '2026-10-08T09:30:00.000Z' },
        },
        policyIds: ['p-contractors'],
        reasons: ['custom:p-contractors'],
      }),
    ],
  ] as Array<['POST' | 'GET', string | RegExp, () => unknown]>;
}

async function render(search = '', result?: unknown) {
  nav.search = search;
  api = installApiMock([...defaultRoutes(), ...simulateRoutes(result)]);
  mounted = await mount(createElement(AccessCheckTab, { canManage: true }));
  await settle(150);
}

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

/** Types into a Mantine searchable Select and picks the first matching option. */
async function pick(input: HTMLInputElement, search: string, optionText: string | RegExp) {
  await click(input);
  await setInput(input, search);
  await settle(450);
  const option = qa('[role="option"]').find((o) =>
    typeof optionText === 'string' ? o.textContent?.includes(optionText) : optionText.test(o.textContent ?? ''),
  );
  expect(option, `option ${String(optionText)}`).toBeTruthy();
  await click(option);
}

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('AccessCheckTab form', () => {
  it('asks for what is missing instead of sending an incomplete request', async () => {
    await render();
    expect(text()).toContain('Access check');
    await click(buttonByText('Check access'));
    await settle(30);
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    expect(text()).toContain('Choose a user or token.');
    expect(text()).toContain('Choose an action.');
  });

  it('checks a service action: the target follows the action, defaults follow the principal', async () => {
    await render();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    expect(text()).toContain('Choose an action to see what it applies to.');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'agents write', 'Agents · Write');
    expect(text()).toContain('The whole Agents service');

    await click(buttonByText('Check access'));
    await settle(100);
    const calls = api.to('POST', '/api/iam/simulate');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      principal: { type: 'user', id: 'u-ann' },
      action: 'agents.write',
      resource: { kind: 'service', service: 'agents' },
      context: { channel: 'dashboard' },
    });
    const t = text();
    expect(t).toContain('Denied');
    // nothing allows it: said with the person's role and the level they lack, with a way to change it
    expect(t).toContain('No rule allows this. Their workspace access (role User, own permissions and groups) does not include Write on Agents.');
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/members/u-ann' && a.textContent === 'Change role or permissions')).toBe(true);
    expect(t).toContain('Ann Lee → Agents · Write on Agents');
    // the engine decides every request: no mode, no comparison with older rules
    expect(t).not.toMatch(/Engine mode|Shadow|Monitor|legacy|current role rules/i);
  });

  it('checks a resource action on an existing resource found in the registry', async () => {
    await render();
    api.on('GET', '/api/resources', (c) => ({
      items: [{ type: c.query.type, id: 'a-support', key: 'support', name: 'Support bot', projectName: 'Alpha' }],
      total: 1,
    }));
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    expect(text()).toContain('Existing resource');
    await pick(q<HTMLInputElement>('input[placeholder="Search by name, key or ID"]')!, 'sup', 'Support bot');
    await click(buttonByText('Check access'));
    await settle(100);
    expect(api.to('POST', '/api/iam/simulate')[0].body).toMatchObject({
      action: 'agent.invoke',
      resource: { kind: 'resource', type: 'agent', id: 'a-support' },
    });
    expect(api.to('GET', '/api/resources')[0].query).toMatchObject({ type: 'agent' });
  });

  it('falls back to typing a resource id when the caller cannot browse the registry', async () => {
    await render();
    api.on('GET', '/api/resources', () => jsonResponse({ error: 'Forbidden' }, 403));
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    await settle(400);
    const idInput = q<HTMLInputElement>('input[placeholder="Resource ID"]');
    expect(idInput).not.toBeNull();
    await setInput(idInput!, 'a-typed');
    await click(buttonByText('Check access'));
    await settle(100);
    expect(api.to('POST', '/api/iam/simulate')[0].body).toMatchObject({
      resource: { kind: 'resource', type: 'agent', id: 'a-typed' },
    });
  });

  it('rejects an invalid IP before sending', async () => {
    await render();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'agents read', 'Agents · Read');
    await click(buttonByText(/^Context/));
    await setInput(q<HTMLInputElement>('input[placeholder="203.0.113.7"]')!, '999.1.1.1');
    await click(buttonByText('Check access'));
    await settle(50);
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    expect(text()).toContain('Not a valid IP address.');
  });

  it('shows the server error for an unknown principal', async () => {
    await render();
    api.on('POST', '/api/iam/simulate', () => jsonResponse({ error: 'User not found', code: 'principal_not_found' }, 404));
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'agents read', 'Agents · Read');
    await click(buttonByText('Check access'));
    await settle(100);
    expect(text()).toContain('The check failed');
    // localized through the server's own error table (iamApi.errors.<code>)
    expect(text()).toContain('This person, group or token no longer exists');
  });
});

describe('AccessCheckTab deep links', () => {
  it('?decisionId=… replays that denial and shows who decided it', async () => {
    await render('tab=check&decisionId=dec-12345678');
    await settle(200);
    expect(api.to('GET', '/api/iam/decisions/dec-12345678')).toHaveLength(1);
    const sim = api.to('POST', '/api/iam/simulate');
    expect(sim).toHaveLength(1);
    expect(sim[0].body).toEqual({
      principal: { type: 'user', id: 'u-ann' },
      action: 'agents.write',
      resource: { kind: 'service', service: 'agents' },
      context: { channel: 'dashboard', ip: '203.0.113.7', at: '2026-10-08T09:30:00.000Z' },
    });
    const t = text();
    expect(t).toContain('POST /api/agents');
    expect(t).toContain('Response: forbidden');
    expect(t).toContain('p-contractors'); // link to the deciding policy
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/iam?tab=policies&policyId=p-contractors')).toBe(true);
    expect(t).toContain('Denied');
    expect((q<HTMLInputElement>('input[placeholder="Decision ID"]')!).value).toBe('dec-12345678');
  });

  it('says so when the decision does not exist', async () => {
    nav.search = 'tab=check&decisionId=ghost-decision';
    api = installApiMock([...defaultRoutes(), ...simulateRoutes()]);
    api.on('GET', /^\/api\/iam\/decisions\/[^/]+$/, () => jsonResponse({ error: 'Decision not found', code: 'not_found' }, 404));
    mounted = await mount(createElement(AccessCheckTab, { canManage: true }));
    await settle(200);
    expect(text()).toContain('No decision with that ID.');
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
  });

  it('?principalType=token&principalId=…&action=… prefills and runs the check', async () => {
    await render('tab=check&principalType=token&principalId=t-ci&action=agents.write');
    await settle(250);
    const sim = api.to('POST', '/api/iam/simulate');
    expect(sim).toHaveLength(1);
    expect(sim[0].body).toEqual({
      principal: { type: 'token', id: 't-ci' },
      action: 'agents.write',
      resource: { kind: 'service', service: 'agents' },
      context: { channel: 'api' },
    });
    expect(api.to('GET', '/api/iam/principals/token/t-ci')).toHaveLength(1);
    expect(text()).toContain('ci-pipeline'); // label from the principal detail
  });

  it('only prefills when no action is given', async () => {
    await render('tab=check&principalType=user&principalId=u-bob');
    await settle(250);
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    expect(text()).toContain('Bob Ray');
  });
});

describe('AccessCheckTab (Turkish)', () => {
  it('renders the form and a result in Turkish with no raw translation keys', async () => {
    nav.search = 'tab=check&principalType=user&principalId=u-ann&action=agents.write';
    api = installApiMock([...defaultRoutes(), ...simulateRoutes()]);
    mounted = await mount(createElement(AccessCheckTab, { canManage: true }), 'tr');
    await settle(300);
    const t = text();
    expect(t).toContain('Erişim testi');
    expect(t).toContain('Reddedildi');
    expect(t).toContain('Hiçbir kural buna izin vermiyor');
    expect(t).toContain('Tüm Ajanlar servisi'); // the service name comes from the server's translated labels? no: built-in label
    expect(t).not.toMatch(/iamCenter\.[a-zA-Z]/);
  });
});

describe('SimulateResultCard', () => {
  const run = async (result: unknown, extra: Array<['GET' | 'POST', string | RegExp, () => unknown]> = [], search = 'tab=check&principalType=user&principalId=u-ann&action=agents.write') => {
    nav.search = search;
    api = installApiMock([...defaultRoutes(), ...simulateRoutes(result), ...(extra as never)]);
    mounted = await mount(createElement(AccessCheckTab, { canManage: true }));
    await settle(300);
  };
  const user = { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [] };
  const hrefs = () => qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'));

  it('lists the deciding policies: built-in in plain words, custom by name (linked)', async () => {
    await run({
      allowed: true,
      reasons: [
        { cedarId: 'managed:rbac:user-write', policyId: null, managed: true, name: 'Members can change what their access allows', effect: 'permit' },
        { cedarId: 'custom:p-analysts', policyId: 'p-analysts', managed: false, name: 'Analysts read cost', effect: 'permit' },
      ],
      defaultDeny: false,
      principalSummary: user,
    });
    const t = text();
    expect(t).toContain('Allowed');
    // the built-in policy is the person's role, not the engine's id or sentence
    expect(t).toContain('Role: User');
    expect(t).toContain('Their workspace access (role, own permissions and groups) allows Write on Agents.');
    expect(t).not.toContain('Members can change what their access allows');
    expect(t).toContain('Built-in');
    expect(hrefs()).toContain('/dashboard/members/u-ann');
    // the custom one by its own name, linked to the editor
    const link = qa<HTMLAnchorElement>('a').find((a) => a.textContent === 'Analysts read cost');
    expect(link?.getAttribute('href')).toBe('/dashboard/iam?tab=policies&policyId=p-analysts');
    expect(t).toContain('Custom');
    // and nothing about a mode or about older rules
    expect(t).not.toMatch(/Engine mode|Shadow|Monitor|Current role rules/i);
  });

  it('says a project limit with the project, the service and the level, and links to the member\'s project permissions', async () => {
    await run(
      {
        allowed: false,
        reasons: [{ cedarId: 'managed:boundary:project-write', policyId: null, managed: true, name: 'Project limit (change)', effect: 'forbid' }],
        defaultDeny: false,
        principalSummary: user,
        projectId: 'proj-a',
      },
      [
        [
          'GET',
          /^\/api\/iam\/principals\/user\/u-ann$/,
          () => ({
            principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' },
            effective: [{ service: 'agents', level: 'read', sources: [{ kind: 'role', label: 'user', level: 'write' }, { kind: 'project', label: 'Alpha', level: 'read' }] }],
            groups: [],
            projects: [],
            policies: [],
          }),
        ],
      ],
    );
    const t = text();
    expect(t).toContain('Denied');
    // the exact limit is asked of the principal view for that project
    expect(api.to('GET', '/api/iam/principals/user/u-ann').some((c) => c.query.projectId === 'proj-a')).toBe(true);
    expect(t).toContain('Project limit: Alpha · Agents = Read');
    expect(t).toContain('Alpha limits this member to Read on Agents, below the Write this needs.');
    expect(t).toContain('never widens it');
    expect(t).not.toContain('managed:boundary');
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/projects/proj-a?member=u-ann' && a.textContent === 'Change project member permissions')).toBe(true);
  });

  it('still reads in full when the exact project limit cannot be fetched', async () => {
    await run(
      {
        allowed: false,
        reasons: [{ cedarId: 'managed:boundary:project-write', policyId: null, managed: true, name: 'Project limit (change)', effect: 'forbid' }],
        defaultDeny: false,
        principalSummary: user,
        projectId: 'proj-a',
      },
      [['GET', /^\/api\/iam\/principals\/user\/u-ann$/, () => jsonResponse({ error: 'Forbidden' }, 403) as never]],
    );
    const t = text();
    expect(t).toContain('Project limit: Alpha · Agents');
    expect(t).not.toContain('Agents =');
    expect(t).toContain('Alpha limits this member on Agents to less than the Write this needs.');
  });

  it('says a token scope as the scope it is, for a token', async () => {
    await run(
      {
        allowed: false,
        reasons: [{ cedarId: 'managed:boundary:token-cap-write', policyId: null, managed: true, name: 'Token scope limit (change)', effect: 'forbid' }],
        defaultDeny: false,
        principalSummary: { type: 'token', id: 't-ci', label: 'ci-pipeline', role: 'admin', groups: [], tokenScope: { agents: 'read' } },
      },
      [],
      'tab=check&principalType=token&principalId=t-ci&action=agents.write',
    );
    const t = text();
    expect(t).toContain('Token scope: Agents = Read');
    expect(t).toContain('The token is scoped to Read on Agents, below the Write this needs.');
    expect(hrefs()).toContain('/dashboard/tokens');
    // a service the scope does not name at all reads as no access
  });

  it('names the owner of a token that is allowed because of what its owner can do', async () => {
    await run(
      {
        allowed: true,
        reasons: [{ cedarId: 'managed:rbac:token-write', policyId: null, managed: true, name: 'API tokens change what their owner and their scope allow', effect: 'permit' }],
        defaultDeny: false,
        principalSummary: { type: 'token', id: 't-ci', label: 'ci-pipeline', role: 'admin', groups: [], tokenScope: null },
      },
      [],
      'tab=check&principalType=token&principalId=t-ci&action=agents.write',
    );
    expect(text()).toContain('Token owner: Admin');
    expect(text()).toContain('A token can do what its owner can, within its scope: Write on Agents.');
  });

  it('says for a token that its owner lacks the level when nothing allows the request', async () => {
    await run(
      { ...DENIED, principalSummary: { type: 'token', id: 't-ci', label: 'ci-pipeline', role: 'user', groups: [], tokenScope: null } },
      [],
      'tab=check&principalType=token&principalId=t-ci&action=agents.write',
    );
    expect(text()).toContain('No rule allows this. The token owner does not have Write on Agents.');
  });

  it('keeps a built-in policy it has no words for under the engine\'s own name', async () => {
    await run({
      allowed: true,
      reasons: [{ cedarId: 'managed:rbac:something-new', policyId: null, managed: true, name: 'A future built-in rule', effect: 'permit' }],
      defaultDeny: false,
      principalSummary: user,
    });
    expect(text()).toContain('A future built-in rule');
  });

  it('shows the owner rule, engine problems, a disabled account and a token scope', async () => {
    await run({
      allowed: true,
      reasons: [],
      defaultDeny: false,
      principalSummary: {
        type: 'token',
        id: 't-ci',
        label: 'ci-pipeline',
        role: 'admin',
        groups: [{ id: 'g-sales', name: 'Sales' }],
        tokenScope: { agents: 'read', tools: 'write' },
        status: 'disabled',
      },
      ownerSafety: true,
      errors: ['policy custom:p-x failed to evaluate'],
    });
    const t = text();
    expect(t).toContain('The workspace owner can always reach the Authorization Engine');
    expect(t).toContain('The engine had problems evaluating some policies');
    expect(t).toContain('policy custom:p-x failed to evaluate');
    expect(t).toContain('Account disabled');
    expect(t).toContain('Sales');
    // (the principal type of the request is the one in the URL: user; token scope shows for token requests)
  });

  it('describes an unscoped token and an empty token scope', async () => {
    nav.search = 'tab=check&principalType=token&principalId=t-ci&action=agents.read';
    api = installApiMock([...defaultRoutes(), ...simulateRoutes({ ...DENIED, principalSummary: { ...DENIED.principalSummary, type: 'token', tokenScope: null } })]);
    mounted = await mount(createElement(AccessCheckTab, { canManage: false }));
    await settle(300);
    expect(text()).toContain('unscoped: inherits its owner');
    // read-only users get no shortcut to create a policy
    expect(buttonByText('Create policy for this principal')).toBeUndefined();
  });

  it('links to the principal and, for admins, to a prefilled new policy', async () => {
    await run(DENIED);
    expect(hrefs()).toContain('/dashboard/iam?tab=principals&principalType=user&principalId=u-ann');
    expect(hrefs()).toContain('/dashboard/iam?tab=policies&new=1&principalType=user&principalId=u-ann');
  });

  it('warns that a check about one resource is not what a real request meets', async () => {
    await run({ ...DENIED, enforcedAtGate: false });
    expect(text()).toContain('The request gates decide whole services, not individual resources.');
  });
});

describe('AccessCheckTab when the engine could not decide', () => {
  it('renders a 503 as an unavailable engine (not as a failed check or a denial), with a way to look at the engine', async () => {
    nav.search = 'tab=check&principalType=user&principalId=u-ann&action=agents.write';
    api = installApiMock([...defaultRoutes(), ...simulateRoutes()]);
    api.on('POST', '/api/iam/simulate', () =>
      jsonResponse({ error: 'Authorization is temporarily unavailable', code: 'authorization_unavailable', decisionId: 'dec-503' }, 503),
    );
    mounted = await mount(createElement(AccessCheckTab, { canManage: true }));
    await settle(300);
    const alert = q('[data-testid="check-unavailable"]')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('The engine could not decide');
    expect(alert.textContent).toContain('Authorization is temporarily unavailable, so the request was not decided');
    expect(q('[data-testid="check-failed"]')).toBeNull();
    expect(text()).not.toContain('Denied');
    expect(qa<HTMLAnchorElement>('a').some((a) => a.getAttribute('href') === '/dashboard/iam?tab=overview')).toBe(true);
  });

  it('a decision id of a 503 says it was not a policy decision, and replays nothing', async () => {
    nav.search = 'tab=check&decisionId=dec-503';
    api = installApiMock([...defaultRoutes(), ...simulateRoutes()]);
    api.on('GET', /^\/api\/iam\/decisions\/[^/]+$/, () => ({
      decisionId: 'dec-503',
      at: '2026-10-10T08:00:00.000Z',
      principal: { type: 'user', id: 'u-ann', label: 'Ann Lee' },
      service: 'agents',
      required: 'write',
      route: '/api/agents',
      method: 'POST',
      code: 'authorization_unavailable',
      simulateInput: null,
      policyIds: [],
      reasons: [],
    }));
    mounted = await mount(createElement(AccessCheckTab, { canManage: true }));
    await settle(250);
    const notice = q('[data-testid="decision-unavailable"]')!;
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('Not a policy decision');
    expect(notice.textContent).toContain('No policy denied it, so there is nothing to replay');
    expect(api.to('POST', '/api/iam/simulate')).toHaveLength(0);
    // it is not reported as a decision that "cannot be replayed" either
    expect(text()).not.toContain('That decision cannot be replayed.');
    expect(text()).toContain('Response: authorization_unavailable');
  });
});
