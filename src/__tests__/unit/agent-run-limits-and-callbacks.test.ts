/**
 * Pure policy helpers of `agentRunService.ts` (PR #326 hardening):
 *  - `resolveAgentExecutionLimits`: effective = min(env ceiling, tenant
 *    quota, agent `config.execution`), where 0/unset means "no tighter bound";
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
  isAbandonedSyncReservation,
  isBackgroundModeRequested,
  normalizeAgentRunId,
  resolveAgentExecutionLimits,
  serializeAgentRun,
  validateCallbackRequest,
} from '@/lib/services/agents/agentRunService';

const QUOTA_CONTEXT = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  licenseType: 'ENTERPRISE' as const,
};

function agent(execution: IAgentConfig['execution']): IAgentConfig {
  return { modelKey: 'gpt-4o', execution };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_SYNC_TIMEOUT_MS = '120000'; // 120s
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '1800000'; // 30min
  process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT = '10';
  process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT = '0';
  reloadConfig();
  hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: {} });
  hoisted.assertPublicUrl.mockImplementation(async (url: string) => new URL(url));
});

afterEach(() => {
  delete process.env.AGENT_SYNC_TIMEOUT_MS;
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT;
  delete process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT;
  reloadConfig();
});

describe('resolveAgentExecutionLimits — min(env, quota, agent)', () => {
  it('with no quota and no agent settings, the env values apply', async () => {
    const limits = await resolveAgentExecutionLimits({ agentConfig: agent(undefined), quotaContext: QUOTA_CONTEXT });
    expect(limits).toEqual({
      syncTimeoutMs: 120_000,
      backgroundEnabled: true,
      backgroundMaxDurationMs: 1_800_000,
      defaultMode: 'sync',
      maxConcurrentRunsPerTenant: 10,
      maxConcurrentRunsPerProject: 0,
    });
  });

  it('takes the tightest of env, tenant quota and agent setting for each knob', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 90, maxAgentBackgroundDurationMinutes: 20, maxConcurrentAgentRuns: 4 },
    });

    // Agent tighter than quota for sync, looser for background.
    const a = await resolveAgentExecutionLimits({
      agentConfig: agent({ syncTimeoutSeconds: 30, backgroundMaxDurationMinutes: 25 }),
      quotaContext: QUOTA_CONTEXT,
    });
    expect(a.syncTimeoutMs).toBe(30_000);
    expect(a.backgroundMaxDurationMs).toBe(20 * 60_000);
    expect(a.maxConcurrentRunsPerTenant).toBe(4);

    // Quota tighter for sync, agent tighter for background.
    const b = await resolveAgentExecutionLimits({
      agentConfig: agent({ syncTimeoutSeconds: 100, backgroundMaxDurationMinutes: 5 }),
      quotaContext: QUOTA_CONTEXT,
    });
    expect(b.syncTimeoutMs).toBe(90_000);
    expect(b.backgroundMaxDurationMs).toBe(5 * 60_000);
  });

  it('nothing can RAISE the env ceiling — an agent or quota above it is ignored', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 3600, maxAgentBackgroundDurationMinutes: 600, maxConcurrentAgentRuns: 500 },
    });
    const limits = await resolveAgentExecutionLimits({
      agentConfig: agent({ syncTimeoutSeconds: 7200, backgroundMaxDurationMinutes: 999 }),
      quotaContext: QUOTA_CONTEXT,
    });
    expect(limits.syncTimeoutMs).toBe(120_000);
    expect(limits.backgroundMaxDurationMs).toBe(1_800_000);
    expect(limits.maxConcurrentRunsPerTenant).toBe(10);
  });

  it('0 or unset in the quota/agent means "no tighter bound", never "zero"', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({
      quotas: { maxAgentSyncTimeoutSeconds: 0, maxAgentBackgroundDurationMinutes: 0, maxConcurrentAgentRuns: 0 },
    });
    const limits = await resolveAgentExecutionLimits({
      agentConfig: agent({ syncTimeoutSeconds: 0, backgroundMaxDurationMinutes: undefined }),
      quotaContext: QUOTA_CONTEXT,
    });
    expect(limits.syncTimeoutMs).toBe(120_000);
    expect(limits.backgroundMaxDurationMs).toBe(1_800_000);
    expect(limits.maxConcurrentRunsPerTenant).toBe(10);
  });

  it('an env tenant cap of 0 (uncapped) still honours a quota cap; both 0 = no cap', async () => {
    process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_TENANT = '0';
    reloadConfig();

    hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: { maxConcurrentAgentRuns: 3 } });
    expect((await resolveAgentExecutionLimits({ quotaContext: QUOTA_CONTEXT })).maxConcurrentRunsPerTenant).toBe(3);

    hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: {} });
    expect((await resolveAgentExecutionLimits({ quotaContext: QUOTA_CONTEXT })).maxConcurrentRunsPerTenant).toBe(0);
  });

  it('the per-project cap comes from env', async () => {
    process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT = '2';
    reloadConfig();
    expect((await resolveAgentExecutionLimits({})).maxConcurrentRunsPerProject).toBe(2);
  });

  it('asks the quota layer for the global domain of the caller', async () => {
    await resolveAgentExecutionLimits({ quotaContext: QUOTA_CONTEXT });
    expect(hoisted.resolveEffectiveLimits).toHaveBeenCalledWith({ ...QUOTA_CONTEXT, domain: 'global' });
  });

  it('a quota lookup failure falls back to the env ceilings instead of failing the request', async () => {
    hoisted.resolveEffectiveLimits.mockRejectedValue(new Error('db down'));
    const limits = await resolveAgentExecutionLimits({
      agentConfig: agent({ syncTimeoutSeconds: 45 }),
      quotaContext: QUOTA_CONTEXT,
    });
    expect(limits.syncTimeoutMs).toBe(45_000);
    expect(limits.backgroundMaxDurationMs).toBe(1_800_000);
  });

  it('without a quota context, no quota lookup is made', async () => {
    await resolveAgentExecutionLimits({ agentConfig: agent(undefined) });
    expect(hoisted.resolveEffectiveLimits).not.toHaveBeenCalled();
  });

  it('backgroundEnabled defaults to true; false disables it and forces defaultMode back to sync', async () => {
    expect((await resolveAgentExecutionLimits({ agentConfig: agent({}) })).backgroundEnabled).toBe(true);

    const disabled = await resolveAgentExecutionLimits({ agentConfig: agent({ backgroundEnabled: false, defaultMode: 'background' }) });
    expect(disabled.backgroundEnabled).toBe(false);
    expect(disabled.defaultMode).toBe('sync');

    const bg = await resolveAgentExecutionLimits({ agentConfig: agent({ defaultMode: 'background' }) });
    expect(bg.defaultMode).toBe('background');
  });
});

describe('isBackgroundModeRequested — header > body > agent default', () => {
  it('uses the agent default only when the call says neither', () => {
    expect(isBackgroundModeRequested(undefined, {}, 'background')).toBe(true);
    expect(isBackgroundModeRequested(undefined, {}, 'sync')).toBe(false);
    expect(isBackgroundModeRequested(undefined, { background: false }, 'background')).toBe(false);
    expect(isBackgroundModeRequested('false', { background: true }, 'background')).toBe(false);
    expect(isBackgroundModeRequested('TRUE', {}, 'sync')).toBe(true);
    expect(isBackgroundModeRequested(undefined, { background: true })).toBe(true);
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
    expect(agentDefaultCallback(agent({ callbackSecretSealed: encryptObject('x'.repeat(20)) }))).toEqual({});
    expect(agentDefaultCallback(agent({
      callbackUrl: 'https://hooks.example.com/agent',
      callbackSecretSealed: encryptObject('agent-level-secret-1'),
    }))).toEqual({ url: 'https://hooks.example.com/agent', secret: 'agent-level-secret-1' });
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
      agent: 'support-agent',
      conversation_id: 'conv-1',
      result: null,
      error: { type: 'max_duration_exceeded', message: 'too long' },
      created_at: 1704067200,
      started_at: 1704067210,
      completed_at: 1704067270,
      cancel_requested_at: null,
      max_duration_ms: 60_000,
      callback: { url: 'https://hooks.example.com/run', status: 'delivered', attempts: 2, signed: true },
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain('sealed-secret-blob');
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain('tenant-1');
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
    'AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT',
  ];
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    reloadConfig();
  });

  it('zero / negative values are raised to their floors', () => {
    for (const key of KEYS) process.env[key] = '0';
    process.env.AGENT_BACKGROUND_MAX_CONCURRENT_RUNS_PER_PROJECT = '-3';
    reloadConfig();
    const agentCfg = getConfig().agent;
    expect(agentCfg.syncTimeoutMs).toBe(5_000);
    expect(agentCfg.backgroundMaxDurationMs).toBe(10_000);
    expect(agentCfg.runHeartbeatIntervalMs).toBe(1_000);
    // A stale threshold at or below the heartbeat would fail live runs as worker_lost.
    expect(agentCfg.runHeartbeatStaleMs).toBeGreaterThanOrEqual(3 * agentCfg.runHeartbeatIntervalMs);
    expect(agentCfg.runConcurrency).toBe(1);
    expect(agentCfg.runRequeueAfterMs).toBe(10_000);
    expect(agentCfg.backgroundMaxConcurrentRunsPerProject).toBe(0);
  });

  it('the stale threshold follows a raised heartbeat interval', () => {
    process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '20000';
    process.env.AGENT_RUN_HEARTBEAT_STALE_MS = '30000';
    reloadConfig();
    expect(getConfig().agent.runHeartbeatStaleMs).toBe(60_000);
  });
});
