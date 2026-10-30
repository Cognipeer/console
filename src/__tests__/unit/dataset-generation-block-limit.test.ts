/**
 * Unit tests - the `max_tokens` a dataset generation call is sent with.
 * A value is sent only when it is larger than the limit the call would otherwise get: it is the caller's hard cap
 * at the gateway, so a smaller one would lower a limit that was already raised for thinking.
 */
import { describe, it, expect } from 'vitest';
import { blockOutputLimit } from '@/lib/services/evaluation/datasetGeneration';
import type { IModel } from '@/lib/database';

const model = (over: Record<string, unknown>) => over as unknown as IModel;

describe('blockOutputLimit', () => {
  it('sends nothing for a thinking model whose effective limit is already larger (Sonnet 5.x, 1000, medium)', () => {
    const m = model({
      providerDriver: 'anthropic',
      modelId: 'claude-sonnet-5-5',
      settings: { maxTokens: 1000, reasoning: { effort: 'medium' } },
    });
    expect(blockOutputLimit(3, m)).toBeUndefined();
  });

  it('raises a configured limit below the need when the call has no reasoning', () => {
    const m = model({ providerDriver: 'openai', modelId: 'gpt-4o', settings: { maxTokens: 1000 } });
    expect(blockOutputLimit(3, m)).toBe(2048);
    expect(blockOutputLimit(5, m)).toBe(3000);
  });

  it('sends nothing when nothing is configured or the configured limit covers the need', () => {
    expect(blockOutputLimit(3, model({ providerDriver: 'openai', modelId: 'gpt-4o', settings: {} }))).toBeUndefined();
    expect(
      blockOutputLimit(3, model({ providerDriver: 'openai', modelId: 'gpt-4o', settings: { maxTokens: 4096 } })),
    ).toBeUndefined();
  });
});
