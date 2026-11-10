/**
 * The crawler's browser aborts sub-resources to tracker / consent hosts so a
 * parser-blocking third-party script that a firewall silently drops cannot
 * hold `domcontentloaded` until the navigation times out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import {
  DEFAULT_BLOCKED_THIRD_PARTY_HOSTS,
  createHostBlocker,
  normalizeBlockedHost,
} from '@/lib/services/crawler/engine/thirdPartyBlocklist';
import { PlaywrightSession } from '@/lib/services/crawler/engine/playwrightFetcher';
import type { CrawlHttpConfig } from '@/lib/services/crawler/engine/types';
import { createCrawlerInputSchema } from '@/lib/services/crawler/validation';
import { snapshotToPlan } from '@/lib/services/crawler/crawlerJobService';
import type { ICrawlPlanSnapshot } from '@/lib/database/provider/types.domain';

vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
// Host blocking is under test here, not DNS resolution.
vi.mock('@/lib/services/crawler/engine/ssrf', () => ({
  assertResolvedUrl: vi.fn().mockResolvedValue(undefined),
}));

describe('normalizeBlockedHost', () => {
  it.each([
    ['cdn.example.com', 'cdn.example.com'],
    ['  CDN.Example.COM  ', 'cdn.example.com'],
    ['*.cdn.example.com', 'cdn.example.com'],
    ['.cdn.example.com', 'cdn.example.com'],
    ['cdn.example.com.', 'cdn.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['BÜCHER.Example', 'xn--bcher-kva.example'],
    ['*.bücher.example', 'xn--bcher-kva.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    // Unicode dots and a full-width asterisk are markers too, once URL parsing has read them
    ['bücher.example。', 'xn--bcher-kva.example'],
    ['。bücher.example', 'xn--bcher-kva.example'],
    ['*。bücher.example', 'xn--bcher-kva.example'],
    ['＊.bücher.example', 'xn--bcher-kva.example'],
    ['bücher.example．', 'xn--bcher-kva.example'],
    ['｡bücher.example｡', 'xn--bcher-kva.example'],
    ['*。cdn。example。com。', 'cdn.example.com'],
    ['ＣＤＮ.Ｅxample.com', 'cdn.example.com'],
    // A leading marker must not turn an IPv4 address into an invalid host: a dotted name
    // ending in a number is read as an address, and `.127.0.0.1` is not one.
    ['.127.0.0.1', '127.0.0.1'],
    ['*.127.0.0.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
    ['*.127.0.0.1.', '127.0.0.1'],
    ['.0x7f.1', '127.0.0.1'],
    ['*.10.0.0.5', '10.0.0.5'],
    ['.localhost', 'localhost'],
    ['a\u3002b.test', 'a.b.test'], // ideographic full stop reads as a dot
    ['under_score.test', 'under_score.test'],
    ['127.0.0.1', '127.0.0.1'],
  ])('turns %j into %j', (raw, expected) => {
    expect(normalizeBlockedHost(raw)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a bare wildcard', '*.'],
    ['a scheme', 'https://cdn.example.com'],
    ['a path', 'cdn.example.com/a.js'],
    ['a port', 'cdn.example.com:8443'],
    ['credentials', 'user@cdn.example.com'],
    ['a query', 'cdn.example.com?x=1'],
    ['a fragment', 'cdn.example.com#x'],
    ['a backslash', 'cdn.example.com\\x'],
    ['whitespace inside', 'cdn example.com'],
    ['a character no host holds', 'exa<mple.com'],
    ['a stray bracket', 'a[b.test'],
    ['a full-width colon', 'a：b.test'],
    ['a full-width slash', 'a／b.test'],
    ['a lone asterisk', '*'],
    ['an asterisk inside the name', 'a*b.test'],
    ['a second wildcard', '*.*.example.com'],
    ['a repeated trailing dot', 'example.com..'],
    ['a repeated leading dot', '..example.com'],
    ['a repeated leading dot before an address', '..127.0.0.1'],
    ['a second wildcard before an address', '*.*.127.0.0.1'],
    ['a wildcard then a second dot', '*..example.com'],
    ['only a dot', '.'],
    ['only Unicode markers', '*。'],
  ])('returns null for %s', (_label, raw) => {
    expect(normalizeBlockedHost(raw)).toBeNull();
  });
});

describe('createHostBlocker', () => {
  const blocked = createHostBlocker();

  it('blocks a tag manager and a consent-manager host', () => {
    expect(blocked('https://bundles.efilli.com/example.com.prod.js')).toBe(true);
    expect(blocked('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123')).toBe(true);
  });

  it('matches by registrable suffix: the host itself and its subdomains only', () => {
    expect(blocked('https://google-analytics.com/collect')).toBe(true);
    expect(blocked('https://www.google-analytics.com/collect')).toBe(true);
    expect(blocked('https://a.b.doubleclick.net/x')).toBe(true);
    // lookalikes that merely END with the same characters are not the tracker
    expect(blocked('https://notgoogle-analytics.com/x')).toBe(false);
    expect(blocked('https://doubleclick.net.evil.example/x')).toBe(false);
    // the suffix appearing in the path or query is irrelevant
    expect(blocked('https://example.com/?u=https://googletagmanager.com/gtm.js')).toBe(false);
    expect(blocked('https://example.com/googletagmanager.com/x.js')).toBe(false);
  });

  it('is case-insensitive and ignores ports', () => {
    expect(blocked('https://WWW.GoogleTagManager.COM:443/gtm.js')).toBe(true);
  });

  it('never blocks ordinary content or the APIs a page needs to render', () => {
    for (const url of [
      'https://www.example.com/assets/scripts/jquery-3.7.1.min.js',
      'https://fonts.googleapis.com/css2?family=Inter',
      'https://fonts.gstatic.com/s/inter/v1/x.woff2',
      'https://www.google.com/recaptcha/api.js',
      'https://cdn.jsdelivr.net/npm/x',
    ]) {
      expect(blocked(url)).toBe(false);
    }
  });

  it('leaves unparseable and host-less URLs to the browser', () => {
    expect(blocked('not a url')).toBe(false);
    expect(blocked('data:text/plain;base64,AAAA')).toBe(false);
    expect(blocked('blob:https://example.com/uuid')).toBe(false);
  });

  it('adds operator hosts to the defaults (leading dot / wildcard tolerated)', () => {
    const b = createHostBlocker({ extra: ['hang.example.com', '*.slow-cdn.test', ' .metrics.test '] });
    expect(b('https://hang.example.com/a.js')).toBe(true);
    expect(b('https://x.slow-cdn.test/a.js')).toBe(true);
    expect(b('https://metrics.test/a.js')).toBe(true);
    expect(b('https://www.googletagmanager.com/gtm.js')).toBe(true); // defaults still on
    expect(b('https://example.com/a.js')).toBe(false);
  });

  it('can turn the defaults off and keep only operator hosts', () => {
    const b = createHostBlocker({ useDefaults: false, extra: ['hang.example.com'] });
    expect(b('https://www.googletagmanager.com/gtm.js')).toBe(false);
    expect(b('https://hang.example.com/a.js')).toBe(true);
    expect(createHostBlocker({ useDefaults: false })('https://www.googletagmanager.com/gtm.js')).toBe(false);
  });

  it('matches an internationalized entry against the punycode form a request URL carries', () => {
    // `new URL(...).hostname` reports `xn--bcher-kva.example` for `bücher.example`,
    // so an entry kept as typed would never match.
    for (const entry of [
      'bücher.example',
      'BÜCHER.Example',
      '*.bücher.example',
      '.bücher.example.',
      'bücher.example。',
      '。bücher.example',
      '*。bücher.example',
      '＊.bücher.example',
    ]) {
      const b = createHostBlocker({ useDefaults: false, extra: [entry] });
      expect(b('https://xn--bcher-kva.example/a.js'), entry).toBe(true);
      expect(b('https://cdn.xn--bcher-kva.example/a.js'), entry).toBe(true);
      expect(b('https://bücher.example/a.js'), entry).toBe(true); // a URL not yet through the browser
      expect(b('https://bucher.example/a.js'), entry).toBe(false);
    }
    // an entry already written as punycode keeps working
    expect(createHostBlocker({ useDefaults: false, extra: ['xn--bcher-kva.example'] })('https://xn--bcher-kva.example/a.js')).toBe(true);
  });

  it('blocks an IP address entered with a marker, as it did before markers were parsed', () => {
    for (const entry of ['.127.0.0.1', '*.127.0.0.1', '127.0.0.1.', '*.127.0.0.1.', '*.0x7f.1']) {
      const b = createHostBlocker({ useDefaults: false, extra: [entry] });
      expect(b('http://127.0.0.1/a.js'), entry).toBe(true);
      expect(b('http://127.0.0.1:8080/a.js'), entry).toBe(true);
      expect(b('http://127.0.0.2/a.js'), entry).toBe(false);
      expect(b('http://10.127.0.1/a.js'), entry).toBe(false);
    }
  });

  it('treats a request host with a trailing dot as the same host', () => {
    expect(blocked('https://www.googletagmanager.com./gtm.js')).toBe(true);
    expect(blocked('https://notgoogletagmanager.com./gtm.js')).toBe(false);
  });

  it('drops an entry that is not a host instead of letting it match something else', () => {
    // `a\b` is read by URL parsers as host `a`: it must be refused, not quietly become `a`.
    const b = createHostBlocker({ useDefaults: false, extra: ['a\\b.test', 'cdn.example.com/x.js', 'exa<mple.com', '*.'] });
    expect(b('https://a.test/x.js')).toBe(false);
    expect(b('https://cdn.example.com/x.js')).toBe(false);
    expect(b('https://anything.test/x.js')).toBe(false);
  });

  it('keeps the default list free of entries that would hide a page’s own content', () => {
    for (const host of DEFAULT_BLOCKED_THIRD_PARTY_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/^[.*]|[/:\s]/);
      // broad infrastructure the page itself relies on (fonts, maps, captchas, CDNs)
      expect(host).not.toMatch(/^(google\.com|gstatic\.com|googleapis\.com|cloudflare\.com|jsdelivr\.net)$/);
    }
  });
});

/**
 * The per-crawler settings (`http.blockTrackers` / `http.blockedHosts`) have to
 * reach the browser's route handler: drive the real PlaywrightSession against a
 * fake Chromium and replay requests through the handler it registers. Tracker
 * blocking is opt-in, so a crawler that sets nothing loads everything.
 */
describe('PlaywrightSession — per-crawler tracker blocking', () => {
  type RouteHandler = (route: unknown) => unknown;
  let handler: RouteHandler;

  beforeEach(() => {
    const context = {
      addInitScript: vi.fn(async () => undefined),
      addCookies: vi.fn(async () => undefined),
      route: vi.fn(async (_pattern: string, h: RouteHandler) => {
        handler = h;
      }),
    };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) };
    vi.mocked(chromium.launch).mockResolvedValue(browser as never);
  });

  /** Replays one request through the registered handler; returns what the browser did with it. */
  async function replay(
    http: CrawlHttpConfig,
    url: string,
    { navigation = false, resourceType = 'script' } = {},
  ): Promise<'aborted' | 'continued'> {
    const session = new PlaywrightSession(http, []);
    await (session as unknown as { ensure(): Promise<void> }).ensure();
    let outcome: 'aborted' | 'continued' | undefined;
    await handler({
      request: () => ({
        url: () => url,
        isNavigationRequest: () => navigation,
        resourceType: () => resourceType,
      }),
      abort: vi.fn(async () => {
        outcome = 'aborted';
      }),
      continue: vi.fn(async () => {
        outcome = 'continued';
      }),
    });
    return outcome as 'aborted' | 'continued';
  }

  const GTM = 'https://www.googletagmanager.com/gtm.js?id=GTM-1';
  const EFILLI = 'https://bundles.efilli.com/example.com.prod.js';
  const OWN = 'https://www.example.com/assets/app.js';

  it('loads everything when the crawler sets nothing: blocking is off by default', async () => {
    expect(await replay({}, GTM)).toBe('continued');
    expect(await replay({}, EFILLI)).toBe('continued');
    expect(await replay({}, OWN)).toBe('continued');
  });

  it('treats an explicit false the same as unset', async () => {
    expect(await replay({ blockTrackers: false }, GTM)).toBe('continued');
    expect(await replay({ blockTrackers: false }, EFILLI)).toBe('continued');
  });

  it('blocks the built-in tracker hosts when the crawler turns blocking on', async () => {
    expect(await replay({ blockTrackers: true }, GTM)).toBe('aborted');
    expect(await replay({ blockTrackers: true }, EFILLI)).toBe('aborted');
    expect(await replay({ blockTrackers: true }, OWN)).toBe('continued');
  });

  it('aborts images, media and fonts, and nothing else, whatever the crawler sets', async () => {
    for (const http of [{}, { blockTrackers: true }]) {
      for (const resourceType of ['image', 'media', 'font']) {
        expect(await replay(http, OWN, { resourceType }), resourceType).toBe('aborted');
      }
      for (const resourceType of ['script', 'stylesheet', 'xhr', 'fetch', 'document', 'other']) {
        expect(await replay(http, OWN, { resourceType }), resourceType).toBe('continued');
      }
    }
  });

  it('never blocks the page being crawled, even on a listed host', async () => {
    expect(
      await replay({ blockTrackers: true }, 'https://www.googletagmanager.com/', {
        navigation: true,
        resourceType: 'document',
      }),
    ).toBe('continued');
  });

  it('blocks only the crawler’s own hosts when blocking is left off', async () => {
    const http = { blockedHosts: ['hang.example.com'] };
    expect(await replay(http, 'https://cdn.hang.example.com/a.js')).toBe('aborted');
    expect(await replay(http, GTM)).toBe('continued');
    expect(await replay(http, OWN)).toBe('continued');
  });

  it('blocks a crawler host written with international characters, as the browser reports it', async () => {
    const http = { blockedHosts: ['bücher.example'] };
    // Chromium reports the punycode form of the host in the request URL.
    expect(await replay(http, 'https://cdn.xn--bcher-kva.example/a.js')).toBe('aborted');
    expect(await replay(http, 'https://bucher.example/a.js')).toBe('continued');
  });

  it('blocks a crawler host written as a marker-prefixed IP address', async () => {
    const http = { blockedHosts: ['*.127.0.0.1'] };
    expect(await replay(http, 'http://127.0.0.1/a.js')).toBe('aborted');
    expect(await replay(http, 'http://127.0.0.2/a.js')).toBe('continued');
  });

  it('adds the crawler’s own hosts to the defaults when blocking is on', async () => {
    const http = { blockTrackers: true, blockedHosts: ['hang.example.com'] };
    expect(await replay(http, 'https://hang.example.com/a.js')).toBe('aborted');
    expect(await replay(http, GTM)).toBe('aborted');
    expect(await replay(http, OWN)).toBe('continued');
  });
});

describe('crawler http settings — blockTrackers / blockedHosts', () => {
  const parse = (http: unknown) => createCrawlerInputSchema.safeParse({ name: 'c', http });

  it('are optional, so an existing crawler keeps the default (trackers load)', () => {
    const ok = parse({});
    expect(ok.success && ok.data.http?.blockTrackers).toBeUndefined();
    expect(ok.success && ok.data.http?.blockedHosts).toBeUndefined();
  });

  it('accept an internationalized host and keep it as typed', () => {
    const typed = ['bücher.example', '*.bücher.example', 'bücher.example。', '*。bücher.example'];
    const ok = parse({ blockedHosts: ['  bücher.example  ', ...typed.slice(1)] });
    expect(ok.success && ok.data.http?.blockedHosts).toEqual(typed);
  });

  it('accept an IP address with a leading marker', () => {
    const ok = parse({ blockedHosts: ['.127.0.0.1', '*.127.0.0.1', '10.0.0.5'] });
    expect(ok.success && ok.data.http?.blockedHosts).toEqual(['.127.0.0.1', '*.127.0.0.1', '10.0.0.5']);
  });

  it('accept a switch and a trimmed host list', () => {
    const ok = parse({ blockTrackers: true, blockedHosts: [' hang.example.com ', '*.slow.test', '.metrics.test'] });
    expect(ok.success && ok.data.http).toMatchObject({
      blockTrackers: true,
      blockedHosts: ['hang.example.com', '*.slow.test', '.metrics.test'],
    });
  });

  it.each([
    ['a URL', 'https://cdn.example.com/a.js'],
    ['a path', 'cdn.example.com/a.js'],
    ['a port', 'cdn.example.com:8443'],
    ['whitespace', 'cdn example.com'],
    ['credentials', 'user@cdn.example.com'],
    ['a backslash', 'cdn.example.com\\x'],
    ['a character no host holds', 'exa<mple.com'],
    ['an asterisk inside the name', 'a*b.example.com'],
    ['a repeated trailing dot', 'cdn.example.com..'],
    ['a repeated leading dot before an address', '..127.0.0.1'],
    ['an empty entry', '   '],
  ])('reject a host list entry with %s', (_label, entry) => {
    expect(parse({ blockedHosts: [entry] }).success).toBe(false);
  });

  it('reject a non-boolean switch and an oversized list', () => {
    expect(parse({ blockTrackers: 'false' }).success).toBe(false);
    expect(parse({ blockedHosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`) }).success).toBe(false);
  });

  it('reach the engine plan: a crawl run is where they take effect', () => {
    const plan = snapshotToPlan({
      seeds: [],
      http: { blockTrackers: true, blockedHosts: ['hang.example.com'] },
    } as unknown as ICrawlPlanSnapshot);
    expect(plan.http.blockTrackers).toBe(true);
    expect(plan.http.blockedHosts).toEqual(['hang.example.com']);
  });
});
