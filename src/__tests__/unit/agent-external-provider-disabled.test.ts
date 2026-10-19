/**
 * A connected agent whose key comes from a provider the operator switched off
 * does not call out: the provider lends its credentials to nobody, and the
 * connection's inline key is not used in its place. A provider that is on
 * keeps working, and one that cannot be read still falls back to the inline key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  provider: { status: 'active' as string, missing: false },
}));

vi.mock('@/lib/security/outboundFetch', () => ({
  safeFetch: hoisted.safeFetch,
}));

// The provider store, with the real rule: only an explicit `disabled` blocks use.
vi.mock('@/lib/services/providers/providerService', () => {
  class ProviderDisabledError extends Error {
    constructor(key: string) {
      super(`Provider "${key}" is disabled`);
      this.name = 'ProviderDisabledError';
    }
  }
  return {
    ProviderDisabledError,
    assertProviderEnabled: (record: { key: string; status?: string }) => {
      if (record.status === 'disabled') throw new ProviderDisabledError(record.key);
    },
    loadProviderRuntimeData: vi.fn(async () => {
      if (hoisted.provider.missing) throw new Error('Provider configuration "agent-creds" not found.');
      return { record: { key: 'agent-creds', status: hoisted.provider.status }, credentials: { apiKey: 'from-provider' } };
    }),
  };
});

import type { IExternalAgentConnection } from '@/lib/database';
import { invokeExternalAgent } from '@/lib/services/agents/externalAgent';
import { encryptObject } from '@/lib/utils/crypto';

const CTX = { tenantDbName: 'tenant_a', tenantId: 'tenant-a', projectId: 'proj-1' };
const MESSAGES = [{ role: 'user', content: 'hi' }];

function connection(): IExternalAgentConnection {
  return {
    protocol: 'openai-chat',
    url: 'https://agent.example.com/v1',
    model: 'm-1',
    credentialProviderKey: 'agent-creds',
    apiKeyEnc: encryptObject('inline-key'),
  } as IExternalAgentConnection;
}

const answer = () => new Response(
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

const sentAuthorization = () => {
  const init = hoisted.safeFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
};

beforeEach(() => {
  process.env.PROVIDER_ENCRYPTION_SECRET ??= 'test-provider-encryption-secret-0123456789';
  hoisted.safeFetch.mockReset();
  hoisted.safeFetch.mockImplementation(async () => answer());
  hoisted.provider = { status: 'active', missing: false };
});

describe('a connected agent keyed by a provider', () => {
  it('uses the provider\'s key while the provider is on', async () => {
    const result = await invokeExternalAgent(connection(), MESSAGES, CTX);
    expect(result.content).toBe('hello');
    expect(sentAuthorization()).toBe('Bearer from-provider');
  });

  it('does not call out when the provider is switched off, not even with the inline key', async () => {
    hoisted.provider.status = 'disabled';
    await expect(invokeExternalAgent(connection(), MESSAGES, CTX)).rejects.toMatchObject({
      name: 'ProviderDisabledError',
      message: 'Provider "agent-creds" is disabled',
    });
    expect(hoisted.safeFetch).not.toHaveBeenCalled();
  });

  it('still falls back to the inline key when the provider cannot be read', async () => {
    hoisted.provider.missing = true;
    await invokeExternalAgent(connection(), MESSAGES, CTX);
    expect(sentAuthorization()).toBe('Bearer inline-key');
  });
});
