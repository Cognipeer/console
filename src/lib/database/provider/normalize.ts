/** Small value normalisers shared by the Mongo and SQLite providers. */

/** Beta access codes are stored and compared trimmed and upper-cased. */
export function normalizeBetaAccessCode(code: string): string {
  return code.trim().toUpperCase();
}

/** The distinct, non-empty strings of `values`, in first-seen order. */
export function distinctStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}
