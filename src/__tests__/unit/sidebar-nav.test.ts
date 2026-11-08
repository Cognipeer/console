/**
 * The single left menu: one labelled column instead of the icon rail plus the service sub-nav. It lists only what the
 * person can open, under the launcher's categories (Build, Data, Operate; an empty one is left out), and goes step by
 * step: a service's pages (filtered like the sub-nav) and Settings' grouped pages are levels of their own. The nested
 * style is kept behind SIDEBAR_STYLE. Someone with seven services or fewer gets one plain list, without categories,
 * pins or the launcher. SIDEBAR_NAV switches back to the rail and the sub-nav, which are kept. A phone gets the same
 * menu in the top bar's drawer.
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
      pinnedIds: new Set<string>(),
      onTogglePin: () => undefined,
      onHelpClick: () => undefined,
      pathname: '/dashboard/agents',
      ...props,
    }),
    locale,
  );
}

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
  it('nested style, many services: pinned, categories with counts, and the pages of the service in view', () => {
    const activeItems = visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true);
    const html = sidebar({
      services: owner,
      activeService: agents,
      activeItems,
      pinnedIds: new Set(['models', 'agents']),
      menuStyle: 'tree',
    });
    expect(html).toContain('data-testid="sidebar-pinned"');
    expect(html).toContain('data-testid="sidebar-pinned-models"');
    for (const group of sidebarGroups(owner)) {
      expect(html).toContain(`data-testid="sidebar-group-${group.category}"`);
    }
    expect(html).toMatch(/data-testid="sidebar-group-build"[^>]*>.*?<span[^>]*>Build<\/span><span[^>]*>7<\/span>/);
    expect(html).toContain('data-testid="sidebar-subitem-tools"');
    expect(html).toContain('data-testid="sidebar-subitem-webhooks"');
    expect(html).toContain('aria-label="Unpin Agent');
    expect(html).toContain('aria-label="Pin Prompt Studio"');
  });

  it('a page the person cannot use is not offered under its service (Webhooks without the Webhooks service)', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const activeItems = visibleSubNavItems(SUBNAV_CONFIG.agents, (service) => service !== 'webhooks', false);
    const html = sidebar({ services: member, activeService: agents, activeItems });
    expect(html).toContain('data-testid="sidebar-subitem-tools"');
    expect(html).not.toContain('data-testid="sidebar-subitem-webhooks"');
  });

  it('for few services: one plain list, no categories, no pins', () => {
    const member = memberServices(['agents', 'prompts', 'rag']);
    const html = sidebar({ services: member, pinnedIds: new Set(['agents']) });
    expect(html).toContain('data-flat="true"');
    expect(html).not.toContain('data-testid="sidebar-group-');
    expect(html).not.toContain('data-testid="sidebar-pinned"');
    expect(html).not.toContain('aria-label="Pin ');
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
    expect(sidebar({ services: owner, menuStyle: 'tree' }, 'tr')).toContain('Tüm servisler');
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
    // No hover on a touch screen: the pin stays shown instead of waiting to be tapped unseen.
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.pin \{\s*opacity: 1;/);
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

  it('with few services the top bar leaves out the launcher', () => {
    expect(layout).toContain('hideLauncher={SIDEBAR_NAV && isFlatSidebar(allowedServices)}');
    expect(topbar).toContain('{hideLauncher ? null : (');
  });

  it('has its words in both languages, with the same placeholders', () => {
    const keys = [
      'sidebarLabel', 'sidebarHome', 'sidebarPinned', 'sidebarAllServices', 'sidebarHelp', 'sidebarCollapse',
      'sidebarExpand', 'sidebarPin', 'sidebarUnpin', 'sidebarBack', 'sidebarAllOf',
    ] as const;
    const enNav = en.navigation as Record<string, string>;
    const trNav = tr.navigation as Record<string, string>;
    for (const key of keys) {
      expect(enNav[key], key).toBeTruthy();
      expect(trNav[key], key).toBeTruthy();
      expect(trNav[key], key).not.toBe(enNav[key]);
      expect(trNav[key].match(/\{\w+\}/g) ?? [], key).toEqual(enNav[key].match(/\{\w+\}/g) ?? []);
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

  it('nested style: one row is marked as the page; the service and its pinned shortcut are only named', () => {
    const html = sidebar({
      services: owner,
      activeService: agents,
      activeItems: allAgentPages,
      pathname: '/dashboard/agents/tools',
      pinnedIds: new Set(['agents']),
      menuStyle: 'tree',
    });
    expect(tag(html, 'sidebar-subitem-tools')).toContain('aria-current="page"');
    expect(tag(html, 'sidebar-service-agents')).toContain('aria-current="true"');
    expect(tag(html, 'sidebar-pinned-agents')).toContain('aria-current="true"');
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

  it('step by step: opens at the level of the page in view, with the way back, its pin and "All {service}"', () => {
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
    expect(html).toContain('data-testid="sidebar-level-pin"');
    expect(html).toMatch(/data-testid="sidebar-subitem-list"[^>]*>.*?<span[^>]*>All Agents<\/span>/);
    expect(tag(html, 'sidebar-subitem-tools')).toContain('aria-current="page"');
    expect(html).toContain('>Sessions<');
    expect(html).not.toContain('data-testid="sidebar-home"');
    expect(html).not.toContain('data-testid="sidebar-service-');
  });

  it('step by step: Settings is a level of its own while one of its pages is in view, in the viewer’s language', () => {
    const html = sidebar(
      { services: owner, settingsItems, settingsActive: true, menuStyle: 'drill', pathname: '/dashboard/projects' },
      'tr',
    );
    expect(html).toContain('data-testid="sidebar-level-settings"');
    expect(html).toContain('Ana menüye dön');
    expect(tag(html, 'sidebar-subitem-projects')).toContain('aria-current="page"');
    expect(html).not.toContain('data-testid="sidebar-level-pin"');
  });

  it('step by step with few services: one plain list, and no pin on a service’s level', () => {
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
      pathname: '/dashboard/agents/tools',
    });
    expect(level).toContain('data-testid="sidebar-level-agents"');
    expect(level).not.toContain('data-testid="sidebar-level-pin"');
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
