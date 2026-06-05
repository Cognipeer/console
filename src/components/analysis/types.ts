/** Lightweight view types mirroring the /api/analysis/* JSON responses. */

export type AnalysisFieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface AnalysisFieldDefView {
  key: string;
  type: AnalysisFieldType;
  description?: string;
  enumValues?: string[];
  required?: boolean;
}

export interface AnalysisModesView {
  store?: boolean;
  judge?: { rubric: string; threshold?: number };
  accuracy?: boolean;
}

export interface AnalysisDefinitionView {
  id: string;
  key: string;
  name: string;
  description?: string;
  fieldSet: AnalysisFieldDefView[];
  extractionInstructions?: string;
  modes: AnalysisModesView;
  extractionModelKey?: string;
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  schedule?: { cron: string; enabled: boolean };
  createdAt?: string;
}

export interface AnalysisTranscriptMessageView {
  role: string;
  content: string;
}

export interface AnalysisConversationView {
  id: string;
  key: string;
  name?: string;
  description?: string;
  transcript: AnalysisTranscriptMessageView[];
  source: 'imported' | 'platform' | 'manual';
  tags?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  referenceFields?: Record<string, unknown>;
  extractedFields?: Record<string, unknown>;
  lastAnalyzedAt?: string;
  createdAt?: string;
}

export interface AnalysisFieldAccuracyView {
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface AnalysisRunItemView {
  conversationKey: string;
  extractedFields: Record<string, unknown>;
  missing: string[];
  judge?: { score: number; passed?: boolean; reasoning?: string; error?: string };
  accuracy?: { score: number; perField: Record<string, AnalysisFieldAccuracyView>; comparedCount: number };
  passed: boolean;
  error?: string;
}

export interface AnalysisRunAggregateView {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgJudgeScore: number | null;
  avgExtractionAccuracy: number | null;
}

export interface AnalysisRunView {
  id: string;
  definitionKey: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: 'sync' | 'async';
  progress: { total: number; completed: number; failed: number };
  aggregate?: AnalysisRunAggregateView;
  items: AnalysisRunItemView[];
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt?: string;
}

export interface ModelOption {
  value: string;
  label: string;
}
