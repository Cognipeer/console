import { describe, expect, it } from 'vitest';
import {
  maskAgentSandboxConfig,
  maskAgentSandboxSecrets,
  sealAgentConfigSecrets,
} from '@/lib/services/agents/agentSandboxSecrets';
import type { IAgentConfig } from '@/lib/database';

const refs = {
  envRefs: { REGION: { configId: 'i1', key: 'region', groupId: 'g1' } },
  secretRefs: { KEY: { configId: 'i2', key: 'api-key', groupId: 'g1' } },
  groupRefs: [{ groupId: 'g1', key: 'shared' }],
};

describe('config references are not secret', () => {
  it('survive sealing next to typed secrets, which are still sealed', () => {
    const sealed = sealAgentConfigSecrets({ modelKey: 'gpt', sandbox: { enabled: true, secrets: { TOKEN: 'typed-secret' }, ...refs } } as IAgentConfig, undefined);
    expect(sealed.sandbox).toMatchObject(refs);
    expect(sealed.sandbox).not.toHaveProperty('secrets');
    expect(sealed.sandbox?.secretsSealed).toBeTruthy();
    expect(JSON.stringify(sealed)).not.toContain('typed-secret');
  });

  it('are returned as stored when an agent leaves the API, and in an export', () => {
    const sealed = sealAgentConfigSecrets({ modelKey: 'gpt', sandbox: { enabled: true, secrets: { TOKEN: 'typed-secret' }, ...refs } } as IAgentConfig, undefined);
    const masked = maskAgentSandboxSecrets({ config: sealed }).config!.sandbox!;
    expect(masked).toMatchObject(refs);
    expect(masked.secrets).toEqual({ TOKEN: '••••••' });
    expect(maskAgentSandboxConfig(sealed.sandbox)).toMatchObject(refs);
  });

  it('are kept when a save leaves the typed secrets alone', () => {
    const stored = sealAgentConfigSecrets({ modelKey: 'gpt', sandbox: { enabled: true, secrets: { TOKEN: 'typed-secret' } } } as IAgentConfig, undefined);
    const next = sealAgentConfigSecrets({ modelKey: 'gpt', sandbox: { enabled: true, ...refs } } as IAgentConfig, stored);
    expect(next.sandbox).toMatchObject(refs);
    expect(next.sandbox?.secretsSealed).toBe(stored.sandbox?.secretsSealed);
  });
});
