/**
 * OWASP Top 10 for LLM Applications — the 2025 list, which every red-team
 * report, rollup and custom probe uses.
 *
 * Probes and runs recorded before this list carried a mix of the 2023-24 (v1.1)
 * and 2025 numbering (for example `LLM06-sensitive-information-disclosure`,
 * `LLM08-excessive-agency`). `normalizeOwaspCategory` maps those stored keys to
 * the 2025 key, so old runs and new runs group together. Reads normalize; new
 * writes store the 2025 key.
 *
 * Pure module with no imports, so client components can use it too.
 */

export const OWASP_LLM_VERSION = '2025' as const;

export const OWASP_LLM_CATEGORIES = [
  'LLM01-prompt-injection',
  'LLM02-sensitive-information-disclosure',
  'LLM03-supply-chain',
  'LLM04-data-model-poisoning',
  'LLM05-improper-output-handling',
  'LLM06-excessive-agency',
  'LLM07-system-prompt-leakage',
  'LLM08-vector-embedding-weaknesses',
  'LLM09-misinformation',
  'LLM10-unbounded-consumption',
] as const;

export type OwaspLlmCategory = (typeof OWASP_LLM_CATEGORIES)[number];

export const OWASP_LLM_LABELS: Record<OwaspLlmCategory, string> = {
  'LLM01-prompt-injection': 'LLM01 Prompt Injection',
  'LLM02-sensitive-information-disclosure': 'LLM02 Sensitive Information Disclosure',
  'LLM03-supply-chain': 'LLM03 Supply Chain',
  'LLM04-data-model-poisoning': 'LLM04 Data and Model Poisoning',
  'LLM05-improper-output-handling': 'LLM05 Improper Output Handling',
  'LLM06-excessive-agency': 'LLM06 Excessive Agency',
  'LLM07-system-prompt-leakage': 'LLM07 System Prompt Leakage',
  'LLM08-vector-embedding-weaknesses': 'LLM08 Vector and Embedding Weaknesses',
  'LLM09-misinformation': 'LLM09 Misinformation',
  'LLM10-unbounded-consumption': 'LLM10 Unbounded Consumption',
};

/** Keys stored before the 2025 list, mapped to the 2025 key for the same risk. */
export const LEGACY_OWASP_CATEGORY_MAP: Readonly<Record<string, OwaspLlmCategory>> = {
  'LLM02-insecure-output-handling': 'LLM05-improper-output-handling',
  'LLM04-model-dos': 'LLM10-unbounded-consumption',
  'LLM05-supply-chain': 'LLM03-supply-chain',
  'LLM06-sensitive-information-disclosure': 'LLM02-sensitive-information-disclosure',
  'LLM08-excessive-agency': 'LLM06-excessive-agency',
  'LLM09-overreliance': 'LLM09-misinformation',
};

const CURRENT = new Set<string>(OWASP_LLM_CATEGORIES);

export function isOwaspLlmCategory(value: unknown): value is OwaspLlmCategory {
  return typeof value === 'string' && CURRENT.has(value);
}

/** True for a 2025 key or a legacy key that maps to one. */
export function isKnownOwaspCategory(value: unknown): boolean {
  return isOwaspLlmCategory(value) || (typeof value === 'string' && value in LEGACY_OWASP_CATEGORY_MAP);
}

/**
 * The 2025 key for a stored category. A legacy key maps to its 2025 key; a value
 * that is neither is returned unchanged (never dropped), so an unknown category
 * still shows up in a report under its own name.
 */
export function normalizeOwaspCategory(value: string): string {
  if (CURRENT.has(value)) return value;
  return LEGACY_OWASP_CATEGORY_MAP[value] ?? value;
}

/** Display label for a stored category (legacy keys get the 2025 label). */
export function owaspCategoryLabel(value: string): string {
  const key = normalizeOwaspCategory(value);
  return isOwaspLlmCategory(key) ? OWASP_LLM_LABELS[key] : value;
}
