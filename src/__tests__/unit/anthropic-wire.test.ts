/**
 * Anthropic Messages ⇄ OpenAI translation.
 *
 * Every case here is a shape that fails SILENTLY when it regresses: a tool
 * result that lands after the answer it answered, a content block an SDK was
 * never told about, a cached turn whose input tokens are counted twice. None of
 * them throws — they just produce a transcript the model reasons about wrongly
 * or a usage number that is quietly too high.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  anthropicErrorTypeForUpstream,
  anthropicRequestToOpenAi,
  AnthropicRequestError,
  openAiResponseToAnthropic,
  openAiStreamToAnthropic,
} from '@/lib/services/models/anthropicWire';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Parses an SSE transcript into `[event, payload]` pairs. */
function frames(sse: string): Array<[string, Record<string, unknown>]> {
  return sse
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      return [event, JSON.parse(data) as Record<string, unknown>];
    });
}

describe('request translation', () => {
  it('requires the fields the Messages API requires', () => {
    expect(() => anthropicRequestToOpenAi({ messages: [], max_tokens: 10 }))
      .toThrow(AnthropicRequestError);
    // max_tokens is mandatory in Messages and optional in chat-completions;
    // letting it through would silently make the request unbounded.
    expect(() => anthropicRequestToOpenAi({ model: 'm', messages: [] }))
      .toThrow(/max_tokens/);
  });

  it('lifts the system field into a system message', () => {
    const out = anthropicRequestToOpenAi({
      model: 'm',
      max_tokens: 64,
      system: [{ type: 'text', text: 'You are terse.' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  /**
   * The ordering case. Anthropic packs a tool RESULT into the next user
   * message; OpenAI wants it as its own `tool` message. If the result is
   * emitted after this turn's text, the transcript reads as "answer, then the
   * question it answered" and the model re-runs the tool.
   */
  it('emits tool results before the user text of the same turn', () => {
    const out = anthropicRequestToOpenAi({
      model: 'm',
      max_tokens: 64,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } }],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' },
            { type: 'text', text: 'now delete it' },
          ],
        },
      ],
    });
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0].role).toBe('assistant');
    expect((messages[0].tool_calls as unknown[])).toHaveLength(1);
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'a.txt' });
    expect(messages[2]).toEqual({ role: 'user', content: 'now delete it' });
  });

  it('translates tools and tool_choice, including the any→required rename', () => {
    const out = anthropicRequestToOpenAi({
      model: 'm',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    });
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'Bash', description: 'run', parameters: { type: 'object' } } },
    ]);
    expect(out.tool_choice).toBe('required');

    const pinned = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 64,
      messages: [{ role: 'user', content: 'go' }],
      tool_choice: { type: 'tool', name: 'Bash' },
    });
    expect(pinned.tool_choice).toEqual({ type: 'function', function: { name: 'Bash' } });
  });

  it('carries a base64 image across as a data URL', () => {
    const out = anthropicRequestToOpenAi({
      model: 'm',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        ],
      }],
    });
    const parts = (out.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  });

  /**
   * OpenAI's `tool` message has no error flag. Dropping `is_error` makes the
   * model read a stack trace as a successful result and build on it.
   */
  it('marks a failed tool result so the model can tell it failed', () => {
    const out = anthropicRequestToOpenAi({
      model: 'm',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ENOENT', is_error: true },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
        ],
      }],
    });
    const messages = out.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe('[tool error] ENOENT');
    expect(messages[1].content).toBe('ok');
  });

  it('rejects what the Messages API rejects instead of guessing', () => {
    const base = { model: 'm', max_tokens: 64 };
    // A `system` entry inside `messages` used to become a user turn silently.
    expect(() => anthropicRequestToOpenAi({
      ...base,
      messages: [{ role: 'system', content: 'be terse' }],
    })).toThrow(/messages\[0\]\.role/);
    expect(() => anthropicRequestToOpenAi({ ...base, max_tokens: 10.5, messages: [] }))
      .toThrow(/positive integer/);
  });

  it('refuses server-side tool types by name and tools without a schema', () => {
    const messages = [{ role: 'user', content: 'go' }];
    expect(() => anthropicRequestToOpenAi({
      model: 'm', max_tokens: 64, messages,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    })).toThrow(/web_search_20250305/);
    expect(() => anthropicRequestToOpenAi({
      model: 'm', max_tokens: 64, messages,
      tools: [{ name: 'Bash' }],
    })).toThrow(/input_schema/);
    // The explicit client-tool spelling is accepted like the implicit one.
    const out = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 64, messages,
      tools: [{ type: 'custom', name: 'Bash', input_schema: { type: 'object' } }],
    });
    expect((out.tools as unknown[]).length).toBe(1);
  });

  /**
   * A PDF wrapped in an `image_url` data URL — the tempting shortcut — is
   * rejected or mis-read by every OpenAI-schema provider; a 400 with a reason
   * is the honest answer. Plain text survives as text.
   */
  it('carries text documents as text and refuses binary ones', () => {
    const doc = (source: Record<string, unknown>) => anthropicRequestToOpenAi({
      model: 'm', max_tokens: 64,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'summarise' },
        { type: 'document', source },
      ] }],
    });
    const parts = (doc({ type: 'text', media_type: 'text/plain', data: 'hello' }).messages as Array<Record<string, unknown>>)[0]
      .content as Array<Record<string, unknown>>;
    expect(parts[1]).toEqual({ type: 'text', text: 'hello' });

    const decoded = (doc({ type: 'base64', media_type: 'text/plain', data: Buffer.from('plain').toString('base64') })
      .messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect(decoded[1]).toEqual({ type: 'text', text: 'plain' });

    expect(() => doc({ type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }))
      .toThrow(/application\/pdf/);
  });
});

describe('response translation', () => {
  it('splits text and tool calls into content blocks', () => {
    const out = openAiResponseToAnthropic({
      id: 'chatcmpl-abc123def456ghi789jkl',
      model: 'claude-sonnet-5',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: 'Running it.',
          tool_calls: [{ id: 'call_1', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }, 'claude-sonnet-5');

    expect(out.type).toBe('message');
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { cmd: 'ls' } },
    ]);
    expect(String(out.id)).toMatch(/^msg_/);
  });

  /**
   * chat-completions reports `prompt_tokens` INCLUSIVE of cache reads; Messages
   * reports `input_tokens` exclusive. Forwarding the number unchanged
   * over-reports every cached turn, and cached turns are most turns.
   */
  it('converts cache-inclusive prompt tokens to the exclusive convention', () => {
    const out = openAiResponseToAnthropic({
      choices: [{ finish_reason: 'stop', message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    }, 'm');
    expect(out.usage).toEqual({
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
    });
  });

  it('maps every finish reason to a Messages stop reason', () => {
    const stopFor = (finish: string) => openAiResponseToAnthropic(
      { choices: [{ finish_reason: finish, message: { content: '' } }] },
      'm',
    ).stop_reason;
    expect(stopFor('stop')).toBe('end_turn');
    expect(stopFor('length')).toBe('max_tokens');
    expect(stopFor('tool_calls')).toBe('tool_use');
    // An unknown reason must still be a legal Messages value.
    expect(stopFor('something_new')).toBe('end_turn');
  });

  it('does not throw on malformed tool arguments', () => {
    const out = openAiResponseToAnthropic({
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ id: 'c1', function: { name: 'X', arguments: '{not json' } }] },
      }],
    }, 'm');
    const block = (out.content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe('tool_use');
    expect(block.input).toEqual({ _raw: '{not json' });
  });
});

describe('stream translation', () => {
  it('brackets a text stream with the frames an SDK expects', async () => {
    const sse = await collect(openAiStreamToAnthropic(streamOf([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'));

    const events = frames(sse).map(([event]) => event);
    expect(events).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const parsed = frames(sse);
    const delta = parsed.find(([e]) => e === 'message_delta')?.[1];
    expect((delta?.delta as Record<string, unknown>).stop_reason).toBe('end_turn');
  });

  /**
   * Messages does not allow two content blocks open at once. When a tool call
   * starts mid-answer the text block has to be closed first, or an SDK receives
   * a delta for a block it believes is still the current one.
   */
  it('closes the text block before opening a tool_use block', async () => {
    const sse = await collect(openAiStreamToAnthropic(streamOf([
      'data: {"choices":[{"delta":{"content":"Let me check."}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Bash","arguments":"{\\"cmd\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'));

    const parsed = frames(sse);
    const events = parsed.map(([e]) => e);
    expect(events).toEqual([
      'message_start',
      'content_block_start',   // text, index 0
      'content_block_delta',
      'content_block_stop',    // text closed BEFORE the tool block opens
      'content_block_start',   // tool_use, index 1
      'content_block_delta',   // arguments arrive as fragments …
      'content_block_delta',   // … one frame per fragment
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const toolStart = parsed.filter(([e]) => e === 'content_block_start')[1][1];
    expect(toolStart.index).toBe(1);
    expect((toolStart.content_block as Record<string, unknown>).type).toBe('tool_use');
    expect((toolStart.content_block as Record<string, unknown>).name).toBe('Bash');

    // Arguments arrive as input_json_delta fragments, not as parsed JSON.
    const toolDelta = parsed.filter(([e]) => e === 'content_block_delta').at(-1)?.[1];
    expect((toolDelta?.delta as Record<string, unknown>).type).toBe('input_json_delta');
  });

  it('relays a mid-stream error and never emits message_stop after it', async () => {
    const sse = await collect(openAiStreamToAnthropic(streamOf([
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      'data: {"error":{"message":"upstream exploded","type":"server_error"}}\n\n',
    ]), 'm'));

    const events = frames(sse).map(([e]) => e);
    expect(events).toContain('error');
    // A message_stop here would make the SDK resolve the truncated message as a
    // successful one — the client would show half an answer and no error.
    expect(events).not.toContain('message_stop');
  });

  it('still produces a well-formed envelope for an empty completion', async () => {
    const sse = await collect(openAiStreamToAnthropic(streamOf(['data: [DONE]\n\n']), 'm'));
    const events = frames(sse).map(([e]) => e);
    expect(events).toEqual(['message_start', 'message_delta', 'message_stop']);
  });

  /**
   * chat-completions only emits its usage frame when asked. The request side
   * has to ask, or the frame below never exists in production and every
   * streamed turn reports 0 tokens — which is what a test that only hand-feeds
   * the frame would never notice.
   */
  it('asks upstream for the usage frame and reports full usage in message_delta', async () => {
    const streaming = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 5, stream: true, messages: [{ role: 'user', content: 'hi' }],
    });
    expect(streaming.stream_options).toEqual({ include_usage: true });
    const buffered = anthropicRequestToOpenAi({
      model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
    });
    expect(buffered.stream_options).toBeUndefined();

    const sse = await collect(openAiStreamToAnthropic(streamOf([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":42,"prompt_tokens_details":{"cached_tokens":400}}}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'));

    const parsed = frames(sse);
    const messageDelta = parsed.find(([e]) => e === 'message_delta')?.[1];
    // Input side too: the SDK's finalMessage() merges MessageDeltaUsage, so a
    // streamed turn ends up with the same numbers a buffered one reports.
    expect(messageDelta?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 42,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
    });
  });

  /**
   * Node's `Readable.fromWeb` cancels the TRANSLATED stream when the socket
   * closes. Unless that reaches the source, the provider request runs to
   * completion and is billed and logged as a normal success.
   */
  it('propagates cancel to the source stream without an unhandled rejection', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
        // …and then stays open, like a provider still generating.
      },
      cancel,
    });

    const reader = openAiStreamToAnthropic(source, 'm').getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel('client disconnected');
    // Let start()'s loop observe the cancellation and unwind.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cancel).toHaveBeenCalledWith('client disconnected');
    // A throw from the guarded enqueue/close in start() would surface here as
    // an unhandled rejection and fail the run.
  });

  /**
   * One open block at a time. Positional SDK accumulators survive nested
   * blocks; strict consumers do not.
   */
  it('closes the previous tool block before the next one opens, and before text resumes', async () => {
    const twoTools = frames(await collect(openAiStreamToAnthropic(streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"A","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"B","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'))).map(([e, p]) => `${e}${typeof p.index === 'number' ? `:${p.index}` : ''}`);
    expect(twoTools).toEqual([
      'message_start',
      'content_block_start:0', 'content_block_delta:0', 'content_block_stop:0',
      'content_block_start:1', 'content_block_delta:1', 'content_block_stop:1',
      'message_delta', 'message_stop',
    ]);

    const toolThenText = frames(await collect(openAiStreamToAnthropic(streamOf([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"A","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'))).map(([e, p]) => `${e}${typeof p.index === 'number' ? `:${p.index}` : ''}`);
    expect(toolThenText).toEqual([
      'message_start',
      'content_block_start:0', 'content_block_delta:0', 'content_block_stop:0',
      'content_block_start:1', 'content_block_delta:1', 'content_block_stop:1',
      'message_delta', 'message_stop',
    ]);
  });

  it("maps upstream error types onto Anthropic's vocabulary", async () => {
    // `server_error` is OpenAI's word; a strict Messages client rejects it.
    expect(anthropicErrorTypeForUpstream({ type: 'server_error' })).toBe('api_error');
    expect(anthropicErrorTypeForUpstream({ type: 'rate_limit_error' })).toBe('rate_limit_error');
    expect(anthropicErrorTypeForUpstream({ type: 'requests', code: 'rate_limit_exceeded' })).toBe('rate_limit_error');
    expect(anthropicErrorTypeForUpstream({ status: 529 })).toBe('overloaded_error');
    expect(anthropicErrorTypeForUpstream({ status: 503 })).toBe('overloaded_error');
    expect(anthropicErrorTypeForUpstream({ status: 429 })).toBe('rate_limit_error');
    expect(anthropicErrorTypeForUpstream({ status: 400 })).toBe('invalid_request_error');

    const sse = await collect(openAiStreamToAnthropic(streamOf([
      'data: {"error":{"message":"boom","type":"server_error"}}\n\n',
    ]), 'm'));
    const err = frames(sse).find(([e]) => e === 'error')?.[1];
    expect((err?.error as Record<string, unknown>).type).toBe('api_error');
  });
});
