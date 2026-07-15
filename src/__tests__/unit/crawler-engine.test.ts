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
import { isTransientFetchError, retry } from '@/lib/services/crawler/engine/concurrency';
import { htmlToMarkdown, cleanupMarkdown, markdownToText } from '@/lib/services/crawler/engine/markdown';

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

describe('engine/concurrency — error classification', () => {
  it('treats broken TLS chains as permanent (not retryable)', () => {
    expect(isTransientFetchError(new Error(
      'Axios error for https://x/y.pdf: unable to verify the first certificate',
    ))).toBe(false);
    expect(isTransientFetchError(new Error('self-signed certificate in chain'))).toBe(false);
  });

  it('treats DNS + 4xx as permanent', () => {
    expect(isTransientFetchError(new Error('getaddrinfo ENOTFOUND example.test'))).toBe(false);
    expect(isTransientFetchError(new Error('HTTP 404 for https://x/missing'))).toBe(false);
    expect(isTransientFetchError(new Error('HTTP 403 for https://x/forbidden'))).toBe(false);
  });

  it('keeps timeouts, resets, 5xx and 429 retryable', () => {
    expect(isTransientFetchError(new Error('Timeout fetching https://x (30000ms)'))).toBe(true);
    expect(isTransientFetchError(new Error('socket hang up ECONNRESET'))).toBe(true);
    expect(isTransientFetchError(new Error('HTTP 503 for https://x'))).toBe(true);
    expect(isTransientFetchError(new Error('HTTP 429 for https://x'))).toBe(true);
  });

  it('retry() bails immediately on a non-retryable error', async () => {
    let calls = 0;
    await expect(retry(async () => {
      calls += 1;
      throw new Error('unable to verify the first certificate');
    }, 3, { isRetryable: isTransientFetchError, initialDelayMs: 1 })).rejects.toThrow(/certificate/);
    expect(calls).toBe(1); // no wasted retries on a permanent failure
  });
});

describe('engine/markdown — output cleanup', () => {
  it('strips base64 data: images by default', async () => {
    const bigDataUri = `data:image/jpg;base64,${'A'.repeat(5000)}`;
    const html = `<html><body><h1>Title</h1><img src="${bigDataUri}"><p>Real content here</p></body></html>`;
    const md = await htmlToMarkdown({ html });
    expect(md).not.toContain('base64');
    expect(md.length).toBeLessThan(1000);
    expect(md).toContain('Real content');
  });

  it('caps body length when maxBodyChars is set', async () => {
    const html = `<html><body><p>${'word '.repeat(2000)}</p></body></html>`;
    const md = await htmlToMarkdown({ html, options: { maxBodyChars: 100 } });
    expect(md).toContain('truncated');
    expect(md.length).toBeLessThan(300);
  });

  it('honors removeSelectors', async () => {
    const html = '<html><body><nav>MENU LINKS</nav><main>Body text</main></body></html>';
    const md = await htmlToMarkdown({ html, options: { removeSelectors: ['nav'] } });
    expect(md).not.toContain('MENU LINKS');
    expect(md).toContain('Body text');
  });
});

describe('engine/markdown — cleanup pass', () => {
  it('decodes leftover HTML entities', () => {
    expect(cleanupMarkdown('Foo&nbsp;bar &amp; baz &#39;x&#39;')).toBe("Foo bar & baz 'x'");
  });

  it('reduces dead anchor / javascript links to their text', () => {
    expect(cleanupMarkdown('[About Us](#) and [Go](javascript:void(0))')).toBe('About Us and Go');
    // Real links are preserved.
    expect(cleanupMarkdown('[Home](/tr)')).toBe('[Home](/tr)');
  });

  it('drops marker-only lines and collapses blank-line runs', () => {
    const dirty = '## Real Heading\n\n##\n\n\n\n*\n\nBody';
    const clean = cleanupMarkdown(dirty);
    expect(clean).toContain('## Real Heading');
    expect(clean).toContain('Body');
    expect(clean).not.toMatch(/\n{3,}/);
    expect(clean).not.toMatch(/^##\s*$/m);
  });
});

describe('engine/markdown — text output', () => {
  it('flattens markdown to clean plain text', async () => {
    const html = '<html><body><h1>Title</h1><p><strong>Bold</strong> and <a href="/x">link</a>.</p><ul><li>one</li><li>two</li></ul></body></html>';
    const md = await htmlToMarkdown({ html, options: { outputFormat: 'text' } });
    expect(md).not.toMatch(/[#*`>]/);      // no markdown markers
    expect(md).not.toContain('](');        // no link syntax
    expect(md).toContain('Title');
    expect(md).toContain('Bold and link');
    expect(md).toContain('one');
  });

  it('markdownToText flattens table rows to spaced cells', () => {
    const table = '| Phone | +90 212 |\n| --- | --- |\n| Address | Istanbul |';
    const text = markdownToText(table);
    expect(text).not.toContain('|');
    expect(text).not.toContain('---');
    expect(text).toContain('Phone +90 212');
    expect(text).toContain('Address Istanbul');
  });
});
