// @vitest-environment jsdom
/**
 * Breadcrumb labels of the dashboard: a dynamic segment is named by the entity behind
 * it, not shown as its id. A portal's page is /dashboard/portals/:id; its name comes
 * from the summary view of the portal (`?view=summary` - the full detail reads a week
 * of conversations and must not be fetched for a label), the static "Portals" crumb is
 * translated, and a name that cannot be had falls back to the segment itself.
 */

import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDomStubs, mount, settle, text, type Mounted } from '../helpers/iamCenterUi';

const nav = vi.hoisted(() => ({ pathname: '/dashboard' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import DashboardBreadcrumbs from '@/components/layout/DashboardBreadcrumbs';
import { BREADCRUMB_RESOLVERS, type ResolveContext } from '@/components/layout/breadcrumbResolvers';

const PORTAL_ID = 'vn25zpgz';
const SUMMARY_URL = `/api/portals/${PORTAL_ID}?view=summary`;

const resolver = () => {
  const found = BREADCRUMB_RESOLVERS.find((r) => r.id === 'standard:portals');
  if (!found) throw new Error('no resolver for the portals pages');
  return found;
};
const contextFor = (path: string, cache = new Map<string, string>()): ResolveContext => ({
  segments: path.split('/').filter(Boolean),
  cache,
});

type Answer = { ok: boolean; status?: number; body?: unknown } | Error;
let answers: Record<string, Answer>;
let fetched: string[];

/** A `fetch` that answers only what the test planted and records what was asked. */
function stubFetch() {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    const answer = answers[url] ?? { ok: false, status: 404 };
    if (answer instanceof Error) throw answer;
    return { ok: answer.ok, status: answer.status ?? (answer.ok ? 200 : 404), json: async () => answer.body };
  });
}

beforeAll(() => installDomStubs());
beforeEach(() => {
  answers = {};
  fetched = [];
  stubFetch();
  nav.pathname = '/dashboard';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the portals resolver', () => {
  it('names the portal of /dashboard/portals/:id by its summary', async () => {
    answers[SUMMARY_URL] = { ok: true, body: { portal: { id: PORTAL_ID, key: 'branch', name: 'Branch assistant', status: 'enabled' } } };
    expect(await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}`))).toEqual([{ index: 2, label: 'Branch assistant' }]);
    expect(fetched).toEqual([SUMMARY_URL]); // the summary view only, never the full detail
  });

  it('also names the pages below the portal (the id is still segment 2)', async () => {
    answers[SUMMARY_URL] = { ok: true, body: { portal: { name: 'Branch assistant' } } };
    expect(await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}/anything`))).toEqual([{ index: 2, label: 'Branch assistant' }]);
  });

  it('falls back to the key when the portal has no name', async () => {
    answers[SUMMARY_URL] = { ok: true, body: { portal: { key: 'branch' } } };
    expect(await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}`))).toEqual([{ index: 2, label: 'branch' }]);
  });

  it('leaves the new-portal page alone and asks for nothing', async () => {
    expect(await resolver().resolve(contextFor('/dashboard/portals/new'))).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('gives no label - so the segment stays as it is - when the portal cannot be fetched', async () => {
    const ctx = () => contextFor(`/dashboard/portals/${PORTAL_ID}`);
    answers[SUMMARY_URL] = { ok: false, status: 404 };
    expect(await resolver().resolve(ctx())).toEqual([]);
    answers[SUMMARY_URL] = { ok: false, status: 403 };
    expect(await resolver().resolve(ctx())).toEqual([]);
    answers[SUMMARY_URL] = new Error('network down');
    expect(await resolver().resolve(ctx())).toEqual([]);
    answers[SUMMARY_URL] = { ok: true, body: {} };
    expect(await resolver().resolve(ctx())).toEqual([]);
    answers[SUMMARY_URL] = { ok: true, body: { portal: { name: '' } } };
    expect(await resolver().resolve(ctx())).toEqual([]);
  });

  it('reads the portal once per session and tries again after a failure', async () => {
    const cache = new Map<string, string>();
    answers[SUMMARY_URL] = { ok: false, status: 500 };
    expect(await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}`, cache))).toEqual([]);
    answers[SUMMARY_URL] = { ok: true, body: { portal: { name: 'Branch assistant' } } };
    expect(await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}`, cache))).toEqual([{ index: 2, label: 'Branch assistant' }]);
    await resolver().resolve(contextFor(`/dashboard/portals/${PORTAL_ID}`, cache));
    expect(fetched).toEqual([SUMMARY_URL, SUMMARY_URL]); // not a third time
  });

  it('keeps to its own pages', async () => {
    for (const path of ['/dashboard/portals', '/dashboard/agents/abc', '/dashboard', '/portals/abc']) {
      expect(await resolver().resolve(contextFor(path)), path).toEqual([]);
    }
    expect(fetched).toEqual([]);
  });
});

describe('the breadcrumb of a portal page', () => {
  let mounted: Mounted;
  afterEach(async () => {
    await mounted?.unmount();
  });

  const render = async (path: string, locale = 'en') => {
    nav.pathname = path;
    mounted = await mount(createElement(DashboardBreadcrumbs), locale);
    await settle(50);
  };

  it('shows the name of the portal, in the crumb and in the browser tab title', async () => {
    answers[SUMMARY_URL] = { ok: true, body: { portal: { name: 'Branch assistant' } } };
    await render(`/dashboard/portals/${PORTAL_ID}`);
    expect(text()).toContain('Portals');
    expect(text()).toContain('Branch assistant');
    expect(text()).not.toContain('Vn25zpgz');
    expect(document.title).toBe('Branch assistant · Portals - Cognipeer Console');
  });

  it('shows the translated "Portals" crumb', async () => {
    answers[SUMMARY_URL] = { ok: true, body: { portal: { name: 'Şube asistanı' } } };
    await render(`/dashboard/portals/${PORTAL_ID}`, 'tr');
    expect(text()).toContain('Portallar');
    expect(text()).toContain('Şube asistanı');
    expect(document.title).toBe('Şube asistanı · Portallar - Cognipeer Console');
  });

  it('shows the segment itself when the name cannot be had', async () => {
    await render(`/dashboard/portals/${PORTAL_ID}`);
    expect(text()).toContain('Portals');
    expect(text()).toContain('Vn25zpgz');
    expect(document.title).toBe('Vn25zpgz · Portals - Cognipeer Console');
  });

  it('shows "New" on the new-portal page without asking for a portal', async () => {
    await render('/dashboard/portals/new');
    expect(text()).toContain('Portals');
    expect(text()).toContain('New');
    expect(fetched).toEqual([]);
  });

  it('names the portals list in Turkish as well', async () => {
    await render('/dashboard/portals', 'tr');
    expect(text()).toContain('Portallar');
    expect(text()).not.toContain('Portals');
  });
});

describe('the connectors resolver', () => {
  const CONNECTOR_ID = '66f1c0de5e1a2b3c4d5e6f70';
  const CONNECTOR_URL = `/api/connectors/${CONNECTOR_ID}`;

  const connectorsResolver = () => {
    const found = BREADCRUMB_RESOLVERS.find((r) => r.id === 'standard:connectors');
    if (!found) throw new Error('no resolver for the connectors pages');
    return found;
  };

  it('names the connector of /dashboard/connectors/:id', async () => {
    answers[CONNECTOR_URL] = { ok: true, body: { connector: { id: CONNECTOR_ID, key: 'support-desk', name: 'Support desk' } } };
    expect(await connectorsResolver().resolve(contextFor(`/dashboard/connectors/${CONNECTOR_ID}`))).toEqual([{ index: 2, label: 'Support desk' }]);
    expect(fetched).toEqual([CONNECTOR_URL]);
  });

  it('leaves the OAuth apps page alone and asks for nothing', async () => {
    expect(await connectorsResolver().resolve(contextFor('/dashboard/connectors/oauth-apps'))).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('leaves the Catalog page alone and asks for nothing', async () => {
    expect(await connectorsResolver().resolve(contextFor('/dashboard/connectors/catalog'))).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('gives no label - so the segment stays as it is - when the connector cannot be fetched', async () => {
    const ctx = () => contextFor(`/dashboard/connectors/${CONNECTOR_ID}`);
    answers[CONNECTOR_URL] = { ok: false, status: 404 };
    expect(await connectorsResolver().resolve(ctx())).toEqual([]);
    answers[CONNECTOR_URL] = { ok: true, body: {} };
    expect(await connectorsResolver().resolve(ctx())).toEqual([]);
  });

  it('keeps to its own pages', async () => {
    for (const path of ['/dashboard/connectors', '/dashboard/agents/abc', '/dashboard', '/connectors/abc']) {
      expect(await connectorsResolver().resolve(contextFor(path)), path).toEqual([]);
    }
    expect(fetched).toEqual([]);
  });
});

describe('the breadcrumb of a connectors page', () => {
  const CONNECTOR_ID = '66f1c0de5e1a2b3c4d5e6f70';
  let mounted: Mounted;
  afterEach(async () => {
    await mounted?.unmount();
  });

  const render = async (path: string, locale = 'en') => {
    nav.pathname = path;
    mounted = await mount(createElement(DashboardBreadcrumbs), locale);
    await settle(50);
  };

  it('shows the name of the connector, in the crumb and in the browser tab title', async () => {
    answers[`/api/connectors/${CONNECTOR_ID}`] = { ok: true, body: { connector: { name: 'Support desk' } } };
    await render(`/dashboard/connectors/${CONNECTOR_ID}`);
    expect(text()).toContain('Connectors');
    expect(text()).toContain('Support desk');
    expect(document.title).toBe('Support desk · Connectors - Cognipeer Console');
  });

  it('shows the translated "Connectors" crumb', async () => {
    answers[`/api/connectors/${CONNECTOR_ID}`] = { ok: true, body: { connector: { name: 'Destek masası' } } };
    await render(`/dashboard/connectors/${CONNECTOR_ID}`, 'tr');
    expect(text()).toContain('Bağlayıcılar');
    expect(text()).toContain('Destek masası');
    expect(document.title).toBe('Destek masası · Bağlayıcılar - Cognipeer Console');
  });

  it('names the OAuth apps page properly, without looking for a connector', async () => {
    await render('/dashboard/connectors/oauth-apps');
    expect(text()).toContain('OAuth Apps');
    expect(text()).not.toContain('Oauth Apps');
    expect(document.title).toBe('OAuth Apps · Connectors - Cognipeer Console');
    expect(fetched).toEqual([]);
  });
});
