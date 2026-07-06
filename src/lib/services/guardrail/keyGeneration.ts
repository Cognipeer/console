import slugify from 'slugify';

const SLUG_OPTIONS = { lower: true, strict: true, trim: true };
const MAX_KEY_ATTEMPTS = 50;

/**
 * Slugifies `desiredKey` (falling back to `fallback` when blank) and appends
 * `-1`, `-2`, … until `exists(candidate)` returns false. Shared by guardrails
 * and word lists so the uniqueness loop lives in one place. The caller is
 * responsible for binding the tenant DB before invoking `exists`.
 */
export async function generateUniqueSlugKey(
  desiredKey: string,
  fallback: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(desiredKey?.trim().length ? desiredKey.trim() : fallback, SLUG_OPTIONS);
  let attempt = 0;
  let candidate = base;

  while (attempt < MAX_KEY_ATTEMPTS) {
    if (!(await exists(candidate))) return candidate;
    attempt++;
    candidate = `${base}-${attempt}`;
  }

  throw new Error(`Could not generate a unique key for "${desiredKey}"`);
}
