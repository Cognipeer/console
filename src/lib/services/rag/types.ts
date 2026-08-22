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
  hybrid?: IRagModule['hybrid'];
  /**
   * Defaults to true: a module we ingest into stamps `_ragModule` on every
   * vector, so isolating it costs nothing and stops two modules that share an
   * index from reading each other's chunks.
   */
  isolateByModule?: boolean;
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
  hybrid?: IRagModule['hybrid'] | null;
  isolateByModule?: boolean | null;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface RagIngestRequest {
  ragModuleKey: string;
  fileName: string;
  content: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  /**
   * Chunk this document differently from the rest of the module. A 200-page
   * contract and a FAQ export rarely want the same splitter. Persisted on the
   * document so a re-index reproduces the same chunks.
   */
  chunkConfig?: IRagChunkConfig;
  /**
   * The upload the text was extracted from. Stored in the module's bucket so a
   * re-index can re-run the converter instead of re-reading our own output.
   */
  fileData?: Buffer;
  /**
   * Ingest even when a document with this fileName and the same content hash is
   * already indexed. Without it the same file uploaded twice used to be
   * embedded twice and answered from twice.
   */
  force?: boolean;
  /**
   * Persist the document and hand chunking + embedding to the ingest queue
   * instead of running them inside the caller's request.
   *
   * The returned document is `pending`; it becomes `indexed` (or `failed`) once
   * the job runs, and is not searchable until then.
   */
  deferIndexing?: boolean;
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
  /**
   * The dense (cosine) similarity, kept separately when a hybrid query fused it
   * with a keyword channel — the fused `score` is on a different scale, so this
   * is what a similarity threshold has to be compared against.
   */
  denseScore?: number;
  /** The keyword channel's contribution to a hybrid match, when the driver reports one. */
  lexicalScore?: number;
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
