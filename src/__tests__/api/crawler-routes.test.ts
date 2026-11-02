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

// Same RAG-ingest mock as the e2e suite — sync-to-rag calls into the real
// ingest pipeline otherwise, which is out of scope for an HTTP-wire test.
const ragIngestCalls = vi.hoisted(() => [] as Array<{ ragModuleKey: string }>);
vi.mock('@/lib/services/rag', () => ({
  ingestDocument: async (
    _tenantDbName: string,
    _tenantId: string,
    _projectId: string | undefined,
    request: { ragModuleKey: string },
  ) => {
    ragIngestCalls.push({ ragModuleKey: request.ragModuleKey });
    return { _id: `ragdoc-${ragIngestCalls.length}`, status: 'indexed' };
  },
}));

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
// The id of the workspace owner created in beforeAll: the authorization engine
// decides every request from the user row, so the caller has to exist.
let USER_ID = 'pending';

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
    ownerId: 'pending',
  });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID,
    email: 'tester@example.com',
    name: 'Tester',
    password: '$2b$10$x',
    role: 'owner',
    licenseId: 'FREE',
    features: [],
  });
  USER_ID = String(owner._id);
  REQUEST_HEADERS['x-user-id'] = USER_ID;

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
    const { results, total, counts } = parseJsonBody<{
      results: Array<{ id?: string; _id?: unknown; url?: string; bodyMarkdown?: string }>;
      total: number;
      counts: { html: number; file: number; error: number };
    }>(resultsRes.body);
    expect(results.length).toBeGreaterThan(0);
    expect(total).toBe(results.length);
    expect(counts.html).toBe(1);
    for (const r of results) {
      expect(r.id, 'result must have `id`').toBeTruthy();
      expect(r._id, 'result must NOT have raw `_id`').toBeUndefined();
      // The list is a summary; the body comes from /results/:resultId.
      expect(r.bodyMarkdown).toBeUndefined();
    }

    const oneRes = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${ourJob!.id}/results/${results[0]!.id}`,
      headers: REQUEST_HEADERS,
    });
    expect(oneRes.statusCode).toBe(200);
    const { result } = parseJsonBody<{ result: { bodyMarkdown?: string } }>(oneRes.body);
    expect(result.bodyMarkdown).toMatch(/UNIQUE_MARKER/);
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

describe('POST /api/crawler/jobs/:jobId/sync-to-rag', () => {
  it('backfills a completed job into a Knowledge Engine module chosen after the fact', async () => {
    ragIngestCalls.length = 0;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Sync To RAG Crawler',
        engine: 'axios',
        maxDepth: 0,
        maxPages: 1,
        autoCrawl: false,
        http: { allowPrivateNetwork: true },
      }),
    });
    expect(createRes.statusCode).toBe(201);
    const { crawler } = parseJsonBody<{ crawler: { key: string } }>(createRes.body);

    // No `rag` binding at crawl time — nothing gets ingested yet.
    const crawlRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    expect(crawlRes.statusCode).toBe(202);
    const { jobId } = parseJsonBody<{ jobId: string }>(crawlRes.body);
    expect(ragIngestCalls.length).toBe(0);

    const syncRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/jobs/${jobId}/sync-to-rag`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ ragModuleKey: 'kb-module-routes-test' }),
    });
    expect(syncRes.statusCode).toBe(200);
    const summary = parseJsonBody<{
      jobId: string; ragModuleKey: string; total: number; indexed: number; skipped: number; failed: number;
    }>(syncRes.body);
    expect(summary.jobId).toBe(jobId);
    expect(summary.ragModuleKey).toBe('kb-module-routes-test');
    expect(summary.total).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(ragIngestCalls).toEqual([{ ragModuleKey: 'kb-module-routes-test' }]);
  }, 30_000);

  it('returns 404 for an unknown job id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crawler/jobs/does-not-exist/sync-to-rag',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ ragModuleKey: 'kb-module-routes-test' }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('a crawler that sends its pages into a knowledge base with access control', () => {
  const GUARDED = 'kb-acl-routes-test';
  let writerHeaders: Record<string, string>;

  beforeAll(async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    await db.createRagModule({
      tenantId: TENANT_ID,
      projectId: FAKE_PROJECT_ID,
      key: GUARDED,
      name: 'Guarded',
      embeddingModelKey: 'embed',
      vectorProviderKey: 'vec',
      vectorIndexKey: 'idx',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
      status: 'active',
      createdBy: 'seed',
      access: { enabled: true },
    } as never);
    // Works with crawlers and writes to the Knowledge Engine, but does not administer it.
    const writer = await db.createUser({
      tenantId: TENANT_ID,
      email: 'writer@example.com',
      name: 'Writer',
      password: '$2b$10$x',
      role: 'user',
      licenseId: 'FREE',
      features: [],
      servicePermissions: { crawler: 'write', rag: 'write' },
    } as never);
    writerHeaders = {
      ...REQUEST_HEADERS,
      'x-user-id': String(writer._id),
      'x-user-email': 'writer@example.com',
      'x-user-role': 'user',
      'content-type': 'application/json',
    };
  });

  const crawlerBody = (rag?: { ragModuleKey: string; enabled: boolean }) => JSON.stringify({
    name: `Guarded crawler ${Math.random().toString(36).slice(2, 8)}`,
    engine: 'axios',
    maxDepth: 0,
    maxPages: 1,
    autoCrawl: false,
    http: { allowPrivateNetwork: true },
    ...(rag ? { rag } : {}),
  });

  it('is set up by an administrator of the knowledge base, not by someone who only writes to it', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: writerHeaders,
      payload: crawlerBody({ ragModuleKey: GUARDED, enabled: true }),
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(parseJsonBody<{ code: string }>(refused.body).code).toBe('kb_access_controlled');

    // A binding that sends nothing, and a crawler without one, are theirs to make.
    const parked = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: writerHeaders,
      payload: crawlerBody({ ragModuleKey: GUARDED, enabled: false }),
    });
    expect(parked.statusCode, parked.body).toBe(201);
    const { crawler } = parseJsonBody<{ crawler: { key: string } }>(parked.body);
    // Turning it on is setting it up.
    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/crawler/crawlers/${crawler.key}`,
      headers: writerHeaders,
      payload: JSON.stringify({ rag: { ragModuleKey: GUARDED, enabled: true } }),
    });
    expect(enabled.statusCode, enabled.body).toBe(403);

    const ad = await app.inject({
      method: 'POST',
      url: '/api/crawler/run',
      headers: writerHeaders,
      payload: JSON.stringify({ seeds: [originUrl], rag: { ragModuleKey: GUARDED, enabled: true }, mode: 'async' }),
    });
    expect(ad.statusCode, ad.body).toBe(403);

    const byOwner = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: crawlerBody({ ragModuleKey: GUARDED, enabled: true }),
    });
    expect(byOwner.statusCode, byOwner.body).toBe(201);
  });

  it('syncs a job into it only for an administrator, whether the module is named or comes from the run', async () => {
    ragIngestCalls.length = 0;
    const created = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: crawlerBody(),
    });
    const { crawler } = parseJsonBody<{ crawler: { key: string } }>(created.body);
    const crawled = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    const { jobId } = parseJsonBody<{ jobId: string }>(crawled.body);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/crawler/jobs/${jobId}/sync-to-rag`,
      headers: writerHeaders,
      payload: JSON.stringify({ ragModuleKey: GUARDED }),
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(parseJsonBody<{ code: string }>(refused.body).code).toBe('kb_access_controlled');
    expect(ragIngestCalls).toEqual([]);

    const synced = await app.inject({
      method: 'POST',
      url: `/api/crawler/jobs/${jobId}/sync-to-rag`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ ragModuleKey: GUARDED }),
    });
    expect(synced.statusCode, synced.body).toBe(200);
    expect(ragIngestCalls).toEqual([{ ragModuleKey: GUARDED }]);
  }, 30_000);

  it('looks the module up where the sync writes: in the job\'s own project, which an old job does not have', async () => {
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    // Only another project has a module of that key, and it has access control.
    await db.createRagModule({
      tenantId: TENANT_ID,
      projectId: 'another-project',
      key: 'kb-acl-legacy-target',
      name: 'Elsewhere',
      embeddingModelKey: 'embed',
      vectorProviderKey: 'vec',
      vectorIndexKey: 'idx-elsewhere',
      chunkConfig: { strategy: 'recursive_character', chunkSize: 800, chunkOverlap: 100 },
      status: 'active',
      createdBy: 'seed',
      access: { enabled: true },
    } as never);
    // A job from before jobs carried a project: visible from every project, and its ingest looks the module up in all.
    const legacy = await db.createCrawlJob({
      tenantId: TENANT_ID,
      trigger: 'manual',
      triggerActor: 'seed',
      planSnapshot: { rag: { ragModuleKey: 'kb-acl-legacy-target', enabled: true } },
      status: 'completed',
      pagesDiscovered: 0,
      pagesProcessed: 0,
      filesProcessed: 0,
      errorsCount: 0,
      createdBy: 'seed',
    } as never);

    const refused = await app.inject({
      method: 'POST',
      url: `/api/crawler/jobs/${String(legacy._id)}/sync-to-rag`,
      headers: writerHeaders,
      payload: '{}',
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(parseJsonBody<{ code: string }>(refused.body).code).toBe('kb_access_controlled');
  });
});

describe('GET /api/crawler/jobs/:jobId/results pages, filters and searches server-side', () => {
  type Page = {
    results: Array<{ id: string; url: string; type: string; bodyMarkdown?: string }>;
    total: number;
    counts: { html: number; file: number; error: number };
  };
  let jobId = '';

  async function getPage(query: string): Promise<Page> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/crawler/jobs/${jobId}/results?${query}`,
      headers: REQUEST_HEADERS,
    });
    expect(res.statusCode).toBe(200);
    return parseJsonBody<Page>(res.body);
  }

  beforeAll(async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/crawler/crawlers',
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Paging Crawler',
        engine: 'axios',
        maxDepth: 0,
        maxPages: 1,
        autoCrawl: false,
        http: { allowPrivateNetwork: true },
      }),
    });
    const { crawler } = parseJsonBody<{ crawler: { key: string } }>(createRes.body);
    const crawlRes = await app.inject({
      method: 'POST',
      url: `/api/crawler/crawlers/${crawler.key}/crawl`,
      headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ urls: [originUrl], mode: 'sync' }),
    });
    jobId = parseJsonBody<{ jobId: string }>(crawlRes.body).jobId;

    // 1 crawled page + 120 seeded rows: 100 pages, 15 files, 5 errors.
    const db = await getDatabase();
    await db.switchToTenant(TENANT_DB_NAME);
    for (let i = 0; i < 120; i += 1) {
      const type = i < 100 ? 'html' : i < 115 ? 'file' : 'error';
      await db.createCrawlResult({
        tenantId: TENANT_ID,
        projectId: FAKE_PROJECT_ID,
        jobId,
        url: `https://docs.example.com/${type}/${i}`,
        depth: 1,
        type,
        title: i === 7 ? 'Pricing 100%_off guide' : `Seeded ${type} ${i}`,
        bodyMarkdown: type === 'error' ? undefined : `body ${i}`,
        errorMessage: type === 'error' ? 'ECONNRESET upstream' : undefined,
        ragStatus: i < 10 ? 'indexed' : undefined,
      });
    }
  }, 30_000);

  it('returns one page at a time with the filtered total and whole-job counts', async () => {
    const first = await getPage('limit=50&skip=0');
    expect(first.results).toHaveLength(50);
    expect(first.total).toBe(121);
    expect(first.counts).toEqual({ html: 101, file: 15, error: 5 });
    expect(first.results.every((r) => r.bodyMarkdown === undefined)).toBe(true);

    const last = await getPage('limit=50&skip=100');
    expect(last.results).toHaveLength(21);
    const firstIds = new Set(first.results.map((r) => r.id));
    expect(last.results.some((r) => firstIds.has(r.id))).toBe(false);
  });

  it('filters by type and Knowledge Engine status, including never-sent rows', async () => {
    const files = await getPage('type=file');
    expect(files.total).toBe(15);
    expect(files.results.every((r) => r.type === 'file')).toBe(true);
    expect(files.counts).toEqual({ html: 101, file: 15, error: 5 });

    expect((await getPage('ragStatus=indexed')).total).toBe(10);
    expect((await getPage('ragStatus=none')).total).toBe(111);
    expect((await getPage('type=html&ragStatus=none')).total).toBe(91);
  });

  it('searches url, title and error message case-insensitively, wildcards taken literally', async () => {
    expect((await getPage('search=DOCS.EXAMPLE.COM%2Ffile')).total).toBe(15);
    expect((await getPage('search=econnreset')).total).toBe(5);

    const literal = await getPage(`search=${encodeURIComponent('100%_off')}`);
    expect(literal.total).toBe(1);
    expect(literal.results[0]!.url).toBe('https://docs.example.com/html/7');
    // `%` and `_` are not wildcards: "1%0" would otherwise match "100".
    expect((await getPage(`search=${encodeURIComponent('1%0')}`)).total).toBe(0);
  });

  it('clamps out-of-range paging params instead of failing', async () => {
    const page = await getPage('limit=100000&skip=-5');
    expect(page.results).toHaveLength(121);
    expect((await getPage('limit=abc')).results).toHaveLength(50);
  });
});
