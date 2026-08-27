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

describe('Crawler HTTP credentials are never returned in cleartext (CWE-312)', () => {
  const SECRET_BEARER_TOKEN = 'sekret-bearer-token-should-never-leak-12345';

  it('masks the bearer token on create/get and on every job read after a real run', async () => {
    // 1. Create a crawler carrying a bearer token.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Secret Bearer Crawler',
        engine: 'axios',
        maxDepth: 0,
        maxPages: 1,
        autoCrawl: false,
        http: { allowPrivateNetwork: true, bearerToken: SECRET_BEARER_TOKEN },
      }),
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.body).not.toContain(SECRET_BEARER_TOKEN);
    const { crawler } = parseJsonBody<{
      crawler: { id: string; key: string; http?: { bearerToken?: string } };
    }>(createRes.body);
    expect(crawler.http?.bearerToken).not.toBe(SECRET_BEARER_TOKEN);

    // 2. Re-fetch the crawler — still masked.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/crawlers/${crawler.key}`,
      headers: REQUEST_HEADERS,
    });
    expect(getRes.body).not.toContain(SECRET_BEARER_TOKEN);

    // 3. Actually run a crawl (sync) so the token is used for real and the
    //    plan snapshot is persisted on the job record.
    const crawlRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    expect(crawlRes.statusCode).toBe(202);
    const { jobId } = parseJsonBody<{ jobId: string }>(crawlRes.body);
    expect(jobId).toBeTruthy();

    // 4. GET /crawler/jobs/:jobId — the exact route the finding's residual
    //    leak (`planSnapshot.http`) was reachable through. Must never
    //    contain the plaintext token, even though the crawl actually ran.
    const jobRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${jobId}`,
      headers: REQUEST_HEADERS,
    });
    expect(jobRes.statusCode).toBe(200);
    expect(jobRes.body).not.toContain(SECRET_BEARER_TOKEN);
    const { job } = parseJsonBody<{
      job: { status: string; planSnapshot?: { http?: { bearerToken?: string } } };
    }>(jobRes.body);
    expect(job.status).toBe('succeeded');
    expect(job.planSnapshot?.http?.bearerToken).not.toBe(SECRET_BEARER_TOKEN);

    // 5. GET /crawler/jobs (list) — same masking must apply there too.
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/crawler/jobs?limit=50',
      headers: REQUEST_HEADERS,
    });
    expect(listRes.body).not.toContain(SECRET_BEARER_TOKEN);
  }, 30_000);
});

describe('Crawler webhook HMAC secret is never returned in cleartext (CWE-201)', () => {
  const WEBHOOK_SECRET = 'sekret-webhook-hmac-should-never-leak-67890';
  const NEW_WEBHOOK_SECRET = 'brand-new-webhook-secret-abcde';

  it('masks the secret on create/get/job-read, and a no-op re-save does not corrupt it', async () => {
    // 1. Create a crawler carrying a webhook secret.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Secret Webhook Crawler',
        engine: 'axios',
        maxDepth: 0,
        maxPages: 1,
        autoCrawl: false,
        webhook: { url: 'https://example.test/hook', secret: WEBHOOK_SECRET, events: ['completed'] },
      }),
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.body).not.toContain(WEBHOOK_SECRET);
    const { crawler } = parseJsonBody<{
      crawler: { id: string; key: string; webhook?: { secret?: string } };
    }>(createRes.body);
    const maskedSecret = crawler.webhook?.secret;
    expect(maskedSecret).not.toBe(WEBHOOK_SECRET);
    expect(maskedSecret).toBeTruthy();

    // 2. Re-fetch — still masked, same placeholder.
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/crawlers/${crawler.key}`,
      headers: REQUEST_HEADERS,
    });
    expect(getRes.body).not.toContain(WEBHOOK_SECRET);
    const { crawler: fetched } = parseJsonBody<{ crawler: { webhook?: { secret?: string } } }>(getRes.body);
    expect(fetched.webhook?.secret).toBe(maskedSecret);

    // 3. Simulate the dashboard's round-trip: PATCH the crawler back with the
    //    masked placeholder unchanged (exactly what page.tsx's pre-filled
    //    form submits on a no-op save). The REAL secret must survive.
    const noopPatchRes = await app.inject({
      method: 'PATCH',
      url: `/api/crawler/crawlers/${crawler.key}`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        webhook: { url: 'https://example.test/hook', secret: maskedSecret, events: ['completed', 'failed'] },
      }),
    });
    expect(noopPatchRes.statusCode).toBe(200);
    const { crawler: afterNoop } = parseJsonBody<{
      crawler: { webhook?: { secret?: string; events?: string[] } };
    }>(noopPatchRes.body);
    // The unrelated field change (events) took effect...
    expect(afterNoop.webhook?.events).toEqual(['completed', 'failed']);
    // ...but the secret is still masked the same way, not corrupted to the
    // literal placeholder string, and not blank.
    expect(afterNoop.webhook?.secret).toBe(maskedSecret);

    // 4. Run a real crawl and confirm the job's planSnapshot never leaks it.
    const crawlRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    expect(crawlRes.statusCode).toBe(202);
    const { jobId } = parseJsonBody<{ jobId: string }>(crawlRes.body);
    const jobRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${jobId}`,
      headers: REQUEST_HEADERS,
    });
    expect(jobRes.body).not.toContain(WEBHOOK_SECRET);
    const { job } = parseJsonBody<{
      job: { planSnapshot?: { webhook?: { secret?: string } } };
    }>(jobRes.body);
    expect(job.planSnapshot?.webhook?.secret).toBe(maskedSecret);

    // 5. A genuine secret rotation (a real, different value) must actually
    //    take effect, not be treated as "keep current" too.
    const rotateRes = await app.inject({
      method: 'PATCH',
      url: `/api/crawler/crawlers/${crawler.key}`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        webhook: { url: 'https://example.test/hook', secret: NEW_WEBHOOK_SECRET, events: ['completed'] },
      }),
    });
    expect(rotateRes.statusCode).toBe(200);
    const { crawler: afterRotate } = parseJsonBody<{ crawler: { webhook?: { secret?: string } } }>(rotateRes.body);
    expect(afterRotate.webhook?.secret).not.toBe(NEW_WEBHOOK_SECRET);
    expect(afterRotate.webhook?.secret).not.toBe(WEBHOOK_SECRET);
  }, 30_000);
});
