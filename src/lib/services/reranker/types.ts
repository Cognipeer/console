import type {
  IReranker,
  IRerankerConfig,
  IRerankerRunLog,
  RerankerStatus,
  RerankerStrategy,
} from '@/lib/database';

export type Reranker = IReranker;
export type RerankerRunLog = IRerankerRunLog;
export type RerankerConfig = IRerankerConfig;

export interface CreateRerankerRequest {
  name: string;
  key?: string;
  description?: string;
  strategy: RerankerStrategy;
  config: IRerankerConfig;
  status?: RerankerStatus;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface UpdateRerankerRequest {
  name?: string;
  description?: string;
  strategy?: RerankerStrategy;
  config?: IRerankerConfig;
  status?: RerankerStatus;
  metadata?: Record<string, unknown>;
  updatedBy?: string;
}

export interface RerankerDocumentInput {
  /** Stable id for callers. Optional. */
  id?: string;
  /** Document text to score. */
  content: string;
  /** Original retrieval score (cosine sim, BM25, etc.) — used by fusion / heuristic strategies. */
  score?: number;
  /** Free-form metadata preserved on output. */
  metadata?: Record<string, unknown>;
}

export interface RerankerRunRequest {
  query: string;
  documents: RerankerDocumentInput[];
  /** Override the reranker's default topN. */
  topN?: number;
  /** Optional source tag for telemetry. */
  source?: 'rag' | 'api' | 'dashboard';
  /** Optional ragModule key tag for telemetry (when called from RAG pipeline). */
  ragModuleKey?: string;
}

export interface RerankerRunResultItem {
  /** Index into the original input array. */
  index: number;
  /** Stable id if caller supplied one, otherwise undefined. */
  id?: string;
  /** Re-ranked score (normalized to [0,1] when scoreNormalization='minmax'). */
  score: number;
  /** Original score before reranking (passthrough). */
  originalScore?: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RerankerRunResult {
  rerankerKey: string;
  strategy: RerankerStrategy;
  modelKey?: string;
  results: RerankerRunResultItem[];
  latencyMs: number;
  inputCount: number;
  outputCount: number;
}
