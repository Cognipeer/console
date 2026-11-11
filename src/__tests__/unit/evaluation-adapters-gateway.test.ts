/**
 * Unit tests — evaluation adapters on the gateway path: target `defaultParams`
 * (R9), retry + timeout of model targets and the judge (R7 / R11), and the
 * `__raw` tool-argument convention (T12).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TRAP: factories must be synchronous — an async vi.mock factory silently
// fails to intercept under this setup.
const h = vi.hoisted(() => ({
  handleChatCompletion: vi.fn(),
  getDatabase: vi.fn(),
  calculateCost: vi.fn(),
}));

vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: h.handleChatCompletion,
  handleEmbeddingRequest: vi.fn(),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({ calculateCost: h.calculateCost }));
vi.mock('@/lib/database', () => ({ getDatabase: h.getDatabase }));

import {
  buildJudgeInvoker,
  buildTargetInvoker,
  extractToolCalls,
  resolveTargetParams,
  type EvaluationModelContext,
} from '@/lib/services/evaluation/adapters';
import type { IEvaluationTarget } from '@/lib/database';
import type { DatasetItem, JudgeCompletion } from '@/lib/services/evaluation/types';

const CTX: EvaluationModelContext = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1', userId: 'u1' };
const ITEM: DatasetItem = { id: 'q1', input: [{ role: 'user', content: 'Hello' }] };

function modelTarget(overrides: Partial<IEvaluationTarget> = {}): IEvaluationTarget {
  return { tenantId: 't1', projectId: 'p1', key: 'm', name: 'M', kind: 'model', modelKey: 'gpt', createdBy: 'u1', ...overrides };
}

function completion(text: string, usage?: Record<string, number>) {
  return { response: { choices: [{ finish_reason: 'stop', message: { content: text } }] }, latencyMs: 5, ...(usage ? { usage } : {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EVALUATION_INVOKER = 'gateway';
  h.calculateCost.mockReturnValue({ totalCost: 0.25 });
  h.getDatabase.mockResolvedValue({
    switchToTenant: vi.fn(),
    listModels: vi.fn().mockResolvedValue([{ key: 'judge', pricing: { currency: 'USD' }, providerDriver: 'openai', modelId: 'j' }]),
  });
});

afterEach(() => {
  delete process.env.EVALUATION_INVOKER;
  vi.useRealTimers();
});

describe('resolveTargetParams (R9)', () => {
  it('reads snake_case and camelCase keys and ignores unknown ones', () => {
    const params = resolveTargetParams({
      defaultParams: { temperature: 0.2, top_p: 0.9, seed: 7, stop: 'END', presencePenalty: 0.1, frequency_penalty: 0.3, nonsense: 1 },
    });
    expect(params).toEqual({ temperature: 0.2, topP: 0.9, seed: 7, stop: ['END'], presencePenalty: 0.1, frequencyPenalty: 0.3 });
  });

  it('lets an explicit target maxTokens beat max_tokens', () => {
    expect(resolveTargetParams({ defaultParams: { max_tokens: 100 } }).maxTokens).toBe(100);
    expect(resolveTargetParams({ maxTokens: 50, defaultParams: { max_tokens: 100 } }).maxTokens).toBe(50);
  });

  it('tolerates null / array defaultParams', () => {
    expect(resolveTargetParams({ defaultParams: null as never })).toEqual({});
    expect(resolveTargetParams({ defaultParams: [] as never })).toEqual({});
  });
});

describe('model target on the gateway path', () => {
  it('sends the target sampling parameters in the request body', async () => {
    h.handleChatCompletion.mockResolvedValue(completion('ok'));
    const invoke = buildTargetInvoker(modelTarget({ defaultParams: { temperature: 0, top_p: 0.5, seed: 3, stop: ['X'] }, maxTokens: 64 }), CTX);
    await invoke(ITEM);
    const body = h.handleChatCompletion.mock.calls[0][0].body;
    expect(body).toMatchObject({ temperature: 0, top_p: 0.5, seed: 3, stop: ['X'], max_tokens: 64 });
  });

  it('retries a 429 up to twice and then succeeds', async () => {
    vi.useFakeTimers();
    const rateLimited = Object.assign(new Error('Too many requests'), { status: 429 });
    h.handleChatCompletion
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce(completion('finally'));
    const promise = buildTargetInvoker(modelTarget(), CTX)(ITEM);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    const output = await promise;
    expect(output.text).toBe('finally');
    expect(h.handleChatCompletion).toHaveBeenCalledTimes(3);
  });

  it('does not retry a deterministic 400', async () => {
    h.handleChatCompletion.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(buildTargetInvoker(modelTarget(), CTX)(ITEM)).rejects.toThrow('bad request');
    expect(h.handleChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('judge invoker (R11)', () => {
  it('returns text and priced usage', async () => {
    h.handleChatCompletion.mockResolvedValue(completion('{"score":1}', { inputTokens: 10, outputTokens: 5 }));
    const result = await buildJudgeInvoker('judge', CTX)([{ role: 'user', content: 'grade' }]) as JudgeCompletion;
    expect(result.text).toBe('{"score":1}');
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.25 });
  });

  it('retries a retryable transport error with Retry-After honoured', async () => {
    vi.useFakeTimers();
    h.handleChatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529, retryAfter: 2 }))
      .mockResolvedValueOnce(completion('{"score":0.5}'));
    const promise = buildJudgeInvoker('judge', CTX)([{ role: 'user', content: 'grade' }]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(((await promise) as JudgeCompletion).text).toBe('{"score":0.5}');
    expect(h.handleChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('still requires a judge model', async () => {
    await expect(buildJudgeInvoker(undefined, CTX)([])).rejects.toThrow(/judgeModelKey/);
  });
});

describe('extractToolCalls (T12)', () => {
  it('keeps unparseable arguments as __raw', () => {
    const calls = extractToolCalls({ choices: [{ message: { tool_calls: [{ function: { name: 'f', arguments: '{oops' } }] } }] });
    expect(calls).toEqual([{ name: 'f', args: { __raw: '{oops' } }]);
  });
});
