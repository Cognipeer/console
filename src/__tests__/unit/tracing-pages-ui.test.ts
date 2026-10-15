// @vitest-environment jsdom
/**
 * The tracing overview and the agent page: skeletons instead of a blank page, charts instead of the daily
 * table, the health panel in place, the raw daily table collapsed, fetches that can be aborted.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  settle,
  text,
  type ApiMock,
  type Mounted,
} from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({
  search: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.search,
  usePathname: () => '/dashboard/tracing',
  useParams: () => ({ agentName: 'Pulse%20Main' }),
  useRouter: () => ({ push: nav.push, replace: nav.replace, prefetch: nav.prefetch }),
}));

vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: nav.push }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

vi.mock('@/components/docs/DocsDrawerContext', () => ({
  useDocsDrawer: () => ({ openDocs: vi.fn() }),
}));

import AgentTracingPage from '@/app/dashboard/tracing/page';
import AgentTracingAgentPage from '@/app/dashboard/tracing/agents/[agentName]/page';

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => {
  installDomStubs();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: (entries: unknown[]) => void) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 800, height: 200 } }]);
    }
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 200 });
});
beforeEach(() => {
  nav.search = new URLSearchParams();
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
});

const totals = {
  sessionsCount: 12,
  totalTokens: 3400,
  totalEvents: 90,
  totalInputTokens: 2000,
  totalCachedInputTokens: 0,
  averageTokensPerSession: 283,
  averageDurationMs: 1500,
  totalDurationMs: 18000,
};

const dashboard = {
  recentAgentsTotal: 2,
  recentSessions: [],
  analytics: {
    totals,
    tools: { totals: { totalCalls: 4, errorCalls: 1, errorRate: 0.25 }, items: [] },
    agents: [],
    statuses: [{ status: 'abandoned', count: 2 }],
    models: [],
    daily: [
      { date: '2026-10-13', sessionsCount: 5, totalEvents: 30, totalTokens: 1000, averageDurationMs: 1000 },
      { date: '2026-10-14', sessionsCount: 7, totalEvents: 60, totalTokens: 2400, averageDurationMs: 2000 },
    ],
  },
};

describe('the tracing overview', () => {
  it('shows skeletons while loading, not a page-wide loader', async () => {
    api = installApiMock([['GET', '/api/tracing/dashboard', () => new Promise(() => undefined)]]);
    mounted = await mount(h(AgentTracingPage));
    // The only spinner is the refresh button's own; there is no page-wide loader.
    expect(qa('.mantine-Loader-root').filter((el) => !el.closest('button'))).toHaveLength(0);
    expect(q('.ds-page-header')).not.toBeNull(); // the header and its date filter are there at once
    expect(qa('.ds-stat').length).toBeGreaterThan(0);
    expect(q('[aria-busy="true"]')).not.toBeNull();
  });

  it('draws the daily trend as charts, not as a table', async () => {
    api = installApiMock([['GET', '/api/tracing/dashboard', () => dashboard]]);
    mounted = await mount(h(AgentTracingPage));
    await settle(50);
    expect(qa('.recharts-wrapper').length).toBe(2); // sessions and tokens per day
    expect(text()).toContain('Sessions per day');
    expect(text()).toContain('Tokens per day');
    expect(text()).not.toContain('Recent Trend');
    // The status breakdown speaks the new status vocabulary through the shared colors.
    expect(text()).toContain('ABANDONED');
  });

  it('says there is not enough daily data instead of drawing a one-point chart', async () => {
    api = installApiMock([
      ['GET', '/api/tracing/dashboard', () => ({ ...dashboard, analytics: { ...dashboard.analytics, daily: dashboard.analytics.daily.slice(0, 1) } })],
    ]);
    mounted = await mount(h(AgentTracingPage));
    await settle(50);
    expect(qa('.recharts-wrapper').length).toBe(0);
    expect(text()).toContain('Not enough daily data in this range to draw a trend yet.');
  });

  it('shows the failure with a retry', async () => {
    let fail = true;
    api = installApiMock([['GET', '/api/tracing/dashboard', () => (fail ? jsonResponse({ error: 'db down' }, 500) : dashboard)]]);
    mounted = await mount(h(AgentTracingPage));
    await settle(50);
    expect(text()).toContain('db down');
    fail = false;
    await click(buttonByText('Try again'));
    await settle(50);
    expect(qa('.recharts-wrapper').length).toBe(2);
    expect(text()).not.toContain('db down');
  });

  it('speaks Turkish', async () => {
    api = installApiMock([['GET', '/api/tracing/dashboard', () => dashboard]]);
    mounted = await mount(h(AgentTracingPage), 'tr');
    await settle(50);
    expect(text()).toContain('Günlük oturum');
    expect(text()).toContain('Toplam oturum');
    expect(text()).not.toContain('Sessions per day');
  });
});

describe('the agent page', () => {
  const overview = {
    agent: {
      name: 'Pulse Main',
      label: 'Pulse Main',
      latestStatus: 'abandoned',
      latestVersion: '2.0',
      latestSessionAt: new Date().toISOString(),
      versions: ['2.0'],
      sessionsCount: 12,
    },
    recentSessions: [],
    analytics: {
      totals: { ...totals, averageInputTokensPerSession: 1, averageOutputTokensPerSession: 1, averageCachedInputTokensPerSession: 0, totalOutputTokens: 5, totalCachedInputTokens: 0 },
      tools: { totals: { totalCalls: 4, errorCalls: 1, successCalls: 3, errorRate: 0.25 }, items: [] },
      statuses: [],
      models: [],
      versions: [],
      daily: [{ date: '2026-10-14', sessionsCount: 7, totalEvents: 60, totalTokens: 2400, averageDurationMs: 2000 }],
      insights: null,
    },
  };
  const health = {
    range: { fromMs: 1, toMs: 2, bucketMs: 3_600_000 },
    buckets: [],
    totals: {},
    previous: null,
    baseline: null,
    markers: [],
    markersPartial: false,
    alerts: { firing: 0, pending: 0 },
  };

  function mockAgent() {
    api = installApiMock([
      ['GET', /\/overview$/, () => overview],
      ['GET', /\/health$/, () => health],
    ]);
  }

  it('shows a skeleton first, then the page with the health panel between the tiles and the token breakdown', async () => {
    mockAgent();
    mounted = await mount(h(AgentTracingAgentPage));
    expect(q('.mantine-Loader-root')).toBeNull();
    await settle(50);

    const calls = api.to('GET', /\/api\/tracing\/agents\/Pulse%20Main\/(overview|health)$/);
    expect(calls.map((c) => c.path.split('/').pop()).sort()).toEqual(['health', 'overview']);

    const body = text();
    expect(body).toContain('Pulse Main');
    expect(body).toContain('Abandoned'); // the latest status badge speaks the shared vocabulary
    expect(body.indexOf('Total sessions')).toBeLessThan(body.indexOf('Health'));
    expect(body.indexOf('Health')).toBeLessThan(body.indexOf('Token breakdown'));
    // The panel's own empty state for a period without rollup sessions.
    expect(body).toContain('No sessions in this period');
  });

  it('defaults to the last 24 hours, like the list, for both the overview and the health panel', async () => {
    mockAgent();
    mounted = await mount(h(AgentTracingAgentPage));
    await settle(50);
    const calls = api.to('GET', /\/api\/tracing\/agents\/Pulse%20Main\/(overview|health)$/);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.query.period).toBe('last_day');
  });

  it('keeps the raw daily table collapsed until asked', async () => {
    mockAgent();
    mounted = await mount(h(AgentTracingAgentPage));
    await settle(50);
    const toggle = buttonByText('Raw daily')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(q('#agent-raw-daily')!.getAttribute('style') ?? '').toMatch(/display:\s*none|height:\s*0/);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(text()).toContain('Oct 14, 2026');
  });

  it('refreshes both the overview and the health panel', async () => {
    mockAgent();
    mounted = await mount(h(AgentTracingAgentPage));
    await settle(50);
    await click(buttonByText('Refresh'));
    await settle(50);
    expect(api.to('GET', /\/overview$/)).toHaveLength(2);
    expect(api.to('GET', /\/health$/)).toHaveLength(2);
  });

  it('shows the overview failure and keeps the page', async () => {
    api = installApiMock([
      ['GET', /\/overview$/, () => jsonResponse({ error: 'overview exploded' }, 500)],
      ['GET', /\/health$/, () => health],
    ]);
    mounted = await mount(h(AgentTracingAgentPage));
    await settle(50);
    expect(text()).toContain('overview exploded');
    expect(text()).toContain('Total sessions');
  });

  it('speaks Turkish', async () => {
    mockAgent();
    mounted = await mount(h(AgentTracingAgentPage), 'tr');
    await settle(50);
    expect(text()).toContain('Toplam oturum');
    expect(text()).toContain('Token dağılımı');
    expect(text()).toContain('Bu dönemde oturum yok');
  });
});
