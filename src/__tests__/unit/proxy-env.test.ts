/**
 * Proxy variables as operators actually write them. Linux environment names
 * are case-sensitive and each client reads its own spellings, so a proxy set
 * as `HTTPS_Proxy` reached the Python tooling of a deployment and nothing in
 * this process: the browser went direct and timed out at the firewall.
 */
import { describe, expect, it } from 'vitest';
import { normalizeProxyEnv, readEgressProxyEnv, readProxyVariable } from '@/lib/core/proxyEnv';

describe('readProxyVariable', () => {
  it('prefers the upper-case name, then the lower-case one', () => {
    expect(readProxyVariable('HTTPS_PROXY', { HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:1' }))
      .toEqual({ value: 'http://a:1', variable: 'HTTPS_PROXY' });
    expect(readProxyVariable('HTTPS_PROXY', { https_proxy: 'http://b:1' }))
      .toEqual({ value: 'http://b:1', variable: 'https_proxy' });
  });

  it('falls back to any other casing, and reports the name it was found under', () => {
    expect(readProxyVariable('NO_PROXY', { No_Proxy: 'corp.example' }))
      .toEqual({ value: 'corp.example', variable: 'No_Proxy' });
  });

  it('treats a blank value as unset', () => {
    expect(readProxyVariable('HTTPS_PROXY', { HTTPS_PROXY: '  ', https_proxy: 'http://b:1' }))
      .toEqual({ value: 'http://b:1', variable: 'https_proxy' });
    expect(readProxyVariable('HTTPS_PROXY', { HTTPS_PROXY: '' })).toBeUndefined();
  });
});

describe('readEgressProxyEnv', () => {
  it('uses HTTPS_PROXY for every scheme and falls back to HTTP_PROXY', () => {
    expect(readEgressProxyEnv({ HTTP_PROXY: 'http://h:1', HTTPS_PROXY: 'http://s:1' }).proxy?.value).toBe('http://s:1');
    expect(readEgressProxyEnv({ http_proxy: 'http://h:1', NO_PROXY: 'localhost' })).toEqual({
      proxy: { value: 'http://h:1', variable: 'http_proxy' },
      noProxy: { value: 'localhost', variable: 'NO_PROXY' },
    });
    expect(readEgressProxyEnv({})).toEqual({ proxy: undefined, noProxy: undefined });
  });
});

describe('normalizeProxyEnv', () => {
  it('copies a non-standard spelling to both standard names so every client sees it', () => {
    const env: Record<string, string | undefined> = {
      HTTPS_Proxy: 'http://proxy:3128',
      http_proxy: 'http://proxy:3128',
      No_proxy: '.svc',
    };

    expect(normalizeProxyEnv(env)).toEqual([
      { variable: 'HTTPS_Proxy', adoptedAs: 'HTTPS_PROXY' },
      { variable: 'No_proxy', adoptedAs: 'NO_PROXY' },
    ]);
    expect(env).toMatchObject({
      HTTPS_PROXY: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      NO_PROXY: '.svc',
      no_proxy: '.svc',
    });
    // Already standard: left as it was.
    expect(env.HTTP_PROXY).toBeUndefined();
  });

  it('never overrides a standard name that is already set', () => {
    const env: Record<string, string | undefined> = { https_proxy: 'http://right:1', HTTPS_Proxy: 'http://wrong:1' };
    expect(normalizeProxyEnv(env)).toEqual([]);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.https_proxy).toBe('http://right:1');
  });
});
