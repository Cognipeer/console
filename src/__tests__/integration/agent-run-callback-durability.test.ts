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
  post: vi.fn(),
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

vi.mock('axios', () => ({
  default: { post: hoisted.post },
}));

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import {
  fireAgentRunCallback,
  deliverAgentRunCallbackJob,
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
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function makeRun(callbackUrl: string | null) {
  return db.createAgentRun({
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
    expect(hoisted.post).not.toHaveBeenCalled();
  });
});

describe('deliverAgentRunCallbackJob (delivery + durability)', () => {
  it('on success, persists callbackStatus=delivered and increments callbackAttempts', async () => {
    hoisted.post.mockResolvedValue({ status: 200 });
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

    expect(hoisted.post).toHaveBeenCalledTimes(1);
    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('delivered');
    expect(after?.callbackAttempts).toBe(1);
  });

  it('on failure, persists callbackStatus=failed with an incremented attempt count and THROWS (so the queue retries)', async () => {
    hoisted.post.mockRejectedValue(new Error('ECONNREFUSED'));
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
    hoisted.post.mockRejectedValue(new Error('ECONNREFUSED'));
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

  it('refuses delivery to a private/loopback callback URL (SSRF hardening) and marks it failed without an HTTP call', async () => {
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

    expect(hoisted.post).not.toHaveBeenCalled();
    const after = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
    expect(after?.callbackStatus).toBe('failed');
  });
});
