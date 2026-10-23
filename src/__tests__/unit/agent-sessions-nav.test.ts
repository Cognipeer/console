// @vitest-environment jsdom
/**
 * The Sessions group of the Agents sub-nav: Active and All under a "Sessions"
 * heading (drawn by the item that starts the group, in the viewer's language,
 * on the desktop nav and in the phone drawer), one entry current on every path,
 * and the breadcrumb leaving `sessions` alone instead of asking for an agent
 * with that id.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { IconActivity, IconMessages } from '@tabler/icons-react';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/dashboard/agents/sessions',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import ServiceSubNav, { SUBNAV_CONFIG } from '@/components/layout/launcher/ServiceSubNav';
import MobileNavDrawer from '@/components/layout/launcher/MobileNavDrawer';
import { BREADCRUMB_RESOLVERS } from '@/components/layout/breadcrumbResolvers';
import { findDashboardService } from '@/lib/utils/dashboardServices';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

const agents = findDashboardService('agents')!;
const agentItems = SUBNAV_CONFIG.agents;
const item = (id: string) => agentItems.find((entry) => entry.id === id)!;
/** The ids of the Agents sub-nav entries that call `pathname` (with `query`) theirs. */
const activeAt = (pathname: string, query = '') => {
  const params = new URLSearchParams(query);
  return agentItems.filter((entry) => (entry.matcher ? entry.matcher(pathname, params) : pathname === entry.href)).map((entry) => entry.id);
};
const anchor = (html: string, href: string) => (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));

const desktopNav = (pathname: string, query = '', locale: 'en' | 'tr' = 'en') => {
  nav.search = query;
  return render(h(ServiceSubNav, { service: agents, pathname, isPinned: false, onTogglePin: noop, onOpenDocs: noop }), locale);
};
const mobileNav = (pathname: string, query = '', locale: 'en' | 'tr' = 'en') => {
  nav.search = query;
  return render(
    h(MobileNavDrawer, {
      open: true,
      onClose: noop,
      pathname,
      pinned: [],
      recents: [],
      activeService: agents,
      onOpenLauncher: noop,
      onOpenDocs: noop,
      settingsHref: '/dashboard/settings',
      settingsActive: false,
    }),
    locale,
  );
};
/** How many times `text` appears as the whole content of an element. */
const headings = (html: string, text: string) => (html.match(new RegExp(`>${text}<`, 'g')) ?? []).length;

beforeEach(() => {
  nav.search = '';
});

describe('the Sessions entries of the Agents sub-nav', () => {
  it('sit after Webhooks; Active starts the group, All continues it', () => {
    expect(item('sessions-active')).toMatchObject({
      label: 'Active',
      labelKey: 'agentSessionsActive',
      sectionKey: 'agentSessions',
      href: '/dashboard/agents/sessions?view=active',
      icon: IconActivity,
    });
    expect(item('sessions-all')).toMatchObject({
      label: 'All',
      labelKey: 'agentSessionsAll',
      href: '/dashboard/agents/sessions',
      icon: IconMessages,
    });
    expect(item('sessions-all').sectionKey).toBeUndefined();
    expect(agentItems.filter((entry) => entry.sectionKey).map((entry) => entry.id)).toEqual(['sessions-active']);
    expect(agentItems.map((entry) => entry.id).slice(-2)).toEqual(['sessions-active', 'sessions-all']);
  });

  it('marks exactly one entry active on each page of the section', () => {
    expect(activeAt('/dashboard/agents/sessions')).toEqual(['sessions-all']);
    expect(activeAt('/dashboard/agents/sessions', 'view=all')).toEqual(['sessions-all']);
    expect(activeAt('/dashboard/agents/sessions', 'view=active')).toEqual(['sessions-active']);
    // an agent's own session pages are the agent's: they stay with the list
    expect(activeAt('/dashboard/agents/64f0c0ffee/sessions/s1')).toEqual(['list']);
    expect(activeAt('/dashboard/agents/64f0c0ffee')).toEqual(['list']);
    expect(activeAt('/dashboard/agents')).toEqual(['list']);
    expect(activeAt('/dashboard/agents/webhooks')).toEqual(['webhooks']);
    expect(activeAt('/dashboard/agents/channels')).toEqual(['channels']);
    expect(activeAt('/dashboard/agents/channels/64f0c0ffee')).toEqual(['channels']);
    expect(activeAt('/dashboard/agents/tools')).toEqual(['tools']);
    expect(activeAt('/dashboard/agents/skills')).toEqual(['skills']);
  });
});

describe('the sub-nav as drawn', () => {
  it('shows the heading once, above Active, in the viewer’s language', () => {
    const en = desktopNav('/dashboard/agents/sessions');
    expect(headings(en, 'Sessions')).toBe(1);
    expect(en.indexOf('>Sessions<')).toBeLessThan(en.indexOf('>Active<'));
    expect(en.indexOf('>Active<')).toBeLessThan(en.indexOf('>All<'));

    const tr = desktopNav('/dashboard/agents/sessions', '', 'tr');
    expect(headings(tr, 'Oturumlar')).toBe(1);
    expect(tr.indexOf('>Oturumlar<')).toBeLessThan(tr.indexOf('>Aktif<'));
    expect(tr.indexOf('>Aktif<')).toBeLessThan(tr.indexOf('>Tümü<'));
    expect(headings(tr, 'Sessions')).toBe(0);
  });

  it('keeps the trailing Resources heading', () => {
    expect(headings(desktopNav('/dashboard/agents'), 'Resources')).toBe(1);
  });

  it('marks the link of the open view as current, and only that one', () => {
    const all = desktopNav('/dashboard/agents/sessions');
    expect(anchor(all, '/dashboard/agents/sessions')).toContain('aria-current="page"');
    expect(anchor(all, '/dashboard/agents/sessions?view=active')).not.toContain('aria-current');
    expect(anchor(all, '/dashboard/agents')).not.toContain('aria-current');

    const active = desktopNav('/dashboard/agents/sessions', 'view=active');
    expect(anchor(active, '/dashboard/agents/sessions?view=active')).toContain('aria-current="page"');
    expect(anchor(active, '/dashboard/agents/sessions')).not.toContain('aria-current');
    expect(anchor(active, '/dashboard/agents')).not.toContain('aria-current');

    const inAgent = desktopNav('/dashboard/agents/64f0c0ffee/sessions/s1');
    expect(anchor(inAgent, '/dashboard/agents')).toContain('aria-current="page"');
    expect(anchor(inAgent, '/dashboard/agents/sessions')).not.toContain('aria-current');
    expect(anchor(inAgent, '/dashboard/agents/sessions?view=active')).not.toContain('aria-current');
  });

  it('labels the group in the phone drawer too', () => {
    const en = mobileNav('/dashboard/agents/sessions', 'view=active');
    expect(headings(en, 'Sessions')).toBe(1);
    expect(en.indexOf('>Sessions<')).toBeLessThan(en.indexOf('>Active<'));
    expect(anchor(en, '/dashboard/agents/sessions?view=active')).toContain('aria-current="page"');
    expect(anchor(en, '/dashboard/agents/sessions')).not.toContain('aria-current');

    const tr = mobileNav('/dashboard/agents/sessions', '', 'tr');
    expect(headings(tr, 'Oturumlar')).toBe(1);
    expect(anchor(tr, '/dashboard/agents/sessions')).toContain('aria-current="page"');
  });
});

describe('the breadcrumb of the Sessions page', () => {
  it('does not ask for an agent called "sessions"', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      fetched.push(String(input));
      return { ok: true, status: 200, json: async () => ({ agent: { name: 'Should not be used' } }) };
    });
    try {
      const resolver = BREADCRUMB_RESOLVERS.find((entry) => entry.id === 'standard:agents')!;
      const ctx = (path: string) => ({ segments: path.split('/').filter(Boolean), cache: new Map<string, string>() });
      expect(await resolver.resolve(ctx('/dashboard/agents/sessions'))).toEqual([]);
      expect(fetched).toEqual([]);
      // a real agent id is still named
      expect(await resolver.resolve(ctx('/dashboard/agents/64f0c0ffee'))).toEqual([{ index: 2, label: 'Should not be used' }]);
      expect(fetched).toEqual(['/api/agents/64f0c0ffee']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
