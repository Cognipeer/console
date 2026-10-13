/**
 * Unit tests — per-model request parameters
 *
 * Regression cover for the parameter funnel between an incoming OpenAI-shaped
 * request and the provider SDK. Everything here encodes a bug that shipped:
 *  - the contract layer narrowed the request to four fields, so `top_p` and the
 *    penalties were accepted by the API and then silently dropped;
 *  - there was no way to express "this model rejects `temperature`", so the
 *    OpenAI reasoning family 400'd on any request the gateway built;
 *  - non-OpenAI-schema parameters (vLLM's `chat_template_kwargs`, `top_k`) could
 *    not be sent at all;
 *  - the provider's own retries nested inside `withResilience`.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { bedrockRuntime, chunk, completion, json, sse, stubUpstream } from '../helpers/nativeGateway';

afterEach(() => vi.unstubAllGlobals());

import { OpenAiCompatibleModelProviderContract } from '@/lib/providers/contracts/modelContracts';
import { buildTransformRequest } from '@/lib/providers/contracts/nativeClients';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';
import { resolveModelInvocationConfig } from '@/lib/services/models/inferenceService';
import {
  detectUnsupportedParams,
  resolveUnsupportedParamNames,
} from '@/lib/providers/unsupportedParams';
import { buildCacheVariantKey } from '@/lib/services/models/semanticCacheService';

const ASK = [{ role: 'user' as const, content: 'hi' }];

async function compatibleRuntime(baseUrl = 'https://vllm.internal/v1') {
  return OpenAiCompatibleModelProviderContract.createRuntime({
    tenantId: 't1',
    providerKey: 'p1',
    credentials: { apiKey: 'sk-test' },
    settings: { baseUrl },
    metadata: {},
    logger: console,
  } as never) as ModelProviderRuntime;
}

/** The request body an OpenAI-compatible native client puts on the wire for these model settings. */
async function sentBody(modelSettings: Record<string, unknown>, modelId = 'qwen3-32b', options: { maxRetries?: number } = { maxRetries: 0 }) {
  const upstream = stubUpstream(() => json(completion()));
  const client = await (await compatibleRuntime()).createNativeChatClient!({ modelId, category: 'llm', modelSettings, options });
  await client.complete({ messages: ASK });
  return upstream.calls[0].body;
}

describe('resolveOverrides - sampling parameters reach the provider', () => {
  it('forwards top_p and the penalties, which used to be collected and discarded', async () => {
    const body = await sentBody({
      temperature: 0.4,
      topP: 0.8,
      presencePenalty: 0.5,
      frequencyPenalty: 0.25,
      maxTokens: 512,
    });

    expect(body.temperature).toBe(0.4);
    expect(body.top_p).toBe(0.8);
    expect(body.presence_penalty).toBe(0.5);
    expect(body.frequency_penalty).toBe(0.25);
    expect(body.max_tokens).toBe(512);
  });

  it('leaves the provider no retry budget when the caller owns retry', async () => {
    // Nested in withResilience's 3 attempts, the provider's own retries would
    // be up to 9 upstream calls, 6 of them invisible to the circuit breaker.
    const upstream = stubUpstream(() => new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'retry-after': '0' } }));
    const client = await (await compatibleRuntime()).createNativeChatClient!({ modelId: 'qwen3-32b', category: 'llm', options: { maxRetries: 0 } });
    await expect(client.complete({ messages: ASK })).rejects.toBeDefined();
    expect(upstream.calls).toHaveLength(1);
  });

  it('keeps a small retry budget for callers outside withResilience', async () => {
    const upstream = stubUpstream(() => new Response('{"error":{"message":"boom"}}', { status: 500, headers: { 'retry-after': '0' } }));
    const client = await (await compatibleRuntime()).createNativeChatClient!({ modelId: 'qwen3-32b', category: 'llm' });
    await expect(client.complete({ messages: ASK })).rejects.toBeDefined();
    expect(upstream.calls).toHaveLength(3);
  });
});

describe('unsupportedParams - models that reject a parameter outright', () => {
  it('drops temperature so it never reaches the wire', async () => {
    const body = await sentBody({ temperature: 0.2, unsupportedParams: ['temperature'] });
    expect(body).not.toHaveProperty('temperature');
  });

  it('accepts the provider wire name in any case, and camelCase too', async () => {
    const body = await sentBody({ temperature: 0.2, topP: 0.9, unsupportedParams: ['TEMPERATURE', 'top_p'] });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('sends max_completion_tokens for a model id no name rule would rename', async () => {
    const body = await sentBody({ maxTokens: 4096, unsupportedParams: ['max_tokens'] }, 'luna-prod');

    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('sends max_completion_tokens when the model id already triggers the rename', async () => {
    const body = await sentBody({ maxTokens: 4096, unsupportedParams: ['max_tokens'] }, 'gpt-5.6-luna');

    expect(body.max_completion_tokens).toBe(4096);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('still gives Bedrock a token cap when max_tokens is declared unsupported', async () => {
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

    expect(upstream.calls[0].body.inferenceConfig.maxTokens).toBe(2048);
  });

  it('turns off stream usage when the upstream rejects stream_options', async () => {
    const streamed = async (modelSettings: Record<string, unknown>) => {
      const upstream = stubUpstream(() => sse([chunk.text('hi'), chunk.finish('stop')]));
      const client = await (await compatibleRuntime()).createNativeChatClient!({ modelId: 'qwen3-32b', category: 'llm', modelSettings, options: { maxRetries: 0 } });
      for await (const part of client.stream({ messages: ASK })) void part;
      return upstream.calls[0].body;
    };
    expect(await streamed({ unsupportedParams: ['stream_options'] })).not.toHaveProperty('stream_options');
    expect((await streamed({})).stream_options).toEqual({ include_usage: true });
  });

  it('ignores names it does not recognise instead of throwing', async () => {
    const body = await sentBody({ temperature: 0.3, unsupportedParams: ['not_a_real_param', 42 as unknown as string] });
    expect(body.temperature).toBe(0.3);
  });
});

describe('extra request body - parameters outside the OpenAI schema', () => {
  it('merges the resolved extraBody into the upstream body', async () => {
    const body = await sentBody({ extraBody: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 } });

    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.top_k).toBe(20);
  });

  it('falls back to the model-level requestDefaults for callers that build a runtime directly', async () => {
    // Agents, OCR and evaluations pass `model.settings` straight through.
    const body = await sentBody({ requestDefaults: { top_k: 40 } });

    expect(body.top_k).toBe(40);
  });

  it('routes Bedrock through additionalModelRequestFields', async () => {
    const upstream = stubUpstream(() => json({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const client = await (await bedrockRuntime()).createNativeChatClient!({
      modelId: 'anthropic.claude-3',
      category: 'llm',
      modelSettings: { extraBody: { anthropic_beta: ['x'] } },
      options: { maxRetries: 0 },
    });
    await client.complete({ messages: ASK });

    expect(upstream.calls[0].body.additionalModelRequestFields).toEqual({ anthropic_beta: ['x'] });
  });
});

describe('automatic detection — the drop_params equivalent', () => {
  it('knows the OpenAI reasoning families, per driver', () => {
    expect(detectUnsupportedParams('openai', 'o3-mini').params).toContain('temperature');
    expect(detectUnsupportedParams('azure', 'gpt-5.6-luna').params).toContain('temperature');
    expect(detectUnsupportedParams('openai-compatible', 'gpt-5.6-luna').params)
      .toEqual(expect.arrayContaining(['temperature', 'top_p', 'max_tokens']));
  });

  it('leaves the non-reasoning gpt-5 variant alone', () => {
    expect(detectUnsupportedParams('openai', 'gpt-5-chat-latest').params).toEqual([]);
  });

  it('says nothing about models and drivers it does not know', () => {
    expect(detectUnsupportedParams('openai-compatible', 'qwen3-32b').params).toEqual([]);
    expect(detectUnsupportedParams('bedrock', 'gpt-5.6-luna').params).toEqual([]);
    expect(detectUnsupportedParams(undefined, undefined).params).toEqual([]);
  });

  it('drops a detected parameter with no operator configuration at all', async () => {
    const body = await sentBody({ temperature: 0.2 }, 'gpt-5.6-luna');
    expect(body).not.toHaveProperty('temperature');
  });

  it('unions detection with the operator list rather than replacing it', () => {
    const { params } = resolveUnsupportedParamNames({
      driver: 'openai',
      modelId: 'gpt-5.6-luna',
      manual: ['frequency_penalty', 'temperature'],
    });

    expect(params).toEqual(expect.arrayContaining([
      'temperature', 'top_p', 'max_tokens', 'frequency_penalty',
    ]));
    // temperature appears in both sources but only once in the result
    expect(params.filter((p) => p === 'temperature')).toHaveLength(1);
  });

  it('can be switched off per model, leaving only the manual list', () => {
    const { params } = resolveUnsupportedParamNames({
      driver: 'openai',
      modelId: 'gpt-5.6-luna',
      manual: ['frequency_penalty'],
      autoDetect: false,
    });

    expect(params).toEqual(['frequency_penalty']);
  });

  it('honours the per-model opt-out in the request hook, so the gateway adds no stripping of its own', () => {
    const request = () => ({ model: 'gpt-5.6-luna', messages: [], temperature: 0.2 });
    const strip = (settings: Record<string, unknown>) =>
      buildTransformRequest({ driver: 'openai-compatible', modelId: 'gpt-5.6-luna', settings })(request() as never) as { temperature?: number };
    expect(strip({ autoDropUnsupportedParams: false }).temperature).toBe(0.2);
    expect(strip({}).temperature).toBeUndefined();
  });
});

describe('reasoning_effort + function tools — upstream 400s the combination', () => {
  // gpt-5.6-terra confirmed: "Function tools with reasoning_effort are not
  // supported ... To use function tools, use /v1/responses or set
  // reasoning_effort to 'none'." The console does not proxy /v1/responses, so
  // the gateway has to drop reasoning_effort itself whenever tools are present.
  it('is unaffected without tools', () => {
    expect(detectUnsupportedParams('openai', 'gpt-5.6-luna', false).params)
      .not.toContain('reasoning_effort');
  });

  it('is dropped once the call carries tools', () => {
    expect(detectUnsupportedParams('openai', 'gpt-5.6-luna', true).params)
      .toEqual(expect.arrayContaining(['reasoning', 'reasoning_effort']));
  });

  it('replaces the caller\'s reasoning_effort with "none" when tools are present', () => {
    const config = resolveModelInvocationConfig(
      { settings: {}, modelId: 'gpt-5.6-luna', providerDriver: 'openai' },
      {
        messages: [],
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'search' } }],
      },
    );

    // Omitting it entirely is NOT enough on a hosted upstream: Bedrock supplies
    // its own default and 400s the tool call anyway, so the caller's value is
    // stripped and the one value the upstream accepts is sent in its place.
    expect(config.modelSettings.reasoning).toBeUndefined();
    expect(config.modelSettings.extraBody).toMatchObject({ reasoning_effort: 'none' });
    expect(config.unsupportedParams).toEqual(expect.arrayContaining(['reasoning', 'reasoning_effort']));
  });

  it('still applies reasoning_effort on a tool-free call', () => {
    const config = resolveModelInvocationConfig(
      { settings: {}, modelId: 'gpt-5.6-luna', providerDriver: 'openai' },
      { messages: [], reasoning_effort: 'high' },
    );

    expect(config.modelSettings.reasoning).toEqual({ effort: 'high' });
  });

  it('reaches the provider as reasoning_effort "none" once bound to a real gpt-5 model id', async () => {
    const { modelSettings } = resolveModelInvocationConfig(
      { settings: {}, modelId: 'gpt-5.6-luna', providerDriver: 'openai-compatible' },
      {
        messages: [],
        reasoning_effort: 'high',
        tools: [{ type: 'function', function: { name: 'search' } }],
      },
    );

    const body = await sentBody(modelSettings as Record<string, unknown>, 'gpt-5.6-luna');

    expect(body.reasoning_effort).toBe('none');
  });
});

describe('buildPassthroughBody — what a caller may add to the upstream body', () => {
  const settings = (extra: Record<string, unknown> = {}) => ({
    requestDefaults: { chat_template_kwargs: { enable_thinking: false, tool_prompt: 'x' } },
    allowUnknownPassthrough: true,
    ...extra,
  });

  it('merges nested objects one level deep, from the top level and from extra_body alike', () => {
    const fromTop = resolveModelInvocationConfig({ settings: settings() }, {
      messages: [],
      chat_template_kwargs: { enable_thinking: true },
    }).extraBody;

    const fromExtraBody = resolveModelInvocationConfig({ settings: settings() }, {
      messages: [],
      extra_body: { chat_template_kwargs: { enable_thinking: true } },
    }).extraBody;

    const expected = { chat_template_kwargs: { enable_thinking: true, tool_prompt: 'x' } };
    expect(fromTop).toEqual(expected);
    expect(fromExtraBody).toEqual(expected);
  });

  it('never forwards the literal extra_body key — upstreams 400 on it', () => {
    const extraBody = resolveModelInvocationConfig({ settings: settings() }, {
      messages: [],
      extra_body: { top_k: 10 },
    }).extraBody;

    expect(extraBody).not.toHaveProperty('extra_body');
    expect(extraBody).toMatchObject({ top_k: 10 });
  });

  it('does not let a caller re-introduce a parameter the model declared unsupported', () => {
    const extraBody = resolveModelInvocationConfig(
      { settings: settings({ unsupportedParams: ['temperature', 'stream_options'] }) },
      {
        messages: [],
        stream_options: { include_usage: true },
        extra_body: { temperature: 0.9 },
      },
    ).extraBody;

    expect(extraBody).not.toHaveProperty('temperature');
    expect(extraBody).not.toHaveProperty('stream_options');
  });

  it('does not let a caller override gateway-owned routing fields', () => {
    const extraBody = resolveModelInvocationConfig({ settings: settings() }, {
      messages: [],
      model: 'someone-elses-model',
      stream: true,
      extra_body: { base_url: 'https://attacker.example' },
    }).extraBody;

    expect(extraBody).not.toHaveProperty('model');
    expect(extraBody).not.toHaveProperty('stream');
    expect(extraBody).not.toHaveProperty('base_url');
  });

  it('drops reserved keys an operator managed to store in requestDefaults', () => {
    const extraBody = resolveModelInvocationConfig(
      { settings: { requestDefaults: { model: 'pinned', top_k: 5 } } },
      { messages: [] },
    ).extraBody;

    expect(extraBody).toEqual({ top_k: 5 });
  });

  it('forwards nothing from the caller unless the model opts in', () => {
    const extraBody = resolveModelInvocationConfig(
      { settings: { requestDefaults: { top_k: 5 } } },
      { messages: [], repetition_penalty: 1.05 },
    ).extraBody;

    expect(extraBody).toEqual({ top_k: 5 });
  });
});

describe('normalizeModelSettings — heals rows the edit form corrupted', () => {
  it('restores numbers that were persisted as strings', () => {
    expect(normalizeModelSettings({ temperature: '0.7', maxTokens: '512' })).toEqual({
      temperature: 0.7,
      maxTokens: 512,
    });
  });

  it('restores structured config that was persisted as JSON text', () => {
    const normalized = normalizeModelSettings({
      dynamic: '{"strategy":"rule-based"}',
      requestDefaults: '{"top_k":20}',
      unsupportedParams: '["temperature"]',
    });

    expect(normalized.dynamic).toEqual({ strategy: 'rule-based' });
    expect(normalized.requestDefaults).toEqual({ top_k: 20 });
    expect(normalized.unsupportedParams).toEqual(['temperature']);
  });

  it('leaves values that are already the right type, and genuine strings, alone', () => {
    const settings = {
      temperature: 0.5,
      ocr: { prompt: 'read this' },
      organization: 'org-123',
    };
    expect(normalizeModelSettings(settings)).toEqual(settings);
  });

  it('does not turn an empty string into 0 — that would pin temperature at 0', () => {
    expect(normalizeModelSettings({ temperature: '' }).temperature).toBe('');
  });
});

describe('buildCacheVariantKey — parameters take part in the cache key', () => {
  it('separates requests that differ only in a passthrough parameter', () => {
    const thinkingOff = buildCacheVariantKey({
      chat_template_kwargs: { enable_thinking: false },
    });
    const thinkingOn = buildCacheVariantKey({
      chat_template_kwargs: { enable_thinking: true },
    });

    expect(thinkingOff).not.toBe(thinkingOn);
  });

  it('is stable regardless of key order', () => {
    expect(buildCacheVariantKey({ a: 1, b: 2 })).toBe(buildCacheVariantKey({ b: 2, a: 1 }));
  });

  it('collapses to a shared key when nothing was specified', () => {
    expect(buildCacheVariantKey({})).toBe('default');
    expect(buildCacheVariantKey(undefined)).toBe('default');
  });
});

describe('gateway-namespaced model ids', () => {
  // Bedrock, Vertex and friends serve the same model under a namespaced id.
  // Every rule in the registry is anchored at the start of the model id, so
  // without suffix matching none of them fired for a hosted deployment and the
  // request went out with parameters the upstream rejects.
  it('detects a rule through a vendor/region prefix', () => {
    const bare = detectUnsupportedParams('openai-compatible', 'gpt-5.6-terra', true);
    const namespaced = detectUnsupportedParams('openai-compatible', 'global.openai.gpt-5.6-terra', true);
    expect(namespaced.ruleId).toBe('openai-gpt-5');
    expect(namespaced.params).toEqual(bare.params);
  });

  it('forces reasoning_effort:"none" for a gpt-5 call that carries tools', () => {
    // Bedrock 400s on a gpt-5 tool call even when the request omits
    // reasoning_effort entirely, so dropping it is not enough.
    const withTools = detectUnsupportedParams('openai-compatible', 'global.openai.gpt-5.6-terra', true);
    expect(withTools.forced).toEqual({ reasoning_effort: 'none' });

    const withoutTools = detectUnsupportedParams('openai-compatible', 'global.openai.gpt-5.6-terra', false);
    expect(withoutTools.forced).toBeUndefined();
  });

  it('never splits a dotted version inside the model name itself', () => {
    // `gpt-5.6-terra` must not be peeled down to `6-terra`.
    expect(detectUnsupportedParams('openai-compatible', 'gpt-5.6-terra', false).ruleId).toBe('openai-gpt-5');
  });

  it('leaves a namespaced model with no rule alone', () => {
    expect(detectUnsupportedParams('openai-compatible', 'qwen.qwen3-32b-v1:0', true).params).toEqual([]);
    expect(detectUnsupportedParams('openai-compatible', 'zai.glm-4.7-flash', true).params).toEqual([]);
  });
});
