/**
 * The agent's chat model at its output limit, beyond a plain doubling (gatewayChatModel.ts): the
 * retry of a call that sent no limit, the retry of a Dynamic LLM call (on the child that ran, under
 * the child's maximum), the thinking separator a live view gets where a retry starts, the finish
 * reason of the limit notice, and what a side pass of the SDK says about itself (its own reasoning
 * and its purpose). The SDK is replaced by a stand-in that hands the provider back, and the gateway
 * core by a script, so the calls the provider makes and the chunks it yields can be read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
const getModelByKey = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: (...a: unknown[]) => getModelByKey(...a) }));
vi.mock('@/lib/services/models/gatewayRouting', () => ({
  // The real one carries the hand-off on the call's context under an internal key; the stand-in under a readable one.
  withRouterHandoff: (context: object, routerHandoff: object) => ({ ...context, routerHandoff }),
}));
vi.mock('@cognipeer/agent-sdk', () => ({
  fromNativeProvider: (provider: unknown) => ({ provider }),
}));

import { OutputTokenLimitError, CONTEXT_WINDOW_EXCEEDED_REASON } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel, raisedOutputLimit } from '@/lib/services/agents/gatewayChatModel';
import { createOutputLimitTap, outputLimitNotice, outputLimitRetrySeparator } from '@/lib/services/agents/outputLimitNotice';

type Chunk = Record<string, any>;
type Provider = { completeStream: (r: unknown) => AsyncGenerator<Chunk>; complete: (r: unknown) => Promise<Chunk> };
type Handoff = { pin?: string; onChild?: (modelKey: string) => void };

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const router = {
  key: 'router', modelId: 'router', providerDriver: 'dynamic',
  settings: { dynamic: { strategy: 'rule-based', defaultModelKey: 'big', rules: [] } },
} as never;
const withMax = (maxOutputTokens: number) => ({ ...(model as object), metadata: { capabilities: { maxOutputTokens } } });
const REQUEST = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const answer = { result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } };
/** What a failed attempt burned (the core's canonical usage: reasoning included in the output). */
const burned = { inputTokens: 50, outputTokens: 4096, totalTokens: 4146 };

const build = async (extra: object = {}): Promise<Provider> => {
  const chat = await buildGatewayChatModel({
    tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
  }) as unknown as { provider: Provider };
  return chat.provider;
};
const collect = async (generator: AsyncGenerator<Chunk>) => {
  const out: Chunk[] = [];
  for await (const part of generator) out.push(part);
  return out;
};
const wires = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire);
const contextOf = (call = 0) => (executeModelCall.mock.calls[call][0] as { context: Record<string, any> }).context;
const handoffOf = (call: number) => contextOf(call).routerHandoff as Handoff | undefined;

const stream = (...events: unknown[]) => ({
  requestId: 'q',
  stream: (async function* () {
    for (const event of events) {
      if (event instanceof Error) throw event;
      yield event;
    }
  })(),
});
/** A streamed outcome that says which child a Dynamic LLM routed the attempt to. */
const routedStream = (child: string, ...events: unknown[]) => ({ ...stream(...events), routing: { chosenModelKey: child } });
const done = (extra: object = {}) => ({
  type: 'done',
  response: { id: 'r', model: 'm', content: '', toolCalls: [], usage: {}, finishReason: 'stop' },
  usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 }, nativeUsage: { inputTokens: 5 }, wireFinishReason: 'stop', outputLimitReached: false, ...extra,
});
const limitEvent = (extra: object = {}) => ({ type: 'output_limit', error: { message: 'cut', type: 'invalid_request_error' }, limit: 100, ...extra });
const isReset = (chunk: Chunk) => chunk.reset === true;
/** The call's own routing hand-off, as the router would read it: told which child ran, then the call fails at its limit. */
const failsAtLimitOn = (...children: string[]) => async (call: { context: { routerHandoff: Handoff } }) => {
  for (const child of children) call.context.routerHandoff.onChild?.(child);
  throw new OutputTokenLimitError(100);
};

beforeEach(() => {
  executeModelCall.mockReset();
  getModelByKey.mockReset();
});

describe('raisedOutputLimit where no limit was configured (VTX-2 / OC-1)', () => {
  const unknown = { modelId: 'some-unknown-model', settings: {} } as never;
  const capped = { modelId: 'x', metadata: { capabilities: { maxOutputTokens: 10000 } }, settings: {} } as never;

  it('doubles the output tokens the failed attempt burned', () => {
    expect(raisedOutputLimit(undefined, unknown, undefined, 4096)).toBe(8192);
  });

  it('stays under the model maximum, and gives up once the attempt reached it', () => {
    expect(raisedOutputLimit(undefined, capped, undefined, 6000)).toBe(10000);
    expect(raisedOutputLimit(undefined, capped, undefined, 10000)).toBeUndefined();
    expect(raisedOutputLimit(undefined, capped, undefined, 12000)).toBeUndefined();
  });

  it('stays under what is left of the run\'s output-token budget', () => {
    expect(raisedOutputLimit(undefined, unknown, 5000, 4096)).toBe(5000);
    expect(raisedOutputLimit(undefined, unknown, 4096, 4096)).toBeUndefined();
  });

  it('with no observation the model maximum is the one thing left to try; with no maximum either, nothing', () => {
    expect(raisedOutputLimit(undefined, capped)).toBe(10000);
    expect(raisedOutputLimit(undefined, capped, 3000)).toBe(3000);
    expect(raisedOutputLimit(undefined, capped, 0)).toBeUndefined();
    expect(raisedOutputLimit(undefined, unknown)).toBeUndefined();
    expect(raisedOutputLimit(undefined, unknown, undefined, 0)).toBeUndefined();
  });

  it('a limit the call ran with still wins over what it burned', () => {
    expect(raisedOutputLimit(100, unknown, undefined, 4096)).toBe(200);
    expect(raisedOutputLimit(100, unknown)).toBe(200);
  });
});

describe('a call that sent no limit: the retry is built from what the failed attempt burned (non-stream)', () => {
  it('sends the doubled output tokens as max_tokens AND max_completion_tokens', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(undefined, { usage: burned }))
      .mockResolvedValueOnce(answer);
    const response = await (await build({ overrides: {} })).complete(REQUEST);
    expect(response.content).toBe('hello');
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(wires()[1]).toMatchObject({ max_tokens: 8192, max_completion_tokens: 8192 });
  });

  it('stays under the model maximum', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(undefined, { usage: burned }))
      .mockResolvedValueOnce(answer);
    await (await build({ model: withMax(6000), overrides: {} })).complete(REQUEST);
    expect(wires()[1]).toMatchObject({ max_tokens: 6000, max_completion_tokens: 6000 });
  });

  it('stays under what is left of the run budget', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(undefined, { usage: burned }))
      .mockResolvedValueOnce(answer);
    await (await build({ overrides: {}, maxTotalOutputTokens: 5000 })).complete(REQUEST);
    expect(wires()[1]).toMatchObject({ max_tokens: 5000, max_completion_tokens: 5000 });
  });

  it('with no usage on the error the model maximum is tried', async () => {
    executeModelCall
      .mockRejectedValueOnce(new OutputTokenLimitError(undefined))
      .mockResolvedValueOnce(answer);
    await (await build({ model: withMax(9000), overrides: {} })).complete(REQUEST);
    expect(wires()[1]).toMatchObject({ max_tokens: 9000, max_completion_tokens: 9000 });
  });

  it('with no usage and no known maximum there is no retry: the notice', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(undefined); });
    const tap = createOutputLimitTap();
    const response = await (await build({ overrides: {}, outputLimitTap: tap })).complete(REQUEST);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(response.content).toBe(outputLimitNotice(undefined));
    expect(tap.latest()).toEqual({ kind: 'notice' });
  });

  it('a full context window is still not retried, whatever the attempt burned', async () => {
    executeModelCall.mockImplementation(async () => {
      throw new OutputTokenLimitError(undefined, { usage: burned, rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON });
    });
    await (await build({ overrides: {} })).complete(REQUEST);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
  });
});

describe('a call that sent no limit: the retry is built from what the failed attempt burned (streamed)', () => {
  it('uses the usage the abandoned attempt\'s done event reported', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(
        { type: 'delta', content: 'partial' },
        limitEvent({ limit: undefined }),
        done({ outputLimitReached: true, usage: burned, nativeUsage: burned }),
      ))
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build({ overrides: {} })).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    expect(wires()[1]).toMatchObject({ max_tokens: 8192, max_completion_tokens: 8192 });
    expect(chunks.filter(isReset)).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.delta.content === 'hello')).toBe(true);
  });

  it('a stream that reported no usage is retried at the model maximum', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(
        limitEvent({ limit: undefined }),
        done({ outputLimitReached: true, nativeUsage: undefined }),
      ))
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'hello' }, done()));
    await collect((await build({ model: withMax(9000), overrides: {} })).completeStream(REQUEST));
    expect(wires()[1]).toMatchObject({ max_tokens: 9000, max_completion_tokens: 9000 });
  });

  it('a stream that reported no usage, on a model with no known maximum, ends with the notice', async () => {
    executeModelCall.mockImplementation(async () => stream(
      limitEvent({ limit: undefined }),
      done({ outputLimitReached: true, nativeUsage: undefined }),
    ));
    const chunks = await collect((await build({ overrides: {} })).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(undefined));
  });
});

describe('a Dynamic LLM at its output limit (G4-9)', () => {
  const child = (maxOutputTokens?: number) => ({
    key: 'big', modelId: 'big', providerDriver: 'openai', settings: {},
    ...(maxOutputTokens ? { metadata: { capabilities: { maxOutputTokens } } } : {}),
  });

  it('caps the raise by the child that ran, and runs the retry on that child alone', async () => {
    getModelByKey.mockResolvedValue(child(150));
    executeModelCall.mockImplementationOnce(failsAtLimitOn('big')).mockResolvedValueOnce(answer);
    const response = await (await build({ model: router })).complete(REQUEST);
    expect(response.content).toBe('hello');
    expect(getModelByKey).toHaveBeenCalledWith('t', 'big', 'p');
    // Not 200: the router declares no maximum of its own, the child does.
    expect(wires()[1]).toMatchObject({ max_tokens: 150, max_completion_tokens: 150 });
    expect(handoffOf(0)?.pin).toBeUndefined();
    expect(handoffOf(1)?.pin).toBe('big');
  });

  it('a call that sent no limit is raised from what the child burned, under the child\'s maximum (VTX-2 on a router)', async () => {
    getModelByKey.mockResolvedValue(child(6000));
    executeModelCall
      .mockImplementationOnce(async (call: { context: { routerHandoff: Handoff } }) => {
        call.context.routerHandoff.onChild?.('big');
        throw new OutputTokenLimitError(undefined, { usage: burned });
      })
      .mockResolvedValueOnce(answer);
    await (await build({ model: router, overrides: {} })).complete(REQUEST);
    // 2 x 4096 = 8192, but the child writes 6000 at most and the router declares nothing of its own.
    expect(wires()[0]).not.toHaveProperty('max_tokens');
    expect(wires()[1]).toMatchObject({ max_tokens: 6000, max_completion_tokens: 6000 });
    expect(handoffOf(1)?.pin).toBe('big');
  });

  it('streamed, the child comes from the outcome of the failed attempt', async () => {
    getModelByKey.mockResolvedValue(child(150));
    const onRouted = vi.fn();
    executeModelCall
      .mockResolvedValueOnce(routedStream('big', { type: 'delta', content: 'part' }, limitEvent()))
      .mockResolvedValueOnce(routedStream('big', { type: 'delta', content: 'ok' }, done()));
    const chunks = await collect((await build({ model: router, onRouted })).completeStream(REQUEST));
    expect(wires()[1]).toMatchObject({ max_tokens: 150, max_completion_tokens: 150 });
    expect(handoffOf(0)?.pin).toBeUndefined();
    expect(handoffOf(1)?.pin).toBe('big');
    expect(onRouted).toHaveBeenCalledWith('big');
    expect(chunks.filter(isReset)).toHaveLength(1);
  });

  it('the child that ran last is the one: a fallback that answered for the primary is where the retry goes', async () => {
    getModelByKey.mockImplementation(async (_db: string, key: string) => ({ key, modelId: key, providerDriver: 'openai', settings: {} }));
    executeModelCall.mockImplementationOnce(failsAtLimitOn('big', 'small')).mockResolvedValueOnce(answer);
    await (await build({ model: router })).complete(REQUEST);
    expect(getModelByKey).toHaveBeenCalledWith('t', 'small', 'p');
    expect(handoffOf(1)?.pin).toBe('small');
  });

  it('a child that cannot be read leaves the ceiling unknown: no blind raise, the notice', async () => {
    getModelByKey.mockResolvedValue(null);
    executeModelCall.mockImplementation(failsAtLimitOn('big'));
    const tap = createOutputLimitTap();
    const response = await (await build({ model: router, outputLimitTap: tap })).complete(REQUEST);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(response.content).toBe(outputLimitNotice(100));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('a lookup that fails is the same as a child that cannot be read', async () => {
    getModelByKey.mockRejectedValue(new Error('database down'));
    executeModelCall.mockImplementation(failsAtLimitOn('big'));
    await (await build({ model: router })).complete(REQUEST);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
  });

  it('a call that never learned its child is capped by the router\'s own record and pinned to nothing', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(answer);
    await (await build({ model: router })).complete(REQUEST);
    expect(getModelByKey).not.toHaveBeenCalled();
    expect(wires()[1]).toMatchObject({ max_tokens: 200, max_completion_tokens: 200 });
    expect(handoffOf(1)?.pin).toBeUndefined();
  });

  it('a plain model gets no hand-off and costs no lookup', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(answer);
    await (await build()).complete(REQUEST);
    expect(contextOf(0)).not.toHaveProperty('routerHandoff');
    expect(contextOf(1)).not.toHaveProperty('routerHandoff');
    expect(getModelByKey).not.toHaveBeenCalled();
    expect(wires()[1]).toMatchObject({ max_tokens: 200 });
  });

  it('two calls in flight never share what they learned about their child', async () => {
    getModelByKey.mockImplementation(async (_db: string, key: string) => ({ key, modelId: key, providerDriver: 'openai', settings: {} }));
    const seen: Array<string | undefined> = [];
    executeModelCall.mockImplementation(async (call: { context: { routerHandoff: Handoff }; request: { messages: Array<{ content: string }> } }) => {
      const who = call.request.messages[0].content === 'first' ? 'big' : 'small';
      if (call.context.routerHandoff.pin) {
        seen.push(call.context.routerHandoff.pin);
        return answer;
      }
      call.context.routerHandoff.onChild?.(who);
      await new Promise((resolve) => setTimeout(resolve, who === 'big' ? 5 : 1));
      throw new OutputTokenLimitError(100);
    });
    const provider = await build({ model: router });
    await Promise.all([
      provider.complete({ ...REQUEST, messages: [{ role: 'user', content: 'first' }] }),
      provider.complete({ ...REQUEST, messages: [{ role: 'user', content: 'second' }] }),
    ]);
    expect(seen.sort()).toEqual(['big', 'small']);
  });
});

describe('a retry after streamed thinking tells a live view where it starts (OL-14)', () => {
  const thinking = (text: string) => ({ type: 'delta', reasoning: text });
  const summaries = (chunks: Chunk[]) => chunks.map((chunk) => chunk.delta?.reasoning?.summary).filter(Boolean);

  it('yields one reasoning delta with the separator after the reset and before the retry\'s first delta', async () => {
    const shown: string[] = [];
    executeModelCall
      .mockResolvedValueOnce(stream(thinking('weighing it'), limitEvent(), done({ outputLimitReached: true })))
      .mockResolvedValueOnce(stream(thinking('again'), { type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build({ onReasoning: (text: string) => shown.push(text) })).completeStream(REQUEST));

    const at = chunks.findIndex(isReset);
    expect(at).toBe(1);
    expect(chunks[at + 1].delta.reasoning).toEqual({ summary: outputLimitRetrySeparator() });
    expect(chunks[at + 2].delta.reasoning).toEqual({ summary: 'again' });
    expect(summaries(chunks)).toEqual(['weighing it', outputLimitRetrySeparator(), 'again']);
    // A caller that renders thinking through the callback sees the same sequence.
    expect(shown).toEqual(['weighing it', outputLimitRetrySeparator(), 'again']);
    expect(chunks.filter(isReset)).toHaveLength(1);
  });

  it('the separator reads as a notice in English, set apart from the thinking around it', () => {
    expect(outputLimitRetrySeparator()).toContain('Retrying with a higher output limit');
    expect(outputLimitRetrySeparator()).toMatch(/^\s*\n/);
    expect(outputLimitRetrySeparator()).toMatch(/\n\s*$/);
  });

  it('is not yielded when the abandoned attempt showed no thinking', async () => {
    const shown: string[] = [];
    executeModelCall
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'partial' }, limitEvent()))
      .mockResolvedValueOnce(stream(thinking('retry thinks'), { type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build({ onReasoning: (text: string) => shown.push(text) })).completeStream(REQUEST));
    expect(summaries(chunks)).toEqual(['retry thinks']);
    expect(shown).toEqual(['retry thinks']);
  });

  it('is not yielded when the reasoning text is hidden (the provider is not asked to show it)', async () => {
    executeModelCall
      .mockResolvedValueOnce({ ...stream(thinking('hidden'), limitEvent()), includeReasoning: false })
      .mockResolvedValueOnce({ ...stream({ type: 'delta', content: 'hello' }, done()), includeReasoning: false });
    const chunks = await collect((await build()).completeStream(REQUEST));
    expect(summaries(chunks)).toEqual([]);
  });

  it('is not yielded when no retry follows: the notice comes after the reset alone', async () => {
    executeModelCall.mockResolvedValueOnce(stream(thinking('weighing it'), limitEvent()));
    const chunks = await collect((await build({ model: withMax(100) })).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(summaries(chunks)).toEqual(['weighing it']);
    expect(chunks.filter(isReset)).toHaveLength(1);
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(100));
  });

  it('a retry that streams nothing and hits the limit again is reset once more before the notice (the separator is a streamed piece too)', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(thinking('weighing it'), limitEvent()))
      .mockResolvedValueOnce(stream(limitEvent()));
    const chunks = await collect((await build()).completeStream(REQUEST));
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    const resets = chunks.map((chunk, index) => (isReset(chunk) ? index : -1)).filter((index) => index >= 0);
    expect(resets).toHaveLength(2);
    expect(chunks[resets[0] + 1].delta.reasoning).toEqual({ summary: outputLimitRetrySeparator() });
    expect(resets[1]).toBe(resets[0] + 2);
    expect(chunks[chunks.length - 1].delta.content).toBe(outputLimitNotice(100));
    expect(summaries(chunks)).toEqual(['weighing it', outputLimitRetrySeparator()]);
  });

  it('a callback that throws never fails the retry', async () => {
    executeModelCall
      .mockResolvedValueOnce(stream(thinking('weighing it'), limitEvent()))
      .mockResolvedValueOnce(stream({ type: 'delta', content: 'hello' }, done()));
    const chunks = await collect((await build({ onReasoning: () => { throw new Error('display broke'); } })).completeStream(REQUEST));
    expect(chunks.some((chunk) => chunk.delta.content === 'hello')).toBe(true);
  });
});

describe('the limit notice finishes length, not stop (GAP2-01)', () => {
  it('non-stream: the response says length and carries no tool call', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const tap = createOutputLimitTap();
    const response = await (await build({ outputLimitTap: tap })).complete(REQUEST);
    expect(response.content).toBe(outputLimitNotice(100));
    expect(response.finishReason).toBe('length');
    expect(response.toolCalls).toEqual([]);
    // The structural report the turn's outcome is read from stays.
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('streamed: the notice chunk says length', async () => {
    executeModelCall.mockImplementation(async () => stream(limitEvent()));
    const tap = createOutputLimitTap();
    const chunks = await collect((await build({ outputLimitTap: tap })).completeStream(REQUEST));
    expect(chunks[chunks.length - 1]).toMatchObject({ finishReason: 'length', delta: { content: outputLimitNotice(100) } });
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('the context-window notice finishes length too', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100, { rawFinishReason: CONTEXT_WINDOW_EXCEEDED_REASON }); });
    const response = await (await build()).complete(REQUEST);
    expect(response.finishReason).toBe('length');
  });

  it('an ordinary answer keeps the finish reason of the core', async () => {
    executeModelCall.mockResolvedValue(answer);
    expect((await (await build()).complete(REQUEST)).finishReason).toBe('stop');
  });
});

describe('a side pass of the SDK brings its own reasoning (GAP2-06)', () => {
  it('a call that names its purpose and carries reasoning wins over the agent\'s pick, for that call', async () => {
    executeModelCall.mockResolvedValue(answer);
    const provider = await build({ reasoning: { effort: 'high' } });
    await provider.complete({ ...REQUEST, purpose: 'summary', reasoning: { effort: 'low' } });
    expect(contextOf(0).reasoningOverride).toEqual({ effort: 'low' });
    // The next call has none of its own: the agent's pick is back.
    await provider.complete({ ...REQUEST, purpose: 'summary' });
    expect(contextOf(1).reasoningOverride).toEqual({ effort: 'high' });
  });

  it('a call that names no purpose carries the loop\'s preset, not a choice: the agent\'s pick stays above it', async () => {
    executeModelCall.mockResolvedValue(answer);
    const provider = await build({ reasoning: { effort: 'high' } });
    await provider.complete({ ...REQUEST, reasoning: { effort: 'medium' } });
    expect(contextOf(0).reasoningOverride).toEqual({ effort: 'high' });
  });

  it('with no pick of the agent, a side pass\'s reasoning is still an override (above the Model Hub default)', async () => {
    executeModelCall.mockResolvedValue(answer);
    await (await build()).complete({ ...REQUEST, purpose: 'reflection', reasoning: { effort: 'low' } });
    expect(contextOf(0).reasoningOverride).toEqual({ effort: 'low' });
  });

  it('no override at all when neither the agent nor the call picked one', async () => {
    executeModelCall.mockResolvedValue(answer);
    await (await build()).complete({ ...REQUEST, purpose: 'reflection' });
    expect(contextOf(0)).not.toHaveProperty('reasoningOverride');
  });

  it('a pick the call carries that is not usable falls back to the agent\'s', async () => {
    executeModelCall.mockResolvedValue(answer);
    await (await build({ reasoning: { effort: 'high' } })).complete({ ...REQUEST, purpose: 'summary', reasoning: { effort: 'bogus' } });
    expect(contextOf(0).reasoningOverride).toEqual({ effort: 'high' });
  });
});

describe('the purpose a call names tags its usage row (GAP2-08)', () => {
  it('sets requestTags.purpose for that call and leaves the route alone', async () => {
    executeModelCall.mockResolvedValue(answer);
    await (await build({ route: 'agent.chat', agentKey: 'a1', sessionId: 's1' })).complete({ ...REQUEST, purpose: 'reflection' });
    expect(contextOf(0)).toMatchObject({
      route: 'agent.chat',
      requestTags: { agentKey: 'a1', sessionId: 's1', purpose: 'reflection' },
    });
  });

  it('beats the purpose the agent built the model for, only for the call that names one', async () => {
    executeModelCall.mockResolvedValue(answer);
    const provider = await build({ purpose: 'title' });
    await provider.complete({ ...REQUEST, purpose: 'summary' });
    await provider.complete(REQUEST);
    expect(contextOf(0).requestTags.purpose).toBe('summary');
    expect(contextOf(1).requestTags.purpose).toBe('title');
  });

  it('a call that names none adds no tag', async () => {
    executeModelCall.mockResolvedValue(answer);
    await (await build()).complete(REQUEST);
    expect(contextOf(0).requestTags).not.toHaveProperty('purpose');
  });

  it('ignores a purpose that is empty or not a string', async () => {
    executeModelCall.mockResolvedValue(answer);
    const provider = await build();
    const unusable: unknown[] = ['', '   ', 42, null, {}, ['summary']];
    for (const purpose of unusable) await provider.complete({ ...REQUEST, purpose });
    for (let call = 0; call < unusable.length; call += 1) {
      expect(contextOf(call).requestTags).not.toHaveProperty('purpose');
    }
  });

  it('streamed calls carry it too', async () => {
    executeModelCall.mockImplementation(async () => stream({ type: 'delta', content: 'hello' }, done()));
    await collect((await build()).completeStream({ ...REQUEST, purpose: 'summary' }));
    expect(contextOf(0).requestTags.purpose).toBe('summary');
  });
});
