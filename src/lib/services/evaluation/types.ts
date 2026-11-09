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

/**
 * JSON-schema subset supported without an external dependency. A keyword
 * outside this subset is reported as a scorer error instead of being ignored,
 * so a schema never "passes" on rules nobody checked.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  /** Annotation keywords are accepted and ignored. */
  description?: string;
  title?: string;
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
  /** Subset of inputTokens served from the prompt cache. */
  cachedInputTokens?: number;
  /** Subset of inputTokens written to the prompt cache. */
  cachedWriteTokens?: number;
  /** Subset of outputTokens spent on reasoning. */
  reasoningTokens?: number;
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
   * The answer was cut off at the output limit (a partial answer is not a verdict on the model: the flag lets it
   * be told apart). Present only when true (Mongo stores `undefined` as null). A `perTurn` replay sets it when
   * ANY of its turns was cut off.
   */
  truncated?: boolean;
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

/** A judge completion with the spend it caused (when the transport knows it). */
export interface JudgeCompletion {
  text: string;
  usage?: EvalUsage;
}

/**
 * Injected: how to call a judge model. Returns the raw completion text, or a
 * `JudgeCompletion` when the transport can report usage. A plain string keeps
 * working so existing invokers need no change.
 */
export type JudgeInvoker = (messages: EvalMessage[]) => Promise<string | JudgeCompletion>;

/** Injected: how to embed a batch of texts. Returns one vector per input. */
export type EmbedInvoker = (texts: string[]) => Promise<number[][]>;

// ── Scorer configs (discriminated union) ──────────────────────────────

/**
 * Opt-in per-item applicability shared by every scorer. Absent = the scorer
 * applies to every item. When the condition is not met the scorer is skipped
 * for that item (not scored as 0, and ignored by the item's combine).
 */
export interface ScorerConfigBase {
  applyWhen?: 'has-reference' | 'has-expected-tool-calls';
}

export interface AssertionScorerConfig extends ScorerConfigBase {
  type: 'assertion';
  /** Weight in the aggregate item score (default 1). */
  weight?: number;
}

export interface LlmJudgeScorerConfig extends ScorerConfigBase {
  type: 'llm-judge';
  weight?: number;
  /** Rubric describing what a good answer looks like. */
  rubric: string;
  /** Pass threshold on the normalised 0..1 judge score (default 0.5). */
  threshold?: number;
}

export interface SemanticScorerConfig extends ScorerConfigBase {
  type: 'semantic';
  weight?: number;
  /** Pass threshold on the cosine similarity in [0..1] (default 0.75). */
  threshold?: number;
}

export interface ToolCallScorerConfig extends ScorerConfigBase {
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
  /**
   * Whether calls beyond the expected ones are tolerated (default `true`: they
   * only lower the selection / sequence components). `false` fails the scorer
   * when any actual call is not matched to an expected call.
   */
  allowExtraCalls?: boolean;
}

/**
 * Structural conformance against the reference output. Separate from
 * `semantic` on purpose: embedding similarity happily passes a response that
 * kept the gist but dropped required JSON fields.
 */
export interface JsonShapeScorerConfig extends ScorerConfigBase {
  type: 'json-shape';
  weight?: number;
  /** Fraction of the reference's keys that must arrive correctly (default 1 — exact shape). */
  threshold?: number;
  /**
   * Default `false`: only the reference's own keys count. `true`: keys present
   * in the output but absent from the reference count as problems too.
   */
  strict?: boolean;
}

/**
 * Is the gold answer semantically COVERED by what we retrieved? Judged by
 * embedding similarity, never string overlap: a passage that answers the
 * question in different words is a hit, and an exact-match scorer would call
 * it a miss.
 */
export interface ContextRecallScorerConfig extends ScorerConfigBase {
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
export interface ContextPrecisionScorerConfig extends ScorerConfigBase {
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
export interface GroundednessScorerConfig extends ScorerConfigBase {
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
  /**
   * The scorer does not apply to this item (`detail.reason` says why). Carries
   * `score: 0`, `passed: false` and is ignored when the item's score is combined.
   */
  skipped?: boolean;
  /** Judge spend for this score, when the judge transport reported it. */
  usage?: EvalUsage;
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
  /** No scorer applied to this item (all skipped, or none configured); not a failure. */
  skipped?: boolean;
  /** Sum of `scores[].usage` — judge spend, kept apart from the target's `usage`. */
  scoringUsage?: EvalUsage;
  error?: string;
  /**
   * The knowledge bases (`<projectId>:<key>` tags) whose documents not open to everyone the item's work handed on
   * (rag/access/exposure.ts): its output, details and error are shown only to the run's starter and to those who read
   * all of them through the admin exception.
   */
  kbRestricted?: string[];
}

export interface RunAggregate {
  total: number;
  /** Items with no `error` (skipped ones included). */
  completed: number;
  /** Items with an `error`: the target threw OR a scorer failed. */
  failed: number;
  /** Items where `passed === true`. */
  passed: number;
  /** Completed items where no scorer applied. */
  skipped: number;
  /** passed / (completed - skipped), in [0, 1]. Errored and skipped items are not in the denominator. */
  passRate: number;
  /** failed / total, in [0, 1] (0 when total is 0). */
  errorRate: number;
  /** Mean item score over (completed - skipped) items, in [0, 1]. */
  avgScore: number;
  /** Mean latency over completed items only. */
  avgLatencyMs: number | null;
  /** Completed items whose output was cut off at the output limit. */
  truncatedCount?: number;
  /** Items that reported target usage — the denominator for per-item token / cost averages. */
  usageItems?: number;
  /** Judge spend; present only when some score reported usage. Never folded into the target totals. */
  scoringCostUsd?: number;
  scoringTokens?: number;
  /** Sum of per-item usage.costUsd; present only if any item reported usage. */
  totalCostUsd?: number;
  /** Sum of per-item tokens (input + output; cached is a subset of input); ditto. */
  totalTokens?: number;
}

export interface RunResult {
  aggregate: RunAggregate;
  items: RunItemResult[];
  /** The run was stopped before every item was dispatched; `items` holds only the processed ones. */
  stopped?: boolean;
}

/** Hard cap on parallel item executions; `RunConfig.concurrency` is clamped to [1, this]. */
export const EVAL_MAX_CONCURRENCY = 32;

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
