/**
 * Crawler service.
 *
 * CRUD for crawler profiles + run dispatch (queues the actual crawl onto
 * the cluster queue or, on a single-node deployment, runs it inline via
 * the queue consumer).
 */

import crypto from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { routeInstanceCall, queueNameFor } from '@/lib/core/cluster';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type {
  ICrawler,
  ICrawlerHttpConfig,
  ICrawlerScope,
  ICrawlJob,
  ICrawlPlanSnapshot,
  ICrawlResult,
} from '@/lib/database';
import { crawlerEntityId } from './crawlerEntityId';
import { matchesProjectScope } from './internals';
import { computeNextRun, validateSchedule } from './schedulePlanner';
import type {
  AdhocCrawlInput,
  CreateCrawlerInput,
  CrawlerContext,
  CrawlJobView,
  CrawlResultView,
  CrawlRunSummary,
  CrawlerView,
  RunCrawlerOptions,
  UpdateCrawlerInput,
} from './types';

const logger = createLogger('crawler:service');

const DEFAULT_SCOPE: ICrawlerScope = {
  sameDomainOnly: true,
  includeSubdomains: false,
};

const DEFAULT_HTTP: ICrawlerHttpConfig = {
  timeoutMs: 30_000,
  maxConcurrency: 5,
  retries: 2,
};

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

function serializeCrawler(record: ICrawler): CrawlerView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function serializeJob(record: ICrawlJob): CrawlJobView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function serializeResult(record: ICrawlResult): CrawlResultView {
  const { _id, ...rest } = record;
  return { ...rest, id: typeof _id === 'string' ? _id : _id?.toString() ?? '' };
}

function generateKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${slug || 'crawler'}-${crypto.randomBytes(3).toString('hex')}`;
}

function ensureCrawlerAccess(
  ctx: CrawlerContext,
  record: ICrawler | null | undefined,
): record is ICrawler {
  return Boolean(
    record
    && record.tenantId === ctx.tenantId
    && matchesProjectScope(record.projectId, ctx.projectId),
  );
}

// ── CRUD ───────────────────────────────────────────────────────────────

export async function createCrawler(
  ctx: CrawlerContext,
  input: CreateCrawlerInput,
): Promise<CrawlerView> {
  const db = await withTenantDb(ctx.tenantDbName);
  const key = input.key?.trim() || generateKey(input.name);
  const existing = await db.findCrawlerByKey(ctx.tenantId, key, ctx.projectId);
  if (existing) throw new Error(`Crawler key "${key}" already exists`);

  if (input.schedule) {
    const scheduleError = validateSchedule(input.schedule);
    if (scheduleError) throw new Error(`Invalid schedule: ${scheduleError}`);
  }

  const schedule = input.schedule
    ? { ...input.schedule, nextRunAt: computeNextRun(input.schedule) ?? undefined }
    : undefined;

  const record = await db.createCrawler({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    key,
    name: input.name,
    description: input.description,
    status: 'active',
    seeds: input.seeds ?? [],
    engine: input.engine ?? 'auto',
    maxDepth: Math.min(Math.max(0, input.maxDepth ?? 0), 3),
    maxPages: Math.max(0, input.maxPages ?? 50),
    autoCrawl: input.autoCrawl ?? false,
    scope: { ...DEFAULT_SCOPE, ...(input.scope ?? {}) },
    downloadableMimes: input.downloadableMimes,
    http: { ...DEFAULT_HTTP, ...(input.http ?? {}) },
    markdownOptions: input.markdownOptions,
    rag: input.rag,
    webhook: input.webhook,
    schedule,
    metadata: input.metadata,
    createdBy: input.createdBy,
  });
  logger.info('Crawler created', { tenantId: ctx.tenantId, key });
  return serializeCrawler(record);
}

export async function updateCrawler(
  ctx: CrawlerContext,
  idOrKey: string,
  input: UpdateCrawlerInput,
): Promise<CrawlerView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await loadCrawler(db, ctx, idOrKey);
  if (!existing) return null;

  const patch: Partial<ICrawler> = {
    updatedBy: input.updatedBy,
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.status !== undefined) patch.status = input.status;
  if (input.seeds !== undefined) patch.seeds = input.seeds;
  if (input.engine !== undefined) patch.engine = input.engine;
  if (input.maxDepth !== undefined) patch.maxDepth = Math.min(Math.max(0, input.maxDepth), 3);
  if (input.maxPages !== undefined) patch.maxPages = Math.max(0, input.maxPages);
  if (input.autoCrawl !== undefined) patch.autoCrawl = input.autoCrawl;
  if (input.scope !== undefined) patch.scope = { ...existing.scope, ...input.scope };
  if (input.http !== undefined) patch.http = { ...existing.http, ...input.http };
  if (input.downloadableMimes !== undefined) patch.downloadableMimes = input.downloadableMimes;
  if (input.markdownOptions !== undefined) patch.markdownOptions = input.markdownOptions;
  if (input.rag !== undefined) patch.rag = input.rag ?? undefined;
  if (input.webhook !== undefined) patch.webhook = input.webhook ?? undefined;
  if (input.schedule !== undefined) {
    if (input.schedule === null) {
      patch.schedule = undefined;
    } else {
      const scheduleError = validateSchedule(input.schedule);
      if (scheduleError) throw new Error(`Invalid schedule: ${scheduleError}`);
      patch.schedule = {
        ...input.schedule,
        // Preserve lastRunAt from existing record
        lastRunAt: existing.schedule?.lastRunAt ?? input.schedule.lastRunAt,
        nextRunAt: computeNextRun({
          ...input.schedule,
          lastRunAt: existing.schedule?.lastRunAt ?? input.schedule.lastRunAt,
        }) ?? undefined,
      };
    }
  }
  if (input.metadata !== undefined) patch.metadata = input.metadata;

  const updated = await db.updateCrawler(String(existing._id), patch);
  return updated ? serializeCrawler(updated) : null;
}

export async function deleteCrawler(
  ctx: CrawlerContext,
  idOrKey: string,
): Promise<boolean> {
  const db = await withTenantDb(ctx.tenantDbName);
  const existing = await loadCrawler(db, ctx, idOrKey);
  if (!existing) return false;
  return db.deleteCrawler(String(existing._id));
}

export async function getCrawler(
  ctx: CrawlerContext,
  idOrKey: string,
): Promise<CrawlerView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await loadCrawler(db, ctx, idOrKey);
  return record ? serializeCrawler(record) : null;
}

export async function listCrawlers(
  ctx: CrawlerContext,
  filters?: { status?: string; search?: string },
): Promise<CrawlerView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listCrawlers(ctx.tenantId, {
    projectId: ctx.projectId,
    status: filters?.status,
    search: filters?.search,
  });
  return records.map((r) => serializeCrawler(r));
}

async function loadCrawler(
  db: DatabaseProvider,
  ctx: CrawlerContext,
  idOrKey: string,
): Promise<ICrawler | null> {
  let record = await db.findCrawlerById(idOrKey).catch(() => null);
  if (!record) {
    record = await db.findCrawlerByKey(ctx.tenantId, idOrKey, ctx.projectId);
  }
  if (!ensureCrawlerAccess(ctx, record)) return null;
  return record;
}

// ── Container URL management ───────────────────────────────────────────

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Add URLs to a crawler's container. URLs already present are silently
 * ignored. Returns the updated full URL list.
 */
export async function addCrawlerUrls(
  ctx: CrawlerContext,
  idOrKey: string,
  urls: string[],
  actor: string,
): Promise<string[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const crawler = await loadCrawler(db, ctx, idOrKey);
  if (!crawler) throw new Error(`Crawler "${idOrKey}" not found`);
  const combined = dedupeUrls([...(crawler.seeds ?? []), ...urls]);
  await db.updateCrawler(String(crawler._id), {
    seeds: combined,
    updatedBy: actor,
  });
  return combined;
}

/**
 * Remove URLs from a crawler's container. Returns the updated list.
 */
export async function removeCrawlerUrls(
  ctx: CrawlerContext,
  idOrKey: string,
  urls: string[],
  actor: string,
): Promise<string[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const crawler = await loadCrawler(db, ctx, idOrKey);
  if (!crawler) throw new Error(`Crawler "${idOrKey}" not found`);
  const toRemove = new Set(urls.map((u) => u.trim()).filter(Boolean));
  const remaining = (crawler.seeds ?? []).filter((u) => !toRemove.has(u));
  await db.updateCrawler(String(crawler._id), {
    seeds: remaining,
    updatedBy: actor,
  });
  return remaining;
}

/**
 * Return the current URL list of a crawler container.
 */
export async function listCrawlerUrls(
  ctx: CrawlerContext,
  idOrKey: string,
): Promise<string[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const crawler = await loadCrawler(db, ctx, idOrKey);
  if (!crawler) throw new Error(`Crawler "${idOrKey}" not found`);
  return crawler.seeds ?? [];
}

// ── Run dispatch ───────────────────────────────────────────────────────

/**
 * Snapshot the current crawler config into an immutable plan that the job
 * worker can replay even if the parent profile is edited mid-run.
 */
export function snapshotCrawlerPlan(
  crawler: ICrawler,
  overrides?: { seeds?: string[] },
): ICrawlPlanSnapshot {
  return {
    seeds: overrides?.seeds ?? crawler.seeds,
    engine: crawler.engine,
    maxDepth: crawler.maxDepth,
    maxPages: crawler.maxPages,
    autoCrawl: crawler.autoCrawl,
    scope: crawler.scope,
    http: crawler.http,
    downloadableMimes: crawler.downloadableMimes,
    markdownOptions: crawler.markdownOptions,
    rag: crawler.rag,
    webhook: crawler.webhook,
  };
}

/**
 * Run a saved crawler. Creates a CrawlJob in `queued` state, then routes
 * execution to the assigned node (or runs locally on single-node setups).
 */
export async function runCrawler(
  ctx: CrawlerContext,
  idOrKey: string,
  options: RunCrawlerOptions,
): Promise<CrawlRunSummary> {
  const db = await withTenantDb(ctx.tenantDbName);
  const crawler = await loadCrawler(db, ctx, idOrKey);
  if (!crawler) throw new Error(`Crawler "${idOrKey}" not found`);
  if (crawler.status !== 'active') {
    throw new Error(`Crawler "${crawler.key}" is not active`);
  }

  const urls = options.urls ?? options.seeds ?? crawler.seeds ?? [];
  if (urls.length === 0) {
    throw new Error(
      `Crawler "${crawler.key}" has no URLs to crawl. Add URLs via the container or pass them in the run body.`,
    );
  }

  const plan = snapshotCrawlerPlan(crawler, { seeds: urls });
  const job = await db.createCrawlJob({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    crawlerKey: crawler.key,
    trigger: options.trigger ?? 'manual',
    triggerActor: options.triggerActor,
    planSnapshot: plan,
    status: 'queued',
    pagesDiscovered: 0,
    pagesProcessed: 0,
    filesProcessed: 0,
    errorsCount: 0,
    callbackUrl: options.callbackUrl,
    metadata: options.metadata,
    createdBy: options.triggerActor,
  });

  const jobId = String(job._id);
  await dispatchRun(ctx, crawler.key, jobId, options.mode ?? 'sync');
  return { jobId, status: 'queued' };
}

/**
 * Trigger an ad-hoc crawl without persisting a Crawler profile. Useful for
 * "one-shot" API integrations (`POST /api/crawler/run`).
 */
export async function runAdhocCrawl(
  ctx: CrawlerContext,
  input: AdhocCrawlInput,
): Promise<CrawlRunSummary> {
  const db = await withTenantDb(ctx.tenantDbName);
  const plan: ICrawlPlanSnapshot = {
    seeds: input.seeds,
    engine: input.engine ?? 'auto',
    maxDepth: Math.min(Math.max(0, input.maxDepth ?? 0), 3),
    maxPages: Math.max(0, input.maxPages ?? 20),
    autoCrawl: input.autoCrawl ?? false,
    scope: { ...DEFAULT_SCOPE, ...(input.scope ?? {}) },
    http: { ...DEFAULT_HTTP, ...(input.http ?? {}) },
    downloadableMimes: input.downloadableMimes,
    markdownOptions: input.markdownOptions,
    rag: input.rag,
    webhook: input.webhook,
  };

  const job = await db.createCrawlJob({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    trigger: 'adhoc',
    triggerActor: input.triggerActor,
    planSnapshot: plan,
    status: 'queued',
    pagesDiscovered: 0,
    pagesProcessed: 0,
    filesProcessed: 0,
    errorsCount: 0,
    callbackUrl: input.callbackUrl,
    metadata: input.metadata,
    createdBy: input.triggerActor,
  });

  const jobId = String(job._id);
  // Ad-hoc has no crawlerKey – route via auto channel
  await dispatchRun(ctx, undefined, jobId, input.mode ?? 'sync');
  return { jobId, status: 'queued' };
}

/**
 * Route a queued job to its worker.
 *
 *  - `async`: fire-and-forget. Publish onto the crawler queue and return
 *    immediately; the queue consumer (registered on every node at bootstrap)
 *    runs `runCrawlJobLocal` in the background. The caller only ever sees the
 *    `queued` job — progress and completion arrive via polling and the
 *    callbackUrl/webhook. This keeps the HTTP request (and the dashboard
 *    button behind it) from blocking for the whole crawl.
 *  - `sync`: block until the crawl finishes. Uses `routeInstanceCall` so the
 *    work still lands on the assigned node in a cluster, but the call does not
 *    return until the run is done. Kept as the default for programmatic
 *    callers (and tests) that read results straight back.
 */
async function dispatchRun(
  ctx: CrawlerContext,
  crawlerKey: string | undefined,
  jobId: string,
  mode: 'sync' | 'async',
): Promise<void> {
  const payload = { ctx, jobId } as unknown as QueuePayload;

  if (mode === 'async') {
    const queue = await getQueue();
    await queue.publish(queueNameFor('crawler'), 'crawler.run', payload, {
      attempts: 1,
    });
    logger.info('Crawl job enqueued (async)', { jobId, crawlerKey });
    return;
  }

  if (crawlerKey) {
    await routeInstanceCall(
      {
        entityType: 'crawler',
        entityId: crawlerEntityId(ctx.tenantId, crawlerKey),
        jobName: 'crawler.run',
      },
      payload,
      async () => {
        // Local fast path – import lazily to avoid a service ↔ consumer
        // import cycle at module load.
        const { runCrawlJobLocal } = await import('./crawlerJobService');
        await runCrawlJobLocal(ctx, jobId);
      },
    );
  } else {
    const { runCrawlJobLocal } = await import('./crawlerJobService');
    await runCrawlJobLocal(ctx, jobId);
  }
}

// ── Job & result listing helpers (thin wrappers for the API) ───────────

export async function listCrawlJobs(
  ctx: CrawlerContext,
  filters?: { crawlerKey?: string; status?: ICrawlJob['status']; limit?: number },
): Promise<CrawlJobView[]> {
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listCrawlJobs(ctx.tenantId, {
    projectId: ctx.projectId,
    crawlerKey: filters?.crawlerKey,
    status: filters?.status,
    limit: filters?.limit,
  });
  return records.map((r) => serializeJob(r));
}

export async function getCrawlJob(
  ctx: CrawlerContext,
  jobId: string,
): Promise<CrawlJobView | null> {
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findCrawlJobById(jobId);
  if (!record) return null;
  if (record.tenantId !== ctx.tenantId) return null;
  if (!matchesProjectScope(record.projectId, ctx.projectId)) return null;
  return serializeJob(record);
}

export async function listCrawlJobResults(
  ctx: CrawlerContext,
  jobId: string,
  options?: { limit?: number; skip?: number; type?: string },
): Promise<CrawlResultView[]> {
  const job = await getCrawlJob(ctx, jobId);
  if (!job) throw new Error(`Crawl job ${jobId} not found`);
  const db = await withTenantDb(ctx.tenantDbName);
  const records = await db.listCrawlResults(jobId, options);
  return records.map((r) => serializeResult(r));
}

export async function getCrawlResult(
  ctx: CrawlerContext,
  jobId: string,
  resultId: string,
): Promise<CrawlResultView | null> {
  const job = await getCrawlJob(ctx, jobId);
  if (!job) return null;
  const db = await withTenantDb(ctx.tenantDbName);
  const record = await db.findCrawlResultById(resultId);
  if (!record) return null;
  if (record.jobId !== jobId) return null;
  return serializeResult(record);
}

export async function cancelCrawlJob(
  ctx: CrawlerContext,
  jobId: string,
): Promise<boolean> {
  const job = await getCrawlJob(ctx, jobId);
  if (!job) return false;
  if (job.status !== 'queued' && job.status !== 'running') return false;
  const db = await withTenantDb(ctx.tenantDbName);
  // Atomic: a `queued` job is canceled outright; a `running` job only has
  // `cancelRequestedAt` stamped. The runner that actually claimed the job
  // (which may be on a different node than the one handling this request)
  // observes the flag on its own DB round trips and performs the terminal
  // `running -> canceled` transition itself — this request never overwrites
  // a `running` job's status directly, so a late-finishing runner can never
  // have its own legitimate `succeeded`/`partial`/`failed` write clobbered
  // by, or clobber, this cancellation.
  const result = await db.requestCrawlJobCancel(jobId, ctx.tenantId);
  if (!result) return false;
  // Same-node fast path: skip the DB round trip if the runner is local.
  const { markJobCancelRequested } = await import('./crawlerJobService');
  markJobCancelRequested(jobId);
  return true;
}

export { queueNameFor };
