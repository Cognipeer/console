/**
 * Core types for the Evaluation service engine.
 *
 * The engine is intentionally free of any database, queue, or model-runtime
 * coupling: the target under test and the LLM judge are supplied as injected
 * invokers, so the whole scoring pipeline is pure and unit-testable.
 * Persistence, live model / agent / external adapters, and the HTTP API are
 * layered on top of this core separately (see service + plugin layers).
 */

export type EvalRole = 'system' | 'user' | 'assistant' | 'tool';

/** A tool call recorded on an assistant turn (provider id kept when known). */
export interface EvalToolCallRef {
  /** Provider call id (e.g. OpenAI `tool_calls[].id`); synthesized on replay when absent. */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * One conversation turn. Full tool fidelity: assistant turns may carry the
 * tool calls they issued (`toolCalls`), and `role: 'tool'` turns carry the
 * tool's response (`toolCallId` links it back to the call). Without these a
 * replay of mid-conversation traffic loses the tool exchanges and the test
 * is not faithful to production.
 */
export interface EvalMessage {
  role: EvalRole;
  content: string;
  /** Assistant turns only: tool calls issued in this turn. */
  toolCalls?: EvalToolCallRef[];
  /** Tool turns only: id of the assistant tool call this responds to. */
  toolCallId?: string;
  /** Tool turns only: tool name, when the source recorded it. */
  name?: string;
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

// ── Tool-call (trajectory) types ──────────────────────────────────────

/** A tool made available to the target for one item (never executed). */
export interface EvalToolDefinition {
  name: string;
  description?: string;
  /** JSON-schema `parameters` object, passed through to the provider. */
  parameters?: Record<string, unknown>;
}

/** A tool call actually emitted by the target, normalised across providers. */
export interface NormalizedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** An expected tool call, with a per-call argument matching strategy. */
export interface ExpectedToolCall {
  name: string;
  /**
   * How `args` are compared for this call:
   * 'exact' (canonical-JSON equality), 'subset' (every expected key/value
   * deep-present in the actual args), 'schema' (validate actual args against
   * `argsSchema`), 'ignore' (excluded from args scoring).
   * Default: 'exact' when `args` is set, 'schema' when only `argsSchema` is
   * set, else 'ignore'.
   */
  argsMatch?: 'exact' | 'subset' | 'schema' | 'ignore';
  args?: Record<string, unknown>;
  argsSchema?: JsonSchema;
}

/** Token / cost usage observed for one target invocation. */
export interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
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
  /** Expected tool-call trajectory (consumed by the tool-call scorer). */
  toolCalls?: ExpectedToolCall[];
}

/** A single test case. */
export interface DatasetItem {
  id: string;
  /** Conversation / prompt fed to the target under test. */
  input: EvalMessage[];
  /** Optional reference / expectations consumed by scorers. */
  expected?: ExpectedOutput;
  /** Tools exposed to the target (single-step decision — never executed). */
  tools?: EvalToolDefinition[];
  /**
   * Canned tool results for future multi-step evaluation.
   * Key format: `name + '(' + canonicalJson(args) + ')'`.
   */
  toolResults?: Record<string, unknown>;
  /**
   * Structured-output contract this item was RECORDED under (OpenAI
   * `response_format` shape), captured by Traffic Snapshots from the trace or
   * gateway log. The other half of the request contract next to `tools`, and
   * the reason it belongs on the item rather than only on the target: a
   * dataset captured from production carries a per-call contract, and replaying
   * it without one measures a looser system than production runs under. A
   * target's own `responseFormat` still wins when set — that is how you test a
   * contract CHANGE.
   */
  responseFormat?: Record<string, unknown>;
  tags?: string[];
}

/**
 * One passage returned by a retrieval target, in rank order.
 *
 * Carried next to `text` rather than folded into it because the retrieval
 * scorers grade the passages individually: a concatenation cannot say which
 * chunk was relevant, or at what rank it arrived — and rank is exactly what
 * separates good retrieval from lucky retrieval.
 */
export interface RetrievedChunk {
  /** Vector-store id of the chunk. */
  id: string;
  /** Retrieval score as reported by the store (post-rerank when reranking ran). */
  score: number;
  content: string;
  documentId?: string;
  fileName?: string;
  chunkIndex?: number;
  /** 1-based position in the ranked result set. */
  rank: number;
}

/** Output produced by a target for one item. */
export interface TargetOutput {
  text: string;
  latencyMs?: number;
  /**
   * Retrieval targets only: the ranked passages behind `text`. Absent (rather
   * than empty) when the target does not retrieve at all — the retrieval
   * scorers use that difference to tell "wrong target kind" apart from
   * "retrieved nothing".
   */
  retrieved?: RetrievedChunk[];
  /** Tool calls the target emitted, normalised across provider shapes. */
  toolCalls?: NormalizedToolCall[];
  /** Token / cost usage reported by the provider for this invocation. */
  usage?: EvalUsage;
  /** Raw provider payload, kept for debugging / trajectory scoring. */
  raw?: unknown;
  /**
   * `perTurn` replays only: what the model said at every turn, in order.
   *
   * Only the LAST turn is scored (it is the one the item's `expected` refers
   * to), so without this a failed multi-turn item is unexplainable — the turn
   * where the model actually lost the thread is invisible.
   */
  turns?: ReplayTurn[];
}

/** One model answer inside a `perTurn` replay. */
export interface ReplayTurn {
  /** 1-based position among the item's user turns. */
  index: number;
  /** The user turn that prompted it, trimmed for display. */
  question: string;
  /** What the model answered — fed back as history for the next turn. */
  text: string;
  toolCalls?: NormalizedToolCall[];
  latencyMs?: number;
  usage?: EvalUsage;
}

/** Injected: how to run the target under test for one item. */
export type TargetInvoker = (item: DatasetItem) => Promise<TargetOutput>;

/** Injected: how to call a judge model. Returns the raw completion text. */
export type JudgeInvoker = (messages: EvalMessage[]) => Promise<string>;

/** Injected: how to embed a batch of texts. Returns one vector per input. */
export type EmbedInvoker = (texts: string[]) => Promise<number[][]>;

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

export interface SemanticScorerConfig {
  type: 'semantic';
  weight?: number;
  /** Pass threshold on the cosine similarity in [0..1] (default 0.75). */
  threshold?: number;
}

export interface ToolCallScorerConfig {
  type: 'tool-call';
  weight?: number;
  /** Pass threshold on the combined 0..1 score (default 0.75). */
  threshold?: number;
  /** Component weight for tool-selection F1 (default 0.5). */
  selectionWeight?: number;
  /** Component weight for call-order similarity (default 0.2). */
  sequenceWeight?: number;
  /** Component weight for argument matching (default 0.3). */
  argsWeight?: number;
}

/**
 * Structural conformance against the reference output. Separate from
 * `semantic` on purpose: embedding similarity happily passes a response that
 * kept the gist but dropped required JSON fields.
 */
export interface JsonShapeScorerConfig {
  type: 'json-shape';
  weight?: number;
  /** Fraction of the reference's keys that must arrive correctly (default 1 — exact shape). */
  threshold?: number;
}

/**
 * Is the gold answer semantically COVERED by what we retrieved? Judged by
 * embedding similarity, never string overlap: a passage that answers the
 * question in different words is a hit, and an exact-match scorer would call
 * it a miss.
 */
export interface ContextRecallScorerConfig {
  type: 'context-recall';
  weight?: number;
  /** Pass threshold on the 0..1 coverage score (default 0.7). */
  threshold?: number;
}

/**
 * How much of what we retrieved was actually relevant, weighted by rank — a
 * relevant passage at rank 1 counts for more than the same passage at rank 10,
 * because that is the one the generator reads first.
 */
export interface ContextPrecisionScorerConfig {
  type: 'context-precision';
  weight?: number;
  /** Pass threshold on the 0..1 rank-weighted relevant share (default 0.5). */
  threshold?: number;
}

/**
 * Is the target's ANSWER supported by the passages it retrieved? The other
 * half of retrieval quality: perfect context still produces a hallucination if
 * the generator ignores it.
 */
export interface GroundednessScorerConfig {
  type: 'groundedness';
  weight?: number;
  /** Pass threshold on the 0..1 support score (default 0.7). */
  threshold?: number;
}

export type ScorerConfig =
  | AssertionScorerConfig
  | LlmJudgeScorerConfig
  | SemanticScorerConfig
  | ToolCallScorerConfig
  | JsonShapeScorerConfig
  | ContextRecallScorerConfig
  | ContextPrecisionScorerConfig
  | GroundednessScorerConfig;
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
  /** Token / cost usage for this item's target invocation, when reported. */
  usage?: EvalUsage;
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
  /** Sum of per-item usage.costUsd; present only if any item reported usage. */
  totalCostUsd?: number;
  /** Sum of per-item tokens (input + output + cached); ditto. */
  totalTokens?: number;
}

export interface RunResult {
  aggregate: RunAggregate;
  items: RunItemResult[];
}

export interface RunConfig {
  /** Parallel item executions (default 4). */
  concurrency?: number;
  /**
   * How a multi-turn item is replayed. `single` (default) sends the recorded
   * prefix and calls the model once; `perTurn` walks the conversation and
   * feeds the model its OWN previous answers, which is the only way drift
   * shows up. See `replayPerTurn` in runner.ts.
   */
  turnMode?: 'single' | 'perTurn';
}
