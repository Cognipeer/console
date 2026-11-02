/**
 * Third-party hosts the crawler's browser never loads sub-resources from.
 *
 * Why: `page.goto(..., 'domcontentloaded')` waits for every parser-blocking
 * `<script src>` in the page, and sites commonly put a consent manager or tag
 * manager there. On a network whose firewall silently drops traffic to those
 * hosts the request never answers, the parser never moves on, and the page
 * times out although its own content loaded in milliseconds (seen on
 * axess.com.tr: a synchronous `bundles.efilli.com` script in `<head>` on a
 * customer network that blocks it). None of these hosts serve page content, so
 * aborting them fails fast and costs the crawl nothing.
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

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
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
      .map(normalizeHost)
      .filter(Boolean),
  );
  if (suffixes.size === 0) return () => false;

  return (url: string): boolean => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
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
