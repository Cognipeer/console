/**
 * Background scheduler for crawlers.
 *
 * Mirrors the pollScheduler / alertScheduler convention:
 *  - one tick every CHECK_INTERVAL_MS
 *  - tenants iterated sequentially
 *  - per-crawler self-filtering by cluster instance assignment
 *  - distributed lock for the unassigned bucket (Redis when configured;
 *    in-memory cache otherwise — single-node safe)
 *
 * Schedule semantics live in `schedulePlanner.ts`; this file only deals
 * with discovery + dispatch.
 */

import { getDatabase, getTenantDatabase } from '@/lib/database';
import type { ICrawler } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getCache } from '@/lib/core/cache';
import {
  findInstanceAssignment,
  getThisNodeName,
  resolveDefaultNodeName,
} from '@/lib/core/cluster';
import { runCrawler } from './crawlerService';
import { crawlerEntityId } from './crawlerEntityId';
import { computeNextRun } from './schedulePlanner';

const logger = createLogger('crawler-scheduler');

const CHECK_INTERVAL_MS = 30_000;
const SCHEDULER_LOCK_KEY = 'scheduler:crawler';
const SCHEDULER_LOCK_TTL_SECONDS = 5 * 60;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let running = false;
let paused = false;
let lastStartedAt: Date | null = null;
let lastCompletedAt: Date | null = null;
let lastDurationMs: number | null = null;
let lastError: string | null = null;
let lastLockProvider = 'unknown';
let lastProcessedTenants = 0;
let lastDueCrawlers = 0;

async function runOnce(manual = false): Promise<{
  dueCrawlers: number;
  processedTenants: number;
}> {
  if (paused && !manual) return { dueCrawlers: 0, processedTenants: 0 };
  if (running) return { dueCrawlers: 0, processedTenants: 0 };
  running = true;
  let lockToken: string | undefined;
  const startedAt = new Date();
  lastStartedAt = startedAt;
  let processedTenants = 0;
  let dueCrawlersCount = 0;

  try {
    const cache = await getCache();
    lastLockProvider = cache.name;
    lockToken = await cache.acquireLock(SCHEDULER_LOCK_KEY, SCHEDULER_LOCK_TTL_SECONDS);
    const holdsGlobalLock = Boolean(lockToken);
    const thisNode = getThisNodeName();
    const defaultNode = await resolveDefaultNodeName();

    const mainDb = await getDatabase();
    const tenants = await mainDb.listTenants();

    for (const tenant of tenants) {
      if (!tenant.dbName) continue;
      processedTenants += 1;

      try {
        const tenantDb = await getTenantDatabase(tenant.dbName);
        const tenantId = String(tenant._id);
        const crawlers = await tenantDb.listCrawlers(tenantId);
        const now = new Date();

        const due = crawlers.filter((c) => {
          if (c.status !== 'active') return false;
          if (!c.schedule?.enabled) return false;
          const next = computeNextRun(c.schedule, now);
          if (!next) return false;
          return next.getTime() <= now.getTime();
        });

        const eligible: ICrawler[] = [];
        for (const crawler of due) {
          const assignment = await findInstanceAssignment(
            'crawler',
            crawlerEntityId(tenantId, crawler.key),
          );
          const target = assignment?.nodeName ?? defaultNode;
          if (assignment) {
            if (target === thisNode) eligible.push(crawler);
          } else if (holdsGlobalLock) {
            eligible.push(crawler);
          }
        }

        if (eligible.length === 0) continue;
        dueCrawlersCount += eligible.length;

        await Promise.allSettled(
          eligible.map(async (crawler) => {
            try {
              const next = computeNextRun(
                { ...crawler.schedule!, lastRunAt: now },
                now,
              );
              await tenantDb.updateCrawler(String(crawler._id), {
                schedule: {
                  ...crawler.schedule!,
                  lastRunAt: now,
                  nextRunAt: next ?? undefined,
                },
              });
              await runCrawler(
                {
                  tenantDbName: tenant.dbName,
                  tenantId,
                  projectId: crawler.projectId,
                },
                crawler.key,
                {
                  trigger: 'schedule',
                  triggerActor: 'system:scheduler',
                },
              );
            } catch (err) {
              logger.error(`Scheduled run failed for ${tenant.slug}/${crawler.key}`, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );
      } catch (err) {
        logger.error(`Error processing tenant ${tenant.slug}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    lastError = null;
    lastProcessedTenants = processedTenants;
    lastDueCrawlers = dueCrawlersCount;
    return { dueCrawlers: dueCrawlersCount, processedTenants };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logger.error('Fatal scheduler error', {
      error: err instanceof Error ? err.message : err,
    });
    throw err;
  } finally {
    if (lockToken) {
      try {
        const cache = await getCache();
        await cache.releaseLock(SCHEDULER_LOCK_KEY, lockToken);
      } catch (err) {
        logger.warn('Failed to release scheduler lock', {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    lastCompletedAt = new Date();
    lastDurationMs = lastCompletedAt.getTime() - startedAt.getTime();
    running = false;
  }
}

export function startCrawlerScheduler(): void {
  if (schedulerTimer !== null) return;
  logger.info(`Started (check interval: ${CHECK_INTERVAL_MS / 1000}s)`);
  void runOnce();
  schedulerTimer = setInterval(() => {
    void runOnce();
  }, CHECK_INTERVAL_MS);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

export function stopCrawlerScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('Stopped');
  }
}

export function pauseCrawlerScheduler(): void {
  paused = true;
}

export function resumeCrawlerScheduler(): void {
  paused = false;
}

export async function triggerCrawlerSchedulerRun(): Promise<{
  dueCrawlers: number;
  processedTenants: number;
}> {
  return runOnce(true);
}

export function getCrawlerSchedulerStatus() {
  return {
    checkIntervalMs: CHECK_INTERVAL_MS,
    distributedLock: lastLockProvider === 'redis',
    key: 'crawler',
    lastCompletedAt,
    lastDueCrawlers,
    lastDurationMs,
    lastError,
    lastLockProvider,
    lastProcessedTenants,
    lastStartedAt,
    paused,
    running,
  };
}
