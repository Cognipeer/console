// @vitest-environment jsdom
/**
 * The dashboard home (Overview) shows a person only what they can open and read in the ACTIVE project: a stat
 * tile only for a service whose number they can read (the API sends 0 for the others), the get-started steps only
 * for services they can open and whose progress they can read, the recent agent sessions only with Tracing, and no
 * link into a service they cannot open. The list of services it goes by is the navigation's
 * (`GET /api/auth/session` -> `effectivePermissions`, as the engine decides it).
 */
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buttonByText,
  click,
  installApiMock,
  installDomStubs,
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
  dailyLine,
  getStartedComplete,
  getStartedSteps,
  overviewTiles,
  type OverviewStats,
} from '@/components/dashboard/overviewModel';
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

const DAILY = [
  { date: '2026-11-05', sessionsCount: 10, totalTokens: 1_000_000 },
  { date: '2026-11-06', sessionsCount: 21, totalTokens: 2_400_000 },
];

const ALL: Levels = { models: 'write', prompts: 'read', agents: 'write', vector: 'read', rag: 'write', tracing: 'read' };

async function renderHome(
  levels: Levels,
  locale = 'en',
  options: { stats?: OverviewStats; sessions?: unknown[]; daily?: unknown[]; pinned?: number | string[]; recents?: string[]; project?: string } = {},
) {
  const api = installApiMock([
    ['GET', '/api/dashboard', () => ({
      stats: options.stats ?? ESTABLISHED,
      recentActivity: [],
      recentSessions: options.sessions ?? [],
      daily: options.daily ?? [],
      user: { email: 'ann@acme.test', licenseType: 'ENTERPRISE' },
    })],
    ['GET', '/api/alerts/incidents', () => ({ incidents: [] })],
  ]);
  if (options.project) {
    api.on('GET', '/api/projects', () => ({ projects: [{ _id: 'p1', name: options.project, key: 'cs' }], activeProjectId: 'p1' }));
  }
  const services = offeredTo(levels);
  const value: LauncherContextValue = {
    pinned: new Set(),
    recents: [],
    togglePin: () => {},
    recordVisit: () => {},
    services,
    pinnedServices: Array.isArray(options.pinned)
      ? services.filter((s) => (options.pinned as string[]).includes(String(s.id)))
      : services.slice(0, options.pinned ?? 0),
    recentServices: services.filter((s) => (options.recents ?? []).includes(String(s.id))),
    isTenantAdmin: false,
    openLauncher: () => {},
    hydrated: true,
  };
  mounted = await mount(createElement(LauncherProvider, { value } as ComponentProps<typeof LauncherProvider>, createElement(DashboardOverviewPage)), locale);
  await settle(100);
  return api;
}

const hrefs = (scope: ParentNode = document.body) => qa<HTMLAnchorElement>('a', scope).map((a) => a.getAttribute('href'));
const tileLabels = () => qa('.ds-stat-label').map((el) => el.textContent ?? '');
const stepIds = () => qa('[data-testid="get-started"] li').map((li) => li.getAttribute('data-step'));
const card = (heading: string) => qa('.ds-card').find((el) => el.querySelector('.ds-h3')?.textContent === heading);

describe('overviewTiles', () => {
  it('has a tile only for a service whose number the person can read', () => {
    expect(overviewTiles(new Set(['tracing', 'models', 'vector']))).toEqual(['sessions', 'tokens', 'models', 'indexes']);
    expect(overviewTiles(new Set(['tracing']))).toEqual(['sessions', 'tokens']);
    expect(overviewTiles(new Set(['vector', 'agents']))).toEqual(['indexes']);
    expect(overviewTiles(new Set(['agents', 'prompts']))).toEqual([]);
  });
});

describe('dailyLine', () => {
  it('draws the daily series the API returns, and nothing for fewer than two days', () => {
    expect(dailyLine(DAILY, 'sessionsCount')).toEqual([10, 21]);
    expect(dailyLine(DAILY, 'totalTokens')).toEqual([1_000_000, 2_400_000]);
    expect(dailyLine(DAILY.slice(0, 1), 'sessionsCount')).toBeUndefined();
    expect(dailyLine(undefined, 'sessionsCount')).toBeUndefined();
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
  it('leads a new project with the steps, above the numbers', async () => {
    await renderHome(ALL, 'en', { stats: EMPTY });
    expect(stepIds()).toEqual(['model', 'knowledge', 'agent']);
    expect(text()).toContain('0 of 3 done');
    const getStarted = q('[data-testid="get-started"]')!;
    const tiles = q('.ds-stat-grid')!;
    expect(getStarted.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('is not shown under a date range, whose counts do not cover the whole project', async () => {
    nav.params = new URLSearchParams('period=last_7_days');
    await renderHome(ALL, 'en', { stats: EMPTY });
    expect(q('[data-testid="get-started"]')).toBeNull();
  });

  it('offers only the steps a person can open and tick', async () => {
    await renderHome({ agents: 'write', prompts: 'read', rag: 'read' }, 'en', { stats: EMPTY });
    expect(q('[data-testid="get-started"]')).toBeNull();
    await mounted.unmount();
    await renderHome({ agents: 'write', tracing: 'read' }, 'en', { stats: EMPTY });
    expect(stepIds()).toEqual(['agent']);
  });
});

describe('the dashboard home: numbers', () => {
  it('shows the four tiles to someone who can read all of their services, with the real daily lines', async () => {
    await renderHome(ALL, 'en', { daily: DAILY });
    expect(tileLabels()).toEqual(['Agent sessions', 'Tokens', 'Models', 'Vector indexes']);
    const tiles = qa('.ds-stat');
    expect(tiles[0].textContent).toContain('31');
    expect(tiles[0].textContent).toContain('+12.5% vs previous 7 days');
    expect(tiles[1].textContent).toContain('3.4M');
    expect(tiles[2].textContent).toContain('5 LLM · 2 embedding');
    expect(tiles[3].textContent).toContain('2 providers');
    // Lines only where there is a series: sessions and tokens.
    expect(tiles.map((tile) => Boolean(tile.querySelector('.ds-stat-spark')))).toEqual([true, true, false, false]);
  });

  it('draws no line without at least two days of data', async () => {
    await renderHome(ALL, 'en', { daily: DAILY.slice(0, 1) });
    expect(q('.ds-stat-spark')).toBeNull();
  });

  it('shows no tile, and no zero, for a service the person cannot read', async () => {
    await renderHome({ tracing: 'read', prompts: 'read' });
    expect(tileLabels()).toEqual(['Agent sessions', 'Tokens']);
    await mounted.unmount();
    await renderHome({ prompts: 'read', agents: 'read' });
    expect(q('.ds-stat-grid')).toBeNull();
    expect(text()).not.toContain('Deploy model');
  });

  it('marks the stat tiles as Turkish, for their upper-cased labels', async () => {
    await renderHome(ALL, 'tr');
    expect(q('.ds-stat-label')?.closest('[lang]')?.getAttribute('lang')).toBe('tr');
    expect(tileLabels()).toEqual(['Ajan oturumları', 'Token', 'Modeller', 'Vektör indeksleri']);
  });
});

describe('the dashboard home: sessions, services and resources', () => {
  it('lists the latest agent sessions, each a link to its session', async () => {
    await renderHome(ALL, 'en', { sessions: SESSIONS });
    const sessions = card('Recent agent sessions')!;
    expect(sessions.textContent).toContain('Help Center Assistant');
    expect(sessions.textContent).toContain('3.2 s · 1,180 tokens');
    expect(sessions.textContent).toContain('2m ago');
    expect(sessions.textContent).not.toContain('/api/tracing');
    expect(hrefs(sessions)).toEqual(['/dashboard/tracing', '/dashboard/tracing/sessions/s-1', '/dashboard/tracing/sessions/s%2F2']);
  });

  it('leaves the sessions out without Tracing, and the resources take the row', async () => {
    await renderHome({ prompts: 'read', agents: 'read' });
    expect(card('Recent agent sessions')).toBeUndefined();
    expect(hrefs()).not.toContain('/dashboard/tracing');
    expect(card('Resources')!.style.gridColumn).toBe('1 / -1');
  });

  it('puts the counts on the service cards and lists recently opened services', async () => {
    await renderHome(ALL, 'en', { pinned: ['models', 'vector', 'tracing', 'agents'], recents: ['rag', 'models'] });
    const services = card('Your services')!;
    const countsOf = (id: string) => services.querySelector(`[data-counts="${id}"]`)?.textContent;
    expect(countsOf('models')).toBe('5 LLM · 2 embedding');
    expect(countsOf('vector')).toBe('4 indexes');
    expect(countsOf('tracing')).toBe('31 sessions');
    expect(countsOf('agents')).toBeUndefined();
    // Recently opened: the ones not already pinned.
    expect(hrefs(q('[data-testid="recently-opened"]')!)).toEqual(['/dashboard/rag']);
    expect(text()).not.toContain('Top resources');
  });

  it('links to Alerts only for someone who can open it, and names the license', async () => {
    await renderHome(ALL);
    expect(hrefs(card('Resources')!)).not.toContain('/dashboard/alerts');
    expect(card('Resources')!.textContent).toContain('ENTERPRISE');
    await mounted.unmount();
    await renderHome({ ...ALL, alerts: 'read' });
    expect(hrefs(card('Resources')!)).toContain('/dashboard/alerts');
  });

  it('says which project and period the numbers cover', async () => {
    await renderHome(ALL, 'en', { project: 'Customer Support' });
    expect(q('[data-testid="overview-scope"]')?.textContent).toBe('Customer Support · All time');
    await mounted.unmount();
    nav.params = new URLSearchParams('period=last_7_days');
    await renderHome(ALL, 'tr', { project: 'Müşteri Destek' });
    expect(q('[data-testid="overview-scope"]')?.textContent).toBe('Müşteri Destek · Son 7 gün');
  });
});

describe('the dashboard home, in both languages', () => {
  it('reads in English', async () => {
    await renderHome(ALL, 'en', { pinned: 2, sessions: SESSIONS, stats: EMPTY });
    const t = text();
    for (const words of [
      'Welcome back, ann', 'Deploy model', 'Get started', 'Connect a model', 'Your services', '2 pinned · ', 'Pin more',
      'Add service', 'Recent agent sessions', 'View all in Tracing', 'Resources', 'API Documentation', 'License',
    ]) {
      expect(t, words).toContain(words);
    }
  });

  it('reads in Turkish, with nothing left in English', async () => {
    await renderHome(ALL, 'tr', { pinned: 2, sessions: SESSIONS, stats: EMPTY });
    const t = text();
    for (const words of [
      'Tekrar hoş geldiniz, ann', 'Model dağıt', 'Başlayın', 'Bir model bağlayın', 'Servisleriniz', '2 sabitlenmiş · ',
      'Daha fazla sabitle', 'Servis ekle', 'Son ajan oturumları', 'Kaynaklar', 'API dokümantasyonu', 'Lisans', '2 dk önce',
    ]) {
      expect(t, words).toContain(words);
    }
    for (const words of [
      'Welcome back', 'Deploy model', 'Get started', 'Your services', 'Pin more', 'Recent agent sessions', 'View all', 'ago',
      'API Documentation', 'License',
    ]) {
      expect(t, words).not.toContain(words);
    }
    expect(t).not.toMatch(/dashboardOverview\./);
  });
});
