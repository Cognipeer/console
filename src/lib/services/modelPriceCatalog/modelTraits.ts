/**
 * Model-name traits — deterministic, dependency-free facts inferred from a
 * model's NAME alone.
 *
 * The recommendation engine's guard rails need a quality prior for candidates
 * that have never been measured. Closed-model vendors encode that prior in
 * marketing markers (`nano`, `mini`, `sonnet`, `opus`); open-weight models
 * encode it as a PARAMETER COUNT (`llama-3.2-3b`, `qwen3-30b-a3b`,
 * `mixtral-8x7b`). A tier heuristic that only reads markers rates every
 * open-weight model — a 3B one included — at the STANDARD tier, which
 * silently disables the "more than one tier down" exclusion for the entire
 * open-weight catalog. This module reads both.
 *
 * Everything here is a PRIOR, never a verdict: parity evidence outranks it
 * (see the abacus service's evidence flywheel).
 */

export const MODEL_TIER_STANDARD = 3;

/** Marker → tier. 1 = smallest. Checked as whole name tokens. */
const TIER_MARKERS: Record<string, number> = {
  nano: 1,
  micro: 1,
  tiny: 1,
  mini: 2,
  small: 2,
  lite: 2,
  flash: 2,
  haiku: 2,
  sonnet: 3,
  medium: 3,
  pro: 4,
  large: 4,
  opus: 4,
  ultra: 4,
  max: 4,
};

/**
 * ACTIVE-parameter (billions) → tier boundaries, calibrated against the
 * marker scale above: a 3B model behaves like a `nano`, an 8B like a `mini`,
 * a 32–70B like a `sonnet`/STANDARD, and only 100B+ active parameters earn
 * the top tier. Upper bound is exclusive.
 */
const PARAM_TIER_BREAKS: Array<{ belowB: number; tier: number }> = [
  { belowB: 5, tier: 1 },
  { belowB: 20, tier: 2 },
  { belowB: 100, tier: 3 },
  { belowB: Number.POSITIVE_INFINITY, tier: 4 },
];

/** Parameter counts above this are a parse artefact, not a model size. */
const MAX_PLAUSIBLE_PARAMS_B = 2_000;

/**
 * Mixture-of-experts routing width assumed when a name only states the
 * `<experts>x<size>B` shape (Mixtral-style). Two experts per token is the
 * published convention for that family; the estimate is deliberately
 * conservative — it under-states capability rather than over-stating it.
 */
const MOE_ACTIVE_EXPERTS = 2;

/**
 * Canonical form of a model name for cross-provider matching:
 *  - lowercase,
 *  - drop provider path prefixes ('azure/gpt-4o' → 'gpt-4o'),
 *  - drop dotted vendor/region prefixes ('us.anthropic.claude-…' →
 *    'claude-…'); only non-numeric segments are treated as prefixes so
 *    version dots ('gpt-4.1') survive,
 *  - drop trailing date suffixes ('-2025-09-29', '-20250929') and '-latest',
 *  - collapse duplicate separators and trim stray ones.
 */
export function normalizeModelName(raw: string): string {
  let name = (raw ?? '').trim().toLowerCase();

  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);

  // Dotted prefixes: letters/underscores/hyphens only, so 'gpt-4.1' keeps
  // its dot ('gpt-4' contains a digit and never matches).
  for (;;) {
    const stripped = name.replace(/^[a-z][a-z_-]*\./, '');
    if (stripped === name || stripped.length === 0) break;
    name = stripped;
  }

  for (;;) {
    const stripped = name
      .replace(/-20\d{2}-\d{2}-\d{2}$/, '')
      .replace(/-20\d{6}$/, '')
      .replace(/-latest$/, '');
    if (stripped === name) break;
    name = stripped;
  }

  name = name.replace(/[-_]{2,}/g, (run) => run[0]);
  name = name.replace(/^[-_.]+|[-_.]+$/g, '');
  return name;
}

/**
 * ACTIVE parameter count in billions, read off the model name. Recognized
 * shapes, in priority order:
 *
 *   1. explicit active marker — 'qwen3-30b-a3b'    → 3   (the `a<N>b` token)
 *   2. mixture-of-experts     — 'mixtral-8x7b'     → 14  (2 experts × 7B)
 *   3. dense size             — 'llama-3.2-3b'     → 3
 *
 * Dense names that state several sizes ('llama-4-maverick-17b-128e') use the
 * FIRST one — the convention is size-then-topology. Returns undefined when
 * the name carries no size at all, or the parsed value is implausible.
 */
export function inferActiveParamsB(raw: string): number | undefined {
  const name = normalizeModelName(raw);
  if (!name) return undefined;

  const plausible = (value: number): number | undefined =>
    Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_PARAMS_B ? value : undefined;

  const active = name.match(/(?:^|[^a-z0-9])a(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (active) return plausible(Number(active[1]));

  const moe = name.match(/(?:^|[^a-z0-9])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (moe) {
    const experts = Number(moe[1]);
    const perExpert = Number(moe[2]);
    return plausible(Math.min(experts, MOE_ACTIVE_EXPERTS) * perExpert);
  }

  const dense = name.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (dense) return plausible(Number(dense[1]));

  return undefined;
}

/**
 * TOTAL parameter count in billions — every weight that has to be resident,
 * which is what sizes a GPU deployment. Differs from `inferActiveParamsB`
 * exactly for mixture-of-experts models: 'mixtral-8x7b' activates ~14B per
 * token but must hold all 56B in memory, and 'qwen3-30b-a3b' activates 3B
 * out of 30B. Quality follows the ACTIVE count; VRAM follows this one.
 */
export function inferTotalParamsB(raw: string): number | undefined {
  const name = normalizeModelName(raw);
  if (!name) return undefined;

  const plausible = (value: number): number | undefined =>
    Number.isFinite(value) && value > 0 && value <= MAX_PLAUSIBLE_PARAMS_B ? value : undefined;

  // '<total>b-a<active>b' — the total is the token BEFORE the active marker.
  const totalWithActive = name.match(
    /(?:^|[^a-z0-9])(\d+(?:\.\d+)?)b[-_]a\d+(?:\.\d+)?b(?![a-z0-9])/,
  );
  if (totalWithActive) return plausible(Number(totalWithActive[1]));

  const moe = name.match(/(?:^|[^a-z0-9])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  if (moe) return plausible(Number(moe[1]) * Number(moe[2]));

  return inferActiveParamsB(name);
}

export interface ModelTierDetail {
  /** 1 (smallest) … 4 (largest). */
  tier: number;
  /**
   * Where the tier came from:
   *  - 'marker' — a vendor size marker in the name ('mini', 'opus'),
   *  - 'params' — an active-parameter count in the name ('8b', '8x7b'),
   *  - 'default' — NEITHER; the name says nothing, so the caller is holding
   *    the STANDARD tier on no evidence at all and may want a second signal
   *    (the abacus service applies a price-based hint in that case).
   */
  source: 'marker' | 'params' | 'default';
  activeParamsB?: number;
}

/**
 * Infer a coarse quality tier (1 smallest … 4 largest) plus its provenance.
 * Vendor markers and parameter counts are both consulted and the SMALLER
 * result wins (a "pro-mini" is a mini; a `llama-4-scout-17b` is a 17B).
 * Neither signal ⇒ STANDARD, flagged as 'default'.
 */
export function inferModelTierDetail(raw: string): ModelTierDetail {
  const normalized = normalizeModelName(raw);
  const tokens = normalized.split(/[^a-z0-9.]+/).filter(Boolean);

  let markerTier: number | undefined;
  for (const token of tokens) {
    const marked = TIER_MARKERS[token];
    if (marked !== undefined && (markerTier === undefined || marked < markerTier)) {
      markerTier = marked;
    }
  }

  const activeParamsB = inferActiveParamsB(normalized);
  const paramTier =
    activeParamsB === undefined
      ? undefined
      : (PARAM_TIER_BREAKS.find((brk) => activeParamsB < brk.belowB)?.tier ?? MODEL_TIER_STANDARD);

  if (markerTier === undefined && paramTier === undefined) {
    return { tier: MODEL_TIER_STANDARD, source: 'default' };
  }
  if (markerTier === undefined) {
    return { tier: paramTier as number, source: 'params', activeParamsB };
  }
  if (paramTier === undefined) return { tier: markerTier, source: 'marker' };

  return paramTier <= markerTier
    ? { tier: paramTier, source: 'params', activeParamsB }
    : { tier: markerTier, source: 'marker', activeParamsB };
}

/**
 * Infer a coarse quality tier (1 smallest … 4 largest) from a model name.
 * Thin wrapper over `inferModelTierDetail` — kept for callers that only need
 * the number.
 */
export function inferModelTier(raw: string): number {
  return inferModelTierDetail(raw).tier;
}

/**
 * Open-weight model families. Used to LABEL a candidate (so the UI can say
 * "open weights — you can also self-host this") and to decide which naming
 * conventions apply; it never gates anything on its own.
 *
 * Matching is by family token, not by publisher, because the same weights
 * appear under a dozen hosting providers ('groq/llama-3.1-8b-instant',
 * 'deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct', 'together_ai/…').
 */
const OPEN_WEIGHT_FAMILIES =
  /(?:^|[^a-z])(llama|qwen|qwq|deepseek|mistral|mixtral|magistral|devstral|codestral|ministral|pixtral|gemma|phi|glm|kimi|minimax|olmo|granite|nemotron|gpt-oss|command-r|dbrx|falcon|yi|solar|internlm|hermes|wizardlm|starcoder|smollm|exaone|apertus|seed-oss|ernie|aya|jamba|tulu|zephyr|openchat)(?:[^a-z]|$)/;

/** True when the name belongs to a published open-weight family. */
export function isOpenWeightModel(raw: string): boolean {
  return OPEN_WEIGHT_FAMILIES.test(normalizeModelName(raw));
}

/**
 * How well a model is expected to handle NON-ENGLISH traffic.
 *
 *  - 'strong'  — the family ships documented multilingual coverage,
 *  - 'limited' — the family is documented as English-first or code-only,
 *  - 'unknown' — no claim (the default, and the only honest answer for most
 *    of the catalog: the price feed carries no language metadata).
 *
 * Only 'limited' is actionable as an exclusion — 'unknown' never gates, in
 * keeping with the engine's UNKNOWN-never-excludes rule. The real answer for
 * a specific workload comes from a language-stratified parity run.
 */
export type MultilingualSupport = 'strong' | 'limited' | 'unknown';

/** Families with documented broad multilingual coverage. */
const MULTILINGUAL_STRONG =
  /(?:^|[^a-z])(qwen|gemma|glm|kimi|minimax|deepseek|command-r|aya|granite|mistral-large|mistral-medium|mistral-small|mistral-nemo|ministral|nemotron|gpt-oss|ernie|gpt-4|gpt-5|claude|gemini|grok)(?:[^a-z]|$)/;

/**
 * Families documented as English-first or single-purpose (code). Deliberately
 * short: a wrong 'limited' verdict silently deletes a viable candidate, so
 * only well-established cases belong here. A `multilingual` token in the name
 * overrides membership (e.g. 'phi-4-multilingual').
 */
const MULTILINGUAL_LIMITED =
  /(?:^|[^a-z])(smollm|olmo|starcoder|codestral|devstral|codellama|codegemma|stable-code|deepseek-coder|phi-2|phi-3|phi-3\.5)(?:[^a-z]|$)/;

export function inferMultilingualSupport(raw: string): MultilingualSupport {
  const name = normalizeModelName(raw);
  if (/multilingual/.test(name)) return 'strong';
  if (MULTILINGUAL_LIMITED.test(name)) return 'limited';
  if (MULTILINGUAL_STRONG.test(name)) return 'strong';
  return 'unknown';
}
