/**
 * Webhooks live in the Agents menu, not under Settings: the sub-nav entry and
 * the matchers around it, the registry no longer listing Webhooks as a Settings
 * page, the command palette finding it at its new address, the old
 * /dashboard/webhooks address redirecting, and the page itself.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { IconWebhook } from '@tabler/icons-react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/agents/webhooks',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  // Next's redirect() ends the render by throwing.
  redirect: vi.fn((path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { redirect } from 'next/navigation';
import { I18nProvider } from '@/lib/i18n';
import ServiceSubNav, {
  SUBNAV_CONFIG,
  findServiceForPath,
  visibleSubNavItems,
} from '@/components/layout/launcher/ServiceSubNav';
import {
  ALL_DASHBOARD_SERVICES,
  DASHBOARD_SUBPAGES,
  findDashboardService,
  getDashboardServices,
} from '@/lib/utils/dashboardServices';
import WebhooksRedirectPage from '@/app/dashboard/webhooks/page';
import AgentWebhooksPage from '@/app/dashboard/agents/webhooks/page';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;
const search = new URLSearchParams();

const agentItems = SUBNAV_CONFIG.agents;
const item = (id: string) => agentItems.find((entry) => entry.id === id)!;
/** The ids of the Agents sub-nav entries that call `pathname` theirs. */
const activeAt = (pathname: string) => agentItems.filter((entry) => (entry.matcher ? entry.matcher(pathname, search) : pathname === entry.href)).map((entry) => entry.id);

describe('the Agents sub-nav', () => {
  it('gains Webhooks after Skills, pointing at the new address, in the viewer’s language', () => {
    expect(agentItems.map((entry) => entry.id)).toEqual(['list', 'tools', 'skills', 'webhooks', 'channels', 'sessions-active', 'sessions-all']);
    expect(item('webhooks')).toMatchObject({
      label: 'Webhooks',
      labelKey: 'webhooks',
      href: '/dashboard/agents/webhooks',
      icon: IconWebhook,
      requiresService: 'webhooks',
    });
  });

  it('marks exactly one entry active on each page of the section', () => {
    expect(activeAt('/dashboard/agents')).toEqual(['list']);
    expect(activeAt('/dashboard/agents/64f0c0ffee')).toEqual(['list']);
    expect(activeAt('/dashboard/agents/64f0c0ffee/sessions/s1')).toEqual(['list']);
    expect(activeAt('/dashboard/agents/tools')).toEqual(['tools']);
    expect(activeAt('/dashboard/agents/tools/abc')).toEqual(['tools']);
    expect(activeAt('/dashboard/agents/skills')).toEqual(['skills']);
    // The list no longer claims the webhooks page.
    expect(activeAt('/dashboard/agents/webhooks')).toEqual(['webhooks']);
    // ...nor the Channels pages (list and a connection's detail).
    expect(activeAt('/dashboard/agents/channels')).toEqual(['channels']);
    expect(activeAt('/dashboard/agents/channels/64f0c0ffee')).toEqual(['channels']);
    // ...nor the project-wide Sessions pages, which have entries of their own.
    expect(activeAt('/dashboard/agents/sessions')).toEqual(['sessions-all']);
  });

  it('is left out of the nav for someone with no access to the Webhooks service', () => {
    const allowed = visibleSubNavItems(agentItems, () => true)!;
    expect(allowed.map((entry) => entry.id)).toContain('webhooks');
    const denied = visibleSubNavItems(agentItems, (service) => service !== 'webhooks')!;
    expect(denied.map((entry) => entry.id)).toEqual(['list', 'tools', 'skills', 'channels', 'sessions-active', 'sessions-all']);
    expect(visibleSubNavItems(undefined, () => false)).toBeUndefined();
  });

  it('draws the entry with its translated label and marks it current on its page', () => {
    const agents = findDashboardService('agents')!;
    const nav = (pathname: string, locale: 'en' | 'tr' = 'en') =>
      render(h(ServiceSubNav, { service: agents, pathname, isPinned: false, onTogglePin: noop, onOpenDocs: noop }), locale);
    const anchor = (html: string, href: string) => (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));

    const onWebhooks = nav('/dashboard/agents/webhooks');
    expect(anchor(onWebhooks, '/dashboard/agents/webhooks')).toContain('aria-current="page"');
    expect(anchor(onWebhooks, '/dashboard/agents')).not.toContain('aria-current');
    expect(onWebhooks).toContain('Webhooks');

    const onList = nav('/dashboard/agents');
    expect(anchor(onList, '/dashboard/agents')).toContain('aria-current="page"');
    expect(anchor(onList, '/dashboard/agents/webhooks')).not.toContain('aria-current');

    expect(nav('/dashboard/agents/webhooks', 'tr')).toContain('Webhook’lar');
  });
});

describe('Webhooks are no longer a Settings page', () => {
  it('has no service of its own: not in the registry, not in the Settings list, so nothing claims the Agents path', () => {
    expect(ALL_DASHBOARD_SERVICES.some((service) => service.id === 'webhooks')).toBe(false);
    expect(findDashboardService('webhooks')).toBeUndefined();

    const settings = getDashboardServices({ isTenantAdmin: true, role: 'owner', isOnPrem: true }).filter((service) => service.isSettings);
    expect(settings.map((service) => service.id)).not.toContain('webhooks');
    expect(settings.length).toBeGreaterThan(0);

    const everything = getDashboardServices({ isTenantAdmin: true, role: 'owner', isOnPrem: true });
    expect(findServiceForPath(everything, '/dashboard/agents/webhooks')?.id).toBe('agents');
    expect(findServiceForPath(everything, '/dashboard/agents')?.id).toBe('agents');
  });

  it('is gone from the Settings order and the platform-services file', () => {
    const layout = readFileSync(join(__dirname, '../../components/layout/DashboardLayout.tsx'), 'utf8');
    const order = /const SETTINGS_NAV_ORDER: string\[\] = \[([^\]]*)\]/.exec(layout)?.[1] ?? '';
    expect(order).toContain("'tokens'");
    expect(order).not.toContain('webhooks');

    const services = readFileSync(join(__dirname, '../../config/platform-services.json'), 'utf8');
    expect(services).not.toContain('"/dashboard/webhooks"');
    expect(services).not.toContain('"id": "webhooks"');
  });

  it('still has its words in the breadcrumb and the navigation messages, in both languages', () => {
    for (const language of [en, tr]) {
      expect(language.navigation.webhooks).toBeTruthy();
      expect(language.navigation.webhooksDescription).toBeTruthy();
      expect(language.breadcrumbs.webhooks).toBeTruthy();
    }
    // The crumb of /dashboard/agents/webhooks is "Agents / Webhooks": its segment keeps a translation.
    const crumbs = readFileSync(join(__dirname, '../../components/layout/DashboardBreadcrumbs.tsx'), 'utf8');
    expect(crumbs).toContain("webhooks: 'webhooks'");
    expect(crumbs).toContain("agents: 'agents'");
  });
});

describe('finding it from the command palette', () => {
  it('lists Webhooks as a page of the Agents menu at the new address, with the words people search for', () => {
    const page = DASHBOARD_SUBPAGES.find((entry) => entry.id === 'webhooks')!;
    expect(page).toMatchObject({ parent: 'agents', service: 'webhooks', href: '/dashboard/agents/webhooks', navLabelKey: 'webhooks' });
    expect(page.searchKeywords).toEqual(expect.arrayContaining(['webhook', 'callback', 'bildirim']));
    // The palette and the sub-nav agree on where it lives.
    expect(page.href).toBe(item('webhooks').href);
    expect(DASHBOARD_SUBPAGES.every((entry) => !entry.href.startsWith('/dashboard/webhooks'))).toBe(true);
  });

  it('is what the palette searches, next to the services', () => {
    const palette = readFileSync(join(__dirname, '../../components/layout/CommandPalette.tsx'), 'utf8');
    expect(palette).toContain('DASHBOARD_SUBPAGES');
    expect(palette).toMatch(/\.\.\.DASHBOARD_SUBPAGES/);
  });
});

describe('the old address', () => {
  it('redirects /dashboard/webhooks to /dashboard/agents/webhooks', () => {
    vi.mocked(redirect).mockClear();
    expect(() => WebhooksRedirectPage()).toThrow('NEXT_REDIRECT:/dashboard/agents/webhooks');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/dashboard/agents/webhooks');
  });
});

describe('the page', () => {
  it('shows the webhook list under Agents, with the page title in the viewer’s language', () => {
    const html = render(h(AgentWebhooksPage));
    expect(html).toContain('Build · Agents · Webhooks');
    expect(html).toContain('Send signed events to your own endpoints');
    expect(html).toContain('New webhook');
    expect(render(h(AgentWebhooksPage), 'tr')).toContain('Webhook’lar');
  });
});
