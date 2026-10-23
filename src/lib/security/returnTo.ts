/**
 * Post-login return-to handling, shared by the Edge middleware, the login /
 * register / change-password / SSO-callback pages and the enterprise SSO flow.
 *
 * A `returnTo` value travels through query strings and (for SSO) through the
 * IdP round trip, so it is attacker-controlled input. The only thing it may
 * ever express is "a same-origin path on this console"; anything else would
 * make /login an open redirect. Pure and dependency-free so it also runs in the
 * Edge runtime and in the browser.
 */

export const DEFAULT_RETURN_TO = '/dashboard';
export const MAX_RETURN_TO_LENGTH = 2048;

// A fixed, unroutable origin used only to resolve and compare: if the value
// escapes it (protocol-relative, absolute URL, backslash tricks), it is not a
// same-origin path.
const PROBE_ORIGIN = 'http://return-to.invalid';

// C0 controls and DEL. Tab/CR/LF matter most: URL parsers silently strip them,
// so "/\t/evil.com" would otherwise resolve to "//evil.com".
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Returns `value` when it is a safe same-origin path (with optional query and
 * hash), otherwise `fallback`.
 */
export function safeReturnTo(
  value: string | null | undefined,
  fallback: string = DEFAULT_RETURN_TO,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) {
    return fallback;
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  if (value.includes('://') || value.includes('\\') || CONTROL_CHARS.test(value)) {
    return fallback;
  }
  // Percent-encoded leading tab/LF/CR/slash/backslash/dot: browsers keep them
  // literal, but a proxy or server that decodes them yields "//host".
  if (/^\/%(09|0a|0d|2f|5c|2e)/i.test(value)) return fallback;
  try {
    const parsed = new URL(value, PROBE_ORIGIN);
    if (parsed.origin !== PROBE_ORIGIN) return fallback;
    // The URL parser collapses dot segments ("/..//evil.com" -> "//evil.com"),
    // which stays on the probe origin but is protocol-relative once echoed
    // back. Only a path that survives parsing unchanged is a plain path, so
    // reject any value the parser would rewrite.
    const rawPath = value.split(/[?#]/, 1)[0];
    if (parsed.pathname !== rawPath || parsed.pathname.startsWith('//')) return fallback;
    return value;
  } catch {
    return fallback;
  }
}

/**
 * `/login?returnTo=<encoded>` for a protected path. A value that fails
 * validation yields the bare `/login`, so a hostile path can never be echoed
 * back into the redirect.
 */
export function buildLoginPath(returnTo: string | null | undefined): string {
  const safe = safeReturnTo(returnTo, '');
  return safe ? `/login?returnTo=${encodeURIComponent(safe)}` : '/login';
}

/** True for the end-user portal pages (`/p`, `/p/<key>`), never for `/pricing`. */
export function isPortalPagePath(pathname: string): boolean {
  return pathname === '/p' || pathname.startsWith('/p/');
}

/**
 * True for the Agent Channels account-link page (`/channels/link/<token>`): a
 * link a chat bot sends to someone in Slack / Teams, opened cold, so it must
 * survive the trip through login.
 */
export function isChannelLinkPagePath(pathname: string): boolean {
  return pathname.startsWith('/channels/link/');
}

/**
 * Where to send someone who just authenticated but must set a new password
 * first. The destination rides along so the interstitial can finish the trip.
 */
export function buildChangePasswordPath(returnTo: string): string {
  const safe = safeReturnTo(returnTo);
  return safe === DEFAULT_RETURN_TO
    ? '/change-password'
    : `/change-password?returnTo=${encodeURIComponent(safe)}`;
}

/**
 * Full page load for the portal. A soft router.push from /login would keep the
 * Mantine notification host (the "Login successful" toast would follow the user
 * onto the portal) and let the dashboard stylesheet bleed into a page that ships
 * its own CSS reset. The same for a way back through the server (`/api/...`, e.g.
 * the portal host's sign-in, which redirects on to the portal's own address):
 * the client router has no page there. Returns true when it navigated; the
 * caller falls back to router.push/replace otherwise. Browser-only.
 */
export function assignIfPortal(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  if (typeof window === 'undefined' || !(isPortalPagePath(pathname) || pathname.startsWith('/api/'))) return false;
  window.location.assign(path);
  return true;
}
