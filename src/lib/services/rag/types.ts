import type {
  IRagModule,
  IRagDocument,
  IRagQueryLog,
  RagChunkStrategy,
  IRagChunkConfig,
  RagDocumentStatus,
} from '@/lib/database';

export type { RagChunkStrategy, IRagChunkConfig, RagDocumentStatus };

export type RagModule = IRagModule;
export type RagDocument = IRagDocument;
export type RagQueryLog = IRagQueryLog;

export interface CreateRagModuleRequest {
  name: string;
  key?: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  rerankerKey?: string;
  rerankerOversample?: number;
  defaultTopK?: number;
  defaultMinScore?: number;
  defaultFilter?: Record<string, unknown>;
  filterableFields?: string[];
  responseDetail?: 'full' | 'text';
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateRagModuleRequest {
  name?: string;
  description?: string;
  embeddingModelKey?: string;
  vectorProviderKey?: string;
  vectorIndexKey?: string;
  chunkConfig?: IRagChunkConfig;
  status?: 'active' | 'disabled';
  rerankerKey?: string | null;
  rerankerOversample?: number | null;
  defaultTopK?: number | null;
  defaultMinScore?: number | null;
  defaultFilter?: Record<string, unknown> | null;
  filterableFields?: string[] | null;
  responseDetail?: 'full' | 'text' | null;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface RagIngestRequest {
  ragModuleKey: string;
  fileName: string;
  content: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface RagQueryRequest {
  ragModuleKey: string;
  query: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  includeContent?: boolean;
}

export interface RagQueryMatch {
  id: string;
  score: number;
  /** Pre-rerank vector similarity score. Present only when reranking was applied. */
  vectorScore?: number;
  content?: string;
  metadata?: Record<string, unknown>;
  documentId?: string;
  fileName?: string;
  chunkIndex?: number;
}

export interface RagQueryResult {
  matches: RagQueryMatch[];
  query: string;
  ragModuleKey: string;
  latencyMs: number;
  /** The module's configured response shape; applied by the API layer only. */
  responseDetail?: 'full' | 'text';
}

export interface RagDocumentDeleteRequest {
  ragModuleKey: string;
  documentId: string;
}
