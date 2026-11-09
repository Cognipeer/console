import { afterEach, describe, expect, it } from 'vitest';
import * as config from '@/lib/core/config';
import { isStdioRunnerEnabled } from '@/lib/services/mcp/stdioRunner';
import { resolveDefaultFailMode } from '@/lib/services/guardrail/guardrailService';

function use(values: Record<string, string>) {
  config.setConfigSource({ name: 'test', get: (key) => values[key] });
}

afterEach(() => {
  config.setConfigSource({ name: 'test', get: () => undefined });
});

describe('stdio runner default', () => {
  it('is off for saas and on for onprem unless set explicitly', () => {
    use({ DEPLOYMENT_MODE: 'saas' });
    expect(isStdioRunnerEnabled()).toBe(false);
    use({ DEPLOYMENT_MODE: 'onprem' });
    expect(isStdioRunnerEnabled()).toBe(true);
    use({ DEPLOYMENT_MODE: 'saas', MCP_STDIO_ENABLED: 'true' });
    expect(isStdioRunnerEnabled()).toBe(true);
    use({ DEPLOYMENT_MODE: 'onprem', MCP_STDIO_ENABLED: 'false' });
    expect(isStdioRunnerEnabled()).toBe(false);
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
