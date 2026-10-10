// @vitest-environment jsdom
/**
 * The IAM center page shell: tab routing from `?tab=`, the seven fixed tab
 * components, and how `canManage` is decided (iam admin: by the engine's own
 * answer for the session, else by role, by the user's own grants, or through a group).
 */

import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  qa,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';
import { DashboardUserProvider } from '@/components/layout/DashboardUserContext';

const nav = vi.hoisted(() => ({ search: '', cache: new Map<string, URLSearchParams>() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/iam',
}));

// The tabs are other components with their own tests; here they only show the props the shell gives them.
vi.mock('@/components/iam/policies/PoliciesTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:policies manage=${p.canManage}`) };
});
vi.mock('@/components/iam/check/AccessCheckTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:check manage=${p.canManage}`) };
});
vi.mock('@/components/iam/principals/PrincipalsTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:principals manage=${p.canManage}`) };
});
vi.mock('@/components/iam/audit/AuditTab', async () => {
  const { createElement } = await import('react');
  // The audit trail is readable by everyone who can open the center: nothing in it depends on `canManage`.
  return { default: () => createElement('div', null, 'tab:audit') };
});
vi.mock('@/components/iam/limits/LimitsTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:limits manage=${p.canManage}`) };
});
vi.mock('@/components/iam/settings/IamSettingsTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:settings manage=${p.canManage}`) };
});
vi.mock('@/components/iam/overview/OverviewTab', async () => {
  const { createElement } = await import('react');
  return { default: (p: { canManage: boolean }) => createElement('div', null, `tab:overview manage=${p.canManage}`) };
});

import IamPage from '@/app/dashboard/iam/page';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());

type Role = 'owner' | 'admin' | 'project_admin' | 'user';

async function renderPage(options: {
  search?: string;
  role?: Role;
  session?: unknown;
  principal?: unknown;
  sessionFails?: boolean;
}) {
  nav.search = options.search ?? '';
  const role = options.role ?? 'admin';
  api = installApiMock([
    [
      'GET',
      '/api/auth/session',
      () =>
        options.sessionFails
          ? jsonResponse({ error: 'nope' }, 500)
          : options.session ?? { authenticated: true, userId: 'u-me', role, servicePermissions: {} },
    ],
    [
      'GET',
      /^\/api\/iam\/principals\/user\/[^/]+$/,
      () => options.principal ?? { principal: { type: 'user', id: 'u-me', label: 'Me' }, effective: [], groups: [], projects: [], policies: [] },
    ],
  ]);
  mounted = await mount(
    createElement(
      DashboardUserProvider as never,
      { value: { name: 'me', email: 'me@example.com', licenseType: 'ee', role } } as never,
      createElement(IamPage),
    ),
  );
  await settle(100);
}

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});

// These render whole component trees (jsdom + Mantine) or run the policy engine; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe('IAM center page', () => {
  it('shows the seven tabs and the overview by default', async () => {
    await renderPage({});
    const labels = qa('[role="tab"]').map((t) => t.textContent?.trim());
    expect(labels).toEqual(['Overview', 'Policies', 'Principals', 'Access check', 'Audit', 'Limits', 'Settings']);
    expect(text()).toContain('IAM center');
    expect(text()).toContain('tab:overview manage=true');
    // the page header keeps its eyebrow; the engine settings page and its mode switch are gone
    expect(text()).toContain('Settings · Authorization');
    expect(api.calls.some((c) => c.path === '/api/iam/mode' || c.path.startsWith('/api/iam/shadow'))).toBe(false);
  });

  it.each([
    ['overview', 'tab:overview'],
    ['policies', 'tab:policies'],
    ['principals', 'tab:principals'],
    ['check', 'tab:check'],
    ['audit', 'tab:audit'],
    ['limits', 'tab:limits'],
    ['settings', 'tab:settings'],
  ])('?tab=%s renders that tab only', async (tab, marker) => {
    await renderPage({ search: `tab=${tab}` });
    expect(text()).toContain(marker);
    expect(text().match(/tab:/g)).toHaveLength(1);
    expect(qa('[role="tab"][aria-selected="true"]')).toHaveLength(1);
  });

  it('falls back to the overview for an unknown tab', async () => {
    await renderPage({ search: 'tab=nonsense' });
    expect(text()).toContain('tab:overview');
  });

  it('puts the chosen tab in the URL and keeps the history usable', async () => {
    const push = vi.spyOn(window.history, 'pushState');
    await renderPage({ search: 'tab=policies' });
    await click(qa('[role="tab"]').find((t) => t.textContent?.trim() === 'Access check'));
    expect(push).toHaveBeenCalledTimes(1);
    expect(String(push.mock.calls[0][2])).toBe('/dashboard/iam?tab=check');
  });
});

describe('canManage', () => {
  it('is true for a workspace admin', async () => {
    await renderPage({ search: 'tab=policies', role: 'admin' });
    expect(text()).toContain('tab:policies manage=true');
  });

  it('is true for the owner whatever the session says about overrides', async () => {
    await renderPage({ search: 'tab=check', role: 'owner' });
    expect(text()).toContain('tab:check manage=true');
    // even when a policy took the level away: the engine never locks the owner out of the center
    await mounted.unmount();
    await renderPage({
      search: 'tab=check',
      role: 'owner',
      session: { userId: 'u-me', role: 'owner', servicePermissions: {}, effectivePermissions: { iam: 'none' } },
    });
    expect(text()).toContain('tab:check manage=true');
  });

  it('takes the engine\'s own answer from the session when it has one (no second request)', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'user', servicePermissions: {}, effectivePermissions: { iam: 'admin', models: 'read' }, effectiveProjectId: 'p1' },
    });
    expect(text()).toContain('tab:policies manage=true');
    expect(api.to('GET', /principals/)).toHaveLength(0);
  });

  it('is false when the engine says less than admin, even for a workspace admin by role (a policy or a project limit took it)', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'admin', servicePermissions: {}, effectivePermissions: { iam: 'read' }, effectiveProjectId: 'p1' },
    });
    expect(text()).toContain('tab:policies manage=false');
    expect(api.to('GET', /principals/)).toHaveLength(0);
  });

  it('falls back to the role and the principal view when the engine could not answer (effectivePermissions null)', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'user', servicePermissions: { iam: 'admin' }, effectivePermissions: null },
    });
    expect(text()).toContain('tab:policies manage=true');
  });

  it('is false for a member who can only read the center', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'user', servicePermissions: { iam: 'read' } },
      principal: { principal: { type: 'user', id: 'u-me', label: 'Me' }, effective: [{ service: 'iam', level: 'read', sources: [] }], groups: [], projects: [], policies: [] },
    });
    expect(text()).toContain('tab:policies manage=false');
  });

  it('is true for a member with their own iam admin grant', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'user', servicePermissions: { iam: 'admin' } },
    });
    expect(text()).toContain('tab:policies manage=true');
    // decided from the session alone: no need for the heavier principal view
    expect(api.to('GET', /principals/)).toHaveLength(0);
  });

  it('is true for a member whose group grants iam admin', async () => {
    await renderPage({
      search: 'tab=policies',
      role: 'user',
      session: { userId: 'u-me', role: 'user', servicePermissions: {} },
      principal: {
        principal: { type: 'user', id: 'u-me', label: 'Me' },
        effective: [{ service: 'iam', level: 'admin', sources: [{ kind: 'group', label: 'IAM admins', level: 'admin' }] }],
        groups: [{ id: 'g1', name: 'IAM admins' }],
        projects: [],
        policies: [],
      },
    });
    expect(text()).toContain('tab:policies manage=true');
  });

  it('does not render a tab on a guessed "cannot": a group may still grant admin', async () => {
    nav.search = 'tab=policies';
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api = installApiMock([
      ['GET', '/api/auth/session', async () => {
        await gate;
        return { userId: 'u-me', role: 'user', servicePermissions: { iam: 'admin' } };
      }],
    ]);
    mounted = await mount(
      createElement(
        DashboardUserProvider as never,
        { value: { name: 'me', email: 'me@example.com', licenseType: 'ee', role: 'user' } } as never,
        createElement(IamPage),
      ),
    );
    await settle(50);
    expect(text()).not.toContain('tab:policies');
    release();
    await settle(80);
    expect(text()).toContain('tab:policies manage=true');
    expect(text()).not.toContain('manage=false');
  });

  it('renders at once for an admin (the guess is already "can manage")', async () => {
    nav.search = 'tab=policies';
    api = installApiMock([['GET', '/api/auth/session', () => new Promise(() => {})]]); // never answers
    mounted = await mount(
      createElement(
        DashboardUserProvider as never,
        { value: { name: 'me', email: 'me@example.com', licenseType: 'ee', role: 'admin' } } as never,
        createElement(IamPage),
      ),
    );
    await settle(50);
    expect(text()).toContain('tab:policies manage=true');
  });

  it('keeps the role-based guess when the session cannot be read', async () => {
    await renderPage({ search: 'tab=policies', role: 'admin', sessionFails: true });
    expect(text()).toContain('tab:policies manage=true');
    await mounted.unmount();
    await renderPage({ search: 'tab=policies', role: 'user', sessionFails: true });
    expect(text()).toContain('tab:policies manage=false');
  });
});
