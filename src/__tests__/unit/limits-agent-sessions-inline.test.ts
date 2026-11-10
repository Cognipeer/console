/**
 * Plan limit (agent sessions) on the inline branch of `startAgentRun`: a messaging turn takes a slot and gives it
 * back when its turn ends; a client API turn takes none; a full pool refuses the turn and leaves no run behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({
  executeAgentChat: vi.fn(),
  getDatabase: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: vi.fn() })) }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: vi.fn() }));
vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: h.executeAgentChat,
  executeAgentChatLocal: vi.fn(),
}));
vi.mock('@/lib/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/database')>()),
  getDatabase: h.getDatabase,
}));
vi.mock('@/lib/services/agents/agentSessionLease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/agents/agentSessionLease')>()),
  acquireAgentSessionSlot: h.acquire,
}));

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { concurrencyRefusal } from '@/lib/services/planLeases';
import { startAgentRun, type StartAgentRunInput } from '@/lib/services/agents/agentRunService';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_inline_slot';

const turn = (conversationId: string, channel: StartAgentRunInput['channel']) => startAgentRun({
  tenantDbName: dbName,
  tenantId,
  projectId: 'proj-1',
  agentKey: 'agent',
  conversationId,
  userMessage: 'hello',
  userId: 'user-1',
  channel,
  execution: { kind: 'inline', waitMs: 0, stream: {}, cancelOnDisconnect: false },
  limits: { syncWaitMs: 1_000, maxDurationMs: 60_000, maxActivePerTenant: 0, maxActivePerProject: 0 },
});

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-inline-slot-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  h.getDatabase.mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-slot', dbName, licenseType: 'FREE', ownerId: 'o' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  h.acquire.mockImplementation(async (input: { origin: string }) => (
    input.origin === 'api' ? { release: async () => undefined } : { release: h.release }
  ));
  h.executeAgentChat.mockResolvedValue({ id: 'r', object: 'response', output: [], status: 'completed', usage: {} });
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('inline agent turns and the agent session pool', () => {
  it('a messaging turn takes a channel slot for its run and releases it when the turn ends', async () => {
    const outcome = await turn('conv-1', 'messaging');
    expect(outcome.kind).toBe('completed');
    expect(h.acquire).toHaveBeenCalledTimes(1);
    expect(h.acquire.mock.calls[0]![0]).toMatchObject({ tenantId, origin: 'channel' });
    expect(h.acquire.mock.calls[0]![0].holderId).toBe(String((outcome as { run: { _id: unknown } }).run._id));
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('releases the slot when the turn fails too', async () => {
    h.executeAgentChat.mockRejectedValue(new Error('boom'));
    await expect(turn('conv-2', 'messaging')).rejects.toThrow('boom');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('a client API turn is not counted', async () => {
    await turn('conv-3', 'responses');
    expect(h.acquire.mock.calls[0]![0]).toMatchObject({ origin: 'api' });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a full pool refuses the turn with tenant_concurrency_limited and leaves no run behind', async () => {
    h.acquire.mockRejectedValue(concurrencyRefusal('agent', { limit: 1, used: 1, retryAfterMs: 5_000 }, 'agent sessions'));
    const refused = await turn('conv-4', 'messaging').catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'tenant_concurrency_limited' });
    expect(h.executeAgentChat).not.toHaveBeenCalled();
    expect(await db.countActiveAgentRuns(tenantId)).toBe(0);
  });
});
