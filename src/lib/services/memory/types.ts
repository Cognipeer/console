import type {
  IMemoryStore,
  IMemoryItem,
  IMemoryStoreConfig,
  MemoryScope,
  MemorySource,
  MemoryStoreStatus,
  MemoryItemStatus,
} from '@/lib/database';

// ── Re-exports ───────────────────────────────────────────────────────────
export type { IMemoryStore, IMemoryItem, IMemoryStoreConfig };
export type {
  MemoryScope,
  MemorySource,
  MemoryStoreStatus,
  MemoryItemStatus,
};

// ── Service-level types ──────────────────────────────────────────────────

export interface CreateMemoryStoreRequest {
  name: string;
  description?: string;
  vectorProviderKey: string;
  embeddingModelKey: string;
  config?: Partial<IMemoryStoreConfig>;
  createdBy: string;
}

export interface UpdateMemoryStoreRequest {
  name?: string;
  description?: string;
  config?: Partial<IMemoryStoreConfig>;
  status?: MemoryStoreStatus;
  updatedBy: string;
}

export interface AddMemoryRequest {
  content: string;
  scope?: MemoryScope;
  scopeId?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  source?: MemorySource;
  importance?: number;
}

export interface UpdateMemoryRequest {
  content?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  status?: MemoryItemStatus;
}

export interface MemorySearchRequest {
  query: string;
  topK?: number;
  scope?: MemoryScope;
  scopeId?: string;
  tags?: string[];
  minScore?: number;
}

export interface MemorySearchMatch {
  id: string;
  content: string;
  score: number;
  scope: MemoryScope;
  scopeId?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  source?: MemorySource;
  importance: number;
  createdAt?: Date;
}

export interface MemorySearchResponse {
  memories: MemorySearchMatch[];
  query: string;
  storeKey: string;
}

export interface MemoryRecallRequest {
  query: string;
  topK?: number;
  scope?: MemoryScope;
  scopeId?: string;
  maxTokens?: number;
}

export interface MemoryRecallResponse {
  context: string;
  memories: MemorySearchMatch[];
  storeKey: string;
}

export interface ChatMemoryOptions {
  storeKey: string;
  autoRetrieve?: boolean;
  autoStore?: boolean;
  topK?: number;
  scope?: MemoryScope;
  scopeId?: string;
  minScore?: number;
}

export interface MemoryStoreView extends IMemoryStore {
  embeddingModelName?: string;
  vectorProviderLabel?: string;
}
