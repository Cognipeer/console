import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { TogetherAIEmbeddings } from '@langchain/community/embeddings/togetherai';
import { ChatBedrockConverse } from '@langchain/aws';
import { BedrockEmbeddings } from '@langchain/community/embeddings/bedrock';
import { VertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai';
import { IModel } from '@/lib/database';

interface BuildChatModelOptions {
  streaming?: boolean;
}

export function buildChatModel(model: IModel, options?: BuildChatModelOptions) {
  const settings = model.settings || {};
  const common = {
    model: model.modelId,
    temperature: typeof settings.temperature === 'number' ? settings.temperature : undefined,
    maxTokens: typeof settings.maxTokens === 'number' ? settings.maxTokens : undefined,
  } as Record<string, unknown>;

  switch (model.provider) {
    case 'openai': {
      const configuration = settings.organization
        ? { organization: settings.organization }
        : undefined;

      return new ChatOpenAI({
        ...common,
        apiKey: settings.apiKey,
        configuration,
        streaming: options?.streaming ?? false,
      });
    }
    case 'openai-compatible': {
      const configuration = {
        baseURL: settings.baseUrl,
        organization: settings.organization,
      };

      return new ChatOpenAI({
        ...common,
        apiKey: settings.apiKey,
        configuration,
        streaming: options?.streaming ?? false,
      });
    }
    case 'together': {
      return new ChatTogetherAI({
        ...common,
        apiKey: settings.apiKey,
        streaming: options?.streaming ?? false,
      });
    }
    case 'bedrock': {
      const credentials = {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        sessionToken: settings.sessionToken,
      };

  return new ChatBedrockConverse({
        ...common,
        region: settings.region,
        credentials,
      });
    }
    case 'vertex': {
      let credentials;
      if (settings.serviceAccountKey) {
        credentials = JSON.parse(settings.serviceAccountKey);
      }

      return new VertexAI({
        ...common,
        authOptions: credentials,
        project: settings.projectId,
        location: settings.location,
      });
    }
    default:
      throw new Error(`Unsupported provider: ${model.provider}`);
  }
}

export function buildEmbeddingModel(model: IModel) {
  const settings = model.settings || {};
  switch (model.provider) {
    case 'openai': {
      const configuration = settings.organization
        ? { organization: settings.organization }
        : undefined;

      return new OpenAIEmbeddings({
        model: model.modelId,
        apiKey: settings.apiKey,
        configuration,
      });
    }
    case 'openai-compatible': {
      const configuration = {
        baseURL: settings.baseUrl,
        organization: settings.organization,
      };

      return new OpenAIEmbeddings({
        model: model.modelId,
        apiKey: settings.apiKey,
        configuration,
      });
    }
    case 'together':
      return new TogetherAIEmbeddings({
        model: model.modelId,
        apiKey: settings.apiKey,
      });
    case 'bedrock': {
      const credentials = {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        sessionToken: settings.sessionToken,
      };
      return new BedrockEmbeddings({
        model: model.modelId,
        region: settings.region,
        credentials,
      });
    }
    case 'vertex': {
      let credentials;
      if (settings.serviceAccountKey) {
        credentials = JSON.parse(settings.serviceAccountKey);
      }

      return new VertexAIEmbeddings({
        model: model.modelId,
        project: settings.projectId,
        location: settings.location,
        authOptions: credentials,
      });
    }
    default:
      throw new Error(`Unsupported provider for embeddings: ${model.provider}`);
  }
}
