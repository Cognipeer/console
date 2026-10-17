/**
 * The Responses ⇄ chat-completions translators (§5.3, model target) and the
 * Responses event encoder every stream uses.
 */

import { describe, expect, it } from 'vitest';
import {
  ResponsesRequestError,
  chatCompletionToResponse,
  chatStreamToResponses,
  createResponsesEventEncoder,
  newModelResponseId,
  responsesRequestToChat,
} from '@/lib/services/models/responsesWire';

type Frame = { event: string; data: Record<string, unknown> };

const parseFrames = (text: string): Frame[] => text.split('\n\n').filter((chunk) => chunk.startsWith('event: ')).map((chunk) => {
  const [eventLine, dataLine] = chunk.split('\n');
  return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> };
});

const sseSource = (payloads: unknown[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text();

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta, finish_reason: finish }],
});

const refusal = (fn: () => unknown): ResponsesRequestError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ResponsesRequestError) return error;
    throw error;
  }
  throw new Error('expected a ResponsesRequestError');
};

describe('responsesRequestToChat', () => {
  it('maps the supported fields: instructions, input, text.format, tools, tool_choice, sampling, max_output_tokens, reasoning', () => {
    const chat = responsesRequestToChat({
      model: 'gpt-x',
      instructions: 'Be brief.',
      input: 'hello',
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object', properties: { a: { type: 'string' } } }, strict: true } },
      tools: [{ type: 'function', name: 'lookup', description: 'Looks up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      tool_choice: { type: 'function', name: 'lookup' },
      temperature: 0.2,
      top_p: 0.9,
      max_output_tokens: 300,
      reasoning: { effort: 'low' },
      metadata: { ticket: 'OPS-1' },
      store: true,
      stream: true,
    });
    expect(chat).toEqual({
      model: 'gpt-x',
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', properties: { a: { type: 'string' } } }, strict: true } },
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Looks up', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 300,
      reasoning_effort: 'low',
    });
    // metadata is echoed on the response, never sent upstream; store is ignored
    expect(chat).not.toHaveProperty('metadata');
    expect(chat).not.toHaveProperty('store');
    expect(responsesRequestToChat({ model: 'm', input: 'x', text: { format: { type: 'json_object' } } }).response_format).toEqual({ type: 'json_object' });
    expect(responsesRequestToChat({ model: 'm', input: 'x', text: { format: { type: 'text' } } })).not.toHaveProperty('response_format');
  });

  it('turns function_call / function_call_output items into assistant tool_calls and tool messages, in order', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: [
        { role: 'developer', content: 'rules' },
        { role: 'user', content: [{ type: 'input_text', text: 'weather in Paris and Rome?' }, { type: 'input_image', image_url: 'https://example.com/map.png', detail: 'low' }] },
        { type: 'reasoning', id: 'rs_1', summary: [] },
        { type: 'function_call', call_id: 'call_a', name: 'weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call', call_id: 'call_b', name: 'weather', arguments: '{"city":"Rome"}' },
        { type: 'function_call_output', call_id: 'call_a', output: '18C' },
        { type: 'function_call_output', call_id: 'call_b', output: [{ type: 'input_text', text: '21C' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Paris 18C, Rome 21C.' }] },
        { role: 'user', content: 'thanks' },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: [{ type: 'text', text: 'weather in Paris and Rome?' }, { type: 'image_url', image_url: { url: 'https://example.com/map.png', detail: 'low' } }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_b', type: 'function', function: { name: 'weather', arguments: '{"city":"Rome"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '18C' },
      { role: 'tool', tool_call_id: 'call_b', content: '21C' },
      { role: 'assistant', content: 'Paris 18C, Rome 21C.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('refuses what a model target does not take with 400s naming the parameter', () => {
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: 'x', previous_response_id: 'resp_1' }))).toMatchObject({ status: 400, code: 'unsupported_parameter', param: 'previous_response_id' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: 'x', conversation: 'conv_1' }))).toMatchObject({ code: 'unsupported_parameter', param: 'conversation' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: 'x', background: true }))).toMatchObject({ code: 'unsupported_parameter', param: 'background' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: 'x', tools: [{ type: 'web_search' }] }))).toMatchObject({ code: 'unsupported_parameter', param: 'tools' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: 'x', tool_choice: { type: 'file_search' } }))).toMatchObject({ code: 'unsupported_parameter', param: 'tool_choice' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'f1' }] }] })))
      .toMatchObject({ code: 'unsupported_content_part', param: 'input' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] })))
      .toMatchObject({ code: 'unsupported_content_part' });
    expect(refusal(() => responsesRequestToChat({ model: 'm', input: [{ type: 'item_reference', id: 'msg_1' }] }))).toMatchObject({ code: 'unsupported_parameter', param: 'input' });
    expect(refusal(() => responsesRequestToChat({ model: 'm' }))).toMatchObject({ code: 'missing_input' });
    // background: false and store are fine
    expect(() => responsesRequestToChat({ model: 'm', input: 'x', background: false, store: false })).not.toThrow();
  });
});

describe('chatCompletionToResponse', () => {
  const context = { id: 'resp_abc', createdAt: 1_760_000_000 };

  it('a text answer: message item, output_text, usage, the request echoed', () => {
    const response = chatCompletionToResponse({
      id: 'chatcmpl-1',
      model: 'gpt-x-2026',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!', reasoning_content: 'greet' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } },
    }, { model: 'gpt-x', input: 'hi', metadata: { a: '1' }, service_tier: 'flex', temperature: 0.5 }, context);
    expect(response).toMatchObject({
      id: 'resp_abc',
      object: 'response',
      created_at: 1_760_000_000,
      status: 'completed',
      model: 'gpt-x',
      output_text: 'Hello!',
      metadata: { a: '1' },
      service_tier: 'flex',
      temperature: 0.5,
      store: false,
      previous_response_id: null,
      error: null,
      incomplete_details: null,
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 14 },
    });
    expect(response.output).toEqual([
      { id: 'rs_resp_abc_0', type: 'reasoning', summary: [{ type: 'summary_text', text: 'greet' }] },
      { id: 'msg_resp_abc_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello!', annotations: [] }] },
    ]);
  });

  it('tool calls become function_call items; a length stop is incomplete (max_output_tokens)', () => {
    const response = chatCompletionToResponse({
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        finish_reason: 'tool_calls',
      }],
    }, { model: 'gpt-x', input: 'hi' }, context);
    expect(response.status).toBe('completed');
    expect(response.output).toEqual([{ id: 'fc_resp_abc_0', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }]);

    const cut = chatCompletionToResponse({ choices: [{ index: 0, message: { content: 'Hel' }, finish_reason: 'length' }] }, { model: 'gpt-x' }, context);
    expect(cut).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_text: 'Hel' });
  });

  it('model response ids are fresh and resp_-prefixed', () => {
    const a = newModelResponseId();
    expect(a).toMatch(/^resp_[0-9a-f]{32}$/);
    expect(newModelResponseId()).not.toBe(a);
  });
});

describe('chatStreamToResponses', () => {
  const context = { id: 'resp_s', createdAt: 1_760_000_000 };

  it('text and reasoning: the full event sequence, sequence numbers from 0, the full object on response.completed', async () => {
    const out = await readAll(chatStreamToResponses(sseSource([
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: 'think' }),
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({}, 'stop'),
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ]), { model: 'gpt-x', input: 'hi', metadata: { a: '1' } }, context));
    const frames = parseFrames(out);
    expect(frames.map((f) => f.event)).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta',
      'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta',
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.completed',
    ]);
    expect(frames.map((f) => f.data.sequence_number)).toEqual(frames.map((_, i) => i));
    expect(frames.every((f) => f.data.type === f.event)).toBe(true);
    expect(frames[0].data.response).toMatchObject({ id: 'resp_s', status: 'in_progress', output: [] });
    expect(frames[12].data).toMatchObject({ text: 'Hello', output_index: 1 });
    expect(frames[15].data.response).toMatchObject({
      id: 'resp_s',
      status: 'completed',
      output_text: 'Hello',
      metadata: { a: '1' },
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] },
      ],
    });
  });

  it('tool call fragments: a function_call item with argument deltas, closed before the final object', async () => {
    const out = await readAll(chatStreamToResponses(sseSource([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
      chunk({}, 'tool_calls'),
    ]), { model: 'gpt-x', input: 'hi' }, context));
    const frames = parseFrames(out);
    expect(frames.map((f) => f.event)).toEqual([
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta',
      'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed',
    ]);
    expect(frames[2].data.item).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' });
    expect(frames[5].data).toMatchObject({ name: 'lookup', arguments: '{"q":"x"}' });
    expect((frames[7].data.response as { output: unknown[] }).output).toEqual([
      { id: 'fc_resp_s_0', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
    ]);
  });

  it('an upstream error frame: an error event, then response.failed with what was produced', async () => {
    const out = await readAll(chatStreamToResponses(sseSource([
      chunk({ content: 'Par' }),
      { error: { message: 'Provider overloaded', type: 'server_error', code: 'upstream_overloaded' } },
      chunk({ content: 'never' }),
    ]), { model: 'gpt-x', input: 'hi' }, context));
    const frames = parseFrames(out);
    expect(frames.map((f) => f.event).slice(-5)).toEqual([
      'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'error', 'response.failed',
    ]);
    expect(frames.at(-2)!.data).toMatchObject({ code: 'upstream_overloaded', message: 'Provider overloaded' });
    expect(frames.at(-1)!.data.response).toMatchObject({ status: 'failed', error: { code: 'upstream_overloaded' }, output_text: 'Par' });
    expect(out).not.toContain('never');
  });

  it('a length stop closes with response.incomplete', async () => {
    const frames = parseFrames(await readAll(chatStreamToResponses(sseSource([chunk({ content: 'a' }), chunk({}, 'length')]), { model: 'm' }, context)));
    expect(frames.at(-1)).toMatchObject({ event: 'response.incomplete', data: { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } } });
  });

  it('cancelling the translated stream cancels the source (the provider call stops)', async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel() { cancelled = true; } });
    const translated = chatStreamToResponses(source, { model: 'm' }, context);
    const reader = translated.getReader();
    await reader.read();
    await reader.cancel('client gone');
    expect(cancelled).toBe(true);
  });
});

describe('createResponsesEventEncoder', () => {
  it('a still-running object (a replayed active run) ends without a terminal event', () => {
    const frames: string[] = [];
    const events = createResponsesEventEncoder((frame) => frames.push(frame));
    events.started({ id: 'resp_1', status: 'in_progress' });
    events.finish({ id: 'resp_1', status: 'in_progress' });
    expect(parseFrames(frames.join('')).map((f) => f.event)).toEqual(['response.created', 'response.in_progress', 'response.in_progress']);
  });

  it('cancelled closes with response.incomplete; an error is an error event, then response.failed when the object is known', () => {
    const frames: string[] = [];
    const events = createResponsesEventEncoder((frame) => frames.push(frame));
    events.started({ id: 'resp_1' });
    events.finish({ id: 'resp_1', status: 'cancelled' });
    events.error({ message: 'boom', code: 'agent_error' }, { id: 'resp_1', status: 'failed' });
    expect(parseFrames(frames.join('')).map((f) => f.event)).toEqual(['response.created', 'response.in_progress', 'response.incomplete', 'error', 'response.failed']);
  });
});
