/**
 * Bounded background queue for shadow evaluations.
 *
 * The request path only ever calls `submitShadowJob()`: it never awaits the job,
 * never sees its errors, and when the queue is full the job is dropped (and
 * counted) instead of buffered — shadow mode must not be able to slow down or
 * exhaust memory of the process it is observing. Jobs start on `setImmediate`,
 * i.e. after the current request has yielded the event loop.
 */

import { bumpTenantMetric, shadowMetrics } from './metrics';

export const MAX_QUEUE = 500;
export const CONCURRENCY = 4;
/** A job that has not settled by then gives its slot back (the job itself cannot be cancelled). */
export const JOB_TIMEOUT_MS = 5_000;
/** Consecutive timed-out jobs that trip the breaker ... */
export const BREAKER_THRESHOLD = 8;
/** ... and how long new work is shed while it is open. */
export const BREAKER_COOLDOWN_MS = 30_000;

type Job = () => Promise<void>;
interface Queued {
  job: Job;
  tenantDbName?: string;
}

const queue: Queued[] = [];
let running = 0;
let consecutiveTimeouts = 0;
let breakerOpenUntil = 0;
let jobTimeoutMs = JOB_TIMEOUT_MS;

export function getShadowQueueDepth(): {
  queued: number;
  running: number;
  maxQueue: number;
  concurrency: number;
  breakerOpen: boolean;
} {
  return { queued: queue.length, running, maxQueue: MAX_QUEUE, concurrency: CONCURRENCY, breakerOpen: Date.now() < breakerOpenUntil };
}

class JobTimeoutError extends Error {
  constructor() {
    super('shadow job timed out');
  }
}

function withDeadline(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JobTimeoutError()), jobTimeoutMs);
    timer.unref?.();
    let result: Promise<void>;
    try {
      result = Promise.resolve(run());
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function trip(): void {
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  consecutiveTimeouts = 0;
  // Do not keep pinning work that would hit the same hung dependency.
  shadowMetrics.queueDrops += queue.length;
  for (const q of queue) if (q.tenantDbName) bumpTenantMetric(q.tenantDbName, 'queueDrops');
  queue.length = 0;
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const { job, tenantDbName } = queue.shift()!;
    running++;
    setImmediate(() => {
      withDeadline(job)
        .then(() => {
          consecutiveTimeouts = 0;
        })
        .catch((error) => {
          shadowMetrics.evaluationFailures++;
          if (tenantDbName) bumpTenantMetric(tenantDbName, 'evaluationFailures');
          if (error instanceof JobTimeoutError) {
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= BREAKER_THRESHOLD) trip();
          }
        })
        .finally(() => {
          running--;
          pump();
        });
    });
  }
}

/** Returns false when the job was dropped (queue full or breaker open). */
export function submitShadowJob(job: Job, tenantDbName?: string): boolean {
  if (queue.length >= MAX_QUEUE || Date.now() < breakerOpenUntil) {
    shadowMetrics.queueDrops++;
    if (tenantDbName) bumpTenantMetric(tenantDbName, 'queueDrops');
    return false;
  }
  queue.push({ job, tenantDbName });
  shadowMetrics.enqueued++;
  if (tenantDbName) bumpTenantMetric(tenantDbName, 'enqueued');
  pump();
  return true;
}

/** Resolves when the queue is empty and nothing is running (tests, shutdown). */
export async function drainShadowQueue(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length > 0 || running > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function resetShadowQueueForTests(): void {
  queue.length = 0;
  consecutiveTimeouts = 0;
  breakerOpenUntil = 0;
  jobTimeoutMs = JOB_TIMEOUT_MS;
}

/** Test seam: shrink the job deadline. */
export function setShadowJobTimeoutForTests(ms: number): void {
  jobTimeoutMs = ms;
}
