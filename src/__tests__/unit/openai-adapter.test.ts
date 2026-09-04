/**
 * Unit tests — OpenAI Adapter
 *
 * toLangChainMessages, toOpenAIChatResponse, toOpenAIStreamChunk,
 * summarizeUsage, buildErrorResponse — tümü saf fonksiyon, dış bağımlılık yok.
 */

import { describe, it, expect } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import {
  toLangChainMessages,
  toOpenAIChatResponse,
  toOpenAIStreamChunk,
  summarizeUsage,
  buildErrorResponse,
  extractFinishReason,
} from '@/lib/services/models/openaiAdapter';
import { createInlineReasoningSplitter } from '@/lib/shared/inlineReasoning';

// ── toLangChainMessages ───────────────────────────────────────────────────────

describe('toLangChainMessages', () => {
  it('converts system role to SystemMessage', () => {
    const msgs = toLangChainMessages([{ role: 'system', content: 'You are helpful.' }]);
    expect(msgs[0].constructor.name).toBe('SystemMessage');
    expect(msgs[0].content).toBe('You are helpful.');
  });

  it('converts user role to HumanMessage', () => {
    const msgs = toLangChainMessages([{ role: 'user', content: 'Hello!' }]);
    expect(msgs[0].constructor.name).toBe('HumanMessage');
    expect(msgs[0].content).toBe('Hello!');
  });

  it('converts assistant role to AIMessage', () => {
    const msgs = toLangChainMessages([{ role: 'assistant', content: 'Hi there!' }]);
    expect(msgs[0].constructor.name).toBe('AIMessage');
    expect(msgs[0].content).toBe('Hi there!');
  });

  it('converts tool role to ToolMessage with tool_call_id', () => {
    const msgs = toLangChainMessages([
      { role: 'tool', content: '{"result": 42}', tool_call_id: 'call-abc' },
    ]);
    expect(msgs[0].constructor.name).toBe('ToolMessage');
  });

  it('handles an empty messages array', () => {
    const msgs = toLangChainMessages([]);
    expect(msgs).toEqual([]);
  });

  it('preserves message order', () => {
    const msgs = toLangChainMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(msgs[0].constructor.name).toBe('SystemMessage');
    expect(msgs[1].constructor.name).toBe('HumanMessage');
    expect(msgs[2].constructor.name).toBe('AIMessage');
  });

  it('falls through unknown role to HumanMessage', () => {
    // @ts-expect-error — testing unknown role
    const msgs = toLangChainMessages([{ role: 'unknown', content: 'x' }]);
    expect(msgs[0].constructor.name).toBe('HumanMessage');
  });

  it('handles multipart array content on user message', () => {
    const msgs = toLangChainMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }] as never,
      },
    ]);
    expect(msgs[0].constructor.name).toBe('HumanMessage');
  });

  it('wraps string image URLs in the OpenAI-compatible object shape', () => {
    const imageUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const msgs = toLangChainMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: imageUrl },
        ] as never,
      },
    ]);

    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'Describe this image' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ]);
  });

  it('preserves the detail option on object image URLs', () => {
    const imageUrl = 'https://example.com/image.png';
    const msgs = toLangChainMessages([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: imageUrl, detail: 'high' },
          },
        ] as never,
      },
    ]);

    expect(msgs[0].content).toEqual([
      {
        type: 'image_url',
        image_url: { url: imageUrl, detail: 'high' },
      },
    ]);
  });

  it('normalizes multiple HTTP and data URL images without changing their order', () => {
    const firstUrl = 'https://cdn.example.com/first.png';
    const secondUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const msgs = toLangChainMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these images' },
          { type: 'image_url', image_url: firstUrl },
          { type: 'image_url', image_url: { url: secondUrl, detail: 'low' } },
        ] as never,
      },
    ]);

    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'Compare these images' },
      { type: 'image_url', image_url: { url: firstUrl } },
      { type: 'image_url', image_url: { url: secondUrl, detail: 'low' } },
    ]);
  });

  it('rejects malformed image URLs before calling a provider', () => {
    expect(() => toLangChainMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { detail: 'high' } },
        ] as never,
      },
    ])).toThrow('`messages[0].content[1].image_url` must be');
  });

  it.each([
    '',
    '   ',
    { url: '' },
    { url: '   ' },
  ])('rejects an empty image URL: %j', (imageUrl) => {
    expect(() => toLangChainMessages([{
      role: 'user',
      content: [{ type: 'image_url', image_url: imageUrl }] as never,
    }])).toThrow('`messages[0].content[0].image_url` must be');
  });

  it('preserves unknown content parts for forward compatibility', () => {
    const inputAudio = {
      type: 'input_audio',
      input_audio: { data: 'UklGRg==', format: 'wav' },
    };
    const msgs = toLangChainMessages([
      { role: 'user', content: [inputAudio] as never },
    ]);

    expect(msgs[0].content).toEqual([inputAudio]);
  });
});

// ── toOpenAIChatResponse ──────────────────────────────────────────────────────

function makeAIMessage(content: string, usageMeta?: Record<string, unknown>): AIMessage {
  return new AIMessage({
    content,
    response_metadata: usageMeta
      ? { tokenUsage: usageMeta, finish_reason: 'stop' }
      : { finish_reason: 'stop' },
  });
}

describe('toOpenAIChatResponse', () => {
  const baseOptions = { model: 'gpt-4o' };

  it('returns a valid OpenAI chat completion shape', () => {
    const msg = makeAIMessage('Hello!');
    const result = toOpenAIChatResponse(msg, baseOptions);

    expect(result.object).toBe('chat.completion');
    expect(typeof result.id).toBe('string');
    // OpenAI's own prefix is `chatcmpl-`; we used to emit an underscore.
    expect(result.id).toMatch(/^chatcmpl-/);
    expect(result.model).toBe('gpt-4o');
    expect(Array.isArray(result.choices)).toBe(true);
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.role).toBe('assistant');
    expect(result.choices[0].message.content).toBe('Hello!');
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(typeof result.created).toBe('number');
  });

  it('includes usage field with numeric token counts', () => {
    const msg = makeAIMessage('Hi', {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    const result = toOpenAIChatResponse(msg, baseOptions);

    expect(result.usage.prompt_tokens).toBe(10);
    expect(result.usage.completion_tokens).toBe(5);
    expect(result.usage.total_tokens).toBe(15);
  });

  it('preserves GPT-5 reasoning usage from LangChain metadata', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 932,
          completion_tokens: 512,
          total_tokens: 1444,
          prompt_tokens_details: { cached_tokens: 0 },
          completion_tokens_details: { reasoning_tokens: 512 },
        },
        finish_reason: 'length',
      },
      usage_metadata: {
        input_tokens: 932,
        output_tokens: 512,
        total_tokens: 1444,
        input_token_details: { cache_read: 0 },
        output_token_details: { reasoning: 512 },
      },
    });

    const result = toOpenAIChatResponse(msg, baseOptions);

    expect(result.usage).toMatchObject({
      prompt_tokens: 932,
      completion_tokens: 512,
      total_tokens: 1444,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 512 },
    });
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('sets usage counts to 0 when no token metadata', () => {
    const msg = makeAIMessage('ok');
    const result = toOpenAIChatResponse(msg, baseOptions);

    expect(result.usage.prompt_tokens).toBe(0);
    expect(result.usage.completion_tokens).toBe(0);
  });

  it('sets content to null for empty string content', () => {
    const msg = makeAIMessage('');
    const result = toOpenAIChatResponse(msg, baseOptions);
    expect(result.choices[0].message.content).toBeNull();
  });

  it('includes system_fingerprint', () => {
    const msg = makeAIMessage('hi');
    const result = toOpenAIChatResponse(msg, baseOptions);
    expect(typeof result.system_fingerprint).toBe('string');
    expect(result.system_fingerprint.length).toBeGreaterThan(0);
  });

  it('each call produces a unique id', () => {
    const msg = makeAIMessage('hi');
    const a = toOpenAIChatResponse(msg, baseOptions);
    const b = toOpenAIChatResponse(msg, baseOptions);
    expect(a.id).not.toBe(b.id);
  });

  it('surfaces reasoning_content from additional_kwargs on the message', () => {
    const msg = new AIMessage({
      content: 'The answer is 42.',
      additional_kwargs: { reasoning_content: 'Thought about it carefully.' },
    });
    const result = toOpenAIChatResponse(msg, baseOptions);
    const message = result.choices[0].message as Record<string, unknown>;
    expect(message.reasoning_content).toBe('Thought about it carefully.');
    expect(message.content).toBe('The answer is 42.');
  });

  it('omits reasoning_content when the model does not emit it', () => {
    const msg = makeAIMessage('plain answer');
    const result = toOpenAIChatResponse(msg, baseOptions);
    const message = result.choices[0].message as Record<string, unknown>;
    expect('reasoning_content' in message).toBe(false);
  });
});

// ── toOpenAIStreamChunk ───────────────────────────────────────────────────────

describe('toOpenAIStreamChunk', () => {
  it('returns a valid stream chunk shape', () => {
    const chunk = new AIMessageChunk({ content: 'partia' });
    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-4o', stream: true });

    expect(result.object).toBe('chat.completion.chunk');
    expect(result.model).toBe('gpt-4o');
    expect(Array.isArray(result.choices)).toBe(true);
    expect(result.choices[0].delta.content).toBe('partia');
    expect(result.choices[0].index).toBe(0);
  });

  it('finish_reason is null for mid-stream chunks', () => {
    const chunk = new AIMessageChunk({ content: 'x' });
    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-4o' });
    expect(result.choices[0].finish_reason).toBeNull();
  });

  it('omits usage when no token metadata', () => {
    const chunk = new AIMessageChunk({ content: 'y' });
    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-4o' });
    expect(result.usage).toBeUndefined();
  });

  it('uses stable completion metadata supplied by the stream owner', () => {
    const options = {
      model: 'gpt-5',
      stream: true,
      completionId: 'chatcmpl_stable',
      created: 1234567890,
    };

    const first = toOpenAIStreamChunk(
      new AIMessageChunk({ content: 'one' }),
      options,
    );
    const second = toOpenAIStreamChunk(
      new AIMessageChunk({ content: 'two' }),
      options,
    );

    expect(first.id).toBe('chatcmpl_stable');
    expect(second.id).toBe(first.id);
    expect(first.created).toBe(1234567890);
    expect(second.created).toBe(first.created);
  });

  it('preserves incremental tool call arguments and index', () => {
    const first = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{
          id: 'call_weather',
          name: 'get_weather',
          args: '{"city":',
          index: 0,
          type: 'tool_call_chunk',
        }],
      }),
      { model: 'gpt-5' },
    );
    const second = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{
          args: '"Ankara"}',
          index: 0,
          type: 'tool_call_chunk',
        }],
      }),
      { model: 'gpt-5' },
    );

    expect(first.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_weather',
      type: 'function' as const,
      function: {
        name: 'get_weather',
        arguments: '{"city":',
      },
    }]);
    expect(second.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      function: { arguments: '"Ankara"}' },
    }]);
  });

  it('prefers raw OpenAI tool deltas over parsed tool calls', () => {
    const chunk = new AIMessageChunk({
      content: '',
      additional_kwargs: {
        tool_calls: [{
          index: 0,
          id: 'call_weather',
          type: 'function' as const,
          function: {
            name: 'get_weather',
            arguments: '{"city":"Ankara"}',
          },
        }],
      },
      tool_calls: [{
        id: 'call_weather',
        name: 'get_weather',
        args: {},
        type: 'tool_call',
      }],
    });

    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-5' });

    expect(result.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_weather',
      type: 'function' as const,
      function: {
        name: 'get_weather',
        arguments: '{"city":"Ankara"}',
      },
    }]);
  });

  it('includes reasoning token details in the final usage chunk', () => {
    const chunk = new AIMessageChunk({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 932,
          completion_tokens: 512,
          total_tokens: 1444,
          completion_tokens_details: { reasoning_tokens: 512 },
        },
        finish_reason: 'length',
      },
    });

    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-5' });

    expect(result.usage).toMatchObject({
      prompt_tokens: 932,
      completion_tokens: 512,
      total_tokens: 1444,
      completion_tokens_details: { reasoning_tokens: 512 },
    });
    expect(result.choices[0].finish_reason).toBe('length');
  });

  it('surfaces reasoning_content from additional_kwargs in the delta', () => {
    const chunk = new AIMessageChunk({
      content: '',
      additional_kwargs: { reasoning_content: 'Let me think…' },
    });
    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-4o', stream: true });
    expect(
      (result.choices[0].delta as Record<string, unknown>).reasoning_content,
    ).toBe('Let me think…');
  });

  it('omits reasoning_content when not present', () => {
    const chunk = new AIMessageChunk({ content: 'hi' });
    const result = toOpenAIStreamChunk(chunk, { model: 'gpt-4o' });
    expect(
      'reasoning_content' in (result.choices[0].delta as Record<string, unknown>),
    ).toBe(false);
  });
});

// ── summarizeUsage ────────────────────────────────────────────────────────────

// -- tool calls the parser could not read --------------------------------------

describe('tool calls with unparseable arguments', () => {
  // Verbatim from bedrock-runtime eu-central-1, `qwen.qwen3-coder-30b-a3b-v1:0`:
  // a call to a NO-PARAMETER tool comes back with `arguments: "{"`. LangChain
  // cannot parse that, so it files the call under `invalid_tool_calls` and
  // leaves `tool_calls` empty -- while `additional_kwargs.tool_calls` still
  // holds the raw wire array.
  const brokenCall = {
    id: 'call_c222a246b91a4cff92495c73',
    type: 'function' as const,
    function: { name: 'list_available_symbols', arguments: '{' },
  };

  it('keeps a call LangChain could not parse, instead of dropping it', () => {
    const msg = new AIMessage({
      content: '',
      additional_kwargs: { tool_calls: [brokenCall] },
      response_metadata: { finish_reason: 'tool_calls' },
    });
    (msg as unknown as Record<string, unknown>).invalid_tool_calls = [
      { name: 'list_available_symbols', args: '{', id: brokenCall.id, type: 'invalid_tool_call' },
    ];

    const res = toOpenAIChatResponse(msg, { model: 'm' });
    const message = res.choices[0].message as Record<string, unknown>;
    const calls = message.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;

    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('list_available_symbols');
    expect(calls[0].id).toBe(brokenCall.id);
    // A bare `{` for a no-parameter call is unambiguously an empty object.
    expect(calls[0].function.arguments).toBe('{}');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({});
  });

  it('falls back to invalid_tool_calls when the raw wire array is absent', () => {
    const msg = new AIMessage({ content: '', response_metadata: { finish_reason: 'tool_calls' } });
    (msg as unknown as Record<string, unknown>).invalid_tool_calls = [
      { name: 'get_time', args: '{', id: 'call_1', type: 'invalid_tool_call' },
    ];

    const message = toOpenAIChatResponse(msg, { model: 'm' }).choices[0].message as Record<string, unknown>;
    expect((message.tool_calls as unknown[]).length).toBe(1);
  });

  it('merges the parsed and unparseable halves of the same turn', () => {
    const msg = new AIMessage({
      content: '',
      tool_calls: [{ id: 'ok-1', name: 'get_weather', args: { city: 'Istanbul' }, type: 'tool_call' }],
    });
    (msg as unknown as Record<string, unknown>).invalid_tool_calls = [
      { name: 'get_time', args: '{', id: 'bad-1', type: 'invalid_tool_call' },
    ];

    const message = toOpenAIChatResponse(msg, { model: 'm' }).choices[0].message as Record<string, unknown>;
    const calls = message.tool_calls as Array<{ id: string }>;
    expect(calls.map((c) => c.id)).toEqual(['ok-1', 'bad-1']);
  });

  it('never invents arguments for a genuinely truncated call', () => {
    const msg = new AIMessage({
      content: '',
      additional_kwargs: {
        tool_calls: [
          { id: 'c1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"Ist' } },
        ],
      },
    });

    const message = toOpenAIChatResponse(msg, { model: 'm' }).choices[0].message as Record<string, unknown>;
    const calls = message.tool_calls as Array<{ function: { arguments: string } }>;
    expect(calls[0].function.arguments).toBe('{"city":"Ist');
  });

  it('leaves well-formed arguments byte-for-byte alone', () => {
    const raw = '{\n  "city": "Istanbul"\n}';
    const msg = new AIMessage({
      content: '',
      additional_kwargs: {
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'get_weather', arguments: raw } }],
      },
    });

    const message = toOpenAIChatResponse(msg, { model: 'm' }).choices[0].message as Record<string, unknown>;
    const calls = message.tool_calls as Array<{ function: { arguments: string } }>;
    expect(calls[0].function.arguments).toBe(raw);
  });
});

// ── leaked inline reasoning ───────────────────────────────────────────────────

describe('inline reasoning leaked into content', () => {
  it('moves a <reasoning> block to reasoning_content on a full response', () => {
    // The shape AWS Bedrock's `/openai/v1` shim returns for gpt-oss.
    const msg = new AIMessage({
      content: '<reasoning>User wants JSON.</reasoning>{"ok": true}',
    });
    const res = toOpenAIChatResponse(msg, { model: 'openai.gpt-oss-120b-1:0' });
    const message = res.choices[0].message as Record<string, unknown>;

    expect(message.content).toBe('{"ok": true}');
    expect(message.reasoning_content).toBe('User wants JSON.');
    expect(JSON.parse(message.content as string)).toEqual({ ok: true });
  });

  it('leaves a message without leaked markup untouched', () => {
    const msg = new AIMessage({ content: 'plain answer' });
    const res = toOpenAIChatResponse(msg, { model: 'm' });
    const message = res.choices[0].message as Record<string, unknown>;

    expect(message.content).toBe('plain answer');
    expect(message.reasoning_content).toBeUndefined();
  });

  it('splits a block that spans several stream deltas', () => {
    const reasoningSplitter = createInlineReasoningSplitter();
    const options = { model: 'm', stream: true, reasoningSplitter };
    const deltas = ['<reason', 'ing>why</reason', 'ing>Hel', 'lo'];

    const seen = deltas.map((content) =>
      toOpenAIStreamChunk(new AIMessageChunk({ content }), options).choices[0].delta,
    );

    expect(seen.map((d) => d.content ?? '').join('')).toBe('Hello');
    expect(seen.map((d) => d.reasoning_content ?? '').join('')).toBe('why');
  });

  it('does not touch stream deltas when no splitter is threaded through', () => {
    const chunk = new AIMessageChunk({ content: '<reasoning>x</reasoning>hi' });
    const delta = toOpenAIStreamChunk(chunk, { model: 'm', stream: true }).choices[0].delta;

    expect(delta.content).toBe('<reasoning>x</reasoning>hi');
  });
});

describe('summarizeUsage', () => {
  it('extracts token usage from promptTokens / completionTokens keys', () => {
    const msg = makeAIMessage('ok', { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    const usage = summarizeUsage(msg);

    expect(usage.inputTokens).toBe(20);
    expect(usage.outputTokens).toBe(10);
    expect(usage.totalTokens).toBe(30);
  });

  it('extracts token usage from snake_case keys', () => {
    const msg = new AIMessage({
      content: 'x',
      response_metadata: {
        tokenUsage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });
    const usage = summarizeUsage(msg);
    expect(usage.inputTokens).toBe(5);
    expect(usage.outputTokens).toBe(3);
  });

  it('extracts cachedInputTokens', () => {
    const msg = makeAIMessage('x', { promptTokens: 10, cachedTokens: 4 });
    const usage = summarizeUsage(msg);
    expect(usage.cachedInputTokens).toBe(4);
  });

  it('returns undefined fields when no usage metadata exists', () => {
    const msg = new AIMessage({ content: 'hi' });
    const usage = summarizeUsage(msg);
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it('auto-calculates totalTokens from input + output when totalTokens missing', () => {
    const msg = makeAIMessage('x', { promptTokens: 7, completionTokens: 3 });
    const usage = summarizeUsage(msg);
    expect(usage.totalTokens).toBe(10);
  });

  it('reads normalized LangChain usage_metadata', () => {
    const msg = new AIMessage({
      content: '',
      usage_metadata: {
        input_tokens: 932,
        output_tokens: 512,
        total_tokens: 1444,
        input_token_details: { cache_read: 12 },
        output_token_details: { reasoning: 512 },
      },
    });

    expect(summarizeUsage(msg)).toMatchObject({
      inputTokens: 932,
      outputTokens: 512,
      cachedInputTokens: 12,
      totalTokens: 1444,
      promptTokensDetails: { cache_read: 12, cached_tokens: 12 },
      completionTokensDetails: { reasoning: 512, reasoning_tokens: 512 },
      reasoningTokens: 512,
    });
  });
});

// ── summarizeUsage: reasoningTokens ──────────────────────────────────────────
// reasoningTokens is a SUBSET of outputTokens — it must never be folded into
// totalTokens or affect any cost arithmetic downstream.

describe('summarizeUsage reasoningTokens', () => {
  it('extracts reasoningTokens from completion_tokens_details.reasoning_tokens', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      },
    });
    const usage = summarizeUsage(msg);
    expect(usage.reasoningTokens).toBe(8);
  });

  it('extracts reasoningTokens from the `reasoning` alias (output_token_details.reasoning)', () => {
    const msg = new AIMessage({
      content: '',
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        output_token_details: { reasoning: 6 },
      },
    });
    const usage = summarizeUsage(msg);
    expect(usage.reasoningTokens).toBe(6);
  });

  it('extracts reasoningTokens from output_tokens_details.reasoning_tokens (Responses API shape)', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    });
    const usage = summarizeUsage(msg);
    expect(usage.reasoningTokens).toBe(4);
  });

  it('omits reasoningTokens when not present', () => {
    const msg = makeAIMessage('x', { promptTokens: 5, completionTokens: 3 });
    const usage = summarizeUsage(msg);
    expect(usage.reasoningTokens).toBeUndefined();
  });

  it('omits reasoningTokens when reported as 0 (not > 0)', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    const usage = summarizeUsage(msg);
    expect(usage.reasoningTokens).toBeUndefined();
  });

  it('never folds reasoningTokens into totalTokens or outputTokens', () => {
    const msg = new AIMessage({
      content: '',
      response_metadata: {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 8 },
        },
      },
    });
    const usage = summarizeUsage(msg);
    // reasoning_tokens (8) is a subset of completion_tokens (20), not an
    // addend — outputTokens/totalTokens must reflect only the raw counts.
    expect(usage.outputTokens).toBe(20);
    expect(usage.totalTokens).toBe(30);
  });
});

// ── extractFinishReason ───────────────────────────────────────────────────────

describe('extractFinishReason', () => {
  it('reads and normalizes response_metadata.finish_reason', () => {
    const msg = new AIMessage({
      content: 'x',
      response_metadata: { finish_reason: 'STOP' },
    });
    expect(extractFinishReason(msg)).toBe('stop');
  });

  it('falls back to response_metadata.finishReason', () => {
    const msg = new AIMessage({
      content: 'x',
      response_metadata: { finishReason: 'length' },
    });
    expect(extractFinishReason(msg)).toBe('length');
  });

  it('returns undefined when no finish reason is present', () => {
    const msg = new AIMessage({ content: 'x' });
    expect(extractFinishReason(msg)).toBeUndefined();
  });

  it('returns undefined for a non-string finish_reason', () => {
    const msg = new AIMessage({
      content: 'x',
      response_metadata: { finish_reason: 42 },
    });
    expect(extractFinishReason(msg)).toBeUndefined();
  });
});

// ── buildErrorResponse ────────────────────────────────────────────────────────

describe('buildErrorResponse', () => {
  it('defaults to status 400', () => {
    const result = buildErrorResponse('Something went wrong');
    expect(result.status).toBe(400);
    expect(result.error.message).toBe('Something went wrong');
    expect(result.error.type).toBe('invalid_request_error');
  });

  it('accepts a custom status code', () => {
    const result = buildErrorResponse('Not found', 404);
    expect(result.status).toBe(404);
  });
});
