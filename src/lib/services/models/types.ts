import type { IModel, IModelPricing, IModelReplica, ISemanticCacheConfig, ModelCategory } from '@/lib/database';
import type { IGuardrailBinding } from '@/lib/database/provider/types.domain';
import type { ProviderCapabilityFlags } from '@/lib/providers';
import type {
  CreateProviderConfigInput,
  ProviderConfigView,
} from '@/lib/services/providers/providerService';
import type { ModelCapabilityOverrides } from './modelCapabilities';

/**
 * Deliberately carries NO guardrail field, neither `guardrails` nor the two
 * deprecated keys: `createModel` builds its record field by field and does not
 * spread this payload, so a `guardrails` accepted here would be dropped on the
 * floor while the create call reported 201 — a binding an operator watched
 * themselves set and that never existed. Both create routes match (`POST
 * /models`, `POST /client/v1/models` send neither key).
 *
 * A model is therefore created first and bound after, through `UpdateModelInput`
 * below, which is the one write path the validation and the legacy projection
 * live on.
 */
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
  capabilities?: ModelCapabilityOverrides;
  semanticCache?: ISemanticCacheConfig;
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
  capabilities?: ModelCapabilityOverrides | null;
  semanticCache?: ISemanticCacheConfig;
  /**
   * Multi-guardrail binding. Authoritative when present: `resolveBindings`
   * ignores the two deprecated keys below, so a save that writes this array
   * must also project it back onto them (`legacyGuardrailSlots`) or an older
   * console binary on the same tenant DB stops enforcing.
   */
  guardrails?: IGuardrailBinding[];
  /**
   * Replica pool — interchangeable deployments of this same model. An empty
   * array clears the pool and returns the model to its own
   * `providerKey`/`modelId`.
   */
  replicas?: IModelReplica[];
  /** @deprecated Use `guardrails`. Kept as the read fallback for legacy rows. */
  inputGuardrailKey?: string;
  /** @deprecated Use `guardrails`. Kept as the read fallback for legacy rows. */
  outputGuardrailKey?: string;
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
