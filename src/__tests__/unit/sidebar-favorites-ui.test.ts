// @vitest-environment jsdom
/**
 * Favorites in the single left menu, clicked through: the closed row opens the favorites' own level (the way back, the
 * favorites as links with their pins), taking them out there, the icon strip's menu and the nested style's fold. What
 * each style renders is covered in sidebar-nav.test.ts.
 */
import { createElement as h, useState, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { click, installDomStubs, mount, q, qa, wait, type Mounted } from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/overview',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

// A plain anchor: no router here to prefetch with or to navigate.
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: ReactNode; [key: string]: unknown }) => {
    const { href, children, ...rest } = props;
    delete rest.onNavigate;
    delete rest.prefetch;
    return h('a', { href, ...rest }, children);
  },
}));

import Sidebar, { type SidebarProps } from '@/components/layout/launcher/Sidebar';
import { SUBNAV_CONFIG, visibleSubNavItems } from '@/components/layout/launcher/ServiceSubNav';
import { reportsNavItems } from '@/components/layout/launcher/reportsNav';
import { findDashboardService, getDashboardServices, type DashboardServiceDefinition } from '@/lib/utils/dashboardServices';

const owner = getDashboardServices({ role: 'owner', isTenantAdmin: true, isOnPrem: true });
const agents = findDashboardService('agents')!;
const rag = findDashboardService('rag')!;
const files = findDashboardService('files')!;
const pagesFor = (service: DashboardServiceDefinition) => visibleSubNavItems(SUBNAV_CONFIG[service.id], () => true, true);
const reportsItems = reportsNavItems(
  [
    { key: 'overview', title: 'Overview' },
    { key: 'cost-spend', title: 'Cost & spend', group: 'usage' },
    { key: 'agents', title: 'Agent sessions', group: 'quality' },
  ],
  (report) => report.title,
);

/** The menu with a working pin store, as the shell gives it (useLauncherState keeps a Set in the order pinned). */
function Menu(props: Partial<SidebarProps> & { initial: string[] }) {
  const { initial, ...rest } = props;
  const [pins, setPins] = useState<ReadonlySet<string>>(() => new Set(initial));
  return h(Sidebar, {
    services: owner,
    activeService: null,
    settingsItems: [],
    settingsHref: '/dashboard/projects',
    settingsActive: false,
    onHelpClick: () => undefined,
    pathname: '/dashboard/overview',
    pagesFor,
    reportsItems,
    ...rest,
    pinnedIds: pins,
    onTogglePin: (id: string) =>
      setPins((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  });
}

const testId = (el: Element | null | undefined) => el?.getAttribute('data-testid') ?? null;
const favoriteRows = () => qa('[data-testid^="sidebar-favorite-"]').map((el) => [testId(el), el.getAttribute('href')]);

let mounted: Mounted | undefined;
beforeAll(() => installDomStubs());
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  window.localStorage.clear();
});

vi.setConfig({ testTimeout: 20_000 });

describe('Favorites, step by step', () => {
  it('the closed row opens Favorites’ level: the way back, and the favorites in the order pinned as links with their pins', async () => {
    mounted = await mount(h(Menu, { initial: ['rag', 'agents'] }));
    const row = q('[data-testid="sidebar-favorites"]');
    expect(row?.textContent).toBe('Favorites2');
    expect(favoriteRows()).toEqual([]);

    await click(row);
    expect(q('[data-testid="sidebar-level-favorites"]')).not.toBeNull();
    expect(q('[data-testid="sidebar-back"]')?.textContent).toContain('Favorites');
    expect(favoriteRows()).toEqual([
      ['sidebar-favorite-rag', rag.href],
      ['sidebar-favorite-agents', agents.href],
    ]);
    expect(q('[data-testid="sidebar-pin-favorite-agents"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="sidebar-pin-favorite-agents"]')?.getAttribute('aria-label')).toBe('Remove Agents from Favorites');
    // Favorites is no service: no pin in its header. The services wait on the first level.
    expect(q('[data-testid="sidebar-level-pin"]')).toBeNull();
    expect(q('[data-testid="sidebar-category-build"]')).toBeNull();
    // Focus goes to the way back.
    expect(testId(document.activeElement)).toBe('sidebar-back');
  });

  it('back returns to the first level, focus on the Favorites row', async () => {
    mounted = await mount(h(Menu, { initial: ['agents'] }));
    await click(q('[data-testid="sidebar-favorites"]'));
    await click(q('[data-testid="sidebar-back"]'));
    expect(q('[data-testid="sidebar-level-root"]')).not.toBeNull();
    expect(testId(document.activeElement)).toBe('sidebar-favorites');
  });

  it('taking a favorite out there updates the list; the last one goes back to the first level, where the row is gone', async () => {
    mounted = await mount(h(Menu, { initial: ['rag', 'agents'] }));
    await click(q('[data-testid="sidebar-favorites"]'));
    await click(q('[data-testid="sidebar-pin-favorite-rag"]'));
    expect(q('[data-testid="sidebar-level-favorites"]')).not.toBeNull();
    expect(favoriteRows()).toEqual([['sidebar-favorite-agents', agents.href]]);
    await click(q('[data-testid="sidebar-pin-favorite-agents"]'));
    expect(q('[data-testid="sidebar-level-root"]')).not.toBeNull();
    expect(q('[data-testid="sidebar-favorites"]')).toBeNull();
    // A pin added later shows the row again and stays on the first level.
    await click(q('[data-testid="sidebar-pin-models"]'));
    expect(q('[data-testid="sidebar-level-root"]')).not.toBeNull();
    expect(q('[data-testid="sidebar-favorites"]')?.textContent).toBe('Favorites1');
  });

  it('a pin on a service row adds to the count without leaving the first level', async () => {
    mounted = await mount(h(Menu, { initial: ['rag'] }));
    await click(q('[data-testid="sidebar-pin-agents"]'));
    expect(q('[data-testid="sidebar-level-root"]')).not.toBeNull();
    expect(q('[data-testid="sidebar-favorites"]')?.textContent).toBe('Favorites2');
    expect(q('[data-testid="sidebar-pin-agents"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a favorite in view is only named there (its service’s own row is the one marked)', async () => {
    mounted = await mount(
      h(Menu, { initial: ['files'], activeService: files, activeItems: SUBNAV_CONFIG.files, pathname: '/dashboard/files' }),
    );
    expect(q('[data-testid="sidebar-service-files"]')?.getAttribute('aria-current')).toBe('page');
    await click(q('[data-testid="sidebar-favorites"]'));
    expect(q('[data-testid="sidebar-favorite-files"]')?.getAttribute('aria-current')).toBe('true');
    expect(qa('[aria-current="page"]')).toHaveLength(0);
  });
});

describe('Favorites in the icon strip and the nested style', () => {
  it('the strip has one Favorites button; it opens the favorites in a menu, as links', async () => {
    window.localStorage.setItem('cgn:sidebar:collapsed', 'true');
    mounted = await mount(h(Menu, { initial: ['rag', 'agents'] }));
    await wait(0);
    expect(q('[data-collapsed="true"]')).not.toBeNull();
    const button = q('[data-testid="sidebar-favorites"]');
    expect(button?.getAttribute('aria-label')).toBe('Favorites');
    expect(favoriteRows()).toEqual([]);

    await click(button);
    await wait(50);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(q('[data-testid="sidebar-favorites-menu"]')?.textContent).toContain('Favorites');
    expect(favoriteRows()).toEqual([
      ['sidebar-favorite-rag', rag.href],
      ['sidebar-favorite-agents', agents.href],
    ]);
  });

  it('the nested style folds Favorites, closed until clicked', async () => {
    mounted = await mount(h(Menu, { initial: ['agents'], menuStyle: 'tree' }));
    const fold = q('[data-testid="sidebar-favorites"]');
    expect(fold?.getAttribute('aria-expanded')).toBe('false');
    expect(favoriteRows()).toEqual([]);
    await click(fold);
    expect(fold?.getAttribute('aria-expanded')).toBe('true');
    expect(favoriteRows()).toEqual([['sidebar-favorite-agents', agents.href]]);
    await click(fold);
    expect(favoriteRows()).toEqual([]);
  });
});
