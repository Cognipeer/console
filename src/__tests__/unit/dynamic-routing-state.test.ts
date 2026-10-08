/**
 * Unit tests — Dynamic LLM routing state: spend / conversation counters,
 * sticky model + conversation ratio, and segment ratio learning, against the
 * in-process memory cache provider.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/database', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/database')>();
  return { ...original, getDatabase: vi.fn().mockRejectedValue(new Error('no db in unit tests')) };
});

import {
  MIN_SEGMENT_SAMPLES,
  __resetDynamicRoutingStateForTests,
  getConversationCostUsd,
  getConversationState,
  getModelProfiles,
  getRouterSpendUsd,
  getSegmentIoRatio,
  recordRoutedUsage,
} from '@/lib/services/models/dynamicRoutingState';
import type { IModelUsageRouting } from '@/lib/database';

const routing = (extra: Partial<IModelUsageRouting> = {}): IModelUsageRouting => ({
  role: 'child',
  routerKey: `router-${Math.random().toString(36).slice(2)}`,
  strategy: 'rule-based',
  decision: 'rule',
  chosenModelKey: 'small',
  reason: 'x',
  conversationId: 'conv-1',
  segment: 'default|t0|f0|s1',
  ...extra,
});

describe('dynamicRoutingState', () => {
  beforeEach(() => __resetDynamicRoutingStateForTests());

  it('accumulates conversation and router spend (child + decider)', async () => {
    const r = routing();
    await recordRoutedUsage({ tenantDbName: 't', routing: r, modelKey: 'small', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.25, status: 'success' });
    await recordRoutedUsage({ tenantDbName: 't', routing: { ...r, role: 'decider' }, modelKey: 'dec', usage: {}, costUsd: 0.05, status: 'success' });

    expect(await getConversationCostUsd('t', r.routerKey, 'conv-1')).toBeCloseTo(0.3);
    expect(await getRouterSpendUsd('t', r.routerKey, 24)).toBeCloseTo(0.3);
    expect(await getRouterSpendUsd('other-tenant', r.routerKey, 24)).toBe(0);
  });

  it('remembers the sticky model and the conversation ratio from child rows only', async () => {
    const r = routing();
    await recordRoutedUsage({ tenantDbName: 't', routing: r, modelKey: 'small', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.01, status: 'success' });
    await recordRoutedUsage({ tenantDbName: 't', routing: { ...r, role: 'decider' }, modelKey: 'dec', usage: { inputTokens: 10, outputTokens: 1 }, costUsd: 0.01, status: 'success' });

    const state = await getConversationState('t', r.routerKey, 'conv-1');
    expect(state.lastModelKey).toBe('small');
    expect(state.ioRatio).toBeCloseTo(0.5);
  });

  it('learns a segment ratio once it has enough samples', async () => {
    const r = routing();
    for (let i = 0; i < MIN_SEGMENT_SAMPLES - 1; i += 1) {
      await recordRoutedUsage({ tenantDbName: 't', routing: r, modelKey: 'small', usage: { inputTokens: 100, outputTokens: 200 }, costUsd: 0, status: 'success' });
    }
    expect(getSegmentIoRatio('t', r.routerKey, r.segment!)).toBeUndefined();
    await recordRoutedUsage({ tenantDbName: 't', routing: r, modelKey: 'small', usage: { inputTokens: 100, outputTokens: 200 }, costUsd: 0, status: 'success' });
    expect(getSegmentIoRatio('t', r.routerKey, r.segment!)?.ratio).toBeCloseTo(2);
    // An unseen segment falls back to the router-wide ratio.
    expect(getSegmentIoRatio('t', r.routerKey, 'other')?.ratio).toBeCloseTo(2);
  });

  it('ignores errored calls for ratios and router rows entirely', async () => {
    const r = routing();
    await recordRoutedUsage({ tenantDbName: 't', routing: r, modelKey: 'small', usage: { inputTokens: 100, outputTokens: 0 }, costUsd: 0, status: 'error' });
    await recordRoutedUsage({ tenantDbName: 't', routing: { ...r, role: 'router' }, modelKey: 'router', usage: {}, costUsd: 5, status: 'success' });
    expect((await getConversationState('t', r.routerKey, 'conv-1')).lastModelKey).toBeUndefined();
    expect(await getRouterSpendUsd('t', r.routerKey, 1)).toBe(0);
  });

  it('model profiles fail soft when the rollup is unavailable', async () => {
    const profiles = await getModelProfiles('t', 'p', ['a']);
    expect(profiles.get('a')).toBeNull();
  });
});
