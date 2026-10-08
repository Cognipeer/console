/**
 * Decision domain — typed answers with probabilities instead of text.
 *
 * A decision model is asked a set of closed questions about some input (a
 * choice among labelled options, a score on ordered levels, a yes/no) and
 * answers each with a probability distribution rather than prose. Vendors that
 * ship this natively (OpenAI `/v1/decisions`, Alibaba Model Studio, TypeSafe
 * Jev) are reached by native adapters in later phases; `backend.kind:
 * 'structured'` is the emulator that serves the same contract from any chat
 * model that can enforce a JSON schema.
 *
 * The contract omits what the backend did not produce. A structured emulator
 * reports `confidence_source: 'self_reported'` because the numbers are the
 * model's own claims, not logprobs — a caller thresholding on `confidence` has
 * to be able to tell the difference.
 */

export type DecisionQuestionType = 'choice' | 'boolean' | 'score';

export interface DecisionChoiceQuestion {
  type: 'choice';
  instructions?: string;
  /** Choice key → description. The keys are the only labels the model may use. */
  choices: Record<string, string>;
}

export interface DecisionBooleanQuestion {
  type: 'boolean';
  instructions?: string;
}

export interface DecisionScoreQuestion {
  type: 'score';
  instructions?: string;
  /** Ordered levels, lowest first. Level `i` is addressed by its index. */
  levels: string[];
}

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionBooleanQuestion
  | DecisionScoreQuestion;

export type DecisionInputPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data_url: string };

export interface DecisionRequest {
  input: DecisionInputPart[];
  questions: Record<string, DecisionQuestion>;
  includeRationale?: boolean;
}

export type DecisionConfidenceSource = 'self_reported' | 'logprobs' | 'native';

export interface DecisionChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  /** Omitted when the backend did not report one. */
  confidence?: number;
  confidence_source?: DecisionConfidenceSource;
}

export interface DecisionBooleanAnswer {
  type: 'boolean';
  probability: number;
}

export interface DecisionScoreAnswer {
  type: 'score';
  /** Expected level index: sum(i * p_i) over the normalized distribution. */
  score: number;
  /** Level index (as a string) → probability. */
  probabilities: Record<string, number>;
  /** Level index (as a string) → the level's label. */
  /** Omitted when the backend neither sent nor implied level labels. */
  legend?: Record<string, string>;
  confidence?: number;
  confidence_source?: DecisionConfidenceSource;
}

export interface DecisionRefusalAnswer {
  type: 'refusal';
}

export type DecisionAnswer =
  | DecisionChoiceAnswer
  | DecisionBooleanAnswer
  | DecisionScoreAnswer
  | DecisionRefusalAnswer;

export interface DecisionBackendInfo {
  kind: 'native' | 'structured';
  provider: string;
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  /** Console extension: present only when `include_rationale` was requested and produced. */
  rationale?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Vendor-side identifiers worth a trace row (native backends only). */
  upstream?: { request_id?: string; latency_ms?: number };
  backend: DecisionBackendInfo;
}

export interface DecisionRuntime {
  decide(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionResult>;
}
