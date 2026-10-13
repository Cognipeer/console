import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const row = { cancelRequestedAt: undefined as Date | undefined };
const db = {
  getAgentRunById: vi.fn(async () => ({ ...row })),
  runWithTenant: undefined,
  switchToTenant: vi.fn(async () => undefined),
};
vi.mock('@/lib/database', () => ({ getDatabase: async () => db }));

import { abortLocalTurns, watchTurnCancellation } from '@/lib/services/agents/turnWatch';

const input = { tenantDbName: 't', tenantId: 'ten', projectId: 'p', conversationId: 'c1', runId: 'r1' };

describe('watchTurnCancellation', () => {
  beforeEach(() => { vi.useFakeTimers(); row.cancelRequestedAt = undefined; db.getAgentRunById.mockClear(); });
  afterEach(() => vi.useRealTimers());

  it('aborts at once when this node is told to stop the conversation', () => {
    const watch = watchTurnCancellation(input);
    expect(watch.signal.aborted).toBe(false);
    expect(abortLocalTurns('ten', 'c1')).toBe(1);
    expect(watch.signal.aborted).toBe(true);
    expect(watch.stopRequested()).toBe(true);
    watch.stop();
    expect(abortLocalTurns('ten', 'c1')).toBe(0);
  });

  it('aborts when a stop stamped on the row by another node is read', async () => {
    const watch = watchTurnCancellation(input);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(watch.signal.aborted).toBe(false);
    row.cancelRequestedAt = new Date();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(watch.signal.aborted).toBe(true);
    watch.stop();
  });

  it('follows the parent signal without calling it a stop request', () => {
    const parent = new AbortController();
    const watch = watchTurnCancellation({ ...input, runId: undefined, parent: parent.signal });
    parent.abort();
    expect(watch.signal.aborted).toBe(true);
    expect(watch.stopRequested()).toBe(false);
    watch.stop();
  });

  it('does not stop a turn of another conversation or tenant', () => {
    const watch = watchTurnCancellation(input);
    expect(abortLocalTurns('other', 'c1')).toBe(0);
    expect(abortLocalTurns('ten', 'c2')).toBe(0);
    expect(watch.signal.aborted).toBe(false);
    watch.stop();
  });
});
