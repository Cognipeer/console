/**
 * `finishReason` normalization — shared between server persistence code and
 * React client components (dependency-free: no `@/lib/database`, no node
 * builtins), so the exact same rules apply wherever a raw provider value is
 * turned into the string we store/compare.
 *
 * We normalize casing/whitespace but never map provider synonyms onto each
 * other (e.g. OpenAI's `length` vs Anthropic's `max_tokens` stay distinct) —
 * that mapping is a display/analytics concern for a later phase, and
 * collapsing it here would make the raw persisted value non-recoverable.
 */

/**
 * Trim + lowercase a raw provider finish reason and validate its shape.
 * Returns `undefined` for anything that isn't a plausible finish-reason
 * token (empty, non-string, or containing characters no known provider
 * uses) rather than persisting garbage that would never match the constant
 * sets below.
 */
export function normalizeFinishReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return /^[a-z0-9_.:-]{1,64}$/.test(normalized) ? normalized : undefined;
}

/** Finish reasons that mean the model completed its turn on its own terms. */
export const NORMAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'end_turn',
  'tool_calls',
  'function_call',
  'tool_use',
  'stop_sequence',
  'completed',
]);

/**
 * Finish reasons that mean generation was cut off by a token/length limit
 * rather than the model choosing to stop — the usual explanation for a
 * truncated or unparseable answer (e.g. a JSON response missing its closing
 * brace), so these are tracked separately from other abnormal stops.
 */
export const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set([
  'length',
  'max_tokens',
  'model_length',
  'output_token_limit',
  'max_output_tokens',
]);

/**
 * True for any defined finish reason outside the "completed normally" set —
 * i.e. worth surfacing to a caller auditing why a response looks off,
 * whether that's a length cutoff, a content filter, or an error abort.
 */
export function isAbnormalFinishReason(value?: string): boolean {
  return value !== undefined && !NORMAL_FINISH_REASONS.has(value);
}

/**
 * True when the finish reason specifically indicates a token/length cutoff —
 * the subset of abnormal reasons most likely to explain a truncated or
 * unparseable answer.
 */
export function isTruncatedFinishReason(value?: string): boolean {
  return value !== undefined && TRUNCATION_FINISH_REASONS.has(value);
}
