/**
 * Webhook subscriptions, end to end on a real SQLite provider: publishing
 * (pattern + project matching), the signed delivery, the retry schedule, the
 * disable rules (3xx, SSRF refusal, sustained failure, a 2xx clears the streak)
 * and the reconciler picking up what the queue lost (due deliveries and
 * agent-run callbacks that never settled).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  safeFetch: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: vi.fn(),
  safeFetch: hoisted.safeFetch,
}));

vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { encryptObject } from '@/lib/utils/crypto';
import {
  WEBHOOK_QUEUE,
  deliverWebhookJob,
  publishWebhookEvent,
  settleWebhookAttempt,
  sweepDueWebhookDeliveries,
} from '@/lib/services/webhooks/webhookService';
import { signWebhookBody } from '@/lib/services/webhooks/webhookDeliverer';
import { fireAgentRunCallback, AGENT_RUN_CALLBACK_QUEUE } from '@/lib/services/agents/agentRunService';
import { triggerAgentRunReconcilerRun } from '@/lib/services/agents/agentRunReconciler';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_webhooks';
const PROJECT_ID = 'proj-1';
const SECRET = 'whsec_test_secret_value';

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.WEBHOOK_RETRY_SCHEDULE_SECONDS = '60,300,1800';
  process.env.WEBHOOK_AUTO_DISABLE_HOURS = '72';
  reloadConfig();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'webhooks-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-webhooks', dbName, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(async () => {
  delete process.env.WEBHOOK_RETRY_SCHEDULE_SECONDS;
  delete process.env.WEBHOOK_AUTO_DISABLE_HOURS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeEndpoint(overrides: Partial<Parameters<SQLiteProvider['createWebhookEndpoint']>[0]> = {}) {
  return db.createWebhookEndpoint({
    tenantId,
    projectId: PROJECT_ID,
    url: 'https://hooks.example.com/in',
    events: ['session.idled'],
    secretSealed: encryptObject(SECRET),
    status: 'active',
    createdBy: 'user-1',
    ...overrides,
  });
}

const publish = (type = 'session.idled', projectId: string | null = PROJECT_ID) => publishWebhookEvent({
  tenantDbName: dbName, tenantId, projectId, type, data: { conversationId: 'conv-1', agentKey: 'bot' },
});

async function onlyDelivery(endpointId: string) {
  const rows = await db.listWebhookDeliveries(endpointId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('publishWebhookEvent', () => {
  it('writes one delivery per matching active endpoint and enqueues each on the webhooks queue', async () => {
    const exact = await makeEndpoint();
    const pattern = await makeEndpoint({ events: ['session.*'] });
    const all = await makeEndpoint({ events: ['*'], projectId: null });
    await makeEndpoint({ events: ['agent_run.*'] });
    await makeEndpoint({ status: 'disabled', disabledReason: 'manual' });

    const result = await publish();
    expect(result.deliveries).toBe(3);

    for (const endpoint of [exact, pattern, all]) {
      const delivery = await onlyDelivery(String(endpoint._id));
      expect(delivery.status).toBe('pending');
      expect(delivery.attempts).toBe(0);
      expect(delivery.eventId).toBe(result.eventId);
    }
    expect(hoisted.publish).toHaveBeenCalledTimes(3);
    const [queue, job, payload, options] = hoisted.publish.mock.calls[0];
    expect(queue).toBe(WEBHOOK_QUEUE);
    expect(job).toBe('deliver');
    expect(payload).toMatchObject({ tenantDbName: dbName });
    expect((options as { attempts: number }).attempts).toBe(1);
  });

  it('sends a thin payload: id, type, createdAt, projectId and small data — nothing else', async () => {
    const endpoint = await makeEndpoint();
    const { eventId } = await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    expect(Object.keys(delivery.payload).sort()).toEqual(['createdAt', 'data', 'id', 'projectId', 'type']);
    expect(delivery.payload).toMatchObject({
      id: eventId, type: 'session.idled', projectId: PROJECT_ID, data: { conversationId: 'conv-1', agentKey: 'bot' },
    });
    expect(String(eventId)).toMatch(/^evt_/);
  });

  it('keeps a project endpoint to its own project; a tenant-wide endpoint sees every project', async () => {
    const mine = await makeEndpoint({ projectId: 'proj-A' });
    const wide = await makeEndpoint({ projectId: null });
    await publish('session.idled', 'proj-B');
    expect(await db.listWebhookDeliveries(String(mine._id))).toHaveLength(0);
    expect(await db.listWebhookDeliveries(String(wide._id))).toHaveLength(1);
  });

  it('does nothing (and does not throw) when no endpoint matches, or the database fails', async () => {
    await makeEndpoint({ events: ['budget.reached'] });
    expect(await publish()).toEqual({ eventId: null, deliveries: 0 });
    expect(hoisted.publish).not.toHaveBeenCalled();

    hoisted.getDatabase.mockRejectedValue(new Error('db down'));
    (getDatabase as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    await expect(publish()).resolves.toEqual({ eventId: null, deliveries: 0 });
  });

  it('a lost enqueue leaves the delivery pending and due, for the reconciler', async () => {
    const endpoint = await makeEndpoint();
    hoisted.publish.mockRejectedValue(new Error('queue down'));
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    expect(delivery.status).toBe('pending');
    expect(new Date(delivery.nextAttemptAt!).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('delivery (deliverWebhookJob)', () => {
  it('POSTs the signed body with the event headers, once, and records the delivery', async () => {
    const endpoint = await makeEndpoint();
    const { eventId } = await publish();
    const delivery = await onlyDelivery(String(endpoint._id));

    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });

    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    const [url, init, options] = hoisted.safeFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }, { timeoutMs: number; followRedirects?: boolean }];
    expect(url).toBe('https://hooks.example.com/in');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-cognipeer-event': 'session.idled',
      'x-cognipeer-event-id': eventId,
      'webhook-id': eventId,
    });
    // A moved endpoint is an answer, not something to follow.
    expect(options.followRedirects).toBe(false);
    expect(options.timeoutMs).toBe(10_000);

    const header = init.headers['x-cognipeer-signature'];
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header)!;
    const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${init.body}`).digest('hex');
    expect(v1).toBe(expected);
    expect(signWebhookBody(SECRET, init.body, Number(t))).toBe(header);
    expect(JSON.parse(init.body)).toMatchObject({ id: eventId, type: 'session.idled' });

    const after = await db.findWebhookDeliveryById(String(delivery._id));
    expect(after).toMatchObject({ status: 'delivered', attempts: 1, lastStatusCode: 200, lastError: null });
    expect(after?.deliveredAt).toBeInstanceOf(Date);
  });

  it('delivers a delivery once even when the publisher and the reconciler both enqueued it', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    const job = { deliveryId: String(delivery._id), tenantDbName: dbName };
    await Promise.all([deliverWebhookJob(job), deliverWebhookJob(job), deliverWebhookJob(job)]);
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('fails a delivery whose endpoint is gone or disabled without sending anything', async () => {
    const gone = await makeEndpoint();
    const off = await makeEndpoint();
    await publish();
    await db.deleteWebhookEndpoint(String(gone._id));
    await db.updateWebhookEndpoint(String(off._id), { status: 'disabled', disabledReason: 'manual' });
    const rows = await db.listDueWebhookDeliveries(tenantId, new Date());
    // The deleted endpoint's delivery went with it; the disabled one's is still queued.
    expect(rows).toHaveLength(1);
    await deliverWebhookJob({ deliveryId: String(rows[0]._id), tenantDbName: dbName });
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
    expect((await db.findWebhookDeliveryById(String(rows[0]._id)))?.status).toBe('failed');
  });

  it('never sends unsigned: an unreadable secret fails the attempt', async () => {
    const endpoint = await makeEndpoint({ secretSealed: 'not-a-sealed-value' });
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
    const after = await db.findWebhookDeliveryById(String(delivery._id));
    expect(after?.status).toBe('pending');
    expect(after?.lastError).toMatch(/secret/i);
  });
});

describe('retry schedule', () => {
  it('waits 60s, 300s, 1800s (the configured schedule) after each failure, then gives up', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    let delivery = await onlyDelivery(String(endpoint._id));
    hoisted.safeFetch.mockResolvedValue(new Response('boom', { status: 503 }));

    const t0 = new Date('2026-10-10T12:00:00Z');
    for (const [index, waitSeconds] of [60, 300, 1800].entries()) {
      const current = (await db.findWebhookEndpointById(String(endpoint._id)))!;
      const settled = await settleWebhookAttempt(db, delivery, current, {
        outcome: 'http_error', ok: false, statusCode: 503, durationMs: 5, error: 'Endpoint answered HTTP 503',
      }, { now: t0 });
      expect(settled).toMatchObject({ status: 'pending', attempts: index + 1, lastStatusCode: 503 });
      expect(new Date(settled!.nextAttemptAt!).getTime() - t0.getTime()).toBe(waitSeconds * 1000);
      delivery = settled!;
    }

    const current = (await db.findWebhookEndpointById(String(endpoint._id)))!;
    const last = await settleWebhookAttempt(db, delivery, current, {
      outcome: 'network', ok: false, durationMs: 5, error: 'ECONNRESET',
    }, { now: t0 });
    expect(last).toMatchObject({ status: 'failed', attempts: 4, nextAttemptAt: null });
    expect(last?.lastError).toMatch(/gave up after 4 attempts/i);
    // Running out of retries is not by itself a reason to switch the endpoint off.
    expect((await db.findWebhookEndpointById(String(endpoint._id)))?.status).toBe('active');
  });

  it('a failed attempt through the job leaves the delivery pending with the first wait', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    hoisted.safeFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    const before = Date.now();
    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });
    const after = await db.findWebhookDeliveryById(String(delivery._id));
    expect(after?.status).toBe('pending');
    const wait = new Date(after!.nextAttemptAt!).getTime() - before;
    expect(wait).toBeGreaterThan(59_000);
    expect(wait).toBeLessThan(62_000);
  });
});

describe('disabling an endpoint', () => {
  it('a 3xx answer disables it at once, records why, and fails what was queued for it', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    await publish();
    const [first] = await db.listWebhookDeliveries(String(endpoint._id));
    hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } }));

    await deliverWebhookJob({ deliveryId: String(first._id), tenantDbName: dbName });

    const after = await db.findWebhookEndpointById(String(endpoint._id));
    expect(after).toMatchObject({ status: 'disabled', disabledReason: 'redirect' });
    const deliveries = await db.listWebhookDeliveries(String(endpoint._id));
    expect(deliveries.every((d) => d.status === 'failed')).toBe(true);
    expect(deliveries.find((d) => d._id === first._id)).toMatchObject({ lastStatusCode: 302, attempts: 1 });
    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('an address the SSRF guard refuses disables it at once', async () => {
    const endpoint = await makeEndpoint({ url: 'http://10.0.0.5/hook' });
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    const refused = new Error('Refusing outbound request to private/loopback host: 10.0.0.5');
    refused.name = 'OutboundNetworkError';
    hoisted.safeFetch.mockRejectedValue(refused);

    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });

    expect(await db.findWebhookEndpointById(String(endpoint._id))).toMatchObject({ status: 'disabled', disabledReason: 'blocked_address' });
    expect((await db.findWebhookDeliveryById(String(delivery._id)))?.status).toBe('failed');
  });

  it('a plain network failure is retried, not disabled', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    hoisted.safeFetch.mockRejectedValue(new Error('ECONNRESET'));
    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });
    expect((await db.findWebhookEndpointById(String(endpoint._id)))?.status).toBe('active');
    expect((await db.findWebhookDeliveryById(String(delivery._id)))?.status).toBe('pending');
  });

  it('failing continuously for longer than WEBHOOK_AUTO_DISABLE_HOURS disables it; the first failure only starts the clock', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    const failure = { outcome: 'http_error' as const, ok: false, statusCode: 500, durationMs: 1, error: 'Endpoint answered HTTP 500' };
    const now = new Date('2026-10-10T12:00:00Z');

    // First failure: the streak starts now, the endpoint stays on.
    await settleWebhookAttempt(db, delivery, (await db.findWebhookEndpointById(String(endpoint._id)))!, failure, { now });
    const started = await db.findWebhookEndpointById(String(endpoint._id));
    expect(started?.status).toBe('active');
    expect(started?.failingSince?.toISOString()).toBe(now.toISOString());

    // 71h later: still on.
    const at71 = new Date(now.getTime() + 71 * 3_600_000);
    await settleWebhookAttempt(db, delivery, started!, failure, { now: at71 });
    expect((await db.findWebhookEndpointById(String(endpoint._id)))?.status).toBe('active');

    // 73h later: off, for the right reason, and the delivery is not retried.
    const at73 = new Date(now.getTime() + 73 * 3_600_000);
    const settled = await settleWebhookAttempt(db, delivery, started!, failure, { now: at73 });
    expect(await db.findWebhookEndpointById(String(endpoint._id))).toMatchObject({ status: 'disabled', disabledReason: 'sustained_failure' });
    expect(settled?.status).toBe('failed');
  });

  it('any 2xx clears the failing streak', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    await db.updateWebhookEndpoint(String(endpoint._id), { failingSince: new Date(Date.now() - 3_600_000) });

    await deliverWebhookJob({ deliveryId: String(delivery._id), tenantDbName: dbName });

    const after = await db.findWebhookEndpointById(String(endpoint._id));
    expect(after?.failingSince).toBeNull();
    expect(after?.status).toBe('active');
  });
});

describe('reconciler durability', () => {
  it('enqueues pending deliveries that are due, and leaves the not-yet-due, leased and settled ones alone', async () => {
    const endpoint = await makeEndpoint();
    const now = new Date();
    const base = {
      tenantId, projectId: PROJECT_ID, endpointId: String(endpoint._id), eventType: 'session.idled',
      payload: {}, attempts: 1, createdAt: now,
    };
    const [due, later, delivered] = await db.createWebhookDeliveries([
      { ...base, eventId: 'evt_due', status: 'pending', nextAttemptAt: new Date(now.getTime() - 1_000) },
      { ...base, eventId: 'evt_later', status: 'pending', nextAttemptAt: new Date(now.getTime() + 600_000) },
      { ...base, eventId: 'evt_done', status: 'delivered', nextAttemptAt: null },
    ]);

    const enqueued = await sweepDueWebhookDeliveries(db, { tenantId, tenantDbName: dbName }, now);

    expect(enqueued).toBe(1);
    expect(hoisted.publish).toHaveBeenCalledTimes(1);
    expect(hoisted.publish.mock.calls[0][0]).toBe(WEBHOOK_QUEUE);
    expect(hoisted.publish.mock.calls[0][2]).toEqual({ deliveryId: String(due._id), tenantDbName: dbName });
    expect(String(later._id)).not.toBe(String(due._id));
    expect(String(delivered._id)).not.toBe(String(due._id));
  });

  it('a tick re-enqueues a retry that came due, and a worker that died holding the lease is retried once the lease ends', async () => {
    const endpoint = await makeEndpoint();
    await publish();
    const delivery = await onlyDelivery(String(endpoint._id));
    hoisted.publish.mockClear();

    // The worker claimed it (lease pushed forward), then died.
    const claimed = await db.claimWebhookDelivery(String(delivery._id), new Date(), new Date(Date.now() + 60_000));
    expect(claimed).not.toBeNull();
    await triggerAgentRunReconcilerRun();
    expect(hoisted.publish.mock.calls.filter(([queue]) => queue === WEBHOOK_QUEUE)).toHaveLength(0);

    // The lease runs out.
    await db.updateWebhookDelivery(String(delivery._id), { nextAttemptAt: new Date(Date.now() - 1_000) });
    await triggerAgentRunReconcilerRun();
    const sent = hoisted.publish.mock.calls.filter(([queue]) => queue === WEBHOOK_QUEUE);
    expect(sent).toHaveLength(1);
    expect(sent[0][2]).toMatchObject({ deliveryId: String(delivery._id) });
  });

  describe('agent-run callbacks that never settled', () => {
    const callbackRun = async (overrides: Record<string, unknown> = {}) => {
      const run = await db.createAgentRun({
        mode: 'background', tenantId, tenantDbName: dbName, projectId: PROJECT_ID, agentKey: 'bot',
        conversationId: `conv-${Math.random().toString(36).slice(2)}`, userMessage: 'hi', status: 'succeeded',
        callbackUrl: 'https://example.com/cb', callbackStatus: 'pending', callbackAttempts: 0,
        result: { id: 'resp_x', status: 'completed' },
        ...overrides,
      } as Parameters<SQLiteProvider['createAgentRun']>[0]);
      return run;
    };
    /** Age the row so it is past the grace the reconciler leaves a live retry. */
    const age = (id: unknown) => {
      (db as unknown as { getTenantDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } })
        .getTenantDb()
        .prepare('UPDATE agent_runs SET updatedAt = ? WHERE id = ?')
        .run(new Date(Date.now() - 10 * 60_000).toISOString(), String(id));
    };
    const callbackJobs = () => hoisted.publish.mock.calls.filter(([queue, name]) => queue === AGENT_RUN_CALLBACK_QUEUE && name === 'callback');

    it('sends again a finished run whose callback is still pending or failed with attempts to spare', async () => {
      const pending = await callbackRun();
      const failed = await callbackRun({ callbackStatus: 'failed', callbackAttempts: 3, status: 'failed', errorReason: 'agent_error' });
      const waiting = await callbackRun({ status: 'requires_action' });
      for (const run of [pending, failed, waiting]) age(run._id);

      await triggerAgentRunReconcilerRun();

      const jobs = callbackJobs();
      expect(jobs).toHaveLength(3);
      const byRun = new Map(jobs.map(([, , payload]) => [(payload as { runId: string }).runId, payload as Record<string, unknown>]));
      expect(byRun.get(String(pending._id))).toMatchObject({ event: 'succeeded', callbackUrl: 'https://example.com/cb', data: { result: { id: 'resp_x', status: 'completed' } } });
      expect(byRun.get(String(failed._id))).toMatchObject({ event: 'failed', data: { errorReason: 'agent_error' } });
      expect(byRun.get(String(waiting._id))).toMatchObject({ event: 'requires_action' });
      // One attempt per tick — the tick is the cadence.
      expect(jobs.every(([, , , options]) => (options as { attempts: number }).attempts === 1)).toBe(true);
    });

    it('leaves alone a delivered callback, one out of attempts, a run still working, one with no callback, and a recent touch', async () => {
      const delivered = await callbackRun({ callbackStatus: 'delivered', callbackAttempts: 1 });
      const exhausted = await callbackRun({ callbackStatus: 'failed', callbackAttempts: 5 });
      const working = await callbackRun({ status: 'queued' });
      const none = await callbackRun({ callbackUrl: null, callbackStatus: null });
      await callbackRun(); // fresh: a queue retry may be in flight
      for (const run of [delivered, exhausted, working, none]) age(run._id);

      await triggerAgentRunReconcilerRun();

      expect(callbackJobs()).toHaveLength(0);
    });

    it('does not queue the same stuck callback again on the next tick while it is in flight', async () => {
      const run = await callbackRun();
      age(run._id);
      await triggerAgentRunReconcilerRun();
      await triggerAgentRunReconcilerRun();
      expect(callbackJobs()).toHaveLength(1);
    });
  });

  it('removes settled deliveries past the retention window and keeps pending ones', async () => {
    process.env.WEBHOOK_DELIVERY_RETENTION_DAYS = '7';
    reloadConfig();
    try {
      const endpoint = await makeEndpoint();
      const old = new Date(Date.now() - 10 * 86_400_000);
      const base = { tenantId, projectId: PROJECT_ID, endpointId: String(endpoint._id), eventType: 'x', payload: {}, attempts: 1, createdAt: old };
      await db.createWebhookDeliveries([
        { ...base, eventId: 'evt_old_done', status: 'delivered' },
        { ...base, eventId: 'evt_old_failed', status: 'failed' },
        { ...base, eventId: 'evt_old_pending', status: 'pending', nextAttemptAt: new Date(Date.now() + 3_600_000) },
        { ...base, eventId: 'evt_new', status: 'delivered', createdAt: new Date() },
      ]);
      const { cleanupWebhookDeliveries } = await import('@/lib/services/webhooks/webhookService');
      expect(await cleanupWebhookDeliveries(db)).toBe(2);
      const left = (await db.listWebhookDeliveries(String(endpoint._id))).map((d) => d.eventId).sort();
      expect(left).toEqual(['evt_new', 'evt_old_pending']);
    } finally {
      delete process.env.WEBHOOK_DELIVERY_RETENTION_DAYS;
      reloadConfig();
    }
  });
});

describe('agent_run events', () => {
  it('a finished run publishes agent_run.<status> to subscriptions whether or not it has a callback', async () => {
    const endpoint = await makeEndpoint({ events: ['agent_run.*'] });
    const run = await db.createAgentRun({
      mode: 'background', tenantId, tenantDbName: dbName, projectId: PROJECT_ID, agentKey: 'bot',
      conversationId: 'conv-9', userMessage: 'hi', status: 'succeeded', callbackAttempts: 0,
    });

    await fireAgentRunCallback(run, 'succeeded', {});

    const delivery = await onlyDelivery(String(endpoint._id));
    expect(delivery.eventType).toBe('agent_run.succeeded');
    expect(delivery.payload).toMatchObject({
      type: 'agent_run.succeeded',
      data: { runId: `run_${String(run._id)}`, conversationId: 'conv-9', agentKey: 'bot' },
    });
    // No callback of its own: nothing went to the callback queue.
    expect(hoisted.publish.mock.calls.filter(([queue]) => queue === AGENT_RUN_CALLBACK_QUEUE)).toHaveLength(0);
  });
});
