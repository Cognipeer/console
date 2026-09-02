/**
 * Review findings #7, #8 (ranges) and #9 (guard half) on the shared outbound
 * helper, `src/lib/security/outboundFetch.ts`.
 *
 *  #7  `safeFetch` followed redirects manually and re-issued `init` VERBATIM on
 *      every hop, so a tenant's webhook host that 302s to another origin
 *      handed that origin the bearer token, the cookies and the HMAC body
 *      signature. Native fetch strips `Authorization` cross-origin; the loop
 *      now does the same, plus `cookie`, `proxy-authorization` and every
 *      `x-cognipeer-signature*` header.
 *  #8  `isPrivateIpAddress` had no rule for NAT64 (`64:ff9b::/96`), 6to4
 *      (`2002::/16`) or the HEX spelling of an IPv4-mapped address
 *      (`::ffff:7f00:1`) — each a way to spell 127.0.0.1 or 169.254.169.254
 *      the guard did not recognise.
 *  #9  `assertPublicUrl` returned early under `OUTBOUND_HTTP_BLOCK_PRIVATE_
 *      NETWORK=false` or an allowlisted host, with no way for a POLICY check to
 *      insist. `forceBlock` is that way.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'other.example.com') return [{ address: '93.184.216.35', family: 4 }];
    if (host === 'internal.corp.example') return [{ address: '10.1.2.3', family: 4 }];
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

import {
  assertPublicUrl,
  isPrivateIpAddress,
  OutboundNetworkError,
  safeFetch,
} from '@/lib/security/outboundFetch';

const original = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return { get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource;
}

beforeEach(() => {
  setConfigSource(sourceWith({}));
});

afterEach(() => {
  setConfigSource(original);
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════════════════════════
// #7 — credentials do not follow a cross-origin redirect
// ═══════════════════════════════════════════════════════════════════════════

const SENSITIVE = {
  authorization: 'Bearer provider-credential',
  cookie: 'session=abc',
  'proxy-authorization': 'Basic xyz',
  'x-cognipeer-signature': 't=1,v1=deadbeef',
};
const HARMLESS = {
  'content-type': 'application/json',
  'x-cognipeer-delivery-id': 'gr_1',
  'user-agent': 'cognipeer-guardrail/1.0',
};

/** The headers `fetch` was handed on its Nth call, normalised. */
function headersOfCall(fetchMock: ReturnType<typeof vi.fn>, n: number): Headers {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('safeFetch: a redirect to ANOTHER origin drops the credentials', () => {
  it('strips authorization, cookie, proxy-authorization and the HMAC signature', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://other.example.com/collector'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await safeFetch('https://public.example.com/hook', {
      method: 'POST',
      headers: { ...SENSITIVE, ...HARMLESS },
      body: '{"signed":"body"}',
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Hop 0 went to the configured host WITH everything.
    const first = headersOfCall(fetchMock, 0);
    for (const name of Object.keys(SENSITIVE)) expect(first.get(name), name).not.toBeNull();

    // Hop 1 went to the other origin WITHOUT the credentials, and the
    // harmless headers survived — this is a strip, not a reset.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://other.example.com/collector');
    const second = headersOfCall(fetchMock, 1);
    for (const name of Object.keys(SENSITIVE)) expect(second.get(name), name).toBeNull();
    for (const [name, value] of Object.entries(HARMLESS)) expect(second.get(name), name).toBe(value);
  });

  it('handles `init.headers` given as a Headers instance too', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://other.example.com/x'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://public.example.com/hook', {
      headers: new Headers({ Authorization: 'Bearer t', 'X-Cognipeer-Signature-V2': 'sig', Accept: 'application/json' }),
    });
    const second = headersOfCall(fetchMock, 1);
    expect(second.get('authorization')).toBeNull();
    // Any `x-cognipeer-signature*` variant, not just today's exact name.
    expect(second.get('x-cognipeer-signature-v2')).toBeNull();
    expect(second.get('accept')).toBe('application/json');
  });

  it('keeps the credentials on a SAME-origin redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://public.example.com/moved'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://public.example.com/hook', { headers: { ...SENSITIVE } });
    const second = headersOfCall(fetchMock, 1);
    for (const [name, value] of Object.entries(SENSITIVE)) expect(second.get(name), name).toBe(value);
  });

  it('a scheme or port change is a different origin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://public.example.com:8443/hook'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch('https://public.example.com/hook', { headers: { authorization: 'Bearer t' } });
    expect(headersOfCall(fetchMock, 1).get('authorization')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #8 — the missing special ranges
// ═══════════════════════════════════════════════════════════════════════════

describe('isPrivateIpAddress: NAT64, 6to4 and hex-form mapped IPv4', () => {
  it('64:ff9b::/96 (NAT64) is judged by the embedded IPv4 address', () => {
    expect(isPrivateIpAddress('64:ff9b::7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateIpAddress('64:ff9b::a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateIpAddress('64:ff9b::a00:1')).toBe(true); // 10.0.0.1
    expect(isPrivateIpAddress('64:ff9b::10.0.0.1')).toBe(true); // dotted tail
    expect(isPrivateIpAddress('64:ff9b::5db8:d822')).toBe(false); // 93.184.216.34
  });

  it('2002::/16 (6to4) is judged by the embedded IPv4 address', () => {
    expect(isPrivateIpAddress('2002:7f00:1::')).toBe(true); // 127.0.0.1
    expect(isPrivateIpAddress('2002:a9fe:a9fe::1')).toBe(true); // 169.254.169.254
    expect(isPrivateIpAddress('2002:c0a8:101::')).toBe(true); // 192.168.1.1
    expect(isPrivateIpAddress('2002:5db8:d822::')).toBe(false); // 93.184.216.34
  });

  it('::ffff: mapped IPv4 in HEX form is recognised, not just the dotted spelling', () => {
    expect(isPrivateIpAddress('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateIpAddress('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isPrivateIpAddress('::ffff:ac10:1')).toBe(true); // 172.16.0.1
    expect(isPrivateIpAddress('::ffff:5db8:d822')).toBe(false); // 93.184.216.34 — public stays public
    // The dotted form keeps working.
    expect(isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('keeps every verdict the existing suite pins', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIpAddress(ip), ip).toBe(true);
    }
    expect(isPrivateIpAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    expect(isPrivateIpAddress('2001:4860:4860::8888')).toBe(false);
  });

  it('assertPublicUrl refuses each range as a URL host literal', async () => {
    for (const url of [
      'http://[64:ff9b::7f00:1]/latest/meta-data/',
      'http://[2002:a9fe:a9fe::]/latest/meta-data/',
      'http://[::ffff:7f00:1]:3000/x',
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(OutboundNetworkError);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #9 — forceBlock
// ═══════════════════════════════════════════════════════════════════════════

describe('assertPublicUrl: forceBlock runs the check the deployment turned off', () => {
  it('OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=false is ignored under forceBlock', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' }));
    await expect(assertPublicUrl('http://10.0.0.5/admin')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://10.0.0.5/admin', { forceBlock: true })).rejects.toThrow(OutboundNetworkError);
    await expect(assertPublicUrl('https://internal.corp.example/api', { forceBlock: true })).rejects.toThrow(
      OutboundNetworkError,
    );
  });

  it('the host allowlist is ignored under forceBlock', async () => {
    setConfigSource(sourceWith({ OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5, .corp.example' }));
    await expect(assertPublicUrl('http://10.0.0.5/admin')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('http://10.0.0.5/admin', { forceBlock: true })).rejects.toThrow(OutboundNetworkError);
    await expect(assertPublicUrl('https://internal.corp.example/api', { forceBlock: true })).rejects.toThrow(
      OutboundNetworkError,
    );
  });

  it('allowPrivate is ignored under forceBlock, and public targets still pass', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/x', { allowPrivate: true, forceBlock: true })).rejects.toThrow(
      OutboundNetworkError,
    );
    await expect(assertPublicUrl('https://public.example.com/api', { forceBlock: true })).resolves.toBeInstanceOf(URL);
  });
});
