/**
 * Unit tests - the red-team judge and attacker as short side calls.
 *
 * Both are sent the lowest thinking their model allows and an explicit output limit; a reply that stops at
 * that limit is asked for once more with a larger one. The target under test is NOT touched: it runs exactly
 * as configured (no limit, no reasoning override), because that is what is being attacked.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
}));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: vi.fn(),
}));

import { handleChatCompletion } from '@/lib/services/models/inferenceService';
import { getModelByKey } from '@/lib/services/models/modelService';
import { CONTEXT_WINDOW_EXCEEDED_REASON, OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { AGENT_REASONING_OVERRIDE } from '@/lib/services/models/reasoning';
import {
  buildAttackerInvoker,
  buildJudgeInvoker,
  buildTargetInvoker,
} from '@/lib/services/redteam/adapters';

const chat = handleChatCompletion as unknown as Mock;
const modelByKey = getModelByKey as unknown as Mock;

const ctx = { tenantDbName: 'db', tenantId: 't1', projectId: 'p1' };
const messages = [{ role: 'user' as const, content: 'grade this' }];

const completion = (content: string, finishReason = 'stop') => ({
  response: { choices: [{ finish_reason: finishReason, message: { content } }] },
  latencyMs: 3,
});

const model = (overrides: Record<string, unknown> = {}) => ({
  key: 'side-model',
  category: 'llm',
  modelId: 'gpt-5-mini',
  providerDriver: 'openai',
  settings: {},
  ...overrides,
});

const bodyOf = (call: number) => chat.mock.calls[call][0].body as Record<string | symbol, unknown>;

beforeEach(() => {
  chat.mockReset();
  modelByKey.mockReset();
  modelByKey.mockResolvedValue(model());
  chat.mockResolvedValue(completion('verdict'));
});

describe('the judge call', () => {
  it('is sent an explicit output limit and the lowest thinking, at temperature 0', async () => {
    const text = await buildJudgeInvoker('judge', ctx)(messages);

    expect(text).toBe('verdict');
    expect(modelByKey).toHaveBeenCalledWith('db', 'judge', 'p1');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0]).toMatchObject({ tenantDbName: 'db', tenantId: 't1', modelKey: 'judge', projectId: 'p1' });
    expect(bodyOf(0)).toMatchObject({ messages, temperature: 0, max_tokens: 1024 });
    expect(bodyOf(0)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'minimal' });
  });

  it('switches thinking off on an adaptive Claude judge', async () => {
    modelByKey.mockResolvedValue(model({ modelId: 'claude-sonnet-5-5', providerDriver: 'anthropic' }));
    await buildJudgeInvoker('judge', ctx)(messages);
    expect(bodyOf(0)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'none' });
  });

  it('sends no reasoning to a chat model, but still the limit', async () => {
    modelByKey.mockResolvedValue(model({ modelId: 'gpt-4o' }));
    await buildJudgeInvoker('judge', ctx)(messages);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
    expect(bodyOf(0).max_tokens).toBe(1024);
  });

  it('sends no reasoning to a Dynamic LLM', async () => {
    modelByKey.mockResolvedValue(model({ settings: { dynamic: { strategy: 'rules', defaultModelKey: 'fallback' } } }));
    await buildJudgeInvoker('judge', ctx)(messages);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
  });

  it('keeps a roomier "Default max tokens" of the judge model instead of squeezing it', async () => {
    modelByKey.mockResolvedValue(model({ settings: { maxTokens: 8000 } }));
    await buildJudgeInvoker('judge', ctx)(messages);
    expect(bodyOf(0).max_tokens).toBe(8000);
  });

  it('still sends the limit when the model record cannot be read', async () => {
    modelByKey.mockResolvedValue(null);
    await buildJudgeInvoker('judge', ctx)(messages);
    expect(bodyOf(0).max_tokens).toBe(1024);
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
  });

  it('needs a judge model', async () => {
    await expect(buildJudgeInvoker(undefined, ctx)(messages)).rejects.toThrow(/judgeModelKey is required/);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('a judge reply that stops at the output limit', () => {
  it('is asked for once more with the limit doubled when no text came back at all', async () => {
    chat.mockRejectedValueOnce(new OutputTokenLimitError(1024)).mockResolvedValueOnce(completion('{"success_score":0.2}'));

    const text = await buildJudgeInvoker('judge', ctx)(messages);

    expect(text).toBe('{"success_score":0.2}');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).max_tokens).toBe(1024);
    expect(bodyOf(1).max_tokens).toBe(2048);
    // the retry keeps the same thinking
    expect(bodyOf(1)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'minimal' });
  });

  it('is asked for once more when the verdict ends mid-way', async () => {
    chat.mockResolvedValueOnce(completion('{"success_sc', 'length')).mockResolvedValueOnce(completion('{"success_score":0.2}'));

    const text = await buildJudgeInvoker('judge', ctx)(messages);

    expect(text).toBe('{"success_score":0.2}');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(bodyOf(1).max_tokens).toBe(2048);
  });

  it('throws an error naming the limit and the setting when the retry is cut off too', async () => {
    chat.mockResolvedValue(completion('{"success_sc', 'length'));

    const error = await buildJudgeInvoker('judge', ctx)(messages).catch((e: unknown) => e);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('output token limit (2048 tokens)');
    expect((error as Error).message).toContain('"Default max tokens"');
  });

  it('rethrows the limit error when the retry gets no text either', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(1024));

    await expect(buildJudgeInvoker('judge', ctx)(messages)).rejects.toBeInstanceOf(OutputTokenLimitError);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('is not retried when the limit already is the model maximum', async () => {
    modelByKey.mockResolvedValue(model({ metadata: { capabilities: { maxOutputTokens: 1024 } } }));
    chat.mockRejectedValue(new OutputTokenLimitError(1024));

    await expect(buildJudgeInvoker('judge', ctx)(messages)).rejects.toBeInstanceOf(OutputTokenLimitError);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('is not retried when the context window is full: a larger output limit does not cure it', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(1024, { rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON }));

    await expect(buildJudgeInvoker('judge', ctx)(messages)).rejects.toBeInstanceOf(OutputTokenLimitError);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('leaves any other error alone', async () => {
    const boom = new Error('upstream 503');
    chat.mockRejectedValue(boom);

    await expect(buildJudgeInvoker('judge', ctx)(messages)).rejects.toBe(boom);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe('the attacker call', () => {
  it('is sent an explicit output limit and the lowest thinking, at temperature 0.8', async () => {
    const text = await buildAttackerInvoker('attacker', ctx)(messages);

    expect(text).toBe('verdict');
    expect(modelByKey).toHaveBeenCalledWith('db', 'attacker', 'p1');
    expect(bodyOf(0)).toMatchObject({ messages, temperature: 0.8, max_tokens: 1024 });
    expect(bodyOf(0)[AGENT_REASONING_OVERRIDE]).toEqual({ effort: 'minimal' });
  });

  it('is asked once more with the limit doubled when it stopped at the limit', async () => {
    chat.mockRejectedValueOnce(new OutputTokenLimitError(1024)).mockResolvedValueOnce(completion('next attack'));

    expect(await buildAttackerInvoker('attacker', ctx)(messages)).toBe('next attack');
    expect(bodyOf(1).max_tokens).toBe(2048);
  });

  it('uses a message that is still cut off after the retry: a partial attack is still an attack', async () => {
    chat.mockResolvedValue(completion('partial attack', 'length'));

    expect(await buildAttackerInvoker('attacker', ctx)(messages)).toBe('partial attack');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('needs an attacker model', async () => {
    await expect(buildAttackerInvoker(undefined, ctx)(messages)).rejects.toThrow(/attackerModelKey is required/);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('the target under test', () => {
  it('is called exactly as configured: no output limit, no reasoning override, no model lookup', async () => {
    const out = await buildTargetInvoker({ kind: 'model', key: 'target', modelKey: 'target-model' }, ctx)(messages);

    expect(out.text).toBe('verdict');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0].modelKey).toBe('target-model');
    expect(bodyOf(0)).toEqual({ messages });
    expect(AGENT_REASONING_OVERRIDE in bodyOf(0)).toBe(false);
    expect(modelByKey).not.toHaveBeenCalled();
  });

  it('a limit error of the target is not retried: it is the finding', async () => {
    chat.mockRejectedValue(new OutputTokenLimitError(512));

    await expect(buildTargetInvoker({ kind: 'model', key: 'target', modelKey: 'target-model' }, ctx)(messages))
      .rejects.toBeInstanceOf(OutputTokenLimitError);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
