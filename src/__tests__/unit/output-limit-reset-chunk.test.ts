/**
 * The raised-limit retry as the agent-sdk provider sees it: the chunks `completeStream` yields.
 * The SDK is replaced by a stand-in that hands the provider back, so the chunk sequence (the
 * `reset` chunk in particular, which agent-sdk 0.20 ignores and >= 0.21 acts on) can be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));
vi.mock('@cognipeer/agent-sdk', () => ({
  fromNativeProvider: (provider: unknown) => ({ provider }),
}));

import { OutputTokenLimitError, CONTEXT_WINDOW_EXCEEDED_REASON } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel } from '@/lib/services/agents/gatewayChatModel';
import { contextWindowNotice, createOutputLimitTap, outputLimitNotice } from '@/lib/services/agents/outputLimitNotice';

type Chunk = Record<string, any>;
const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const REQUEST = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

const build = async (extra: object = {}) => {
  const chat = await buildGatewayChatModel({
    tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
  }) as unknown as { provider: { completeStream: (r: unknown) => AsyncGenerator<Chunk>; complete: (r: unknown) => Promise<Chunk> } };
  return chat.provider;
};
const collect = async (generator: AsyncGenerator<Chunk>) => {
  const out: Chunk[] = [];
  for await (const part of generator) out.push(part);
  return out;
};
const wires = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire);

const stream = (...events: unknown[]) => ({
  requestId: 'q',
  stream: (async function* () {
    for (const event of events) {
      if (event instanceof Error) throw event;
      yield event;
    }
  })(),
});
const done = (extra: object = {}) => ({
  type: 'done',
  response: { id: 'r', model: 'm', content: '', toolCalls: [], usage: {}, finishReason: 'stop' },
  usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, nativeUsage: { inputTokens: 5 }, wireFinishReason: 'stop', outputLimitReached: false, ...extra,
});
const limitEvent = (extra: object = {}) => ({ type: 'output_limit', error: { message: 'cut', type: 'invalid_request_error' }, limit: 100, ...extra });
const isReset = (chunk: Chunk) => chunk.reset === true;

beforeEach(() => { executeModelCall.mockReset(); });

describe('reset chunk before the raised retry', () => {
  it('is yielded exactly once, after what the failed attempt streamed and before the retry\'s chunks', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(
        { type: 'delta', content: 'partial thought' },
        { type: 'delta', toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '{"q":' }] },
        limitEvent(),
      ))
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build()).completeStream(REQUEST));

    expect(chunks.filter(isReset)).toHaveLength(1);
    const at = chunks.findIndex(isReset);
    expect(chunks.slice(0, at).map((c) => c.delta.content ?? (c.delta.toolCalls ? 'tool' : undefined))).toEqual(['partial thought', 'tool']);
    expect(chunks[at]).toMatchObject({ delta: {} });
    expect(chunks.slice(at + 1).some((c) => c.delta.content === 'hello')).toBe(true);
    // The retry's own pieces are never discarded by a later reset.
    expect(chunks.slice(at + 1).some(isReset)).toBe(false);
  });

  it('is not yielded when the first attempt succeeds', async () => {
    executeModelCall.mockResolvedValueOnce(stream({ type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build()).completeStream(REQUEST));
    expect(chunks.some(isReset)).toBe(false);
  });

  it('is not yielded when no retry is planned and nothing was streamed: the notice alone', async () => {
    executeModelCall.mockResolvedValueOnce(stream(limitEvent({ rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON })));
    const chunks = await collect((await build()).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(chunks.some(isReset)).toBe(false);
    expect(chunks[chunks.length - 1].delta.content).toBe(contextWindowNotice());
  });

  it('is yielded before a notice that follows streamed pieces (no retry), so no half-built tool call survives it', async () => {
    executeModelCall.mockResolvedValueOnce(stream(
      { type: 'delta', toolCalls: [{ index: 0, id: 'c1', name: 'lookup', arguments: '{"q":' }] },
      limitEvent({ rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON }),
    ));
    const chunks = await collect((await build()).completeStream(REQUEST));
    const at = chunks.findIndex(isReset);
    expect(at).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].delta.content).toBe(contextWindowNotice());
    expect(at).toBe(chunks.length - 2);
  });
});

describe('retry wire and limits', () => {
  it('retries from event.limit, capped by the model maximum, with both spellings', async () => {
    const capped = { ...(model as object), metadata: { capabilities: { maxOutputTokens: 150 } } };
    executeModelCall
      .mockResolvedValueOnce(stream(limitEvent()))
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'ok' }, done()));
    await collect((await build({ model: capped })).completeStream(REQUEST));
    expect(wires()[1]).toMatchObject({ max_tokens: 150, max_completion_tokens: 150 });
  });

  it('skips the retry when the next limit would not exceed the base (model maximum reached)', async () => {
    const capped = { ...(model as object), metadata: { capabilities: { maxOutputTokens: 100 } } };
    executeModelCall.mockResolvedValue(stream(limitEvent()));
    const tap = createOutputLimitTap();
    const chunks = await collect((await build({ model: capped, outputLimitTap: tap })).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(100));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('a retry the provider refuses with a 400 about max_tokens degrades to the notice with the base limit', async () => {
    const refused = Object.assign(new Error('max_completion_tokens is too large: 200. This model supports at most 128 completion tokens.'), { status: 400 });
    executeModelCall
      .mockResolvedValueOnce(stream(limitEvent()))
      .mockResolvedValueOnce(stream({ type: 'failed', error: { message: refused.message, type: 'invalid_request_error', param: 'max_completion_tokens' }, status: 400 }));
    const tap = createOutputLimitTap();
    const chunks = await collect((await build({ outputLimitTap: tap })).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(100));
    expect(chunks.filter(isReset)).toHaveLength(1);
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('a retry that fails for another reason is an error', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(limitEvent()))
      .mockResolvedValueOnce(stream({ type: 'failed', error: { message: 'upstream overloaded', type: 'server_error' }, status: 503 }));
    await expect(collect((await build()).completeStream(REQUEST))).rejects.toThrow('upstream overloaded');
  });

  it('carries the error the notice is built from: the event\'s limit and provider stop reason', async () => {
    executeModelCall.mockImplementation(async () => stream(limitEvent({ limit: 4096, rawFinishReason: 'max_tokens' })));
    const tap = createOutputLimitTap();
    const chunks = await collect((await build({ outputLimitTap: tap })).completeStream(REQUEST));
    // 4096 -> 8192 retried, and the second attempt hit 4096 again (the same scripted event): the notice names it.
    expect(wires()[1]).toMatchObject({ max_tokens: 8192 });
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(4096));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 4096 });
  });
});

describe('non-stream', () => {
  it('a limit error built by the core is retried and the call input carries both spellings', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(100))
      .mockResolvedValueOnce({ result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } });
    const response = await (await build()).complete(REQUEST);
    expect(response.content).toBe('hello');
    expect(wires()[1]).toMatchObject({ max_tokens: 200, max_completion_tokens: 200 });
  });
});
