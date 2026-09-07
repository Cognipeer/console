/**
 * Regression test for a live incident: every plain `fetch()` call in this
 * codebase (model provider contracts, CRM support handoff) never read
 * HTTP(S)_PROXY the way Chromium already needed to be taught to
 * (browserProxyConfig.ts) -- on a network that requires an egress proxy for
 * internet access, those calls would fail or hang with no proxy named as
 * the cause. `configureOutboundProxy` installs undici's env-driven dispatcher
 * globally, once, at boot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { configureOutboundProxy } from '@/lib/core/outboundProxyBootstrap';

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
const originalDispatcher = getGlobalDispatcher();

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  setGlobalDispatcher(originalDispatcher);
});

describe('configureOutboundProxy', () => {
  it('does nothing when no proxy variable is set — no dispatcher change for the overwhelming majority of deployments', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    setGlobalDispatcher(new Agent());

    configureOutboundProxy();

    expect(getGlobalDispatcher().constructor.name).toBe('Agent');
  });

  it('installs the env-driven proxy dispatcher globally when HTTPS_PROXY is set', () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HTTPS_PROXY = 'http://proxy.internal.example:8080';
    setGlobalDispatcher(new Agent());

    configureOutboundProxy();

    expect(getGlobalDispatcher().constructor.name).toBe('EnvHttpProxyAgent');
  });
});
