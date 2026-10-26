import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));

import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel, raisedOutputLimit } from '@/lib/services/agents/gatewayChatModel';
import { describeTurnOutcome } from '@/lib/services/agents/agentTurnState';
import { incompleteReason } from '@/lib/services/agents/agentService';
import { outputLimitNotice, parseOutputLimitNotice } from '@/lib/services/agents/outputLimitNotice';

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const ok = { result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } };
const build = (extra: object = {}) => buildGatewayChatModel({
  tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
});
const sentLimits = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire.max_tokens);

beforeEach(() => { executeModelCall.mockReset(); });

describe('raisedOutputLimit', () => {
  it('doubles, capped by declared max and remaining budget', () => {
    expect(raisedOutputLimit(100, model)).toBe(200);
    expect(raisedOutputLimit(100, { settings: { maxOutputTokens: 150 } } as never)).toBe(150);
    expect(raisedOutputLimit(100, model, 130)).toBe(130);
    expect(raisedOutputLimit(100, model, 100)).toBeUndefined();
    expect(raisedOutputLimit(undefined, model)).toBeUndefined();
    expect(raisedOutputLimit(100, { settings: { maxOutputTokens: 100 } } as never)).toBeUndefined();
  });
});

describe('agent turn on output token limit', () => {
  it('retries once with a doubled limit and returns the answer', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(ok);
    const chat = await build();
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('hello');
    expect(sentLimits()).toEqual([100, 200]);
  });

  it('ends gracefully with the notice when the retry also hits the limit', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build();
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(parseOutputLimitNotice(String(result.content))).not.toBeNull();
  });

  it('does not retry when the run budget leaves no room', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build({ maxTotalOutputTokens: 100 });
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(parseOutputLimitNotice(String(result.content))).not.toBeNull();
  });
});

describe('streamed agent turn on output token limit', () => {
  it('ends with the notice chunk after the raised retry also hits the limit', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build() as unknown as { stream: (m: unknown) => AsyncIterable<unknown> };
    const out: unknown[] = [];
    for await (const part of chat.stream([{ role: 'user', content: 'hi' }])) out.push(part);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(sentLimits()).toEqual([100, 200]);
    expect(JSON.stringify(out)).toContain('output token limit');
  });
});

type Invoke = { invoke: (m: unknown) => Promise<{ content: string; usage?: Record<string, any> }> };
type Stream = { stream: (m: unknown) => AsyncIterable<any> };
const USER = [{ role: 'user', content: 'hi' }];
const failedAttempt = { inputTokens: 50, outputTokens: 100, totalTokens: 150, cachedInputTokens: 10, cachedWriteTokens: 5 };

/** A scripted core stream: the events, in order (an Error in the list is thrown from the stream). */
function coreStream(...events: unknown[]) {
  return (async function* () {
    for (const event of events) {
      if (event instanceof Error) throw event;
      yield event;
    }
  })();
}
const done = (usage: object, extra: object = {}) => ({
  type: 'done',
  response: { id: 'r', model: 'm', content: '', toolCalls: [], usage: {}, finishReason: 'stop' },
  usage, nativeUsage: {}, wireFinishReason: 'stop', outputLimitReached: false, ...extra,
});
const limitHit = { type: 'output_limit', error: { message: 'limit', type: 'invalid_request_error' } };

describe('usage of an attempt that hit the output limit (agent ledger)', () => {
  it('non-stream: the failed attempt\'s usage is added to the retry\'s answer', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(100, { usage: failedAttempt }))
      .mockResolvedValueOnce({ ...ok, usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedInputTokens: 20 } });
    const chat = await build() as unknown as Invoke;
    const result = await chat.invoke(USER);
    expect(result.content).toBe('hello');
    expect(result.usage).toMatchObject({
      prompt_tokens: 100, completion_tokens: 130, total_tokens: 230,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
    });
  });

  it('non-stream: both attempts hit the limit, so the notice carries the sum, not zero', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100, { usage: failedAttempt }); });
    const chat = await build() as unknown as Invoke;
    const result = await chat.invoke(USER);
    expect(parseOutputLimitNotice(String(result.content))).not.toBeNull();
    expect(result.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } });
  });

  it('non-stream: an error without usage adds nothing (the retry\'s own usage stands)', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(100))
      .mockResolvedValueOnce({ ...ok, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    const chat = await build() as unknown as Invoke;
    const result = await chat.invoke(USER);
    expect(result.usage).toMatchObject({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it('non-stream: the single attempt with no room to retry still reports what it burned', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100, { usage: failedAttempt }); });
    const chat = await build({ maxTotalOutputTokens: 100 }) as unknown as Invoke;
    const result = await chat.invoke(USER);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(result.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 });
  });

  it('stream: the limit attempt\'s done chunk is not forwarded; its usage rides on the retry\'s final chunk', async () => {
    executeModelCall
      .mockResolvedValueOnce({ requestId: 'q1', stream: coreStream(done(failedAttempt, { outputLimitReached: true, wireFinishReason: 'length', nativeUsage: { inputTokens: 50 } }), new OutputTokenLimitError(100)) })
      .mockResolvedValueOnce({ requestId: 'q2', stream: coreStream(
        { type: 'delta', content: 'hello' },
        done({ inputTokens: 50, outputTokens: 30, totalTokens: 80, cachedInputTokens: 20 }, { nativeUsage: { inputTokens: 50 } }),
      ) });
    const chat = await build() as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(sentLimits()).toEqual([100, 200]);
    expect(parts[parts.length - 1]).toMatchObject({
      content: 'hello',
      usage: { prompt_tokens: 100, completion_tokens: 130, total_tokens: 230, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 } },
    });
  });

  it('stream: both attempts hit the limit; the notice chunk carries the sum', async () => {
    executeModelCall.mockImplementation(async () => ({
      requestId: 'q', stream: coreStream(done(failedAttempt, { outputLimitReached: true, wireFinishReason: 'length', nativeUsage: { inputTokens: 50 } }), new OutputTokenLimitError(100)),
    }));
    const chat = await build() as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    const last = parts[parts.length - 1];
    expect(parseOutputLimitNotice(String(last.content))).not.toBeNull();
    expect(last.usage).toMatchObject({ prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 });
  });

  it('stream: the core\'s own output_limit event ends the turn with the notice and what the attempt burned', async () => {
    executeModelCall.mockImplementation(async () => ({
      requestId: 'q', stream: coreStream(done(failedAttempt, { outputLimitReached: true, wireFinishReason: 'length', nativeUsage: { inputTokens: 50 } }), limitHit),
    }));
    const chat = await build() as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    const last = parts[parts.length - 1];
    expect(parseOutputLimitNotice(String(last.content))).not.toBeNull();
    expect(last.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 });
  });

  it('stream: usage the core estimated (no provider usage) is handed over, flagged', async () => {
    executeModelCall.mockResolvedValueOnce({ requestId: 'q', stream: coreStream(
      { type: 'delta', content: 'hello' },
      done({ inputTokens: 12, outputTokens: 2, totalTokens: 14 }, { usageEstimated: true }),
    ) });
    const chat = await build() as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(parts[parts.length - 1]).toMatchObject({ usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } });
  });

  it('stream: a stream that carried no usage at all reports none', async () => {
    executeModelCall.mockResolvedValueOnce({ requestId: 'q', stream: coreStream({ type: 'delta', content: 'hello' }, done({})) });
    const chat = await build() as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    const usage = parts[parts.length - 1].usage;
    expect(usage?.prompt_tokens ?? 0).toBe(0);
    expect(usage?.completion_tokens ?? 0).toBe(0);
  });
});

describe('turn outcome', () => {
  it('reports the notice as an incomplete max_output_tokens stop', () => {
    const outcome = describeTurnOutcome({ content: outputLimitNotice(200), state: { messages: [] } } as never, 0);
    expect(outcome.stopReason).toBe('limit');
    expect(outcome.partial).toBe(true);
    expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('max_output_tokens');
  });
  it('leaves normal answers alone', () => {
    expect(describeTurnOutcome({ content: 'fine', state: { messages: [] } } as never, 0).stopReason).toBe('completed');
  });
});
