import { ChatOpenAI, OpenAIEmbeddings, AzureChatOpenAI, AzureOpenAIEmbeddings } from '@langchain/openai';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { TogetherAIEmbeddings } from '@langchain/community/embeddings/togetherai';
import { ChatOllama } from '@langchain/ollama';
import { OllamaEmbeddings } from '@langchain/ollama';
import { ChatBedrockConverse, BedrockEmbeddings } from '@langchain/aws';
import { VertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ProviderContract } from '../types';
import type { ModelProviderRuntime } from '../domains/model';

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

type OllamaCredentials = Record<string, never>;

interface OllamaSettings {
  baseUrl: string;
}

interface CognipeerLlmCredentials {
  url: string;
}

interface ModelSettingsOverrides {
  temperature?: number;
  maxTokens?: number;
  maxCompletionTokens?: number;
  reasoning?: {
    effort?: 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise';
  };
}

function resolveOverrides(overrides?: Record<string, unknown>): ModelSettingsOverrides {
  const result: ModelSettingsOverrides = {};

  if (overrides && typeof overrides.temperature === 'number') {
    result.temperature = overrides.temperature;
  }

  if (overrides && typeof overrides.maxTokens === 'number') {
    result.maxTokens = overrides.maxTokens;
  }

  if (overrides && typeof overrides.maxCompletionTokens === 'number') {
    result.maxCompletionTokens = overrides.maxCompletionTokens;
  }

  if (overrides && overrides.reasoning && typeof overrides.reasoning === 'object') {
    result.reasoning = overrides.reasoning as ModelSettingsOverrides['reasoning'];
  }

  return result;
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
  domains: ['model', 'embedding'],
  display: {
    label: 'OpenAI',
    description: 'Official OpenAI platform supporting GPT and embedding models.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.reasoning': true,
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

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings);
        return new ChatOpenAI({
          model: config.modelId,
          apiKey,
          configuration: settings.organization
            ? { organization: settings.organization }
            : undefined,
          temperature: overrides.temperature,
          // Use maxCompletionTokens for reasoning models (o1, o3, etc.), fallback to maxTokens
          maxCompletionTokens: overrides.maxCompletionTokens,
          maxTokens: overrides.maxTokens,
          reasoning: overrides.reasoning,
          streaming: config.options?.streaming ?? false,
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
    };

    return runtime;
  },
};

export const OpenAiCompatibleModelProviderContract: ProviderContract<ModelProviderRuntime, OpenAiCompatibleCredentials, OpenAiCompatibleSettings> = {
  id: 'openai-compatible',
  version: '1.0.0',
  domains: ['model', 'embedding'],
  display: {
    label: 'OpenAI-Compatible',
    description: 'Any API that follows the OpenAI REST schema (Mistral, Groq, etc.).',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.reasoning': true,
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
        const overrides = resolveOverrides(config.modelSettings);
        return new ChatOpenAI({
          model: config.modelId,
          apiKey,
          configuration: {
            baseURL: baseUrl,
            organization: settings.organization,
          },
          temperature: overrides.temperature,
          // Use maxCompletionTokens for reasoning models (o1, o3, etc.), fallback to maxTokens
          maxCompletionTokens: overrides.maxCompletionTokens,
          maxTokens: overrides.maxTokens,
          reasoning: overrides.reasoning,
          streaming: config.options?.streaming ?? false,
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
        const overrides = resolveOverrides(config.modelSettings);
        return new ChatTogetherAI({
          model: config.modelId,
          apiKey,
          temperature: overrides.temperature,
          maxTokens: overrides.maxTokens,
          streaming: config.options?.streaming ?? false,
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
  domains: ['model', 'embedding'],
  display: {
    label: 'Amazon Bedrock',
    description: 'Bedrock Converse API supporting Anthropic, AI21, and other models.',
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
        const overrides = resolveOverrides(config.modelSettings);
        return new ChatBedrockConverse({
          model: config.modelId,
          region,
          credentials: {
            accessKeyId,
            secretAccessKey,
            sessionToken: credentials.sessionToken,
          },
          temperature: overrides.temperature,
          maxTokens: overrides.maxTokens,
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
    };

    return runtime;
  },
};

export const VertexModelProviderContract: ProviderContract<ModelProviderRuntime, VertexCredentials, VertexSettings> = {
  id: 'vertex',
  version: '1.0.0',
  domains: ['model', 'embedding'],
  display: {
    label: 'Google Vertex AI',
    description: 'Vertex AI generative and embedding models using service accounts.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding'],
    'model.supports.tool_calls': true,
    'model.supports.streaming': true,
    'model.supports.multimodal': true,
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
        const overrides = resolveOverrides(config.modelSettings);
        // `project` is accepted at runtime but not in the published types
        return new VertexAI({
          model: config.modelId,
          location,
          authOptions,
          temperature: overrides.temperature,
          maxOutputTokens: overrides.maxTokens,
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
    };

    return runtime;
  },
};

// ─── Azure OpenAI ────────────────────────────────────────────────────────────

export const AzureModelProviderContract: ProviderContract<ModelProviderRuntime, AzureCredentials, AzureSettings> = {
  id: 'azure',
  version: '1.0.0',
  domains: ['model', 'embedding'],
  display: {
    label: 'Azure OpenAI',
    description: 'Microsoft Azure-hosted OpenAI models with deployment-based access.',
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
        const overrides = resolveOverrides(config.modelSettings);
        return new AzureChatOpenAI({
          model: config.modelId,
          azureOpenAIApiKey: apiKey,
          azureOpenAIApiInstanceName: instanceName,
          azureOpenAIApiDeploymentName: deploymentName,
          azureOpenAIApiVersion: apiVersion,
          temperature: overrides.temperature,
          maxTokens: overrides.maxTokens,
          streaming: config.options?.streaming ?? false,
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
    };

    return runtime;
  },
};

// ─── Ollama ──────────────────────────────────────────────────────────────────

export const OllamaModelProviderContract: ProviderContract<ModelProviderRuntime, OllamaCredentials, OllamaSettings> = {
  id: 'ollama',
  version: '1.0.0',
  domains: ['model', 'embedding'],
  display: {
    label: 'Ollama',
    description: 'Locally hosted open-source models via the Ollama runtime.',
  },
  capabilities: {
    'model.categories': ['llm', 'embedding'],
    'model.supports.tool_calls': false,
    'model.supports.streaming': true,
  },
  form: {
    sections: [
      {
        title: 'Settings',
        fields: [
          {
            name: 'baseUrl',
            label: 'Base URL',
            type: 'text',
            required: true,
            placeholder: 'http://localhost:11434',
            description: 'URL of the running Ollama server.',
            scope: 'settings',
          },
        ],
      },
    ],
  },
  createRuntime: ({ settings }) => {
    const baseUrl = ensureValue(settings.baseUrl, 'Ollama base URL is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: (config) => {
        const overrides = resolveOverrides(config.modelSettings);
        return new ChatOllama({
          model: config.modelId,
          baseUrl,
          temperature: overrides.temperature,
        });
      },
      createEmbeddingModel: (config) =>
        new OllamaEmbeddings({
          model: config.modelId,
          baseUrl,
        }),
    };

    return runtime;
  },
};

// ─── CognipeerLLM (custom HTTP chat endpoint) ────────────────────────────────

class CognipeerLlmModel extends SimpleChatModel {
  private readonly endpointUrl: string;

  constructor(endpointUrl: string) {
    super({});
    this.endpointUrl = endpointUrl;
  }

  _llmType(): string {
    return 'cognipeer-llm';
  }

  async _call(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<string> {
    void options;
    void runManager;

    const payload = messages.map((m) => ({
      role: m._getType() === 'human' ? 'user' : m._getType() === 'ai' ? 'assistant' : m._getType(),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const response = await fetch(`${this.endpointUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payload }),
    });

    if (!response.ok) {
      throw new Error(`CognipeerLLM request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { message?: { content?: string }; content?: string };
    const content = data?.message?.content ?? (data?.content as string | undefined) ?? '';
    return content.trim();
  }
}

export const CognipeerLlmModelProviderContract: ProviderContract<ModelProviderRuntime, CognipeerLlmCredentials, Record<string, never>> = {
  id: 'cognipeer-llm',
  version: '1.0.0',
  domains: ['model'],
  display: {
    label: 'Cognipeer LLM',
    description: 'Custom self-hosted LLM accessible via an HTTP chat endpoint.',
  },
  capabilities: {
    'model.categories': ['llm'],
    'model.supports.tool_calls': false,
    'model.supports.streaming': false,
  },
  form: {
    sections: [
      {
        title: 'Connection',
        fields: [
          {
            name: 'url',
            label: 'Endpoint URL',
            type: 'text',
            required: true,
            placeholder: 'http://localhost:8080',
            description: 'Base URL of the Cognipeer LLM server (without /api/chat).',
            scope: 'credentials',
          },
        ],
      },
    ],
  },
  createRuntime: ({ credentials }) => {
    const url = ensureValue(credentials.url, 'Cognipeer LLM endpoint URL is required.');

    const runtime: ModelProviderRuntime = {
      createChatModel: () => new CognipeerLlmModel(url),
    };

    return runtime;
  },
};

export const MODEL_PROVIDER_CONTRACTS = [
  OpenAiModelProviderContract,
  OpenAiCompatibleModelProviderContract,
  TogetherModelProviderContract,
  BedrockModelProviderContract,
  VertexModelProviderContract,
  AzureModelProviderContract,
] as unknown as ProviderContract<ModelProviderRuntime, unknown, unknown>[];