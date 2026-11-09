import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from '@/lib/core/config';
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/logger')>();
  return {
    ...actual,
    createLogger: (scope: string) => {
      const real = actual.createLogger(scope);
      if (scope !== 'mcp-stdio-runner') return real;
      return new Proxy(real, { get: (target, prop) => (prop === 'warn' ? warn : Reflect.get(target, prop)) });
    },
  };
});

import { __resetStdioWarningForTests, isStdioRunnerEnabled } from '@/lib/services/mcp/stdioRunner';
import { resolveDefaultFailMode } from '@/lib/services/guardrail/guardrailService';

function use(values: Record<string, string>) {
  config.setConfigSource({ name: 'test', get: (key) => values[key] });
}

afterEach(() => {
  config.setConfigSource({ name: 'test', get: () => undefined });
});

describe('stdio runner default', () => {
  beforeEach(() => {
    warn.mockClear();
    __resetStdioWarningForTests();
  });

  it('is on for every deployment mode, with one notice per process on saas', () => {
    use({ DEPLOYMENT_MODE: 'onprem' });
    expect(isStdioRunnerEnabled()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    use({ DEPLOYMENT_MODE: 'saas' });
    expect(isStdioRunnerEnabled()).toBe(true);
    expect(isStdioRunnerEnabled()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('MCP_STDIO_ENABLED=false');
  });

  it('can be turned off with MCP_STDIO_ENABLED=false, without a notice', () => {
    use({ DEPLOYMENT_MODE: 'saas', MCP_STDIO_ENABLED: 'false' });
    expect(isStdioRunnerEnabled()).toBe(false);
    use({ DEPLOYMENT_MODE: 'onprem', MCP_STDIO_ENABLED: 'false' });
    expect(isStdioRunnerEnabled()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads false/0/no/off in any case as off and anything else as on', () => {
    for (const value of ['FALSE', ' False ', '0', 'no', 'OFF']) {
      use({ DEPLOYMENT_MODE: 'onprem', MCP_STDIO_ENABLED: value });
      expect(isStdioRunnerEnabled(), value).toBe(false);
    }
    for (const value of ['true', '1', 'yes', '', 'maybe']) {
      use({ DEPLOYMENT_MODE: 'onprem', MCP_STDIO_ENABLED: value });
      expect(isStdioRunnerEnabled(), value).toBe(true);
    }
  });
});

describe('guardrail default fail mode', () => {
  const pii = { pii: { enabled: true } } as never;
  const none = { pii: { enabled: false }, promptShield: { enabled: false } } as never;

  it('is closed for presets running PII or prompt-shield checks', () => {
    use({});
    expect(resolveDefaultFailMode('preset', pii)).toBe('closed');
    expect(resolveDefaultFailMode('preset', none)).toBe('open');
    expect(resolveDefaultFailMode('custom', undefined)).toBe('open');
  });

  it('can be set back to open', () => {
    use({ GUARDRAIL_DEFAULT_FAIL_MODE: 'open' });
    expect(resolveDefaultFailMode('preset', pii)).toBe('open');
  });
});
