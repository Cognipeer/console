import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { TogetherAIEmbeddings } from '@langchain/community/embeddings/togetherai';
import { ChatBedrockConverse } from '@langchain/aws';
import { BedrockEmbeddings } from '@langchain/community/embeddings/bedrock';
import { VertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
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

interface ModelSettingsOverrides {
  temperature?: number;
  maxTokens?: number;
}

function resolveOverrides(overrides?: Record<string, unknown>): ModelSettingsOverrides {
  const result: ModelSettingsOverrides = {};

  if (overrides && typeof overrides.temperature === 'number') {
    result.temperature = overrides.temperature;
  }

  if (overrides && typeof overrides.maxTokens === 'number') {
    result.maxTokens = overrides.maxTokens;
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
  domains: ['model'],
  display: {
    label: 'OpenAI',
    description: 'Official OpenAI platform supporting GPT and embedding models.',
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
          maxTokens: overrides.maxTokens,
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
  domains: ['model'],
  display: {
    label: 'OpenAI-Compatible',
    description: 'Any API that follows the OpenAI REST schema (Mistral, Groq, etc.).',
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
          maxTokens: overrides.maxTokens,
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
  domains: ['model'],
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
  domains: ['model'],
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
  domains: ['model'],
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
        return new VertexAI({
          model: config.modelId,
          project: projectId,
          location,
          authOptions,
          temperature: overrides.temperature,
          maxOutputTokens: overrides.maxTokens,
        });
      },
      createEmbeddingModel: (config) =>
        new VertexAIEmbeddings({
          model: config.modelId,
          project: projectId,
          location,
          authOptions,
        }),
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
] as unknown as ProviderContract<ModelProviderRuntime, unknown, unknown>[];
