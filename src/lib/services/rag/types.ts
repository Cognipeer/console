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
  filter?: Record<string, unknown>;
  includeContent?: boolean;
}

export interface RagQueryMatch {
  id: string;
  score: number;
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
}

export interface RagDocumentDeleteRequest {
  ragModuleKey: string;
  documentId: string;
}
