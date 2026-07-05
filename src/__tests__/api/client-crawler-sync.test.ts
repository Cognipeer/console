/**
 * API tests — client crawler container runs.
 * Locks the sync-vs-async response contract: async returns 202 + jobId only;
 * sync blocks and inlines the finished job state + results (markdown included)
 * so a persistent crawler serves request → result in one call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn().mockResolvedValue({
    switchToTenant: vi.fn().mockResolvedValue(undefined),
    runWithTenant: vi.fn((_db: string, fn: () => unknown) => fn()),
  }),
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
  };
});

vi.mock('@/lib/services/crawler', async () => {
  const validation = await vi.importActual<
    typeof import('@/lib/services/crawler/validation')
  >('@/lib/services/crawler/validation');
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
    listCrawlJobs: vi.fn(),
    listCrawlerUrls: vi.fn(),
    removeCrawlerUrls: vi.fn(),
    runAdhocCrawl: vi.fn(),
    runCrawler: vi.fn(),
    updateCrawler: vi.fn(),
  };
});

import { clientCrawlerApiPlugin } from '@/server/api/plugins/client-crawler';
import {
  getCrawlJob,
  listCrawlJobResults,
  runCrawler,
} from '@/lib/services/crawler';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const AUTH_CTX = {
  token: 'tok_abc',
  tokenRecord: { _id: 'tok-1', userId: 'user-1' },
  tenant: { licenseType: 'PROFESSIONAL' },
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  tenantDbName: 'tenant_acme',
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'owner', tenantId: 'tenant-1', servicePermissions: {} },
};

const FINISHED_JOB = {
  id: 'job-1',
  status: 'succeeded',
  pagesProcessed: 1,
  filesProcessed: 0,
  errorsCount: 0,
};

const RESULTS = [
  {
    id: 'res-1',
    url: 'https://example.com/page',
    type: 'page',
    httpStatus: 200,
    title: 'Example page',
    bodyMarkdown: '# Example\n\nContent…',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(AUTH_CTX);
  (runCrawler as ReturnType<typeof vi.fn>).mockResolvedValue({ jobId: 'job-1', status: 'queued' });
  (getCrawlJob as ReturnType<typeof vi.fn>).mockResolvedValue(FINISHED_JOB);
  (listCrawlJobResults as ReturnType<typeof vi.fn>).mockResolvedValue(RESULTS);
});

function inject(app: Awaited<ReturnType<typeof createFastifyApiTestApp>>, url: string, payload: object) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('POST /api/client/v1/crawler/crawlers/:idOrKey/crawl', () => {
  it('sync mode returns 200 with the finished job and inline results', async () => {
    const app = await createFastifyApiTestApp(clientCrawlerApiPlugin);
    const res = await inject(app, '/api/client/v1/crawler/crawlers/my-crawler/crawl', {
      urls: ['https://example.com/page'],
      mode: 'sync',
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{
      jobId: string;
      status: string;
      pagesProcessed: number;
      results: Array<{ url: string; bodyMarkdown: string }>;
    }>(res.body);
    expect(body.jobId).toBe('job-1');
    expect(body.status).toBe('succeeded');
    expect(body.pagesProcessed).toBe(1);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].bodyMarkdown).toContain('# Example');

    expect(runCrawler).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDbName: 'tenant_acme', projectId: 'proj-1' }),
      'my-crawler',
      expect.objectContaining({ urls: ['https://example.com/page'], mode: 'sync' }),
    );
    expect(listCrawlJobResults).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      'job-1',
      { limit: 100 },
    );
  });

  it('async mode (default) returns 202 with jobId only, no results fetch', async () => {
    const app = await createFastifyApiTestApp(clientCrawlerApiPlugin);
    const res = await inject(app, '/api/client/v1/crawler/crawlers/my-crawler/crawl', {
      urls: ['https://example.com/page'],
    });

    expect(res.statusCode).toBe(202);
    const body = parseJsonBody<{ jobId: string; status: string; results?: unknown }>(res.body);
    expect(body.jobId).toBe('job-1');
    expect(body.results).toBeUndefined();
    expect(listCrawlJobResults).not.toHaveBeenCalled();
    expect(getCrawlJob).not.toHaveBeenCalled();
  });
});

describe('POST /api/client/v1/crawler/crawlers/:idOrKey/run', () => {
  it('sync mode returns 200 with inline results', async () => {
    const app = await createFastifyApiTestApp(clientCrawlerApiPlugin);
    const res = await inject(app, '/api/client/v1/crawler/crawlers/my-crawler/run', {
      mode: 'sync',
    });

    expect(res.statusCode).toBe(200);
    const body = parseJsonBody<{ status: string; results: unknown[] }>(res.body);
    expect(body.status).toBe('succeeded');
    expect(body.results).toHaveLength(1);
  });

  it('async mode returns 202 without results', async () => {
    const app = await createFastifyApiTestApp(clientCrawlerApiPlugin);
    const res = await inject(app, '/api/client/v1/crawler/crawlers/my-crawler/run', {});

    expect(res.statusCode).toBe(202);
    expect(listCrawlJobResults).not.toHaveBeenCalled();
  });
});
