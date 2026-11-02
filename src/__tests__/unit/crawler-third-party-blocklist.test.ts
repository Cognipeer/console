/**
 * The crawler's browser aborts sub-resources to tracker / consent hosts so a
 * parser-blocking third-party script that a firewall silently drops cannot
 * hold `domcontentloaded` until the navigation times out.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCKED_THIRD_PARTY_HOSTS,
  createHostBlocker,
} from '@/lib/services/crawler/engine/thirdPartyBlocklist';
import {
  getConfig,
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';

describe('createHostBlocker', () => {
  const blocked = createHostBlocker();

  it('blocks the tag manager and consent host that stalled axess.com.tr', () => {
    expect(blocked('https://bundles.efilli.com/axess.com.tr.prod.js')).toBe(true);
    expect(blocked('https://www.googletagmanager.com/gtm.js?id=GTM-KN4BWJH')).toBe(true);
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
      'https://www.axess.com.tr/assets/scripts/jquery-3.7.1.min.js',
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

  it('keeps the default list free of entries that would hide a page’s own content', () => {
    for (const host of DEFAULT_BLOCKED_THIRD_PARTY_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/^[.*]|[/:\s]/);
      // broad infrastructure the page itself relies on (fonts, maps, captchas, CDNs)
      expect(host).not.toMatch(/^(google\.com|gstatic\.com|googleapis\.com|cloudflare\.com|jsdelivr\.net)$/);
    }
  });
});

describe('config.browser — crawler tracker blocking', () => {
  const original = getConfigSource();
  afterEach(() => setConfigSource(original));
  const withEnv = (o: Record<string, string>): ConfigSource =>
    ({ get: (k: string) => o[k] ?? process.env[k] }) as ConfigSource;

  it('is on by default with no extra hosts', () => {
    setConfigSource(withEnv({}));
    const cfg = getConfig().browser;
    expect(cfg.crawlerBlockTrackers).toBe(true);
    expect(cfg.crawlerBlockedHosts).toEqual([]);
  });

  it('reads CRAWLER_BLOCK_TRACKERS and a comma-separated CRAWLER_BLOCKED_HOSTS', () => {
    setConfigSource(withEnv({
      CRAWLER_BLOCK_TRACKERS: 'false',
      CRAWLER_BLOCKED_HOSTS: 'hang.example.com , cdn.slow.test',
    }));
    const cfg = getConfig().browser;
    expect(cfg.crawlerBlockTrackers).toBe(false);
    expect(cfg.crawlerBlockedHosts).toEqual(['hang.example.com', 'cdn.slow.test']);
  });
});
