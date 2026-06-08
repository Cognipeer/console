/**
 * HTTP-level tests for the crawler dashboard routes.
 *
 * Spins up a real Fastify instance + real SQLite + bypasses the
 * project context resolver so we can assert on the wire response
 * shape that the dashboard UI consumes.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-crawler-routes-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'crawler_routes_main';

// Same to-markdown mock as the e2e suite — the underlying file-type CJS
// import trips vitest's ESM resolver.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => {
    const text = typeof input === 'string'
      ? Buffer.from(input.split(',').pop() ?? '', 'base64').toString('utf8')
      : input.toString('utf8');
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  },
}));

// Bypass project context lookup — the resolver needs a fully provisioned
// user + UserProject row, which is more setup than this test needs.
// We return the same tenant/project that the test inserted.
const FAKE_PROJECT_ID = 'test-project-1';
vi.mock('@/lib/services/projects/projectContext', async () => {
  return {
    ProjectContextError: class extends Error {
      status = 400;
    },
    resolveProjectContext: vi.fn(async (ctx: { tenantDbName: string; tenantId: string }) => ({
      projectId: FAKE_PROJECT_ID,
      project: {
        _id: FAKE_PROJECT_ID,
        tenantId: ctx.tenantId,
        name: 'Test',
        key: 'test',
        status: 'active',
      },
      userProject: null,
    })),
    requireProjectContext: vi.fn(),
  };
});

// Bypass RBAC enforcement — the runtime path tries to load a real user.
vi.mock('@/lib/security/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security/rbac')>('@/lib/security/rbac');
  return {
    ...actual,
    getPermissionServiceForPath: () => null,
  };
});

import http, { type Server } from 'node:http';
import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import { crawlerApiPlugin } from '@/server/api/plugins/crawler';
import {
  createFastifyApiTestApp,
  parseJsonBody,
} from '../helpers/fastify-api';

const TENANT_DB_NAME = 'crawler_routes_tenant';
const TENANT_ID = 'tenant-routes-1';
const USER_ID = 'user-routes-1';

const REQUEST_HEADERS = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'test',
  'x-user-id': USER_ID,
  'x-user-email': 'tester@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let originServer: Server;
let originUrl = '';

beforeAll(async () => {
  reloadConfig();

  // tiny origin server
  await new Promise<void>((resolve) => {
    originServer = http.createServer((_, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><h1>Hello</h1><p>UNIQUE_MARKER</p></body></html>');
    });
    originServer.listen(0, '127.0.0.1', () => {
      const addr = originServer.address();
      if (addr && typeof addr === 'object') {
        originUrl = `http://127.0.0.1:${addr.port}/`;
      }
      resolve();
    });
  });

  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Routes Test',
    slug: 'routes-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: USER_ID,
  });
  await db.switchToTenant(TENANT_DB_NAME);

  app = await createFastifyApiTestApp(crawlerApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => originServer.close(() => resolve()));
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/crawler/jobs and /jobs/:id/results return id + status on the wire', () => {
  it('full flow: create → /crawl → list jobs → list results — all have id + status', async () => {
    // 1. Create a container
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Routes Test Crawler',
        engine: 'axios',
        maxDepth: 0,
        maxPages: 1,
        autoCrawl: false,
        http: { allowPrivateNetwork: true },
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const { crawler } = parseJsonBody<{ crawler: { id: string; key: string } }>(createRes.body);
    expect(crawler.id).toBeTruthy();
    expect(crawler.key).toBeTruthy();

    // 2. Crawl a URL via /crawl
    const crawlRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    expect(crawlRes.statusCode).toBe(202);
    const { jobId } = parseJsonBody<{ jobId: string; status: string }>(crawlRes.body);
    expect(jobId).toBeTruthy();

    // 3. List jobs — every job MUST have `id` and `status`. This is what
    //    the Runs DataGrid relies on for both row keys and status badges.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/crawler/jobs?limit=50',
      headers: REQUEST_HEADERS,
    });
    expect(listRes.statusCode).toBe(200);
    const { jobs } = parseJsonBody<{
      jobs: Array<{ id?: string; _id?: unknown; status?: string; pagesProcessed?: number }>;
    }>(listRes.body);
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.id, 'wire response must include `id`').toBeTruthy();
      expect(j._id, 'wire response must NOT include raw `_id`').toBeUndefined();
      expect(typeof j.status, 'wire response must include `status`').toBe('string');
    }

    // 4. Click row → fetch results. This is the path that used to fail
    //    with "Failed to load results" — verify it works through HTTP now.
    const ourJob = jobs.find((j) => j.id === jobId);
    expect(ourJob).toBeDefined();
    expect(ourJob!.status).toBe('succeeded');
    expect(ourJob!.pagesProcessed).toBe(1);

    const resultsRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${ourJob!.id}/results?limit=200`,
      headers: REQUEST_HEADERS,
    });
    expect(resultsRes.statusCode).toBe(200);
    const { results } = parseJsonBody<{
      results: Array<{ id?: string; _id?: unknown; url?: string; bodyMarkdown?: string }>;
    }>(resultsRes.body);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.id, 'result must have `id`').toBeTruthy();
      expect(r._id, 'result must NOT have raw `_id`').toBeUndefined();
    }
    expect(results[0]!.bodyMarkdown).toMatch(/UNIQUE_MARKER/);
  }, 30_000);

  it('GET /jobs/{id} returns serialized job', async () => {
    // re-use the previous job; just list once more and pick first
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/crawler/jobs?limit=1',
      headers: REQUEST_HEADERS,
    });
    const { jobs } = parseJsonBody<{ jobs: Array<{ id: string }> }>(listRes.body);
    const first = jobs[0];
    expect(first).toBeDefined();

    const detailRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${first.id}`,
      headers: REQUEST_HEADERS,
    });
    expect(detailRes.statusCode).toBe(200);
    const { job } = parseJsonBody<{
      job: { id?: string; _id?: unknown; status?: string };
    }>(detailRes.body);
    expect(job.id).toBe(first.id);
    expect(job._id).toBeUndefined();
    expect(typeof job.status).toBe('string');
  });
});
