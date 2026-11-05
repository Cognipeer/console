/**
 * Readers of the providers' "list models" answers, against the shapes the APIs return: OpenAI, OpenRouter, Together
 * (a bare array), Groq, Mistral, vLLM, Anthropic (paged), Azure deployments, Bedrock foundation models and inference
 * profiles, Cohere and Azure Document Intelligence. Odd shapes are read as far as they go and never throw.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultModelName,
  foundationModelIdOfArn,
  parseAnthropicModels,
  parseAzureDeployments,
  parseAzureDocumentModels,
  parseBedrockFoundationModels,
  parseBedrockInferenceProfiles,
  parseCohereModels,
  parseOpenAiCompatibleModels,
  parseOpenAiModels,
  parseTogetherModels,
} from '@/lib/services/models/catalog/parsers';

describe('OpenAI', () => {
  it('reads id, owner and creation time; infers the category', () => {
    const models = parseOpenAiModels({
      object: 'list',
      data: [
        { id: 'gpt-4o', object: 'model', created: 1715367049, owned_by: 'system' },
        { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'system' },
        { id: 'gpt-4o-realtime-preview', object: 'model', created: 1727659998, owned_by: 'system' },
      ],
    });
    expect(models).toEqual([
      { id: 'gpt-4o', name: 'gpt-4o', category: 'llm', ownedBy: 'system', createdAt: '2024-05-10T18:50:49.000Z' },
      { id: 'text-embedding-3-small', name: 'text-embedding-3-small', category: 'embedding', ownedBy: 'system', createdAt: '2024-01-22T18:43:17.000Z' },
      { id: 'gpt-4o-realtime-preview', name: 'gpt-4o-realtime-preview', category: null, ownedBy: 'system', createdAt: '2024-09-30T01:33:18.000Z' },
    ]);
  });

  it('skips non-string ids, trims, dedupes, and survives odd shapes', () => {
    expect(parseOpenAiModels({ data: [{ id: 42 }, { id: '  gpt-4o ' }, { id: 'gpt-4o' }, null, 'x', { id: '' }] }).map((m) => m.id))
      .toEqual(['gpt-4o']);
    expect(parseOpenAiModels(null)).toEqual([]);
    expect(parseOpenAiModels('<html>')).toEqual([]);
    expect(parseOpenAiModels({ data: 'nope' })).toEqual([]);
    expect(parseOpenAiModels({ data: [{ id: 'm', created: 'not a date' }] })[0].createdAt).toBeUndefined();
  });
});

describe('OpenAI-compatible servers', () => {
  it('OpenRouter: name, description, limits, per-token prices to per-1M, modalities, supported parameters', () => {
    const [model] = parseOpenAiCompatibleModels({
      data: [
        {
          id: 'openai/gpt-4o',
          canonical_slug: 'openai/gpt-4o',
          name: 'OpenAI: GPT-4o',
          created: 1715367049,
          description: 'GPT-4o ("o" for "omni") is OpenAI\'s latest AI model.\n\nIt supports text and image inputs.',
          context_length: 128000,
          architecture: {
            modality: 'text+image->text',
            input_modalities: ['text', 'image', 'file'],
            output_modalities: ['text'],
            tokenizer: 'GPT',
          },
          pricing: { prompt: '0.0000025', completion: '0.00001', request: '0', image: '0.003613', input_cache_read: '0.00000125' },
          top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: true },
          supported_parameters: ['tools', 'tool_choice', 'max_tokens', 'temperature', 'response_format', 'structured_outputs'],
        },
      ],
    });
    expect(model).toEqual({
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      description: 'GPT-4o ("o" for "omni") is OpenAI\'s latest AI model. It supports text and image inputs.',
      category: 'llm',
      createdAt: '2024-05-10T18:50:49.000Z',
      contextWindow: 128000,
      maxOutputTokens: 16384,
      inputModalities: ['text', 'image', 'file'],
      supportsToolCalls: true,
      supportsReasoning: false,
      supportsStructuredOutputs: true,
      pricing: { currency: 'USD', inputTokenPer1M: 2.5, outputTokenPer1M: 10, cachedTokenPer1M: 1.25, source: 'provider' },
    });
  });

  it('OpenRouter: a free model keeps its 0 price; a router\'s "-1" is no price; embeddings output is an embedding model', () => {
    const models = parseOpenAiCompatibleModels({
      data: [
        { id: 'meta-llama/llama-3.3-8b-instruct:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'openai/text-embedding-3-small', architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] } },
      ],
    });
    expect(models[0].pricing).toEqual({ currency: 'USD', inputTokenPer1M: 0, outputTokenPer1M: 0, source: 'provider' });
    expect(models[0]).toMatchObject({ supportsToolCalls: false, supportsReasoning: true, name: 'llama-3.3-8b-instruct:free' });
    expect(models[1].pricing).toBeUndefined();
    expect(models[2].category).toBe('embedding');
  });

  it('Groq: context_window, max_completion_tokens; an inactive model is marked deprecated', () => {
    const models = parseOpenAiCompatibleModels({
      object: 'list',
      data: [
        { id: 'llama-3.3-70b-versatile', object: 'model', created: 1733447754, owned_by: 'Meta', active: true, context_window: 131072, public_apps: null, max_completion_tokens: 32768 },
        { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI', active: true, context_window: 448 },
        { id: 'gemma-7b-it', object: 'model', owned_by: 'Google', active: false, context_window: 8192 },
      ],
    });
    expect(models[0]).toMatchObject({ category: 'llm', contextWindow: 131072, maxOutputTokens: 32768, ownedBy: 'Meta' });
    expect(models[1].category).toBe('stt');
    expect(models[2].deprecated).toBe(true);
  });

  it('Mistral: max_context_length, capabilities, deprecation; a model that cannot chat is not a chat model', () => {
    const models = parseOpenAiCompatibleModels({
      object: 'list',
      data: [
        {
          id: 'mistral-large-2411',
          object: 'model',
          created: 1732000000,
          owned_by: 'mistralai',
          capabilities: { completion_chat: true, completion_fim: false, function_calling: true, fine_tuning: true, vision: false, classification: false },
          name: 'mistral-large-2411',
          description: 'Official mistral-large-2411 Mistral AI model',
          max_context_length: 131072,
          aliases: ['mistral-large-latest'],
          deprecation: null,
          default_model_temperature: 0.7,
          type: 'base',
        },
        {
          id: 'pixtral-large-2411',
          capabilities: { completion_chat: true, function_calling: true, vision: true },
          max_context_length: 131072,
          deprecation: '2026-03-30T12:00:00Z',
          type: 'base',
        },
        { id: 'mistral-ocr-2505', capabilities: { completion_chat: false, ocr: true }, type: 'base' },
        { id: 'mistral-embed', capabilities: { completion_chat: false }, max_context_length: 8192, type: 'base' },
      ],
    });
    expect(models[0]).toMatchObject({ category: 'llm', contextWindow: 131072, supportsToolCalls: true, inputModalities: ['text'] });
    expect(models[0].deprecated).toBeUndefined();
    expect(models[1]).toMatchObject({ category: 'llm', inputModalities: ['text', 'image'], deprecated: true });
    expect(models[2].category).toBeNull();
    expect(models[3]).toMatchObject({ category: 'embedding', contextWindow: 8192 });
  });

  it('vLLM: max_model_len', () => {
    const [model] = parseOpenAiCompatibleModels({
      object: 'list',
      data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct', object: 'model', created: 1730000000, owned_by: 'vllm', root: 'meta-llama/Llama-3.1-8B-Instruct', parent: null, max_model_len: 131072 }],
    });
    expect(model).toMatchObject({ id: 'meta-llama/Llama-3.1-8B-Instruct', name: 'Llama-3.1-8B-Instruct', contextWindow: 131072, ownedBy: 'vllm' });
  });

  it('Gemini (OpenAI endpoint): ids carry a models/ path; the name drops it', () => {
    const [model] = parseOpenAiCompatibleModels({ object: 'list', data: [{ id: 'models/gemini-2.5-flash', object: 'model', owned_by: 'google' }] });
    expect(model).toMatchObject({ id: 'models/gemini-2.5-flash', name: 'gemini-2.5-flash', category: 'llm' });
  });
});

describe('Together', () => {
  it('reads the bare array: type, display name, organization, per-1M prices', () => {
    const models = parseTogetherModels([
      {
        id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        object: 'model',
        created: 1733443200,
        type: 'chat',
        display_name: 'Meta Llama 3.3 70B Instruct Turbo',
        organization: 'Meta',
        context_length: 131072,
        config: { chat_template: '...', stop: ['<|eot_id|>'] },
        pricing: { hourly: 0, input: 0.88, output: 0.88, base: 0, finetune: 0 },
      },
      { id: 'BAAI/bge-large-en-v1.5', type: 'embedding', display_name: 'BAAI-Bge-Large-1p5', pricing: { input: 0.02, output: 0 } },
      { id: 'Salesforce/Llama-Rank-V1', type: 'rerank', pricing: { input: 0.1, output: 0.1 } },
      { id: 'black-forest-labs/FLUX.1-schnell', type: 'image', pricing: { input: 0, output: 0 } },
      { id: 'cartesia/sonic', type: 'audio' },
      { id: 'openai/whisper-large-v3', type: 'transcribe' },
      { id: 'meta-llama/Llama-Guard-3-8B', type: 'moderation' },
      { id: 'some/video-model', type: 'video' },
    ]);
    expect(models[0]).toMatchObject({
      name: 'Meta Llama 3.3 70B Instruct Turbo',
      category: 'llm',
      ownedBy: 'Meta',
      contextWindow: 131072,
      pricing: { currency: 'USD', inputTokenPer1M: 0.88, outputTokenPer1M: 0.88, source: 'provider' },
    });
    expect(models.map((m) => m.category)).toEqual(['llm', 'embedding', 'rerank', 'image', 'tts', 'stt', 'moderation', null]);
    // Not billed per token: no price rather than a price of zero.
    expect(models[3].pricing).toBeUndefined();
  });

  it('also reads a `{ data: [...] }` answer', () => {
    expect(parseTogetherModels({ data: [{ id: 'x/y', type: 'chat' }] })).toHaveLength(1);
  });
});

describe('Anthropic', () => {
  it('reads display names, dates and the paging cursor', () => {
    const page = parseAnthropicModels({
      data: [
        { type: 'model', id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-22T00:00:00Z' },
        { type: 'model', id: 'claude-3-5-haiku-20241022', display_name: 'Claude Haiku 3.5', created_at: '2024-10-22T00:00:00Z', max_input_tokens: 200000, max_tokens: 8192 },
      ],
      has_more: true,
      first_id: 'claude-sonnet-4-20250514',
      last_id: 'claude-3-5-haiku-20241022',
    });
    expect(page.hasMore).toBe(true);
    expect(page.lastId).toBe('claude-3-5-haiku-20241022');
    expect(page.models[0]).toEqual({ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', category: 'llm', createdAt: '2025-05-22T00:00:00.000Z' });
    expect(page.models[1]).toMatchObject({ contextWindow: 200000, maxOutputTokens: 8192 });
    expect(parseAnthropicModels({})).toEqual({ models: [], hasMore: false, lastId: undefined });
  });
});

describe('Azure OpenAI deployments', () => {
  it('lists succeeded deployments by deployment name, with the model they serve deciding the category', () => {
    const models = parseAzureDeployments({
      data: [
        { scale_settings: { scale_type: 'standard' }, model: 'gpt-4o', owner: 'organization-owner', id: 'chat-prod', status: 'succeeded', created_at: 1715367049, object: 'deployment' },
        { model: 'text-embedding-3-large', id: 'embed', status: 'succeeded', object: 'deployment' },
        { model: 'whisper', id: 'speech-in', object: 'deployment' },
        { model: 'gpt-4o-mini', id: 'creating', status: 'running', object: 'deployment' },
        { model: 'gpt-4o', id: 'broken', status: 'failed', object: 'deployment' },
      ],
      object: 'list',
    });
    expect(models.map((m) => [m.id, m.category, m.upstreamModel])).toEqual([
      ['chat-prod', 'llm', 'gpt-4o'],
      ['embed', 'embedding', 'text-embedding-3-large'],
      ['speech-in', 'stt', 'whisper'],
    ]);
  });
});

describe('Bedrock', () => {
  const foundationBody = {
    modelSummaries: [
      {
        modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        modelName: 'Claude 3.5 Sonnet',
        providerName: 'Anthropic',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        responseStreamingSupported: true,
        customizationsSupported: [],
        inferenceTypesSupported: ['ON_DEMAND'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      {
        modelId: 'anthropic.claude-3-sonnet-20240229-v1:0:28k',
        modelName: 'Claude 3 Sonnet',
        providerName: 'Anthropic',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        inferenceTypesSupported: ['PROVISIONED'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      {
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        modelName: 'Claude Sonnet 4',
        providerName: 'Anthropic',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['TEXT'],
        inferenceTypesSupported: ['INFERENCE_PROFILE'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      {
        modelId: 'amazon.titan-embed-text-v2:0',
        modelName: 'Titan Text Embeddings V2',
        providerName: 'Amazon',
        inputModalities: ['TEXT'],
        outputModalities: ['EMBEDDING'],
        inferenceTypesSupported: ['ON_DEMAND'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      {
        modelId: 'stability.sd3-5-large-v1:0',
        modelName: 'Stable Diffusion 3.5 Large',
        providerName: 'Stability AI',
        inputModalities: ['TEXT', 'IMAGE'],
        outputModalities: ['IMAGE'],
        inferenceTypesSupported: ['ON_DEMAND'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      {
        modelId: 'anthropic.claude-v2:1',
        modelName: 'Claude',
        providerName: 'Anthropic',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        inferenceTypesSupported: ['ON_DEMAND'],
        modelLifecycle: { status: 'LEGACY' },
      },
      {
        modelId: 'cohere.rerank-v3-5:0',
        modelName: 'Rerank 3.5',
        providerName: 'Cohere',
        inputModalities: ['TEXT'],
        outputModalities: ['TEXT'],
        inferenceTypesSupported: ['ON_DEMAND'],
        modelLifecycle: { status: 'ACTIVE' },
      },
      { modelId: 42 },
    ],
  };

  it('ListFoundationModels: on-demand models only; text is chat, embedding output an embedding model, image output left out', () => {
    const { onDemand, byId } = parseBedrockFoundationModels(foundationBody);
    expect(onDemand.map((m) => [m.id, m.category])).toEqual([
      ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'llm'],
      ['amazon.titan-embed-text-v2:0', 'embedding'],
      ['stability.sd3-5-large-v1:0', null],
      ['anthropic.claude-v2:1', 'llm'],
      ['cohere.rerank-v3-5:0', 'rerank'],
    ]);
    expect(onDemand[0]).toMatchObject({ name: 'Claude 3.5 Sonnet', ownedBy: 'Anthropic', inputModalities: ['text', 'image'] });
    expect(onDemand[3]).toMatchObject({ deprecated: true, inputModalities: ['text'] });
    // The profile-only model is not listed by its own id, but known for the profiles.
    expect(byId.get('anthropic.claude-sonnet-4-20250514-v1:0')).toMatchObject({ category: 'llm', inputModalities: ['text', 'image'] });
  });

  it('ListInferenceProfiles: profile ids, with category and vision from the foundation model behind them', () => {
    const { byId } = parseBedrockFoundationModels(foundationBody);
    const page = parseBedrockInferenceProfiles(
      {
        inferenceProfileSummaries: [
          {
            inferenceProfileName: 'US Anthropic Claude Sonnet 4',
            description: 'Routes requests to Anthropic Claude Sonnet 4 in us-east-1, us-east-2 and us-west-2.',
            createdAt: '2025-05-20T00:00:00Z',
            updatedAt: '2025-05-20T00:00:00Z',
            inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0',
            models: [
              { modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0' },
              { modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0' },
            ],
            inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
            status: 'ACTIVE',
            type: 'SYSTEM_DEFINED',
          },
          {
            inferenceProfileName: 'US Meta Llama 4 Scout',
            models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/meta.llama4-scout-17b-instruct-v1:0' }],
            inferenceProfileId: 'us.meta.llama4-scout-17b-instruct-v1:0',
            status: 'ACTIVE',
            type: 'SYSTEM_DEFINED',
          },
          { inferenceProfileId: 'us.retired', status: 'INACTIVE', models: [] },
        ],
        nextToken: 'token-2',
      },
      byId,
    );
    expect(page.nextToken).toBe('token-2');
    expect(page.models).toHaveLength(2);
    expect(page.models[0]).toMatchObject({
      id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      name: 'US Anthropic Claude Sonnet 4',
      category: 'llm',
      upstreamModel: 'anthropic.claude-sonnet-4-20250514-v1:0',
      inputModalities: ['text', 'image'],
      ownedBy: 'Anthropic',
      createdAt: '2025-05-20T00:00:00.000Z',
    });
    // Not in the foundation list: read by its id.
    expect(page.models[1]).toMatchObject({ category: 'llm', upstreamModel: 'meta.llama4-scout-17b-instruct-v1:0' });
    expect(page.models[1].inputModalities).toBeUndefined();
  });

  it('reads the foundation model id of an ARN', () => {
    expect(foundationModelIdOfArn('arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
    expect(foundationModelIdOfArn('arn:aws:bedrock:us-east-1:1:inference-profile/x')).toBeUndefined();
  });
});

describe('Cohere', () => {
  it('keeps only the models served on the rerank endpoint', () => {
    const models = parseCohereModels({
      models: [
        { name: 'rerank-v3.5', endpoints: ['rerank'], finetuned: false, context_length: 4096, tokenizer_url: 'https://…', default_endpoints: [] },
        { name: 'command-r-plus', endpoints: ['generate', 'chat', 'summarize'], context_length: 128000 },
        { name: 'rerank-english-v2.0', endpoints: ['rerank'], is_deprecated: true },
      ],
      next_page_token: '',
    });
    expect(models).toEqual([
      { id: 'rerank-v3.5', name: 'rerank-v3.5', category: 'rerank', contextWindow: 4096 },
      { id: 'rerank-english-v2.0', name: 'rerank-english-v2.0', category: 'rerank', deprecated: true },
    ]);
  });
});

describe('Azure Document Intelligence', () => {
  it('lists document models as OCR models, with the next page link', () => {
    const page = parseAzureDocumentModels({
      value: [
        { modelId: 'prebuilt-read', description: 'Extract text from documents.', createdDateTime: '2024-11-30T00:00:00Z', apiVersion: '2024-11-30' },
        { modelId: 'my-custom-invoice', createdDateTime: '2025-01-02T03:04:05Z' },
      ],
      nextLink: 'https://my-di.cognitiveservices.azure.com/documentintelligence/documentModels?api-version=2024-11-30&$skipToken=abc',
    });
    expect(page.models).toEqual([
      { id: 'prebuilt-read', name: 'prebuilt-read', description: 'Extract text from documents.', category: 'ocr', createdAt: '2024-11-30T00:00:00.000Z' },
      { id: 'my-custom-invoice', name: 'my-custom-invoice', category: 'ocr', createdAt: '2025-01-02T03:04:05.000Z' },
    ]);
    expect(page.nextLink).toContain('$skipToken=abc');
  });
});

describe('defaultModelName', () => {
  it('is the id, without the path in front of it', () => {
    expect(defaultModelName('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(defaultModelName('meta-llama/Llama-3.3-70B')).toBe('Llama-3.3-70B');
    expect(defaultModelName('accounts/fireworks/models/llama-v3p1-8b-instruct')).toBe('llama-v3p1-8b-instruct');
    expect(defaultModelName('trailing/')).toBe('trailing/');
  });
});
