/**
 * Flow runs under Agent Observability: the sub-nav entry and the matchers around it, the permission gate,
 * the command palette entry, the breadcrumb word and the navigation words in both languages.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/tracing/flows',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import ServiceSubNav, { SUBNAV_CONFIG, visibleSubNavItems } from '@/components/layout/launcher/ServiceSubNav';
import { DASHBOARD_SUBPAGES, findDashboardService } from '@/lib/utils/dashboardServices';
import { BREADCRUMB_RESOLVERS } from '@/components/layout/breadcrumbResolvers';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;
const search = new URLSearchParams();

const items = SUBNAV_CONFIG.tracing;
const item = (id: string) => items.find((entry) => entry.id === id)!;
const activeAt = (pathname: string) =>
  items.filter((entry) => (entry.matcher ? entry.matcher(pathname, search) : pathname === entry.href)).map((entry) => entry.id);

describe('the Tracing sub-nav, Flow runs entry', () => {
  it('is the last entry, gated by the flows service', () => {
    expect(items[items.length - 1]!.id).toBe('flow-runs');
    expect(item('flow-runs')).toMatchObject({
      label: 'Flow runs',
      labelKey: 'flowRuns',
      href: '/dashboard/tracing/flows',
      icon: IconRoute,
      requiresService: 'flows',
    });
  });

  it('is the only active entry on its pages, and Overview lets go of them', () => {
    expect(activeAt('/dashboard/tracing/flows')).toEqual(['flow-runs']);
    expect(activeAt('/dashboard/tracing/flows/run_1')).toEqual(['flow-runs']);
    expect(activeAt('/dashboard/tracing')).toEqual(['overview']);
    expect(activeAt('/dashboard/tracing/sessions/abc')).toEqual(['sessions']);
    expect(activeAt('/dashboard/tracing/agents/Pulse')).toEqual(['agents']);
  });

  it('is left out for someone without access to flows', () => {
    expect(visibleSubNavItems(items, () => true)!.map((entry) => entry.id)).toContain('flow-runs');
    expect(visibleSubNavItems(items, (service) => service !== 'flows')!.map((entry) => entry.id)).not.toContain('flow-runs');
  });

  it('is drawn in the viewer’s language and marked current on its page', () => {
    const tracing = findDashboardService('tracing')!;
    const nav = (locale: 'en' | 'tr') =>
      render(h(ServiceSubNav, { service: tracing, pathname: '/dashboard/tracing/flows', isPinned: false, onTogglePin: noop, onOpenDocs: noop }), locale);
    const anchor = (html: string, href: string) => (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));
    const english = nav('en');
    expect(anchor(english, '/dashboard/tracing/flows')).toContain('aria-current="page"');
    expect(anchor(english, '/dashboard/tracing')).not.toContain('aria-current');
    expect(english).toContain('Flow runs');
    expect(nav('tr')).toContain(tr.navigation.flowRuns);
  });
});

describe('Flow runs elsewhere in the shell', () => {
  it('has a command palette entry inside the tracing service', () => {
    const entry = DASHBOARD_SUBPAGES.find((page) => page.id === 'flow-runs')!;
    expect(entry).toMatchObject({ parent: 'tracing', service: 'flows', href: '/dashboard/tracing/flows', icon: IconRoute });
    expect(entry.searchKeywords.length).toBeGreaterThan(0);
  });

  it('has its words in both languages', () => {
    for (const language of [en, tr]) {
      expect(language.navigation.flowRuns).toBeTruthy();
      expect(language.navigation.flowRunsDescription).toBeTruthy();
      expect(language.breadcrumbs.flows).toBeTruthy();
    }
    expect(tr.navigation.flowRuns).not.toBe(en.navigation.flowRuns);
  });

  it('has a breadcrumb resolver for the run id', () => {
    expect(BREADCRUMB_RESOLVERS.some((resolver) => resolver.id === 'custom:tracing-flow-run')).toBe(true);
  });
});
