import { describe, expect, it } from 'vitest';
import { addPlaygroundUsage, pausedLegsUsage } from '@/lib/services/agents/playgroundUsage';

const paused = (usage: Record<string, number>) => ({
  role: 'assistant' as const,
  usage,
  pendingActions: [{ id: 'a' }] as never,
});

describe('usage of a turn that paused and resumed', () => {
  it('sums every paused leg, stopping at the user message before them', () => {
    const legs = pausedLegsUsage([
      { role: 'assistant', usage: { totalTokens: 999 } },
      { role: 'user' },
      paused({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.1 }),
      paused({ inputTokens: 20, outputTokens: 5, totalTokens: 25, costUsd: 0.2 }),
    ]);
    expect(legs).toMatchObject({ inputTokens: 30, outputTokens: 10, totalTokens: 40 });
    expect(legs?.costUsd).toBeCloseTo(0.3);
  });

  it('is undefined when the last message did not pause', () => {
    expect(pausedLegsUsage([{ role: 'user' }, { role: 'assistant', usage: { totalTokens: 5 } }])).toBeUndefined();
  });

  it('adds the resumed leg to the earlier ones and drops a cost one leg could not price', () => {
    expect(addPlaygroundUsage({ inputTokens: 1, totalTokens: 3, costUsd: 1 }, { inputTokens: 2, totalTokens: 4 }))
      .toEqual({ inputTokens: 3, outputTokens: undefined, cachedInputTokens: undefined, totalTokens: 7 });
  });
});
