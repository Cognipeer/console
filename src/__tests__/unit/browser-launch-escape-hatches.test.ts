/**
 * Regression test for the operator-controlled Chromium launch escape hatches
 * added alongside the HTTP(S)_PROXY forwarding fix: a live incident where a
 * network required both an egress proxy AND (suspected) a TLS-inspecting
 * corporate proxy that Chromium has no independent way to trust, on a
 * deployment with very limited room for iterative deploy/diagnose cycles.
 * BROWSER_CHROMIUM_EXTRA_ARGS and BROWSER_IGNORE_CERTIFICATE_ERRORS let an
 * operator resolve whatever their specific network needs without a code
 * change and a new release for each one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { getConfig } from '@/lib/core/config';

const original = getConfigSource();

function sourceWith(overrides: Record<string, string>): ConfigSource {
  return {
    get: (key: string) => overrides[key] ?? process.env[key],
  } as ConfigSource;
}

afterEach(() => {
  setConfigSource(original);
});

describe('config.browser — Chromium launch escape hatches', () => {
  it('defaults to no extra args and certificate errors NOT ignored — unchanged for every existing deployment', () => {
    setConfigSource(sourceWith({}));
    const cfg = getConfig().browser;
    expect(cfg.chromiumExtraArgs).toEqual([]);
    expect(cfg.ignoreCertificateErrors).toBe(false);
  });

  it('parses BROWSER_CHROMIUM_EXTRA_ARGS as a comma-separated list, trimmed', () => {
    setConfigSource(sourceWith({
      BROWSER_CHROMIUM_EXTRA_ARGS: '--proxy-bypass-list=*.internal.bank , --disable-gpu,--lang=tr',
    }));
    expect(getConfig().browser.chromiumExtraArgs).toEqual([
      '--proxy-bypass-list=*.internal.bank',
      '--disable-gpu',
      '--lang=tr',
    ]);
  });

  it('enables BROWSER_IGNORE_CERTIFICATE_ERRORS from a truthy value', () => {
    setConfigSource(sourceWith({ BROWSER_IGNORE_CERTIFICATE_ERRORS: 'true' }));
    expect(getConfig().browser.ignoreCertificateErrors).toBe(true);
  });
});
