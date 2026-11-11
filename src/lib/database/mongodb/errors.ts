/** Mongo write-error helpers shared by the mixins. */

const DUPLICATE_KEY_CODES = new Set([11000, 11001]);

/** True when `error` is a Mongo duplicate-key (unique index) violation. */
export function isDuplicateKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && DUPLICATE_KEY_CODES.has(code);
}
