/**
 * Moderation domain — a purpose-built content classifier, as distinct from the
 * LLM-judge path the guardrail engine has always used.
 *
 * Why it is its own domain: a classifier answers in one cheap, fast call with
 * real per-category probabilities, where a judge costs a full completion and
 * can only be coaxed into a coarse severity. Both are legitimate — a provider
 * with no classifier still needs the judge — so the guardrail policy chooses
 * between them and this domain covers the classifier half.
 */
import type { ModelRuntimeConfig } from './model';

export interface ModerationCategoryVerdict {
  /** Whether the text trips this category. */
  flagged: boolean;
  /**
   * Model-reported probability in [0,1] when the detector produces one. A judge
   * that only reports a severity bucket leaves this undefined rather than
   * inventing a number that a caller's threshold would then trust.
   */
  score?: number;
}

export interface ModerationClassification {
  flagged: boolean;
  /** Keyed by the shared category ids in `guardrail/types.ts`. */
  categories: Record<string, ModerationCategoryVerdict>;
  /** The upstream body, for the trace. */
  raw?: Record<string, unknown>;
}

export interface ModerationResultSet {
  results: ModerationClassification[];
  model?: string;
  usage?: { inputTokens?: number; totalTokens?: number };
}

export interface ModerationRuntime {
  classify(texts: string[], config?: ModelRuntimeConfig): Promise<ModerationResultSet>;
}
