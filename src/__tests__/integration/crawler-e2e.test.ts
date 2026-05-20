/**
 * End-to-end smoke test for the crawler service.
 *
 * Spins up a real http.Server fixture serving 3 connected HTML pages, then
 * exercises:
 *
 *   1. `runAdhocCrawl(...)`  — no profile, direct seeds.
 *   2. `createCrawler` + `runCrawler` — saved profile flow.
 *   3. `webhook` delivery (per-page + completed) against a second local server.
 *
 * The crawler engine uses `engine: 'axios'` so we don't have to launch
 * chromium during CI. Playwright is exercised by its own targeted tests.
 *
 * Backed by a real SQLiteProvider in a temp directory.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @cognipeer/to-markdown ships an ESM-incompatible CJS dep (`file-type`) that
// trips vitest's strict ESM resolver. The engine's markdown.ts is the only
// consumer and falls back to cheerio text when this import fails — but
// vitest throws at module-load time, so we replace the export entirely.
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: async (input: string | Buffer) => {
    // Hand back a markdown-shaped string that contains the visible body
    // text so downstream assertions still find their markers.
    const text = typeof input === 'string'
      ? Buffer.from(input.split(',').pop() ?? '', 'base64').toString('utf8')
      : input.toString('utf8');
    // Strip tags + scripts/styles, collapse whitespace — same shape the real
    // to-markdown converter would emit for a plain HTML page.
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },
}));

// SQLite + temp dir need to be configured BEFORE getDatabase() is ever called.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-crawler-e2e-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'crawler_e2e_main';

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase } from '@/lib/database';
import {
  addCrawlerUrls,
  createCrawler,
  getCrawler,
  getCrawlJob,
  listCrawlerUrls,
  listCrawlers,
  listCrawlJobs,
  listCrawlJobResults,
  removeCrawlerUrls,
  runAdhocCrawl,
  runCrawler,
} from '@/lib/services/crawler';

let originServer: Server;
let originUrl = '';

let webhookServer: Server;
let webhookUrl = '';
const webhookHits: Array<{ event: string; body: unknown }> = [];

const TENANT_DB_NAME = 'crawler_e2e_tenant';
const TENANT_ID = 'tenant-crawler-e2e';
const ACTOR = 'tester@example.com';

const PAGES: Record<string, string> = {
  '/': `
    <html>
      <head>
        <title>Home</title>
        <meta name="description" content="Welcome to the test site." />
      </head>
      <body>
        <h1>Home page</h1>
        <p>Crawl me first. Some unique text: <strong>HOMEPAGE_MARKER</strong>.</p>
        <nav>
          <a href="/docs">Docs</a>
          <a href="/about">About</a>
          <a href="https://external.example.com/skip">External (skip)</a>
        </nav>
      </body>
    </html>`,
  '/docs': `
    <html>
      <head><title>Docs</title></head>
      <body>
        <h1>Docs</h1>
        <p>This is the documentation: DOCS_MARKER.</p>
        <a href="/about">Back to about</a>
      </body>
    </html>`,
  '/about': `
    <html>
      <head><title>About</title></head>
      <body>
        <h1>About</h1>
        <p>This is the about page: ABOUT_MARKER.</p>
      </body>
    </html>`,
};

beforeAll(async () => {
  reloadConfig();

  // Origin server: serves the three test pages.
  await new Promise<void>((resolve) => {
    originServer = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const body = PAGES[url];
      if (!body) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
    });
    originServer.listen(0, '127.0.0.1', () => {
      const addr = originServer.address();
      if (addr && typeof addr === 'object') {
        originUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  // Webhook server: collects deliveries.
  await new Promise<void>((resolve) => {
    webhookServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          webhookHits.push({ event: body.event, body });
        } catch { /* ignore */ }
        res.statusCode = 200;
        res.end('ok');
      });
    });
    webhookServer.listen(0, '127.0.0.1', () => {
      const addr = webhookServer.address();
      if (addr && typeof addr === 'object') {
        webhookUrl = `http://127.0.0.1:${addr.port}/hook`;
      }
      resolve();
    });
  });

  // Provision a tenant DB so switchToTenant() works.
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Crawler E2E',
    slug: 'crawler-e2e',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: TENANT_ID,
  });
  await db.switchToTenant(TENANT_DB_NAME);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => originServer.close(() => resolve()));
  await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('crawler e2e — ad-hoc run', () => {
  it('crawls the seed and follows in-domain links to depth 1', async () => {
    const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID };
    const result = await runAdhocCrawl(ctx, {
      seeds: [originUrl],
      engine: 'axios',
      maxDepth: 1,
      maxPages: 10,
      autoCrawl: true,
      scope: { sameDomainOnly: true, includeSubdomains: false },
      http: { allowPrivateNetwork: true, maxConcurrency: 3 },
      triggerActor: ACTOR,
    });

    expect(result.jobId).toBeTruthy();

    const job = await getCrawlJob(ctx, result.jobId);
    expect(job).not.toBeNull();
    expect(job!.status).toBe('succeeded');
    expect(job!.pagesProcessed).toBeGreaterThanOrEqual(3);
    expect(job!.errorsCount).toBe(0);
    expect(job!.durationMs).toBeGreaterThan(0);

    const results = await listCrawlJobResults(ctx, result.jobId);
    const urls = results.map((r) => r.url).sort();
    const seedUrl = `${originUrl}/`;
    expect(urls).toContain(seedUrl);
    expect(urls).toContain(`${originUrl}/docs`);
    expect(urls).toContain(`${originUrl}/about`);

    // Off-domain link is not crawled.
    expect(urls.find((u) => u.includes('external.example.com'))).toBeUndefined();

    // Markdown contains unique markers — to-markdown produced real text.
    const home = results.find((r) => r.url === seedUrl);
    expect(home?.bodyMarkdown).toBeTruthy();
    expect(home?.bodyMarkdown).toMatch(/HOMEPAGE_MARKER/);
    expect(home?.title).toBe('Home');
    expect(home?.depth).toBe(0);

    const docs = results.find((r) => r.url === `${originUrl}/docs`);
    expect(docs?.depth).toBe(1);
    expect(docs?.bodyMarkdown).toMatch(/DOCS_MARKER/);
    expect(docs?.parentUrl).toBe(seedUrl);
  }, 30_000);
});

describe('crawler e2e — saved profile + webhook', () => {
  it('persists a crawler, triggers run, hits the webhook', async () => {
    webhookHits.length = 0;
    const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID };

    const created = await createCrawler(ctx, {
      name: 'E2E crawler',
      seeds: [originUrl],
      engine: 'axios',
      maxDepth: 1,
      maxPages: 5,
      autoCrawl: true,
      scope: { sameDomainOnly: true, includeSubdomains: false },
      http: { allowPrivateNetwork: true, maxConcurrency: 3 },
      webhook: {
        url: webhookUrl,
        events: ['page', 'completed'],
      },
      createdBy: ACTOR,
    });
    expect(created.key).toBeTruthy();

    const list = await listCrawlers(ctx);
    expect(list.find((c) => c.id === created.id)).toBeTruthy();

    const summary = await runCrawler(ctx, created.key, {
      triggerActor: ACTOR,
      trigger: 'manual',
    });
    expect(summary.jobId).toBeTruthy();

    const job = await getCrawlJob(ctx, summary.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.crawlerKey).toBe(created.key);

    const pageEvents = webhookHits.filter((h) => h.event === 'crawl.page');
    const completed = webhookHits.find((h) => h.event === 'crawl.completed');
    expect(pageEvents.length).toBeGreaterThanOrEqual(3);
    expect(completed).toBeTruthy();

    // First page event payload sanity-check.
    const firstPage = pageEvents[0]!.body as {
      data: { url: string; title?: string; markdownPreview?: string };
      jobId: string;
    };
    expect(firstPage.jobId).toBe(summary.jobId);
    expect(firstPage.data.url).toBeTruthy();
    expect(firstPage.data.markdownPreview ?? '').toMatch(/MARKER/);

    // Read back the persisted profile to confirm webhook + scope round-trip.
    const fetched = await getCrawler(ctx, created.key);
    expect(fetched?.webhook?.url).toBe(webhookUrl);
    expect(fetched?.scope.sameDomainOnly).toBe(true);
  }, 45_000);
});

describe('crawler e2e — container URL flow', () => {
  it('creates a crawler with no URLs, adds them later, runs them, removes one', async () => {
    const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID };

    // 1. Create container, NO seeds.
    const container = await createCrawler(ctx, {
      name: 'Container crawler',
      engine: 'axios',
      maxDepth: 0,
      maxPages: 10,
      autoCrawl: false,
      http: { allowPrivateNetwork: true },
      createdBy: ACTOR,
    });
    expect(container.seeds).toEqual([]);

    // 2. Empty run should fail with a clear message.
    await expect(
      runCrawler(ctx, container.key, {
        trigger: 'manual',
        triggerActor: ACTOR,
      }),
    ).rejects.toThrow(/no URLs/i);

    // 3. Add URLs to the container.
    const urls = await addCrawlerUrls(
      ctx,
      container.key,
      [`${originUrl}/about`, `${originUrl}/docs`, `${originUrl}/docs`], // dedupe
      ACTOR,
    );
    expect(urls).toHaveLength(2);
    expect(urls).toContain(`${originUrl}/about`);
    expect(urls).toContain(`${originUrl}/docs`);

    const listed = await listCrawlerUrls(ctx, container.key);
    expect(listed).toEqual(urls);

    // 4. Run on the saved URLs.
    const summary = await runCrawler(ctx, container.key, {
      trigger: 'manual',
      triggerActor: ACTOR,
    });
    const job = await getCrawlJob(ctx, summary.jobId);
    expect(job?.status).toBe('succeeded');
    expect(job?.pagesProcessed).toBe(2);
    const resultUrls = (await listCrawlJobResults(ctx, summary.jobId))
      .map((r) => r.url)
      .sort();
    expect(resultUrls).toEqual([
      `${originUrl}/about`,
      `${originUrl}/docs`,
    ]);

    // 5. Single-URL ad-hoc crawl against the container (the API
    //    use-case the user described).
    const oneShot = await runCrawler(ctx, container.key, {
      urls: [`${originUrl}/`],
      trigger: 'api',
      triggerActor: 'external-app',
    });
    const oneShotJob = await getCrawlJob(ctx, oneShot.jobId);
    expect(oneShotJob?.status).toBe('succeeded');
    expect(oneShotJob?.pagesProcessed).toBe(1);
    const oneShotResults = await listCrawlJobResults(ctx, oneShot.jobId);
    expect(oneShotResults[0]?.url).toBe(`${originUrl}/`);
    expect(oneShotResults[0]?.bodyMarkdown).toMatch(/HOMEPAGE_MARKER/);

    // The container itself should still hold only its 2 saved URLs.
    const afterOneShot = await listCrawlerUrls(ctx, container.key);
    expect(afterOneShot).toEqual(urls);

    // 6. Remove a URL.
    const remaining = await removeCrawlerUrls(
      ctx,
      container.key,
      [`${originUrl}/docs`],
      ACTOR,
    );
    expect(remaining).toEqual([`${originUrl}/about`]);
  }, 30_000);
});

describe('crawler e2e — list job + result response shape', () => {
  it('returns id/status fields the UI relies on, both for list and results', async () => {
    const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID };
    const adhoc = await runAdhocCrawl(ctx, {
      seeds: [`${originUrl}/about`],
      engine: 'axios',
      maxDepth: 0,
      maxPages: 1,
      autoCrawl: false,
      http: { allowPrivateNetwork: true },
      triggerActor: ACTOR,
    });

    const jobs = await listCrawlJobs(ctx, { limit: 100 });
    const job = jobs.find((j) => j.id === adhoc.jobId);
    expect(job).toBeDefined();
    // The DataGrid + openJobModal both rely on these.
    expect(typeof job!.id).toBe('string');
    expect(job!.id.length).toBeGreaterThan(0);
    expect(['queued', 'running', 'succeeded', 'failed', 'partial', 'canceled'])
      .toContain(job!.status);
    // No leftover `_id` should be returned — would mean the UI received raw DB shape.
    expect((job as unknown as { _id?: unknown })._id).toBeUndefined();
    // JSON round-trip must preserve id + status (this is what the wire sends).
    const wired = JSON.parse(JSON.stringify(job)) as typeof job;
    expect(wired!.id).toBe(job!.id);
    expect(wired!.status).toBe(job!.status);

    const results = await listCrawlJobResults(ctx, job!.id);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThan(0);
      expect((r as unknown as { _id?: unknown })._id).toBeUndefined();
    }
  });
});

describe('crawler e2e — schedule planner integration', () => {
  it('persists schedule and computes nextRunAt on save', async () => {
    const ctx = { tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID };
    const created = await createCrawler(ctx, {
      name: 'Scheduled crawler',
      seeds: [originUrl],
      engine: 'axios',
      maxDepth: 0,
      maxPages: 1,
      autoCrawl: false,
      http: { allowPrivateNetwork: true },
      schedule: {
        enabled: true,
        mode: 'interval',
        intervalSeconds: 3600,
      },
      createdBy: ACTOR,
    });
    expect(created.schedule?.enabled).toBe(true);
    expect(created.schedule?.intervalSeconds).toBe(3600);
    expect(created.schedule?.nextRunAt).toBeTruthy();
    // Next run is "now-ish" because no previous run has happened.
    const next = new Date(created.schedule!.nextRunAt!);
    expect(Math.abs(next.getTime() - Date.now())).toBeLessThan(5_000);
  }, 15_000);
});
