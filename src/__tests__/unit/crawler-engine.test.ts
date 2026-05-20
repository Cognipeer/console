/**
 * Unit tests — crawler engine helpers
 * Covers: URL normalize, link extraction with scope, SSRF guard.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  isSkippableExtension,
  isSupportedHttpUrl,
  matchesAny,
} from '@/lib/services/crawler/engine/normalize';
import { extractLinks } from '@/lib/services/crawler/engine/links';
import { assertSafeUrl, isPrivateHost } from '@/lib/services/crawler/engine/ssrf';

describe('engine/normalize', () => {
  it('lowercases hostname and strips trailing slash', () => {
    expect(normalizeUrl('HTTPS://Example.COM/docs/')).toBe('https://example.com/docs');
  });

  it('strips tracking params and sorts the remainder', () => {
    const out = normalizeUrl('https://x.com/p?utm_source=a&z=1&a=2&fbclid=x');
    expect(out).toBe('https://x.com/p?a=2&z=1');
  });

  it('detects skippable extensions', () => {
    expect(isSkippableExtension('https://x.com/photo.jpg')).toBe(true);
    expect(isSkippableExtension('https://x.com/page')).toBe(false);
  });

  it('rejects non-http schemes', () => {
    expect(isSupportedHttpUrl('mailto:foo@bar.com')).toBe(false);
    expect(isSupportedHttpUrl('https://x.com')).toBe(true);
    expect(isSupportedHttpUrl('#')).toBe(false);
  });

  it('matches host globs', () => {
    expect(matchesAny('docs.example.com', ['*.example.com'])).toBe(true);
    expect(matchesAny('docs.example.com', ['*.foo.com'])).toBe(false);
    expect(matchesAny('docs.example.com', ['docs.example.com'])).toBe(true);
  });
});

describe('engine/links', () => {
  const html = `
    <html>
      <body>
        <a href="/about">About</a>
        <a href="https://example.com/docs/page">Docs</a>
        <a href="https://sub.example.com/sub">Sub</a>
        <a href="https://other.com/foo">Other</a>
        <a href="mailto:foo@x.com">Mail</a>
        <a href="javascript:void(0)">JS</a>
        <a href="/photo.png">Image</a>
      </body>
    </html>
  `;

  it('extracts only same-domain http(s) links by default', () => {
    const links = extractLinks({
      html,
      pageUrl: 'https://example.com/docs',
      rootDomain: 'example.com',
      scope: { sameDomainOnly: true, includeSubdomains: false },
      visited: new Set(),
    });
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://example.com/docs/page');
    expect(links.some((l) => l.includes('sub.example.com'))).toBe(false);
    expect(links.some((l) => l.includes('other.com'))).toBe(false);
    expect(links.some((l) => l.endsWith('.png'))).toBe(false);
  });

  it('includes subdomains when configured', () => {
    const links = extractLinks({
      html,
      pageUrl: 'https://example.com/docs',
      rootDomain: 'example.com',
      scope: { sameDomainOnly: true, includeSubdomains: true },
      visited: new Set(),
    });
    expect(links.some((l) => l.includes('sub.example.com'))).toBe(true);
  });

  it('respects allowList over sameDomainOnly', () => {
    const links = extractLinks({
      html,
      pageUrl: 'https://example.com/docs',
      rootDomain: 'example.com',
      scope: {
        sameDomainOnly: true,
        includeSubdomains: false,
        allowList: ['other.com'],
      },
      visited: new Set(),
    });
    expect(links.some((l) => l.includes('other.com'))).toBe(true);
    // example.com is not in allowList → excluded
    expect(links.some((l) => l.startsWith('https://example.com'))).toBe(false);
  });
});

describe('engine/ssrf', () => {
  it('flags loopback hosts', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
  });

  it('flags RFC1918 + metadata IPs', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('172.16.5.5')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
  });

  it('lets public hosts through', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });

  it('assertSafeUrl throws on private host unless opted in', () => {
    expect(() => assertSafeUrl('http://127.0.0.1/x')).toThrow(/private/i);
    expect(() => assertSafeUrl('http://127.0.0.1/x', true)).not.toThrow();
  });
});
