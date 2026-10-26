/**
 * Unit tests - OpenAI Adapter
 *
 * The OpenAI Chat Completions wire <-> the gateway's native types: request
 * translation (messages, tools, tool choice, response format), the native answer
 * rendered as `chat.completion`, and the stream framer that turns native steps
 * into `chat.completion.chunk`s. Pure functions, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  OpenAiStreamFramer,
  buildErrorResponse,
  newCompletionId,
  normalizeArgumentsString,
  nativeMessagesToOpenAi,
  nativeRequestToWire,
  openAiBodyToNative,
  openAiMessagesToNative,
  openAiResponseToNative,
  openAiToolChoiceToNative,
  openAiToolsToNative,
  openAIStreamDeltaChunk,
  openAIStreamRoleChunk,
  openAIStreamStopChunk,
  openAIStreamUsageChunk,
  toOpenAIChatResponse,
  toOpenAiToolCalls,
  wireToolCallsToNative,
} from '@/lib/services/models/openaiAdapter';

// ── openAiMessagesToNative ────────────────────────────────────────────────────

describe('openAiMessagesToNative', () => {
  it('converts system, user and assistant roles', () => {
    expect(openAiMessagesToNative([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('treats the developer role as a system message', () => {
    expect(openAiMessagesToNative([{ role: 'developer', content: 'rules' }])).toEqual([
      { role: 'system', content: 'rules' },
    ]);
  });

  it('flattens system text parts into one string', () => {
    expect(openAiMessagesToNative([
      { role: 'system', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
    ])).toEqual([{ role: 'system', content: 'one\ntwo' }]);
  });

  it('converts a tool message with its tool_call_id', () => {
    expect(openAiMessagesToNative([
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call_1' },
    ])).toEqual([{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' }]);
  });

  it('falls back to the tool name, then a placeholder, for a tool message without an id', () => {
    const [named, anonymous] = openAiMessagesToNative([
      { role: 'tool', content: 'x', name: 'lookup' },
      { role: 'tool', content: 'y' },
    ]);
    expect(named).toMatchObject({ toolCallId: 'lookup', name: 'lookup' });
    expect(anonymous).toMatchObject({ toolCallId: 'tool-call' });
  });

  it('maps the legacy function role onto a tool message', () => {
    expect(openAiMessagesToNative([{ role: 'function', name: 'calc', content: '4' }])).toEqual([
      { role: 'tool', content: '4', toolCallId: 'calc', name: 'calc' },
    ]);
  });

  it('serialises non-string tool content', () => {
    const [message] = openAiMessagesToNative([
      { role: 'tool', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], tool_call_id: 'c' },
    ]);
    expect(message.content).toBe('a\nb');
  });

  it('handles an empty messages array and preserves order', () => {
    expect(openAiMessagesToNative([])).toEqual([]);
    const out = openAiMessagesToNative([
      { role: 'system', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('falls through an unknown role to a user message', () => {
    // @ts-expect-error - testing unknown role
    expect(openAiMessagesToNative([{ role: 'unknown', content: 'x' }])[0].role).toBe('user');
  });

  it('keeps assistant tool calls, with string arguments, on the message', () => {
    const [message] = openAiMessagesToNative([{
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: { q: 'x' } } }],
    }]);
    expect(message).toEqual({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":"x"}' }],
    });
  });

  it('rejects an assistant tool call without a name', () => {
    expect(() => openAiMessagesToNative([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: {} }] },
    ])).toThrow('Invalid tool call at index 0: missing function name');
  });

  it('wraps string image URLs and keeps http(s) images as URL sources', () => {
    const [message] = openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: 'https://cdn.example.com/a.png' },
      ],
    }]);
    expect(message.content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/a.png' } },
    ]);
  });

  it('turns a data URL into a base64 source with its media type', () => {
    const [message] = openAiMessagesToNative([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } }],
    }]);
    expect(message.content).toEqual([
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } },
    ]);
  });

  it('preserves the detail option on object image URLs, and the order of several images', () => {
    const first = 'https://cdn.example.com/first.png';
    const second = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const [message] = openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'text', text: 'Compare these images' },
        { type: 'image_url', image_url: first },
        { type: 'image_url', image_url: { url: second, detail: 'low' } },
        { type: 'image_url', image_url: { url: first, detail: 'bogus' } },
      ],
    }]);
    const parts = message.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'image', 'image']);
    expect(parts[1].detail).toBeUndefined();
    expect(parts[2].detail).toBe('low');
    expect(parts[3].detail).toBeUndefined();
  });

  it('rejects malformed image URLs before calling a provider', () => {
    expect(() => openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { detail: 'high' } },
      ],
    }])).toThrow('`messages[0].content[1].image_url` must be');
  });

  it.each([
    '',
    '   ',
    { url: '' },
    { url: '   ' },
  ])('rejects an empty image URL: %j', (imageUrl) => {
    expect(() => openAiMessagesToNative([{
      role: 'user',
      content: [{ type: 'image_url', image_url: imageUrl }],
    }])).toThrow('`messages[0].content[0].image_url` must be');
  });

  it('maps input_audio and file parts onto native audio / file parts', () => {
    const [message] = openAiMessagesToNative([{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
        { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'a.pdf' } },
        { type: 'file', file: { file_id: 'file-abc' } },
      ],
    }]);
    expect(message.content).toEqual([
      { type: 'audio', source: { type: 'base64', mediaType: 'audio/wav', data: 'UklGRg==' } },
      { type: 'file', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' }, fileName: 'a.pdf' },
      // A reference to a file the upstream holds is not degraded to a text note: it is kept (under a private
      // type the SDK passes through) and leaves the process, and the wire view, as the caller wrote it.
      { type: 'gateway_file_ref', file: { file_id: 'file-abc' } },
    ]);
    expect(nativeMessagesToOpenAi([message])[0].content).toEqual([
      expect.objectContaining({ type: 'input_audio' }),
      expect.objectContaining({ type: 'file' }),
      { type: 'file', file: { file_id: 'file-abc' } },
    ]);
  });

  it('keeps an unknown content part as the caller wrote it, for forward compatibility', () => {
    const future = { type: 'input_video', input_video: { url: 'https://x/y.mp4' } };
    const [message] = openAiMessagesToNative([{ role: 'user', content: [future] }]);
    expect(message.content).toEqual([future]);
  });
});

// ── native -> OpenAI (the wire view of an in-process call) ───────────────────

describe('native request -> wire view', () => {
  it('round-trips a conversation with tool calls, images and a tool result', () => {
    const wire = nativeMessagesToOpenAi([
      { role: 'system', content: 'be brief' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
        ],
      },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{"q":1}' }] },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ]);
    expect(wire).toEqual([
      { role: 'system', content: 'be brief' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ]);
  });

  it('describes tools, tool choice, response format and sampling in OpenAI names', () => {
    const wire = nativeRequestToWire({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'find', parameters: { type: 'object' }, strict: true }],
      toolChoice: { name: 'lookup' },
      responseFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' } },
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 100,
      stop: ['END'],
      seed: 3,
      parallelToolCalls: false,
    }, { streamUsage: true });
    expect(wire).toMatchObject({
      tools: [{ type: 'function', function: { name: 'lookup', description: 'find', strict: true } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      stop: ['END'],
      seed: 3,
      parallel_tool_calls: false,
      stream_options: { include_usage: true },
    });
  });
});

describe('openAiBodyToNative', () => {
  it('translates the known fields and leaves the rest to the wire view', () => {
    const request = openAiBodyToNative({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 64,
      max_completion_tokens: 128,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 9,
      stop: 'DONE',
      parallel_tool_calls: true,
      tool_choice: 'required',
      response_format: { type: 'json_object' },
      request_id: 'req-1',
      logit_bias: { 1: 2 },
    });
    expect(request).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: 'required',
      responseFormat: { type: 'json_object' },
      temperature: 0.5,
      topP: 0.8,
      maxTokens: 64,
      maxCompletionTokens: 128,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      seed: 9,
      stop: ['DONE'],
      parallelToolCalls: true,
      requestId: 'req-1',
    });
  });
});

describe('tools and tool choice', () => {
  const tool = {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'find',
      parameters: { type: 'object', properties: { f: { type: 'array', items: { type: 'object', properties: { k: { type: 'string' } } } } } },
    },
  };

  it('keeps only function tools natively', () => {
    expect(openAiToolsToNative([tool, { type: 'web_search_preview' }])?.map((t) => t.name)).toEqual(['lookup']);
    expect(openAiToolsToNative(undefined)).toBeUndefined();
  });

  it('closes every object schema when a tool is strict (request-wide or per tool)', () => {
    const viaRequest = openAiToolsToNative([tool], true)![0];
    expect(viaRequest.strict).toBe(true);
    expect(viaRequest.parameters).toMatchObject({
      additionalProperties: false,
      properties: { f: { items: { additionalProperties: false } } },
    });

    const viaTool = openAiToolsToNative([{ ...tool, function: { ...tool.function, strict: true } }])![0];
    expect(viaTool.parameters).toMatchObject({ additionalProperties: false });

    const lax = openAiToolsToNative([tool])![0];
    expect(lax.strict).toBeUndefined();
    expect(lax.parameters).not.toHaveProperty('additionalProperties');
  });

  it.each([
    ['auto', 'auto'],
    ['none', 'none'],
    ['required', 'required'],
    [{ type: 'function', function: { name: 'lookup' } }, { name: 'lookup' }],
    [{ name: 'lookup' }, { name: 'lookup' }],
    [{ type: 'weird' }, undefined],
    [undefined, undefined],
  ])('maps tool_choice %j', (input, expected) => {
    expect(openAiToolChoiceToNative(input)).toEqual(expected);
  });
});

// ── toOpenAIChatResponse ──────────────────────────────────────────────────────

const answer = (over: Record<string, unknown> = {}) => ({
  content: 'ok' as string | null,
  toolCalls: [],
  ...over,
});

describe('toOpenAIChatResponse', () => {
  const base = {
    model: 'gpt-4o',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    wireFinishReason: 'stop',
  };

  it('returns a valid OpenAI chat completion shape', () => {
    const result = toOpenAIChatResponse(answer({ content: 'Hello' }), base) as any;
    expect(result.object).toBe('chat.completion');
    expect(result.model).toBe('gpt-4o');
    expect(result.id).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
    expect(result.choices[0]).toMatchObject({
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: 'Hello', refusal: null, annotations: [] },
      logprobs: null,
    });
    expect(typeof result.created).toBe('number');
  });

  it('includes usage with numeric token counts', () => {
    const result = toOpenAIChatResponse(answer(), base) as any;
    expect(result.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 20,
      cached_tokens: 0,
      total_tokens: 30,
    });
  });

  it('shows reasoning as a subset of completion tokens and the cached part of the prompt', () => {
    const result = toOpenAIChatResponse(answer({ content: '' }), {
      ...base,
      usage: { inputTokens: 932, outputTokens: 512, totalTokens: 1444, cachedInputTokens: 100, reasoningTokens: 512 },
      wireFinishReason: 'length',
    }) as any;
    expect(result.usage).toMatchObject({
      prompt_tokens: 932,
      completion_tokens: 512,
      total_tokens: 1444,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 512 },
    });
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('sets usage counts to 0 when the upstream reported none', () => {
    const result = toOpenAIChatResponse(answer(), { ...base, usage: {} }) as any;
    expect(result.usage.prompt_tokens).toBe(0);
    expect(result.usage.completion_tokens).toBe(0);
  });

  it('sets content to null for empty content', () => {
    expect((toOpenAIChatResponse(answer({ content: '' }), base) as any).choices[0].message.content).toBeNull();
    expect((toOpenAIChatResponse(answer({ content: null }), base) as any).choices[0].message.content).toBeNull();
  });

  it('includes system_fingerprint: the upstream\'s own when it sent one, a stable derived one otherwise', () => {
    const derived = toOpenAIChatResponse(answer(), base) as any;
    expect(derived.system_fingerprint).toMatch(/^fp_[0-9a-f]{24}$/);
    expect((toOpenAIChatResponse(answer(), base) as any).system_fingerprint).toBe(derived.system_fingerprint);
    const own = toOpenAIChatResponse(answer({ providerFields: { system_fingerprint: 'fp_up' } }), base) as any;
    expect(own.system_fingerprint).toBe('fp_up');
  });

  it('carries the provider fields the native shape kept: refusal, annotations, logprobs, service tier', () => {
    const result = toOpenAIChatResponse(answer({
      providerFields: {
        refusal: 'no',
        annotations: [{ type: 'url_citation' }],
        logprobs: { content: [] },
        service_tier: 'default',
      },
    }), base) as any;
    expect(result.choices[0].message).toMatchObject({ refusal: 'no', annotations: [{ type: 'url_citation' }] });
    expect(result.choices[0].logprobs).toEqual({ content: [] });
    expect(result.service_tier).toBe('default');
  });

  it('each call produces a unique id unless one is supplied', () => {
    expect((toOpenAIChatResponse(answer(), base) as any).id).not.toBe((toOpenAIChatResponse(answer(), base) as any).id);
    expect((toOpenAIChatResponse(answer(), { ...base, completionId: 'chatcmpl-x' }) as any).id).toBe('chatcmpl-x');
  });

  it('surfaces the reasoning summary as reasoning_content, and the text of signed blocks when there is no summary', () => {
    const summary = toOpenAIChatResponse(answer({ reasoning: { summary: 'Thought carefully.' } }), base) as any;
    expect(summary.choices[0].message.reasoning_content).toBe('Thought carefully.');

    const blocks = toOpenAIChatResponse(answer({
      reasoning: { blocks: [{ type: 'thinking', text: 'step one ', signature: 'sig' }, { type: 'redacted_thinking', data: 'x' }, { type: 'thinking', text: 'step two' }] },
    }), base) as any;
    expect(blocks.choices[0].message.reasoning_content).toBe('step one step two');
  });

  it('omits reasoning_content when the model did not reason, or when it is hidden', () => {
    expect('reasoning_content' in (toOpenAIChatResponse(answer(), base) as any).choices[0].message).toBe(false);
    const hidden = toOpenAIChatResponse(answer({ reasoning: { summary: 'secret' } }), { ...base, includeReasoning: false }) as any;
    expect('reasoning_content' in hidden.choices[0].message).toBe(false);
  });

  it('carries guardrail annotations', () => {
    const result = toOpenAIChatResponse(answer(), {
      ...base,
      guardrails: { input: { guardrail_key: 'g', findings: [] } },
    }) as any;
    expect(result.guardrails).toEqual({ input: { guardrail_key: 'g', findings: [] } });
  });

  it('keeps the finish_reason it is given: the upstream\'s own word, not a collapsed enum', () => {
    expect((toOpenAIChatResponse(answer(), { ...base, wireFinishReason: 'function_call' }) as any).choices[0].finish_reason)
      .toBe('function_call');
  });
});

// ── the stream framer ─────────────────────────────────────────────────────────

describe('OpenAiStreamFramer', () => {
  const toolCallsOf = (frame: unknown): any[] => (frame as any).choices[0].delta.tool_calls;
  const options = { model: 'gpt-5', completionId: 'chatcmpl_stable', created: 1234567890 };

  it('opens with the assistant role and keeps the completion id and creation time on every frame', () => {
    const framer = new OpenAiStreamFramer(options);
    const role = openAIStreamRoleChunk(options);
    const first = framer.delta({ type: 'delta', content: 'one' })!;
    const second = framer.delta({ type: 'delta', content: 'two' })!;
    expect(role.choices[0].delta).toMatchObject({ role: 'assistant' });
    expect(role.choices[0].finish_reason).toBeNull();
    expect([role.id, first.id, second.id]).toEqual(['chatcmpl_stable', 'chatcmpl_stable', 'chatcmpl_stable']);
    expect(first.created).toBe(1234567890);
    expect(first.object).toBe('chat.completion.chunk');
  });

  it('finish_reason is null for mid-stream frames and the raw value on the terminal one', () => {
    const framer = new OpenAiStreamFramer(options);
    expect(framer.delta({ type: 'delta', content: 'hi' })!.choices[0].finish_reason).toBeNull();
    expect(framer.delta({ type: 'delta', finishReason: 'tool_calls' })!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('a step that carries nothing is no frame at all', () => {
    const framer = new OpenAiStreamFramer(options);
    expect(framer.delta({ type: 'delta' })).toBeNull();
    expect(framer.delta({ type: 'delta', content: '' })).toBeNull();
  });

  it('opens a tool call with index + id + type + name, and continues it with index + arguments only', () => {
    const framer = new OpenAiStreamFramer(options);
    // The SDK repeats the id and name on every fragment.
    const first = framer.delta({
      type: 'delta',
      toolCalls: [{ id: 'call_weather', name: 'get_weather', arguments: '{"city":', index: 0 }],
    })!;
    const second = framer.delta({
      type: 'delta',
      toolCalls: [{ id: 'call_weather', name: 'get_weather', arguments: '"Ankara"}', index: 0 }],
    })!;
    expect(first.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_weather',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":' },
    }]);
    expect(second.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      function: { arguments: '"Ankara"}' },
    }]);
  });

  it('keeps parallel tool calls apart by index, however their fragments interleave', () => {
    const framer = new OpenAiStreamFramer(options);
    const frames = [
      { id: 'a', name: 'one', arguments: '', index: 0 },
      { id: 'b', name: 'two', arguments: '', index: 1 },
      { id: 'a', name: 'one', arguments: '{"x":1}', index: 0 },
      { id: 'b', name: 'two', arguments: '{"y":2}', index: 1 },
    ].map((partial) => toolCallsOf(framer.delta({ type: 'delta', toolCalls: [partial] }))[0]);
    expect(frames).toEqual([
      { index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '' } },
      { index: 0, function: { arguments: '{"x":1}' } },
      { index: 1, function: { arguments: '{"y":2}' } },
    ]);
    expect(framer.hasToolCalls).toBe(true);
  });

  it('numbers the calls of a provider that sends no index, by id', () => {
    const framer = new OpenAiStreamFramer(options);
    const out = [
      { id: 'a', name: 'one', arguments: '{' },
      { id: 'a', name: 'one', arguments: '}' },
      { id: 'b', name: 'two', arguments: '{}' },
    ].map((partial) => toolCallsOf(framer.delta({ type: 'delta', toolCalls: [partial] }))[0]);
    expect(out.map((call) => call.index)).toEqual([0, 0, 1]);
    expect(out[1]).toEqual({ index: 0, function: { arguments: '}' } });
  });

  it('mints an id for a call the provider never named', () => {
    const framer = new OpenAiStreamFramer(options);
    const [call] = toolCallsOf(framer.delta({ type: 'delta', toolCalls: [{ name: 'one', arguments: '{}', index: 0 }] }));
    expect(call.id).toMatch(/^call_0_/);
  });

  it('shows reasoning text as reasoning_content, and hides it when the caller must not see it', () => {
    const shown = new OpenAiStreamFramer(options).delta({ type: 'delta', reasoning: 'Let me think...' })!;
    expect(shown.choices[0].delta.reasoning_content).toBe('Let me think...');
    const hidden = new OpenAiStreamFramer({ ...options, includeReasoning: false });
    expect(hidden.delta({ type: 'delta', reasoning: 'Let me think...' })).toBeNull();
    expect(hidden.delta({ type: 'delta', reasoning: 'x', content: 'answer' })!.choices[0].delta)
      .toEqual({ content: 'answer' });
  });

  it('builds the terminal, delta and usage frames', () => {
    expect(openAIStreamStopChunk(options).choices[0].finish_reason).toBe('stop');
    expect(openAIStreamStopChunk(options, 'content_filter').choices[0].finish_reason).toBe('content_filter');
    expect(openAIStreamDeltaChunk(options, { content: 'x' }).choices[0].delta).toEqual({ content: 'x' });
    const usage = openAIStreamUsageChunk(options, { prompt_tokens: 1 });
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({ prompt_tokens: 1 });
  });

  it('reads the wire tool deltas the stream gate hands back as native partials', () => {
    expect(wireToolCallsToNative([
      { index: 1, id: 'c', type: 'function', function: { name: 'f', arguments: '{' } },
      { index: 1, function: { arguments: '}' } },
    ])).toEqual([
      { index: 1, id: 'c', name: 'f', arguments: '{' },
      { index: 1, arguments: '}' },
    ]);
    expect(wireToolCallsToNative(undefined)).toBeUndefined();
  });
});

// ── tool calls with unparseable arguments ─────────────────────────────────────

describe('tool calls with unparseable arguments', () => {
  // Observed with qwen3-coder over Bedrock's /openai/v1: a tool that takes no
  // parameters comes back with `arguments: "{"`. Every strict client then fails
  // to parse the call and an agent loop stalls.
  it('repairs the lone-brace and empty shapes to an empty object', () => {
    expect(normalizeArgumentsString('{')).toBe('{}');
    expect(normalizeArgumentsString(' { ')).toBe('{}');
    expect(normalizeArgumentsString('')).toBe('{}');
    expect(normalizeArgumentsString('   ')).toBe('{}');
  });

  it('keeps a call whose arguments do not parse instead of dropping it', () => {
    const [call] = toOpenAiToolCalls([{ id: 'c1', name: 'get_time', arguments: '{' }])!;
    expect(call).toEqual({ id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } });
  });

  it('never invents arguments for a genuinely truncated call', () => {
    const [call] = toOpenAiToolCalls([{ id: 'c1', name: 'lookup', arguments: '{"city":"Ank' }])!;
    expect(call.function.arguments).toBe('{"city":"Ank');
  });

  it('leaves well-formed arguments byte-for-byte alone', () => {
    const raw = '{ "city" : "Ankara",\n "n": 1 }';
    expect(normalizeArgumentsString(raw)).toBe(raw);
  });

  it('mints an id and a name for a call that has neither', () => {
    const [call] = toOpenAiToolCalls([{ arguments: '{}' }])!;
    expect(call.id).toMatch(/^call_0_/);
    expect(call.function.name).toBe('tool_call');
    expect(toOpenAiToolCalls([])).toBeUndefined();
  });

  it('puts the repaired calls on a full response', () => {
    const result = toOpenAIChatResponse(
      { content: null, toolCalls: [{ id: 'c1', name: 'get_time', arguments: '{' }] },
      { model: 'm', usage: {}, wireFinishReason: 'tool_calls' },
    ) as any;
    expect(result.choices[0].message.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } },
    ]);
    expect(result.choices[0].message.content).toBeNull();
  });
});

// ── a stored response, back to native ─────────────────────────────────────────

describe('openAiResponseToNative', () => {
  it('reads a stored OpenAI response (a semantic-cache hit) as a native answer', () => {
    const native = openAiResponseToNative({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'text',
          reasoning_content: 'why',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 2, completion_tokens_details: { reasoning_tokens: 3 } },
      guardrails: { output: { guardrail_key: 'g', findings: [] } },
    });
    expect(native.response).toMatchObject({
      content: 'text',
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }],
      reasoning: { summary: 'why' },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 2, reasoningTokens: 3 },
    });
    expect(native.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 3 });
    expect(native.wireFinishReason).toBe('tool_calls');
    expect(native.guardrails).toEqual({ output: { guardrail_key: 'g', findings: [] } });
  });

  it('keeps the cache-write slice of a stored response instead of zeroing it', () => {
    const native = openAiResponseToNative({
      id: 'chatcmpl-2',
      model: 'gpt-4o',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'text' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 30 },
      },
    });
    expect(native.response.usage).toMatchObject({ cachedInputTokens: 40, cachedWriteTokens: 30 });
  });
});

describe('newCompletionId', () => {
  it('is OpenAI shaped: chatcmpl- plus an opaque token', () => {
    expect(newCompletionId()).toMatch(/^chatcmpl-[0-9a-f]{32}$/);
  });
});

// ── buildErrorResponse ────────────────────────────────────────────────────────

describe('buildErrorResponse', () => {
  it('defaults to status 400', () => {
    const result = buildErrorResponse('bad request');
    expect(result.status).toBe(400);
    expect(result.error.message).toBe('bad request');
    expect(result.error.type).toBe('invalid_request_error');
  });

  it('accepts a custom status code', () => {
    expect(buildErrorResponse('nope', 422).status).toBe(422);
  });
});
