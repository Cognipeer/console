/**
 * The single left menu: one labelled column instead of the icon rail plus the service sub-nav. It lists only what the
 * person can open, under the launcher's categories (Build, Data, Operate; an empty one is left out), and goes step by
 * step: a service's pages (filtered like the sub-nav), the reports and Settings' grouped pages are levels of their own.
 * Favorites, under Home and Reports, are the services the person pins from the menu (kept in the browser, in the order
 * pinned). The nested style is kept behind SIDEBAR_STYLE. Someone with seven services or fewer gets one plain
 * list, without categories. The top bar beside it is slim (no launcher). SIDEBAR_NAV switches back to the rail and the
 * sub-nav, which are kept. A phone gets the same menu in the top bar's drawer.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/agents',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

// The window width the menu sees (useMediaQuery); everything else of @mantine/hooks stays real.
const media = vi.hoisted(() => ({ narrow: false }));
vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantine/hooks')>()),
  useMediaQuery: () => media.narrow,
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import Sidebar, { type SidebarProps } from '@/components/layout/launcher/Sidebar';
import MobileNavDrawer from '@/components/layout/launcher/MobileNavDrawer';
import { SIDEBAR_FLAT_MAX, isFlatSidebar, sidebarGroups, sidebarServices } from '@/components/layout/launcher/sidebarNav';
import { isReportsPath, reportsNavItems, type ListedReport } from '@/components/layout/launcher/reportsNav';
import { SUBNAV_CONFIG, visibleSubNavItems, type SubNavItem } from '@/components/layout/launcher/ServiceSubNav';
import { findDashboardService, getDashboardServices, type DashboardServiceDefinition } from '@/lib/utils/dashboardServices';
import type { PermissionService, ServicePermissionLevel } from '@/lib/security/rbac';
import { IconFolder, IconKey } from '@tabler/icons-react';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));

const owner = getDashboardServices({ role: 'owner', isTenantAdmin: true, isOnPrem: true });
const agents = findDashboardService('agents')!;

/** A project member whose engine levels allow only these services (everything else none). */
function memberServices(allowed: PermissionService[]): DashboardServiceDefinition[] {
  const effectivePermissions: Partial<Record<string, ServicePermissionLevel>> = {};
  for (const service of owner) {
    if (service.id !== 'services-home') effectivePermissions[service.id] = allowed.includes(service.id as PermissionService) ? 'write' : 'none';
  }
  effectivePermissions.webhooks = allowed.includes('webhooks') ? 'write' : 'none';
  return getDashboardServices({ role: 'user', isTenantAdmin: false, effectivePermissions });
}

const settingsItems: SubNavItem[] = [
  { id: 'projects', label: 'Projects', sectionKey: 'settingsWorkspace', href: '/dashboard/projects', icon: IconFolder },
  { id: 'tokens', label: 'API Tokens', href: '/dashboard/tokens', icon: IconKey },
];

function sidebar(props: Partial<SidebarProps> & Pick<SidebarProps, 'services'>, locale: 'en' | 'tr' = 'en') {
  return render(
    h(Sidebar, {
      activeService: null,
      settingsItems: [],
      settingsHref: '/dashboard/projects',
      settingsActive: false,
      onHelpClick: () => undefined,
      pathname: '/dashboard/agents',
      ...props,
    }),
    locale,
  );
}

/** Reports as the reports API lists them (in its order, which is not the menu's). */
const listedReports: ListedReport[] = [
  { key: 'overview', title: 'Overview', icon: 'gauge' },
  { key: 'guardrails', title: 'Guardrails', icon: 'shield', group: 'safety' },
  { key: 'cost-spend', title: 'Cost & spend', icon: 'coin', group: 'usage' },
  { key: 'agents', title: 'Agent sessions', icon: 'robot', group: 'quality' },
  { key: 'models', title: 'Model operations', icon: 'bolt', group: 'usage' },
];
const reportItems = reportsNavItems(listedReports, (report) => report.title);

describe('what the menu lists', () => {
  it('the launcher categories in the order Build, Data, Operate, without Settings pages or the services home', () => {
    const groups = sidebarGroups(owner);
    expect(groups.map((group) => group.category)).toEqual(['build', 'data', 'operate']);
    expect(groups.map((group) => group.label)).toEqual(['Build', 'Data', 'Operate']);
    const listed = groups.flatMap((group) => group.services);
    expect(listed.some((service) => service.isSettings || service.id === 'services-home')).toBe(false);
    expect(listed.length).toBe(sidebarServices(owner).length);
    // The JSON order inside a category.
    expect(groups[0].services.map((service) => service.id).slice(0, 2)).toEqual(['models', 'prompts']);
  });

  it('leaves out a category with nothing the person can open', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    expect(sidebarGroups(member).map((group) => group.category)).toEqual(['build', 'data']);
    expect(sidebarServices(member).map((service) => service.id).sort()).toEqual(['agents', 'prompts', 'rag']);
  });

  it(`is one plain list up to ${SIDEBAR_FLAT_MAX} services`, () => {
    expect(isFlatSidebar(owner)).toBe(false);
    expect(isFlatSidebar(memberServices(['agents', 'prompts', 'rag', 'guardrails']))).toBe(true);
    const eight = memberServices(['agents', 'prompts', 'rag', 'guardrails', 'models', 'vector', 'memory', 'files']);
    expect(sidebarServices(eight).length).toBe(8);
    expect(isFlatSidebar(eight)).toBe(false);
  });
});

describe('the menu', () => {
  it('nested style, many services: categories with counts, and the pages of the service in view', () => {
    const activeItems = visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true);
    const html = sidebar({ services: owner, activeService: agents, activeItems, menuStyle: 'tree' });
    for (const group of sidebarGroups(owner)) {
      expect(html).toContain(`data-testid="sidebar-group-${group.category}"`);
    }
    expect(html).toMatch(/data-testid="sidebar-group-build"[^>]*>.*?<span[^>]*>Build<\/span><span[^>]*>7<\/span>/);
    expect(html).toContain('data-testid="sidebar-subitem-tools"');
    expect(html).toContain('data-testid="sidebar-subitem-webhooks"');
  });

  it('without the pin store (no onTogglePin) it offers no pin and shows no Favorites, in either style or variant', () => {
    for (const menuStyle of ['tree', 'drill'] as const) {
      for (const variant of ['side', 'drawer'] as const) {
        const first = sidebar({ services: owner, menuStyle, variant, pinnedIds: new Set(['agents']), pathname: '/dashboard/overview' });
        const level = sidebar({
          services: owner,
          menuStyle,
          variant,
          activeService: agents,
          activeItems: visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true),
          pinnedIds: new Set(['agents']),
          pathname: '/dashboard/agents/tools',
        });
        for (const html of [first, level]) {
          expect(html).not.toContain('data-testid="sidebar-favorites"');
          expect(html).not.toContain('data-testid="sidebar-favorite-');
          expect(html).not.toContain('data-testid="sidebar-pin-');
          expect(html).not.toContain('data-testid="sidebar-level-pin"');
        }
      }
    }
  });

  it('a page the person cannot use is not offered under its service (Webhooks without the Webhooks service)', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const activeItems = visibleSubNavItems(SUBNAV_CONFIG.agents, (service) => service !== 'webhooks', false);
    const html = sidebar({ services: member, activeService: agents, activeItems });
    expect(html).toContain('data-testid="sidebar-subitem-tools"');
    expect(html).not.toContain('data-testid="sidebar-subitem-webhooks"');
  });

  it('for few services: one plain list, no categories', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const html = sidebar({ services: member });
    expect(html).toContain('data-flat="true"');
    expect(html).not.toContain('data-testid="sidebar-group-');
    expect(html).toContain('data-testid="sidebar-service-agents"');
    expect(html).not.toContain('data-testid="sidebar-service-models"');
  });

  it('Settings shows only with pages the person may open, and opens them by group while one is in view', () => {
    expect(sidebar({ services: owner })).not.toContain('data-testid="sidebar-settings"');
    const closed = sidebar({ services: owner, settingsItems });
    expect(closed).toContain('data-testid="sidebar-settings"');
    expect(closed).not.toContain('data-testid="sidebar-subitem-projects"');
    const open = sidebar({ services: owner, settingsItems, settingsActive: true, pathname: '/dashboard/projects' });
    expect(open).toContain('data-testid="sidebar-subitem-projects"');
    expect(open).toContain('>Workspace<');
    expect(open).toMatch(/data-testid="sidebar-subitem-projects"[^>]*aria-current="page"|aria-current="page"[^>]*data-testid="sidebar-subitem-projects"/);
  });

  it('a service with a single page opens nothing under it', () => {
    const files = findDashboardService('files')!;
    const html = sidebar({ services: owner, activeService: files, activeItems: SUBNAV_CONFIG.files, pathname: '/dashboard/files' });
    expect(SUBNAV_CONFIG.files.length).toBe(1);
    expect(html).not.toContain(`data-testid="sidebar-subitem-${SUBNAV_CONFIG.files[0].id}"`);
  });

  it('starts as icons on a narrow window or a tablet, labelled on a wide one', () => {
    const wide = sidebar({ services: owner });
    expect(wide).toContain('data-testid="sidebar-nav"');
    expect(wide).not.toContain('data-collapsed="true"');
    media.narrow = true;
    try {
      expect(sidebar({ services: owner })).toContain('data-collapsed="true"');
    } finally {
      media.narrow = false;
    }
  });

  it('speaks the viewer’s language', () => {
    const html = sidebar({ services: owner }, 'tr');
    expect(html).toContain('Ana sayfa');
    expect(html).toContain('Menüyü daralt');
    expect(sidebar({ services: owner, activeService: agents, activeItems: SUBNAV_CONFIG.agents }, 'tr')).toContain('Ana menüye dön');
    expect(sidebar({ services: owner, reportsItems: reportItems }, 'tr')).toContain('Raporlar');
  });
});

describe('the menu on a phone', () => {
  const drawerProps = {
    open: true,
    onClose: () => undefined,
    pathname: '/dashboard/agents',
    pinned: [],
    recents: [],
    activeService: agents,
    onOpenLauncher: () => undefined,
    onOpenDocs: () => undefined,
    settingsHref: '/dashboard/projects',
    settingsActive: false,
  };

  it('is the same menu, labelled although a phone is narrow, without the collapse toggle', () => {
    media.narrow = true;
    try {
      const level = sidebar({ services: owner, variant: 'drawer', activeService: agents, activeItems: SUBNAV_CONFIG.agents, settingsItems });
      expect(level).toContain('data-testid="sidebar-drawer"');
      expect(level).not.toContain('data-collapsed="true"');
      expect(level).toContain('data-testid="sidebar-level-agents"');
      expect(level).toContain('data-testid="sidebar-back"');
      expect(level).toContain('data-testid="sidebar-subitem-tools"');
      expect(level).toContain('data-testid="sidebar-help"');
      expect(level).not.toContain('data-testid="sidebar-toggle"');
      const first = sidebar({ services: owner, variant: 'drawer', settingsItems, pathname: '/dashboard/overview' });
      expect(first).toContain('data-testid="sidebar-category-build"');
      expect(first).toContain('data-testid="sidebar-settings"');
      expect(first).not.toContain('data-testid="sidebar-toggle"');
    } finally {
      media.narrow = false;
    }
  });

  it('for few services: the same plain list as the side menu', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const html = sidebar({ services: member, variant: 'drawer' });
    expect(html).toContain('data-flat="true"');
    expect(html).not.toContain('data-testid="sidebar-group-');
  });

  it('the drawer shows the menu it is given, under the menu title, and none of its old lists', () => {
    const html = render(
      h(MobileNavDrawer, { ...drawerProps, menu: h('nav', { 'data-testid': 'given-menu' }), menuTitle: 'Main menu' }),
    );
    expect(html).toContain('data-testid="mobile-nav-menu"');
    expect(html).toContain('data-testid="given-menu"');
    expect(html).toContain('aria-label="Main menu"');
    expect(html).not.toContain('Browse all services');
    expect(html).not.toContain('>Navigation<');
    // Without a menu (SIDEBAR_NAV off) the drawer keeps its lists (rendered in connectors-nav / agent-sessions-nav).
    const drawerSource = readFileSync(join(process.cwd(), 'src/components/layout/launcher/MobileNavDrawer.tsx'), 'utf8');
    expect(drawerSource.indexOf('Browse all services')).toBeGreaterThan(drawerSource.indexOf('if (menu) {'));
  });

  it('every link of the menu and its help close the drawer', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.tsx'), 'utf8');
    const links = source.match(/<Link\b/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect((source.match(/onNavigate=\{onNavigate\}/g) ?? []).length).toBe(links.length);
    expect(source).toMatch(/const openHelp = \(\) => \{\s*onNavigate\?\.\(\);\s*onHelpClick\(\);/);
    expect(source).toContain('const collapsed = drawer ? false : prefs.collapsed;');
  });

  it('the shell hands the drawer the same filtered lists as the side menu', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/DashboardLayout.tsx'), 'utf8');
    expect(layout).toMatch(
      /menu=\{\s*SIDEBAR_NAV \? \(\s*<Sidebar\s+variant="drawer"\s+onNavigate=\{closeMobileNav\}\s+services=\{allowedServices\}[\s\S]*?activeItems=\{serviceSubnavItems\}\s+settingsItems=\{settingsNavItems\}/,
    );
    const css = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.module.css'), 'utf8');
    expect(css).toMatch(/\.sidebar\.drawer \{\s*display: flex;/);
    // A finger gets a larger pin on a service's level.
    expect(css).toMatch(/\.drawer \.levelPin \{\s*width: 40px;\s*height: 40px;/);
    // The drawer gets the reports too.
    expect(layout).toMatch(/<Sidebar\s+variant="drawer"[\s\S]*?reportsItems=\{reportsItems\}\s+reportsActive=\{reportsActive\}/);
  });
});

describe('the switch and the old menu', () => {
  const layout = readFileSync(join(process.cwd(), 'src/components/layout/DashboardLayout.tsx'), 'utf8');
  const topbar = readFileSync(join(process.cwd(), 'src/components/layout/launcher/TopbarV2.tsx'), 'utf8');
  const model = readFileSync(join(process.cwd(), 'src/components/layout/launcher/sidebarNav.ts'), 'utf8');

  it('a narrow window opens the menu for the visit only; the stored choice is the wide screen’s', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.tsx'), 'utf8');
    expect(model).toContain("export const SIDEBAR_NARROW_QUERY = '(max-width: 62em)';");
    expect(source).toContain('const collapsed = narrow ? !narrowOpen : storedCollapsed;');
    expect(source).toMatch(/if \(narrow\) \{\s*setNarrowOpen\(\(open\) => !open\);\s*return;\s*\}/);
  });

  it('one constant picks the menu; the rail and the sub-nav are still there behind it', () => {
    expect(model).toContain('export const SIDEBAR_NAV = true;');
    expect(layout).toMatch(/\{SIDEBAR_NAV \? \(\s*<Sidebar[\s\S]*?\) : \(\s*<>\s*<SlimRail[\s\S]*?<ServiceSubNav[\s\S]*?<\/>\s*\)\}/);
    expect(layout).toContain('SIDEBAR_NAV ? sidebarClasses.shell : `${classes.shell} ${hasSubnav ? classes.shellWithSubnav : \'\'}`');
  });

  it('the menu gets the same filtered lists the rail and the sub-nav got', () => {
    expect(layout).toMatch(/<Sidebar\s+services=\{allowedServices\}[\s\S]*?activeItems=\{serviceSubnavItems\}[\s\S]*?settingsItems=\{settingsNavItems\}/);
  });

  it('with the single menu the top bar is slim: no launcher, portals, theme or docs button (the old bar keeps them)', () => {
    expect(layout).toContain("variant={SIDEBAR_NAV ? 'slim' : 'full'}");
    expect(topbar).toContain('{slim ? null : (');
    // Launcher, then portals + theme + docs: each behind the slim switch.
    expect(topbar.match(/\{slim \? null : \(/g) ?? []).toHaveLength(2);
    expect(topbar).toMatch(/\{slim \? null : \(\s*<>\s*<PortalSwitcher \/>[\s\S]*?toggleColorScheme[\s\S]*?onClick=\{onDocsClick\}/);
  });

  it('has its words in both languages, with the same placeholders', () => {
    const keys = [
      'sidebarLabel', 'sidebarHome', 'sidebarReports', 'sidebarHelp', 'sidebarCollapse', 'sidebarExpand', 'sidebarBack',
      'sidebarAllOf', 'sidebarFavorites', 'sidebarPin', 'sidebarUnpin', 'reportsSummary', 'reportsGroupUsage',
      'reportsGroupQuality', 'reportsGroupSafety', 'reportsGroupInfrastructure',
    ] as const;
    const enNav = en.navigation as Record<string, string>;
    const trNav = tr.navigation as Record<string, string>;
    for (const key of keys) {
      expect(enNav[key], key).toBeTruthy();
      expect(trNav[key], key).toBeTruthy();
      expect(trNav[key], key).not.toBe(enNav[key]);
      expect(trNav[key].match(/\{\w+\}/g) ?? [], key).toEqual(enNav[key].match(/\{\w+\}/g) ?? []);
    }
    for (const key of ['sidebarPinned', 'sidebarAllServices']) {
      expect(enNav[key], key).toBeUndefined();
    }
    const enAccount = en.account as Record<string, string>;
    const trAccount = tr.account as Record<string, string>;
    for (const key of ['themeDark', 'themeLight']) {
      expect(enAccount[key], key).toBeTruthy();
      expect(trAccount[key], key).toBeTruthy();
      expect(trAccount[key], key).not.toBe(enAccount[key]);
    }
  });
});

describe('no page twice, and the step-by-step menu', () => {
  const layout = readFileSync(join(process.cwd(), 'src/components/layout/DashboardLayout.tsx'), 'utf8');
  const model = readFileSync(join(process.cwd(), 'src/components/layout/launcher/sidebarNav.ts'), 'utf8');
  const source = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.tsx'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.module.css'), 'utf8');
  const allAgentPages = visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true);
  const pagesFor = (service: DashboardServiceDefinition) => visibleSubNavItems(SUBNAV_CONFIG[service.id], () => true, true);
  /** The opening tag of the element with this test id. */
  const tag = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

  it('nested style: the page under the service’s own name is not listed again under it (Agents › Agents)', () => {
    expect(SUBNAV_CONFIG.agents.filter((item) => item.sameAsService).map((item) => item.id)).toEqual(['list']);
    expect(SUBNAV_CONFIG.browser.filter((item) => item.sameAsService).map((item) => item.id)).toEqual(['browsers']);
    const html = sidebar({
      services: owner,
      activeService: agents,
      activeItems: allAgentPages,
      pathname: '/dashboard/agents',
      menuStyle: 'tree',
    });
    expect(html).not.toContain('data-testid="sidebar-subitem-list"');
    expect(html).toContain('data-testid="sidebar-subitem-tools"');
    expect(tag(html, 'sidebar-service-agents')).toContain('aria-current="page"');
  });

  it('nested style: one row is marked as the page; the service it is under is only named', () => {
    const html = sidebar({
      services: owner,
      activeService: agents,
      activeItems: allAgentPages,
      pathname: '/dashboard/agents/tools',
      menuStyle: 'tree',
    });
    expect(tag(html, 'sidebar-subitem-tools')).toContain('aria-current="page"');
    expect(tag(html, 'sidebar-service-agents')).toContain('aria-current="true"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it('step by step: the services first; one with several pages opens its level, one with a single page is a link', () => {
    const html = sidebar({ services: owner, pagesFor, settingsItems, menuStyle: 'drill', pathname: '/dashboard/overview' });
    expect(html).toContain('data-style="drill"');
    expect(html).toContain('data-testid="sidebar-level-root"');
    expect(html).toContain('data-testid="sidebar-category-build"');
    expect(html).not.toContain('data-testid="sidebar-group-');
    expect(tag(html, 'sidebar-service-agents')).toMatch(/^<button[^>]*data-opens="level"/);
    expect(tag(html, 'sidebar-service-files')).toMatch(/^<a\b/);
    expect(tag(html, 'sidebar-service-files')).toContain('href="/dashboard/files"');
    expect(tag(html, 'sidebar-settings')).toMatch(/^<button[^>]*data-opens="level"/);
    expect(html).not.toContain('data-testid="sidebar-subitem-');
    expect(html).not.toContain('data-testid="sidebar-back"');
  });

  it('step by step: opens at the level of the page in view, with the way back and "All {service}"', () => {
    const html = sidebar({
      services: owner,
      activeService: agents,
      activeItems: allAgentPages,
      pagesFor,
      menuStyle: 'drill',
      pathname: '/dashboard/agents/tools',
    });
    expect(html).toContain('data-testid="sidebar-level-agents"');
    expect(tag(html, 'sidebar-back')).toMatch(/^<button/);
    expect(html).toContain('Back to the main menu');
    expect(html).toMatch(/data-testid="sidebar-subitem-list"[^>]*>.*?<span[^>]*>All Agents<\/span>/);
    expect(tag(html, 'sidebar-subitem-tools')).toContain('aria-current="page"');
    expect(html).toContain('>Sessions<');
    expect(html).not.toContain('data-testid="sidebar-home"');
    expect(html).not.toContain('data-testid="sidebar-service-');
  });

  it('step by step: Settings is a level of its own while one of its pages is in view, in the viewer’s language', () => {
    const html = sidebar(
      { services: owner, settingsItems, settingsActive: true, menuStyle: 'drill', pathname: '/dashboard/projects', onTogglePin: () => undefined },
      'tr',
    );
    expect(html).toContain('data-testid="sidebar-level-settings"');
    expect(html).toContain('Ana menüye dön');
    expect(tag(html, 'sidebar-subitem-projects')).toContain('aria-current="page"');
    expect(html).not.toContain('data-testid="sidebar-level-pin"');
  });

  it('step by step with few services: one plain list, and a service’s level has its pin', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const first = sidebar({ services: member, pagesFor, menuStyle: 'drill', pathname: '/dashboard/overview' });
    expect(first).toContain('data-flat="true"');
    expect(first).not.toContain('data-testid="sidebar-category-');
    const level = sidebar({
      services: member,
      pagesFor,
      menuStyle: 'drill',
      activeService: agents,
      activeItems: allAgentPages,
      pinnedIds: new Set<string>(),
      onTogglePin: () => undefined,
      pathname: '/dashboard/agents/tools',
    });
    expect(level).toContain('data-testid="sidebar-level-agents"');
    expect(level).toContain('data-testid="sidebar-level-pin"');
  });

  it('the menu goes step by step; the nested style is kept behind one constant, and no choice is offered', () => {
    const html = sidebar({ services: owner, pagesFor });
    expect(html).toContain('data-style="drill"');
    expect(html).toContain('data-testid="sidebar-level-root"');
    expect(html).not.toContain('data-testid="sidebar-style');
    expect(sidebar({ services: owner, menuStyle: 'tree' })).toContain('data-style="tree"');
    expect(model).toContain("export const SIDEBAR_STYLE: SidebarStyle = 'drill';");
    expect(source).toContain('const style: SidebarStyle = menuStyle ?? SIDEBAR_STYLE;');
    expect(source).not.toContain('cgn:sidebar:style');
    // Both menus (the side one and the phone's drawer) get every service's pages, filtered like the one in view.
    expect(layout.match(/pagesFor=\{sidebarPagesFor\}/g) ?? []).toHaveLength(2);
    expect(layout).toMatch(/visibleSubNavItems\(SUBNAV_CONFIG\[service\.id\], \(permission\) => canUseService\(permission\), isTenantAdmin\)/);
  });

  it('a touch screen keeps no row "hovered" after a tap: every hover rule is for a pointer only', () => {
    const start = css.indexOf('@media (hover: hover) {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const outside = [...css.matchAll(/:hover/g)].filter((match) => match.index < start || match.index > end);
    expect(outside).toHaveLength(0);
    expect(css).toMatch(/@media \(hover: hover\) \{\s*\.item:hover/);
  });
});

describe('Reports in the menu', () => {
  const tag = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  const pagesFor = (service: DashboardServiceDefinition) => visibleSubNavItems(SUBNAV_CONFIG[service.id], () => true, true);

  it('the entries: the summary first, then the reports group by group under their headings; the summary’s own data is not one', () => {
    expect(reportItems.map((item) => item.id)).toEqual([
      'reports-summary',
      'report-cost-spend',
      'report-models',
      'report-agents',
      'report-guardrails',
    ]);
    expect(reportItems.map((item) => item.sectionKey)).toEqual([
      undefined,
      'reportsGroupUsage',
      undefined,
      'reportsGroupQuality',
      'reportsGroupSafety',
    ]);
    expect(reportItems[0]).toMatchObject({ href: '/dashboard/analytics', labelKey: 'reportsSummary' });
    expect(reportItems[1].href).toBe('/dashboard/analytics/cost-spend');
    const search = new URLSearchParams();
    expect(reportItems[0].matcher?.('/dashboard/analytics', search)).toBe(true);
    expect(reportItems[0].matcher?.('/dashboard/analytics/cost-spend', search)).toBe(false);
    expect(reportItems[1].matcher?.('/dashboard/analytics/cost-spend', search)).toBe(true);
    expect(isReportsPath('/dashboard/analytics/cost-spend')).toBe(true);
    expect(isReportsPath('/dashboard/analyticsx')).toBe(false);
  });

  it('an older reports API without groups: the reports as listed, without headings; none: no entries', () => {
    const ungrouped = reportsNavItems(
      listedReports.map((report) => ({ ...report, group: undefined })),
      (report) => report.title,
    );
    expect(ungrouped.map((item) => item.id)).toEqual([
      'reports-summary',
      'report-guardrails',
      'report-cost-spend',
      'report-agents',
      'report-models',
    ]);
    expect(ungrouped.some((item) => item.sectionKey)).toBe(false);
    expect(reportsNavItems([], (report) => report.title)).toEqual([]);
    expect(reportsNavItems([{ key: 'overview', title: 'Overview' }], (report) => report.title)).toEqual([]);
  });

  it('step by step: a row under Home that opens the reports’ own level; none without reports (community, no license)', () => {
    const first = sidebar({ services: owner, pagesFor, reportsItems: reportItems, pathname: '/dashboard/overview' });
    expect(tag(first, 'sidebar-reports')).toMatch(/^<button[^>]*data-opens="level"/);
    expect(first.indexOf('data-testid="sidebar-reports"')).toBeGreaterThan(first.indexOf('data-testid="sidebar-home"'));
    expect(first.indexOf('data-testid="sidebar-reports"')).toBeLessThan(first.indexOf('data-testid="sidebar-category-build"'));
    expect(sidebar({ services: owner, pagesFor, pathname: '/dashboard/overview' })).not.toContain('data-testid="sidebar-reports"');
    const member = memberServices(['agents', 'prompts', 'rag']);
    expect(sidebar({ services: member, pagesFor, reportsItems: reportItems })).toContain('data-testid="sidebar-reports"');
  });

  it('step by step: a report in view opens the reports’ level, marks it, and names its group', () => {
    const html = sidebar({
      services: owner,
      pagesFor,
      reportsItems: reportItems,
      reportsActive: true,
      pathname: '/dashboard/analytics/cost-spend',
    });
    expect(html).toContain('data-testid="sidebar-level-reports"');
    expect(html).toContain('data-testid="sidebar-back"');
    expect(tag(html, 'sidebar-subitem-report-cost-spend')).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('>Usage &amp; cost<');
    expect(html).toContain('>Summary<');
    const tr = sidebar(
      { services: owner, pagesFor, reportsItems: reportItems, reportsActive: true, pathname: '/dashboard/analytics' },
      'tr',
    );
    expect(tr).toContain('>Raporlar<');
    expect(tr).toContain('>Özet<');
    expect(tr).toContain('>Kullanım ve maliyet<');
  });

  it('nested style: Reports is a link under Home that shows its reports while one is in view', () => {
    const closed = sidebar({ services: owner, menuStyle: 'tree', reportsItems: reportItems, pathname: '/dashboard/agents' });
    expect(tag(closed, 'sidebar-reports')).toMatch(/^<a\b[^>]*href="\/dashboard\/analytics"/);
    expect(closed).not.toContain('data-testid="sidebar-subitem-report-');
    const open = sidebar({
      services: owner,
      menuStyle: 'tree',
      reportsItems: reportItems,
      reportsActive: true,
      pathname: '/dashboard/analytics/agents',
    });
    expect(tag(open, 'sidebar-subitem-report-agents')).toContain('aria-current="page"');
    expect(tag(open, 'sidebar-reports')).toContain('aria-current="true"');
  });

  it('the icon strip: Home, Reports, then every service with a line between categories', () => {
    media.narrow = true;
    try {
      const html = sidebar({ services: owner, reportsItems: reportItems, pathname: '/dashboard/overview' });
      expect(html).toContain('data-collapsed="true"');
      expect(html).toContain('data-testid="sidebar-reports"');
      for (const service of sidebarServices(owner)) {
        expect(html).toContain(`data-testid="sidebar-service-${service.id}"`);
      }
      expect(html.match(/data-testid="sidebar-service-/g)).toHaveLength(sidebarServices(owner).length);
      const member = memberServices(['agents', 'prompts', 'rag']);
      const few = sidebar({ services: member, pathname: '/dashboard/overview' });
      expect(few.match(/data-testid="sidebar-service-/g)).toHaveLength(3);
      expect(few).not.toContain('data-testid="sidebar-reports"');
    } finally {
      media.narrow = false;
    }
  });

  it('the shell asks for the reports only with the single menu, and passes them to both menus', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/DashboardLayout.tsx'), 'utf8');
    expect(layout).toContain('const reportsItems = useReportsNav(SIDEBAR_NAV);');
    expect(layout).toContain('const reportsActive = isReportsPath(pathname);');
    expect(layout.match(/reportsItems=\{reportsItems\}/g) ?? []).toHaveLength(2);
  });
});

describe('Favorites: pinned from the menu', () => {
  const tag = (html: string, testId: string) => html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
  const pagesFor = (service: DashboardServiceDefinition) => visibleSubNavItems(SUBNAV_CONFIG[service.id], () => true, true);
  const allAgentPages = visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true);
  const onTogglePin = () => undefined;
  const at = (html: string, testId: string) => html.indexOf(`data-testid="${testId}"`);

  it('every service row has a pin named for its service, beside the row (a level’s arrow stays at the edge); nothing pinned, no Favorites', () => {
    const html = sidebar({ services: owner, pagesFor, pinnedIds: new Set(), onTogglePin, pathname: '/dashboard/overview' });
    for (const service of sidebarServices(owner)) {
      expect(html).toContain(`data-testid="sidebar-pin-${service.id}"`);
    }
    expect(tag(html, 'sidebar-pin-agents')).toContain('aria-label="Add Agents to Favorites"');
    expect(tag(html, 'sidebar-pin-agents')).toContain('aria-pressed="false"');
    // Agents opens its level: the pin follows that button (a button cannot hold another), before the arrow.
    expect(tag(html, 'sidebar-pin-agents')).toMatch(/class="[^"]*pinBeforeArrow/);
    expect(html).toMatch(/data-testid="sidebar-service-agents"[\s\S]*?<\/button><button[^>]*data-testid="sidebar-pin-agents"/);
    // Files is a plain link: its pin follows the link.
    expect(html).toMatch(/data-testid="sidebar-service-files"[\s\S]*?<\/a><button[^>]*data-testid="sidebar-pin-files"/);
    expect(html).not.toContain('data-testid="sidebar-favorites"');
  });

  it('under Home and Reports, above the categories, in the order pinned: links to the service, each with its pin shown', () => {
    const html = sidebar({
      services: owner,
      pagesFor,
      reportsItems: reportItems,
      pinnedIds: new Set(['rag', 'agents']),
      onTogglePin,
      pathname: '/dashboard/overview',
    });
    expect(at(html, 'sidebar-favorites')).toBeGreaterThan(at(html, 'sidebar-reports'));
    expect(at(html, 'sidebar-favorites')).toBeLessThan(at(html, 'sidebar-category-build'));
    expect(html).toContain('>Favorites<');
    expect(at(html, 'sidebar-favorite-rag')).toBeLessThan(at(html, 'sidebar-favorite-agents'));
    // A shortcut to the service's page, although Agents opens a level in the list below, where it keeps its row.
    expect(tag(html, 'sidebar-favorite-agents')).toMatch(new RegExp(`^<a\\b[^>]*href="${agents.href}"`));
    expect(tag(html, 'sidebar-service-agents')).toMatch(/^<button[^>]*data-opens="level"/);
    expect(tag(html, 'sidebar-pin-favorite-agents')).toContain('aria-label="Remove Agents from Favorites"');
    expect(tag(html, 'sidebar-pin-favorite-agents')).toContain('aria-pressed="true"');
    expect(tag(html, 'sidebar-pin-favorite-agents')).toMatch(/class="[^"]*pinStay/);
    expect(tag(html, 'sidebar-pin-agents')).toContain('aria-pressed="true"');
    expect(tag(html, 'sidebar-pin-models')).toContain('aria-pressed="false"');
    // Without Reports (community, no license) Favorites follow Home.
    const noReports = sidebar({ services: owner, pagesFor, pinnedIds: new Set(['rag']), onTogglePin, pathname: '/dashboard/overview' });
    expect(at(noReports, 'sidebar-favorites')).toBeGreaterThan(at(noReports, 'sidebar-home'));
    expect(at(noReports, 'sidebar-favorites')).toBeLessThan(at(noReports, 'sidebar-category-build'));
  });

  it('a pin for a service the person cannot open (any more) is left out', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const html = sidebar({ services: member, pagesFor, pinnedIds: new Set(['models', 'agents', 'gone']), onTogglePin });
    expect(html).toContain('data-testid="sidebar-favorite-agents"');
    expect(html).not.toContain('data-testid="sidebar-favorite-models"');
    expect(html).not.toContain('data-testid="sidebar-favorite-gone"');
    expect(html.match(/data-testid="sidebar-favorite-/g)).toHaveLength(1);
  });

  it('a favorite in view is only named: the service’s own row (or its page) is the one marked', () => {
    const files = findDashboardService('files')!;
    const drill = sidebar({
      services: owner,
      pagesFor,
      activeService: files,
      activeItems: SUBNAV_CONFIG.files,
      pinnedIds: new Set(['files']),
      onTogglePin,
      pathname: '/dashboard/files',
    });
    expect(tag(drill, 'sidebar-favorite-files')).toContain('aria-current="true"');
    expect(tag(drill, 'sidebar-service-files')).toContain('aria-current="page"');
    expect(drill.match(/aria-current="page"/g)).toHaveLength(1);
    const tree = sidebar({
      services: owner,
      menuStyle: 'tree',
      activeService: agents,
      activeItems: allAgentPages,
      pinnedIds: new Set(['agents']),
      onTogglePin,
      pathname: '/dashboard/agents/tools',
    });
    expect(tag(tree, 'sidebar-favorite-agents')).toContain('aria-current="true"');
    expect(tag(tree, 'sidebar-subitem-tools')).toContain('aria-current="page"');
    expect(tree.match(/aria-current="page"/g)).toHaveLength(1);
    // The pages open under the service's own row only.
    expect(tree.match(/data-testid="sidebar-subitem-tools"/g)).toHaveLength(1);
  });

  it('a service’s level has its pin beside the way back, side menu and drawer; Reports and Settings have none', () => {
    for (const variant of ['side', 'drawer'] as const) {
      const props = {
        services: owner,
        pagesFor,
        variant,
        activeService: agents,
        activeItems: allAgentPages,
        onTogglePin,
        pathname: '/dashboard/agents/tools',
      };
      const unpinned = sidebar({ ...props, pinnedIds: new Set<string>() });
      expect(unpinned).toMatch(/data-testid="sidebar-back"[\s\S]*?<\/button><button[^>]*data-testid="sidebar-level-pin"/);
      expect(tag(unpinned, 'sidebar-level-pin')).toContain('aria-label="Add Agents to Favorites"');
      expect(tag(unpinned, 'sidebar-level-pin')).toContain('aria-pressed="false"');
      const pinned = sidebar({ ...props, pinnedIds: new Set(['agents']) });
      expect(tag(pinned, 'sidebar-level-pin')).toContain('aria-label="Remove Agents from Favorites"');
      expect(tag(pinned, 'sidebar-level-pin')).toContain('aria-pressed="true"');
      // A level shows its pages only: Favorites are on the first level.
      expect(pinned).not.toContain('data-testid="sidebar-favorites"');
    }
    const reports = sidebar({
      services: owner,
      pagesFor,
      reportsItems: reportItems,
      reportsActive: true,
      onTogglePin,
      pathname: '/dashboard/analytics/cost-spend',
    });
    expect(reports).toContain('data-testid="sidebar-level-reports"');
    expect(reports).not.toContain('data-testid="sidebar-level-pin"');
  });

  it('nested style and the phone’s drawer: the same Favorites under Home and Reports, and a pin on every service row', () => {
    for (const props of [{ menuStyle: 'tree' as const }, { variant: 'drawer' as const }]) {
      const html = sidebar({
        services: owner,
        pagesFor,
        reportsItems: reportItems,
        pinnedIds: new Set(['agents']),
        onTogglePin,
        pathname: '/dashboard/overview',
        ...props,
      });
      expect(at(html, 'sidebar-favorites')).toBeGreaterThan(at(html, 'sidebar-reports'));
      expect(html).toContain('data-testid="sidebar-favorite-agents"');
      const rows = [...html.matchAll(/data-testid="sidebar-service-([\w-]+)"/g)].map((match) => match[1]);
      expect(rows.length).toBeGreaterThan(0);
      for (const id of rows) expect(html).toContain(`data-testid="sidebar-pin-${id}"`);
    }
  });

  it('the icon strip: the favorites after Home and Reports, before the services, without pins', () => {
    media.narrow = true;
    try {
      const html = sidebar({
        services: owner,
        reportsItems: reportItems,
        pinnedIds: new Set(['rag', 'agents']),
        onTogglePin,
        pathname: '/dashboard/overview',
      });
      expect(html).toContain('data-collapsed="true"');
      expect(at(html, 'sidebar-favorite-rag')).toBeGreaterThan(at(html, 'sidebar-reports'));
      expect(at(html, 'sidebar-favorite-rag')).toBeLessThan(at(html, 'sidebar-favorite-agents'));
      expect(at(html, 'sidebar-favorite-agents')).toBeLessThan(html.indexOf('data-testid="sidebar-service-'));
      expect(html).not.toContain('data-testid="sidebar-pin-');
      // The services keep their one icon each.
      expect(html.match(/data-testid="sidebar-service-/g)).toHaveLength(sidebarServices(owner).length);
    } finally {
      media.narrow = false;
    }
  });

  it('speaks the viewer’s language', () => {
    const trNav = tr.navigation as Record<string, string>;
    const label = trNav[agents.navLabelKey];
    expect(label).toBeTruthy();
    const html = sidebar({ services: owner, pagesFor, pinnedIds: new Set(['agents']), onTogglePin, pathname: '/dashboard/overview' }, 'tr');
    expect(html).toContain('>Favoriler<');
    expect(tag(html, 'sidebar-pin-favorite-agents')).toContain(`aria-label="Favorilerden çıkar: ${label}"`);
    expect(tag(html, 'sidebar-pin-models')).toContain('aria-label="Favorilere ekle: ');
  });

  it('a pointer shows a row’s pin on hover or keyboard focus; a touch screen always, with room to tap it', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/layout/launcher/Sidebar.module.css'), 'utf8');
    expect(css).toMatch(/\.pin \{[^}]*opacity: 0;/);
    expect(css).toMatch(/\.pin:focus-visible,\s*\.pinStay \{\s*opacity: 1;/);
    expect(css).toMatch(/@media \(hover: hover\) \{[\s\S]*?\.row:hover \.pin \{\s*opacity: 1;/);
    const touch = css.slice(css.indexOf('@media (hover: none) {'));
    expect(css.indexOf('@media (hover: none) {')).toBeGreaterThan(-1);
    expect(touch).toMatch(/^@media \(hover: none\) \{\s*\.pin \{\s*opacity: 1;\s*width: 32px;\s*height: 32px;/);
  });

  it('the shell: Favorites start empty with the single menu (the rail keeps its defaults), and both menus get the pins', () => {
    const layout = readFileSync(join(process.cwd(), 'src/components/layout/DashboardLayout.tsx'), 'utf8');
    expect(layout).toMatch(/SIDEBAR_NAV\s*\?\s*\[\]\s*:\s*allowedServices\s*\.filter\(\s*\(svc\) => svc\.defaultPinned/);
    expect(layout).toContain('useLauncherState(defaultPinnedIds)');
    const handed = layout.match(/pinnedIds=\{pinned\}\s+(?:\/\/[^\n]*\n\s*)?onTogglePin=\{hydrated \? togglePin : undefined\}/g) ?? [];
    expect(handed).toHaveLength(2);
    expect(layout).toMatch(/<Sidebar\s+variant="drawer"[\s\S]*?pinnedIds=\{pinned\}/);
  });
});
