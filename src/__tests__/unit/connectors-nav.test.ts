// @vitest-environment jsdom
/**
 * The Connectors sub-nav: Catalog and Installed, then a "Settings" group with
 * OAuth apps for tenant owners and admins only. One entry is current on every
 * page (a connector's own page stays with Installed), on the desktop nav and in
 * the phone drawer, in the viewer's language; the breadcrumb leaves the static
 * pages alone, and the palette finds Catalog and OAuth apps by name.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { IconKey, IconLayoutGrid, IconPlugConnected } from '@tabler/icons-react';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/dashboard/connectors',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import ServiceSubNav, { SUBNAV_CONFIG, visibleSubNavItems } from '@/components/layout/launcher/ServiceSubNav';
import MobileNavDrawer from '@/components/layout/launcher/MobileNavDrawer';
import { BREADCRUMB_RESOLVERS } from '@/components/layout/breadcrumbResolvers';
import { DASHBOARD_SUBPAGES, findDashboardService } from '@/lib/utils/dashboardServices';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const connectors = findDashboardService('connectors')!;
const items = SUBNAV_CONFIG.connectors;
const item = (id: string) => items.find((entry) => entry.id === id)!;
const CONNECTOR_ID = '66f1c0de5e1a2b3c4d5e6f70';

/** The ids of the Connectors sub-nav entries that call `pathname` theirs. */
const activeAt = (pathname: string) => {
  const params = new URLSearchParams('');
  return items.filter((entry) => (entry.matcher ? entry.matcher(pathname, params) : pathname === entry.href)).map((entry) => entry.id);
};
const anchor = (html: string, href: string) => (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));
const headings = (html: string, text: string) => (html.match(new RegExp(`>${text}<`, 'g')) ?? []).length;

const desktopNav = (pathname: string, shown = items, locale: 'en' | 'tr' = 'en') =>
  render(h(ServiceSubNav, { service: connectors, pathname, isPinned: false, onTogglePin: noop, onOpenDocs: noop, items: shown }), locale);
const mobileNav = (pathname: string, shown = items, locale: 'en' | 'tr' = 'en') =>
  render(
    h(MobileNavDrawer, {
      open: true,
      onClose: noop,
      pathname,
      pinned: [],
      recents: [],
      activeService: connectors,
      onOpenLauncher: noop,
      onOpenDocs: noop,
      subnavOverride: { title: 'Connectors', items: shown },
      settingsHref: '/dashboard/settings',
      settingsActive: false,
    }),
    locale,
  );

beforeEach(() => {
  nav.search = '';
});

describe('the Connectors sub-nav entries', () => {
  it('are Catalog, Installed, then OAuth apps starting the Settings group', () => {
    expect(items.map((entry) => entry.id)).toEqual(['catalog', 'installed', 'oauth-apps']);
    expect(item('catalog')).toMatchObject({ labelKey: 'connectorsCatalog', href: '/dashboard/connectors/catalog', icon: IconLayoutGrid });
    expect(item('installed')).toMatchObject({ labelKey: 'connectorsInstalled', href: '/dashboard/connectors', icon: IconPlugConnected });
    expect(item('oauth-apps')).toMatchObject({
      labelKey: 'connectorsOauthApps',
      sectionKey: 'connectorsSettings',
      href: '/dashboard/connectors/oauth-apps',
      icon: IconKey,
      tenantAdminOnly: true,
    });
    expect(items.filter((entry) => entry.sectionKey).map((entry) => entry.id)).toEqual(['oauth-apps']);
  });

  it('mark exactly one entry active on each page of the section', () => {
    expect(activeAt('/dashboard/connectors')).toEqual(['installed']);
    expect(activeAt('/dashboard/connectors/catalog')).toEqual(['catalog']);
    expect(activeAt('/dashboard/connectors/oauth-apps')).toEqual(['oauth-apps']);
    // a connector's own page stays with the installed list
    expect(activeAt(`/dashboard/connectors/${CONNECTOR_ID}`)).toEqual(['installed']);
  });

  it('are all owned by the connectors service', () => {
    expect(connectors.href).toBe('/dashboard/connectors');
    for (const entry of items) expect(entry.href.startsWith(connectors.href)).toBe(true);
  });
});

describe('visibleSubNavItems and the tenant-admin flag', () => {
  it('hides OAuth apps from someone who is not an owner or admin', () => {
    expect(visibleSubNavItems(items, () => true, false)!.map((entry) => entry.id)).toEqual(['catalog', 'installed']);
    expect(visibleSubNavItems(items, () => true, true)!.map((entry) => entry.id)).toEqual(['catalog', 'installed', 'oauth-apps']);
  });

  it('keeps the two-argument call as it was', () => {
    expect(visibleSubNavItems(items, () => true)!.map((entry) => entry.id)).toEqual(['catalog', 'installed', 'oauth-apps']);
    expect(visibleSubNavItems(undefined, () => true, false)).toBeUndefined();
  });

  it('judges both flags together', () => {
    const both = [{ ...item('oauth-apps'), requiresService: 'rag' as const }];
    expect(visibleSubNavItems(both, () => true, true)).toHaveLength(1);
    expect(visibleSubNavItems(both, () => false, true)).toHaveLength(0);
    expect(visibleSubNavItems(both, () => true, false)).toHaveLength(0);
  });
});

describe('the sub-nav as drawn', () => {
  it('shows Catalog, Installed, then the Settings heading above OAuth apps, in the viewer’s language', () => {
    const en = desktopNav('/dashboard/connectors');
    expect(headings(en, 'Settings')).toBe(1);
    expect(en.indexOf('>Catalog<')).toBeLessThan(en.indexOf('>Installed<'));
    expect(en.indexOf('>Installed<')).toBeLessThan(en.indexOf('>Settings<'));
    expect(en.indexOf('>Settings<')).toBeLessThan(en.indexOf('>OAuth apps<'));

    const tr = desktopNav('/dashboard/connectors', items, 'tr');
    expect(tr.indexOf('>Katalog<')).toBeLessThan(tr.indexOf('>Kurulu<'));
    expect(tr.indexOf('>Kurulu<')).toBeLessThan(tr.indexOf('>Ayarlar<'));
    expect(tr.indexOf('>Ayarlar<')).toBeLessThan(tr.indexOf('>OAuth uygulamaları<'));
    expect(headings(tr, 'Catalog')).toBe(0);
  });

  it('draws no OAuth apps link and no Settings heading for a non-admin', () => {
    const shown = visibleSubNavItems(items, () => true, false)!;
    const en = desktopNav('/dashboard/connectors', shown);
    expect(anchor(en, '/dashboard/connectors/oauth-apps')).toBeUndefined();
    expect(headings(en, 'Settings')).toBe(0);
    expect(anchor(en, '/dashboard/connectors/catalog')).toBeDefined();
  });

  it('marks the link of the open page as current, and only that one', () => {
    const catalog = desktopNav('/dashboard/connectors/catalog');
    expect(anchor(catalog, '/dashboard/connectors/catalog')).toContain('aria-current="page"');
    expect(anchor(catalog, '/dashboard/connectors')).not.toContain('aria-current');
    expect(anchor(catalog, '/dashboard/connectors/oauth-apps')).not.toContain('aria-current');

    const detail = desktopNav(`/dashboard/connectors/${CONNECTOR_ID}`);
    expect(anchor(detail, '/dashboard/connectors')).toContain('aria-current="page"');
    expect(anchor(detail, '/dashboard/connectors/catalog')).not.toContain('aria-current');

    const apps = desktopNav('/dashboard/connectors/oauth-apps');
    expect(anchor(apps, '/dashboard/connectors/oauth-apps')).toContain('aria-current="page"');
    expect(anchor(apps, '/dashboard/connectors')).not.toContain('aria-current');
  });

  it('is the same in the phone drawer', () => {
    const en = mobileNav('/dashboard/connectors/catalog');
    // the drawer has a Settings link of its own: the group heading is the one more, above OAuth apps
    const withoutGroup = headings(mobileNav('/dashboard/connectors/catalog', visibleSubNavItems(items, () => true, false)!), 'Settings');
    expect(headings(en, 'Settings')).toBe(withoutGroup + 1);
    expect(en.indexOf('>Catalog<')).toBeLessThan(en.indexOf('>Installed<'));
    expect(anchor(en, '/dashboard/connectors/catalog')).toContain('aria-current="page"');
    expect(anchor(en, '/dashboard/connectors')).not.toContain('aria-current');

    const tr = mobileNav('/dashboard/connectors/oauth-apps', items, 'tr');
    expect(tr.indexOf('>Ayarlar<')).toBeGreaterThan(-1);
    expect(tr.indexOf('>OAuth uygulamaları<')).toBeGreaterThan(-1);
    expect(anchor(tr, '/dashboard/connectors/oauth-apps')).toContain('aria-current="page"');
  });

  it('leaves OAuth apps out of the phone drawer for a non-admin', () => {
    const shown = visibleSubNavItems(items, () => true, false)!;
    const en = mobileNav('/dashboard/connectors', shown);
    expect(anchor(en, '/dashboard/connectors/oauth-apps')).toBeUndefined();
    expect(en).not.toContain('OAuth apps');
  });
});

describe('the command palette pages of Connectors', () => {
  it('list Catalog and OAuth apps under the connectors service', () => {
    const pages = DASHBOARD_SUBPAGES.filter((page) => page.parent === 'connectors');
    expect(pages.map((page) => [page.href, page.navLabelKey, page.service])).toEqual([
      ['/dashboard/connectors/catalog', 'connectorsCatalog', 'connectors'],
      ['/dashboard/connectors/oauth-apps', 'connectorsOauthApps', 'connectors'],
    ]);
  });
});

describe('the breadcrumb of the Connectors pages', () => {
  it('does not ask for a connector called "catalog" or "oauth-apps"', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      fetched.push(String(input));
      return { ok: true, status: 200, json: async () => ({ connector: { name: 'Should not be used' } }) };
    });
    try {
      const resolver = BREADCRUMB_RESOLVERS.find((entry) => entry.id === 'standard:connectors')!;
      const ctx = (path: string) => ({ segments: path.split('/').filter(Boolean), cache: new Map<string, string>() });
      expect(await resolver.resolve(ctx('/dashboard/connectors/catalog'))).toEqual([]);
      expect(await resolver.resolve(ctx('/dashboard/connectors/oauth-apps'))).toEqual([]);
      expect(fetched).toEqual([]);
      // a real connector id is still named
      expect(await resolver.resolve(ctx(`/dashboard/connectors/${CONNECTOR_ID}`))).toEqual([{ index: 2, label: 'Should not be used' }]);
      expect(fetched).toEqual([`/api/connectors/${CONNECTOR_ID}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
