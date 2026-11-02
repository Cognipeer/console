/**
 * Core types for the Conversation Analysis engine.
 *
 * Like the evaluation engine, this core is free of any database, queue, or
 * model-runtime coupling: the model (used for field extraction and the LLM
 * judge) is supplied as an injected invoker, so the whole pipeline is pure and
 * unit-testable. Persistence, live model adapters, scheduling, alerting, and
 * the dashboard are layered on top separately.
 *
 * Supports four composable analysis modes:
 *   - extract  : pull a field-set out of a transcript as structured JSON
 *   - store    : (persistence intent) keep the extracted fields
 *   - judge    : grade conversation quality against a rubric (LLM judge)
 *   - accuracy : compare extracted fields against reference (ground-truth)
 *
 * With a decision model, Yes/No, Choice and Score fields are answered by a
 * Model Hub `decision` model instead of being extracted: one call per
 * conversation, with a probability per option, and low-confidence answers are
 * flagged for human review.
 */

import type { DecisionAnswer, DecisionQuestion } from '@/lib/providers/domains/decision';

export interface AnalysisMessage {
  /** Speaker role — flexible to support IVR transcripts (caller/agent/ivr). */
  role: string;
  content: string;
}

export interface AnalysisConversation {
  id: string;
  transcript: AnalysisMessage[];
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  /** Ground-truth field values, used by the accuracy mode. */
  referenceFields?: Record<string, unknown>;
}

export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'score';

export interface FieldDef {
  key: string;
  type: FieldType;
  description?: string;
  /** Allowed values when type is 'enum'. */
  enumValues?: string[];
  /** Ordered level labels, lowest first, when type is 'score'. */
  levels?: string[];
  required?: boolean;
  /** Decision fields: flag answers below this confidence (overrides the spec's review threshold). */
  reviewBelow?: number;
}

export type FieldSet = FieldDef[];

/** Injected model call: takes chat messages, returns the raw completion text. */
export type ModelInvoker = (messages: AnalysisMessage[]) => Promise<string>;

export interface AnalysisModes {
  /** Persistence intent for extracted fields (does not affect the engine run). */
  store?: boolean;
  /** Enable the LLM-judge quality scorer with this rubric. */
  judge?: { rubric: string; threshold?: number };
  /** Enable reference-based accuracy scoring (needs conversation.referenceFields). */
  accuracy?: boolean;
}

export interface AnalysisReviewSpec {
  /** Decision answers below this confidence are flagged. Default 0.7. */
  threshold?: number;
  /** Share (0-100) of confident items also flagged, picked deterministically. Default 0. */
  spotCheckPct?: number;
}

export interface AnalysisSpec {
  fieldSet: FieldSet;
  /** Extra extraction instructions appended to the prompt. */
  extractionInstructions?: string;
  modes: AnalysisModes;
  /** Route Yes/No, Choice and Score fields to the decision invoker. */
  useDecisionModel?: boolean;
  review?: AnalysisReviewSpec;
  /** Salt for the deterministic spot-check pick (the definition key). */
  spotCheckSalt?: string;
}

/** One decision-model answer, normalized for Analysis. */
export interface AnalysisDecision {
  /** Choice key, yes/no (boolean) or score level label. Absent when the model refused. */
  answer?: string | boolean;
  /** `score` only: expected level index (sum of i * p_i), 0-based. */
  score?: number;
  /** choice: key -> p; score: level label -> p; boolean: { yes: p, no: 1 - p }. */
  probabilities?: Record<string, number>;
  /** 0..1; 0 when refused. */
  confidence: number;
  confidenceSource?: 'native' | 'logprobs' | 'self_reported';
  refused?: boolean;
  needsReview?: boolean;
}

export type ReviewReason = 'low_confidence' | 'spot_check';

/** What the engine hands the injected decision invoker: one call per conversation. */
export interface DecisionInvocation {
  input: string;
  questions: Record<string, DecisionQuestion>;
  includeRationale: boolean;
}

export interface DecisionInvocationResult {
  answers: Record<string, DecisionAnswer>;
  rationale?: string;
  /** 'structured' = an emulated decision model whose confidence is self-reported. */
  backendKind: 'native' | 'structured';
}

/** Injected decision-model call (Model Hub `decision` category). */
export type DecisionInvoker = (request: DecisionInvocation) => Promise<DecisionInvocationResult>;

export interface ExtractionResult {
  fields: Record<string, unknown>;
  /** Required fields that were missing or failed type coercion. */
  missing: string[];
  error?: string;
}

export interface JudgeResult {
  /** Normalised 0..1 quality score. */
  score: number;
  passed?: boolean;
  reasoning?: string;
  error?: string;
}

export interface FieldAccuracy {
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface AccuracyResult {
  /** matches / comparedCount, in [0, 1]. */
  score: number;
  perField: Record<string, FieldAccuracy>;
  comparedCount: number;
}

export interface AnalysisItemResult {
  conversationId: string;
  extractedFields: Record<string, unknown>;
  missing: string[];
  judge?: JudgeResult;
  accuracy?: AccuracyResult;
  /** Extraction succeeded with all required fields present (and judge passed). */
  passed: boolean;
  error?: string;
  /** Decision answers by field key (decision fields only). */
  decisions?: Record<string, AnalysisDecision>;
  needsReview?: boolean;
  reviewReason?: ReviewReason;
  rationale?: string;
  /** Lowest decision confidence; 1 when there are no decisions. */
  minConfidence?: number;
  /**
   * An agent session that holds passages of knowledge base documents not open to everyone: its tags and who started
   * it, carried to the run's stored copy of the item (see IAgentConversation.kbRestricted).
   */
  restriction?: { kbRestricted: string[]; ownerId?: string };
}

export interface DecisionAggregate {
  answered: number;
  refused: number;
  needsReview: number;
  /** Answer -> count (choice key, 'yes'/'no', or score level label). */
  counts: Record<string, number>;
  avgConfidence: number | null;
  /** `score` only: mean expected level index. */
  avgScore?: number | null;
}

export interface AnalysisAggregate {
  total: number;
  /** Conversations whose extraction did not error. */
  completed: number;
  /** Conversations whose extraction errored. */
  failed: number;
  passed: number;
  /** passed / completed, in [0, 1]. */
  passRate: number;
  /** Mean judge score over judged conversations, or null. */
  avgJudgeScore: number | null;
  /** Mean accuracy over conversations with a reference, or null. */
  avgExtractionAccuracy: number | null;
  /** Items flagged for human review. */
  needsReview: number;
  /** Per decision field; present only when some item has decisions. */
  decisions?: Record<string, DecisionAggregate>;
}

export interface AnalysisResult {
  aggregate: AnalysisAggregate;
  items: AnalysisItemResult[];
}

export interface AnalysisRunConfig {
  concurrency?: number;
}
