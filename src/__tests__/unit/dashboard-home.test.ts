// @vitest-environment jsdom
/**
 * The dashboard home shows a person only what they can open and read in the ACTIVE project, and each block only when it
 * has something: the get-started steps of a new project, what needs attention (open incidents, with Alerts), the
 * services this browser opened last with the latest agent sessions (with Tracing), and the person's services, the
 * recently opened first. Numbers over time are in Reports: the home has no stat tiles, no date range and no pins. The
 * list of services it goes by is the navigation's (`GET /api/auth/session` -> `effectivePermissions`, as the engine
 * decides it).
 */
import { createElement, type ComponentProps } from 'react';
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
  type Mounted,
} from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard/overview',
}));

import DashboardOverviewPage from '@/app/dashboard/overview/page';
import { GetStarted } from '@/components/dashboard/GetStarted';
import {
  getStartedComplete,
  getStartedSteps,
  homeServices,
  recentlyOpenedServices,
  type OverviewStats,
} from '@/components/dashboard/overviewModel';
import type { IncidentDto } from '@/components/alerts/alertTypes';
import { LauncherProvider, type LauncherContextValue } from '@/components/layout/launcher/LauncherContext';
import { getDashboardServices } from '@/lib/utils/dashboardServices';
import type { ServicePermissionLevel } from '@/lib/security/rbac';

beforeAll(() => installDomStubs());

// These render whole component trees (jsdom + Mantine); on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mounted: Mounted;

beforeEach(() => {
  nav.params = new URLSearchParams();
  window.localStorage.clear();
});

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

const EMPTY: OverviewStats = {
  models: { total: 0, llm: 0, embedding: 0 },
  vectors: { providers: 0, indexes: 0 },
  tracing: { totalSessions: 0, totalTokens: 0, activeSessions: 0 },
  apiCalls: { total: 0, trend: 0 },
};

const ESTABLISHED: OverviewStats = {
  models: { total: 7, llm: 5, embedding: 2 },
  vectors: { providers: 2, indexes: 4 },
  tracing: { totalSessions: 31, totalTokens: 3_400_000, activeSessions: 1 },
  apiCalls: { total: 31, trend: 12.5 },
};

const SESSIONS = [
  { sessionId: 's-1', agentName: 'Help Center Assistant', status: 'completed', startedAt: new Date(Date.now() - 2 * 60_000).toISOString(), durationMs: 3200, totalTokens: 1180, totalEvents: 9 },
  { sessionId: 's/2', agentName: 'Orders Bot', status: 'error', startedAt: new Date(Date.now() - 14 * 60_000).toISOString(), durationMs: 800, totalTokens: 410, totalEvents: 3 },
];

const INCIDENT: IncidentDto = {
  _id: 'i1',
  ruleName: 'Agent error rate',
  ruleId: 'r1',
  alertEventId: 'e-i1',
  metric: 'agent_error_rate',
  threshold: 5,
  actualValue: 9.5,
  severity: 'critical',
  status: 'open',
  notes: [],
  firedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  entityType: 'agent',
  entityKey: 'refund-bot',
  module: 'agents',
  metadata: { operator: 'gt' },
};

const ALL: Levels = { models: 'write', prompts: 'read', agents: 'write', vector: 'read', rag: 'write', tracing: 'read' };

async function renderHome(
  levels: Levels,
  locale = 'en',
  options: {
    stats?: OverviewStats;
    sessions?: unknown[];
    recents?: string[];
    project?: string;
    incidents?: IncidentDto[];
    /** Answers `GET /api/dashboard` in place of the stats and sessions above. */
    dashboard?: () => unknown;
  } = {},
) {
  const api = installApiMock([
    [
      'GET',
      '/api/dashboard',
      options.dashboard ??
        (() => ({
          stats: options.stats ?? ESTABLISHED,
          recentActivity: [],
          recentSessions: options.sessions ?? [],
          daily: [],
          user: { email: 'ann@acme.test', licenseType: 'ENTERPRISE' },
        })),
    ],
    ['GET', '/api/alerts/incidents', () => ({ incidents: options.incidents ?? [], openCount: options.incidents?.length ?? 0 })],
  ]);
  if (options.project) {
    api.on('GET', '/api/projects', () => ({ projects: [{ _id: 'p1', name: options.project, key: 'cs' }], activeProjectId: 'p1' }));
  }
  const services = offeredTo(levels);
  const value: LauncherContextValue = {
    pinned: new Set(),
    recents: options.recents ?? [],
    togglePin: () => {},
    recordVisit: () => {},
    services,
    pinnedServices: [],
    recentServices: [],
    isTenantAdmin: false,
    openLauncher: () => {},
    hydrated: true,
  };
  mounted = await mount(createElement(LauncherProvider, { value } as ComponentProps<typeof LauncherProvider>, createElement(DashboardOverviewPage)), locale);
  await settle(100);
  return api;
}

const hrefs = (scope: ParentNode | null = document.body) =>
  qa<HTMLAnchorElement>('a', scope ?? undefined).map((a) => a.getAttribute('href'));
const stepIds = () => qa('[data-testid="get-started"] li').map((li) => li.getAttribute('data-step'));
const block = (id: string) => q(`[data-testid="${id}"]`);

describe('recentlyOpenedServices and homeServices', () => {
  const service = (id: string, extra: { defaultPinned?: boolean; isSettings?: boolean } = {}) => ({
    id,
    href: `/dashboard/${id}`,
    ...extra,
  });
  const SERVICES = [
    service('services-home'),
    service('models', { defaultPinned: true }),
    service('prompts', { defaultPinned: true }),
    service('vector'),
    service('agents', { defaultPinned: true }),
    service('tracing'),
    service('cost'),
    service('alerts'),
    service('tokens', { isSettings: true }),
  ];
  const ids = (list: Array<{ id: string }>) => list.map((s) => s.id);

  it('keeps the services opened last that the person can still open, the latest first, without Settings', () => {
    expect(ids(recentlyOpenedServices(SERVICES, ['tracing', 'tokens', 'gone', 'models']))).toEqual(['tracing', 'models']);
    expect(recentlyOpenedServices(SERVICES, [])).toEqual([]);
  });

  it('lists the recently opened first, then the usual ones, then the others, up to six', () => {
    const fresh = homeServices(SERVICES, []);
    expect(ids(fresh.shown)).toEqual(['models', 'prompts', 'agents', 'vector', 'tracing', 'cost']);
    expect(fresh.more).toBe(1);
    const used = homeServices(SERVICES, ['cost', 'agents']);
    expect(ids(used.shown)).toEqual(['cost', 'agents', 'models', 'prompts', 'vector', 'tracing']);
    expect(used.more).toBe(1);
  });

  it('shows them all when there are six or fewer, never Home itself nor a Settings page', () => {
    const few = homeServices(
      SERVICES.filter((s) => ['services-home', 'agents', 'prompts', 'tokens'].includes(s.id)),
      [],
    );
    expect(ids(few.shown)).toEqual(['prompts', 'agents']);
    expect(few.more).toBe(0);
  });
});

describe('getStartedSteps', () => {
  const service = (id: string, href = `/dashboard/${id}`) => ({ id, href });
  const everything = ['models', 'vector', 'rag', 'agents', 'tracing'].map((id) => service(id));

  it('ticks each step from what the project already has', () => {
    expect(getStartedSteps(everything, EMPTY)).toEqual([
      { id: 'model', href: '/dashboard/models', done: false, optional: false },
      { id: 'knowledge', href: '/dashboard/rag', done: false, optional: true },
      { id: 'agent', href: '/dashboard/agents', done: false, optional: false },
    ]);
    expect(getStartedSteps(everything, ESTABLISHED).map((s) => s.done)).toEqual([true, true, true]);
    // Knowledge needs both an embedding model and an index.
    const embeddingOnly = { ...EMPTY, models: { total: 1, llm: 0, embedding: 1 } };
    expect(getStartedSteps(everything, embeddingOnly)[1].done).toBe(false);
  });

  it('leaves out a step whose service the person cannot open, or whose progress they cannot read', () => {
    const ids = (offered: string[]) => getStartedSteps(offered.map((id) => service(id)), EMPTY).map((s) => s.id);
    expect(ids(['agents'])).toEqual([]); // no Tracing: the first session could never tick it
    expect(ids(['agents', 'tracing'])).toEqual(['agent']);
    expect(ids(['models', 'rag'])).toEqual(['model']); // no Vector: the index count is not readable
    expect(ids(['vector', 'rag', 'agents', 'tracing'])).toEqual(['agent']);
    expect(ids(['prompts', 'cost'])).toEqual([]);
  });

  it('sends knowledge to Vector when Knowledge Engine cannot be opened, and links where the navigation does', () => {
    const steps = getStartedSteps([service('models', '/somewhere/models'), service('vector')], EMPTY);
    expect(steps.map((s) => s.href)).toEqual(['/somewhere/models', '/dashboard/vector']);
  });

  it('is complete once every step that is not optional is done', () => {
    const steps = getStartedSteps(everything, { ...ESTABLISHED, models: { total: 5, llm: 5, embedding: 0 } });
    expect(steps.map((s) => s.done)).toEqual([true, false, true]);
    expect(getStartedComplete(steps)).toBe(true);
    expect(getStartedComplete(getStartedSteps(everything, EMPTY))).toBe(false);
    expect(getStartedComplete([])).toBe(true);
  });
});

describe('GetStarted', () => {
  const steps = getStartedSteps(
    ['models', 'vector', 'rag', 'agents', 'tracing'].map((id) => ({ id, href: `/dashboard/${id}` })),
    { ...EMPTY, models: { total: 1, llm: 1, embedding: 0 } },
  );

  it('lists the steps with their progress, and the next one leads', async () => {
    const onHide = vi.fn();
    mounted = await mount(createElement(GetStarted, { steps, onHide }));
    expect(text()).toContain('Get started');
    expect(text()).toContain('1 of 3 done');
    expect(stepIds()).toEqual(['model', 'knowledge', 'agent']);
    expect(q('[data-step="model"]')?.textContent).toContain('Done');
    expect(q('[data-step="knowledge"]')?.textContent).toContain('optional');
    expect(hrefs(q('[data-testid="get-started"]')!)).toEqual(['/dashboard/rag', '/dashboard/agents']);
    await click(buttonByText('Hide'));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it('is worded in Turkish when the console is', async () => {
    mounted = await mount(createElement(GetStarted, { steps, onHide: () => {} }), 'tr');
    expect(text()).toContain('Başlayın');
    expect(text()).toContain('1/3 tamamlandı');
    expect(text()).toContain('Bir model bağlayın');
    expect(text()).toContain('Gizle');
    expect(text()).not.toMatch(/dashboardOverview\./);
  });

  it('shows nothing when there is no step', async () => {
    mounted = await mount(createElement(GetStarted, { steps: [], onHide: () => {} }));
    expect(q('[data-testid="get-started"]')).toBeNull();
  });
});

describe('the dashboard home: get started', () => {
  it('leads a new project with the steps, above everything else', async () => {
    await renderHome(ALL, 'en', { stats: EMPTY, recents: ['agents'] });
    expect(stepIds()).toEqual(['model', 'knowledge', 'agent']);
    expect(text()).toContain('0 of 3 done');
    const getStarted = q('[data-testid="get-started"]')!;
    expect(getStarted.compareDocumentPosition(block('home-pick-up')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hrefs(getStarted)).toEqual(['/dashboard/models', '/dashboard/rag', '/dashboard/agents']);
  });

  it('is gone once the project has a model and a first agent session', async () => {
    await renderHome(ALL, 'en', { stats: { ...ESTABLISHED, models: { total: 5, llm: 5, embedding: 0 } } });
    expect(q('[data-testid="get-started"]')).toBeNull();
  });

  it('stays hidden in this browser once the person hides it', async () => {
    await renderHome(ALL, 'en', { stats: EMPTY });
    await click(buttonByText('Hide'));
    expect(q('[data-testid="get-started"]')).toBeNull();
    await mounted.unmount();
    await renderHome(ALL, 'en', { stats: EMPTY });
    expect(q('[data-testid="get-started"]')).toBeNull();
  });

  it('reads the whole project: the home has no date range, and one in the address changes nothing', async () => {
    nav.params = new URLSearchParams('period=last_7_days');
    const api = await renderHome(ALL, 'en', { stats: EMPTY });
    expect(api.to('GET', '/api/dashboard').map((call) => call.query)).toEqual([{ period: 'total' }]);
    expect(stepIds()).toEqual(['model', 'knowledge', 'agent']);
  });

  it('offers only the steps a person can open and tick', async () => {
    await renderHome({ agents: 'write', prompts: 'read', rag: 'read' }, 'en', { stats: EMPTY });
    expect(q('[data-testid="get-started"]')).toBeNull();
    await mounted.unmount();
    await renderHome({ agents: 'write', tracing: 'read' }, 'en', { stats: EMPTY });
    expect(stepIds()).toEqual(['agent']);
  });
});

describe('the dashboard home: what needs attention', () => {
  it('shows the open incidents, and only while there are some', async () => {
    await renderHome({ ...ALL, alerts: 'read' }, 'en', { incidents: [INCIDENT] });
    const attention = block('home-attention')!;
    expect(attention.querySelector('[data-testid="active-incidents-card"]')?.textContent).toContain('Agent error rate');
    expect(hrefs(attention)).toContain('/dashboard/alerts/incidents/i1');
    await mounted.unmount();
    await renderHome({ ...ALL, alerts: 'read' }, 'en', { incidents: [] });
    expect(block('home-attention')!.childElementCount).toBe(0);
  });

  it('asks nothing without Alerts', async () => {
    const api = await renderHome(ALL);
    expect(api.to('GET', '/api/alerts/incidents')).toHaveLength(0);
    expect(block('home-attention')!.childElementCount).toBe(0);
  });
});

describe('the dashboard home: pick up where you left off', () => {
  it('lists the services opened last, then the latest agent sessions, each a link', async () => {
    await renderHome(ALL, 'en', { recents: ['rag', 'models'], sessions: SESSIONS });
    expect(hrefs(block('recently-opened'))).toEqual(['/dashboard/rag', '/dashboard/models']);
    const sessions = block('home-sessions')!;
    expect(sessions.textContent).toContain('Help Center Assistant');
    expect(sessions.textContent).toContain('3.2 s · 1,180 tokens');
    expect(sessions.textContent).toContain('2m ago');
    expect(sessions.textContent).not.toContain('/api/tracing');
    expect(hrefs(sessions)).toEqual(['/dashboard/tracing', '/dashboard/tracing/sessions/s-1', '/dashboard/tracing/sessions/s%2F2']);
  });

  it('leaves out a service the person can no longer open', async () => {
    await renderHome(ALL, 'en', { recents: ['cost', 'agents'] });
    expect(hrefs(block('recently-opened'))).toEqual(['/dashboard/agents']);
  });

  it('leaves the sessions out without Tracing', async () => {
    await renderHome({ prompts: 'read', agents: 'read' }, 'en', { recents: ['agents'], sessions: SESSIONS });
    expect(block('home-sessions')).toBeNull();
    expect(hrefs()).not.toContain('/dashboard/tracing');
    expect(hrefs(block('recently-opened'))).toEqual(['/dashboard/agents']);
  });

  it('is not there when there is nothing to pick up', async () => {
    await renderHome(ALL, 'en', { recents: [], sessions: [] });
    expect(block('home-pick-up')).toBeNull();
  });

  it('says so when the sessions could not be loaded, and tries again', async () => {
    let calls = 0;
    await renderHome(ALL, 'en', {
      dashboard: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ error: 'boom' }, 500)
          : { stats: ESTABLISHED, recentSessions: SESSIONS, user: { email: 'ann@acme.test', licenseType: 'ENTERPRISE' } };
      },
    });
    expect(block('home-sessions')!.textContent).toContain('Couldn’t load recent activity.');
    await click(buttonByText('Retry'));
    await settle(100);
    expect(block('home-sessions')!.textContent).toContain('Help Center Assistant');
  });
});

describe('the dashboard home: your services', () => {
  it('puts the counts on the cards of the services the page has numbers for, and what the others are for', async () => {
    await renderHome(ALL);
    const services = block('home-services')!;
    const countsOf = (id: string) => services.querySelector(`[data-counts="${id}"]`)?.textContent;
    expect(countsOf('models')).toBe('5 LLM · 2 embedding');
    expect(countsOf('vector')).toBe('4 indexes');
    expect(countsOf('tracing')).toBe('31 sessions');
    expect(countsOf('agents')).toBeUndefined();
    expect(hrefs(services)).toContain('/dashboard/agents');
  });

  it('lists the recently opened first, at most six; the others are in the menu', async () => {
    await renderHome({ ...ALL, cost: 'read', alerts: 'read', guardrails: 'read' }, 'en', { recents: ['tracing', 'rag'] });
    const links = hrefs(block('home-services'));
    expect(links).toHaveLength(6);
    expect(links.slice(0, 2)).toEqual(['/dashboard/tracing', '/dashboard/rag']);
    expect(links).not.toContain('/dashboard/cost');
    expect(block('home-services')!.textContent).toContain('3 more in the menu');
  });

  it('has nothing to pin or add', async () => {
    await renderHome(ALL);
    for (const words of ['Pin more', 'Add service', 'pinned']) expect(text(), words).not.toContain(words);
  });
});

describe('the dashboard home: what it leaves to Reports and the menu', () => {
  it('has no stat tiles, no quick deploy and no resources', async () => {
    await renderHome(ALL);
    expect(q('.ds-stat-grid')).toBeNull();
    for (const words of ['Deploy model', 'Resources', 'API Documentation', 'License', 'Tokens']) {
      expect(text(), words).not.toContain(words);
    }
  });

  it('names the project under the greeting', async () => {
    await renderHome(ALL, 'en', { project: 'Customer Support' });
    expect(block('home-project')?.textContent).toBe('Project: Customer Support');
    await mounted.unmount();
    await renderHome(ALL, 'tr', { project: 'Müşteri Destek' });
    expect(block('home-project')?.textContent).toBe('Proje: Müşteri Destek');
  });
});

describe('the dashboard home, in both languages', () => {
  it('reads in English', async () => {
    await renderHome(ALL, 'en', { recents: ['agents'], sessions: SESSIONS, stats: EMPTY });
    const t = text();
    for (const words of [
      'Welcome back, ann', 'Get started', 'Connect a model', 'Pick up where you left off', 'Recently opened',
      'Recent agent sessions', 'View all in Tracing', 'Your services',
    ]) {
      expect(t, words).toContain(words);
    }
  });

  it('reads in Turkish, with nothing left in English', async () => {
    await renderHome(ALL, 'tr', { recents: ['agents'], sessions: SESSIONS, stats: EMPTY });
    const t = text();
    for (const words of [
      'Tekrar hoş geldiniz, ann', 'Başlayın', 'Bir model bağlayın', 'Kaldığınız yerden devam edin', 'Son açılanlar',
      'Son ajan oturumları', 'Servisleriniz', '2 dk önce',
    ]) {
      expect(t, words).toContain(words);
    }
    for (const words of [
      'Welcome back', 'Get started', 'Your services', 'Pick up', 'Recently opened', 'Recent agent sessions', 'View all',
      'ago',
    ]) {
      expect(t, words).not.toContain(words);
    }
    expect(t).not.toMatch(/dashboardOverview\./);
  });
});
