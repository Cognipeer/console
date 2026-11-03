/**
 * A crawler request body that fails its schema is the caller's mistake: both the
 * dashboard and the client plugin answer 400 with a readable `path: message`,
 * whatever the issue says. They used to classify by the error's wording, so an
 * issue that did not happen to contain "invalid" (a rejected `blockedHosts`
 * entry, a number over its maximum) came back as a 500.
 *
 * No database: validation fails before any service is reached, and the services
 * that a valid request does reach are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});

// The dashboard gate loads the caller from the database before a handler runs. Who may
// call is not what this test is about, so that gate becomes a passthrough here; the
// client plugin keeps its real token path.
vi.mock('@/server/api/fastify-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/api/fastify-utils')>()),
  withApiRequestContext: <T>(handler: T) => handler,
  requireProjectContextForRequest: vi.fn(async () => ({
    projectId: 'proj-1',
    session: {
      tenantDbName: 'tenant_acme',
      tenantId: 'tenant-1',
      userId: 'user-1',
      userEmail: 'tester@example.com',
    },
  })),
}));

vi.mock('@/lib/services/crawler', async () => {
  const validation = await vi.importActual<typeof import('@/lib/services/crawler/validation')>(
    '@/lib/services/crawler/validation',
  );
  return {
    ...validation,
    addCrawlerUrls: vi.fn(),
    cancelCrawlJob: vi.fn(),
    createCrawler: vi.fn(),
    deleteCrawler: vi.fn(),
    getCrawler: vi.fn(),
    getCrawlJob: vi.fn(),
    getCrawlResult: vi.fn(),
    listCrawlers: vi.fn(),
    listCrawlJobResults: vi.fn(),
    listCrawlJobResultsPage: vi.fn(),
    listCrawlJobs: vi.fn(),
    listCrawlerUrls: vi.fn(),
    removeCrawlerUrls: vi.fn(),
    runAdhocCrawl: vi.fn(),
    runCrawler: vi.fn(),
    syncCrawlJobToRag: vi.fn(),
    updateCrawler: vi.fn(),
  };
});

import { clientCrawlerApiPlugin } from '@/server/api/plugins/client-crawler';
import { crawlerApiPlugin } from '@/server/api/plugins/crawler';
import { createCrawler, runAdhocCrawl, updateCrawler } from '@/lib/services/crawler';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const CLIENT_AUTH = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} },
};

interface Surface {
  name: string;
  plugin: typeof crawlerApiPlugin;
  headers: Record<string, string>;
  collection: string;
  adhoc: string;
}

const SURFACES: Surface[] = [
  {
    name: 'dashboard (/api/crawler)',
    plugin: crawlerApiPlugin,
    headers: {},
    collection: '/api/crawler/crawlers',
    adhoc: '/api/crawler/run',
  },
  {
    name: 'client (/api/client/v1/crawler)',
    plugin: clientCrawlerApiPlugin,
    headers: { authorization: 'Bearer tok_abc' },
    collection: '/api/client/v1/crawler/crawlers',
    adhoc: '/api/client/v1/crawler/run',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued one-shot results, which would leak into the next test.
  for (const service of [createCrawler, updateCrawler, runAdhocCrawl]) {
    (service as ReturnType<typeof vi.fn>).mockReset();
  }
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(createMockDb());
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(CLIENT_AUTH);
});

describe.each(SURFACES)('crawler request validation — $name', (surface) => {
  async function send(method: 'POST' | 'PATCH', url: string, payload: object) {
    const app = await createFastifyApiTestApp(surface.plugin);
    try {
      return await app.inject({
        method,
        url,
        headers: { ...surface.headers, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
    } finally {
      await app.close();
    }
  }
  const errorOf = (res: { body: string }) => parseJsonBody<{ error: string }>(res.body).error;

  it('answers 400 for a blockedHosts entry that is not a host name, naming the entry', async () => {
    const res = await send('POST', surface.collection, {
      name: 'c',
      http: { blockedHosts: ['cdn.example.com', 'https://cdn.example.com'] },
    });

    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe(
      'http.blockedHosts.1: Enter a host name such as cdn.example.com, without scheme, path or port',
    );
    expect(createCrawler).not.toHaveBeenCalled();
  });

  it('answers 400 on update and on an ad-hoc run too', async () => {
    const update = await send('PATCH', `${surface.collection}/docs`, { http: { blockedHosts: ['a*b.example.com'] } });
    expect(update.statusCode).toBe(400);
    expect(errorOf(update)).toMatch(/^http\.blockedHosts\.0: Enter a host name/);
    expect(updateCrawler).not.toHaveBeenCalled();

    const adhoc = await send('POST', surface.adhoc, {
      seeds: ['https://example.com/'],
      http: { blockedHosts: ['cdn.example.com:8443'] },
    });
    expect(adhoc.statusCode).toBe(400);
    expect(errorOf(adhoc)).toMatch(/^http\.blockedHosts\.0: Enter a host name/);
    expect(runAdhocCrawl).not.toHaveBeenCalled();
  });

  it('answers 400 for any other schema issue that never says "invalid" (a number over its maximum)', async () => {
    const res = await send('POST', surface.collection, { name: 'c', http: { maxConcurrency: 500 } });

    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toMatch(/^http\.maxConcurrency: /);
  });

  it('does not hand the caller Zod’s raw JSON of the issues', async () => {
    const res = await send('POST', surface.collection, { name: 'c', http: { blockedHosts: [' '] } });

    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).not.toMatch(/^\s*\[/);
    expect(errorOf(res)).not.toContain('"code"');
  });

  it('still answers a service error by its own wording, so only schema failures changed', async () => {
    (createCrawler as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('A crawler with this key already exists'));
    const conflict = await send('POST', surface.collection, { name: 'c', http: { blockedHosts: ['cdn.example.com'] } });
    expect(conflict.statusCode).toBe(400);
    expect(errorOf(conflict)).toBe('A crawler with this key already exists');

    (createCrawler as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk exploded'));
    const broken = await send('POST', surface.collection, { name: 'c', http: { blockedHosts: ['cdn.example.com'] } });
    expect(broken.statusCode).toBe(500);
  });

  it('lets a valid host list through to the service, Unicode forms included', async () => {
    (createCrawler as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'crw-1', key: 'c' });
    const res = await send('POST', surface.collection, {
      name: 'c',
      http: { blockTrackers: true, blockedHosts: ['cdn.example.com', '*。bücher.example'] },
    });

    expect(res.statusCode).toBe(201);
    expect(createCrawler).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        http: expect.objectContaining({ blockTrackers: true, blockedHosts: ['cdn.example.com', '*。bücher.example'] }),
      }),
    );
  });
});
