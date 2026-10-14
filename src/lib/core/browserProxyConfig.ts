/**
 * Resolves a Playwright `proxy` launch option from the standard
 * HTTP(S)_PROXY / NO_PROXY environment variables -- the same variables
 * `stdioRunner.ts` already forwards to MCP subprocesses for on-prem
 * deployments that egress through a corporate proxy.
 *
 * Chromium does NOT read these env vars itself. Most Node HTTP clients
 * (axios, undici) honor them directly or through a configured agent, so on a
 * network that requires an egress proxy, every OTHER outbound path in the
 * same process keeps working while a headless browser launched without this
 * silently cannot reach the public internet at all -- not even a single
 * trivial page. The only visible symptom is `chromium.launch()`'s own
 * connection attempts, or every subsequent `page.goto()`, eventually hitting
 * Playwright's default timeout, with nothing that names a proxy as the cause.
 */
export interface BrowserProxyConfig {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export function resolveBrowserProxyConfig(): BrowserProxyConfig | undefined {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return undefined;

  // Playwright's `bypass` is a plain comma-separated host list; passed
  // through as-is rather than reparsed, since NO_PROXY's own conventions
  // (leading dots, occasional CIDR-ish entries) aren't standardized enough
  // for any Node HTTP client to agree on either, and Playwright already
  // tolerates the common comma-separated form.
  const bypass = process.env.NO_PROXY || process.env.no_proxy;

  const { server, username, password } = splitProxyCredentials(raw.trim());
  return {
    server,
    ...(bypass ? { bypass } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * Corporate proxy URLs commonly embed basic-auth credentials
 * (`http://user:pass@host:3128`). Chromium ignores credentials in
 * `--proxy-server`, so Playwright needs them as separate `username` /
 * `password` fields; left in the URL the proxy answers 407 (or the request
 * stalls) and surfaces only as a navigation timeout.
 */
function splitProxyCredentials(raw: string): { server: string; username?: string; password?: string } {
  // Bare `host:port` is valid for Playwright (treated as HTTP) but not for
  // `new URL`, which would read `host` as the scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hasScheme) return { server: raw };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { server: raw };
  }
  if (!parsed.username && !parsed.password) return { server: raw };

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    username: decode(parsed.username),
    password: decode(parsed.password),
  };
}
