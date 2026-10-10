/**
 * Webhook subscriptions: publishing an event, delivering it, and the retry /
 * auto-disable policy.
 *
 *   publishWebhookEvent        one `webhook_deliveries` row per matching active
 *                              endpoint, each enqueued on the `webhooks` queue
 *   deliverWebhookJob          the queue handler: lease the row, send, settle
 *   sweepDueWebhookDeliveries  the reconciler's net — pending rows that are due
 *                              are enqueued again, so retries survive a restart
 *                              and a memory queue that lost its messages
 *
 * A delivery is `pending` while it is owed (first attempt or a scheduled
 * retry), `delivered` after a 2xx, `failed` when it will not be tried again.
 * The retry wait comes from `WEBHOOK_RETRY_SCHEDULE_SECONDS`; a 3xx answer or
 * an address the SSRF guard refuses disables the endpoint at once, and an
 * endpoint that fails continuously for `WEBHOOK_AUTO_DISABLE_HOURS` is disabled.
 * Any 2xx clears the failing streak.
 */

import crypto from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { getDatabase, type DatabaseProvider } from '@/lib/database';
import type { IWebhookDelivery, IWebhookEndpoint, WebhookDisabledReason } from '@/lib/database';
import { decryptObject } from '@/lib/utils/crypto';
import { eventMatches } from './webhookEvents';
import { sendSignedWebhook, type WebhookSendResult } from './webhookDeliverer';

const logger = createLogger('webhooks');

/** Own queue (and own consumer), so a slow receiver never delays agent runs. */
export const WEBHOOK_QUEUE = 'webhooks';
export const WEBHOOK_DELIVER_JOB = 'deliver';
export const WEBHOOK_USER_AGENT = 'cognipeer-webhooks/1.0';

/** A claimed delivery stays leased this long beyond the request timeout. */
const LEASE_PADDING_MS = 60_000;
/** Bound on the deliveries one reconciler tick re-enqueues per tenant. */
export const WEBHOOK_SWEEP_BATCH = 200;
const DAY_MS = 86_400_000;

export interface WebhookDeliveryJob extends QueuePayload {
  deliveryId: string;
  tenantDbName: string;
}

/** Bound to the tenant DB for the whole callback — see `runWithTenantDb` in agentRunService (not imported: it would be a cycle). */
async function inTenant<T>(tenantDbName: string, fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
  const db = await getDatabase();
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, () => fn(db));
  await db.switchToTenant(tenantDbName);
  return fn(db);
}

export const newWebhookEventId = () => `evt_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** The thin body that is signed and sent. */
export function buildWebhookPayload(input: {
  eventId: string;
  type: string;
  projectId?: string | null;
  data?: Record<string, unknown>;
  createdAt?: Date;
}): Record<string, unknown> {
  return {
    id: input.eventId,
    type: input.type,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    projectId: input.projectId ?? null,
    data: input.data ?? {},
  };
}

function openSecret(sealed: string): string | undefined {
  try {
    return decryptObject<string>(sealed) || undefined;
  } catch {
    return undefined;
  }
}

// ── Queue ────────────────────────────────────────────────────────────────

export async function enqueueWebhookDelivery(job: WebhookDeliveryJob): Promise<void> {
  const queue = await getQueue();
  // One attempt per job: retries are rows with a `nextAttemptAt`, not queue backoff.
  await queue.publish(WEBHOOK_QUEUE, WEBHOOK_DELIVER_JOB, job, { attempts: 1 });
}

// ── Publishing ───────────────────────────────────────────────────────────

export interface PublishWebhookEventInput {
  tenantDbName: string;
  tenantId: string;
  /** The project the event happened in; endpoints scoped to another project do not see it. */
  projectId?: string | null;
  type: string;
  /** Ids and small fields only. */
  data?: Record<string, unknown>;
}

/**
 * Records the event for every matching active endpoint (tenant-wide ones, and
 * those of `projectId`) and enqueues the deliveries. Best effort and never
 * throws: a publisher is in the middle of something that must not fail because
 * of a webhook. A delivery whose job could not be enqueued is still `pending`
 * and due, so the reconciler picks it up.
 */
export async function publishWebhookEvent(input: PublishWebhookEventInput): Promise<{ eventId: string | null; deliveries: number }> {
  try {
    return await inTenant(input.tenantDbName, async (db) => {
      const scopes: Array<string | null> = input.projectId ? [input.projectId, null] : [null];
      const endpoints = await db.listWebhookEndpoints(input.tenantId, { projectScopes: scopes, status: 'active' });
      const matching = endpoints.filter((endpoint) => eventMatches(endpoint.events, input.type));
      if (matching.length === 0) return { eventId: null, deliveries: 0 };

      const eventId = newWebhookEventId();
      const now = new Date();
      const payload = buildWebhookPayload({ eventId, type: input.type, projectId: input.projectId, data: input.data, createdAt: now });
      const rows = await db.createWebhookDeliveries(matching.map((endpoint) => ({
        tenantId: input.tenantId,
        projectId: input.projectId ?? null,
        endpointId: String(endpoint._id),
        eventId,
        eventType: input.type,
        payload,
        status: 'pending' as const,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })));
      for (const row of rows) {
        await enqueueWebhookDelivery({ deliveryId: String(row._id), tenantDbName: input.tenantDbName }).catch((error) => {
          logger.warn('Could not enqueue a webhook delivery; the reconciler will', {
            deliveryId: String(row._id),
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { eventId, deliveries: rows.length };
    });
  } catch (error) {
    logger.warn('Could not publish a webhook event', {
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return { eventId: null, deliveries: 0 };
  }
}

// ── Delivering ───────────────────────────────────────────────────────────

/** Switches the endpoint off and gives up on everything still queued for it. */
export async function disableWebhookEndpoint(
  db: DatabaseProvider,
  endpoint: Pick<IWebhookEndpoint, '_id'>,
  reason: WebhookDisabledReason,
): Promise<IWebhookEndpoint | null> {
  const id = String(endpoint._id);
  const updated = await db.updateWebhookEndpoint(id, { status: 'disabled', disabledReason: reason });
  await db.failPendingWebhookDeliveries(id, `Endpoint disabled (${reason})`);
  return updated;
}

export interface SettleOptions {
  /** A test send: record the answer, but no retry and no effect on the endpoint's health. */
  oneShot?: boolean;
  now?: Date;
}

/**
 * Writes the outcome of one attempt onto the delivery (and the endpoint's
 * health). The whole retry / disable policy lives here.
 */
export async function settleWebhookAttempt(
  db: DatabaseProvider,
  delivery: IWebhookDelivery,
  endpoint: IWebhookEndpoint,
  result: WebhookSendResult,
  options: SettleOptions = {},
): Promise<IWebhookDelivery | null> {
  const cfg = getConfig().webhooks;
  const now = options.now ?? new Date();
  const id = String(delivery._id);
  const attempts = delivery.attempts + 1;
  const record = {
    attempts,
    lastStatusCode: result.statusCode ?? null,
    lastDurationMs: result.durationMs,
  };

  if (result.ok) {
    if (!options.oneShot && endpoint.failingSince) {
      await db.updateWebhookEndpoint(String(endpoint._id), { failingSince: null });
    }
    return db.updateWebhookDelivery(id, {
      ...record, status: 'delivered', nextAttemptAt: null, lastError: null, deliveredAt: now,
    });
  }

  const lastError = result.error ?? 'Delivery failed';
  const fail = (error = lastError) => db.updateWebhookDelivery(id, { ...record, status: 'failed', nextAttemptAt: null, lastError: error });
  if (options.oneShot) return fail();

  if (result.outcome === 'redirect') {
    await disableWebhookEndpoint(db, endpoint, 'redirect');
    return fail(`${lastError}. Redirects are not followed; the endpoint was disabled. Update its URL to the final address.`);
  }
  if (result.outcome === 'blocked') {
    await disableWebhookEndpoint(db, endpoint, 'blocked_address');
    return fail(`${lastError}. The endpoint was disabled.`);
  }

  // A retryable failure: extend (or start) the failing streak.
  const failingSince = endpoint.failingSince ? new Date(endpoint.failingSince) : now;
  if (!endpoint.failingSince) await db.updateWebhookEndpoint(String(endpoint._id), { failingSince });
  if (now.getTime() - failingSince.getTime() >= cfg.autoDisableHours * 3_600_000) {
    await disableWebhookEndpoint(db, endpoint, 'sustained_failure');
    return fail(`${lastError}. The endpoint failed continuously for ${cfg.autoDisableHours}h and was disabled.`);
  }

  const waitSeconds = cfg.retryScheduleSeconds[attempts - 1];
  if (waitSeconds === undefined) return fail(`${lastError}. Gave up after ${attempts} attempts.`);
  return db.updateWebhookDelivery(id, {
    ...record,
    status: 'pending',
    nextAttemptAt: new Date(now.getTime() + waitSeconds * 1000),
    lastError,
  });
}

/** Sends a delivery this caller already holds the lease on, and settles it. */
export async function runClaimedWebhookDelivery(
  db: DatabaseProvider,
  delivery: IWebhookDelivery,
  options: SettleOptions = {},
): Promise<IWebhookDelivery | null> {
  const id = String(delivery._id);
  const endpoint = await db.findWebhookEndpointById(delivery.endpointId);
  if (!endpoint) {
    return db.updateWebhookDelivery(id, { status: 'failed', nextAttemptAt: null, lastError: 'Endpoint was removed' });
  }
  // A test send goes to a disabled endpoint on purpose (to check a fix before re-enabling).
  if (endpoint.status !== 'active' && !options.oneShot) {
    return db.updateWebhookDelivery(id, { status: 'failed', nextAttemptAt: null, lastError: `Endpoint is disabled${endpoint.disabledReason ? ` (${endpoint.disabledReason})` : ''}` });
  }

  const secret = openSecret(endpoint.secretSealed);
  const result: WebhookSendResult = secret
    ? await sendSignedWebhook({
      url: endpoint.url,
      body: JSON.stringify(delivery.payload),
      eventName: delivery.eventType,
      eventId: delivery.eventId,
      userAgent: WEBHOOK_USER_AGENT,
      secret,
      timeoutMs: getConfig().webhooks.timeoutMs,
      followRedirects: false,
      webhookIdHeader: true,
    })
    // Never send unsigned: a secret that cannot be read (a rotated encryption key) is a failure to fix.
    : { outcome: 'network', ok: false, durationMs: 0, error: 'The endpoint signing secret could not be read; rotate it' };
  logger.info('Webhook delivery attempt', {
    deliveryId: id, endpointId: delivery.endpointId, eventType: delivery.eventType,
    attempt: delivery.attempts + 1, outcome: result.outcome, statusCode: result.statusCode,
  });
  return settleWebhookAttempt(db, delivery, endpoint, result, options);
}

/** The `webhooks` queue handler. */
export async function deliverWebhookJob(job: WebhookDeliveryJob): Promise<void> {
  await inTenant(job.tenantDbName, async (db) => {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + getConfig().webhooks.timeoutMs + LEASE_PADDING_MS);
    const claimed = await db.claimWebhookDelivery(job.deliveryId, now, leaseUntil);
    // Not due, already delivered, or another worker holds it.
    if (!claimed) return;
    await runClaimedWebhookDelivery(db, claimed);
  });
}

/**
 * Sends one event to one endpoint right now and returns the recorded
 * delivery — the "Send test event" button. One attempt, no retries, and the
 * answer does not count towards the endpoint's health.
 */
export async function sendWebhookNow(
  db: DatabaseProvider,
  endpoint: IWebhookEndpoint,
  event: { type: string; projectId?: string | null; data?: Record<string, unknown> },
): Promise<IWebhookDelivery | null> {
  const now = new Date();
  const eventId = newWebhookEventId();
  const [row] = await db.createWebhookDeliveries([{
    tenantId: endpoint.tenantId,
    projectId: event.projectId ?? null,
    endpointId: String(endpoint._id),
    eventId,
    eventType: event.type,
    payload: buildWebhookPayload({ eventId, type: event.type, projectId: event.projectId, data: event.data, createdAt: now }),
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
  }]);
  const claimed = await db.claimWebhookDelivery(String(row._id), now, new Date(now.getTime() + getConfig().webhooks.timeoutMs + LEASE_PADDING_MS));
  if (!claimed) return db.findWebhookDeliveryById(String(row._id));
  return runClaimedWebhookDelivery(db, claimed, { oneShot: true });
}

// ── Reconciler ───────────────────────────────────────────────────────────

/**
 * Enqueues every delivery that is `pending` and due. A delivery whose lease is
 * still running is not due, so a live attempt is never doubled; one whose
 * worker died becomes due when the lease ends.
 */
export async function sweepDueWebhookDeliveries(
  db: DatabaseProvider,
  scope: { tenantId: string; tenantDbName: string },
  now = new Date(),
): Promise<number> {
  const due = await db.listDueWebhookDeliveries(scope.tenantId, now, WEBHOOK_SWEEP_BATCH);
  let enqueued = 0;
  for (const delivery of due) {
    try {
      await enqueueWebhookDelivery({ deliveryId: String(delivery._id), tenantDbName: scope.tenantDbName });
      enqueued += 1;
    } catch (error) {
      logger.warn('Failed to enqueue a due webhook delivery', {
        deliveryId: String(delivery._id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return enqueued;
}

/** Retention: settled deliveries older than `WEBHOOK_DELIVERY_RETENTION_DAYS` are deleted. */
export async function cleanupWebhookDeliveries(db: DatabaseProvider, now = new Date()): Promise<number> {
  const olderThan = new Date(now.getTime() - getConfig().webhooks.deliveryRetentionDays * DAY_MS);
  const { deletedCount } = await db.cleanupWebhookDeliveryRetention({ olderThan, batchSize: 1000 });
  return deletedCount;
}
