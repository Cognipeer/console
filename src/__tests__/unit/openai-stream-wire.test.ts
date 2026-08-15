/**
 * Unit tests — OpenAI streaming wire format
 *
 * Regression cover for the defects that made our SSE stream unusable to strict
 * OpenAI clients (Open WebUI among them). Each case below shipped:
 *  - usage was read from metadata keys the streaming path never populates, so
 *    every streamed request logged zero tokens and skipped budget/rate limits;
 *  - tool-call deltas were read from the collapsed `tool_calls` instead of
 *    `tool_call_chunks`, so tools appeared to be called with no arguments;
 *  - each frame carried a fresh id, and no frame carried `delta.role`;
 *  - `delta.content` could be an array, which breaks `content += delta.content`.
 */

import { describe, it, expect } from 'vitest';
import { AIMessageChunk } from '@langchain/core/messages';
import {
  isEmptyStreamDelta,
  openAIStreamRoleChunk,
  openAIStreamStopChunk,
  toOpenAIStreamChunk,
  toOpenAIErrorType,
} from '@/lib/services/models/openaiAdapter';

const OPTIONS = {
  model: 'my-model',
  stream: true as const,
  id: 'chatcmpl-fixed',
  created: 1_700_000_000,
};

describe('stream envelope', () => {
  it('keeps one id and created across every frame of a completion', () => {
    const first = toOpenAIStreamChunk(new AIMessageChunk({ content: 'a' }), OPTIONS);
    const second = toOpenAIStreamChunk(new AIMessageChunk({ content: 'b' }), OPTIONS);

    expect(first.id).toBe('chatcmpl-fixed');
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(first.created);
    expect(first.object).toBe('chat.completion.chunk');
  });

  it('opens the stream with the assistant role', () => {
    const role = openAIStreamRoleChunk(OPTIONS);
    expect(role.choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(role.choices[0].finish_reason).toBeNull();
  });

  it('can emit a terminal frame for upstreams that never send finish_reason', () => {
    expect(openAIStreamStopChunk(OPTIONS).choices[0].finish_reason).toBe('stop');
    expect(openAIStreamStopChunk(OPTIONS, 'error').choices[0].finish_reason).toBe('error');
  });
});

describe('delta.content is always a string', () => {
  it('passes a plain string through', () => {
    const chunk = toOpenAIStreamChunk(new AIMessageChunk({ content: 'hello' }), OPTIONS);
    expect(chunk.choices[0].delta.content).toBe('hello');
  });

  it('flattens content blocks instead of putting an array on the wire', () => {
    const chunk = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: [
          { type: 'text', text: 'he' },
          { type: 'text', text: 'llo' },
        ],
      } as never),
      OPTIONS,
    );

    expect(chunk.choices[0].delta.content).toBe('hello');
  });

  it('routes reasoning blocks to reasoning_content rather than the answer', () => {
    const chunk = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: [
          { type: 'reasoning', text: 'thinking...' },
          { type: 'text', text: 'answer' },
        ],
      } as never),
      OPTIONS,
    );

    expect(chunk.choices[0].delta.content).toBe('answer');
    expect(chunk.choices[0].delta.reasoning_content).toBe('thinking...');
  });

  it('finds the reasoning text wherever the provider puts it', () => {
    const anthropic = toOpenAIStreamChunk(
      new AIMessageChunk({ content: [{ type: 'thinking', thinking: 'hmm' }] } as never),
      OPTIONS,
    );
    const bedrock = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: [{ type: 'reasoning_content', reasoningText: { text: 'hmm' } }],
      } as never),
      OPTIONS,
    );

    expect(anthropic.choices[0].delta.reasoning_content).toBe('hmm');
    expect(bedrock.choices[0].delta.reasoning_content).toBe('hmm');
    expect(anthropic.choices[0].delta.content).toBeUndefined();
  });

  it('omits content entirely for a frame that carries none', () => {
    const chunk = toOpenAIStreamChunk(new AIMessageChunk({ content: '' }), OPTIONS);
    expect(chunk.choices[0].delta.content).toBeUndefined();
  });
});

describe('tool-call deltas', () => {
  it('streams raw argument fragments with an index, not a re-serialized object', () => {
    const opening = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { name: 'get_weather', args: '{"ci', id: 'call_1', index: 0, type: 'tool_call_chunk' },
        ],
      } as never),
      OPTIONS,
    );

    expect(opening.choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"ci' },
      },
    ]);
  });

  it('keeps emitting continuation fragments — these used to vanish entirely', () => {
    const continuation = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { args: 'ty":"Berlin"}', index: 0, type: 'tool_call_chunk' },
        ],
      } as never),
      OPTIONS,
    );

    const deltas = continuation.choices[0].delta.tool_calls as Array<Record<string, unknown>>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0].index).toBe(0);
    expect((deltas[0].function as { arguments: string }).arguments).toBe('ty":"Berlin"}');
    // No id on a continuation frame, per the OpenAI protocol.
    expect(deltas[0].id).toBeUndefined();
  });

  it('never substitutes "{}" for a fragment that has not arrived yet', () => {
    const chunk = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ name: 'f', args: '', id: 'call_2', index: 0, type: 'tool_call_chunk' }],
      } as never),
      OPTIONS,
    );

    const deltas = chunk.choices[0].delta.tool_calls as Array<Record<string, unknown>>;
    expect((deltas[0].function as { arguments: string }).arguments).toBe('');
  });

  it('concatenating the fragments reconstructs the arguments', () => {
    const fragments = ['{"ci', 'ty":', '"Berlin"}'];
    const assembled = fragments
      .map((args, i) =>
        toOpenAIStreamChunk(
          new AIMessageChunk({
            content: '',
            tool_call_chunks: [
              { args, index: 0, type: 'tool_call_chunk', ...(i === 0 ? { id: 'c', name: 'f' } : {}) },
            ],
          } as never),
          OPTIONS,
        ),
      )
      .map((chunk) => {
        const deltas = chunk.choices[0].delta.tool_calls as Array<{ function: { arguments: string } }>;
        return deltas[0].function.arguments;
      })
      .join('');

    expect(JSON.parse(assembled)).toEqual({ city: 'Berlin' });
  });
});

describe('usage extraction', () => {
  it('reads the terminal frame that LangChain reports on usage_metadata', () => {
    const chunk = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        usage_metadata: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
          input_token_details: { cache_read: 4 },
        },
      } as never),
      OPTIONS,
    );

    expect(chunk.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 7,
      cached_tokens: 4,
      total_tokens: 18,
    });
  });

  it('also reads the raw provider numbers under response_metadata.usage', () => {
    const chunk = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        response_metadata: {
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        },
      } as never),
      OPTIONS,
    );

    expect(chunk.usage?.total_tokens).toBe(8);
  });

  it('reports no usage on ordinary content frames', () => {
    expect(toOpenAIStreamChunk(new AIMessageChunk({ content: 'x' }), OPTIONS).usage)
      .toBeUndefined();
  });

  it('identifies the usage-only frame so it can be sent as {choices: [], usage}', () => {
    const terminal = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } as never),
      OPTIONS,
    );

    expect(isEmptyStreamDelta(terminal)).toBe(true);
    expect(isEmptyStreamDelta(toOpenAIStreamChunk(new AIMessageChunk({ content: 'x' }), OPTIONS)))
      .toBe(false);
  });

  it('keeps the choice when a provider puts usage and finish_reason on one frame', () => {
    // Gemini does this. Collapsing the frame to `{choices: []}` would throw away
    // the only finish_reason the client ever sees.
    const frame = toOpenAIStreamChunk(
      new AIMessageChunk({
        content: '',
        response_metadata: { finish_reason: 'stop' },
        usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } as never),
      OPTIONS,
    );

    expect(isEmptyStreamDelta(frame)).toBe(true);
    expect(frame.choices[0].finish_reason).toBe('stop');
    expect(frame.usage).toBeDefined();
  });
});

describe('error envelope', () => {
  it('maps upstream statuses onto OpenAI error types instead of a blanket server_error', () => {
    expect(toOpenAIErrorType({ status: 400 })).toBe('invalid_request_error');
    expect(toOpenAIErrorType({ status: 401 })).toBe('authentication_error');
    expect(toOpenAIErrorType({ status: 404 })).toBe('not_found_error');
    expect(toOpenAIErrorType({ status: 429 })).toBe('rate_limit_error');
    expect(toOpenAIErrorType({ status: 503 })).toBe('server_error');
    expect(toOpenAIErrorType(new Error('boom'))).toBe('server_error');
  });
});
