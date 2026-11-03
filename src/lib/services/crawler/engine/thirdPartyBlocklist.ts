/**
 * Third-party hosts the crawler's browser skips sub-resources from when a
 * crawler turns `http.blockTrackers` on (off by default).
 *
 * Why: `page.goto(..., 'domcontentloaded')` waits for every parser-blocking
 * `<script src>` in the page, and sites commonly put a consent manager or tag
 * manager there. On a network whose firewall silently drops traffic to those
 * hosts the request never answers, the parser never moves on, and the page
 * times out although its own content loaded in milliseconds (seen with a
 * synchronous consent-manager script in `<head>` on a customer network that
 * blocks its host). These hosts do not serve page content, so aborting them
 * fails fast. It is opt-in because a site can render its content through one
 * of them.
 *
 * Only sub-resources are blocked, never the page being crawled: a navigation
 * to one of these hosts is left alone (see `PlaywrightSession`).
 *
 * Matching is by registrable suffix: `google-analytics.com` also covers
 * `www.google-analytics.com`, but not `notgoogle-analytics.com`.
 */
export const DEFAULT_BLOCKED_THIRD_PARTY_HOSTS: readonly string[] = [
  // Tag managers, analytics, ads
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'googleadservices.com',
  'googlesyndication.com',
  'doubleclick.net',
  'googleoptimize.com',
  'connect.facebook.net',
  'analytics.tiktok.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'mc.yandex.ru',
  'mc.yandex.com',
  'criteo.com',
  'criteo.net',
  'adnxs.com',
  'adform.net',
  // Session replay, product analytics, RUM
  'hotjar.com',
  'hotjar.io',
  'clarity.ms',
  'fullstory.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.io',
  'cdn.segment.com',
  'newrelic.com',
  'nr-data.net',
  // Cookie-consent managers
  'efilli.com',
  'cookielaw.org',
  'onetrust.com',
  'cookiebot.com',
  'cookieyes.com',
  'usercentrics.eu',
];

/**
 * The form the matcher compares in: exactly what `new URL(...).hostname`
 * reports for a request, so lowercase and, for an internationalized name,
 * punycode (`bücher.example` → `xn--bcher-kva.example`). Entries and request
 * hosts go through the same parser, so they cannot drift apart.
 *
 * A leading `*.` or `.` and a trailing `.` are markers, not part of the name,
 * and each is removed once, in whichever of two places it appears:
 *  - typed in ASCII, before parsing. A dotted name whose last label is a number
 *    is read as an IPv4 address, and `.127.0.0.1` / `*.127.0.0.1` are not valid
 *    ones until the marker is gone;
 *  - typed as a Unicode dot (`。` `．` `｡`) or a full-width asterisk, after
 *    parsing, which is what turns them into `.` and `*`. So `*。bücher.example`
 *    and `bücher.example。` reduce to the same name as their ASCII forms.
 *
 * Returns `null` when the entry is not a bare host name: a scheme, path, port,
 * credentials, whitespace, a character a host cannot contain, an empty name, a
 * stray or repeated dot at an end, or a `*` anywhere but the leading marker.
 */
export function normalizeBlockedHost(raw: string): string | null {
  const entry = raw.trim();
  if (!entry || /[\s/\\:?#@]/.test(entry)) return null;

  let name = entry;
  const asciiLeading = /^\*?\./.test(name);
  if (asciiLeading) name = name.replace(/^\*?\./, '');
  const asciiTrailing = name.endsWith('.');
  if (asciiTrailing) name = name.slice(0, -1);

  let host: string;
  try {
    host = new URL(`http://${name}/`).hostname;
  } catch {
    return null;
  }
  // Only a side that did not already lose its marker above: `..example.com`
  // and `*.*.example.com` carry a second marker, which stays a mistake.
  if (!asciiLeading) host = host.replace(/^\*?\./, '');
  if (!asciiTrailing) host = host.replace(/\.$/, '');
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('*')) return null;
  return host;
}

export type HostBlocker = (url: string) => boolean;

/**
 * Builds the predicate the browser's route handler asks for every
 * sub-resource. `extra` entries (operator-configured) are added to the
 * defaults; `useDefaults: false` keeps only `extra`.
 */
export function createHostBlocker(options: {
  useDefaults?: boolean;
  extra?: readonly string[];
} = {}): HostBlocker {
  const { useDefaults = true, extra = [] } = options;
  const suffixes = new Set(
    [...(useDefaults ? DEFAULT_BLOCKED_THIRD_PARTY_HOSTS : []), ...extra]
      .map(normalizeBlockedHost)
      .filter((host): host is string => host !== null),
  );
  if (suffixes.size === 0) return () => false;

  return (url: string): boolean => {
    let host: string;
    try {
      // `www.example.com.` is the same host; the entries are stored without the dot.
      host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return false; // not a parseable URL — let the browser deal with it
    }
    if (!host) return false; // data:, blob:, about:
    for (const suffix of suffixes) {
      if (host === suffix || host.endsWith(`.${suffix}`)) return true;
    }
    return false;
  };
}
