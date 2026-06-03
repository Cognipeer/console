/**
 * Core types for the Evaluation service engine.
 *
 * The engine is intentionally free of any database, queue, or model-runtime
 * coupling: the target under test and the LLM judge are supplied as injected
 * invokers, so the whole scoring pipeline is pure and unit-testable.
 * Persistence, live model / agent / external adapters, and the HTTP API are
 * layered on top of this core separately (see service + plugin layers).
 */

export type EvalRole = 'system' | 'user' | 'assistant';

export interface EvalMessage {
  role: EvalRole;
  content: string;
}

/** Minimal JSON-schema subset supported without an external dependency. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

/** A single JSON-path assertion against the (parsed) target output. */
export interface JsonPathAssertion {
  /** Dot / bracket path, e.g. `data.items[0].name`. */
  path: string;
  /** Require the path to resolve (or explicitly to be absent). */
  exists?: boolean;
  /** Require the resolved value to deep-equal this. */
  equals?: unknown;
}

/** Reference data / expectations attached to a dataset item. */
export interface ExpectedOutput {
  /** Gold answer (used by judge / similarity scorers). */
  reference?: string;
  /** Substrings that MUST appear in the output. */
  mustContain?: string[];
  /** Substrings that must NOT appear in the output. */
  mustNotContain?: string[];
  /** Exact (trimmed) match. */
  equals?: string;
  /** Output must match this regular expression. */
  regex?: string;
  /** Parsed output must satisfy this schema. */
  jsonSchema?: JsonSchema;
  /** Parsed-output path assertions. */
  jsonPath?: JsonPathAssertion[];
}

/** A single test case. */
export interface DatasetItem {
  id: string;
  /** Conversation / prompt fed to the target under test. */
  input: EvalMessage[];
  /** Optional reference / expectations consumed by scorers. */
  expected?: ExpectedOutput;
  tags?: string[];
}

/** Output produced by a target for one item. */
export interface TargetOutput {
  text: string;
  latencyMs?: number;
  /** Raw provider payload, kept for debugging / trajectory scoring. */
  raw?: unknown;
}

/** Injected: how to run the target under test for one item. */
export type TargetInvoker = (item: DatasetItem) => Promise<TargetOutput>;

/** Injected: how to call a judge model. Returns the raw completion text. */
export type JudgeInvoker = (messages: EvalMessage[]) => Promise<string>;

// ── Scorer configs (discriminated union) ──────────────────────────────

export interface AssertionScorerConfig {
  type: 'assertion';
  /** Weight in the aggregate item score (default 1). */
  weight?: number;
}

export interface LlmJudgeScorerConfig {
  type: 'llm-judge';
  weight?: number;
  /** Rubric describing what a good answer looks like. */
  rubric: string;
  /** Pass threshold on the normalised 0..1 judge score (default 0.5). */
  threshold?: number;
}

export type ScorerConfig = AssertionScorerConfig | LlmJudgeScorerConfig;
export type ScorerType = ScorerConfig['type'];

// ── Results ────────────────────────────────────────────────────────────

export interface ScoreResult {
  scorerType: ScorerType;
  /** Normalised score in [0, 1]. */
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface RunItemResult {
  itemId: string;
  output?: TargetOutput;
  scores: ScoreResult[];
  /** Weighted mean of scorer scores, in [0, 1]. */
  score: number;
  /** True when every scorer passed (and the target did not error). */
  passed: boolean;
  latencyMs?: number;
  error?: string;
}

export interface RunAggregate {
  total: number;
  /** Items that produced a result (i.e. the target did not throw). */
  completed: number;
  /** Items whose target invocation threw. */
  failed: number;
  /** Items where `passed === true`. */
  passed: number;
  /** passed / completed, in [0, 1]. */
  passRate: number;
  /** Mean item score over completed items, in [0, 1]. */
  avgScore: number;
  avgLatencyMs: number | null;
}

export interface RunResult {
  aggregate: RunAggregate;
  items: RunItemResult[];
}

export interface RunConfig {
  /** Parallel item executions (default 4). */
  concurrency?: number;
}
