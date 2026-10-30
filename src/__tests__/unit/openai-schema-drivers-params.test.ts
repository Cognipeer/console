/**
 * Unit tests — which drivers speak the OpenAI schema, for the parameter rules and the token-field rename
 *
 *  - `together` is a record driver of its own on the OpenAI wire, and the SDK rule table treats it as one. The
 *    parameter registry did not list it, so a Together model got none of the detection (temperature on a reasoning
 *    model, the reasoning effort next to tools) that an OpenAI-compatible one got.
 *  - `max_tokens` -> `max_completion_tokens` is an OpenAI-schema choice. Anthropic, Bedrock and Vertex carry the cap in
 *    their own field, so the form does not offer the option for them and the runtime never puts the OpenAI key into
 *    their request.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOverrides } from '@/lib/providers/contracts/modelContracts';
import { OPENAI_SCHEMA_DRIVERS, buildTransformRequest } from '@/lib/providers/contracts/nativeClients';
import {
  detectUnsupportedParams,
  isOpenAiSchemaDriver,
  requestReasoningEffortAccepted,
  resolveUnsupportedParamNames,
} from '@/lib/providers/unsupportedParams';
import { UNSUPPORTED_PARAM_OPTIONS, unsupportedParamOptions } from '@/components/models/requestParams';
import { anthropicRuntime, bedrockRuntime, json, stubUpstream } from '../helpers/nativeGateway';

afterEach(() => vi.unstubAllGlobals());

const ASK = [{ role: 'user' as const, content: 'hi' }];
const TOOL = { type: 'function', function: { name: 'search', parameters: { type: 'object', properties: {} } } };

describe('isOpenAiSchemaDriver', () => {
  it('is true for the four drivers that speak Chat Completions, together included', () => {
    for (const driver of ['openai', 'openai-compatible', 'azure', 'together']) {
      expect(isOpenAiSchemaDriver(driver), driver).toBe(true);
    }
  });

  it('is false for the drivers with their own request shape, and for no driver at all', () => {
    for (const driver of ['anthropic', 'bedrock', 'vertex', 'cohere', 'voyage', '', undefined, null]) {
      expect(isOpenAiSchemaDriver(driver), String(driver)).toBe(false);
    }
  });

  it('agrees with the native clients about every driver', () => {
    for (const driver of ['openai', 'openai-compatible', 'azure', 'together', 'anthropic', 'bedrock', 'vertex', 'cohere', 'unknown']) {
      expect(isOpenAiSchemaDriver(driver), driver).toBe(OPENAI_SCHEMA_DRIVERS.has(driver));
    }
  });
});

describe('detection for a Together model', () => {
  it.each(['gpt-5.6-luna', 'o3-mini', 'gpt-5-chat-latest', 'gpt-6-luna', 'qwen3-32b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'])(
    'is what an OpenAI-compatible endpoint gets for %s, with and without tools',
    (modelId) => {
      for (const hasTools of [false, true]) {
        expect(detectUnsupportedParams('together', modelId, hasTools), `${modelId} tools=${hasTools}`)
          .toEqual(detectUnsupportedParams('openai-compatible', modelId, hasTools));
      }
    },
  );

  it('knows the OpenAI reasoning families, as it does per driver for the others', () => {
    expect(detectUnsupportedParams('together', 'o3-mini').params).toContain('temperature');
    expect(detectUnsupportedParams('together', 'gpt-5.6-luna').params)
      .toEqual(expect.arrayContaining(['temperature', 'top_p', 'max_tokens']));
  });

  it('drops the reasoning effort next to tools and forces "none", like the other OpenAI-schema drivers', () => {
    const detected = detectUnsupportedParams('together', 'gpt-5.6-luna', true);
    expect(detected.params).toEqual(expect.arrayContaining(['reasoning', 'reasoning_effort']));
    expect(detected.forced).toEqual({ reasoning_effort: 'none' });
    // Without tools the effort is fine.
    expect(detectUnsupportedParams('together', 'gpt-5.6-luna', false).params).not.toContain('reasoning_effort');
  });

  it('says nothing about models the rule table does not restrict', () => {
    expect(detectUnsupportedParams('together', 'qwen3-32b').params).toEqual([]);
    expect(detectUnsupportedParams('together', undefined).params).toEqual([]);
  });

  it('unions with the operator list, and can be switched off per model, like any OpenAI-schema driver', () => {
    const detected = resolveUnsupportedParamNames({ driver: 'together', modelId: 'gpt-5.6-luna', manual: ['frequency_penalty'] });
    expect(detected.params).toEqual(expect.arrayContaining(['temperature', 'top_p', 'max_tokens', 'frequency_penalty']));

    const off = resolveUnsupportedParamNames({ driver: 'together', modelId: 'gpt-5.6-luna', manual: ['frequency_penalty'], autoDetect: false });
    expect(off.params).toEqual(['frequency_penalty']);
  });

  it('still takes a request effort the way it did (the check was already shared with the other drivers)', () => {
    expect(requestReasoningEffortAccepted('together', 'gpt-4o', 'low')).toBe(requestReasoningEffortAccepted('openai-compatible', 'gpt-4o', 'low'));
    expect(requestReasoningEffortAccepted('together', 'o3', 'high')).toBe(true);
  });

  it('strips what the model rejects from the finished request, and forces the effort next to tools', () => {
    const request = (extra: Record<string, unknown> = {}) =>
      ({ model: 'gpt-5.6-luna', messages: [], temperature: 0.2, ...extra }) as never;
    const transform = (settings: Record<string, unknown>) =>
      buildTransformRequest({ driver: 'together', modelId: 'gpt-5.6-luna', settings });

    expect((transform({})(request()) as { temperature?: number }).temperature).toBeUndefined();
    expect((transform({ autoDropUnsupportedParams: false })(request()) as { temperature?: number }).temperature).toBe(0.2);

    const withTools = transform({})(request({ tools: [TOOL], reasoning: { effort: 'high' } })) as { reasoning?: unknown; extra?: Record<string, unknown> };
    expect(withTools.reasoning).toBeUndefined();
    expect(withTools.extra).toEqual({ reasoning_effort: 'none' });
  });
});

describe('declaring max_tokens unsupported (the budget travels as max_completion_tokens)', () => {
  const rename = (driver: string | undefined, modelId: string) =>
    resolveOverrides({ maxTokens: 500, unsupportedParams: ['max_tokens'] }, modelId, driver);

  it.each([
    ['openai', 'my-prod-deployment'],
    ['azure', 'my-prod-deployment'],
    ['openai-compatible', 'luna-prod'],
    ['together', 'luna-prod'],
  ])('%s: a model id no rule renames (%s) gets the renamed key in the extra body', (driver, modelId) => {
    const result = rename(driver, modelId);
    expect(result.extraBody).toEqual({ max_completion_tokens: 500 });
    expect(result.maxCompletionTokens).toBe(500);
    expect(result.maxTokens).toBeUndefined();
    expect(result.maxTokensRenamed).toBe(true);
  });

  it.each(['openai', 'azure', 'openai-compatible', 'together'])(
    '%s: an id whose rule already sends max_completion_tokens needs no extra key',
    (driver) => {
      const result = rename(driver, 'gpt-6-luna');
      expect(result.extraBody).toBeUndefined();
      expect(result.maxCompletionTokens).toBe(500);
      expect(result.maxTokensRenamed).toBe(true);
    },
  );

  it.each([
    ['anthropic', 'claude-sonnet-4-5'],
    ['bedrock', 'anthropic.claude-3'],
    ['vertex', 'gemini-2.5-pro'],
    ['bedrock', 'luna-prod'],
  ])('%s: the budget stays in the one field the provider has, and the OpenAI key is not added', (driver, modelId) => {
    const result = rename(driver, modelId);
    expect(result.extraBody).toBeUndefined();
    expect(result.maxCompletionTokens).toBe(500);
    expect(result.maxTokens).toBeUndefined();
  });

  it('keeps the operator\'s own extra body as it was, for every driver', () => {
    const settings = { maxTokens: 500, unsupportedParams: ['max_tokens'], extraBody: { top_k: 20 } };
    expect(resolveOverrides(settings, 'luna-prod', 'openai-compatible').extraBody).toEqual({ max_completion_tokens: 500, top_k: 20 });
    expect(resolveOverrides(settings, 'claude-sonnet-4-5', 'anthropic').extraBody).toEqual({ top_k: 20 });
  });

  it('puts max_tokens on the Anthropic wire and no max_completion_tokens next to it', async () => {
    const upstream = stubUpstream(() => json({
      id: 'msg', model: 'claude', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const client = await (await anthropicRuntime()).createNativeChatClient!({
      modelId: 'claude-sonnet-4-5',
      category: 'llm',
      modelSettings: { maxTokens: 500, unsupportedParams: ['max_tokens'] },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    expect(upstream.calls[0].body.max_tokens).toBe(500);
    expect(upstream.calls[0].body).not.toHaveProperty('max_completion_tokens');
  });

  it('keeps the Bedrock cap in inferenceConfig and puts nothing OpenAI-shaped into the request', async () => {
    const upstream = stubUpstream(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const client = await (await bedrockRuntime()).createNativeChatClient!({
      modelId: 'anthropic.claude-3',
      category: 'llm',
      modelSettings: { maxTokens: 2048, unsupportedParams: ['max_tokens'] },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    const body = upstream.calls[0].body;
    expect(body.inferenceConfig.maxTokens).toBe(2048);
    expect(JSON.stringify(body)).not.toContain('max_completion_tokens');
  });
});

describe('the "Also reject these" options of a model form', () => {
  const values = (options: Array<{ value: string }>) => options.map((option) => option.value);
  const WITHOUT_MAX_TOKENS = values(UNSUPPORTED_PARAM_OPTIONS).filter((value) => value !== 'max_tokens');

  it.each(['openai', 'azure', 'openai-compatible', 'together'])('offer max_tokens for %s', (driver) => {
    expect(values(unsupportedParamOptions(driver))).toEqual(values(UNSUPPORTED_PARAM_OPTIONS));
    expect(values(unsupportedParamOptions(driver))).toContain('max_tokens');
  });

  it.each(['anthropic', 'bedrock', 'vertex', undefined])('leave max_tokens out for %s, and keep every other option in order', (driver) => {
    expect(values(unsupportedParamOptions(driver))).not.toContain('max_tokens');
    expect(values(unsupportedParamOptions(driver))).toEqual(WITHOUT_MAX_TOKENS);
  });

  it('still show max_tokens when the model already lists it, so it can be seen and removed', () => {
    expect(values(unsupportedParamOptions('anthropic', ['max_tokens']))).toContain('max_tokens');
    expect(values(unsupportedParamOptions('bedrock', ['temperature']))).not.toContain('max_tokens');
  });

  it('keep the full list exported, with max_tokens labelled by what it is sent as instead', () => {
    expect(UNSUPPORTED_PARAM_OPTIONS.find((option) => option.value === 'max_tokens')?.label).toContain('max_completion_tokens');
  });
});
