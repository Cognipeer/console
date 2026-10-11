// @vitest-environment jsdom
/**
 * The agent-session side of the IAM center, rendered for real (jsdom) against contract-shaped
 * responses: the built-in approval rules in the policy list, the actions the agent routes ask in
 * the editor, and the Access check of answering a pending request - the session's owner and the
 * agent's setting as inputs, and the deciding rule in plain words.
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

const verbAction = (verb: string, level: 'read' | 'write') => ({
  id: `agent.${verb}`, kind: 'resource', level, service: 'agents', resourceType: 'agent', verb,
  labelKey: `iamApi.action.verb.${verb}`, labelParams: { type: 'agent' }, enforcedIn: ['dashboard', 'api'],
});

const SESSION_CATALOG = {
  ...CATALOG,
  actions: [
    ...CATALOG.actions,
    verbAction('approve', 'write'),
    verbAction('session_view_others', 'read'),
    verbAction('session_manage_others', 'write'),
  ],
};

const APPROVAL_RULES = [
  {
    id: 'managed:agent:approve', name: 'People who may approve an agent\'s tool calls', description: 'The owner, or whoever the agent accepts.',
    nameKey: 'iamApi.managed.agent-approve.name', descriptionKey: 'iamApi.managed.agent-approve.description',
    group: 'agent', effect: 'permit', cedar: '@managed("agent") permit(principal is User, action == Action::"agent.approve", resource is Agent);',
  },
  {
    id: 'managed:agent:approve-token', name: 'API tokens approve on behalf of their owner', description: 'As their owner.',
    nameKey: 'iamApi.managed.agent-approve-token.name', descriptionKey: 'iamApi.managed.agent-approve-token.description',
    group: 'agent', effect: 'permit', cedar: '@managed("agent") permit(principal is ApiToken, action == Action::"agent.approve", resource is Agent);',
  },
];

const ANN = { type: 'user', id: 'u-ann', label: 'Ann Lee', role: 'user', groups: [], tokenScope: null, status: null };
const REFUSED = {
  allowed: false,
  reasons: [],
  defaultDeny: true,
  principalSummary: ANN,
  projectId: 'p1',
  ownerSafety: false,
  enforcedAtGate: true,
  errors: [],
  portal: null,
  session: { ownerId: 'u-sam', approvers: 'owner' },
};

const routes = (extra: Array<[string, string | RegExp, () => unknown]> = []) => [
  ...defaultRoutes(),
  ['GET', '/api/iam/catalog', () => SESSION_CATALOG],
  ['GET', '/api/resources', (c: { query: Record<string, string> }) => ({
    items: [{ type: c.query.type, id: 'a-support', key: 'support', name: 'Support bot', projectName: 'Alpha' }], total: 1,
  })],
  ['POST', '/api/iam/simulate', () => REFUSED],
  ...extra,
] as never;

async function renderCheck(search = '', r = routes(), locale = 'en') {
  nav.search = search;
  api = installApiMock(r);
  await loadCatalog(true);
  mounted = await mount(createElement(AccessCheckTab, { canManage: true }), locale);
  await settle(250);
}

async function renderPolicies(r = routes([['GET', '/api/iam/policies', () => ({ managed: [...MANAGED, ...APPROVAL_RULES], custom: [] })]])) {
  nav.search = '';
  api = installApiMock(r);
  await loadCatalog(true);
  mounted = await mount(createElement(PoliciesTab, { canManage: true }));
  await settle(250);
}

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

describe('the built-in policies', () => {
  it('lists the approval rules in a group of their own, with what they are for', async () => {
    await renderPolicies();
    const t = text();
    expect(t).toContain('Agent approvals');
    expect(t).toContain('Who may approve a tool call of an agent session is decided by the session\'s owner');
    expect(t).toContain('People who may approve an agent\'s tool calls');
    expect(t).toContain('API tokens approve on behalf of their owner');
    expect(q('[data-testid="managed-agent-group"]')).not.toBeNull();
  });

  it('shows no such group when the server reports no approval rules', async () => {
    await renderPolicies(routes());
    expect(q('[data-testid="managed-agent-group"]')).toBeNull();
  });
});

describe('the policy editor', () => {
  it('marks the actions the agent routes ask, so a deny about them is known to apply', async () => {
    await renderPolicies();
    await click(buttonByText('Create policy'));
    await settle(80);
    const overlay = q('.form-overlay')!;
    await click(qa('button', overlay).find((b) => b.textContent?.startsWith('Specific actions')));
    await settle(30);
    const rows = qa('[data-testid="enforced-in-agents"]', overlay).map((b) => b.closest('label')?.textContent ?? '');
    expect(rows).toHaveLength(3);
    for (const id of ['agent.approve', 'agent.session_view_others', 'agent.session_manage_others']) {
      expect(rows.some((r) => r.includes(id)), id).toBe(true);
    }
    expect(qa('[data-testid="enforced-in-agents"]', overlay)[0].textContent).toBe('Checked on agent requests');
    // an action nothing asks is not marked
    expect(qa('[data-testid="enforced-in-agents"]', overlay).some((b) => b.closest('label')?.textContent?.includes('tool.execute'))).toBe(false);
  });
});

describe('the Access check of answering a pending request', () => {
  it('takes the session\'s owner and the agent\'s setting, sends them, and explains the refusal in plain words', async () => {
    await renderCheck();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'approve', 'Agents · Approve tool calls');
    await pick(q<HTMLInputElement>('input[placeholder="Search by name, key or ID"]')!, 'sup', 'Support bot');

    const inputs = q('[data-testid="session-inputs"]')!;
    expect(inputs.textContent).toContain('Session started by');
    expect(inputs.textContent).toContain('The agent accepts as approvers');
    await pick(qa<HTMLInputElement>('input', inputs).find((i) => i.placeholder === 'Search people')!, 'bob', 'Bob Ray');
    await pick(qa<HTMLInputElement>('input', inputs).find((i) => i.placeholder === 'Default: the session owner and admins')!, '', 'only the person who started the session');

    await click(buttonByText('Check access'));
    await settle(100);
    const calls = api.to('POST', '/api/iam/simulate');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      principal: { type: 'user', id: 'u-ann' },
      action: 'agent.approve',
      resource: { kind: 'resource', type: 'agent', id: 'a-support' },
      context: { channel: 'dashboard', approvers: 'owner' },
    });
    expect((calls[0].body as { context: Record<string, string> }).context.ownerId).toBe('u-bob');

    const t = text();
    expect(t).toContain('Denied');
    expect(t).toContain('Nothing appoints this person as an approver: only the person who started the session, whoever the agent accepts (only the person who started the session) and the people your own allow rules name may approve its tool calls.');
  });

  it('asks for the owner only when the action is about a session, and for the setting only when it is an approval', async () => {
    await renderCheck();
    await pick(q<HTMLInputElement>('input[placeholder="Search users"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'invoke', 'Agents · Invoke');
    expect(q('[data-testid="session-inputs"]')).toBeNull();
    await pick(q<HTMLInputElement>('input[placeholder="Search actions"]')!, 'others', 'View others');
    const inputs = q('[data-testid="session-inputs"]')!;
    expect(inputs.textContent).toContain('Session started by');
    expect(inputs.textContent).not.toContain('The agent accepts as approvers');
  });

  it('reads in Turkish with no raw translation keys', async () => {
    await renderCheck('', routes(), 'tr');
    await pick(q<HTMLInputElement>('input[placeholder="Kullanıcı ara"]')!, 'ann', 'Ann Lee');
    await pick(q<HTMLInputElement>('input[placeholder="İşlem ara"]')!, 'approve', /Araç çağrılarını onayla/);
    const inputs = q('[data-testid="session-inputs"]')!;
    expect(inputs.textContent).toContain('Oturumu başlatan');
    expect(text()).not.toMatch(/iamCenter\.|iamApi\./);
  });
});
