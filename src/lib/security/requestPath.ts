/**
 * The path as the router will match it. Fastify decodes percent-escapes
 * (decodeURI semantics: reserved characters such as %2F stay encoded) before
 * routing, so `/api/resource%2Dusage/...` and `/api/to%6Fls` reach the same
 * handlers as their plain spelling. Every gate that maps a path to a service
 * MUST look at this canonical form, never at the raw one, or an escape walks
 * around it. Duplicate slashes are collapsed (stricter, never looser).
 */
export function canonicalizeRequestPathname(rawUrl: string | undefined): string {
  let pathname = new URL(rawUrl || '/', 'http://localhost').pathname;
  try {
    pathname = decodeURI(pathname);
  } catch {
    // Malformed escape: the router answers 400/404; keep the raw form for the gate.
  }
  return pathname.replace(/\/{2,}/g, '/');
}
