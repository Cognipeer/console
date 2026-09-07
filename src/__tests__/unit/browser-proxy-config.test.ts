/**
 * Regression test for a live incident: on a network that requires an egress
 * proxy (HTTP(S)_PROXY set, matching what stdioRunner.ts already forwards to
 * MCP subprocesses), the crawler's axios engine worked while both the
 * interactive Browser feature and the crawler's Playwright engine could not
 * reach ANY external site — not just a blocked one, not even the simplest
 * page — because chromium.launch() never received the proxy Chromium itself
 * does not read from the environment. The only visible symptom was every
 * page.goto() eventually hitting Playwright's own 30s timeout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrowserProxyConfig } from '@/lib/core/browserProxyConfig';

const PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

function clearProxyEnv(): void {
  for (const key of PROXY_VARS) delete process.env[key];
}

describe('resolveBrowserProxyConfig', () => {
  afterEach(() => {
    clearProxyEnv();
  });

  it('returns undefined when no proxy env var is set — unchanged default for every existing deployment', () => {
    clearProxyEnv();
    expect(resolveBrowserProxyConfig()).toBeUndefined();
  });

  it('prefers HTTPS_PROXY over HTTP_PROXY when both are set', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://https-proxy.internal:8080';
    process.env.HTTP_PROXY = 'http://http-proxy.internal:8080';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://https-proxy.internal:8080' });
  });

  it('falls back to HTTP_PROXY when HTTPS_PROXY is not set', () => {
    clearProxyEnv();
    process.env.HTTP_PROXY = 'http://proxy.internal:3128';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://proxy.internal:3128' });
  });

  it('honours the lowercase variants some environments set instead', () => {
    clearProxyEnv();
    process.env.https_proxy = 'http://lower-case-proxy.internal:8080';
    expect(resolveBrowserProxyConfig()).toEqual({ server: 'http://lower-case-proxy.internal:8080' });
  });

  it('includes NO_PROXY as the bypass list when a proxy is configured', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    process.env.NO_PROXY = 'localhost,.internal,10.0.0.0/8';
    expect(resolveBrowserProxyConfig()).toEqual({
      server: 'http://proxy.internal:8080',
      bypass: 'localhost,.internal,10.0.0.0/8',
    });
  });

  it('omits bypass entirely when NO_PROXY is not set', () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = 'http://proxy.internal:8080';
    const result = resolveBrowserProxyConfig();
    expect(result).toEqual({ server: 'http://proxy.internal:8080' });
    expect(result).not.toHaveProperty('bypass');
  });
});
