/**
 * The `topK` of a Knowledge Engine query: how many matches come back.
 *
 * The HTTP routes refuse a value that is not a whole number from 1 to RAG_MAX_TOP_K (`readRagTopK`).
 * The services apply the same rule as a second line of defence (`normalizeRagTopK`): a value that is
 * not usable falls back to the default and a large one is clamped, so it is never sent to the vector
 * store or used to slice the matches.
 */

/** The largest `topK` a query may ask for (the dashboard allows up to 200 anywhere a count is typed). */
export const RAG_MAX_TOP_K = 200;

export const RAG_TOP_K_ERROR = `topK must be an integer from 1 to ${RAG_MAX_TOP_K}`;

export type RagTopKResult = { ok: true; topK: number | undefined } | { ok: false; error: string };

/** Reads the `topK` of a request body: absent (undefined or null) is fine, anything else must be a whole number from 1 to the maximum. */
export function readRagTopK(value: unknown): RagTopKResult {
  if (value === undefined || value === null) return { ok: true, topK: undefined };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > RAG_MAX_TOP_K) {
    return { ok: false, error: RAG_TOP_K_ERROR };
  }
  return { ok: true, topK: value };
}

/** The `topK` a service works with: the requested one when usable (clamped to the maximum), else the fallback. */
export function normalizeRagTopK(requested: unknown, fallback: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 1) return fallback;
  return Math.min(Math.floor(requested), RAG_MAX_TOP_K);
}
