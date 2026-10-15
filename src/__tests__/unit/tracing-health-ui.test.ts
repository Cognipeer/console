// @vitest-environment jsdom
/**
 * The tracing health views in a browser: the agent health panel (fetch, KPI tiles, links, states), the reusable
 * entity charts for an entity that is not an agent, the agents list (default period, columns, sorting, filters)
 * and the sessions list reading status and time range from the URL.
 * (createElement, not JSX: the suite only collects `.test.ts`.)
 */
import { createElement as h, Fragment, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
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
  usePathname: () => '/dashboard/tracing/agents',
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

import AgentHealthPanel from '@/components/tracing/health/AgentHealthPanel';
import EntityHealthCharts from '@/components/tracing/health/EntityHealthCharts';
import type { EntityHealthSeriesPayload } from '@/components/tracing/health/healthSeries';
import TracingAgentsPage from '@/app/dashboard/tracing/agents/page';
import TracingSessionsPage from '@/app/dashboard/tracing/sessions/page';
import TracingThreadsPage from '@/app/dashboard/tracing/threads/page';

const HOUR = 3_600_000;
const FROM = Date.UTC(2026, 9, 14, 0, 0, 0);

function series(over: Partial<EntityHealthSeriesPayload> = {}): EntityHealthSeriesPayload {
  return {
    range: { fromMs: FROM, toMs: FROM + 4 * HOUR, bucketMs: HOUR },
    buckets: [
      { t: FROM, requests: 10, errors: 1, errorRate: 10, p50Ms: 200, p95Ms: 900 },
      { t: FROM + HOUR, requests: 0 },
      { t: FROM + 2 * HOUR, requests: 20, errors: 0, errorRate: 0, p50Ms: 180, p95Ms: 700 },
      { t: FROM + 3 * HOUR, requests: 5, errors: 5, errorRate: 100, p50Ms: 300, p95Ms: 2000 },
    ],
    totals: { requests: 35, errors: 6, errorRate: 17.1, p95Ms: 1200 },
    previous: { requests: 30, errors: 1, errorRate: 3.3, p95Ms: 900 },
    baseline: null,
    markers: [],
    markersPartial: false,
    alerts: { firing: 0, pending: 0 },
    ...over,
  };
}

let mounted: Mounted | null = null;
let api: ApiMock;

beforeAll(() => installDomStubs());
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

const noFilter = { period: 'last_day' as const, dateRange: [null, null] as [Date | null, Date | null] };

describe('AgentHealthPanel', () => {
  it('fetches the agent health of the period (the name encoded once) and shows the KPI tiles', async () => {
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'Pulse Main', dateFilter: noFilter }));
    await settle(50);

    const calls = api.to('GET', /\/api\/tracing\/agents\/.+\/health$/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/api/tracing/agents/Pulse%20Main/health');
    expect(calls[0]!.query.period).toBe('last_day');

    const tiles = qa('.ds-stat').map((tile) => tile.getAttribute('data-kpi'));
    expect(tiles).toEqual(['requests', 'errorRate', 'p95Ms']);
    expect(text()).toContain('Sessions');
    expect(text()).toContain('17%');
    expect(text()).toContain('1.2 s');
  });

  it('colors an error rate that grew as bad and says so against the previous period', async () => {
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    const errorTile = q('[data-kpi="errorRate"]')!;
    const delta = q('.ds-stat-delta', errorTile)!;
    expect(delta.getAttribute('data-tone')).toBe('bad');
    expect(delta.className).toContain('down'); // the red class
    expect(delta.textContent).toContain('+14 pp');
    // Traffic volume is never colored.
    expect(q('[data-kpi="requests"] .ds-stat-delta')!.getAttribute('data-tone')).toBe('neutral');
  });

  it('links to the pre-filled alert form and to the failing sessions of the range', async () => {
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'Pulse Main', dateFilter: noFilter }));
    await settle(50);

    const alert = new URL(buttonByText('Create alert')!.getAttribute('href')!, 'http://x');
    expect(alert.pathname).toBe('/dashboard/alerts');
    expect(Object.fromEntries(alert.searchParams)).toEqual({
      create: '1',
      module: 'agents',
      metric: 'agent_error_rate',
      entityType: 'agent',
      entityKey: 'Pulse Main',
    });

    const failing = new URL(buttonByText('View failing sessions')!.getAttribute('href')!, 'http://x');
    expect(failing.pathname).toBe('/dashboard/tracing/sessions');
    expect(failing.searchParams.get('agent')).toBe('Pulse Main');
    expect(failing.searchParams.get('status')).toBe('error');
    expect(failing.searchParams.get('from')).toBe(new Date(FROM).toISOString());
    expect(failing.searchParams.get('to')).toBe(new Date(FROM + 4 * HOUR).toISOString());
  });

  it('shows how many alerts fire and which markers sit on the chart', async () => {
    api = installApiMock([
      ['GET', /\/health$/, () => series({
        alerts: { firing: 2, pending: 1 },
        markers: [
          { t: FROM + 2 * HOUR + 60_000, type: 'version', label: 'v2.0', href: '/dashboard/tracing/sessions?agent=a' },
          { t: FROM + 3 * HOUR + 60_000, type: 'incident', label: 'Error spike', href: '/dashboard/alerts/incidents/inc1' },
        ],
        markersPartial: true,
      })],
    ]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    expect(text()).toContain('2 alerts firing');
    expect(text()).toContain('1 pending');
    expect(text()).toContain('New version: v2.0');
    expect(text()).toContain('Incident: Error spike');
    expect(text()).toContain('Earlier versions may not be shown.');
    const hrefs = qa('a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/alerts/incidents/inc1');
  });

  it('says no alert rule covers the agent instead of implying all is well', async () => {
    api = installApiMock([['GET', /\/health$/, () => series({ alerts: { firing: 0, pending: 0, covered: false }, alertsAvailable: true })]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'Pulse Main', dateFilter: noFilter }));
    await settle(50);
    const badge = q('[data-testid="agent-no-alert-rule"]')!;
    expect(badge.textContent).toContain('No alert rule');
    expect(new URL(badge.getAttribute('href')!, 'http://x').searchParams.get('entityKey')).toBe('Pulse Main');
    expect(q('[data-testid="agent-alerts-unavailable"]')).toBeNull();
  });

  it('shows nothing extra for a covered agent with no alert, and for an older server without the flags', async () => {
    api = installApiMock([['GET', /\/health$/, () => series({ alerts: { firing: 0, pending: 0, covered: true }, alertsAvailable: true })]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    expect(q('[data-testid="agent-no-alert-rule"]')).toBeNull();
    expect(q('[data-testid="agent-alerts-unknown"]')).toBeNull();
    await mounted.unmount();
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    expect(q('[data-testid="agent-no-alert-rule"]')).toBeNull();
    expect(q('[data-testid="agent-alerts-unavailable"]')).toBeNull();
  });

  it('warns and shows Unknown when the alert read failed, never an all-clear', async () => {
    api = installApiMock([['GET', /\/health$/, () => series({ alerts: { firing: 0, pending: 0, covered: true }, alertsAvailable: false })]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    expect(q('[data-testid="agent-alerts-unavailable"]')).not.toBeNull();
    expect(q('[data-testid="agent-alerts-unknown"]')!.textContent).toContain('Unknown');
    expect(q('[data-testid="agent-no-alert-rule"]')).toBeNull();
  });

  it('shows a skeleton while loading and an empty state when the period has no sessions', async () => {
    let release: (value: unknown) => void = () => undefined;
    api = installApiMock([['GET', /\/health$/, () => new Promise((resolve) => { release = resolve; })]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    expect(q('[aria-busy="true"]')).not.toBeNull();
    expect(qa('.ds-stat')).toHaveLength(4); // the stat-grid skeleton
    await act(async () => {
      release(series({ totals: {}, buckets: [{ t: FROM, requests: 0 }, { t: FROM + HOUR, requests: 0 }], previous: null }));
    });
    await settle(50);
    expect(text()).toContain('No sessions in this period');
    expect(qa('[data-kpi]')).toHaveLength(0);
  });

  it('shows the error with a retry that fetches again', async () => {
    let fail = true;
    api = installApiMock([
      ['GET', /\/health$/, () => (fail ? jsonResponse({ error: 'rollup unavailable' }, 500) : series())],
    ]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: noFilter }));
    await settle(50);
    expect(text()).toContain('Could not load the health of this agent.');
    expect(text()).toContain('rollup unavailable');
    fail = false;
    await click(buttonByText('Try again'));
    await settle(50);
    expect(api.to('GET', /\/health$/)).toHaveLength(2);
    expect(qa('[data-kpi]').length).toBeGreaterThan(0);
  });

  it('refetches when the period changes or the page refreshes', async () => {
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    const last7 = { period: 'last_7_days' as const, dateRange: [null, null] as [Date | null, Date | null] };
    function Harness() {
      const [filter, setFilter] = useState<typeof noFilter | typeof last7>(noFilter);
      const [refreshKey, setRefreshKey] = useState(0);
      return h(
        Fragment,
        null,
        h('button', { onClick: () => setFilter(last7) }, 'change period'),
        h('button', { onClick: () => setRefreshKey((n) => n + 1) }, 'refresh page'),
        h(AgentHealthPanel, { agentName: 'a', dateFilter: filter, refreshKey }),
      );
    }
    mounted = await mount(h(Harness));
    await settle(50);
    await click(buttonByText('change period'));
    await settle(50);
    await click(buttonByText('refresh page'));
    await settle(50);
    expect(api.to('GET', /\/health$/).map((c) => c.query.period)).toEqual(['last_day', 'last_7_days', 'last_7_days']);
  });

  it('never shows one agent\'s charts under another agent while the next one loads', async () => {
    let releaseB: (value: unknown) => void = () => undefined;
    api = installApiMock([
      ['GET', /\/agents\/a\/health$/, () => series({ alerts: { firing: 1, pending: 0 } })],
      ['GET', /\/agents\/b\/health$/, () => new Promise((resolve) => { releaseB = resolve; })],
    ]);
    function Harness() {
      const [agent, setAgent] = useState('a');
      return h(
        Fragment,
        null,
        h('button', { onClick: () => setAgent('b') }, 'go to b'),
        h(AgentHealthPanel, { agentName: agent, dateFilter: noFilter }),
      );
    }
    mounted = await mount(h(Harness));
    await settle(50);
    expect(qa('[data-kpi]').length).toBeGreaterThan(0);
    expect(text()).toContain('1 alert firing');

    await click(buttonByText('go to b'));
    // b is still loading: a's KPIs and alert badge are gone, the skeleton shows.
    expect(qa('[data-kpi]')).toHaveLength(0);
    expect(text()).not.toContain('alert firing');
    expect(qa('.ds-stat')).toHaveLength(4);

    await act(async () => { releaseB(series({ alerts: { firing: 0, pending: 0 } })); });
    await settle(50);
    expect(qa('[data-kpi]').length).toBeGreaterThan(0);
  });

  it('links the firing badge to the open agent incidents of that agent', async () => {
    api = installApiMock([['GET', /\/health$/, () => series({ alerts: { firing: 1, pending: 0 } })]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'Pulse Main', dateFilter: noFilter }));
    await settle(50);
    const badge = qa('a').find((a) => (a.textContent ?? '').includes('alert firing'))!;
    const url = new URL(badge.getAttribute('href')!, 'http://x');
    expect(url.pathname).toBe('/dashboard/alerts/incidents');
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: 'all', module: 'agents', entityKey: 'Pulse Main' });
  });

  it('notes that "total" means the last 30 days', async () => {
    api = installApiMock([['GET', /\/health$/, () => series()]]);
    mounted = await mount(h(AgentHealthPanel, { agentName: 'a', dateFilter: { period: 'total', dateRange: [null, null] } }));
    await settle(50);
    expect(api.to('GET', /\/health$/)[0]!.query.period).toBe('total');
    expect(text()).toContain('Total shows the last 30 days');
  });
});

describe('EntityHealthCharts (reused for entities that are not agents)', () => {
  it('draws only what the payload has: no tool, abandoned or cost tiles for a model', async () => {
    mounted = await mount(h(EntityHealthCharts, { series: series(), requestsLabel: 'Requests' }));
    await settle(20);
    expect(qa('[data-kpi]').map((tile) => tile.getAttribute('data-kpi'))).toEqual(['requests', 'errorRate', 'p95Ms']);
    expect(text()).not.toContain('Tool error rate');
    expect(text()).not.toContain('Abandoned');
    expect(text()).toContain('Requests');
  });

  it('adds tool error, cost and abandoned tiles when the payload carries them', async () => {
    mounted = await mount(h(EntityHealthCharts, {
      series: series({ totals: { requests: 35, errorRate: 17.1, p95Ms: 1200, toolCalls: 8, toolErrorRate: 12.5, costUsd: 3.2, abandoned: 2 } }),
    }));
    await settle(20);
    expect(qa('[data-kpi]').map((tile) => tile.getAttribute('data-kpi'))).toEqual([
      'requests', 'errorRate', 'p95Ms', 'toolErrorRate', 'costUsd', 'abandoned',
    ]);
    expect(text()).toContain('$3.20');
  });

  it('always signs the change against the previous period and gives it an arrow, however small', async () => {
    mounted = await mount(h(EntityHealthCharts, {
      series: series({
        totals: { requests: 35, errorRate: 17.1, p95Ms: 1035, toolCalls: 8, toolErrorRate: 5.3 },
        previous: { requests: 35, errorRate: 17.1, p95Ms: 1000, toolErrorRate: 5.6 },
      }),
    }));
    await settle(20);
    const delta = (id: string) => q(`[data-kpi="${id}"] .ds-stat-delta`)!;
    // p95 up 3.5% is under the noise band, but still reads as a rise, in red.
    expect(delta('p95Ms').textContent).toContain('+3.5%');
    expect(delta('p95Ms').getAttribute('data-tone')).toBe('bad');
    expect(delta('p95Ms').className).toContain('down');
    expect(q('svg', delta('p95Ms'))).not.toBeNull();
    // Tool errors down 0.3 pp: a real minus sign, an arrow, green.
    expect(delta('toolErrorRate').textContent).toContain('\u22120.3 pp');
    expect(delta('toolErrorRate').getAttribute('data-tone')).toBe('good');
    expect(delta('toolErrorRate').className).toContain('up');
    expect(q('svg', delta('toolErrorRate'))).not.toBeNull();
    // No change at all: neutral, no sign and no arrow.
    expect(delta('errorRate').getAttribute('data-tone')).toBe('neutral');
    expect(delta('errorRate').textContent).toContain('0 pp');
    expect(delta('errorRate').textContent).not.toMatch(/[+\u2212]/);
    expect(q('svg', delta('errorRate'))).toBeNull();
    expect(q('svg', delta('requests'))).toBeNull();
  });

  it('says there is not enough data when there are fewer than two buckets', async () => {
    mounted = await mount(h(EntityHealthCharts, { series: series({ buckets: [{ t: FROM, requests: 3 }] }) }));
    await settle(20);
    expect(text()).toContain('Not enough data points to draw this chart yet.');
  });
});

describe('the agents list', () => {
  const healthBody = {
    range: { fromMs: FROM, toMs: FROM + 24 * HOUR, bucketMs: HOUR, sparkFromMs: FROM },
    total: 3,
    agents: [
      {
        name: 'Pulse Main',
        totals: { requests: 200, errors: 30, errorRate: 15, p95Ms: 4200, toolCalls: 10, toolErrorRate: 20, costUsd: 4.5 },
        previous: { requests: 100, errors: 3, errorRate: 3, p95Ms: 2000, toolErrorRate: 2 },
        spark: { requests: [1, 4, 2, 8], errorRate: [0, 10, null, 20], p95Ms: [1, 2, 3, 4] },
        alert: { phase: 'firing', severity: 'critical', incidentId: 'inc1' },
      },
      {
        name: 'support',
        totals: { requests: 50, errors: 0, errorRate: 0, p95Ms: 800, toolCalls: 0, toolErrorRate: null, costUsd: 0 },
        previous: null,
        spark: { requests: [1, 1], errorRate: [0, 0], p95Ms: [null, null] },
        alert: { phase: null },
      },
      {
        name: '50%off',
        totals: { requests: 5, errors: 0, errorRate: 0, p95Ms: 100, toolCalls: 0, toolErrorRate: null, costUsd: 0 },
        previous: null,
        spark: { requests: [], errorRate: [], p95Ms: [] },
        alert: { phase: 'pending' },
      },
    ],
  };
  const directoryBody = {
    total: 4,
    agents: [
      { name: 'Pulse Main', sessionsCount: 200, latestSessionAt: new Date().toISOString(), latestStatus: 'error' },
      { name: 'support', sessionsCount: 50, latestSessionAt: new Date().toISOString(), latestStatus: 'in_progress' },
      { name: '50%off', sessionsCount: 5, latestSessionAt: null, latestStatus: 'abandoned' },
      { name: 'old-agent', sessionsCount: 1, latestSessionAt: null, latestStatus: 'success' },
    ],
  };

  function mockAgents() {
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => healthBody],
      ['GET', '/api/tracing/agents', () => directoryBody],
    ]);
  }

  const names = () => qa('tbody tr').map((row) => row.querySelector('td a')?.textContent?.trim() ?? '');

  it('asks for the last day by default and lists every agent with health, deltas and the fixed statuses', async () => {
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);

    expect(api.to('GET', '/api/tracing/agents/health')[0]!.query).toMatchObject({ period: 'last_day', limit: '200' });
    expect(names()).toEqual(['Pulse Main', 'support', '50%off', 'old-agent']);

    const body = text();
    expect(body).toContain('Firing');
    expect(body).toContain('Critical');
    expect(body).toContain('Pending');
    expect(body).toContain('In progress'); // in_progress is read, not the old "running"
    expect(body).toContain('Abandoned');
    expect(body).toContain('+100%'); // sessions against the previous period
    expect(body).toContain('$4.50');

    // 15% is above 5% and more than 1.5x the previous 3%: flagged.
    expect(qa('[data-elevated="true"]')).toHaveLength(1);

    // A directory-only agent has no health data for the period.
    const old = qa('tbody tr').find((row) => row.textContent?.includes('old-agent'))!;
    expect(old.textContent).toContain('—');
  });

  it('writes the Trend header in the same case as the sortable ones', async () => {
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const headers = qa('thead th');
    const sortable = headers.find((th) => th.textContent?.includes('Sessions'))!;
    const trend = headers.find((th) => th.textContent?.trim() === 'Trend')!;
    expect(sortable.querySelector('button')).not.toBeNull();
    // The grid uppercases plain header text, buttons are exempt: the plain one opts out the same way.
    const label = trend.querySelector('span')!;
    expect(label.style.textTransform).toBe('none');
    expect(label.style.letterSpacing).toBe('normal');
  });

  it('tells an agent no rule covers from a healthy one, and an unreadable alert state from both', async () => {
    const body = {
      ...healthBody,
      alertsAvailable: true,
      agents: healthBody.agents.map((agent) => ({
        ...agent,
        alert: agent.name === 'support' ? { phase: null, covered: false } : { ...agent.alert, covered: true },
      })),
    };
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => body],
      ['GET', '/api/tracing/agents', () => directoryBody],
    ]);
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const row = (name: string) => qa('tbody tr').find((r) => r.textContent?.includes(name))!;
    expect(row('support').textContent).toContain('No alert rule');
    expect(row('support').textContent).not.toContain('OK');
    const link = row('support').querySelector('a.ds-badge')!;
    expect(new URL(link.getAttribute('href')!, 'http://x').searchParams.get('entityKey')).toBe('support');
    expect(q('[data-testid="agents-alerts-unavailable"]')).toBeNull();
  });

  it('shows OK for a covered agent without an alert, and keeps showing it for a server without the flags', async () => {
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => ({ ...healthBody, agents: [{ ...healthBody.agents[1]!, alert: { phase: null, covered: true } }] })],
      ['GET', '/api/tracing/agents', () => directoryBody],
    ]);
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const body = () => qa('tbody').map((el) => el.textContent ?? '').join(' ');
    expect(body()).toContain('OK');
    expect(body()).not.toContain('No alert rule');
    await mounted.unmount();
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    expect(qa('tbody tr').find((r) => r.textContent?.includes('support'))!.textContent).toContain('OK');
  });

  it('warns and shows Unknown instead of OK when the alerts could not be read', async () => {
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => ({
        ...healthBody,
        alertsAvailable: false,
        agents: healthBody.agents.map((agent) => ({ ...agent, alert: { phase: null, covered: true } })),
      })],
      ['GET', '/api/tracing/agents', () => directoryBody],
    ]);
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    expect(q('[data-testid="agents-alerts-unavailable"]')).not.toBeNull();
    const rows = qa('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.textContent).not.toContain('Firing');
    }
    for (const r of rows) expect(r.textContent).not.toMatch(/\bOK\b/);
    expect(rows.find((r) => r.textContent?.includes('support'))!.textContent).toContain('Unknown');
  });

  it('opens the agent with the period, the name encoded once', async () => {
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const hrefs = qa('tbody tr td a').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/dashboard/tracing/agents/50%25off?period=last_day');
    expect(hrefs).toContain('/dashboard/tracing/agents/Pulse%20Main?period=last_day');
    // The firing badge links to its incident.
    expect(hrefs).toContain('/dashboard/alerts/incidents/inc1');
  });

  it('keeps the period of the URL', async () => {
    nav.search = new URLSearchParams('period=last_7_days');
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    expect(api.to('GET', '/api/tracing/agents/health')[0]!.query.period).toBe('last_7_days');
  });

  it('sorts from the column headers, both ways', async () => {
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const header = (label: string) => qa<HTMLButtonElement>('thead button').find((b) => b.getAttribute('aria-label') === `Sort by ${label}`)!;

    await click(header('Error rate'));
    expect(names().slice(0, 3)).toEqual(['Pulse Main', '50%off', 'support']); // desc: 15, 0, 0 (name tie-break)
    await click(header('Error rate'));
    expect(names().slice(0, 3)).toEqual(['50%off', 'support', 'Pulse Main']); // asc
    expect(names()[3]).toBe('old-agent'); // no value: last either way

    await click(header('Agent'));
    expect(names()).toEqual(['50%off', 'old-agent', 'Pulse Main', 'support']);
    expect(header('Agent').getAttribute('data-sorted')).toBe('asc');
    // The sort state is spoken, and the buttons keep the browser focus outline.
    expect(header('Agent').textContent).toContain('sorted ascending');
    expect(header('Error rate').textContent).not.toContain('sorted');
    expect(header('Agent').style.outline).toBe('');
    expect(header('Agent').getAttribute('style') ?? '').not.toContain('all: unset');
  });

  it('filters by name search', async () => {
    mockAgents();
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    const search = q<HTMLInputElement>('input[placeholder="Search by agent name…"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(search, 'pulse');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(400);
    expect(names()).toEqual(['Pulse Main']);
  });

  it('shows the error with a retry, and the list still works without the directory', async () => {
    let healthFails = true;
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => (healthFails ? jsonResponse({ error: 'boom' }, 500) : healthBody)],
      ['GET', '/api/tracing/agents', () => jsonResponse({ error: 'slow' }, 500)],
    ]);
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    expect(text()).toContain('Could not load the agent health overview.');
    healthFails = false;
    await click(buttonByText('Try again'));
    await settle(50);
    expect(names()).toEqual(['Pulse Main', 'support', '50%off']);
  });

  it('tells the viewer the latest status is unavailable and drops the status filter', async () => {
    api = installApiMock([
      ['GET', '/api/tracing/agents/health', () => healthBody],
      ['GET', '/api/tracing/agents', () => jsonResponse({ error: 'directory down' }, 500)],
    ]);
    mounted = await mount(h(TracingAgentsPage));
    await settle(50);
    expect(q('[data-testid="agents-directory-error"]')).not.toBeNull();
    expect(text()).toContain('Latest status is unavailable right now');
    expect(q('[aria-label="Filter by latest status"]')).toBeNull();
    expect(names()).toEqual(['Pulse Main', 'support', '50%off']);
  });
});

describe('the sessions list', () => {
  const sessionsBody = { sessions: [], total: 0 };

  it('reads agent, status and time range from the URL and sends them to the API', async () => {
    const from = '2026-10-14T00:00:00.000Z';
    const to = '2026-10-15T00:00:00.000Z';
    nav.search = new URLSearchParams({ agent: 'Pulse Main', status: 'error', from, to });
    api = installApiMock([['GET', '/api/tracing/sessions', () => sessionsBody]]);
    mounted = await mount(h(TracingSessionsPage));
    await settle(50);
    const call = api.to('GET', '/api/tracing/sessions')[0]!;
    expect(call.query).toMatchObject({ agent: 'Pulse Main', status: 'error', from, to });
    expect(q('[data-testid="sessions-range-chip"]')).not.toBeNull();
  });

  it('ignores a status the filter does not offer and an unreadable date', async () => {
    nav.search = new URLSearchParams({ status: 'bogus', from: 'not-a-date' });
    api = installApiMock([['GET', '/api/tracing/sessions', () => sessionsBody]]);
    mounted = await mount(h(TracingSessionsPage));
    await settle(50);
    const call = api.to('GET', '/api/tracing/sessions')[0]!;
    expect(call.query.status).toBeUndefined();
    expect(call.query.from).toBeUndefined();
    expect(q('[data-testid="sessions-range-chip"]')).toBeNull();
  });

  it('keeps a typed metadata filter when the status changes and the URL follows', async () => {
    api = installApiMock([['GET', '/api/tracing/sessions', () => sessionsBody]]);
    // The router rewrites the URL: the next render sees the new search params.
    nav.replace.mockImplementation((url: string) => {
      nav.search = new URLSearchParams(url.split('?')[1] ?? '');
    });
    mounted = await mount(h(TracingSessionsPage));
    await settle(50);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const type = async (placeholder: string, value: string) => {
      const input = q<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await type('metadata key', 'tenant');
    await type('value', 'acme');
    await settle(50);
    expect(api.to('GET', '/api/tracing/sessions').at(-1)!.query).toMatchObject({ metadataKey: 'tenant', metadataValue: 'acme' });

    const statusSelect = q<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    await act(async () => {
      selectSetter.call(statusSelect, 'error');
      statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(50);

    expect(nav.replace).toHaveBeenCalled();
    expect(q<HTMLInputElement>('input[placeholder="metadata key"]')!.value).toBe('tenant');
    expect(q<HTMLInputElement>('input[placeholder="value"]')!.value).toBe('acme');
    const last = api.to('GET', '/api/tracing/sessions').at(-1)!;
    expect(last.query).toMatchObject({ status: 'error', metadataKey: 'tenant', metadataValue: 'acme' });
  });

  it('accepts abandoned and clears the range from the chip, in the URL too', async () => {
    nav.search = new URLSearchParams({ status: 'abandoned', from: '2026-10-14T00:00:00.000Z' });
    api = installApiMock([['GET', '/api/tracing/sessions', () => sessionsBody]]);
    mounted = await mount(h(TracingSessionsPage));
    await settle(50);
    expect(api.to('GET', '/api/tracing/sessions')[0]!.query.status).toBe('abandoned');
    await click(q('[data-testid="sessions-range-chip"] button'));
    await settle(50);
    expect(nav.replace).toHaveBeenCalled();
    const url = String(nav.replace.mock.calls.at(-1)![0]);
    expect(url).toContain('status=abandoned');
    expect(url).not.toContain('from=');
    const last = api.to('GET', '/api/tracing/sessions').at(-1)!;
    expect(last.query.from).toBeUndefined();
  });
});

describe('the sessions and threads lists speak Turkish', () => {
  it('has no English column, placeholder or footer left on the sessions list', async () => {
    api = installApiMock([['GET', '/api/tracing/sessions', () => ({ sessions: [], total: 0 })]]);
    mounted = await mount(h(TracingSessionsPage), 'tr');
    await settle(50);
    const body = text();
    expect(body).toContain('Oturum gezgini');
    expect(body).toContain('Oturum bulunamadı');
    expect(body).toContain('Trafikten anlık görüntü oluştur');
    expect(body).not.toContain('Session Explorer');
    expect(q('input[placeholder="meta veri anahtarı"]')).not.toBeNull();
  });

  it('has no English column, placeholder or footer left on the threads list', async () => {
    api = installApiMock([['GET', '/api/tracing/threads', () => ({ threads: [], total: 0 })]]);
    mounted = await mount(h(TracingThreadsPage), 'tr');
    await settle(50);
    const body = text();
    expect(body).toContain('Konuşma gezgini');
    expect(body).toContain('Konuşma bulunamadı');
    expect(body).not.toContain('Thread Explorer');
    expect(q('input[placeholder="Konuşma kimliğine göre ara…"]')).not.toBeNull();
  });
});
