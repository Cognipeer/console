/**
 * Group H (docs/guide/agent-background-execution.md §13) — callback
 * durability (§12.6).
 *
 * `fireAgentRunCallback` enqueues delivery as a queue job rather than
 * delivering in-process; `deliverAgentRunCallbackJob` (the job's handler)
 * persists `callbackStatus`/`callbackAttempts` on every attempt (success OR
 * failure) and THROWS on failure so the queue's own `attempts`/`backoff`
 * retries it — durable across a process restart mid-retry, unlike the
 * crawler's in-process `setTimeout` chain precedent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  safeFetch: vi.fn(),
  publish: vi.fn(),
  actualSafeFetch: undefined as undefined | ((...args: unknown[]) => Promise<Response>),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

// Delivery goes through safeFetch (DNS-pinned, per-hop SSRF checks). The
// transport is faked so no test touches the network; the SSRF test hands the
// call to the REAL safeFetch, whose literal-loopback refusal needs no DNS.
vi.mock('@/lib/security/outboundFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/outboundFetch')>();
  hoisted.actualSafeFetch = actual.safeFetch as (...args: unknown[]) => Promise<Response>;
  return { ...actual, safeFetch: hoisted.safeFetch };
});

vi.mock('@/lib/core/queue', () => ({
  getQueue: vi.fn(async () => ({ publish: hoisted.publish })),
}));

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import crypto from 'node:crypto';
import { encryptObject } from '@/lib/utils/crypto';
import {
  AGENT_RUN_QUEUE,
  fireAgentRunCallback,
  deliverAgentRunCallbackJob,
  signAgentRunCallback,
} from '@/lib/services/agents/agentRunService';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_callback';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-bot';

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-callback-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme',
    slug: 'acme-callback',
    dbName,
    licenseType: 'FREE',
    ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeRun(callbackUrl: string | null, callbackSecret?: string) {
  return db.createAgentRun({
    callbackSecret: callbackSecret ? encryptObject(callbackSecret) : null,
    mode: 'background',
    tenantId,
    tenantDbName: dbName,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: 'conv-1',
    userMessage: 'hello',
    status: 'succeeded',
    callbackUrl,
    callbackStatus: callbackUrl ? 'pending' : null,
    callbackAttempts: 0,
  });
}

describe('fireAgentRunCallback (enqueue side)', () => {
  it('does nothing when the run has no callbackUrl', async () => {
    const run = await makeRun(null);
    await fireAgentRunCallback(run, 'succeeded', {});
    expect(hoisted.publish).not.toHaveBeenCalled();
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('enqueues a retried callback job on the agent-runs queue instead of delivering in-process', async () => {
    const run = await makeRun('https://example.com/webhook');
    await fireAgentRunCallback(run, 'succeeded', { result: { id: 'resp_x' } });

    expect(hoisted.safeFetch).not.toHaveBeenCalled();
    expect(hoisted.publish).toHaveBeenCalledTimes(1);
    const [queue, name, payload, options] = hoisted.publish.mock.calls[0];
    expect(queue).toBe(AGENT_RUN_QUEUE);
    expect(name).toBe('callback');
    expect(payload).toMatchObject({ runId: String(run._id), event: 'succeeded', callbackUrl: 'https://example.com/webhook' });
    expect((options as { attempts: number }).attempts).toBeGreaterThan(1);
  });
});

describe('deliverAgentRunCallbackJob (delivery + durability)', () => {
  it('on success, persists callbackStatus=delivered and increments callbackAttempts', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const run = await makeRun('https://example.com/webhook');

    await deliverAgentRunCallbackJob({
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'succeeded',
      data: { foo: 'bar' },
    });

    expect(hoisted.safeFetch).toHaveBeenCalledTimes(1);
    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('delivered');
    expect(after?.callbackAttempts).toBe(1);
  });

  it('on failure, persists callbackStatus=failed with an incremented attempt count and THROWS (so the queue retries)', async () => {
    hoisted.safeFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const run = await makeRun('https://example.com/webhook');

    await expect(deliverAgentRunCallbackJob({
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'failed',
      data: {},
    })).rejects.toThrow();

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('failed');
    expect(after?.callbackAttempts).toBe(1);
  });

  it('attempts accumulate across repeated (queue-retried) invocations, surviving a fresh read each time', async () => {
    hoisted.safeFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const run = await makeRun('https://example.com/webhook');

    const attempt = () => deliverAgentRunCallbackJob({
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'failed',
      data: {},
    }).catch(() => undefined);

    await attempt();
    await attempt();
    await attempt();

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackAttempts).toBe(3);
    expect(after?.callbackStatus).toBe('failed');
  });

  it('a non-2xx answer is a failed attempt (thrown, so the queue retries)', async () => {
    hoisted.safeFetch.mockResolvedValue(new Response('nope', { status: 503 }));
    const run = await makeRun('https://example.com/webhook');

    await expect(deliverAgentRunCallbackJob({
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'succeeded',
      data: {},
    })).rejects.toThrow(/503/);

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('failed');
  });

  it('refuses delivery to a private/loopback callback URL (SSRF hardening) and marks it failed without an HTTP call', async () => {
    const realFetch = vi.spyOn(globalThis, 'fetch');
    hoisted.safeFetch.mockImplementation((...args: unknown[]) => hoisted.actualSafeFetch!(...args));
    const run = await makeRun('http://127.0.0.1:9999/webhook');

    await expect(deliverAgentRunCallbackJob({
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'succeeded',
      data: {},
    })).rejects.toThrow();

    expect(realFetch).not.toHaveBeenCalled();
    realFetch.mockRestore();
    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('failed');
  });
});

describe('callback wire format (signing, stable event id, public ids)', () => {
  const SECRET = 'whsec_0123456789abcdef';

  function payloadFor(run: { _id?: unknown; conversationId: string; callbackUrl?: string | null }) {
    return {
      runId: String(run._id),
      tenantId,
      tenantDbName: dbName,
      projectId: PROJECT_ID,
      conversationId: run.conversationId,
      callbackUrl: run.callbackUrl!,
      event: 'succeeded' as const,
      data: { result: { id: `resp_${String(run._id)}` } },
    };
  }

  function sentRequest(callIndex = 0) {
    const [url, init] = hoisted.safeFetch.mock.calls[callIndex] as [string, { method: string; headers: Record<string, string>; body: string }];
    return { url, init, body: JSON.parse(init.body) as Record<string, unknown> };
  }

  it('REGRESSION: a run with a secret is signed t=..,v1=hex(HMAC_SHA256(secret, "t.body")) and the signature verifies', async () => {
    const run = await makeRun('https://example.com/webhook', SECRET);
    await deliverAgentRunCallbackJob(payloadFor(run));

    const { url, init } = sentRequest();
    expect(url).toBe('https://example.com/webhook');
    expect(init.method).toBe('POST');
    const header = init.headers['x-cognipeer-signature'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    // Verify exactly as a receiver would, from the header and the raw body.
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header)!;
    const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${init.body}`).digest('hex');
    expect(crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'))).toBe(true);
    // ...and the exported signer agrees with it.
    expect(signAgentRunCallback(SECRET, init.body, Number(t))).toBe(header);
    // A different secret does not verify.
    const wrong = crypto.createHmac('sha256', 'another-secret-value').update(`${t}.${init.body}`).digest('hex');
    expect(wrong).not.toBe(v1);
  });

  it('REGRESSION: the event id is stable across retried attempts; runId has the public run_ prefix; no tenant/project ids leak', async () => {
    const run = await makeRun('https://example.com/webhook', SECRET);
    hoisted.safeFetch
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(deliverAgentRunCallbackJob(payloadFor(run))).rejects.toThrow();
    await deliverAgentRunCallbackJob(payloadFor(run));

    const first = sentRequest(0);
    const second = sentRequest(1);
    const expectedEventId = `evt_${String(run._id)}_succeeded`;
    expect(first.body.id).toBe(expectedEventId);
    expect(second.body.id).toBe(expectedEventId);
    expect(first.init.headers['x-cognipeer-event-id']).toBe(expectedEventId);
    expect(second.init.headers['x-cognipeer-event-id']).toBe(expectedEventId);
    expect(first.init.headers['x-cognipeer-event']).toBe('agent_run.succeeded');
    expect(first.body.event).toBe('agent_run.succeeded');

    expect(second.body.runId).toBe(`run_${String(run._id)}`);
    expect(second.body.conversationId).toBe('conv-1');
    expect(second.body).not.toHaveProperty('tenantId');
    expect(second.body).not.toHaveProperty('projectId');
    expect(second.init.body).not.toContain(tenantId);
    expect(second.init.body).not.toContain(SECRET);

    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackAttempts).toBe(2);
    expect(after?.callbackStatus).toBe('delivered');
  });

  it('a run with no secret is delivered unsigned (no x-cognipeer-signature header)', async () => {
    const run = await makeRun('https://example.com/webhook');
    await deliverAgentRunCallbackJob(payloadFor(run));

    const { init } = sentRequest();
    expect(init.headers).not.toHaveProperty('x-cognipeer-signature');
    expect(init.headers['x-cognipeer-event-id']).toBe(`evt_${String(run._id)}_succeeded`);
    expect(init.headers['content-type']).toBe('application/json');
  });
});
