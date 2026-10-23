/** Lightweight view types mirroring the /api/analysis/* JSON responses. */

export type AnalysisFieldType = 'string' | 'number' | 'boolean' | 'enum' | 'score';

export interface AnalysisFieldDefView {
  key: string;
  type: AnalysisFieldType;
  description?: string;
  enumValues?: string[];
  /** Score fields: level labels, lowest first. */
  levels?: string[];
  required?: boolean;
  /** Decision fields: flag answers below this confidence. */
  reviewBelow?: number;
}

export type AnalysisSourceConfigView =
  | { kind: 'conversations' }
  | { kind: 'agent_sessions'; agentKeys: string[]; minMessages?: number; idleMinutes?: number; days?: number };

export interface AnalysisReviewSettingsView {
  threshold?: number;
  spotCheckPct?: number;
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
  decisionModelKey?: string;
  source?: AnalysisSourceConfigView;
  review?: AnalysisReviewSettingsView;
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

export type AnalysisReviewReason = 'low_confidence' | 'spot_check';

export interface AnalysisDecisionView {
  /** Choice key, boolean, or score level label; absent when refused. */
  answer?: string | boolean;
  score?: number;
  /** Detail views only: option -> probability (boolean: yes / no). */
  probabilities?: Record<string, number>;
  confidence: number;
  confidenceSource?: 'native' | 'logprobs' | 'self_reported';
  refused?: boolean;
  needsReview?: boolean;
}

export interface AnalysisRunItemView {
  conversationKey: string;
  extractedFields: Record<string, unknown>;
  missing: string[];
  judge?: { score: number; passed?: boolean; reasoning?: string; error?: string };
  accuracy?: { score: number; perField: Record<string, AnalysisFieldAccuracyView>; comparedCount: number };
  passed: boolean;
  error?: string;
  decisions?: Record<string, AnalysisDecisionView>;
  needsReview?: boolean;
  reviewReason?: AnalysisReviewReason;
  resultId?: string;
}

export interface AnalysisDecisionAggregateView {
  answered: number;
  refused: number;
  needsReview: number;
  counts: Record<string, number>;
  avgConfidence: number | null;
  avgScore?: number | null;
}

export interface AnalysisRunAggregateView {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgJudgeScore: number | null;
  avgExtractionAccuracy: number | null;
  needsReview?: number;
  decisions?: Record<string, AnalysisDecisionAggregateView>;
}

export interface AnalysisRunView {
  id: string;
  definitionKey: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  mode: 'sync' | 'async';
  progress: { total: number; completed: number; failed: number };
  /** Absent on runs of the imported corpus from before run targets existed. */
  target?:
    | { kind: 'conversations' }
    | { kind: 'dataset'; datasetId: string; datasetKey?: string; datasetName?: string }
    | { kind: 'agent_sessions'; agentKeys: string[]; minMessages: number; idleMinutes: number; from: string; to: string };
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

export interface DecisionModelOption extends ModelOption {
  /** The structured emulator: its confidence is the model's own estimate. */
  selfReported: boolean;
}

export interface AnalysisResultRowView {
  id: string;
  definitionKey: string;
  sourceKind: 'conversation' | 'agent_session';
  sourceId: string;
  title: string | null;
  agentKey: string | null;
  needsReview: boolean;
  reviewReason: AnalysisReviewReason | null;
  reviewed: boolean;
  minConfidence: number;
  decisions: Record<string, AnalysisDecisionView>;
  analyzedAt: string;
  runId: string;
}

export interface AnalysisResultView extends AnalysisResultRowView {
  extractedFields: Record<string, unknown>;
  judge?: { score: number; passed?: boolean; reasoning?: string };
  accuracy?: { score: number; comparedCount: number };
  rationale?: string;
  review: { values: Record<string, unknown>; by: string; at: string } | null;
  sourceVersion?: { messageCount: number; lastMessageAt?: string };
}

export interface AnalysisSourceView {
  kind: 'conversation' | 'agent_session';
  id: string;
  /** False when the conversation or session no longer exists. */
  available: boolean;
  title: string | null;
  agentKey?: string;
  /** Link to the source in the dashboard (agent session or imported conversation). */
  href?: string;
  messageCount?: number;
  transcript: AnalysisTranscriptMessageView[];
}

export interface AnalysisResultDetailResponse {
  result: AnalysisResultView;
  definition: Pick<AnalysisDefinitionView, 'id' | 'key' | 'name' | 'fieldSet' | 'decisionModelKey' | 'review'>;
  source: AnalysisSourceView;
}

export interface AgentSessionRowView {
  id: string;
  title: string | null;
  agentKey: string;
  messageCount: number;
  updatedAt: string;
  origin: string | null;
  result: null | {
    id: string;
    needsReview: boolean;
    reviewed: boolean;
    /** The session changed after it was analyzed. */
    stale: boolean;
    analyzedAt: string;
    decisions: Record<string, AnalysisDecisionView>;
  };
}

export interface RunEstimateView {
  conversations: number;
  /** How many transcripts the average length was measured on. */
  sampled: number;
  avgChars: number;
  inputTokens: number;
  outputTokens: number;
  cost: {
    decision: number | null;
    extraction: number | null;
    judge: number | null;
    total: number | null;
    currency: string;
  };
}

export interface CalibrationQuestionView {
  key: string;
  type: 'enum' | 'boolean' | 'score';
  reviewed: number;
  accuracy: number | null;
  avgConfidence: number | null;
  ece: number | null;
  mae?: number | null;
  threshold: number;
  suggestedThreshold: number | null;
}

export interface CalibrationView {
  definitionKey: string;
  targetAccuracy: number;
  reviewed: number;
  spotChecks: number;
  questions: CalibrationQuestionView[];
}
