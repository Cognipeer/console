// @vitest-environment jsdom
/**
 * Project-aware navigation. The menu used to be judged from the role and the
 * person's own grants alone, so a service that a project (or a policy, or a
 * group) had narrowed to "none" stayed visible and answered 403 on click. The
 * session now carries what the engine allows per service in the ACTIVE project
 * (`effectivePermissions`); the sidebar, the launcher and the command palette
 * follow it, and fall back to the role-based view when it is absent.
 */

import { act, createElement, Fragment, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
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
import {
  ALL_DASHBOARD_SERVICES,
  canUseDashboardService,
  getDashboardServices,
  type DashboardServiceDefinition,
} from '@/lib/utils/dashboardServices';
import { SUBNAV_CONFIG, visibleSubNavItems } from '@/components/layout/launcher/ServiceSubNav';
import {
  ACTIVE_PROJECT_CHANGED_EVENT,
  notifyActiveProjectChanged,
  parseEffectivePermissions,
  useEffectivePermissions,
  type EffectivePermissions,
} from '@/components/layout/useEffectivePermissions';
import { LauncherProvider, type LauncherContextValue } from '@/components/layout/launcher/LauncherContext';
import CommandPalette, { openCommandPalette } from '@/components/layout/CommandPalette';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

const ids = (list: DashboardServiceDefinition[]) => list.map((s) => s.id as string);

describe('getDashboardServices with the engine\'s answer for the active project', () => {
  const asUser = { role: 'user' as const, servicePermissions: {} };

  it('without it, the menu is what the role and the own grants say (unchanged)', () => {
    const list = ids(getDashboardServices({ ...asUser }));
    expect(list).toContain('models');
    expect(list).toContain('agents');
    expect(list).not.toContain('members'); // an administration service: not for a plain user
    expect(ids(getDashboardServices({ ...asUser, effectivePermissions: null }))).toEqual(list);
    expect(ids(getDashboardServices({ ...asUser, effectivePermissions: {} }))).toEqual(list);
  });

  it('Webhooks is an administration service: a plain member does not see it until the permission is granted', () => {
    // Webhooks sit in the Agents menu (no service entry of their own), judged by the level the services are.
    const sees = (options: Parameters<typeof canUseDashboardService>[0]) =>
      visibleSubNavItems(SUBNAV_CONFIG.agents, (service) => canUseDashboardService(options, service))!.some(
        (entry) => entry.id === 'webhooks',
      );
    expect(sees({ ...asUser })).toBe(false);
    expect(sees({ role: 'admin', servicePermissions: {} })).toBe(true);
    // an own grant, or the engine's answer for this project (a group, a policy), shows it
    expect(sees({ role: 'user', servicePermissions: { webhooks: 'read' } })).toBe(true);
    expect(sees({ ...asUser, effectivePermissions: { webhooks: 'admin' } })).toBe(true);
    // ...and a rule that takes it away from an admin hides it
    expect(sees({ role: 'admin', servicePermissions: {}, effectivePermissions: { webhooks: 'none' } })).toBe(false);
    // the rest of the Agents menu is not affected
    expect(visibleSubNavItems(SUBNAV_CONFIG.agents, (service) => canUseDashboardService(asUser, service))!.map((entry) => entry.id)).toEqual(['list', 'tools', 'skills']);
  });

  it('hides a service the active project narrowed to none, instead of leaving a link that answers 403', () => {
    const list = ids(getDashboardServices({ ...asUser, effectivePermissions: { models: 'none', agents: 'read' } }));
    expect(list).not.toContain('models');
    expect(list).toContain('agents'); // read is enough to see it
    expect(list).toContain('prompts'); // services the map does not name keep the role-based answer
  });

  it('shows a service the engine grants beyond the role (a group or a policy gave it)', () => {
    // 'sandbox' is an administration-tier service that a plain user does not get by role
    const byRole = ids(getDashboardServices({ ...asUser }));
    const candidate = ALL_DASHBOARD_SERVICES.find((s) => s.tenantAdminOnly && !s.requiresOnPrem && s.id !== 'services-home' && !byRole.includes(s.id as string));
    expect(candidate).toBeTruthy();
    const granted = ids(
      getDashboardServices({ ...asUser, effectivePermissions: { [candidate!.id]: 'admin' } }),
    );
    expect(granted).toContain(candidate!.id as string);
    // but an administration service needs admin, not just read
    const readOnly = ids(getDashboardServices({ ...asUser, effectivePermissions: { [candidate!.id]: 'read' } }));
    expect(readOnly).not.toContain(candidate!.id as string);
  });

  it('a workspace admin loses a service only when the engine says so', () => {
    const admin = { role: 'admin' as const, isTenantAdmin: true, servicePermissions: {} };
    expect(ids(getDashboardServices(admin))).toContain('guardrails');
    expect(ids(getDashboardServices({ ...admin, effectivePermissions: { guardrails: 'none' } }))).not.toContain('guardrails');
    expect(ids(getDashboardServices({ ...admin, effectivePermissions: { guardrails: 'admin' } }))).toContain('guardrails');
  });

  it('the services home is never judged by a level', () => {
    const list = ids(getDashboardServices({ ...asUser, effectivePermissions: { 'services-home': 'none' } }));
    expect(list).toContain('services-home');
  });

  it('keeps hiding what is not for this deployment, whatever the engine says', () => {
    const onPrem = ALL_DASHBOARD_SERVICES.find((s) => s.requiresOnPrem);
    if (!onPrem) return;
    const granted = { [onPrem.id]: 'admin' as const };
    expect(ids(getDashboardServices({ role: 'owner', isTenantAdmin: true, effectivePermissions: granted, isOnPrem: false }))).not.toContain(onPrem.id as string);
    expect(ids(getDashboardServices({ role: 'owner', isTenantAdmin: true, effectivePermissions: granted, isOnPrem: true }))).toContain(onPrem.id as string);
  });
});

describe('parseEffectivePermissions', () => {
  it('reads the level map of a session payload', () => {
    expect(parseEffectivePermissions({ effectivePermissions: { models: 'read', agents: 'none', iam: 'admin' } })).toEqual({
      models: 'read',
      agents: 'none',
      iam: 'admin',
    });
  });

  it('drops what is not a level, and returns null when there is no map (the engine could not answer)', () => {
    expect(parseEffectivePermissions({ effectivePermissions: { models: 'sideways', agents: 3, iam: 'write' } })).toEqual({ iam: 'write' });
    expect(parseEffectivePermissions({ effectivePermissions: null })).toBeNull();
    expect(parseEffectivePermissions({})).toBeNull();
    expect(parseEffectivePermissions({ effectivePermissions: ['models'] })).toBeNull();
    expect(parseEffectivePermissions('junk')).toBeNull();
    expect(parseEffectivePermissions(null)).toBeNull();
  });
});

describe('useEffectivePermissions', () => {
  let api: ApiMock;
  let mounted: Mounted;

  beforeAll(() => installDomStubs());
  afterEach(async () => {
    await mounted?.unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function Probe({ onLevels }: { onLevels: (levels: EffectivePermissions | null) => void }): ReactNode {
    const levels = useEffectivePermissions();
    onLevels(levels);
    return createElement('div', { 'data-testid': 'levels' }, levels ? JSON.stringify(levels) : 'none');
  }

  async function renderProbe(session: () => unknown | Response) {
    const seen: Array<EffectivePermissions | null> = [];
    api = installApiMock([['GET', '/api/auth/session', session as never]]);
    mounted = await mount(createElement(Probe, { onLevels: (l) => seen.push(l) }));
    await settle(60);
    return seen;
  }

  it('is null until the session answers, then the levels of the active project', async () => {
    const seen = await renderProbe(() => ({ authenticated: true, role: 'user', effectivePermissions: { models: 'none', agents: 'write' } }));
    expect(seen[0]).toBeNull();
    expect(seen[seen.length - 1]).toEqual({ models: 'none', agents: 'write' });
    expect(api.to('GET', '/api/auth/session')).toHaveLength(1);
  });

  it('stays null (role-based menu) when the engine could not answer or the session is gone', async () => {
    const withoutMap = await renderProbe(() => ({ authenticated: true, role: 'user', effectivePermissions: null }));
    expect(withoutMap[withoutMap.length - 1]).toBeNull();
    await mounted.unmount();
    const signedOut = await renderProbe(() => jsonResponse({ error: 'unauthorized' }, 401));
    expect(signedOut[signedOut.length - 1]).toBeNull();
  });

  it('asks again when the active project changes without a page reload', async () => {
    let level = 'write';
    const seen = await renderProbe(() => ({ effectivePermissions: { models: level } }));
    expect(seen[seen.length - 1]).toEqual({ models: 'write' });
    level = 'none';
    notifyActiveProjectChanged();
    await settle(60);
    expect(api.to('GET', '/api/auth/session')).toHaveLength(2);
    expect(seen[seen.length - 1]).toEqual({ models: 'none' });
  });

  it('keeps what it knew when a later answer has no map', async () => {
    let body: unknown = { effectivePermissions: { models: 'read' } };
    const seen = await renderProbe(() => body);
    body = { effectivePermissions: null };
    notifyActiveProjectChanged();
    await settle(60);
    expect(seen[seen.length - 1]).toEqual({ models: 'read' });
  });

  it('exposes the event name the project switchers dispatch', () => {
    expect(ACTIVE_PROJECT_CHANGED_EVENT).toBe('cognipeer:active-project-changed');
  });
});

describe('the command palette follows the services the shell offers', () => {
  let mounted: Mounted;

  beforeAll(() => installDomStubs());
  afterEach(async () => {
    await mounted?.unmount();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const launcherValue = (services: DashboardServiceDefinition[]): LauncherContextValue => ({
    pinned: new Set(),
    recents: [],
    togglePin: () => {},
    recordVisit: () => {},
    services,
    pinnedServices: [],
    recentServices: [],
    isTenantAdmin: true,
    openLauncher: () => {},
    hydrated: true,
  });

  async function openPalette(element: ReactNode) {
    installApiMock([]); // the palette's own searches are not under test
    mounted = await mount(element);
    openCommandPalette();
    await settle(80);
  }

  it('offers the services of the shell - one narrowed away in this project is not in the list', async () => {
    const offered = getDashboardServices({ role: 'admin', isTenantAdmin: true, effectivePermissions: { models: 'none' } });
    await openPalette(
      createElement(
        LauncherProvider as never,
        { value: launcherValue(offered) } as never,
        createElement(CommandPalette, { isTenantAdmin: true }),
      ),
    );
    const t = text();
    expect(t).toContain('Agents');
    expect(t).not.toContain('Model Hub');
  });

  it('finds Webhooks (a page of the Agents menu) only when the shell says the person may use the service', async () => {
    const offered = getDashboardServices({ role: 'user', servicePermissions: {} });
    expect(ids(offered)).toContain('agents');
    const palette = (canUseService: LauncherContextValue['canUseService']) =>
      createElement(
        LauncherProvider as never,
        { value: { ...launcherValue(offered), canUseService } } as never,
        createElement(CommandPalette, { isTenantAdmin: false }),
      );

    await openPalette(palette((service) => service !== 'webhooks'));
    expect(text()).not.toContain('Webhooks');
    await mounted.unmount();

    await openPalette(palette(() => true));
    expect(text()).toContain('Webhooks');
  });

  it('opens on "/" unless a page has already taken the key for its own search box', async () => {
    installApiMock([]);
    mounted = await mount(createElement(Fragment, null, createElement(CommandPalette, { isTenantAdmin: true })));
    const slash = () => new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    const press = async () => {
      await act(async () => {
        document.body.dispatchEvent(slash());
      });
      await settle(80);
    };

    const claim = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener('keydown', claim, true);
    await press();
    window.removeEventListener('keydown', claim, true);
    expect(qa('[data-cmd-index]')).toHaveLength(0);

    await press();
    expect(qa('[data-cmd-index]').length).toBeGreaterThan(10);
  });

  it('without a shell around it, lists every service the old way', async () => {
    await openPalette(createElement(Fragment, null, createElement(CommandPalette, { isTenantAdmin: true })));
    expect(text()).toContain('Model Hub');
    expect(qa('[data-cmd-index]').length).toBeGreaterThan(10);
  });
});
