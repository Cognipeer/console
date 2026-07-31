import type { IModel } from '@/lib/database';
import {
  resolveModelCapabilities,
  type ResolvedModelCapabilities,
} from './modelCapabilities';

export type OpenAiModelListEntry = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name: string;
  context_length?: number;
  max_output_tokens?: number;
  category?: IModel['category'];
  supports_image_input?: boolean;
  supports_reasoning?: boolean;
  supports_structured_outputs?: boolean;
  supports_tool_calls?: boolean;
  architecture: {
    input_modalities: ResolvedModelCapabilities['inputModalities'];
    output_modalities: ResolvedModelCapabilities['outputModalities'];
  };
  cognipeer: {
    schema_version: ResolvedModelCapabilities['schemaVersion'];
    canonical_model_id: string;
    capabilities: Omit<ResolvedModelCapabilities, 'schemaVersion' | 'canonicalModelId'>;
  };
};

export type OpenAiModelListResponse = {
  object: 'list';
  data: OpenAiModelListEntry[];
};

export function toOpenAiModelListEntry(model: IModel): OpenAiModelListEntry {
  const capabilities = resolveModelCapabilities(model);
  const supportsImageInput = capabilities.inputModalities.includes('image');
  const {
    schemaVersion,
    canonicalModelId,
    ...capabilityMetadata
  } = capabilities;

  return {
    id: model.key,
    object: 'model',
    created: model.createdAt instanceof Date
      ? Math.floor(model.createdAt.getTime() / 1000)
      : 0,
    owned_by: 'cognipeer',
    name: model.name,
    ...(capabilities.contextWindow !== undefined
      ? { context_length: capabilities.contextWindow }
      : {}),
    ...(capabilities.maxOutputTokens !== undefined
      ? { max_output_tokens: capabilities.maxOutputTokens }
      : {}),
    category: model.category,
    supports_image_input: supportsImageInput,
    supports_reasoning: capabilities.supportsReasoning,
    supports_structured_outputs: capabilities.supportsStructuredOutputs,
    supports_tool_calls: capabilities.supportsToolCalls,
    architecture: {
      input_modalities: capabilities.inputModalities,
      output_modalities: capabilities.outputModalities,
    },
    cognipeer: {
      schema_version: schemaVersion,
      canonical_model_id: canonicalModelId,
      capabilities: capabilityMetadata,
    },
  };
}

export function toOpenAiModelListResponse(models: IModel[]): OpenAiModelListResponse {
  return {
    object: 'list',
    data: models
      .filter((model) => model.category === 'llm')
      .map(toOpenAiModelListEntry),
  };
}
