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
 *  - LangChain's own retries nested inside `withResilience`.
 */

import { describe, it, expect, vi } from 'vitest';

const constructed: Array<Record<string, unknown>> = [];

vi.mock('@langchain/openai', () => {
  class FakeChatOpenAI {
    constructor(fields: Record<string, unknown>) {
      constructed.push(fields);
    }
    invoke = vi.fn();
    stream = vi.fn();
  }
  class FakeOpenAIEmbeddings {
    embedDocuments = vi.fn();
  }
  return {
    ChatOpenAI: FakeChatOpenAI,
    AzureChatOpenAI: FakeChatOpenAI,
    OpenAIEmbeddings: FakeOpenAIEmbeddings,
    AzureOpenAIEmbeddings: FakeOpenAIEmbeddings,
  };
});

vi.mock('@langchain/community/chat_models/togetherai', () => ({
  ChatTogetherAI: class {
    constructor(fields: Record<string, unknown>) {
      constructed.push(fields);
    }
    invoke = vi.fn();
  },
}));
vi.mock('@langchain/community/embeddings/togetherai', () => ({
  TogetherAIEmbeddings: class {},
}));
vi.mock('@langchain/aws', () => ({
  ChatBedrockConverse: class {
    constructor(fields: Record<string, unknown>) {
      constructed.push(fields);
    }
    invoke = vi.fn();
  },
  BedrockEmbeddings: class {},
}));
vi.mock('@langchain/google-vertexai', () => ({
  ChatVertexAI: class {
    constructor(fields: Record<string, unknown>) {
      constructed.push(fields);
    }
    invoke = vi.fn();
  },
  VertexAIEmbeddings: class {},
}));

import {
  OpenAiCompatibleModelProviderContract,
  BedrockModelProviderContract,
} from '@/lib/providers/contracts/modelContracts';
import type { ModelProviderRuntime } from '@/lib/providers/domains/model';
import { normalizeModelSettings } from '@/lib/services/models/modelSettings';
import { resolveModelInvocationConfig } from '@/lib/services/models/inferenceService';
import {
  detectUnsupportedParams,
  resolveUnsupportedParamNames,
} from '@/lib/providers/unsupportedParams';
import { buildCacheVariantKey } from '@/lib/services/models/semanticCacheService';

function buildOpenAiCompatibleChat(modelSettings: Record<string, unknown>, modelId = 'qwen3-32b') {
  constructed.length = 0;
  const runtime = OpenAiCompatibleModelProviderContract.createRuntime({
    tenantId: 't1',
    providerKey: 'p1',
    credentials: { apiKey: 'sk-test' },
    settings: { baseUrl: 'https://vllm.internal/v1' },
    metadata: {},
    logger: console,
  } as never) as ModelProviderRuntime;

  runtime.createChatModel!({
    modelId,
    category: 'llm',
    modelSettings,
    options: { maxRetries: 0 },
  });
  return constructed[0];
}

describe('resolveOverrides — sampling parameters reach the provider', () => {
  it('forwards top_p and the penalties, which used to be collected and discarded', () => {
    const fields = buildOpenAiCompatibleChat({
      temperature: 0.4,
      topP: 0.8,
      presencePenalty: 0.5,
      frequencyPenalty: 0.25,
      maxTokens: 512,
    });

    expect(fields.temperature).toBe(0.4);
    expect(fields.topP).toBe(0.8);
    expect(fields.presencePenalty).toBe(0.5);
    expect(fields.frequencyPenalty).toBe(0.25);
    expect(fields.maxTokens).toBe(512);
  });

  it('leaves LangChain no retry budget when the caller owns retry', () => {
    // AsyncCaller defaults to 6 retries; nested in withResilience's 3 attempts
    // that is up to 21 upstream calls, 18 invisible to the circuit breaker.
    expect(buildOpenAiCompatibleChat({}).maxRetries).toBe(0);
  });

  it('keeps a small retry budget for callers outside withResilience (agents)', () => {
    constructed.length = 0;
    const runtime = OpenAiCompatibleModelProviderContract.createRuntime({
      tenantId: 't1',
      providerKey: 'p1',
      credentials: { apiKey: 'sk-test' },
      settings: { baseUrl: 'https://vllm.internal/v1' },
      metadata: {},
      logger: console,
    } as never) as ModelProviderRuntime;

    runtime.createChatModel!({ modelId: 'qwen3-32b', category: 'llm', modelSettings: {} });

    expect(constructed[0].maxRetries).toBe(2);
  });
});

describe('unsupportedParams — models that reject a parameter outright', () => {
  it('drops temperature so it never reaches the wire', () => {
    const fields = buildOpenAiCompatibleChat({
      temperature: 0.2,
      unsupportedParams: ['temperature'],
    });

    // undefined, not 0 or 1 — JSON.stringify omits it, which is the whole point.
    expect(fields.temperature).toBeUndefined();
  });

  it('accepts the provider wire name in any case, and camelCase too', () => {
    const fields = buildOpenAiCompatibleChat({
      temperature: 0.2,
      topP: 0.9,
      unsupportedParams: ['TEMPERATURE', 'top_p'],
    });

    expect(fields.temperature).toBeUndefined();
    expect(fields.topP).toBeUndefined();
  });

  it('sends max_completion_tokens for a model id LangChain would not rename', () => {
    // LangChain collapses maxCompletionTokens/maxTokens into one property and
    // then picks the wire key from the model id alone (/^o\d/ or a gpt-5
    // prefix). For an Azure deployment or a vanity id the constructor field
    // cannot express the rename, so it has to ride in the request body — and
    // LangChain's own emission has to be silenced with its -1 sentinel.
    const fields = buildOpenAiCompatibleChat({
      maxTokens: 4096,
      unsupportedParams: ['max_tokens'],
    }, 'luna-prod');

    expect(fields.maxTokens).toBe(-1);
    expect(fields.maxCompletionTokens).toBe(-1);
    expect(fields.modelKwargs).toMatchObject({ max_completion_tokens: 4096 });
  });

  it('uses the constructor field when the model id already triggers the rename', () => {
    const fields = buildOpenAiCompatibleChat({
      maxTokens: 4096,
      unsupportedParams: ['max_tokens'],
    }, 'gpt-5.6-luna');

    expect(fields.maxCompletionTokens).toBe(4096);
    expect(fields.modelKwargs).toBeUndefined();
  });

  it('still gives Bedrock a token cap when max_tokens is declared unsupported', () => {
    constructed.length = 0;
    const runtime = BedrockModelProviderContract.createRuntime({
      tenantId: 't1',
      providerKey: 'p1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      settings: { region: 'us-east-1' },
      metadata: {},
      logger: console,
    } as never) as ModelProviderRuntime;

    runtime.createChatModel!({
      modelId: 'anthropic.claude-3',
      category: 'llm',
      modelSettings: { maxTokens: 2048, unsupportedParams: ['max_tokens'] },
    });

    expect(constructed[0].maxTokens).toBe(2048);
  });

  it('turns off stream usage when the upstream rejects stream_options', () => {
    expect(
      buildOpenAiCompatibleChat({ unsupportedParams: ['stream_options'] }).streamUsage,
    ).toBe(false);
    expect(buildOpenAiCompatibleChat({}).streamUsage).toBeUndefined();
  });

  it('ignores names it does not recognise instead of throwing', () => {
    const fields = buildOpenAiCompatibleChat({
      temperature: 0.3,
      unsupportedParams: ['not_a_real_param', 42 as unknown as string],
    });

    expect(fields.temperature).toBe(0.3);
  });
});

describe('extra request body — parameters outside the OpenAI schema', () => {
  it('passes the resolved extraBody to the provider as modelKwargs', () => {
    const fields = buildOpenAiCompatibleChat({
      extraBody: { chat_template_kwargs: { enable_thinking: false }, top_k: 20 },
    });

    expect(fields.modelKwargs).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      top_k: 20,
    });
  });

  it('falls back to the model-level requestDefaults for callers that build a runtime directly', () => {
    // Agents, OCR and evaluations pass `model.settings` straight through.
    const fields = buildOpenAiCompatibleChat({
      requestDefaults: { top_k: 40 },
    });

    expect(fields.modelKwargs).toEqual({ top_k: 40 });
  });

  it('routes Bedrock through additionalModelRequestFields, not modelKwargs', () => {
    constructed.length = 0;
    const runtime = BedrockModelProviderContract.createRuntime({
      tenantId: 't1',
      providerKey: 'p1',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      settings: { region: 'us-east-1' },
      metadata: {},
      logger: console,
    } as never) as ModelProviderRuntime;

    runtime.createChatModel!({
      modelId: 'anthropic.claude-3',
      category: 'llm',
      modelSettings: { extraBody: { anthropic_beta: ['x'] } },
    });

    expect(constructed[0].additionalModelRequestFields).toEqual({ anthropic_beta: ['x'] });
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

  it('drops a detected parameter with no operator configuration at all', () => {
    const fields = buildOpenAiCompatibleChat({ temperature: 0.2 }, 'gpt-5.6-luna');
    expect(fields.temperature).toBeUndefined();
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

  it('honours the per-model opt-out all the way to the provider', () => {
    const fields = buildOpenAiCompatibleChat(
      { temperature: 0.2, autoDropUnsupportedParams: false },
      'gpt-5.6-luna',
    );
    expect(fields.temperature).toBe(0.2);
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
