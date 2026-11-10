import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wait: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => undefined),
}));

vi.mock('@/lib/limits', async () => {
  const errors = await vi.importActual<typeof import('@/lib/limits/errors')>('@/lib/limits/errors');
  return {
    PlanLimitError: errors.PlanLimitError,
    waitForPlanLease: (...args: unknown[]) => h.wait(...args),
    acquirePlanLease: (...args: unknown[]) => h.acquire(...args),
  };
});
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn() }));

import {
  acquireAgentSessionSlot,
  actorChannelOrigin,
  agentRunOrigin,
  countsAsAgentSession,
  tryAcquireAgentSessionSlot,
} from '@/lib/services/agents/agentSessionLease';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { isPlanLimitError } from '@/lib/limits/errors';

const lease = () => ({ tenantId: 't1', pool: 'agent', holderId: 'h', release: h.release });
const allowed = { allowed: true, outcome: 'allowed', kind: 'concurrency', dimension: 'agent', limit: 2, used: 1 };
const refused = { allowed: false, outcome: 'refused', kind: 'concurrency', dimension: 'agent', limit: 3, used: 3, retryAfterMs: 5000 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent session origin', () => {
  it('maps the run channel to an origin; API surfaces are not counted', () => {
    expect(agentRunOrigin({ channel: 'runs' })).toBe('api');
    expect(agentRunOrigin({ channel: 'responses' })).toBe('api');
    expect(agentRunOrigin({ channel: 'chat_completions' })).toBe('api');
    expect(agentRunOrigin({ channel: 'a2a' })).toBe('api');
    expect(agentRunOrigin({ channel: 'trigger' })).toBe('schedule');
    expect(agentRunOrigin({ channel: 'reminder' })).toBe('schedule');
    expect(agentRunOrigin({ channel: 'messaging' })).toBe('channel');
    expect(countsAsAgentSession('api')).toBe(false);
    expect(countsAsAgentSession('schedule')).toBe(true);
  });

  it('treats an unknown origin as console (counted)', () => {
    expect(agentRunOrigin({ channel: null })).toBe('console');
    expect(agentRunOrigin({})).toBe('console');
    expect(agentRunOrigin({ channel: 'something-new' as never })).toBe('console');
    expect(actorChannelOrigin(undefined)).toBe('console');
    expect(actorChannelOrigin('dashboard')).toBe('console');
    expect(actorChannelOrigin('portal')).toBe('portal');
    expect(actorChannelOrigin('api')).toBe('api');
  });
});

describe('acquireAgentSessionSlot', () => {
  it('does not touch the limits for an API-origin run', async () => {
    const slot = await acquireAgentSessionSlot({ tenantId: 't1', origin: 'api' });
    await slot.release();
    expect(h.wait).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it('takes a slot for a console turn and releases it once, with no queued event when a slot was free', async () => {
    h.wait.mockResolvedValue({ decision: allowed, lease: lease() });
    const onQueued = vi.fn();
    const onStarted = vi.fn();
    const slot = await acquireAgentSessionSlot({ tenantId: 't1', holderId: 'run-1', origin: 'console', onQueued, onStarted });
    expect(h.wait).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', pool: 'agent', holderId: 'run-1', maxWaitMs: 15_000 }));
    expect(onQueued).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    await slot.release();
    await slot.release();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('emits queued once and started once when the turn waited', async () => {
    h.wait.mockImplementation(async (input: { onQueued: (info: unknown) => void }) => {
      input.onQueued({ limit: 2, active: 2, retryInMs: 500 });
      return { decision: allowed, lease: lease() };
    });
    const onQueued = vi.fn();
    const onStarted = vi.fn();
    const slot = await acquireAgentSessionSlot({ tenantId: 't1', origin: 'portal', onQueued, onStarted });
    expect(onQueued).toHaveBeenCalledTimes(1);
    expect(onQueued).toHaveBeenCalledWith({ limit: 2, active: 2, retryInMs: 500 });
    expect(onStarted).toHaveBeenCalledTimes(1);
    await slot.release();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("refuses with tenant_concurrency_limited after the wait (mode 'on')", async () => {
    h.wait.mockImplementation(async (input: { onQueued: (info: unknown) => void }) => {
      input.onQueued({ limit: 3, active: 3, retryInMs: 500 });
      return { decision: refused, lease: null };
    });
    const onStarted = vi.fn();
    const failure = await acquireAgentSessionSlot({ tenantId: 't1', origin: 'console', onStarted }).catch((e) => e);
    expect(isPlanLimitError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'tenant_concurrency_limited',
      status: 429,
      message: 'All 3 agent sessions are in use. Try again shortly.',
    });
    expect(onStarted).not.toHaveBeenCalled();
    // The turn error path shows it with its code.
    expect(classifyAgentRunError(failure)).toMatchObject({
      status: 429,
      error: { code: 'tenant_concurrency_limited', type: 'rate_limit_error' },
    });
  });

  it('never refuses in shadow mode (the decision stays allowed)', async () => {
    h.wait.mockResolvedValue({ decision: { ...allowed, outcome: 'would_refuse' }, lease: lease() });
    const slot = await acquireAgentSessionSlot({ tenantId: 't1', origin: 'channel' });
    await slot.release();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('is a no-op slot when limits are off (no lease handed back)', async () => {
    h.wait.mockResolvedValue({ decision: allowed, lease: null });
    const slot = await acquireAgentSessionSlot({ tenantId: 't1', origin: 'console' });
    await expect(slot.release()).resolves.toBeUndefined();
    expect(h.release).not.toHaveBeenCalled();
  });
});

describe('tryAcquireAgentSessionSlot (background runs)', () => {
  it('does not count an API-origin run', async () => {
    const result = await tryAcquireAgentSessionSlot({ tenantId: 't1', holderId: 'r1', origin: 'api' });
    expect(result.refused).toBe(false);
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it('reports a full pool as refused (the caller leaves the run queued) and holds nothing', async () => {
    h.acquire.mockResolvedValue({ decision: refused, lease: null });
    const result = await tryAcquireAgentSessionSlot({ tenantId: 't1', holderId: 'r1', origin: 'schedule' });
    expect(result.refused).toBe(true);
    await result.slot.release();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('hands back a slot that releases the lease', async () => {
    h.acquire.mockResolvedValue({ decision: allowed, lease: lease() });
    const result = await tryAcquireAgentSessionSlot({ tenantId: 't1', holderId: 'r1', origin: 'channel' });
    expect(result.refused).toBe(false);
    expect(h.acquire).toHaveBeenCalledWith(expect.objectContaining({ pool: 'agent', holderId: 'r1', source: { type: 'channel', id: 'r1' } }));
    await result.slot.release();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
