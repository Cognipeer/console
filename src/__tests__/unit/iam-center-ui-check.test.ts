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
  legacy: { allowed: true, service: 'agents', required: 'write' },
  principalSummary: { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [{ id: 'g-sales', name: 'Sales' }] },
  mode: 'enforce',
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
    expect(t).toContain('No policy allows this request, so it is denied by default.');
    expect(t).toContain('Ann Lee → Agents · Write on Agents');
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
    expect(t).toContain('Hiçbir politika bu isteğe izin vermiyor');
    expect(t).toContain('Tüm Ajanlar servisi'); // the service name comes from the server's translated labels? no: built-in label
    expect(t).not.toMatch(/iamCenter\.[a-zA-Z]/);
  });
});

describe('SimulateResultCard', () => {
  const run = async (result: unknown) => {
    await render('tab=check&principalType=user&principalId=u-ann&action=agents.write', result);
    await settle(250);
  };

  it('lists the deciding policies: built-in (translated name) and custom (linked)', async () => {
    await run({
      allowed: true,
      reasons: [
        { cedarId: 'managed:rbac:user-write', policyId: null, managed: true, name: 'Members can change what their access allows', effect: 'permit' },
        { cedarId: 'custom:p-analysts', policyId: 'p-analysts', managed: false, name: 'Analysts read cost', effect: 'permit' },
      ],
      defaultDeny: false,
      principalSummary: { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [] },
      mode: 'enforce',
    });
    const t = text();
    expect(t).toContain('Allowed');
    expect(t).toContain('Members can change what their access allows');
    expect(t).toContain('Built-in');
    const link = qa<HTMLAnchorElement>('a').find((a) => a.textContent === 'Analysts read cost');
    expect(link?.getAttribute('href')).toBe('/dashboard/iam?tab=policies&policyId=p-analysts');
    expect(t).toContain('The policy engine decides real requests');
  });

  it('shows the monitor difference, the legacy comparison and the engine mode', async () => {
    await run({
      allowed: true,
      reasons: [{ cedarId: 'managed:rbac:user-write', policyId: null, managed: true, name: 'Members can change', effect: 'permit' }],
      defaultDeny: false,
      monitor: {
        allowed: false,
        differs: true,
        reasons: [{ cedarId: 'custom:p-new', policyId: 'p-new', managed: false, name: 'Block writes (monitor)', effect: 'forbid' }],
      },
      legacy: { allowed: false, service: 'agents', required: 'write' },
      principalSummary: { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [] },
      mode: 'shadow',
    });
    const t = text();
    expect(t).toContain('Engine mode: Shadow');
    expect(t).toContain('Real requests are still decided by the current role rules');
    expect(t).toContain('With monitor-mode policies the result would be');
    expect(t).toContain('Block writes (monitor)');
    expect(t).toContain('Current role rules (legacy)');
    expect(t).toContain('needs Write on Agents');
    expect(t).toContain('The policy engine and the current role rules disagree');
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
      mode: 'enforce',
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
    const hrefs = qa<HTMLAnchorElement>('a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/iam?tab=principals&principalType=user&principalId=u-ann');
    expect(hrefs).toContain('/dashboard/iam?tab=policies&new=1&principalType=user&principalId=u-ann');
  });
});
