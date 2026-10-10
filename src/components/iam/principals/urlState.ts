/**
 * Updates query parameters of the current URL without a navigation, so state
 * that is worth sharing (the principal open in a drawer) can be mirrored into
 * the address bar. `null` removes a parameter; every other parameter, including
 * the IAM center's `tab`, is left untouched.
 *
 * `history.replaceState(null, …)` is the form the Next.js app router patches to
 * keep `useSearchParams` in sync; handing it the existing state object would
 * bypass that. Returns the resulting query string (null when nothing could be written).
 */
export function replaceUrlParams(updates: Record<string, string | null>): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    // The query string as the router will report it, so the caller can tell its own writes from a navigation.
    return url.searchParams.toString();
  } catch {
    /* the History API is unavailable (embedded or sandboxed frame): the mirror is optional */
    return null;
  }
}
