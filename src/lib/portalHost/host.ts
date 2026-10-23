/**
 * The portals' own address: a workspace's portals at `https://<workspace slug>.<PORTAL_BASE_DOMAIN>/`
 * (a wildcard DNS record and certificate), and for an installation that has no wildcard, one fixed
 * `PORTAL_HOST` that serves one workspace (`PORTAL_HOST_TENANT`) or, when none is named, the
 * workspace of the person's session (as `/p` does on the Console host).
 *
 * On a portal host the address is short: `/` is the chooser of the person's portals and `/{key}` is
 * a portal; the pages behind them are the Console's `/p` and `/p/{key}`. A portal host serves the
 * portal and nothing else (see `isPortalHostApiPath`), and it has a session of its own
 * (`./token`): the Console's session cookie belongs to the Console host and never reaches it.
 *
 * Edge-safe (the middleware imports it): no Node APIs, no database.
 */
import { getConfig, type AppConfig } from '@/lib/core/config';

/**
 * What a request host is when it is a portal host. `slug: null` = a fixed host with no workspace of
 * its own: the person's session names it.
 */
export type PortalHostMatch =
  | { kind: 'tenant'; host: string; slug: string }
  | { kind: 'fixed'; host: string; slug: string | null };

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The shape of a portal key (`PORTAL_KEY_PATTERN` of `@cognipeer/portal`, which community code cannot
 * import). Keys are lower-case; links are read case-insensitively.
 */
const PORTAL_KEY = /^[a-z0-9][a-z0-9-]{2,47}$/i;

/** API routes a portal host answers: the portal runtime and its own sign-in. Everything else is the Console's. */
const PORTAL_HOST_API_PREFIXES = ['/api/portal/', '/api/portal-host/'];

/** A name that can be one label of a host name (a workspace slug that can stand before the base domain). */
export function isDnsLabel(value: string): boolean {
  return DNS_LABEL.test(value);
}

/** Lower-case host name without the port; '' for nothing usable. */
function bareHost(value: string | null | undefined): string {
  const first = (value ?? '').split(',')[0].trim().toLowerCase();
  if (!first) return '';
  // [v6]:port keeps its brackets; a name drops its port.
  const host = first.startsWith('[') ? first.slice(0, first.indexOf(']') + 1) : first.replace(/:\d+$/, '');
  return host.replace(/\.$/, '');
}

/**
 * The host a request was addressed to: the proxy's `X-Forwarded-Host` (its first value), else `Host`.
 * The same header the portal's request guard compares an `Origin` with.
 */
export function requestHostOf(header: (name: string) => string | null | undefined): string {
  return bareHost(header('x-forwarded-host')) || bareHost(header('host'));
}

/** The Console's own host (APP_URL): never a portal host. */
export function consoleHostOf(cfg: AppConfig = getConfig()): string {
  try {
    return new URL(cfg.app.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Whether this installation gives portals an address of their own at all. */
export function portalHostsEnabled(cfg: AppConfig = getConfig()): boolean {
  return Boolean(cfg.portalHost.baseDomain || cfg.portalHost.fixedHost);
}

/** The portal host a request host is, or null (the Console host and any other name). */
export function matchPortalHost(host: string, cfg: AppConfig = getConfig()): PortalHostMatch | null {
  if (!host || host === consoleHostOf(cfg)) return null;
  const { baseDomain, fixedHost, fixedHostTenant } = cfg.portalHost;
  // The fixed host wins over the wildcard when both would match.
  if (fixedHost && host === fixedHost) return { kind: 'fixed', host, slug: fixedHostTenant || null };
  if (baseDomain && host.endsWith(`.${baseDomain}`)) {
    const label = host.slice(0, -(baseDomain.length + 1));
    if (isDnsLabel(label)) return { kind: 'tenant', host, slug: label };
  }
  return null;
}

/**
 * The portal host of a workspace, or null when it has none (portals then stay at `/p/{key}` on the
 * Console host). `PORTAL_HOST` comes first, when it serves this workspace: it names it in
 * `PORTAL_HOST_TENANT`, or names none.
 */
export function portalHostOfTenant(slug: string, cfg: AppConfig = getConfig()): string | null {
  const { baseDomain, fixedHost, fixedHostTenant } = cfg.portalHost;
  const label = (slug ?? '').toLowerCase();
  if (fixedHost && (!fixedHostTenant || fixedHostTenant === label)) return fixedHost;
  if (baseDomain && isDnsLabel(label)) return `${label}.${baseDomain}`;
  return null;
}

/** `https://<host>` with the Console's scheme and port (APP_URL), so a local `*.portal.localhost:3000` works too. */
export function portalHostOrigin(host: string, cfg: AppConfig = getConfig()): string {
  let scheme = 'https:';
  let port = '';
  try {
    const url = new URL(cfg.app.url);
    scheme = url.protocol;
    port = url.port;
  } catch {
    /* the default scheme, no port */
  }
  return `${scheme}//${host}${port ? `:${port}` : ''}`;
}

/** The address of a portal on its host (`/{key}`), or of the chooser (no key). */
export function portalHostUrl(host: string, portalKey?: string, cfg: AppConfig = getConfig()): string {
  return `${portalHostOrigin(host, cfg)}/${portalKey ? encodeURIComponent(portalKey) : ''}`;
}

/**
 * The page behind a portal-host path: `/` is the chooser (`/p`), `/{key}` a portal (`/p/{key}`).
 * `null` = not a page of the portal host (it answers 404).
 */
export function portalHostPagePath(pathname: string): string | null {
  if (pathname === '' || pathname === '/') return '/p';
  const match = /^\/([^/]+)\/?$/.exec(pathname);
  if (!match || !PORTAL_KEY.test(match[1])) return null;
  return `/p/${match[1].toLowerCase()}`;
}

/**
 * The short form of a Console portal path on a portal host (`/p` -> `/`, `/p/{key}` -> `/{key}`), or
 * null when the path is not one. An old relative link that lands on the portal host is sent here.
 */
export function shortPortalPath(pathname: string): string | null {
  if (pathname === '/p' || pathname === '/p/') return '/';
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname);
  return match && PORTAL_KEY.test(match[1]) ? `/${match[1].toLowerCase()}` : null;
}

/** Whether a portal host answers this API path (the rest of the API belongs to the Console host). */
export function isPortalHostApiPath(pathname: string): boolean {
  return PORTAL_HOST_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
