/**
 * The Enterprise Health plumbing the community build carries: the Health entry of the tracing sub-nav and the
 * matchers around it, the placeholder page, its licence rule, RBAC mapping and words in both languages.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import React, { createElement as h, type ReactNode } from 'react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { IconHeartbeat } from '@tabler/icons-react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard/tracing/health',
  useRouter: () => ({ push: () => undefined, prefetch: () => undefined, replace: () => undefined }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { I18nProvider } from '@/lib/i18n';
import ServiceSubNav, { SUBNAV_CONFIG } from '@/components/layout/launcher/ServiceSubNav';
import { findDashboardService } from '@/lib/utils/dashboardServices';
import TracingHealthPage from '@/app/dashboard/tracing/health/page';
import { EnterpriseUpsell } from '@/components/enterprise/EnterpriseUpsell';
import { ENTERPRISE_API_RULES } from '@/lib/license/enterprise-access';
import { getPermissionServiceForPath } from '@/lib/security/rbac';
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

describe('the Tracing sub-nav', () => {
  it('has Health right after Overview, translated, pointing at the Health page', () => {
    expect(items.map((entry) => entry.id)).toEqual(['overview', 'health', 'sessions', 'threads', 'agents']);
    expect(item('health')).toMatchObject({
      label: 'Health',
      labelKey: 'entityHealth',
      href: '/dashboard/tracing/health',
      icon: IconHeartbeat,
    });
  });

  it('marks exactly one entry active on each page of the section', () => {
    expect(activeAt('/dashboard/tracing')).toEqual(['overview']);
    expect(activeAt('/dashboard/tracing/health')).toEqual(['health']);
    expect(activeAt('/dashboard/tracing/health/agent/pulse')).toEqual(['health']);
    expect(activeAt('/dashboard/tracing/sessions')).toEqual(['sessions']);
    expect(activeAt('/dashboard/tracing/sessions/abc')).toEqual(['sessions']);
    expect(activeAt('/dashboard/tracing/threads/t1')).toEqual(['threads']);
    expect(activeAt('/dashboard/tracing/agents')).toEqual(['agents']);
    expect(activeAt('/dashboard/tracing/agents/Pulse%20Main')).toEqual(['agents']);
  });

  it('draws the entry in the viewer’s language and marks it current on its page', () => {
    const tracing = findDashboardService('tracing')!;
    const nav = (pathname: string, locale: 'en' | 'tr' = 'en') =>
      render(h(ServiceSubNav, { service: tracing, pathname, isPinned: false, onTogglePin: noop, onOpenDocs: noop }), locale);
    const anchor = (html: string, href: string) => (html.match(/<a [^>]*>/g) ?? []).find((tag) => tag.includes(`href="${href}"`));

    const onHealth = nav('/dashboard/tracing/health');
    expect(anchor(onHealth, '/dashboard/tracing/health')).toContain('aria-current="page"');
    expect(anchor(onHealth, '/dashboard/tracing')).not.toContain('aria-current');
    expect(onHealth).toContain('Health');
    expect(nav('/dashboard/tracing/health', 'tr')).toContain('Sağlık');
  });

  it('has its navigation words in both languages', () => {
    for (const language of [en, tr]) {
      expect(language.navigation.entityHealth).toBeTruthy();
      expect(language.navigation.entityHealthDescription).toBeTruthy();
    }
    expect(tr.navigation.entityHealth).not.toBe(en.navigation.entityHealth);
  });
});

// The Enterprise overlay replaces the placeholder page with the real scoreboard (covered by the overlay's
// entity-health-ui test); detect the composed EE tree by the component only the overlay ships.
const isEeTree = existsSync(join(process.cwd(), 'src/components/entityHealth/HealthScoreboard.tsx'));

describe('the community Health page', () => {
  it.skipIf(isEeTree)('is the Enterprise placeholder for the health module', () => {
    const element = TracingHealthPage() as React.ReactElement<{ module: string }>;
    expect(element.type).toBe(EnterpriseUpsell);
    expect(element.props.module).toBe('health');
    expect(render(element)).toContain('Entity Health is an Enterprise feature');
  });
});

describe('licence and RBAC of the Health API', () => {
  it('has a licence rule for /api/entity-health', () => {
    expect(ENTERPRISE_API_RULES.find((rule) => rule.module === 'health')).toEqual({
      module: 'health',
      prefixes: ['/api/entity-health/'],
    });
  });

  it('does not map the Health API to one service (each entity type is authorized in the handler)', () => {
    expect(getPermissionServiceForPath('/api/entity-health/summary')).toBeNull();
    expect(getPermissionServiceForPath('/api/entity-health')).toBeNull();
    expect(getPermissionServiceForPath('/api/tracing/agents/health')).toBe('tracing');
  });
});
