import type { IModel, IModelPricing, ModelCategory } from '@/lib/database';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type {
  CreateProviderConfigInput,
  ProviderConfigView,
} from '@/lib/services/providers/providerService';

export interface CreateModelInput {
  name: string;
  description?: string;
  key?: string;
  providerKey: string;
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
  category?: ModelCategory;
  providerKey?: string;
  providerDriver?: string;
  modelId?: string;
  pricing?: IModelPricing;
  settings?: Record<string, unknown>;
  isMultimodal?: boolean;
  supportsToolCalls?: boolean;
  metadata?: Record<string, unknown>;
}

export interface InvokeModelOptions {
  mode: 'chat' | 'embedding';
  payload: unknown;
}

export interface ModelInvocationResult {
  model: IModel;
  response: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalTokens?: number;
  };
  latencyMs?: number;
}

export type ModelProviderView = ProviderConfigView & {
  driverCapabilities?: ProviderCapabilityFlags;
};

export type CreateModelProviderInput = Omit<CreateProviderConfigInput, 'type'>;

export type ProviderCredentialFieldType = 'text' | 'password' | 'select';

export interface ProviderCredentialField {
  name: string;
  label: string;
  type: ProviderCredentialFieldType;
  required?: boolean;
  placeholder?: string;
  description?: string;
  options?: { label: string; value: string }[];
}

export interface ProviderDefinition {
  id: string;
  label: string;
  description: string;
  categories: ModelCategory[];
  credentialFields: ProviderCredentialField[];
  defaultPricingCurrency: string;
  supportsCustomBaseUrl?: boolean;
  modelIdHint?: string;
}
