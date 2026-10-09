/**
 * Agent-run quota on BACKGROUND runs: counted once, at submit (so the caller
 * gets the 429 instead of a run that fails later); a replay of an accepted
 * request is never newly refused; the worker adds the finished run's tokens
 * without counting the run again.
 *
 * Real SQLite provider and the real quota guard; only the agent turn is faked
 * (same harness as agent-run-background-execution.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.QUOTA_POLICY_CACHE_TTL_SECONDS = '0';

const hoisted = vi.hoisted(() => ({
  executeAgentChatLocal: vi.fn(),
  getDatabase: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: vi.fn(),
  executeAgentChatLocal: hoisted.executeAgentChatLocal,
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, getDatabase: hoisted.getDatabase };
});

import { getDatabase } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { AgentQuotaExceededError } from '@/lib/services/agents/agentQuota';
import { createBackgroundAgentRun, runAgentJobLocal } from '@/lib/services/agents/agentRunService';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const dbName = 'tenant_agent_quota';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-agent';

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-run-quota-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-quota', dbName, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(dbName);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Support', config: { modelKey: 'gpt-4o' }, status: 'active', createdBy: 'user-1',
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  reloadConfig();
});

afterEach(async () => {
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

const conversation = async (n: number) =>
  String((await db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: `c${n}`, messages: [], createdBy: 'user-1',
  } as never))._id);

async function submit(conversationId: string, extra: Record<string, unknown> = {}) {
  return createBackgroundAgentRun({
    tenantId, tenantDbName: dbName, projectId: PROJECT_ID, agentKey: AGENT_KEY,
    conversationId, userMessage: 'hi', userId: 'alice', usePublished: false, ...extra,
  });
}

const agentLimit = (limits: object, over: Record<string, unknown> = {}) =>
  db.createQuotaPolicy({
    tenantId, scope: 'tenant', domain: 'agent', priority: 10, enabled: true, label: 'agent runs', limits, ...over,
  } as never);

describe('background agent runs and the agent-run quota', () => {
  it('accepts every submit while the tenant has no agent limit', async () => {
    // A legacy-style global limit must not start refusing agent runs.
    await db.createQuotaPolicy({
      tenantId, projectId: PROJECT_ID, scope: 'tenant', domain: 'global', priority: 100, enabled: true,
      label: 'project quota', limits: { rateLimit: { requests: { perMinute: 1 } } },
    } as never);
    for (let i = 0; i < 3; i += 1) {
      expect((await submit(await conversation(i))).kind).toBe('created');
    }
  });

  it('refuses a submit over the limit with the quota error, creating no run', async () => {
    await agentLimit({ rateLimit: { requests: { perDay: 1 } } });

    expect((await submit(await conversation(1))).kind).toBe('created');
    const second = await conversation(2);
    const error = await submit(second).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(AgentQuotaExceededError);
    expect(classifyAgentRunError(error).status).toBe(429);
    expect(await db.listAgentRuns({ tenantId, projectId: PROJECT_ID })).toHaveLength(1);
    expect(hoisted.publish).toHaveBeenCalledTimes(1);
  });

  it('never refuses the replay of a request it already accepted', async () => {
    await agentLimit({ rateLimit: { requests: { perDay: 1 } } });
    const conversationId = await conversation(1);

    const first = await submit(conversationId, { idempotencyKey: 'k-1', idempotencyConversationScope: conversationId });
    expect(first.kind).toBe('created');

    const replay = await submit(conversationId, { idempotencyKey: 'k-1', idempotencyConversationScope: conversationId });
    expect(replay.kind).toBe('idempotent_replay');
  });

  it('adds the finished run\'s tokens (once) so the next submit sees them', async () => {
    await agentLimit({ rateLimit: { tokens: { perDay: 400 } } });
    const created = await submit(await conversation(1));
    if (created.kind !== 'created') throw new Error('expected a created run');

    hoisted.executeAgentChatLocal.mockResolvedValue({
      id: 'resp_x', object: 'response', model: AGENT_KEY, output: [], status: 'completed',
      usage: { input_tokens: 300, output_tokens: 200, total_tokens: 500 },
      created_at: 0, previous_response_id: null, version: null,
    });
    await runAgentJobLocal({ runId: String(created.run._id), tenantId, tenantDbName: dbName } as never);
    // The worker itself did not count a request: only the one counted at submit exists.
    expect(hoisted.executeAgentChatLocal).toHaveBeenCalledTimes(1);

    await vi.waitFor(async () => {
      const error = await submit(await conversation(2)).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(AgentQuotaExceededError);
      expect((error as Error).message).toMatch(/tokens perDay \(500\/400\)/);
    });
  });
});
