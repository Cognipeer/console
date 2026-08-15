import { ChatOpenAI, OpenAIEmbeddings, AzureChatOpenAI, AzureOpenAIEmbeddings } from '@langchain/openai';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { TogetherAIEmbeddings } from '@langchain/community/embeddings/togetherai';
import {
  ChatBedrockConverse,
  BedrockEmbeddings,
  type ChatBedrockConverseInput,
} from '@langchain/aws';
import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';
import { resolveUnsupportedParamNames } from '../unsupportedParams';
import {
  createOpenAiSttRuntime,
  createOpenAiTtsRuntime,
} from './openaiAudioHelpers';
import { createVlmOcrRuntime } from './vlmOcrHelpers';

interface OpenAiCredentials {
  apiKey: string;
}

interface OpenAiSettings {
  organization?: string;
}

interface OpenAiCompatibleCredentials {
  apiKey: string;
}

interface OpenAiCompatibleSettings {
  baseUrl: string;
  organization?: string;
}

interface TogetherCredentials {
  apiKey: string;
}

interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface BedrockSettings {
  region: string;
}

interface VertexCredentials {
  serviceAccountKey?: string;
}

interface VertexSettings {
  projectId: string;
  location: string;
}

interface AzureCredentials {
  apiKey: string;
}

interface AzureSettings {
  instanceName: string;
  deploymentName: string;
  apiVersion: string;
}

interface RerankCredentials {
  apiKey: string;
}

interface ModelSettingsOverrides {
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise';
  };
  /**
   * Merged verbatim into the upstream request body. This is how non-OpenAI-schema
   * parameters reach a self-hosted server — vLLM/SGLang take things like
   * `{ chat_template_kwargs: { enable_thinking: false } }`, `top_k` or
   * `repetition_penalty`, none of which exist in the OpenAI schema.
   */
  extraBody?: Record<string, unknown>;
  /** false when the model declares `stream_options` unsupported. */
  streamUsage?: boolean;
  /**
   * Suppresses LangChain's own token-cap emission (`maxTokens: -1` is its
   * documented "omit" sentinel) because we are supplying the renamed key
   * through `extraBody` instead. See `applyMaxTokensRename`.
   */
  suppressMaxTokens?: boolean;
}

/**
 * Mirrors `isReasoningModel` in @langchain/openai (dist/utils/misc.js) — the
 * predicate it uses to decide whether a chat request carries `max_tokens` or
 * `max_completion_tokens`. We need the same answer *before* constructing the
 * model, because the rename cannot be expressed through constructor fields:
 * `maxCompletionTokens` and `maxTokens` collapse into one property
 * (dist/chat_models/base.js:217) and the wire key is then chosen from the model
 * id alone (dist/chat_models/completions.js:58).
 */
function langChainEmitsCompletionTokens(modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (/^o\d/.test(modelId)) return true;
  return modelId.startsWith('gpt-5') && !modelId.startsWith('gpt-5-chat');
}

/**
 * Carries the token budget across when an operator declares `max_tokens`
 * unsupported.
 *
 * When the model id already makes LangChain emit `max_completion_tokens`, the
 * constructor field is enough. Otherwise LangChain would emit `max_tokens`
 * regardless of what we pass, so we silence it and put the renamed key in the
 * extra body, which is spread into the request verbatim. This is exactly the
 * case the setting exists for — an Azure deployment or a vanity model id whose
 * name does not match the provider-side regex.
 */
function applyMaxTokensRename(
  result: ModelSettingsOverrides,
  modelId: string | undefined,
): void {
  const budget = result.maxTokens;
  if (budget === undefined) return;

  result.maxCompletionTokens ??= budget;

  if (!langChainEmitsCompletionTokens(modelId)) {
    result.extraBody = { max_completion_tokens: budget, ...(result.extraBody ?? {}) };
    result.suppressMaxTokens = true;
  }
}

/**
 * Wire names an operator may list in a model's `settings.unsupportedParams`,
 * mapped to the internal override field they suppress.
 *
 * The keys are deliberately the names the *provider* uses in its 400 response
 * (OpenAI's reasoning family answers `Unsupported value: 'temperature' … Only
 * the default (1) is supported`), so an operator can paste what they saw
 * instead of translating it into our camelCase.
 */
const UNSUPPORTED_PARAM_ALIASES: Readonly<Record<string, keyof ModelSettingsOverrides | 'streamOptions'>> = {
  frequency_penalty: 'frequencyPenalty',
  frequencypenalty: 'frequencyPenalty',
  max_completion_tokens: 'maxCompletionTokens',
  maxcompletiontokens: 'maxCompletionTokens',
  max_tokens: 'maxTokens',
  maxtokens: 'maxTokens',
  presence_penalty: 'presencePenalty',
  presencepenalty: 'presencePenalty',
  reasoning: 'reasoning',
  reasoning_effort: 'reasoning',
  stream_options: 'streamOptions',
  streamoptions: 'streamOptions',
  temperature: 'temperature',
  top_p: 'topP',
  topp: 'topP',
};

/**
 * The parameters to strip for this call: what the capability registry knows
 * about the driver/model pair, plus the operator's own list. Names that the
 * registry does not map to an override field are still returned by
 * `resolveUnsupportedParamNames` — they are dropped from the passthrough body
 * upstream in `buildPassthroughBody` rather than here.
 */
function resolveUnsupportedParams(
  settings: Record<string, unknown>,
  modelId?: string,
  driver?: string,
): Set<string> {
  const { params } = resolveUnsupportedParamNames({
    driver,
    modelId,
    manual: settings.unsupportedParams,
    autoDetect: settings.autoDropUnsupportedParams,
  });

  const blocked = new Set<string>();
  for (const entry of params) {
    const mapped = UNSUPPORTED_PARAM_ALIASES[entry.toLowerCase()];
    if (mapped) blocked.add(mapped);
  }

  return blocked;
}

/**
 * Two upstream calls of slack when nobody else is retrying — enough to ride out
 * a transient 429/5xx for callers outside the gateway's `withResilience`.
 */
const DEFAULT_PROVIDER_RETRIES = 2;

function resolveMaxRetries(config: { options?: { maxRetries?: number } }): number {
  return config.options?.maxRetries ?? DEFAULT_PROVIDER_RETRIES;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? { ...record } : undefined;
}

function resolveOverrides(
  overrides?: Record<string, unknown>,
  modelId?: string,
  driver?: string,
): ModelSettingsOverrides {
  const result: ModelSettingsOverrides = {};

  if (!overrides) {
    return result;
  }

  const num = (key: string): number | undefined =>
    typeof overrides[key] === 'number' ? (overrides[key] as number) : undefined;

  result.temperature = num('temperature');
  result.topP = num('topP');
  result.presencePenalty = num('presencePenalty');
  result.frequencyPenalty = num('frequencyPenalty');
  result.maxTokens = num('maxTokens');
  result.maxCompletionTokens = num('maxCompletionTokens');

  if (overrides.reasoning && typeof overrides.reasoning === 'object') {
    result.reasoning = overrides.reasoning as ModelSettingsOverrides['reasoning'];
  }

  // `extraBody` is what the gateway resolved for this call (model defaults +
  // caller passthrough). `requestDefaults` is the raw model-level field, honoured
  // as a fallback so callers that build a runtime straight from `model.settings`
  // — agents, OCR, evaluations — still get the operator's defaults.
  result.extraBody = asPlainObject(overrides.extraBody) ?? asPlainObject(overrides.requestDefaults);

  const blocked = resolveUnsupportedParams(overrides, modelId, driver);
  if (blocked.size === 0) {
    return result;
  }

  if (blocked.has('maxTokens') && !blocked.has('maxCompletionTokens')) {
    applyMaxTokensRename(result, modelId);
  }

  if (blocked.has('streamOptions')) {
    result.streamUsage = false;
  }

  for (const field of blocked) {
    if (field === 'streamOptions') continue;
    delete result[field as keyof ModelSettingsOverrides];
  }

  return result;
}

/**
 * Constructor fields shared by every OpenAI-schema chat model (OpenAI, any
 * OpenAI-compatible base URL, Together, Azure). Undefined fields are dropped by
 * `JSON.stringify` on the way to the wire, which is what lets a stripped
 * parameter genuinely disappear from the request.
 */
function openAiChatOverrides(
  overrides: ModelSettingsOverrides,
  streaming: boolean,
  maxRetries: number,
) {
  return {
    // LangChain's own AsyncCaller retries 6 times by default. Nested inside the
    // gateway's 3-attempt `withResilience` that is up to 21 upstream calls per
    // request, 18 of them invisible to the circuit breaker, which then trips 7x
    // later than configured.
    maxRetries,
    temperature: overrides.temperature,
    topP: overrides.topP,
    presencePenalty: overrides.presencePenalty,
    frequencyPenalty: overrides.frequencyPenalty,
    // Use maxCompletionTokens for reasoning models (o1, o3, gpt-5, …), maxTokens otherwise.
    // `-1` is LangChain's "omit the cap" sentinel, used when the renamed key is
    // being supplied through the extra body instead.
    maxCompletionTokens: overrides.suppressMaxTokens ? -1 : overrides.maxCompletionTokens,
    maxTokens: overrides.suppressMaxTokens ? -1 : overrides.maxTokens,
    reasoning: overrides.reasoning,
    modelKwargs: overrides.extraBody,
    ...(overrides.streamUsage === false ? { streamUsage: false } : {}),
    streaming,
  };
}

function ensureValue(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(message);
  }
  return value.trim();
}

function parseServiceAccountKey(raw?: string) {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Google service account JSON: ${(error as Error).message}`);
  }
}

export const OpenAiModelProviderContract: ProviderContract<ModelProviderRuntime, OpenAiCredentials, OpenAiSettings> = {
  id: 'openai',
  version: '1.0.0',
  domains: ['model', 'embedding', 'stt', 'tts', 'ocr'],
  display: {
    label: 'OpenAI',
    description: 'Official OpenAI platform supporting GPT, embedding, audio (Whisper/TTS) and vision (VLM-OCR) models.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding', 'stt', 'tts', 'ocr'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.reasoning': true,
    'stt.supports.timestamps': true,
    'stt.supports.translate': true,
    'tts.voices': ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'],
    'tts.formats.output': ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'],
    'ocr.modes': ['vlm'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
            placeholder: 'sk-...'
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'organization',
            label: 'Organization ID',
            type: 'text',
            required: false,
            description: 'Optional OpenAI organization identifier.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const apiKey = ensureValue(credentials.apiKey, 'OpenAI API key is required.');
    const audioBase = 'https://api.openai.com/v1';

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'openai');
        return new ChatOpenAI({
          model: config.modelId,
          apiKey,
          configuration: settings.organization
            ? { organization: settings.organization }
            : undefined,
          ...openAiChatOverrides(overrides, config.options?.streaming ?? false, resolveMaxRetries(config)),
        });
      },
      createEmbeddingModel: (config) =>
        new OpenAIEmbeddings({
          model: config.modelId,
          apiKey,
          configuration: settings.organization
            ? { organization: settings.organization }
            : undefined,
        }),
      createSttRuntime: (config) =>
        createOpenAiSttRuntime({
          apiKey,
          baseUrl: audioBase,
          organization: settings.organization,
          modelId: config.modelId,
        }),
      createTtsRuntime: (config) =>
        createOpenAiTtsRuntime({
          apiKey,
          baseUrl: audioBase,
          organization: settings.organization,
          modelId: config.modelId,
        }),
      createOcrRuntime: (config) => {
        const prompt =
          typeof (config.modelSettings as Record<string, unknown> | undefined)?.ocr === 'object'
            ? ((config.modelSettings as Record<string, unknown>).ocr as Record<string, unknown>)
                .prompt
            : undefined;
        return createVlmOcrRuntime(
          runtime,
          config,
          typeof prompt === 'string' ? prompt : undefined,
        );
      },
    };

    return runtime;
  },
};

/**
 * Azure's OpenAI-compatible v1 endpoint (`https://<resource>.openai.azure.com/openai/v1`)
 * does not route `/audio/*` operations by the `model` body field — audio only
 * works deployment-scoped (`/openai/deployments/<deployment>/audio/*`), and
 * those endpoints authenticate with the `api-key` header rather than a Bearer
 * token. When the base URL points at Azure, rewrite audio URLs accordingly,
 * treating the model id as the deployment name.
 */
const AZURE_AUDIO_API_VERSION = '2025-03-01-preview';

function azureAudioOverrides(
  baseUrl: string,
  modelId: string,
  apiKey: string,
):
  | {
      buildUrl: (path: '/audio/transcriptions' | '/audio/translations' | '/audio/speech') => string;
      extraHeaders: Record<string, string>;
    }
  | undefined {
  const match = baseUrl.match(
    /^(https:\/\/[^/]+\.(?:openai\.azure\.com|cognitiveservices\.azure\.com))\/openai(?:\/v1)?\/?$/i,
  );
  if (!match) return undefined;
  return {
    buildUrl: (path) =>
      `${match[1]}/openai/deployments/${encodeURIComponent(modelId)}${path}?api-version=${AZURE_AUDIO_API_VERSION}`,
    extraHeaders: { 'api-key': apiKey },
  };
}

export const OpenAiCompatibleModelProviderContract: ProviderContract<ModelProviderRuntime, OpenAiCompatibleCredentials, OpenAiCompatibleSettings> = {
  id: 'openai-compatible',
  version: '1.0.0',
  domains: ['model', 'embedding', 'stt', 'tts', 'ocr'],
  display: {
    label: 'OpenAI-Compatible',
    description: 'Any API following the OpenAI REST schema (Mistral, Groq, Deepgram-OpenAI, ElevenLabs-OpenAI, …) including /v1/audio/* and VLM-based OCR.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding', 'rerank', 'stt', 'tts', 'ocr'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.reasoning': true,
    'ocr.modes': ['vlm'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
            placeholder: 'sk-...'
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: true,
            placeholder: 'https://api.your-provider.com/v1',
            description: 'Base URL for the OpenAI-compatible API.',
            scope: 'settings',
          },
          {
            name: 'organization',
            label: 'Organization',
            type: 'text',
            required: false,
            scope: 'settings',
            description: 'Optional organization or workspace identifier.',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const apiKey = ensureValue(credentials.apiKey, 'API key is required.');
    const baseUrl = ensureValue(settings.baseUrl, 'Base URL is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'openai-compatible');
        return new ChatOpenAI({
          model: config.modelId,
          apiKey,
          configuration: {
            baseURL: baseUrl,
            organization: settings.organization,
          },
          ...openAiChatOverrides(overrides, config.options?.streaming ?? false, resolveMaxRetries(config)),
        });
      },
      createEmbeddingModel: (config) =>
        new OpenAIEmbeddings({
          model: config.modelId,
          apiKey,
          configuration: {
            baseURL: baseUrl,
            organization: settings.organization,
          },
        }),
      createSttRuntime: (config) =>
        createOpenAiSttRuntime({
          apiKey,
          baseUrl,
          organization: settings.organization,
          modelId: config.modelId,
          ...azureAudioOverrides(baseUrl, config.modelId, apiKey),
        }),
      createTtsRuntime: (config) =>
        createOpenAiTtsRuntime({
          apiKey,
          baseUrl,
          organization: settings.organization,
          modelId: config.modelId,
          ...azureAudioOverrides(baseUrl, config.modelId, apiKey),
        }),
      createOcrRuntime: (config) => {
        const prompt =
          typeof (config.modelSettings as Record<string, unknown> | undefined)?.ocr === 'object'
            ? ((config.modelSettings as Record<string, unknown>).ocr as Record<string, unknown>)
                .prompt
            : undefined;
        return createVlmOcrRuntime(
          runtime,
          config,
          typeof prompt === 'string' ? prompt : undefined,
        );
      },
    };

    return runtime;
  },
};

export const TogetherModelProviderContract: ProviderContract<ModelProviderRuntime, TogetherCredentials, Record<string, never>> = {
  id: 'together',
  version: '1.0.0',
  domains: ['model', 'embedding'],
  display: {
    label: 'Together AI',
    description: 'Together AI APIs for hosted open models with tool calling support.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials }) => {
    const apiKey = ensureValue(credentials.apiKey, 'Together API key is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'together');
        return new ChatTogetherAI({
          model: config.modelId,
          apiKey,
          ...openAiChatOverrides(overrides, config.options?.streaming ?? false, resolveMaxRetries(config)),
        });
      },
      createEmbeddingModel: (config) =>
        new TogetherAIEmbeddings({
          model: config.modelId,
          apiKey,
        }),
    };

    return runtime;
  },
};

export const BedrockModelProviderContract: ProviderContract<ModelProviderRuntime, BedrockCredentials, BedrockSettings> = {
  id: 'bedrock',
  version: '1.0.0',
  domains: ['model', 'embedding', 'ocr'],
  display: {
    label: 'Amazon Bedrock',
    description: 'Bedrock Converse API (Anthropic, Nova, AI21, …) with vision support for VLM-mode OCR.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding', 'ocr'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'ocr.modes': ['vlm'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'accessKeyId',
            label: 'AWS Access Key ID',
            type: 'text',
            required: true,
          },
          {
            name: 'secretAccessKey',
            label: 'AWS Secret Access Key',
            type: 'password',
            required: true,
          },
          {
            name: 'sessionToken',
            label: 'AWS Session Token',
            type: 'password',
            required: false,
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'region',
            label: 'Region',
            type: 'select',
            required: true,
            options: [
              { label: 'us-east-1', value: 'us-east-1' },
              { label: 'us-west-2', value: 'us-west-2' },
              { label: 'eu-central-1', value: 'eu-central-1' },
              { label: 'ap-southeast-1', value: 'ap-southeast-1' },
            ],
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const accessKeyId = ensureValue(credentials.accessKeyId, 'AWS accessKeyId is required.');
    const secretAccessKey = ensureValue(credentials.secretAccessKey, 'AWS secretAccessKey is required.');
    const region = ensureValue(settings.region, 'AWS region is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'bedrock');
        return new ChatBedrockConverse({
          maxRetries: resolveMaxRetries(config),
          model: config.modelId,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
          temperature: overrides.temperature,
          topP: overrides.topP,
          // Converse carries model-specific parameters in its own envelope
          // rather than as top-level body fields. The cast is unavoidable:
          // Smithy types this as a recursive `DocumentType`, which plain
          // operator-supplied JSON does not structurally satisfy.
          additionalModelRequestFields:
            overrides.extraBody as ChatBedrockConverseInput['additionalModelRequestFields'],
          maxTokens: overrides.maxCompletionTokens ?? overrides.maxTokens,
          streaming: config.options?.streaming ?? false,
        });
      },
      createEmbeddingModel: (config) =>
        new BedrockEmbeddings({
          model: config.modelId,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
        }),
      createOcrRuntime: (config) => {
        const prompt =
          typeof (config.modelSettings as Record<string, unknown> | undefined)?.ocr === 'object'
            ? ((config.modelSettings as Record<string, unknown>).ocr as Record<string, unknown>)
                .prompt
            : undefined;
        return createVlmOcrRuntime(
          runtime,
          config,
          typeof prompt === 'string' ? prompt : undefined,
        );
      },
    };

    return runtime;
  },
};

export const VertexModelProviderContract: ProviderContract<ModelProviderRuntime, VertexCredentials, VertexSettings> = {
  id: 'vertex',
  version: '1.0.0',
  domains: ['model', 'embedding', 'ocr'],
  display: {
    label: 'Google Vertex AI',
    description: 'Vertex AI generative, embedding, and Gemini multimodal models (used for VLM-mode OCR).',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding', 'ocr'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.multimodal': true,
    'ocr.modes': ['vlm'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'serviceAccountKey',
            label: 'Service Account JSON',
            type: 'textarea',
            required: true,
            description: 'Service account key JSON with Vertex AI permissions.',
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'projectId',
            label: 'Project ID',
            type: 'text',
            required: true,
            scope: 'settings',
          },
          {
            name: 'location',
            label: 'Location',
            type: 'text',
            required: true,
            placeholder: 'us-central1',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const projectId = ensureValue(settings.projectId, 'Project ID is required.');
    const location = ensureValue(settings.location, 'Location is required.');
    const authOptions = parseServiceAccountKey(credentials.serviceAccountKey);

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'vertex');
        // `ChatVertexAI`, not `VertexAI`: the latter is a text-completion LLM
        // whose `.stream()` yields plain strings, so every streamed chunk came
        // out of the gateway as an empty delta.
        // `project` is accepted at runtime but not in the published types.
        return new ChatVertexAI({
          maxRetries: resolveMaxRetries(config),
          model: config.modelId,
          location,
          authOptions,
          temperature: overrides.temperature,
          topP: overrides.topP,
          maxOutputTokens: overrides.maxCompletionTokens ?? overrides.maxTokens,
          streaming: config.options?.streaming ?? false,
          ...({ project: projectId } as Record<string, unknown>),
        });
      },
      createEmbeddingModel: (config) =>
        new VertexAIEmbeddings({
          model: config.modelId,
          location,
          authOptions,
          ...({ project: projectId } as Record<string, unknown>),
        }),
      createOcrRuntime: (config) => {
        const prompt =
          typeof (config.modelSettings as Record<string, unknown> | undefined)?.ocr === 'object'
            ? ((config.modelSettings as Record<string, unknown>).ocr as Record<string, unknown>)
                .prompt
            : undefined;
        return createVlmOcrRuntime(
          runtime,
          config,
          typeof prompt === 'string' ? prompt : undefined,
        );
      },
    };

    return runtime;
  },
};

// ─── Azure OpenAI ────────────────────────────────────────────────────────────

export const AzureModelProviderContract: ProviderContract<ModelProviderRuntime, AzureCredentials, AzureSettings> = {
  id: 'azure',
  version: '1.0.0',
  domains: ['model', 'embedding', 'stt', 'tts', 'ocr'],
  display: {
    label: 'Azure OpenAI',
    description: 'Microsoft Azure-hosted OpenAI models with deployment-based access, including Whisper/TTS deployments.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding', 'stt', 'tts', 'ocr'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'ocr.modes': ['vlm'],
  },
  form: {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
          },
        ],
      },
      {
        title: 'Settings',
        fields: [
          {
            name: 'instanceName',
            label: 'Instance Name',
            type: 'text',
            required: true,
            placeholder: 'my-resource',
            description: 'Azure OpenAI resource name (subdomain of openai.azure.com).',
            scope: 'settings',
          },
          {
            name: 'deploymentName',
            label: 'Deployment Name',
            type: 'text',
            required: true,
            placeholder: 'gpt-4o-deployment',
            description: 'The deployment name created in Azure OpenAI Studio.',
            scope: 'settings',
          },
          {
            name: 'apiVersion',
            label: 'API Version',
            type: 'text',
            required: true,
            placeholder: '2024-08-01-preview',
            description: 'Azure OpenAI API version string.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials, settings }) => {
    const apiKey = ensureValue(credentials.apiKey, 'Azure OpenAI API key is required.');
    const instanceName = ensureValue(settings.instanceName, 'Azure OpenAI instance name is required.');
    const deploymentName = ensureValue(settings.deploymentName, 'Azure OpenAI deployment name is required.');
    const apiVersion = ensureValue(settings.apiVersion, 'Azure OpenAI API version is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings, config.modelId, 'azure');
        return new AzureChatOpenAI({
          model: config.modelId,
          azureOpenAIApiKey: apiKey,
          azureOpenAIApiInstanceName: instanceName,
          azureOpenAIApiDeploymentName: deploymentName,
          azureOpenAIApiVersion: apiVersion,
          ...openAiChatOverrides(overrides, config.options?.streaming ?? false, resolveMaxRetries(config)),
        });
      },
      createEmbeddingModel: (config) =>
        new AzureOpenAIEmbeddings({
          model: config.modelId,
          azureOpenAIApiKey: apiKey,
          azureOpenAIApiInstanceName: instanceName,
          azureOpenAIApiDeploymentName: deploymentName,
          azureOpenAIApiVersion: apiVersion,
        }),
      createSttRuntime: (config) =>
        createOpenAiSttRuntime({
          apiKey,
          baseUrl: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
          modelId: config.modelId,
          extraHeaders: { 'api-key': apiKey },
          buildUrl: (path) =>
            `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}${path}?api-version=${encodeURIComponent(apiVersion)}`,
        }),
      createTtsRuntime: (config) =>
        createOpenAiTtsRuntime({
          apiKey,
          baseUrl: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
          modelId: config.modelId,
          extraHeaders: { 'api-key': apiKey },
          buildUrl: (path) =>
            `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}${path}?api-version=${encodeURIComponent(apiVersion)}`,
        }),
      createOcrRuntime: (config) => {
        const prompt =
          typeof (config.modelSettings as Record<string, unknown> | undefined)?.ocr === 'object'
            ? ((config.modelSettings as Record<string, unknown>).ocr as Record<string, unknown>)
                .prompt
            : undefined;
        return createVlmOcrRuntime(
          runtime,
          config,
          typeof prompt === 'string' ? prompt : undefined,
        );
      },
    };

    return runtime;
  },
};

// ─── Dedicated rerank providers ──────────────────────────────────────────────
// These providers expose only the `rerank` category. Reranking bypasses the
// LangChain runtime entirely — it is executed directly against the provider's
// HTTP /rerank endpoint by `src/lib/services/reranker/rerankAdapter.ts`, keyed
// on the provider `driver` (which equals the contract `id`). The runtime factory
// therefore returns an empty runtime; no chat/embedding model is ever built for
// these providers.
const EMPTY_RERANK_RUNTIME: () => ModelProviderRuntime = () => ({});

function rerankCredentialForm(apiKeyLabel = 'API Key'): ProviderContract['form'] {
  return {
    sections: [
      {
        title: 'Credentials',
        fields: [
          {
            name: 'apiKey',
            label: apiKeyLabel,
            type: 'password',
            required: true,
          },
        ],
      },
    ],
  };
}

export const CohereModelProviderContract: ProviderContract<ModelProviderRuntime, RerankCredentials, Record<string, never>> = {
  id: 'cohere',
  version: '1.0.0',
  domains: ['model'],
  display: {
    label: 'Cohere',
    description: 'Cohere dedicated rerank models (rerank-v3.5, rerank-multilingual-v3.0).',
  },
  capabilities: {
    'model.categories': ['rerank'],
  },
  form: rerankCredentialForm(),
  createRuntime: EMPTY_RERANK_RUNTIME,
};

export const JinaAiModelProviderContract: ProviderContract<ModelProviderRuntime, RerankCredentials, Record<string, never>> = {
  id: 'jina-ai',
  version: '1.0.0',
  domains: ['model'],
  display: {
    label: 'Jina AI',
    description: 'Jina AI rerankers (jina-reranker-v2-base-multilingual).',
  },
  capabilities: {
    'model.categories': ['rerank'],
  },
  form: rerankCredentialForm(),
  createRuntime: EMPTY_RERANK_RUNTIME,
};

export const VoyageAiModelProviderContract: ProviderContract<ModelProviderRuntime, RerankCredentials, Record<string, never>> = {
  id: 'voyage-ai',
  version: '1.0.0',
  domains: ['model'],
  display: {
    label: 'Voyage AI',
    description: 'Voyage AI rerank models (rerank-2, rerank-2-lite).',
  },
  capabilities: {
    'model.categories': ['rerank'],
  },
  form: rerankCredentialForm(),
  createRuntime: EMPTY_RERANK_RUNTIME,
};

export const MODEL_PROVIDER_CONTRACTS = [
  OpenAiModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  TogetherModelProviderContract,
  BedrockModelProviderContract,
  VertexModelProviderContract,
  AzureModelProviderContract,
  CohereModelProviderContract,
  JinaAiModelProviderContract,
  VoyageAiModelProviderContract,
] as unknown as ProviderContract<ModelProviderRuntime, unknown, unknown>[];