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
} from '@/lib/services/models/openaiAdapter';

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
    expect(result.id).toMatch(/^chatcmpl_/);
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
});

// ── summarizeUsage ────────────────────────────────────────────────────────────

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
