import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  getConfigSource,
  setConfigSource,
  type ConfigSource,
} from '@/lib/core/config';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'internal.corp.example') return [{ address: '10.1.2.3', family: 4 }];
    if (host === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

import {
  assertPublicUrl,
  isPrivateIpAddress,
  OutboundNetworkError,
  safeFetch,
} from '@/lib/security/outboundFetch';

/** Node's global RequestInit type doesn't declare `dispatcher` (undici's addition). */
type FetchInit = RequestInit & { dispatcher?: unknown };

/** `dns/promises`' overloaded `lookup` type infers the single-address
 * overload against `vi.mocked(lookup)`; the guard always calls it with
 * `{ all: true }`, so tests stub the array-returning shape directly. */
function mockLookupOnce(...results: Array<{ address: string; family: 4 | 6 }[]>): void {
  const mocked = lookup as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => unknown };
  for (const result of results) {
    mocked.mockImplementationOnce(async () => result);
  }
}

const original = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return {
    get: (key: string) => overrides[key] ?? process.env[key],
  } as ConfigSource;
}

beforeEach(() => {
  setConfigSource(sourceWith({}));
});

afterEach(() => {
  setConfigSource(original);
  vi.unstubAllGlobals();
});

describe('isPrivateIpAddress', () => {
  it('flags loopback, private, link-local, CGNAT, metadata and multicast IPv4 space', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
    ]) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1']) {
      expect(isPrivateIpAddress(ip), ip).toBe(false);
    }
  });

  it('flags private IPv6 space including v4-mapped forms', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
    expect(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(OutboundNetworkError);
    await expect(assertPublicUrl('ftp://example.com/x')).rejects.toThrow(OutboundNetworkError);
    await expect(assertPublicUrl('not a url')).rejects.toThrow(OutboundNetworkError);
  });

  it('rejects loopback / private / metadata hosts', async () => {
    for (const url of [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://[::1]:3000/x',
      'http://foo.internal/x',
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(OutboundNetworkError);
    }
  });

  it('rejects hostnames that resolve to private IPs', async () => {
    await expect(assertPublicUrl('https://internal.corp.example/api'))
      .rejects.toThrow(OutboundNetworkError);
  });

  it('rejects hostnames that fail to resolve', async () => {
    await expect(assertPublicUrl('https://does-not-resolve.example/'))
      .rejects.toThrow(OutboundNetworkError);
  });

  it('allows public hosts', async () => {
    await expect(assertPublicUrl('https://public.example.com/api')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://93.184.216.34/api')).resolves.toBeInstanceOf(URL);
  });

  it('honours the allowPrivate option', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x', { allowPrivate: true }))
      .resolves.toBeInstanceOf(URL);
  });

  it('honours OUTBOUND_HTTP_ALLOWED_HOSTS (exact and .suffix entries)', async () => {
    setConfigSource(sourceWith({
      OUTBOUND_HTTP_ALLOWED_HOSTS: 'internal.corp.example, .trusted.internal',
    }));
    await expect(assertPublicUrl('https://internal.corp.example/api'))
      .resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://svc.trusted.internal/api'))
      .resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('https://other.internal/api'))
      .rejects.toThrow(OutboundNetworkError);
  });

  it('honours OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=false', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    await expect(assertPublicUrl('http://127.0.0.1/x')).resolves.toBeInstanceOf(URL);
  });
});

describe('safeFetch', () => {
  it('blocks private targets before any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/'))
      .rejects.toThrow(OutboundNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('performs the request against a public target', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://public.example.com/api');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pins the connection to the resolved address instead of leaving fetch to re-resolve DNS itself', async () => {
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await safeFetch('https://public.example.com/api');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [URL, FetchInit?])[1]?.dispatcher).toBeDefined();
  });

  it('does not attempt to pin a literal-IP URL (nothing to pin)', async () => {
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await safeFetch('https://93.184.216.34/api');

    expect((fetchMock.mock.calls[0] as unknown as [URL, FetchInit?])[1]?.dispatcher).toBeUndefined();
  });

  it('does not pin when the private-network guard itself was bypassed', async () => {
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await safeFetch('https://internal.corp.example/api', undefined, { allowPrivate: true });

    expect((fetchMock.mock.calls[0] as unknown as [URL, FetchInit?])[1]?.dispatcher).toBeUndefined();
  });

  it('re-validates redirect hops and blocks redirects into private space', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/steal' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://public.example.com/redirect'))
      .rejects.toThrow(OutboundNetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows public redirects', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'https://public.example.com/moved' },
      }))
      .mockResolvedValueOnce(new Response('moved-ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await safeFetch('https://public.example.com/old');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('moved-ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after too many redirects', async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://public.example.com/loop' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://public.example.com/loop'))
      .rejects.toThrow(/Too many redirects/);
  });

  it('aborts when the timeout elapses', async () => {
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(safeFetch('https://public.example.com/slow', undefined, { timeoutMs: 20 }))
      .rejects.toThrow();
  });
});

// F-11 (finance-institution assessment, 2026-09-05): assertPublicUrl resolved
// DNS once to decide a hostname was public, then handed the HOSTNAME (not the
// resolved address) to fetch, which resolves it AGAIN at connect time. An
// attacker controlling DNS for the target can answer publicly for the check
// and privately for the connection -- classic TOCTOU / DNS rebinding. Every
// case below uses its own hostname so the 30s privacy cache from earlier
// tests in this file can't hide a lookup call these tests need to count.
describe('DNS rebinding: the address fetch connects to must be the one just checked', () => {
  it('rejects a target whose SECOND (connection-time) resolution differs and is private, even though the first (policy) resolution was public', async () => {
    mockLookupOnce(
      [{ address: '93.184.216.34', family: 4 }], // policy check
      [{ address: '127.0.0.1', family: 4 }], // rebind at connect time
    );

    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(safeFetch('https://rebind-attack.example.com/api'))
      .rejects.toThrow(OutboundNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still succeeds when the second resolution legitimately differs but is also public', async () => {
    mockLookupOnce(
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '203.0.113.9', family: 4 }], // still public, just different
    );

    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await safeFetch('https://rebind-legit.example.com/api');

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [URL, FetchInit?])[1]?.dispatcher).toBeDefined();
  });
});
