import {
  IModel,
  IModelPricing,
  ModelCategory,
  ModelProviderType,
} from '@/lib/database';

export type CredentialFieldType = 'text' | 'password' | 'select';

export interface ProviderCredentialField {
  name: string;
  label: string;
  type: CredentialFieldType;
  required: boolean;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface ProviderModelOption {
  value: string;
  label: string;
  capabilities?: {
    multimodal?: boolean;
    toolCalls?: boolean;
  };
}

export interface ProviderDefinition {
  id: ModelProviderType;
  label: string;
  description: string;
  categories: ModelCategory[];
  credentialFields: ProviderCredentialField[];
  defaultPricingCurrency: string;
  modelIdHint?: string;
  supportsCustomBaseUrl?: boolean;
  options?: ProviderModelOption[];
}

export interface CreateModelInput {
  name: string;
  description?: string;
  key?: string;
  provider: ModelProviderType;
  category: ModelCategory;
  modelId: string;
  pricing: IModelPricing;
  settings: Record<string, unknown>;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateModelInput {
  name?: string;
  description?: string;
  key?: string;
  modelId?: string;
  pricing?: IModelPricing;
  settings?: Record<string, unknown>;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InvokeModelOptions {
  mode: 'chat' | 'embedding';
  payload: any;
}

export interface ModelInvocationResult {
  model: IModel;
  response: any;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
}
