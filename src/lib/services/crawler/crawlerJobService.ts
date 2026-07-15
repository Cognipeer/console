/**
 * Crawl job runner – the function the queue consumer (and single-node
 * fast path) calls to actually execute a queued CrawlJob.
 *
 * Pulls the job's plan snapshot, streams pages from the engine, writes
 * each result to the DB, optionally ingests into RAG, fires per-page
 * and end-of-run webhooks, and updates job counters as work progresses.
 */

import { createLogger } from '@/lib/core/logger';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { ICrawlJob, ICrawlPlanSnapshot } from '@/lib/database';
import { crawl } from './engine';
import type { CrawlPlan, PageResult } from './engine';
import { recordUsageEvent } from '@/lib/services/usage/usageEvents';
import { sendCrawlerWebhook } from './crawlerWebhook';
import { ingestCrawlPage } from './crawlerRagBridge';
import type { CrawlerContext } from './types';

const logger = createLogger('crawler:job');

// In-process cancel registry. Cross-node cancellation lands in Faz 2.
const cancelRequested = new Set<string>();

export function markJobCancelRequested(jobId: string): void {
  cancelRequested.add(jobId);
}

/**
 * Bind `fn` to the tenant DB for its whole (sync + async) execution.
 *
 * A crawl job runs for minutes; using the bare `switchToTenant` (which relies
 * on `enterWith` + a process-global `this.tenantDb` fallback) meant that ANY
 * request for a different tenant arriving mid-crawl flipped the global pointer
 * and redirected this job's writes (results, counters, finalize, RAG ingest)
 * into the wrong tenant's database. `runWithTenant` pins the binding in a real
 * AsyncLocalStorage scope that survives `await` and is immune to concurrent
 * overwrites. See [[tenant-db-global-race]] and the sandbox isolation fix.
 */
async function runWithTenantDb<T>(
  tenantDbName: string,
  fn: (db: DatabaseProvider) => T | Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, () => fn(db));
  await db.switchToTenant(tenantDbName);
  return fn(db);
}

function snapshotToPlan(snapshot: ICrawlPlanSnapshot): CrawlPlan {
  return {
    seeds: snapshot.seeds ?? [],
    engine: snapshot.engine ?? 'auto',
    maxDepth: snapshot.maxDepth ?? 0,
    maxPages: snapshot.maxPages ?? 0,
    autoCrawl: snapshot.autoCrawl ?? false,
    scope: {
      sameDomainOnly: snapshot.scope?.sameDomainOnly ?? true,
      includeSubdomains: snapshot.scope?.includeSubdomains ?? false,
      allowList: snapshot.scope?.allowList,
      blockList: snapshot.scope?.blockList,
    },
    http: {
      userAgent: snapshot.http?.userAgent,
      acceptLanguage: snapshot.http?.acceptLanguage,
      timeoutMs: snapshot.http?.timeoutMs,
      maxConcurrency: snapshot.http?.maxConcurrency,
      retries: snapshot.http?.retries,
      headers: snapshot.http?.headers,
      cookies: snapshot.http?.cookies,
      basicAuth: snapshot.http?.basicAuth,
      bearerToken: snapshot.http?.bearerToken,
      allowPrivateNetwork: snapshot.http?.allowPrivateNetwork,
      allowInsecureTls: snapshot.http?.allowInsecureTls,
    },
    downloadableMimes: snapshot.downloadableMimes,
    markdownOptions: snapshot.markdownOptions,
  };
}

/**
 * Public entry point. Pins the tenant DB via ALS for the entire run so no
 * concurrent request for another tenant can redirect this job's writes, then
 * delegates to the inner runner.
 */
export async function runCrawlJobLocal(
  ctx: CrawlerContext,
  jobId: string,
): Promise<void> {
  return runWithTenantDb(ctx.tenantDbName, (db) =>
    runCrawlJobInner(db, ctx, jobId));
}

async function runCrawlJobInner(
  db: DatabaseProvider,
  ctx: CrawlerContext,
  jobId: string,
): Promise<void> {
  const startedAt = new Date();
  // Atomic queued -> running transition (CAS on `status`). If this returns
  // `null`, another consumer already claimed the job — a duplicate/
  // redelivered queue message MUST NOT re-run it (duplicate crawl results,
  // duplicate RAG ingestion, duplicate signed webhooks otherwise).
  const job = await db.claimCrawlJob(jobId, ctx.tenantId, startedAt);
  if (!job) {
    logger.info('Crawl job already claimed or not queued; skipping duplicate run', { jobId });
    return;
  }
  logger.info('Crawl job started', { jobId, crawlerKey: job.crawlerKey });

  const plan = snapshotToPlan(job.planSnapshot);
  const abort = new AbortController();

  let pagesProcessed = 0;
  let filesProcessed = 0;
  let errorsCount = 0;
  let limitReached = false;
  let failureMessage: string | undefined;

  // The for-await loop below only gets a chance to check `cancelRequested`
  // BETWEEN pages the engine yields — but the engine processes a batch of
  // up to `maxConcurrency` fetches with `Promise.all`, so if a cancel is
  // requested while a batch is in flight, `abort.signal` (which is what
  // actually interrupts in-flight axios/Playwright requests) would not be
  // aborted until that whole batch finishes on its own. That's exactly the
  // "I clicked Cancel and it just stays Running" symptom. Poll the
  // same-node flag on a short timer instead, so `abort.abort()` fires
  // within a fraction of a second of the button being clicked, regardless
  // of what the generator is doing.
  const cancelPollTimer = setInterval(() => {
    if (!abort.signal.aborted && cancelRequested.has(jobId)) {
      abort.abort();
    }
  }, 250);

  try {
    for await (const page of crawl(plan, {
      logger: {
        info: (m, meta) => logger.info(m, { jobId, ...meta }),
        warn: (m, meta) => logger.warn(m, { jobId, ...meta }),
        error: (m, meta) => logger.error(m, { jobId, ...meta }),
      },
      signal: abort.signal,
    })) {
      if (cancelRequested.has(jobId)) {
        abort.abort();
        break;
      }

      const written = await persistPage(db, ctx, job, page);
      if (page.type === 'html') pagesProcessed += 1;
      else if (page.type === 'file') filesProcessed += 1;
      else if (page.type === 'error') {
        errorsCount += 1;
        // Page-level errors were previously only ever persisted to
        // `crawl_results` (visible if someone happens to open this exact
        // job's result row in the UI) and never written to the
        // application logs — logging them here means they show up
        // alongside every other server-side log line during the run.
        logger.error('Crawl page failed', {
          jobId,
          url: page.url,
          parentUrl: page.parentUrl,
          error: page.errorMessage,
        });
      }

      if (plan.maxPages > 0 && pagesProcessed + filesProcessed >= plan.maxPages) {
        limitReached = true;
      }

      const updated = await db.updateCrawlJob(jobId, {
        pagesProcessed,
        filesProcessed,
        errorsCount,
        limitReached,
      });
      // Cross-node cancellation: a cancel request may have been recorded by
      // a different node than the one running this job. `cancelRequestedAt`
      // rides along on the per-page update above (no extra DB round trip),
      // so it's observed here even without any pub/sub between nodes.
      if (updated?.cancelRequestedAt && !cancelRequested.has(jobId)) {
        logger.info('Cross-node cancel request observed; aborting crawl', { jobId });
        cancelRequested.add(jobId);
        abort.abort();
      }

      if (page.type === 'html' || page.type === 'file') {
        // A failed per-page webhook delivery used to vanish with no trace at
        // all (neither logs nor DB) — log it so a misconfigured/unreachable
        // webhook endpoint is actually visible instead of silently dropped.
        await fireWebhook(job, page, written.ragDocumentId, 'page').catch((err) => {
          logger.warn('Per-page webhook delivery failed', {
            jobId,
            url: page.url,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  } catch (err) {
    failureMessage = err instanceof Error ? err.message : String(err);
    errorsCount += 1;
    logger.error('Crawl job failed', { jobId, error: failureMessage });
  } finally {
    clearInterval(cancelPollTimer);
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - startedAt.getTime();
    const canceled = cancelRequested.has(jobId);
    cancelRequested.delete(jobId);
    // Persisted job status must reflect ALL failures, not just a thrown
    // exception from the crawl generator itself. Per-page failures (TLS
    // errors, 404s, timeouts, etc.) are streamed as `page.type === 'error'`
    // and rolled into `errorsCount` above — without checking it here, a run
    // with 50 good pages and 20 broken ones was persisted to the DB as
    // `succeeded`, and the UI had no correct status to ever display.
    const hadFailure = Boolean(failureMessage) || errorsCount > 0;
    const processedAny = pagesProcessed + filesProcessed > 0;
    const status: ICrawlJob['status'] = canceled
      ? 'canceled'
      : !hadFailure
        ? 'succeeded'
        : processedAny
          ? 'partial'
          : 'failed';

    // Guarded by `WHERE status = 'running'` — this runner is the exclusive
    // owner of the job (claimed atomically above), so this only fails to
    // apply if something unexpected already moved the job out of `running`.
    const finalized = await db.finalizeCrawlJob(jobId, ctx.tenantId, {
      status,
      endedAt,
      durationMs,
      pagesProcessed,
      filesProcessed,
      errorsCount,
      limitReached,
      errorMessage: failureMessage,
    });
    if (!finalized) {
      logger.warn('Crawl job finalize skipped: job was no longer running', { jobId, status });
    }

    // Rollup event at completion — attribution comes from the fields stamped
    // on the job row at creation (the runner is outside the request ALS).
    recordUsageEvent({
      tenantDbName: ctx.tenantDbName,
      tenantId: ctx.tenantId,
      projectId: job.projectId,
      service: 'crawler',
      refKey: job.crawlerKey ?? '',
      status: status === 'failed' ? 'error' : 'success',
      latencyMs: durationMs,
      units: { pagesProcessed },
      attribution: {
        userId: job.userId,
        apiTokenId: job.apiTokenId,
        actorType: job.actorType,
      },
    });

    const event = status === 'failed' ? 'failed' : 'completed';
    await fireSummaryWebhook(job, status, {
      pagesProcessed,
      filesProcessed,
      errorsCount,
      durationMs,
    }, event).catch((err) => {
      logger.warn('Summary webhook delivery failed', {
        jobId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('Crawl job ended', {
      jobId,
      status,
      pagesProcessed,
      filesProcessed,
      errorsCount,
      durationMs,
    });
  }
}


async function persistPage(
  db: DatabaseProvider,
  ctx: CrawlerContext,
  job: ICrawlJob,
  page: PageResult,
): Promise<{ ragDocumentId?: string }> {
  let ragDocumentId: string | undefined;
  let ragStatus: 'pending' | 'indexed' | 'skipped' | 'failed' | undefined;
  let ragError: string | undefined;

  if (
    (page.type === 'html' || page.type === 'file') &&
    job.planSnapshot.rag?.enabled &&
    page.body
  ) {
    // Must be the tenant DB NAME (`tenant_<slug>`), not the tenant id:
    // ingestDocument switches the shared provider to this database, so a
    // wrong value here both breaks the module lookup AND redirects every
    // subsequent write in this job (results, counters, finalize) into a
    // phantom database.
    const ingest = await ingestCrawlPage({
      tenantDbName: ctx.tenantDbName,
      tenantId: job.tenantId,
      projectId: job.projectId,
      rag: job.planSnapshot.rag,
      crawlerKey: job.crawlerKey,
      jobId: String(job._id),
      url: page.url,
      title: page.title,
      bodyMarkdown: page.body,
      depth: page.depth,
      createdBy: job.triggerActor,
    });
    ragDocumentId = ingest.ragDocumentId;
    ragStatus = ingest.ragStatus;
    ragError = ingest.errorMessage;
    if (ragError) {
      // Previously only persisted on the crawl_result row (silent unless
      // someone opens that specific page's detail modal) — log it too.
      logger.warn('RAG ingestion failed for crawled page', {
        jobId: String(job._id),
        url: page.url,
        error: ragError,
      });
    }
  }

  await db.createCrawlResult({
    tenantId: job.tenantId,
    projectId: job.projectId,
    jobId: String(job._id),
    crawlerKey: job.crawlerKey,
    url: page.url,
    parentUrl: page.parentUrl,
    depth: page.depth,
    type: page.type,
    httpStatus: page.httpStatus,
    contentType: page.contentType,
    title: page.title,
    description: page.description,
    bodyMarkdown: page.body,
    bytes: page.bytes,
    ragDocumentId,
    ragStatus,
    errorMessage: page.errorMessage ?? ragError,
    fetchedAt: page.fetchedAt,
  });

  return { ragDocumentId };
}

async function fireWebhook(
  job: ICrawlJob,
  page: PageResult,
  ragDocumentId: string | undefined,
  event: 'page',
): Promise<void> {
  const previewLen = 500;
  await sendCrawlerWebhook({
    webhook: job.planSnapshot.webhook,
    overrideUrl: job.callbackUrl,
    allowPrivateNetwork: job.planSnapshot.http?.allowPrivateNetwork,
    event,
    payload: {
      tenantId: job.tenantId,
      projectId: job.projectId,
      crawlerKey: job.crawlerKey,
      jobId: String(job._id),
      data: {
        url: page.url,
        parentUrl: page.parentUrl,
        depth: page.depth,
        type: page.type,
        httpStatus: page.httpStatus,
        contentType: page.contentType,
        title: page.title,
        markdownPreview: page.body ? page.body.slice(0, previewLen) : undefined,
        markdownBytes: page.body ? Buffer.byteLength(page.body, 'utf8') : undefined,
        ragDocumentId,
      },
    },
  });
}

async function fireSummaryWebhook(
  job: ICrawlJob,
  status: ICrawlJob['status'],
  counts: {
    pagesProcessed: number;
    filesProcessed: number;
    errorsCount: number;
    durationMs: number;
  },
  event: 'completed' | 'failed',
): Promise<void> {
  await sendCrawlerWebhook({
    webhook: job.planSnapshot.webhook,
    overrideUrl: job.callbackUrl,
    allowPrivateNetwork: job.planSnapshot.http?.allowPrivateNetwork,
    event,
    payload: {
      tenantId: job.tenantId,
      projectId: job.projectId,
      crawlerKey: job.crawlerKey,
      jobId: String(job._id),
      data: {
        status,
        ...counts,
      },
    },
  });
}
