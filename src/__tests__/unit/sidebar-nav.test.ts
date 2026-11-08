/**
 * The single left menu: one labelled column instead of the icon rail plus the service sub-nav. It lists only what the
 * person can open, under the launcher's categories (Build, Data, Operate; an empty one is left out), opens the pages of
 * the service in view in place (filtered like the sub-nav), and Settings with its grouped pages. Someone with seven
 * services or fewer gets one plain list, without categories, pins or the launcher. SIDEBAR_NAV switches back to the
 * rail and the sub-nav, which are kept. A phone gets the same menu in the top bar's drawer.
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
  it('for many services: pinned, categories with counts, and the pages of the service in view', () => {
    const activeItems = visibleSubNavItems(SUBNAV_CONFIG.agents, () => true, true);
    const html = sidebar({ services: owner, activeService: agents, activeItems, pinnedIds: new Set(['models', 'agents']) });
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
    expect(html).toContain('Tüm servisler');
    expect(html).toContain('Menüyü daralt');
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
      const html = sidebar({ services: owner, variant: 'drawer', activeService: agents, activeItems: SUBNAV_CONFIG.agents, settingsItems });
      expect(html).toContain('data-testid="sidebar-drawer"');
      expect(html).not.toContain('data-collapsed="true"');
      expect(html).toContain('data-testid="sidebar-group-build"');
      expect(html).toContain(`data-testid="sidebar-subitem-${SUBNAV_CONFIG.agents[0].id}"`);
      expect(html).toContain('data-testid="sidebar-settings"');
      expect(html).toContain('data-testid="sidebar-help"');
      expect(html).not.toContain('data-testid="sidebar-toggle"');
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
    const keys = ['sidebarLabel', 'sidebarHome', 'sidebarPinned', 'sidebarAllServices', 'sidebarHelp', 'sidebarCollapse', 'sidebarExpand', 'sidebarPin', 'sidebarUnpin'] as const;
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
