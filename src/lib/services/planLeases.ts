/**
 * Shared plan-limit lease helpers for the call sites that hold a concurrency
 * slot (agent sessions, background jobs, browser sessions). Hosted deployments
 * only: with plan limits off `acquirePlanLease` hands back no lease and an
 * allowed decision, so every helper here is a no-op there.
 */
import { createLogger } from '@/lib/core/logger';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import {
  PlanLimitError,
  acquirePlanLease,
  type ConcurrencyPool,
  type PlanLease,
  type PlanLimitDecision,
  type PlanLimitSource,
} from '@/lib/limits';

const logger = createLogger('plan-leases');

/** How long a refused background job waits before it asks for a slot again. */
export const JOB_LEASE_REQUEUE_DELAY_MS = 30_000;

export interface PoolLeaseAttempt {
  /** The held slot, or null when none is held (limits off, or refused). */
  lease: PlanLease | null;
  /** True only when the effective mode is `on` and the pool is full. */
  refused: boolean;
  decision: PlanLimitDecision;
}

/** One non-waiting attempt. Shadow mode never refuses. */
export async function tryPoolLease(input: {
  tenantId: string;
  pool: ConcurrencyPool;
  holderId: string;
  source?: PlanLimitSource;
}): Promise<PoolLeaseAttempt> {
  const { decision, lease } = await acquirePlanLease(input);
  return { lease, refused: !decision.allowed, decision };
}

/** The refusal a pool that is full answers with (`tenant_concurrency_limited`). */
export function concurrencyRefusal(
  pool: ConcurrencyPool,
  decision: Pick<PlanLimitDecision, 'limit' | 'used' | 'retryAfterMs'>,
  noun: string,
): PlanLimitError {
  const limit = decision.limit ?? 0;
  return new PlanLimitError({
    code: 'tenant_concurrency_limited',
    message: `All ${limit} ${noun} are in use. Try again shortly.`,
    kind: 'concurrency',
    dimension: pool,
    ...(decision.limit !== undefined ? { limit: decision.limit } : {}),
    ...(decision.used !== undefined ? { used: decision.used } : {}),
    ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
  });
}

export async function releaseQuietly(lease: PlanLease | null | undefined): Promise<void> {
  if (!lease) return;
  try {
    await lease.release();
  } catch (error) {
    logger.warn('Could not release a plan lease', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Runs a background job under one 'job' lease (holder = the job id, never an
 * item). When the pool is full the job is published again with a delay and its
 * own status is left untouched (still queued); `run` is not called. The lease
 * is released in `finally`, whatever way `run` ends.
 */
export async function runJobUnderLease<T>(input: {
  tenantId: string;
  holderId: string;
  queueName: string;
  jobName: string;
  payload: QueuePayload;
  run: () => Promise<T>;
}): Promise<{ deferred: false; value: T } | { deferred: true }> {
  const attempt = await tryPoolLease({
    tenantId: input.tenantId,
    pool: 'job',
    holderId: input.holderId,
    source: { type: 'job', id: input.holderId },
  });
  if (attempt.refused) {
    const bucket = Math.floor(Date.now() / JOB_LEASE_REQUEUE_DELAY_MS);
    const queue = await getQueue();
    await queue.publish(input.queueName, input.jobName, input.payload, {
      attempts: 1,
      delayMs: JOB_LEASE_REQUEUE_DELAY_MS,
      dedupKey: `plim_${input.queueName}_${input.holderId}_${bucket}`,
    });
    logger.info('Job pool is full; the job is requeued with a delay', {
      queue: input.queueName,
      holderId: input.holderId,
      delayMs: JOB_LEASE_REQUEUE_DELAY_MS,
    });
    return { deferred: true };
  }
  try {
    return { deferred: false, value: await input.run() };
  } finally {
    await releaseQuietly(attempt.lease);
  }
}
