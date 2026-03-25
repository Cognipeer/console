import type { ModelCategory } from '@/lib/database';

export type ModelRuntimeCategory = ModelCategory;

export interface ModelRuntimeOptions {
  streaming?: boolean;
}

export interface ModelRuntimeConfig {
  modelId: string;
  category: ModelRuntimeCategory;
  modelSettings?: Record<string, unknown>;
  options?: ModelRuntimeOptions;
}

export interface ModelProviderRuntime {
  createChatModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  createEmbeddingModel?(config: ModelRuntimeConfig): Promise<unknown> | unknown;
  getCapabilities?(): Record<string, unknown>;
}

export interface ModelProviderCapabilityFlags {
  'model.categories'?: ModelCategory[];
  'model.supports.tool_calls'?: boolean;
  'model.supports.streaming'?: boolean;
  'model.supports.multimodal'?: boolean;
  [key: string]: unknown;
}
