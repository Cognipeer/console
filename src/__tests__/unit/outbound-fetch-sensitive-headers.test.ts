/**
 * `safeFetch` follows redirects itself and always drops `Authorization`,
 * `Cookie`, `Proxy-Authorization` and the guardrail signature when a hop
 * changes origin. `sensitiveHeaders` names more: the credential headers a
 * caller configured under names of its own (an API-key header, runtime headers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
    if (host === 'other.example.com') return [{ address: '93.184.216.35', family: 4 }];
    throw new Error(`ENOTFOUND ${host}`);
  }),
}));

import { safeFetch } from '@/lib/security/outboundFetch';

const original = getConfigSource();

beforeEach(() => {
  setConfigSource({ get: (key: string) => process.env[key] } as ConfigSource);
});

afterEach(() => {
  setConfigSource(original);
  vi.unstubAllGlobals();
});

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function headersOfCall(fetchMock: ReturnType<typeof vi.fn>, n: number): Headers {
  const init = fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

const CONFIGURED = {
  'X-Api-Key': 'key-abcdef123456',
  'X-Tenant-Token': 'tenant-abcdef123456',
  Authorization: 'Bearer always-dropped',
};
const HARMLESS = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Source': 'gateway' };

function stubRedirectThenOk(location: string) {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(redirectTo(location))
    .mockResolvedValueOnce(new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('safeFetch sensitiveHeaders — cross-origin redirects', () => {
  it('drops the named headers when the origin changes, and keeps the rest', async () => {
    const fetchMock = stubRedirectThenOk('https://other.example.com/landing');

    await safeFetch(
      'https://public.example.com/start',
      { headers: { ...CONFIGURED, ...HARMLESS } },
      { sensitiveHeaders: ['X-Api-Key', 'x-tenant-token'] },
    );

    const first = headersOfCall(fetchMock, 0);
    expect(first.get('x-api-key')).toBe('key-abcdef123456');
    expect(first.get('x-tenant-token')).toBe('tenant-abcdef123456');

    const second = headersOfCall(fetchMock, 1);
    expect(second.get('x-api-key')).toBeNull();
    expect(second.get('x-tenant-token')).toBeNull();
    // The headers that are always dropped still are.
    expect(second.get('authorization')).toBeNull();
    // A strip, not a reset.
    for (const [name, value] of Object.entries(HARMLESS)) expect(second.get(name), name).toBe(value);
  });

  it('keeps the named headers on a same-origin redirect', async () => {
    const fetchMock = stubRedirectThenOk('https://public.example.com/moved');

    await safeFetch(
      'https://public.example.com/start',
      { headers: { ...CONFIGURED } },
      { sensitiveHeaders: ['X-Api-Key'] },
    );

    const second = headersOfCall(fetchMock, 1);
    expect(second.get('x-api-key')).toBe('key-abcdef123456');
    expect(second.get('authorization')).toBe('Bearer always-dropped');
  });

  it('leaves other callers unaffected: without the option a custom header still follows', async () => {
    const fetchMock = stubRedirectThenOk('https://other.example.com/landing');

    await safeFetch('https://public.example.com/start', { headers: { ...CONFIGURED, ...HARMLESS } });

    const second = headersOfCall(fetchMock, 1);
    expect(second.get('x-api-key')).toBe('key-abcdef123456');
    expect(second.get('authorization')).toBeNull();
  });

  it('matches names case-insensitively and accepts Headers instances', async () => {
    const fetchMock = stubRedirectThenOk('https://other.example.com/landing');

    await safeFetch(
      'https://public.example.com/start',
      { headers: new Headers({ 'x-API-KEY': 'key-abcdef123456', Accept: 'application/json' }) },
      { sensitiveHeaders: ['X-API-Key'] },
    );

    const second = headersOfCall(fetchMock, 1);
    expect(second.get('x-api-key')).toBeNull();
    expect(second.get('accept')).toBe('application/json');
  });

  it('ignores blank and non-string entries', async () => {
    const fetchMock = stubRedirectThenOk('https://other.example.com/landing');

    await safeFetch(
      'https://public.example.com/start',
      { headers: { ...CONFIGURED, ...HARMLESS } },
      { sensitiveHeaders: ['', '   ', undefined as never, 42 as never, 'X-Api-Key'] },
    );

    const second = headersOfCall(fetchMock, 1);
    expect(second.get('x-api-key')).toBeNull();
    for (const [name, value] of Object.entries(HARMLESS)) expect(second.get(name), name).toBe(value);
  });

  it('does not hand the credential back on a later hop to the original origin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectTo('https://other.example.com/hop'))
      .mockResolvedValueOnce(redirectTo('https://public.example.com/back'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await safeFetch(
      'https://public.example.com/start',
      { headers: { ...CONFIGURED, ...HARMLESS } },
      { sensitiveHeaders: ['X-Api-Key'] },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(headersOfCall(fetchMock, 2).get('x-api-key')).toBeNull();
  });
});
