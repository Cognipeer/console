/**
 * Unit tests - what a short side call (a rerank score, a verdict, a decision, an attacker turn, a title) sends
 * for reasoning and for its output limit.
 *
 * The reasoning is the LOWEST thinking the model's rule (agent-sdk table) allows; the limits start at a floor
 * (or the model's own "Default max tokens" when larger) and have one raised value for the single retry.
 */

import { describe, expect, it } from 'vitest';
import {
  raisedSideCallLimit,
  sideCallLimits,
  sideCallReasoning,
  titleReasoningForModel,
} from '@/lib/services/agents/agentReasoning';

describe('sideCallReasoning', () => {
  it.each([
    ['anthropic', 'claude-sonnet-5-5'],
    ['anthropic', 'claude-haiku-5-5'],
    ['anthropic', 'claude-opus-4-7'],
    ['anthropic', 'claude-sonnet-4-6'],
    ['bedrock', 'us.anthropic.claude-sonnet-5-5-v1:0'],
  ])('%s / %s: thinking is switched off (the SDK picks the way the model takes)', (providerDriver, modelId) => {
    expect(sideCallReasoning({ providerDriver, modelId })).toEqual({ effort: 'none' });
  });

  it.each([
    ['anthropic', 'claude-opus-5-5'],
    ['anthropic', 'claude-fable-1'],
  ])('%s / %s: a Claude that cannot be switched off gets its lowest effort', (providerDriver, modelId) => {
    expect(sideCallReasoning({ providerDriver, modelId })).toEqual({ effort: 'low' });
  });

  it('a budget-style model gets nothing: thinking is opt-in there', () => {
    expect(sideCallReasoning({ providerDriver: 'anthropic', modelId: 'claude-sonnet-4-5' })).toBeUndefined();
    expect(sideCallReasoning({ providerDriver: 'bedrock', modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0' })).toBeUndefined();
    expect(sideCallReasoning({ providerDriver: 'vertex', modelId: 'gemini-2.5-flash' })).toBeUndefined();
  });

  it('a budget-style model the operator gave a reasoning default is turned down', () => {
    expect(sideCallReasoning({
      providerDriver: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      settings: { reasoning: { effort: 'high' } },
    })).toEqual({ effort: 'none' });
  });

  it.each([
    ['openai', 'gpt-5.2', 'none'],
    ['azure', 'gpt-5.2', 'none'],
    ['openai', 'gpt-5-mini', 'minimal'],
    ['openai', 'o3', 'low'],
    ['openai', 'gpt-oss-120b', 'low'],
    ['openai-compatible', 'gpt-oss-20b', 'low'],
  ])('%s / %s: the lowest effort its rule takes (%s)', (providerDriver, modelId, effort) => {
    expect(sideCallReasoning({ providerDriver, modelId })).toEqual({ effort });
  });

  it('a chat model gets no reasoning: the parameter is a 400 there', () => {
    expect(sideCallReasoning({ providerDriver: 'openai', modelId: 'gpt-4o' })).toBeUndefined();
    expect(sideCallReasoning({ providerDriver: 'openai', modelId: 'gpt-4.1' })).toBeUndefined();
    expect(sideCallReasoning({ providerDriver: 'openai', modelId: 'gpt-5-chat-latest' })).toBeUndefined();
  });

  it('an unknown driver, or no driver at all, gets nothing', () => {
    expect(sideCallReasoning({ providerDriver: 'mystery', modelId: 'gpt-5.2' })).toBeUndefined();
    expect(sideCallReasoning({ modelId: 'gpt-5.2' })).toBeUndefined();
    expect(sideCallReasoning({})).toBeUndefined();
  });

  it('a model only a permissive default rule matched is left alone, unless the operator configured reasoning', () => {
    expect(sideCallReasoning({ providerDriver: 'openai', modelId: 'my-reasoner' })).toBeUndefined();
    expect(sideCallReasoning({
      providerDriver: 'openai',
      modelId: 'my-reasoner',
      settings: { reasoning: { effort: 'high' } },
    })).toEqual({ effort: 'none' });
  });

  it('a Dynamic LLM is routed to models this cannot know: nothing', () => {
    expect(sideCallReasoning({ providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5' }, { dynamic: true })).toBeUndefined();
    expect(sideCallReasoning({ providerDriver: 'openai', modelId: 'gpt-5.2' }, { dynamic: true })).toBeUndefined();
  });

  it('is the same rule a title call uses', () => {
    const models = [
      { providerDriver: 'anthropic', modelId: 'claude-sonnet-5-5' },
      { providerDriver: 'openai', modelId: 'gpt-5-mini' },
      { providerDriver: 'openai', modelId: 'gpt-4o' },
    ];
    for (const model of models) {
      expect(titleReasoningForModel(model)).toEqual(sideCallReasoning(model));
    }
    expect(titleReasoningForModel(models[0], { dynamic: true })).toBeUndefined();
  });
});

describe('raisedSideCallLimit', () => {
  it('doubles the limit that was sent', () => {
    expect(raisedSideCallLimit(1024)).toBe(2048);
    expect(raisedSideCallLimit(32)).toBe(64);
  });

  it('stops at the model maximum', () => {
    expect(raisedSideCallLimit(1024, 1500)).toBe(1500);
    expect(raisedSideCallLimit(1024, 100000)).toBe(2048);
  });

  it('has nothing larger to offer at (or above) the model maximum', () => {
    expect(raisedSideCallLimit(1500, 1500)).toBeUndefined();
    expect(raisedSideCallLimit(4000, 1500)).toBeUndefined();
  });

  it('refuses a limit that is not a positive number', () => {
    expect(raisedSideCallLimit(0)).toBeUndefined();
    expect(raisedSideCallLimit(-5)).toBeUndefined();
    expect(raisedSideCallLimit(Number.NaN)).toBeUndefined();
    expect(raisedSideCallLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('sideCallLimits', () => {
  it('starts at the floor and retries once at double', () => {
    expect(sideCallLimits({ modelId: 'my-model' }, 1024)).toEqual({ limit: 1024, retry: 2048 });
  });

  it('keeps a roomier "Default max tokens" of the model instead of squeezing it to the floor', () => {
    expect(sideCallLimits({ modelId: 'my-model', settings: { maxTokens: 8000 } }, 2048)).toEqual({ limit: 8000, retry: 16000 });
    expect(sideCallLimits({ modelId: 'my-model', settings: { maxCompletionTokens: 6000 } }, 2048)).toEqual({ limit: 6000, retry: 12000 });
  });

  it('a smaller "Default max tokens" does not lower the floor', () => {
    expect(sideCallLimits({ modelId: 'my-model', settings: { maxTokens: 500 } }, 2048)).toEqual({ limit: 2048, retry: 4096 });
  });

  it('caps the floor and the retry at the model maximum', () => {
    const capped = (max: number) => ({ modelId: 'my-model', metadata: { capabilities: { maxOutputTokens: max } } });
    expect(sideCallLimits(capped(3000), 2048)).toEqual({ limit: 2048, retry: 3000 });
    expect(sideCallLimits(capped(1000), 2048)).toEqual({ limit: 1000 });
  });

  it('an explicit value above the model maximum stays, with no retry above it', () => {
    const model = { modelId: 'my-model', settings: { maxTokens: 8000 }, metadata: { capabilities: { maxOutputTokens: 4096 } } };
    expect(sideCallLimits(model, 2048)).toEqual({ limit: 8000 });
  });

  it('reads the built-in maximum of a known model', () => {
    expect(sideCallLimits({ modelId: 'claude-sonnet-5-5' }, 2048)).toEqual({ limit: 2048, retry: 4096 });
  });

  it('tolerates a model without settings', () => {
    expect(sideCallLimits({}, 1024)).toEqual({ limit: 1024, retry: 2048 });
    expect(sideCallLimits({ settings: null }, 1024)).toEqual({ limit: 1024, retry: 2048 });
  });
});
