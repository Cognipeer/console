// @vitest-environment jsdom
/**
 * The Activity section of a person's page: usage by service with the application tokens the calls came through, and the
 * recent actions with the token and the issuer behind a call made on the person's behalf.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installApiMock,
  installDomStubs,
  jsonResponse,
  mount,
  q,
  qa,
  settle,
  type ApiMock,
  type Mounted,
  type RouteHandler,
} from '../helpers/iamCenterUi';
import { CAPS_ADMIN, directoryRoutes, EMPTY_ACTIVITY } from '../helpers/iamDirectoryFixtures';
import { parsePersonActivity } from '@/components/iam/principals/directoryApi';

const nav = vi.hoisted(() => ({
  search: '',
  cache: new Map<string, URLSearchParams>(),
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    if (!nav.cache.has(nav.search)) nav.cache.set(nav.search, new URLSearchParams(nav.search));
    return nav.cache.get(nav.search)!;
  },
  useRouter: () => nav.router,
  usePathname: () => '/dashboard/iam',
}));

import PrincipalDetailPage from '@/components/iam/principals/PrincipalDetailPage';

let mounted: Mounted;
let api: ApiMock;

beforeAll(() => installDomStubs());
beforeEach(() => window.history.replaceState(null, '', '/dashboard/iam?tab=principals'));
afterEach(async () => {
  await mounted?.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nav.search = '';
});
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

const ACTIVITY_URL = /^\/api\/iam\/principals\/user\/u-ann\/activity$/;

async function open(activity: RouteHandler, locale = 'en') {
  nav.search = '';
  window.history.replaceState(null, '', '/dashboard/iam/principals/user/u-ann');
  api = installApiMock([...directoryRoutes(CAPS_ADMIN), ['GET', ACTIVITY_URL, activity]]);
  mounted = await mount(createElement(PrincipalDetailPage, { type: 'user', id: 'u-ann', canManage: true }), locale);
  await settle(300);
}
const section = () => q('[data-testid="section-activity"]');

const BUSY = {
  windowDays: 30,
  usageTruncated: false,
  usage: [
    { service: 'models', requests: 1234, errors: 3, totalTokens: 56789, costUsd: 1.5, lastDay: '2026-10-10', viaTokens: [{ id: 't-app', label: 'portal-backend', requests: 1000 }] },
    { service: 'rag', requests: 5, errors: 0, totalTokens: 0, costUsd: 0, lastDay: '2026-10-09', viaTokens: [] },
  ],
  events: [
    { id: 'e1', at: '2026-10-10T09:00:00.000Z', service: 'models', event: 'POST /api/client/v1/chat/completions', method: 'POST', path: '/api/client/v1/chat/completions', outcome: 'success', statusCode: 200, viaToken: { id: 't-app', label: 'portal-backend' }, via: { kind: 'delegated', issuer: 'https://idp.bank.example' } },
    { id: 'e2', at: '2026-10-09T09:00:00.000Z', service: 'agents', event: 'POST /api/agents', method: 'POST', path: '/api/agents', outcome: 'denied', statusCode: 403, decisionId: 'dec-9' },
  ],
  hasMoreEvents: true,
};

describe('the Activity section', () => {
  it('asks for the person\'s activity when the page opens, and shows nothing but empty notes for a quiet person', async () => {
    await open(() => EMPTY_ACTIVITY);
    expect(api.to('GET', ACTIVITY_URL)).toHaveLength(1);
    expect(section()?.textContent).toContain('Activity');
    expect(section()?.textContent).toContain('No calls in this period.');
    expect(section()?.textContent).toContain('No recorded actions in this period.');
  });

  it('shows usage by service with the application tokens, and the recent actions with who acted for them', async () => {
    await open(() => BUSY);
    const body = section()!.textContent!;
    expect(body).toContain('Usage in the last 30 days');
    expect(body).toContain('Model Hub');
    expect(body).toContain('1,234');
    expect(body).toContain('portal-backend · 1,000');
    expect(body).toContain('2026-10-10');
    const events = q('[data-testid="activity-events"]')!;
    expect(events.textContent).toContain('POST /api/client/v1/chat/completions');
    expect(events.textContent).toContain('via portal-backend');
    expect(events.textContent).toContain('Done');
    expect(events.textContent).toContain('POST /api/agents');
    expect(events.textContent).toContain('Refused');
    expect(body).toContain('There are more actions than shown');
    // a person's own call has no "via"
    expect(qa('[data-testid="activity-events"] > div')[1].textContent).not.toContain('via ');
  });

  it('says when it could not load, without hiding the rest of the page', async () => {
    await open(() => jsonResponse({ error: 'boom' }, 500));
    expect(section()?.textContent).toContain('The activity could not be loaded.');
    expect(document.body.textContent).toContain('Ann Lee');
  });

  it('speaks Turkish', async () => {
    await open(() => BUSY, 'tr');
    expect(section()?.textContent).toContain('Etkinlik');
    expect(section()?.textContent).toContain('Son 30 günde kullanım');
  });
});

describe('parsePersonActivity', () => {
  it('reads a payload tolerantly: unknown fields ignored, missing ones defaulted, rows without an id dropped', () => {
    const parsed = parsePersonActivity({
      windowDays: 7,
      usage: [{ service: 'models', requests: 2 }, { requests: 5 }, 'garbage'],
      events: [{ id: 'e1', at: '2026-10-10T00:00:00.000Z' }, { at: 'x' }, { id: 'e2' }],
      surprise: true,
    });
    expect(parsed.windowDays).toBe(7);
    expect(parsed.usage).toEqual([{ service: 'models', requests: 2, errors: 0, totalTokens: 0, costUsd: 0, lastDay: '', viaTokens: [] }]);
    expect(parsed.events).toEqual([{ id: 'e1', at: '2026-10-10T00:00:00.000Z', service: '', event: '', method: null, path: null, outcome: 'success', statusCode: null, decisionId: null, viaToken: null, issuer: null }]);
    expect(parsed.usageTruncated).toBe(false);
    expect(parsed.hasMoreEvents).toBe(false);
    expect(parsePersonActivity(null).windowDays).toBe(30);
  });
});
