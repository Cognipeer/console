/** Paging bounds shared by the provider mixins (same behaviour on every backend). */

/** A page size in `[1, max]`; `fallback` when the input is not a finite number. */
export function clampLimit(value: number | undefined, fallback: number, max = 200): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/** A non-negative whole offset; 0 when the input is not a finite non-negative number. */
export function clampSkip(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
