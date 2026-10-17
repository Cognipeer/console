/**
 * Pure policy helpers of `agentRunService.ts`:
 *  - `resolveAgentRunLimits`: effective = min(env ceiling, tenant quota),
 *    where 0/unset means "no tighter bound" (agents have no say any more);
 *  - `validateCallbackRequest`: submit-time 400 for a callback that could
 *    never be delivered (or would reach an internal address);
 *  - the id / serialization helpers the client API and dashboard share.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  resolveEffectiveLimits: vi.fn(),
  assertPublicUrl: vi.fn(),
}));

vi.mock('@/lib/quota/quotaGuard', () => ({
  resolveEffectiveLimits: hoisted.resolveEffectiveLimits,
}));

vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: hoisted.assertPublicUrl,
  safeFetch: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: vi.fn(),
  executeAgentChatLocal: vi.fn(),
}));

import { getConfig, reloadConfig } from '@/lib/core/config';
import type { IAgentConfig, IAgentRun } from '@/lib/database';
import { encryptObject } from '@/lib/utils/crypto';
import {
  agentDefaultCallback,
  agentRunJobDedupKey,
  isAbandonedSyncReservation,
  isAsyncAgentRun,
  isBackgroundModeRequested,
  normalizeAgentRunId,
  resolveAgentRunLimits,
  serializeAgentRun,
  validateCallbackRequest,
} from '@/lib/services/agents/agentRunService';

const QUOTA_CONTEXT = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  licenseType: 'ENTERPRISE' as const,
};

function agent(callback: IAgentConfig['callback']): IAgentConfig {
  return { modelKey: 'gpt-4o', callback };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_SYNC_TIMEOUT_MS = '120000'; // 120s
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '1800000'; // 30min
  process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '10';
  process.env.AGENT_RUN_MAX_ACTIVE_PER_PROJECT = '0';
  reloadConfig();
  hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: {} });
  hoisted.assertPublicUrl.mockImplementation(async (url: string) => new URL(url));
});

afterEach(() => {
  delete process.env.AGENT_SYNC_TIMEOUT_MS;
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT;
  delete process.env.AGENT_RUN_MAX_ACTIVE_PER_PROJECT;
  reloadConfig();
});

describe('resolveAgentRunLimits — min(env, tenant quota)', () => {
  it('with no quota, the env values apply', async () => {
    expect(await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT })).toEqual({
      syncWaitMs: 120_000,
      maxDurationMs: 1_800_000,
      maxActivePerTenant: 10,
      maxActivePerProject: 0,
    });
  });

  it('takes the tightest of env and tenant quota for each knob', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 60, maxAgentBackgroundDurationMinutes: 10, maxConcurrentAgentRuns: 3 },
    });
    expect(await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT })).toEqual({
      syncWaitMs: 60_000,
      maxDurationMs: 600_000,
      maxActivePerTenant: 3,
      maxActivePerProject: 0,
    });
  });

  it('nothing can RAISE the env ceiling — a quota above it is ignored', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 10_000, maxAgentBackgroundDurationMinutes: 10_000, maxConcurrentAgentRuns: 500 },
    });
    const limits = await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT });
    expect(limits.syncWaitMs).toBe(120_000);
    expect(limits.maxDurationMs).toBe(1_800_000);
    expect(limits.maxActivePerTenant).toBe(10);
  });

  it('0 or unset in the quota means "no tighter bound", never "zero"', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 0, maxAgentBackgroundDurationMinutes: 0, maxConcurrentAgentRuns: 0 },
    });
    const limits = await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT });
    expect(limits.syncWaitMs).toBe(120_000);
    expect(limits.maxDurationMs).toBe(1_800_000);
    expect(limits.maxActivePerTenant).toBe(10);
  });

  it('an env tenant cap of 0 (uncapped) still honours a quota cap; both 0 = no cap', async () => {
    process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT = '0';
    reloadConfig();
    hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: { maxConcurrentAgentRuns: 4 } });
    expect((await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT })).maxActivePerTenant).toBe(4);
    hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: {} });
    expect((await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT })).maxActivePerTenant).toBe(0);
  });

  it('the per-project cap comes from env; the tenant default is 250', async () => {
    process.env.AGENT_RUN_MAX_ACTIVE_PER_PROJECT = '2';
    delete process.env.AGENT_RUN_MAX_ACTIVE_PER_TENANT;
    reloadConfig();
    const limits = await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT });
    expect(limits.maxActivePerProject).toBe(2);
    expect(limits.maxActivePerTenant).toBe(250);
  });

  it('asks the quota layer for the global domain of the caller', async () => {
    await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT });
    expect(hoisted.resolveEffectiveLimits).toHaveBeenCalledWith({ ...QUOTA_CONTEXT, domain: 'global' });
  });

  it('a quota lookup failure falls back to the env ceilings instead of failing the request', async () => {
    hoisted.resolveEffectiveLimits.mockRejectedValue(new Error('quota store down'));
    expect((await resolveAgentRunLimits({ quotaContext: QUOTA_CONTEXT })).syncWaitMs).toBe(120_000);
  });

  it('without a quota context, no quota lookup is made', async () => {
    await resolveAgentRunLimits({});
    expect(hoisted.resolveEffectiveLimits).not.toHaveBeenCalled();
  });
});

describe('isBackgroundModeRequested — header > body, default synchronous', () => {
  it('header wins over the body; saying neither is synchronous', () => {
    expect(isBackgroundModeRequested(undefined, {})).toBe(false);
    expect(isBackgroundModeRequested(undefined, { background: true })).toBe(true);
    expect(isBackgroundModeRequested('false', { background: true })).toBe(false);
    expect(isBackgroundModeRequested('TRUE', { background: false })).toBe(true);
    expect(isBackgroundModeRequested('maybe', { background: false })).toBe(false);
  });
});

describe('validateCallbackRequest — submit-time 400 instead of a silently failing 202', () => {
  const SECRET = 'a'.repeat(16);

  it('no callback at all is fine', async () => {
    expect(await validateCallbackRequest(undefined, undefined)).toEqual({ ok: true });
    expect(await validateCallbackRequest('', null)).toEqual({ ok: true });
  });

  it('accepts a public https or http URL, with or without a valid secret', async () => {
    expect(await validateCallbackRequest('https://hooks.example.com/run', undefined))
      .toEqual({ ok: true, url: 'https://hooks.example.com/run' });
    expect(await validateCallbackRequest('http://hooks.example.com/run', SECRET))
      .toEqual({ ok: true, url: 'http://hooks.example.com/run', secret: SECRET });
    expect(hoisted.assertPublicUrl).toHaveBeenCalledWith('https://hooks.example.com/run');
  });

  it('rejects non-http(s) schemes', async () => {
    for (const url of ['ftp://hooks.example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x']) {
      const result = await validateCallbackRequest(url, undefined);
      expect(result.ok, url).toBe(false);
    }
    expect(hoisted.assertPublicUrl).not.toHaveBeenCalled();
  });

  it('rejects a malformed or over-long URL, or a non-string', async () => {
    expect((await validateCallbackRequest('not a url', undefined)).ok).toBe(false);
    expect((await validateCallbackRequest(`https://example.com/${'x'.repeat(2100)}`, undefined)).ok).toBe(false);
    expect((await validateCallbackRequest(42, undefined)).ok).toBe(false);
  });

  it('rejects a host that resolves to a private/internal address', async () => {
    hoisted.assertPublicUrl.mockRejectedValue(new Error('private address'));
    const result = await validateCallbackRequest('https://metadata.internal/latest', undefined);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/public address/) });
  });

  it('rejects a secret shorter than 16 or longer than 256 characters, or not a string', async () => {
    expect((await validateCallbackRequest('https://hooks.example.com/run', 'short')).ok).toBe(false);
    expect((await validateCallbackRequest('https://hooks.example.com/run', 'a'.repeat(15))).ok).toBe(false);
    expect((await validateCallbackRequest('https://hooks.example.com/run', 'a'.repeat(257))).ok).toBe(false);
    expect((await validateCallbackRequest('https://hooks.example.com/run', 12345678901234567)).ok).toBe(false);
    expect((await validateCallbackRequest('https://hooks.example.com/run', 'a'.repeat(256))).ok).toBe(true);
  });

  it('rejects a secret without a URL', async () => {
    const result = await validateCallbackRequest(undefined, SECRET);
    expect(result).toEqual({ ok: false, message: 'callback_secret requires callback_url' });
  });
});

describe('agentDefaultCallback', () => {
  it('opens the agent\'s sealed secret; no URL means no default callback', () => {
    expect(agentDefaultCallback(agent(undefined))).toEqual({});
    expect(agentDefaultCallback(agent({ secretSealed: encryptObject('x'.repeat(20)) }))).toEqual({});
    expect(agentDefaultCallback(agent({
      url: 'https://hooks.example.com/agent',
      secretSealed: encryptObject('agent-level-secret-1'),
    }))).toEqual({ url: 'https://hooks.example.com/agent', secret: 'agent-level-secret-1' });
  });
});

describe('notifications rule and job keys', () => {
  it('only async runs notify: queued ones, and inline ones whose caller stopped waiting', () => {
    expect(isAsyncAgentRun({ mode: 'background' })).toBe(true);
    expect(isAsyncAgentRun({ mode: 'inline', detachedAt: null })).toBe(false);
    expect(isAsyncAgentRun({ mode: 'inline', detachedAt: new Date() })).toBe(true);
    expect(isAsyncAgentRun({ mode: 'sync' })).toBe(false);
  });

  it('the job dedup key is per run and queue generation, with no ":"', () => {
    expect(agentRunJobDedupKey({ _id: 'r1', queueGeneration: 3 })).toBe('ar_r1_3');
    expect(agentRunJobDedupKey({ _id: 'r1' })).toBe('ar_r1_1');
  });
});

describe('ids and serialization', () => {
  it('normalizeAgentRunId strips run_ and resp_, leaves a raw id alone', () => {
    expect(normalizeAgentRunId('run_abc123')).toBe('abc123');
    expect(normalizeAgentRunId('resp_abc123')).toBe('abc123');
    expect(normalizeAgentRunId('abc123')).toBe('abc123');
  });

  it('serializeAgentRun is the single §8 shape and never exposes the secret or runtime headers', () => {
    const run = {
      _id: 'r1',
      mode: 'background',
      tenantId: 'tenant-1',
      tenantDbName: 'tenant_acme',
      projectId: 'proj-1',
      agentKey: 'support-agent',
      conversationId: 'conv-1',
      userMessage: 'hello',
      status: 'failed',
      errorReason: 'max_duration_exceeded',
      errorMessage: 'too long',
      result: { id: 'resp_r1' },
      runtimeContext: { sealed: 'ciphertext' },
      callbackUrl: 'https://hooks.example.com/run',
      callbackSecret: 'sealed-secret-blob',
      callbackStatus: 'delivered',
      callbackAttempts: 2,
      maxDurationMs: 60_000,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      startedAt: new Date('2024-01-01T00:00:10Z'),
      completedAt: new Date('2024-01-01T00:01:10Z'),
    } as unknown as IAgentRun;

    const body = serializeAgentRun(run);
    expect(body).toEqual({
      id: 'run_r1',
      object: 'agent.run',
      status: 'failed',
      class: 'default',
      agent: 'support-agent',
      version: null,
      session_id: 'conv-1',
      conversation_id: 'conv-1',
      channel: null,
      trigger: null,
      routine_id: null,
      metadata: {},
      stop_reason: null,
      result: null,
      output_text: null,
      output_parsed: null,
      output_error: null,
      error: { type: 'max_duration_exceeded', message: 'too long' },
      scheduled_for: null,
      created_at: 1704067200,
      started_at: 1704067210,
      completed_at: 1704067270,
      detached_at: null,
      cancel_requested_at: null,
      max_duration_ms: 60_000,
      callback: { url: 'https://hooks.example.com/run', status: 'delivered', attempts: 2, signed: true },
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain('sealed-secret-blob');
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('tenant-1');
  });

  it('serializeAgentRun lifts output_text / output_parsed and carries the engine fields', () => {
    const run = {
      _id: 'r2', mode: 'inline', agentKey: 'a', conversationId: 'c', status: 'succeeded', runClass: 'deferred',
      version: 3, channel: 'routine', trigger: 'schedule', routineId: 'rt1', metadata: { team: 'ops' },
      notBefore: new Date('2024-01-01T00:00:00Z'), detachedAt: new Date('2024-01-01T00:00:05Z'),
      result: {
        id: 'resp_r2',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hel' }, { type: 'output_text', text: 'lo' }] }],
        output_parsed: { ok: true },
      },
    } as unknown as IAgentRun;
    expect(serializeAgentRun(run)).toMatchObject({
      class: 'deferred', version: 3, channel: 'routine', trigger: 'schedule', routine_id: 'rt1', metadata: { team: 'ops' },
      output_text: 'Hello', output_parsed: { ok: true }, scheduled_for: 1704067200, detached_at: 1704067205,
    });
    expect(serializeAgentRun({ ...run, status: 'scheduled', result: null } as IAgentRun)).toMatchObject({
      status: 'scheduled', output_text: null, scheduled_for: 1704067200,
    });
  });

  it('isAbandonedSyncReservation: only sync rows past the env ceiling + grace', () => {
    const now = Date.now();
    const sync = (ageMs: number) => ({ mode: 'sync', startedAt: new Date(now - ageMs) }) as unknown as IAgentRun;
    expect(isAbandonedSyncReservation(sync(60_000), now)).toBe(false); // inside 120s ceiling
    expect(isAbandonedSyncReservation(sync(150_000), now)).toBe(false); // inside ceiling + 60s grace
    expect(isAbandonedSyncReservation(sync(200_000), now)).toBe(true);
    expect(isAbandonedSyncReservation({ mode: 'background', startedAt: new Date(0) } as unknown as IAgentRun, now)).toBe(false);
  });
});

describe('agent run env knobs are clamped to values that cannot wedge the system', () => {
  const KEYS = [
    'AGENT_SYNC_TIMEOUT_MS', 'AGENT_BACKGROUND_MAX_DURATION_MS', 'AGENT_RUN_HEARTBEAT_INTERVAL_MS',
    'AGENT_RUN_HEARTBEAT_STALE_MS', 'AGENT_RUN_CONCURRENCY', 'AGENT_RUN_REQUEUE_AFTER_MS',
    'AGENT_RUN_MAX_ACTIVE_PER_PROJECT',
  ];
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    reloadConfig();
  });

  it('zero / negative values are raised to their floors', () => {
    for (const key of KEYS) process.env[key] = '0';
    process.env.AGENT_RUN_MAX_ACTIVE_PER_PROJECT = '-3';
    reloadConfig();
    const agentCfg = getConfig().agent;
    expect(agentCfg.syncTimeoutMs).toBe(5_000);
    expect(agentCfg.backgroundMaxDurationMs).toBe(10_000);
    expect(agentCfg.runHeartbeatIntervalMs).toBe(1_000);
    // A stale threshold at or below the heartbeat would fail live runs as worker_lost.
    expect(agentCfg.runHeartbeatStaleMs).toBeGreaterThanOrEqual(3 * agentCfg.runHeartbeatIntervalMs);
    expect(agentCfg.runConcurrency).toBe(1);
    expect(agentCfg.runRequeueAfterMs).toBe(10_000);
    expect(agentCfg.runMaxActivePerProject).toBe(0);
  });

  it('the stale threshold follows a raised heartbeat interval', () => {
    process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '20000';
    process.env.AGENT_RUN_HEARTBEAT_STALE_MS = '30000';
    reloadConfig();
    expect(getConfig().agent.runHeartbeatStaleMs).toBe(60_000);
  });
});
