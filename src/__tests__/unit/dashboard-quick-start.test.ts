// @vitest-environment jsdom
/**
 * The dashboard home offers links into services only when the person can open
 * those services in the ACTIVE project - the quick-start tiles, the "Deploy model"
 * action and the "Top resources" quick links. The list of services it goes by is
 * the navigation's (`GET /api/auth/session` -> `effectivePermissions`, as the
 * engine decides it), so a service narrowed to "none" in this project is not
 * linked to from here either.
 */
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  installApiMock,
  installDomStubs,
  mount,
  q,
  qa,
  settle,
  text,
  type Mounted,
} from '../helpers/iamCenterUi';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/overview',
}));

import DashboardOverviewPage from '@/app/dashboard/overview/page';
import { QuickStart } from '@/components/dashboard/QuickStart';
import { QUICK_START_SERVICES, quickStartTiles } from '@/components/dashboard/quickStartModel';
import { LauncherProvider, type LauncherContextValue } from '@/components/layout/launcher/LauncherContext';
import { getDashboardServices } from '@/lib/utils/dashboardServices';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;

afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
});

type Levels = Record<string, ServicePermissionLevel>;

/**
 * The services the navigation offers a person whose levels in the active
 * project are `levels` (every other service: none), exactly as the layout
 * builds them from the session.
 */
function offeredTo(levels: Levels) {
  const all = getDashboardServices({ role: 'owner', isTenantAdmin: true, isOnPrem: true });
  const effectivePermissions = Object.fromEntries(all.map((s) => [s.id, levels[s.id] ?? 'none'])) as Levels;
  return getDashboardServices({ role: 'user', servicePermissions: {}, effectivePermissions, isOnPrem: true });
}

const STATS = {
  stats: {
    models: { total: 7, llm: 5, embedding: 2 },
    vectors: { providers: 2, indexes: 4 },
    tracing: { totalSessions: 31, totalTokens: 12000, activeSessions: 1 },
    apiCalls: { total: 99, trend: 0 },
  },
  recentActivity: [],
  user: { email: 'ann@acme.test', licenseType: 'FREE' },
};

async function renderHome(levels: Levels, locale = 'en', options: { pinned?: number; activity?: unknown[] } = {}) {
  installApiMock([['GET', '/api/dashboard', () => ({ ...STATS, recentActivity: options.activity ?? [] })]]);
  const services = offeredTo(levels);
  const value: LauncherContextValue = {
    pinned: new Set(),
    recents: [],
    togglePin: () => {},
    recordVisit: () => {},
    services,
    pinnedServices: services.slice(0, options.pinned ?? 0),
    recentServices: [],
    isTenantAdmin: false,
    openLauncher: () => {},
    hydrated: true,
  };
  mounted = await mount(createElement(LauncherProvider, { value } as ComponentProps<typeof LauncherProvider>, createElement(DashboardOverviewPage)), locale);
  await settle(100);
}

const hrefs = (scope: ParentNode = document.body) => qa<HTMLAnchorElement>('a', scope).map((a) => a.getAttribute('href'));
const tileTexts = () => qa('[data-testid="quick-start"] a').map((a) => a.textContent ?? '');

describe('quickStartTiles', () => {
  const service = (id: string) => ({ id, href: `/dashboard/${id}` });

  it('makes a tile for each suggested service the navigation offers, in the suggested order', () => {
    expect(quickStartTiles([service('agents'), service('models'), service('prompts'), service('cost')])).toEqual([
      { service: 'models', href: '/dashboard/models', step: '01' },
      { service: 'prompts', href: '/dashboard/prompts', step: '02' },
      { service: 'agents', href: '/dashboard/agents', step: '03' },
    ]);
  });

  it('leaves out a service that is not offered, and counts the steps over the ones that remain', () => {
    expect(quickStartTiles([service('models'), service('agents')])).toEqual([
      { service: 'models', href: '/dashboard/models', step: '01' },
      { service: 'agents', href: '/dashboard/agents', step: '02' },
    ]);
    expect(quickStartTiles([service('agents')])).toEqual([{ service: 'agents', href: '/dashboard/agents', step: '01' }]);
  });

  it('links to where the navigation sends people, not to a path of its own', () => {
    expect(quickStartTiles([{ id: 'models', href: '/somewhere/else' }])[0].href).toBe('/somewhere/else');
  });

  it('has no tile at all when none of them is offered', () => {
    expect(quickStartTiles([])).toEqual([]);
    expect(quickStartTiles([service('cost'), service('tracing')])).toEqual([]);
    expect(QUICK_START_SERVICES).toEqual(['models', 'prompts', 'agents']);
  });
});

describe('QuickStart', () => {
  it('renders the steps with their titles, the sentence under them and a link into the service', async () => {
    mounted = await mount(createElement(QuickStart, { tiles: quickStartTiles([{ id: 'models', href: '/dashboard/models' }, { id: 'prompts', href: '/dashboard/prompts' }, { id: 'agents', href: '/dashboard/agents' }]) }));
    expect(text()).toContain('Get started');
    expect(text()).toContain('Quick paths into your project');
    expect(tileTexts()).toEqual([
      'Step 01Deploy a modelChoose a provider and create an inference endpoint.',
      'Step 02Publish a promptVersion-controlled templates with test cases.',
      'Step 03Wire up an agentConnect tools and memory into a runnable agent.',
    ]);
    expect(hrefs(q('[data-testid="quick-start"]')!)).toEqual(['/dashboard/models', '/dashboard/prompts', '/dashboard/agents']);
  });

  it('is worded in Turkish when the console is', async () => {
    mounted = await mount(createElement(QuickStart, { tiles: quickStartTiles([{ id: 'models', href: '/dashboard/models' }]) }), 'tr');
    expect(text()).toContain('Başlayın');
    expect(text()).toContain('Adım 01');
    expect(text()).toContain('Bir model dağıtın');
    expect(text()).not.toMatch(/dashboardOverview\./);
  });

  it('shows nothing when there is nothing to link to', async () => {
    mounted = await mount(createElement(QuickStart, { tiles: [] }));
    expect(q('[data-testid="quick-start"]')).toBeNull();
    expect(text()).not.toContain('Get started');
  });
});

describe('the dashboard home', () => {
  it('offers every step to someone who can open the three services', async () => {
    await renderHome({ models: 'write', prompts: 'read', agents: 'write', vector: 'read', tracing: 'read' });
    expect(tileTexts().map((t) => t.replace(/(Deploy a model|Publish a prompt|Wire up an agent).*/, '$1'))).toEqual([
      'Step 01Deploy a model',
      'Step 02Publish a prompt',
      'Step 03Wire up an agent',
    ]);
    expect(hrefs()).toEqual(expect.arrayContaining(['/dashboard/models', '/dashboard/prompts', '/dashboard/agents']));
    expect(text()).toContain('Deploy model');
  });

  it('leaves out the step for a service narrowed to "none" in this project, and numbers the rest again', async () => {
    await renderHome({ models: 'write', prompts: 'none', agents: 'write' });
    expect(tileTexts()).toHaveLength(2);
    expect(tileTexts()[0]).toContain('Step 01Deploy a model');
    expect(tileTexts()[1]).toContain('Step 02Wire up an agent');
    expect(hrefs()).not.toContain('/dashboard/prompts');
  });

  it('sends nobody to a service they cannot use: no tile, no "Deploy model", no quick link, no "View All"', async () => {
    await renderHome({ prompts: 'read', agents: 'read' });
    expect(hrefs()).not.toContain('/dashboard/models');
    expect(hrefs()).not.toContain('/dashboard/vector');
    expect(hrefs()).not.toContain('/dashboard/tracing');
    expect(text()).not.toContain('Deploy model');
    expect(text()).not.toContain('Deploy a model');
    expect(text()).not.toContain('All models');
    expect(text()).not.toContain('View All');
    // What they can open is still there.
    expect(tileTexts()).toHaveLength(2);
    expect(hrefs()).toEqual(expect.arrayContaining(['/dashboard/prompts', '/dashboard/agents']));
  });

  it('shows the quick links of the services that remain, with their counts', async () => {
    await renderHome({ vector: 'read', tracing: 'read' });
    const top = qa('.ds-card').find((card) => card.textContent?.includes('Top resources'))!;
    expect(top.textContent).toContain('Vector indexes');
    expect(top.textContent).toContain('Trace sessions');
    expect(top.textContent).not.toContain('Models');
    expect(top.textContent).not.toContain('All models');
    expect(hrefs(top)).toEqual(['/dashboard/vector', '/dashboard/tracing']);
  });

  it('drops the "Top resources" card when none of its services can be opened, and the cards left use the whole row', async () => {
    await renderHome({ prompts: 'read' });
    expect(text()).not.toContain('Top resources');
    // The card that is left beside nothing takes the row (its grid has two columns).
    const resources = qa('.ds-card').find((card) => card.textContent?.includes('API Documentation'))!;
    expect(resources.style.gridColumn).toBe('1 / -1');
    const activity = qa('.ds-card').find((card) => card.textContent?.includes('No recent activity'))!;
    expect(activity.style.gridColumn).toBe('');
  });

  it('gives the activity the whole row when there is no step to suggest', async () => {
    await renderHome({ vector: 'read' });
    expect(q('[data-testid="quick-start"]')).toBeNull();
    expect(text()).not.toContain('Get started');
    const activity = qa('.ds-card').find((card) => card.textContent?.includes('No recent activity'))!;
    expect(activity.style.gridColumn).toBe('1 / -1');
  });

  it('is worded in Turkish', async () => {
    await renderHome({ models: 'write', prompts: 'read', agents: 'write' }, 'tr');
    expect(text()).toContain('Başlayın');
    expect(text()).toContain('Adım 02');
    expect(text()).toContain('Bir prompt yayımlayın');
  });
});

describe('the dashboard home, in both languages', () => {
  const LEVELS: Levels = { models: 'write', prompts: 'read', agents: 'write', vector: 'read', tracing: 'read' };
  const ACTIVITY = [{ id: 'a1', type: 'POST', service: 'models', endpoint: '/api/x', status: 'success', timestamp: new Date(Date.now() - 5 * 60_000).toISOString() }];

  it('reads in English as it always did', async () => {
    await renderHome(LEVELS, 'en', { pinned: 2, activity: ACTIVITY });
    const t = text();
    for (const words of [
      'Welcome back, ann', '2 pinned · ', 'services available', 'Deploy model', 'Your pinned services', 'Pin more', 'Add service',
      'Activity', 'View All', 'Top resources', 'Quick links into your build surface', 'All models', 'Vector indexes', 'Trace sessions',
      '2 providers', '12,000 tokens', 'Resources', '5m ago', '7 Models', '4 Indexes',
    ]) {
      expect(t, words).toContain(words);
    }
  });

  it('reads in Turkish, with nothing left in English', async () => {
    await renderHome(LEVELS, 'tr', { pinned: 2, activity: ACTIVITY });
    const t = text();
    for (const words of [
      'Tekrar hoş geldiniz, ann', '2 sabitlenmiş · ', 'servis kullanılabilir', 'Model dağıt', 'Sabitlediğiniz servisler', 'Daha fazla sabitle', 'Servis ekle',
      'Etkinlik', 'Tümünü gör', 'Öne çıkan kaynaklar', 'Geliştirme alanınıza hızlı bağlantılar', 'Tüm modeller', 'Vektör indeksleri', 'İzleme oturumları',
      '2 sağlayıcı', '12.000 token', 'Kaynaklar', '5 dk önce', '7 Model', '4 İndeks', 'API istekleri', 'Plan özeti', 'API dokümantasyonu',
    ]) {
      expect(t, words).toContain(words);
    }
    for (const words of [
      'Welcome back', 'Deploy model', 'Your pinned services', 'Pin more', 'Top resources', 'All models', 'View All', 'ago', 'tokens', 'API Requests', 'API Documentation',
    ]) {
      expect(t, words).not.toContain(words);
    }
    expect(t).not.toMatch(/dashboardOverview\./);
  });

  it('counts one service in the singular', async () => {
    await renderHome({ prompts: 'read' });
    expect(text()).toContain('0 pinned · 1 service available');
    expect(text()).not.toContain('1 services');
    await mounted.unmount();
    await renderHome({ prompts: 'read', agents: 'read' });
    expect(text()).toContain('2 services available');
  });

  it('marks the stat tiles as Turkish, for their upper-cased labels', async () => {
    await renderHome(LEVELS, 'tr');
    expect(q('.ds-stat-label')?.closest('[lang]')?.getAttribute('lang')).toBe('tr');
  });
});
