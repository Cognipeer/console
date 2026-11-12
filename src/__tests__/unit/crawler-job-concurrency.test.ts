/**
 * The crawl job runner persists pages (crawl result + RAG ingest + webhook)
 * concurrently, up to the crawl's maxConcurrency, writes progress counters in
 * order, and lets in-flight persists land before the job is finalized.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(await getDatabase())),
  };
});
vi.mock('@/lib/services/availability/serviceAvailability', () => ({
  assertServiceEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/usage/usageEvents', () => ({ recordUsageEvent: vi.fn() }));
vi.mock('@/lib/services/crawler/crawlerWebhook', () => ({
  sendCrawlerWebhook: vi.fn().mockResolvedValue(undefined),
}));

const { pages, ingest } = vi.hoisted(() => ({
  // `extra` is merged into every yielded page, e.g. the engine's fetch fields.
  pages: { count: 0, extra: {} as Record<string, unknown> },
  ingest: vi.fn(),
}));

vi.mock('@/lib/services/crawler/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/crawler/engine')>()),
  crawl: async function* () {
    for (let i = 0; i < pages.count; i++) {
      yield {
        url: `https://example.com/p${i}`,
        depth: 0,
        type: 'html' as const,
        httpStatus: 200,
        body: `# Page ${i}`,
        ...pages.extra,
        fetchedAt: new Date(),
      };
    }
  },
}));

vi.mock('@/lib/services/crawler/crawlerRagBridge', () => ({ ingestCrawlPage: ingest }));

import { createMockDb } from '../helpers/db.mock';
import { getDatabase } from '@/lib/database';
import { runCrawlJobLocal } from '@/lib/services/crawler/crawlerJobService';

const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };

function job(maxConcurrency: number) {
  return {
    _id: 'job-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    crawlerKey: 'docs',
    triggerActor: 'user-1',
    planSnapshot: {
      seeds: ['https://example.com/'],
      engine: 'axios',
      http: { maxConcurrency },
      rag: { enabled: true, ragModuleKey: 'kb' },
    },
  };
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  pages.extra = {};
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.updateCrawlJob.mockResolvedValue(null);
  db.createCrawlResult.mockResolvedValue({});
  db.finalizeCrawlJob.mockResolvedValue({});
  ingest.mockReset();
});

describe('crawl job runner — concurrent persistence', () => {
  it('ingests up to maxConcurrency pages at once and counts every page', async () => {
    pages.count = 12;
    db.claimCrawlJob.mockResolvedValue(job(4));
    let inFlight = 0;
    let peak = 0;
    ingest.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return { ragStatus: 'indexed', ragDocumentId: 'doc' };
    });

    await runCrawlJobLocal(ctx as never, 'job-1');

    expect(peak).toBe(4);
    expect(db.createCrawlResult).toHaveBeenCalledTimes(12);
    expect(db.finalizeCrawlJob).toHaveBeenCalledWith(
      'job-1',
      'tenant-1',
      expect.objectContaining({ status: 'succeeded', pagesProcessed: 12 }),
    );
  });

  it('writes progress counters in order even though pages finish out of order', async () => {
    pages.count = 10;
    db.claimCrawlJob.mockResolvedValue(job(5));
    ingest.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 15));
      return { ragStatus: 'indexed', ragDocumentId: 'doc' };
    });
    db.updateCrawlJob.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return null;
    });

    await runCrawlJobLocal(ctx as never, 'job-1');

    const written = db.updateCrawlJob.mock.calls.map(
      (call: unknown[]) => (call[1] as { pagesProcessed: number }).pagesProcessed,
    );
    expect(written).toEqual([...written].sort((a, b) => a - b));
    expect(written.at(-1)).toBe(10);
  });

  it('lets in-flight pages land before finalizing a run that failed mid-way', async () => {
    pages.count = 8;
    db.claimCrawlJob.mockResolvedValue(job(4));
    const events: string[] = [];
    ingest.mockResolvedValue({ ragStatus: 'indexed', ragDocumentId: 'doc' });
    db.createCrawlResult.mockImplementation(async (row: { url: string }) => {
      await new Promise((r) => setTimeout(r, 10));
      if (row.url.endsWith('/p1')) throw new Error('disk full');
      events.push(`persisted ${row.url}`);
      return {};
    });
    db.finalizeCrawlJob.mockImplementation(async () => {
      events.push('finalized');
      return {};
    });

    await runCrawlJobLocal(ctx as never, 'job-1');

    expect(events.at(-1)).toBe('finalized');
    expect(db.finalizeCrawlJob).toHaveBeenCalledWith(
      'job-1',
      'tenant-1',
      expect.objectContaining({ errorMessage: 'disk full' }),
    );
  });

  it('stores the engine and fetch time the crawl measured with each result', async () => {
    pages.count = 2;
    pages.extra = { engine: 'playwright', fetchMs: 1840 };
    db.claimCrawlJob.mockResolvedValue(job(2));
    ingest.mockResolvedValue({ ragStatus: 'indexed', ragDocumentId: 'doc' });

    await runCrawlJobLocal(ctx as never, 'job-1');

    expect(db.createCrawlResult).toHaveBeenCalledTimes(2);
    for (const [row] of db.createCrawlResult.mock.calls) {
      expect(row).toMatchObject({ engine: 'playwright', fetchMs: 1840 });
    }
  });

  it('stores an error page\'s fetch time without inventing an engine', async () => {
    pages.count = 1;
    pages.extra = { type: 'error', errorMessage: 'All engines failed', fetchMs: 30_012 };
    db.claimCrawlJob.mockResolvedValue(job(1));

    await runCrawlJobLocal(ctx as never, 'job-1');

    const [row] = db.createCrawlResult.mock.calls[0]!;
    expect(row).toMatchObject({ type: 'error', fetchMs: 30_012 });
    expect(row.engine).toBeUndefined();
  });
});
