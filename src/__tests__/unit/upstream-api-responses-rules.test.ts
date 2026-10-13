/**
 * A model on the Responses upstream: its reasoning summary is requested when it will be shown, and the
 * Chat Completions tools rule (GPT-5: reasoning effort forced to `none` next to function tools) does not apply.
 */
import { describe, expect, it } from 'vitest';
import { buildTransformRequest } from '@/lib/providers/contracts/nativeClients';
import { withReasoningVisibility } from '@/lib/services/models/reasoning';

const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];

describe('Responses upstream', () => {
  it('asks an OpenAI-schema model for its reasoning summary only when the text will be shown', () => {
    expect(withReasoningVisibility({ effort: "high" } as { effort: string; includeThoughts?: boolean }, true, 'azure', 'responses')).toEqual({ effort: 'high', includeThoughts: true });
    expect(withReasoningVisibility({ effort: "high" } as { effort: string; includeThoughts?: boolean }, true, 'azure', 'chat')).toEqual({ effort: 'high' });
    expect(withReasoningVisibility({ effort: "high" } as { effort: string; includeThoughts?: boolean }, false, 'azure', 'responses')).toEqual({ effort: 'high', includeThoughts: false });
  });

  it('keeps the requested reasoning effort next to tools on Responses, forces none on Chat Completions', async () => {
    const run = async (upstreamApi: string) => {
      const transform = buildTransformRequest({ driver: 'openai-compatible', modelId: 'gpt-5.6-luna', settings: { upstreamApi } });
      const out = await transform({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'x' }], tools, reasoning: { effort: 'high' } } as never);
      return (out ?? {}) as Record<string, unknown>;
    };
    const chat = await run('chat');
    const responses = await run('responses');
    expect((chat.extra as Record<string, unknown>).reasoning_effort).toBe('none');
    expect(chat.reasoning).toBeUndefined();
    // Responses: the typed reasoning reaches the provider (sent as reasoning: {effort, summary}), nothing forced.
    expect((responses.reasoning as { effort?: string } | undefined)?.effort).toBe('high');
    expect((responses.extra as Record<string, unknown> | undefined)?.reasoning_effort).toBeUndefined();
  });
});
