import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeModelCall = vi.fn();
vi.mock('@/lib/services/models/gatewayCore', () => ({ executeModelCall: (...a: unknown[]) => executeModelCall(...a) }));

import { OutputTokenLimitError } from '@/lib/services/models/openaiErrors';
import { buildGatewayChatModel, raisedOutputLimit } from '@/lib/services/agents/gatewayChatModel';
import { buildTurnInputState, describeTurnOutcome, serializeCarriedState, loadConversationState } from '@/lib/services/agents/agentTurnState';
import { incompleteReason } from '@/lib/services/agents/agentService';
import {
  OUTPUT_LIMIT_NOTICE_FLAG,
  contextWindowNotice,
  createOutputLimitTap,
  isOutputLimitNoticeMessage,
  markOutputLimitNotice,
  outputLimitNotice,
  outputLimitStopDetail,
} from '@/lib/services/agents/outputLimitNotice';

const model = { key: 'm', modelId: 'm-1', providerDriver: 'openai', settings: {} } as never;
const ok = { result: { response: { id: 'r', model: 'm', content: 'hello', toolCalls: [], usage: {}, finishReason: 'stop' } } };
const build = (extra: object = {}) => buildGatewayChatModel({
  tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: { max_tokens: 100 }, ...extra,
});
const sentLimits = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire.max_tokens);
const sentWires = () => executeModelCall.mock.calls.map((c) => (c[0] as { wire: Record<string, unknown> }).wire);
const CONTEXT_FULL = 'model_context_window_exceeded';

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

  it('caps at the model maximum (declared, else the built-in table) and skips a retry that would not raise anything', () => {
    const declared = { modelId: 'x', metadata: { capabilities: { maxOutputTokens: 150 } }, settings: {} } as never;
    expect(raisedOutputLimit(100, declared)).toBe(150);
    expect(raisedOutputLimit(150, declared)).toBeUndefined();
    expect(raisedOutputLimit(200, declared)).toBeUndefined();
    // Built-in table: Claude Sonnet 4.5 tops out at 64000 output tokens.
    const sonnet45 = { modelId: 'claude-sonnet-4-5', settings: {} } as never;
    expect(raisedOutputLimit(40000, sonnet45)).toBe(64000);
    expect(raisedOutputLimit(64000, sonnet45)).toBeUndefined();
    // No declared maximum and none in the table: plain doubling.
    expect(raisedOutputLimit(8192, { modelId: 'some-unknown-model', settings: {} } as never)).toBe(16384);
    // The declared value wins over the table.
    expect(raisedOutputLimit(40000, { modelId: 'claude-sonnet-4-5', metadata: { capabilities: { maxOutputTokens: 50000 } }, settings: {} } as never)).toBe(50000);
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
    expect(result.content).toBe(outputLimitNotice(100));
  });

  it('does not retry when the run budget leaves no room', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const chat = await build({ maxTotalOutputTokens: 100 });
    const result = await (chat as unknown as { invoke: (m: unknown) => Promise<{ content: string }> }).invoke([{ role: 'user', content: 'hi' }]);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(outputLimitNotice(100));
  });

  it('retries from the limit the failed call RAN with (error.limit), and sends it as max_tokens AND max_completion_tokens', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(4096)).mockResolvedValueOnce(ok);
    // No max_tokens override of the agent: the first call's limit came from the gateway's own default.
    const chat = await buildGatewayChatModel({ tenantDbName: 't', tenantId: 't', projectId: 'p', model, overrides: {} });
    await (chat as unknown as { invoke: (m: unknown) => Promise<unknown> }).invoke(USER);
    expect(sentWires()[1]).toMatchObject({ max_tokens: 8192, max_completion_tokens: 8192 });
  });

  it('a retry beside a max_completion_tokens override replaces both spellings', async () => {
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockResolvedValueOnce(ok);
    const chat = await build({ overrides: { max_tokens: 100, max_completion_tokens: 100 } });
    await (chat as unknown as { invoke: (m: unknown) => Promise<unknown> }).invoke(USER);
    expect(sentWires()[1]).toMatchObject({ max_tokens: 200, max_completion_tokens: 200 });
  });

  it('does not retry when the model maximum leaves nothing to raise: the notice at once', async () => {
    const capped = { ...(model as object), metadata: { capabilities: { maxOutputTokens: 100 } } } as never;
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100); });
    const tap = createOutputLimitTap();
    const chat = await build({ model: capped, outputLimitTap: tap });
    const result = await (chat as unknown as Invoke).invoke(USER);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(outputLimitNotice(100));
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('a full context window is not retried: a distinct context-window notice', async () => {
    executeModelCall.mockImplementation(async () => { throw new OutputTokenLimitError(100, { rawFinishReason: CONTEXT_FULL }); });
    const tap = createOutputLimitTap();
    const chat = await build({ outputLimitTap: tap });
    const result = await (chat as unknown as Invoke).invoke(USER);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(result.content).toBe(contextWindowNotice());
    expect(result.content).not.toContain('max_tokens');
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100, contextWindow: true });
  });

  it('a retry the provider refuses with a 400 about max_tokens degrades to the notice (never fails the run)', async () => {
    const refused = Object.assign(new Error('max_tokens: 200 > 128, which is the maximum allowed number of output tokens'), { status: 400 });
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100, { usage: failedAttempt })).mockRejectedValueOnce(refused);
    const tap = createOutputLimitTap();
    const chat = await build({ outputLimitTap: tap });
    const result = await (chat as unknown as Invoke).invoke(USER);
    expect(executeModelCall).toHaveBeenCalledTimes(2);
    // The notice names the limit the first attempt ran with, not the raised one the model refused.
    expect(result.content).toBe(outputLimitNotice(100));
    expect(result.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 });
    expect(tap.latest()).toEqual({ kind: 'notice', limit: 100 });
  });

  it('any other failure of the retry is still an error', async () => {
    const unrelated = Object.assign(new Error('Incorrect API key provided'), { status: 400 });
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockRejectedValueOnce(unrelated);
    const chat = await build();
    await expect((chat as unknown as Invoke).invoke(USER)).rejects.toThrow('Incorrect API key provided');
    const serverError = Object.assign(new Error('max_tokens exploded'), { status: 500 });
    executeModelCall.mockReset();
    executeModelCall.mockRejectedValueOnce(new OutputTokenLimitError(100)).mockRejectedValueOnce(serverError);
    await expect((chat as unknown as Invoke).invoke(USER)).rejects.toThrow('max_tokens exploded');
  });

  it('an answer cut off at the limit (truncated) keeps its text and reports a partial turn', async () => {
    executeModelCall.mockResolvedValueOnce({ ...ok, truncated: true });
    const tap = createOutputLimitTap();
    const chat = await build({ outputLimitTap: tap });
    const result = await (chat as unknown as Invoke).invoke(USER);
    expect(result.content).toBe('hello');
    expect(tap.latest()).toEqual({ kind: 'truncated' });
    // The next call starts clean.
    executeModelCall.mockResolvedValueOnce(ok);
    await (chat as unknown as Invoke).invoke(USER);
    expect(tap.latest()).toBeUndefined();
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

  it('builds the retry from the limit and stop reason the core\'s output_limit event carries', async () => {
    executeModelCall
      .mockResolvedValueOnce({ requestId: 'q1', stream: coreStream({ type: 'output_limit', error: { message: 'cut', type: 'invalid_request_error' }, limit: 1000, rawFinishReason: 'max_tokens' }) })
      .mockResolvedValueOnce({ requestId: 'q2', stream: coreStream({ type: 'delta', content: 'hello' }, done({}, {})) });
    const chat = await build({ overrides: {} }) as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(sentWires()[1]).toMatchObject({ max_tokens: 2000, max_completion_tokens: 2000 });
    expect(parts[parts.length - 1]).toMatchObject({ content: 'hello' });
  });

  it('a context-window output_limit event is not retried and ends with the context-window notice', async () => {
    executeModelCall.mockResolvedValue({ requestId: 'q1', stream: coreStream({ type: 'output_limit', error: { message: 'ctx', type: 'invalid_request_error' }, limit: 1000, rawFinishReason: CONTEXT_FULL }) });
    const tap = createOutputLimitTap();
    const chat = await build({ outputLimitTap: tap }) as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(parts[parts.length - 1]).toMatchObject({ content: contextWindowNotice() });
    expect(tap.latest()).toMatchObject({ kind: 'notice', contextWindow: true });
  });

  it('a streamed answer cut off at the limit (done.truncated) keeps its text and reports a partial turn', async () => {
    executeModelCall.mockResolvedValueOnce({ requestId: 'q', stream: coreStream(
      { type: 'delta', content: 'half an ans' },
      done({}, { truncated: true, wireFinishReason: 'length' }),
    ) });
    const tap = createOutputLimitTap();
    const chat = await build({ outputLimitTap: tap }) as unknown as Stream;
    const parts: any[] = [];
    for await (const part of chat.stream(USER)) parts.push(part);
    expect(executeModelCall).toHaveBeenCalledTimes(1);
    expect(parts[parts.length - 1]).toMatchObject({ content: 'half an ans' });
    expect(tap.latest()).toEqual({ kind: 'truncated' });
  });
});

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
    expect(result.content).toBe(outputLimitNotice(100));
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
    expect(last.content).toBe(outputLimitNotice(100));
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
    expect(String(last.content)).toContain('output token limit');
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
  const empty = { state: { messages: [] } };

  it('reports a reported limit notice as an incomplete max_output_tokens stop, whatever its text says', () => {
    const outcome = describeTurnOutcome({ content: outputLimitNotice(200), ...empty } as never, 0, { kind: 'notice', limit: 200 });
    expect(outcome.stopReason).toBe('limit');
    expect(outcome.partial).toBe(true);
    expect(outcome.stopDetail).toBe('maxOutputTokens (200) reached by the model');
    expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('max_output_tokens');
  });

  it('does NOT recognise the notice by its text: with no report the same words are a normal answer', () => {
    expect(describeTurnOutcome({ content: outputLimitNotice(200), ...empty } as never, 0).stopReason).toBe('completed');
  });

  it('a truncated answer is a partial turn that keeps its text', () => {
    const outcome = describeTurnOutcome({ content: 'half an ans', ...empty } as never, 0, { kind: 'truncated', limit: 500 });
    expect(outcome).toMatchObject({ stopReason: 'limit', content: 'half an ans', partial: true });
    expect(outcome.stopDetail).toMatch(/^maxOutputTokens/);
    expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('max_output_tokens');
    expect(describeTurnOutcome({ content: 'half', ...empty } as never, 0, { kind: 'truncated' }).stopDetail).toBe('maxOutputTokens cut the answer short');
  });

  it('a context-window notice is a limit stop of its own', () => {
    const outcome = describeTurnOutcome({ content: contextWindowNotice(), ...empty } as never, 0, { kind: 'notice', contextWindow: true });
    expect(outcome.stopReason).toBe('limit');
    expect(outcome.stopDetail).toBe(outputLimitStopDetail({ kind: 'notice', contextWindow: true }));
    expect(incompleteReason(outcome.stopReason, outcome.stopDetail)).toBe('run_limit');
  });

  it('a budget or cancellation the SDK reported wins over the report', () => {
    const state = { state: { messages: [], ctx: { __limitBreached: 'maxWallClockMs (1ms) exceeded' } } };
    expect(describeTurnOutcome({ content: 'x', ...state } as never, 0, { kind: 'truncated' }).stopDetail).toMatch(/^maxWallClockMs/);
  });

  it('leaves normal answers alone', () => {
    expect(describeTurnOutcome({ content: 'fine', ...empty } as never, 0).stopReason).toBe('completed');
  });
});

describe('the limit notice is flagged, and the next turn does not replay it to the model', () => {
  const assistant = (content: string) => ({ role: 'assistant', content });

  it('flags the last assistant message of the state, only for a notice', () => {
    const state = { messages: [{ role: 'user', content: 'q' }, assistant(outputLimitNotice(100))] };
    markOutputLimitNotice(state, { kind: 'truncated', limit: 100 });
    expect(isOutputLimitNoticeMessage(state.messages[1])).toBe(false);
    markOutputLimitNotice(state, undefined);
    expect(isOutputLimitNoticeMessage(state.messages[1])).toBe(false);
    markOutputLimitNotice(state, { kind: 'notice', limit: 100 });
    expect(isOutputLimitNoticeMessage(state.messages[1])).toBe(true);
    expect((state.messages[1] as any).additional_kwargs[OUTPUT_LIMIT_NOTICE_FLAG]).toBe(true);
    expect(isOutputLimitNoticeMessage(state.messages[0])).toBe(false);
  });

  it('keeps other additional_kwargs and ignores a state that does not end with an assistant message', () => {
    const kept = { messages: [{ role: 'assistant', content: 'n', additional_kwargs: { a: 1 } }] };
    markOutputLimitNotice(kept, { kind: 'notice' });
    expect((kept.messages[0] as any).additional_kwargs).toEqual({ a: 1, [OUTPUT_LIMIT_NOTICE_FLAG]: true });
    const toolLast = { messages: [{ role: 'tool', content: 'r' }] };
    markOutputLimitNotice(toolLast, { kind: 'notice' });
    expect(isOutputLimitNoticeMessage(toolLast.messages[0])).toBe(false);
    expect(() => markOutputLimitNotice(undefined, { kind: 'notice' })).not.toThrow();
  });

  it('the state saved after a notice turn leaves the notice out; a truncated answer stays', async () => {
    const notice = { messages: [{ role: 'user', content: 'q' }, assistant(outputLimitNotice(100))] };
    markOutputLimitNotice(notice, { kind: 'notice', limit: 100 });
    const saved = JSON.parse(await decoded(notice));
    expect(saved.messages).toEqual([{ role: 'user', content: 'q' }]);

    const truncated = { messages: [{ role: 'user', content: 'q' }, assistant('half an ans')] };
    markOutputLimitNotice(truncated, { kind: 'truncated' });
    expect(JSON.parse(await decoded(truncated)).messages).toHaveLength(2);
  });

  it('a transcript replay skips the assistant turn that ended with a notice, but not one that ended with a truncated answer', () => {
    const transcript = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: outputLimitNotice(100), stopReason: 'limit', stopDetail: outputLimitStopDetail({ kind: 'notice', limit: 100 }) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'half an ans', stopReason: 'limit', stopDetail: outputLimitStopDetail({ kind: 'truncated', limit: 100 }) },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: contextWindowNotice(), stopReason: 'limit', stopDetail: outputLimitStopDetail({ kind: 'notice', contextWindow: true }) },
    ];
    const state = buildTurnInputState({ carried: null, transcript, userMessage: 'q4' });
    expect(state.messages.map((m: any) => m.content)).toEqual(['q1', 'q2', 'half an ans', 'q3', 'q4']);
  });
});

/** The state as `saveConversationState` would store it, read back through the loader. */
async function decoded(state: unknown): Promise<string> {
  const snapshot = serializeCarriedState(state as never)!;
  const loaded = await loadConversationState(
    { findAgentConversationState: async () => ({ snapshot, messageCount: 0 }) } as never,
    { _id: 'c', messages: [] } as never,
  );
  return JSON.stringify(loaded);
}
