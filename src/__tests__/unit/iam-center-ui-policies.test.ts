// @vitest-environment jsdom
/**
 * Policies tab + policy editor, rendered for real (jsdom) against contract-shaped
 * API responses. Verifies what an admin sees and the exact requests the UI sends.
 */

import { act, createElement } from 'react';
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
  wait,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { defaultRoutes, POLICY_ENFORCED } from '../helpers/iamCenterFixtures';

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

import PoliciesTab from '@/components/iam/policies/PoliciesTab';

let api: ApiMock;
let mounted: Mounted;

beforeAll(() => installDomStubs());

async function render(canManage = true, search = '') {
  nav.search = search;
  api = installApiMock(defaultRoutes());
  mounted = await mount(createElement(PoliciesTab, { canManage }));
  await settle(150);
}

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('PoliciesTab (list)', () => {
  it('lists the custom policies with effect, mode, scope and monitor results', async () => {
    await render();
    const t = text();
    expect(t).toContain('Contractors cannot write');
    expect(t).toContain('Analysts read cost');
    expect(t).toContain('Hand written');
    // names of the groups the specs refer to (resolved through the principals API)
    expect(t).toContain('Groups: Contractors');
    expect(t).toContain('Groups: Analysts');
    // monitor results of the monitor-mode policy
    expect(t).toContain('would block 3');
    expect(t).toContain('would allow 12');
    // a raw Cedar policy is labelled as such
    expect(t).toContain('Cedar policy · 2 statement(s)');
  });

  it('explains the built-in policies in plain language, boundaries included', async () => {
    await render();
    const t = text();
    expect(t).toContain('Built-in policies');
    // the server's own plain-language names (its translation keys resolve to the same text in English)
    expect(t).toContain('Members can view what their access allows');
    expect(t).toContain('API tokens change what their owner and their scope allow');
    expect(t).toContain('Boundaries');
    expect(t).toContain('Token scope limit (change)');
    expect(t).toContain('Project limit (view)');
    // role-based and boundary policies are listed separately
    expect(t.indexOf('Role-based access')).toBeLessThan(t.indexOf('Boundaries'));
    expect(t.indexOf('Members can view')).toBeLessThan(t.indexOf('Boundaries'));
    expect(t.indexOf('Token scope limit (change)')).toBeGreaterThan(t.indexOf('Boundaries'));
  });

  it('warns that policies do not decide yet while the engine is not enforcing', async () => {
    await render();
    expect(text()).toContain('authorization engine is in Shadow mode');
  });

  it('shows no banner once the engine enforces', async () => {
    nav.search = '';
    api = installApiMock(defaultRoutes());
    api.on('GET', '/api/iam/mode', () => ({ mode: 'enforce', effectiveMode: 'enforce' }));
    mounted = await mount(createElement(PoliciesTab, { canManage: true }));
    await settle(150);
    expect(text()).not.toContain('authorization engine is in');
  });

  it('is read-only without admin access: no create, no switches, rows open a drawer', async () => {
    await render(false);
    expect(buttonByText('Create policy')).toBeUndefined();
    expect(text()).toContain('changing them needs admin access');
    expect(qa<HTMLInputElement>('input[type="checkbox"]').every((c) => c.disabled)).toBe(true);
    await click(qa('p, div').find((e) => e.textContent === 'Contractors cannot write' && e.children.length === 0));
    expect(text()).toContain('Contractors may look but not touch');
    expect(q('.form-overlay')).toBeNull();
  });

  it('filters by name and by mode', async () => {
    await render();
    const search = q<HTMLInputElement>('input[placeholder="Search policies"]')!;
    await setInput(search, 'analysts');
    expect(text()).toContain('Analysts read cost');
    expect(text()).not.toContain('Contractors cannot write');
    await setInput(search, '');
    const enforceFilter = qa<HTMLLabelElement>('label').find((l) => l.textContent === 'Enforce');
    await click(enforceFilter);
    expect(text()).toContain('Contractors cannot write');
    expect(text()).not.toContain('Analysts read cost');
  });
});

describe('PoliciesTab (changes)', () => {
  it('turning a monitor policy off sends only the switch (the server keeps the Cedar and spec)', async () => {
    await render();
    const row = qa('tr').find((r) => r.textContent?.includes('Analysts read cost'))!;
    await click(row.querySelector('input[type="checkbox"]'));
    await settle(50);
    const puts = api.to('PUT', '/api/iam/policies/p-analysts');
    expect(puts).toHaveLength(1);
    // Not the whole policy: re-sending the spec would make the server re-check every person and group it names,
    // and a leaver or a deleted group must never stop an admin from switching a policy off.
    expect(puts[0].body).toEqual({ enabled: false });
  });

  it('asks before switching an enforcing policy off, and does nothing if declined', async () => {
    await render();
    const row = qa('tr').find((r) => r.textContent?.includes('Contractors cannot write'))!;
    await click(row.querySelector('input[type="checkbox"]'));
    await wait(0);
    expect(text()).toContain('Disable "Contractors cannot write"?');
    await click(buttonByText('Cancel', q('[role="dialog"]')!));
    await settle(50);
    expect(api.to('PUT', /policies/)).toHaveLength(0);
    // the switch snapped back
    expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it('rolls the switch back and reports when the server refuses', async () => {
    await render();
    api.on('PUT', /^\/api\/iam\/policies\/[^/]+$/, () => jsonResponse({ error: 'nope', code: 'validation' }, 400));
    const row = qa('tr').find((r) => r.textContent?.includes('Analysts read cost'))!;
    await click(row.querySelector('input[type="checkbox"]'));
    await settle(50);
    expect(row.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });

  it('deletes through the shared confirm dialog', async () => {
    await render();
    const row = qa('tr').find((r) => r.textContent?.includes('Analysts read cost'))!;
    await click(row.querySelector('button[aria-label="Actions"]'));
    await click(buttonByText('Delete', document.body) ?? qa('[role="menuitem"]').find((m) => m.textContent === 'Delete'));
    await wait(0);
    expect(text()).toContain('Analysts read cost');
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Delete');
    await click(qa<HTMLButtonElement>('button', dialog).find((b) => b.textContent === 'Delete'));
    await settle(50);
    expect(api.to('DELETE', '/api/iam/policies/p-analysts')).toHaveLength(1);
    expect(text()).not.toContain('Analysts read cost');
  });
});

describe('PolicyEditor', () => {
  it('creates a policy for everyone from the guided form, in Monitor mode', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    expect(q('.form-overlay')).not.toBeNull();
    expect(text()).toContain('Create access policy');

    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Everyone reads');
    // Who: everyone
    await click(qa('.form-overlay .form-source-card').find((c) => c.textContent?.startsWith('Everyone')));
    // What: every service, Read
    const allRow = qa('.form-overlay').flatMap((o) => qa('div', o)).find((d) => d.textContent?.startsWith('Every serviceShortcut'));
    expect(allRow).toBeTruthy();
    await click(qa<HTMLButtonElement>('button', allRow!.parentElement!).find((b) => b.textContent === 'Read'));
    await settle(700);

    // The live Cedar preview asked the compile endpoint for exactly this spec
    const compiles = api.to('POST', '/api/iam/policies/compile');
    expect(compiles.length).toBeGreaterThan(0);
    expect(compiles[compiles.length - 1].body).toEqual({
      spec: { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } },
    });
    expect(q('.form-overlay')!.textContent).toContain('Valid');

    await click(buttonByText('Create policy', q('.form-footer')!));
    await settle(100);
    const posts = api.to('POST', '/api/iam/policies');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      name: 'Everyone reads',
      mode: 'monitor',
      enabled: true,
      spec: { effect: 'permit', principals: { any: true }, actions: ['Read'], resources: { any: true } },
    });
    // the editor closed and the list refreshed
    expect(q('.form-overlay')).toBeNull();
  });

  it('shows what is missing instead of sending an incomplete policy', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    await click(buttonByText('Create policy', q('.form-footer')!));
    await settle(50);
    expect(api.to('POST', '/api/iam/policies')).toHaveLength(0);
    const t = q('.form-overlay')!.textContent ?? '';
    expect(t).toContain('Give the policy a name.');
    expect(t).toContain('Choose who this applies to.');
    expect(t).toContain('Choose at least one action.');
  });

  it('opens an existing policy with its values, names resolved, and saves a change as a PUT', async () => {
    await render();
    await click(qa('p, div').find((e) => e.textContent === 'Contractors cannot write' && e.children.length === 0));
    await settle(200);
    const overlay = q('.form-overlay')!;
    expect(overlay.textContent).toContain('Edit access policy');
    expect(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!.value).toBe('Contractors cannot write');
    // the group id was resolved to its name
    expect(overlay.textContent).toContain('Contractors');
    // an enforcing policy asks for confirmation when it is changed
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Contractors cannot write (v2)');
    await click(buttonByText('Save changes', q('.form-footer')!));
    await wait(0);
    expect(text()).toContain('Save as an enforcing policy?');
    await click(buttonByText('Save and enforce', q('[role="dialog"]')!));
    await settle(100);
    const puts = api.to('PUT', '/api/iam/policies/p-contractors');
    expect(puts).toHaveLength(1);
    expect(puts[0].body).toMatchObject({
      name: 'Contractors cannot write (v2)',
      description: 'Contractors may look but not touch',
      mode: 'enforce',
      enabled: true,
      spec: POLICY_ENFORCED.spec,
    });
  });

  it('shows the server validation errors with line and column', async () => {
    await render();
    api.on('POST', '/api/iam/policies', () =>
      jsonResponse(
        { error: 'Policy is not valid', code: 'validation', details: [{ message: 'unknown group', line: 2, col: 9 }] },
        400,
      ),
    );
    await click(buttonByText('Create policy'));
    await settle(50);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'X');
    await click(qa('.form-overlay .form-source-card').find((c) => c.textContent?.startsWith('Everyone')));
    const allRow = qa('.form-overlay').flatMap((o) => qa('div', o)).find((d) => d.textContent?.startsWith('Every serviceShortcut'));
    await click(qa<HTMLButtonElement>('button', allRow!.parentElement!).find((b) => b.textContent === 'Write'));
    await settle(600);
    await click(buttonByText('Create policy', q('.form-footer')!));
    await settle(100);
    const overlay = q('.form-overlay')!;
    expect(overlay.textContent).toContain('The policy could not be saved');
    expect(overlay.textContent).toContain('line 2, col 9');
    expect(overlay.textContent).toContain('unknown group');
  });

  it('switches to Cedar mode after a confirmation, and validates the text live', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    await click(buttonByText('Edit as Cedar', q('.form-summary')!));
    await wait(0);
    expect(text()).toContain('Edit as Cedar?');
    await click(buttonByText('Edit as Cedar', q('[role="dialog"]')!));
    await settle(50);
    const textarea = q<HTMLTextAreaElement>('.form-overlay textarea[aria-label="Cedar policy"]')!;
    expect(textarea).not.toBeNull();
    // the starter is comments only: not a policy yet
    await settle(600);
    expect(q('.form-overlay')!.textContent).toContain('Invalid');
    await setInput(textarea, 'forbid (principal, action, resource);');
    await settle(700);
    expect(q('.form-overlay')!.textContent).toContain('Valid');
    const last = api.to('POST', '/api/iam/policies/compile').pop()!;
    expect(last.body).toEqual({ cedar: 'forbid (principal, action, resource);' });
  });

  it('previews the impact and reports the flips', async () => {
    await render();
    await click(qa('p, div').find((e) => e.textContent === 'Contractors cannot write' && e.children.length === 0));
    await settle(900); // the button is enabled once the live Cedar check (450 ms debounce) has answered
    await click(buttonByText('Preview impact', q('.form-overlay')!));
    await settle(100);
    const calls = api.to('POST', '/api/iam/policies/preview');
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ policyId: 'p-contractors', mode: 'enforce', spec: POLICY_ENFORCED.spec });
    const overlay = q('.form-overlay')!.textContent ?? '';
    expect(overlay).toContain('Newly denied');
    expect(overlay).toContain('840 access checks compared');
    expect(overlay).toContain('Ann Lee');
  });

  it('asks before throwing unsaved changes away', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    // untouched: closes right away
    await click(buttonByText('Cancel', q('.form-footer')!));
    await settle(30);
    expect(q('.form-overlay')).toBeNull();
    await click(buttonByText('Create policy'));
    await settle(50);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Draft');
    await click(buttonByText('Cancel', q('.form-footer')!));
    await wait(0);
    expect(text()).toContain('Discard your changes?');
    await click(buttonByText('Keep editing', q('[role="dialog"]')!));
    await settle(30);
    expect(q('.form-overlay')).not.toBeNull();
  });
});


/** Types into a Mantine searchable (Multi)Select and clicks the first option containing `optionText`. */
async function pickOption(input: HTMLInputElement, search: string, optionText: string) {
  await click(input);
  if (search) {
    await setInput(input, search);
    await settle(450);
  } else {
    await wait(30);
  }
  const option = qa('[role="option"]').find((o) => o.textContent?.includes(optionText));
  expect(option, `option "${optionText}"`).toBeTruthy();
  await click(option);
}

const overlay = () => q('.form-overlay')!;
const lastCompile = (api: ApiMock) => api.to('POST', '/api/iam/policies/compile').pop()!.body as { spec: Record<string, unknown> };

/** The text input behind a field label (radio / checkbox labels of the same text are skipped). */
function fieldInput(label: string): HTMLInputElement {
  const input = qa<HTMLLabelElement>('.form-overlay label')
    .filter((l) => l.textContent?.replace(/\s*\*$/, '') === label)
    .map((l) => document.getElementById(l.htmlFor))
    .find((el): el is HTMLInputElement => !!el && el instanceof HTMLInputElement && !['radio', 'checkbox'].includes(el.type));
  expect(input, `input of field "${label}"`).toBeTruthy();
  return input!;
}

/** The chip buttons of one service row of the action matrix. */
function matrixChips(serviceLabel: string): HTMLButtonElement[] {
  const name = qa('.form-overlay div').find((d) => d.children.length === 0 && d.textContent === serviceLabel);
  expect(name, `matrix row "${serviceLabel}"`).toBeTruthy();
  return qa<HTMLButtonElement>('button', name!.parentElement!);
}

describe('PolicyEditor (every section)', () => {
  it('builds a rich spec: effect, people from the async pickers, actions, services and conditions', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Block writes');

    // Effect: deny
    await click(qa('.form-overlay .form-source-card').find((c) => c.textContent?.startsWith('Deny')));
    // Who: the group found through the server-side search, plus every API token
    await pickOption(q<HTMLInputElement>('.form-overlay input[placeholder="Search groups"]')!, 'sal', 'Sales');
    const tokenSwitch = qa<HTMLLabelElement>('.form-overlay label').find((l) => l.textContent?.startsWith('Any API token'));
    expect(tokenSwitch, 'switch "Any API token"').toBeTruthy();
    await click(document.getElementById(tokenSwitch!.htmlFor));
    // What: every write action + administering Agents
    const every = qa('.form-overlay div').find((d) => d.textContent?.startsWith('Every serviceShortcut'))!;
    await click(qa<HTMLButtonElement>('button', every.parentElement!).find((b) => b.textContent === 'Write'));
    await click(matrixChips('Agents').find((b) => b.textContent === 'Admin'));
    // Where: two services
    await click(qa('.form-overlay label').find((l) => l.textContent === 'Services'));
    await pickOption(fieldInput('Services'), '', 'Agents');
    await pickOption(fieldInput('Services'), 'tools', 'Agent Tools');
    // Conditions: a network and a channel
    await click(qa('.form-section-header').find((h) => h.textContent?.includes('Conditions')));
    const ip = q<HTMLInputElement>('.form-overlay input[placeholder="10.0.0.0/8"]')!;
    await setInput(ip, '10.0.0.0/8');
    await act(async () => {
      ip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await click(qa('.form-overlay .form-chip').find((c) => c.textContent === 'API'));
    await settle(700);

    expect(lastCompile(api).spec).toEqual({
      effect: 'forbid',
      principals: { anyToken: true, groups: ['g-sales'] },
      actions: ['Write', 'agents.admin'],
      resources: { services: ['agents', 'tools'] },
      conditions: { ipRanges: ['10.0.0.0/8'], channels: ['api'] },
    });
    // the plain-language summary in the side pane
    const pane = overlay().textContent ?? '';
    expect(pane).toContain('Groups: Sales');
    expect(pane).toContain('Any API token');
    expect(pane).toContain('Services: Agents, Agent Tools');

    await click(buttonByText('Create policy', q('.form-footer')!));
    await settle(100);
    expect(api.to('POST', '/api/iam/policies')[0].body).toMatchObject({
      name: 'Block writes',
      mode: 'monitor',
      enabled: true,
      spec: lastCompile(api).spec,
    });
  });

  it('rejects a malformed IP range as it is typed', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    await click(qa('.form-section-header').find((h) => h.textContent?.includes('Conditions')));
    const ip = q<HTMLInputElement>('.form-overlay input[placeholder="10.0.0.0/8"]')!;
    await setInput(ip, '10.0.0.0/99');
    await act(async () => {
      ip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(overlay().textContent).toContain('Not a valid IP range: 10.0.0.0/99');
    // a bare address becomes a single-host range
    await setInput(ip, '192.168.1.5');
    await act(async () => {
      ip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(overlay().textContent).toContain('192.168.1.5/32');
  });

  it('limits a policy to specific resources picked from the registry', async () => {
    await render();
    api.on('GET', '/api/resources', (c) => ({
      items: [{ type: c.query.type, id: 'a-support', key: 'support', name: 'Support bot', projectName: 'Alpha' }],
      total: 1,
    }));
    await click(buttonByText('Create policy'));
    await settle(50);
    await click(qa('.form-source-card').find((c) => c.textContent?.startsWith('Everyone')));
    await click(matrixChips('Agents').find((b) => b.textContent === 'Write'));
    await click(qa('.form-overlay label').find((l) => l.textContent === 'Specific resources'));
    await pickOption(q<HTMLInputElement>('.form-overlay input[placeholder="Choose a type"]')!, '', 'Agents');
    await pickOption(q<HTMLInputElement>('.form-overlay input[placeholder="Search by name, key or ID"]')!, 'sup', 'Support bot');
    await click(buttonByText('Add', q('.form-overlay')!));
    expect(overlay().textContent).toContain('Agents: Support bot');
    await settle(700);
    expect(lastCompile(api).spec).toMatchObject({
      actions: ['agents.write'],
      resources: { resources: [{ type: 'agent', id: 'a-support' }] },
    });
  });

  it('lists the projects of the caller for a project-limited policy', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(50);
    await click(qa('.form-source-card').find((c) => c.textContent?.startsWith('Everyone')));
    await click(matrixChips('Agents').find((b) => b.textContent === 'Read'));
    await click(qa('.form-overlay label').find((l) => l.textContent === 'Projects'));
    await pickOption(q<HTMLInputElement>('.form-overlay input[placeholder="Choose projects"]')!, '', 'Beta');
    await settle(700);
    expect(lastCompile(api).spec).toMatchObject({ resources: { projects: ['proj-b'] } });
  });

  it('duplicates a policy as a new monitor-mode copy', async () => {
    await render();
    const row = qa('tr').find((r) => r.textContent?.includes('Contractors cannot write'))!;
    await click(row.querySelector('button[aria-label="Actions"]'));
    await click(qa('[role="menuitem"]').find((m) => m.textContent === 'Duplicate'));
    await settle(300);
    expect(overlay().textContent).toContain('Duplicate access policy');
    expect(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!.value).toBe('Contractors cannot write (copy)');
    await settle(700);
    await click(buttonByText('Create policy', q('.form-footer')!));
    await settle(100);
    const posts = api.to('POST', '/api/iam/policies');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      name: 'Contractors cannot write (copy)',
      mode: 'monitor',
      enabled: true,
      spec: POLICY_ENFORCED.spec,
    });
  });

  it('moves a monitored policy to enforce after showing what it measured', async () => {
    await render();
    const row = qa('tr').find((r) => r.textContent?.includes('Analysts read cost'))!;
    await click(row.querySelector('button[aria-label="Actions"]'));
    await click(qa('[role="menuitem"]').find((m) => m.textContent === 'Switch to Enforce'));
    await wait(0);
    const dialog = q('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Enforce "Analysts read cost"?');
    expect(dialog.textContent).toContain('would have blocked 3 and newly allowed 12');
    await click(buttonByText('Switch to Enforce', dialog));
    await settle(60);
    expect(api.to('PUT', '/api/iam/policies/p-analysts')[0].body).toEqual({ mode: 'enforce' });
  });

  it('opens an existing policy written as Cedar straight in Cedar mode', async () => {
    await render();
    await click(qa('p, div').find((e) => e.textContent === 'Hand written' && e.children.length === 0));
    await settle(200);
    const textarea = q<HTMLTextAreaElement>('.form-overlay textarea[aria-label="Cedar policy"]')!;
    expect(textarea.value).toContain('permit (principal, action, resource);');
    expect(buttonByText('Edit as Cedar', q('.form-overlay')!)).toBeUndefined();
    await settle(600);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Hand written v2');
    await click(buttonByText('Save changes', q('.form-footer')!));
    await settle(100);
    const put = api.to('PUT', '/api/iam/policies/p-raw')[0];
    expect(put.body).toMatchObject({ name: 'Hand written v2', cedar: textarea.value });
    expect(put.body).not.toHaveProperty('spec');
  });
});

describe('PolicyEditor (Escape)', () => {
  const escape = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle(60);
  };

  it('closes an untouched editor, even though closed lists stay in the DOM', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(60);
    expect(q('.form-overlay')).not.toBeNull();
    await escape(document.body);
    expect(q('.form-overlay')).toBeNull();
  });

  it('only closes an open list, not the editor behind it', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(60);
    const groups = q<HTMLInputElement>('.form-overlay input[placeholder="Search groups"]')!;
    await click(groups);
    await setInput(groups, 'sal');
    await settle(450);
    expect(qa('[role="option"]').length).toBeGreaterThan(0);
    await escape(groups);
    expect(q('.form-overlay')).not.toBeNull();
  });

  it('asks before leaving with unsaved changes, and Escape on that question does not ask again', async () => {
    await render();
    await click(buttonByText('Create policy'));
    await settle(60);
    await setInput(q<HTMLInputElement>('.form-overlay input[placeholder^="For example"]')!, 'Draft');
    await escape(document.body);
    await wait(0);
    expect(qa('[role="dialog"]').filter((d) => d.textContent?.includes('Discard your changes?'))).toHaveLength(1);
    // Escape on the question itself answers "keep editing" and must not open it again
    await act(async () => {
      q('[role="dialog"]', document.body)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle(60);
    expect(qa('[role="dialog"]').filter((d) => d.textContent?.includes('Discard your changes?'))).toHaveLength(0);
    expect(q('.form-overlay')).not.toBeNull();
  });
});

describe('PoliciesTab (Turkish)', () => {
  it('renders the list and the editor in Turkish with no raw translation keys', async () => {
    nav.search = '';
    api = installApiMock(defaultRoutes());
    mounted = await mount(createElement(PoliciesTab, { canManage: true }), 'tr');
    await settle(150);
    let t = text();
    expect(t).toContain('Erişim politikaları');
    expect(t).toContain('Özel politikalar');
    expect(t).toContain('Yerleşik politikalar');
    expect(t).not.toMatch(/iamCenter\.[a-zA-Z]/);

    await click(buttonByText('Politika oluştur'));
    await settle(80);
    t = q('.form-overlay')!.textContent ?? '';
    expect(t).toContain('Erişim politikası oluştur');
    expect(t).toContain('Temel bilgiler');
    expect(t).toContain('Etki önizlemesi');
    expect(t).not.toMatch(/iamCenter\.[a-zA-Z]/);
    expect(t).not.toMatch(/iamApi\.[a-zA-Z]/);
  });
});

describe('PoliciesTab deep links', () => {
  it('?new=1&principalType=group&principalId=… opens the editor with that group', async () => {
    await render(true, 'tab=policies&new=1&principalType=group&principalId=g-sales');
    await settle(300);
    const overlay = q('.form-overlay')!;
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toContain('Create access policy');
    expect(overlay.textContent).toContain('Sales'); // the group label from the principal detail
    expect(api.to('GET', '/api/iam/principals/group/g-sales')).toHaveLength(1);
  });

  it('?policyId=… opens that policy for an admin and a read-only drawer otherwise', async () => {
    await render(true, 'tab=policies&policyId=p-contractors');
    await settle(200);
    expect(q('.form-overlay')!.textContent).toContain('Edit access policy');
    await mounted.unmount();

    await render(false, 'tab=policies&policyId=p-contractors');
    await settle(200);
    expect(q('.form-overlay')).toBeNull();
    expect(text()).toContain('Contractors may look but not touch');
  });

  it('tells the admin when the policy does not exist', async () => {
    nav.search = 'tab=policies&policyId=ghost';
    api = installApiMock(defaultRoutes());
    api.on('GET', /^\/api\/iam\/policies\/[^/]+$/, () => jsonResponse({ error: 'not found', code: 'not_found' }, 404));
    mounted = await mount(createElement(PoliciesTab, { canManage: true }));
    await settle(200);
    expect(q('.form-overlay')).toBeNull();
    expect(api.to('GET', '/api/iam/policies/ghost')).toHaveLength(1);
  });
});

// keep `act` referenced for future interaction helpers
void act;
