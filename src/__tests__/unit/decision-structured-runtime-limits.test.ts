/**
 * Unit tests - the structured decision runtime as a short side call.
 *
 * It sends the lowest thinking the model allows, and a document cut off at the output limit is no answer:
 * `decide()` retries once with the model's "Default max tokens" doubled (stopping at the model maximum), then
 * throws a DecisionBackendError that names the limit and that setting. The usage of every call that ran is
 * kept (summed on success, carried on the error).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DecisionBackendError,
  createStructuredDecisionRuntime,
} from '@/lib/providers/contracts/structuredDecisionRuntime';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import type { DecisionRequest } from '@/lib/providers/domains/decision';

const request: DecisionRequest = {
  input: [{ type: 'text', text: 'Great service, thanks!' }],
  questions: {
    sentiment: { type: 'choice', choices: { pos: 'positive', neg: 'negative' } },
    urgent: { type: 'boolean' },
  },
};

const ANSWER = JSON.stringify({ answers: { sentiment: { pos: 0.9, neg: 0.1 }, urgent: 0.05 } });
const CUT_OFF = '{"answers":{"sentiment":{"pos":0.9';

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    model: 'm',
    content: ANSWER,
    toolCalls: [],
    finishReason: 'stop',
    raw: {},
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 0,
      cachedWriteTokens: 0,
      cachedOutputTokens: 0,
      reasoningTokens: 0,
    },
    ...overrides,
  };
}

/** The usage of a call that stopped at its limit: it billed what it burned. */
const burned = (outputTokens: number) => ({
  inputTokens: 100,
  outputTokens,
  totalTokens: 100 + outputTokens,
  cachedInputTokens: 0,
  cachedWriteTokens: 0,
  cachedOutputTokens: 0,
  reasoningTokens: 0,
});

function fakeClient(...replies: Array<Record<string, unknown>>) {
  const complete = vi.fn();
  for (const reply of replies) complete.mockResolvedValueOnce(reply);
  const runtime: ModelProviderRuntime = { createNativeChatClient: vi.fn().mockResolvedValue({ complete }) };
  return { runtime, complete };
}

const configOf = (modelId: string, modelSettings: Record<string, unknown> = {}) => ({
  modelId,
  category: 'decision' as const,
  modelSettings,
});

const callOf = (complete: ReturnType<typeof vi.fn>, call: number) => complete.mock.calls[call][0] as Record<string, unknown>;

describe('the decision call asks for the lowest thinking the model allows', () => {
  it('switches thinking off on an adaptive Claude', async () => {
    const { runtime, complete } = fakeClient(response());
    await createStructuredDecisionRuntime(runtime, configOf('claude-sonnet-5-5'), 'anthropic').decide(request);
    expect(callOf(complete, 0).reasoning).toEqual({ effort: 'none' });
  });

  it('switches thinking off on a Claude behind Bedrock', async () => {
    const { runtime, complete } = fakeClient(response());
    await createStructuredDecisionRuntime(runtime, configOf('us.anthropic.claude-sonnet-5-5-v1:0'), 'bedrock').decide(request);
    expect(callOf(complete, 0).reasoning).toEqual({ effort: 'none' });
  });

  it('sends the lowest effort of an OpenAI reasoning model', async () => {
    const { runtime, complete } = fakeClient(response());
    await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini'), 'openai').decide(request);
    expect(callOf(complete, 0).reasoning).toEqual({ effort: 'minimal' });
  });

  it('sends nothing to a chat model, which would refuse it', async () => {
    const { runtime, complete } = fakeClient(response());
    await createStructuredDecisionRuntime(runtime, configOf('gpt-4o'), 'openai').decide(request);
    expect('reasoning' in callOf(complete, 0)).toBe(false);
  });

  it('sends no limit of its own on the first call: the model\'s "Default max tokens" applies', async () => {
    const { runtime, complete } = fakeClient(response());
    const result = await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini', { maxTokens: 1000 }), 'openai').decide(request);
    expect(complete).toHaveBeenCalledTimes(1);
    expect('maxTokens' in callOf(complete, 0)).toBe(false);
    expect(result.answers.sentiment).toMatchObject({ type: 'choice', choice: 'pos' });
  });
});

describe('a decision cut off at the output limit', () => {
  it('is retried once with the limit the first call ran with doubled (1000 configured, raised to 4096 for thinking), and the usage of both calls is kept', async () => {
    const { runtime, complete } = fakeClient(
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(1000) }),
      response(),
    );

    const result = await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini', { maxTokens: 1000 }), 'openai').decide(request);

    expect(complete).toHaveBeenCalledTimes(2);
    expect('maxTokens' in callOf(complete, 0)).toBe(false);
    // 'minimal' thinking raises a configured 1000 to 4096 on the first call; the retry doubles that, never less
    expect(callOf(complete, 1).maxTokens).toBe(8192);
    // the retry keeps the same thinking
    expect(callOf(complete, 1).reasoning).toEqual({ effort: 'minimal' });
    expect(result.answers.sentiment).toMatchObject({ type: 'choice', choice: 'pos' });
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 1020, totalTokens: 1220 });
  });

  it('starts from the max completion tokens setting when both limits are set (raised for thinking)', async () => {
    const { runtime, complete } = fakeClient(
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(500) }),
      response(),
    );

    await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini', { maxCompletionTokens: 500, maxTokens: 9000 }), 'openai').decide(request);

    // the first call ran at 4096 (thinking headroom over the configured 500)
    expect(callOf(complete, 1).maxTokens).toBe(8192);
  });

  it('on Anthropic with nothing configured, doubles the driver default the first call ran with', async () => {
    const { runtime, complete } = fakeClient(
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(8192) }),
      response(),
    );

    await createStructuredDecisionRuntime(
      runtime,
      configOf('my-claude', { maxOutputTokens: 100000 }),
      'anthropic',
    ).decide(request);

    // the first call ran at min(100000, 21333); the retry is never below it
    expect(callOf(complete, 1).maxTokens).toBe(42666);
  });

  it('is retried at no more than the model maximum', async () => {
    const { runtime, complete } = fakeClient(
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(3000) }),
      response(),
    );

    await createStructuredDecisionRuntime(
      runtime,
      configOf('my-model', { maxTokens: 3000, maxOutputTokens: 4096 }),
      'openai',
    ).decide(request);

    expect(callOf(complete, 1).maxTokens).toBe(4096);
  });

  it('throws a DecisionBackendError naming the limit and the setting when the retry is cut off too', async () => {
    const { runtime, complete } = fakeClient(
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(1000) }),
      response({ content: CUT_OFF, finishReason: 'length', usage: burned(2000) }),
    );

    const error = await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini', { maxTokens: 1000 }), 'openai')
      .decide(request)
      .catch((e: unknown) => e);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(DecisionBackendError);
    const typed = error as DecisionBackendError;
    expect(typed.status).toBe(422);
    expect(typed.message).toContain('output token limit (8192 tokens)');
    expect(typed.message).toContain('also after one retry with a larger limit');
    expect(typed.message).toContain('"Default max tokens"');
    // what the cut-off calls burned is still reported
    expect(typed.usage).toEqual({ inputTokens: 200, outputTokens: 3000, totalTokens: 3200 });
  });

  it('is not retried when no "Default max tokens" is known to start from', async () => {
    const { runtime, complete } = fakeClient(response({ content: CUT_OFF, finishReason: 'length', usage: burned(800) }));

    const error = await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini'), 'openai')
      .decide(request)
      .catch((e: unknown) => e);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DecisionBackendError);
    const typed = error as DecisionBackendError;
    expect(typed.message).toContain('output token limit');
    expect(typed.message).toContain('"Default max tokens"');
    expect(typed.message).not.toContain('after one retry');
    expect(typed.usage).toEqual({ inputTokens: 100, outputTokens: 800, totalTokens: 900 });
  });

  it('is not retried when the limit is already at the model maximum', async () => {
    const { runtime, complete } = fakeClient(response({ content: CUT_OFF, finishReason: 'length', usage: burned(4096) }));

    const error = await createStructuredDecisionRuntime(
      runtime,
      configOf('my-model', { maxTokens: 4096, maxOutputTokens: 4096 }),
      'openai',
    ).decide(request).catch((e: unknown) => e);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(DecisionBackendError);
    expect((error as DecisionBackendError).message).toContain('output token limit (4096 tokens)');
    expect((error as DecisionBackendError).message).not.toContain('after one retry');
  });

  it('a finished answer is never retried', async () => {
    const { runtime, complete } = fakeClient(response());
    await createStructuredDecisionRuntime(runtime, configOf('gpt-5-mini', { maxTokens: 1000 }), 'openai').decide(request);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
