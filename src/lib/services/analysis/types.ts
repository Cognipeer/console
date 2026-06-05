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
 */

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

export type FieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface FieldDef {
  key: string;
  type: FieldType;
  description?: string;
  /** Allowed values when type is 'enum'. */
  enumValues?: string[];
  required?: boolean;
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

export interface AnalysisSpec {
  fieldSet: FieldSet;
  /** Extra extraction instructions appended to the prompt. */
  extractionInstructions?: string;
  modes: AnalysisModes;
}

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
}

export interface AnalysisResult {
  aggregate: AnalysisAggregate;
  items: AnalysisItemResult[];
}

export interface AnalysisRunConfig {
  concurrency?: number;
}
