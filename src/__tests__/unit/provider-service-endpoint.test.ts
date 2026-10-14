import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';

const db = {
  switchToTenant: vi.fn(),
  findProviderById: vi.fn(),
  findProviderByKey: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
};
vi.mock('@/lib/database', () => ({ getDatabase: async () => db }));

import { createProviderConfig, updateProviderConfig } from '@/lib/services/providers/providerService';

const original = getConfigSource();
afterEach(() => setConfigSource(original));
function saas() {
  setConfigSource({ get: (k: string) => (k === 'DEPLOYMENT_MODE' ? 'saas' : process.env[k]) } as ConfigSource);
}

describe('provider service endpoint validation', () => {
  it('create rejects a private baseUrl before touching the database', async () => {
    saas();
    await expect(createProviderConfig('t', 'tenant', {
      key: 'k', type: 'model', driver: 'openai-compatible', label: 'x',
      credentials: { apiKey: 'a', baseUrl: 'http://127.0.0.1:9/v1' }, createdBy: 'u',
    } as never)).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    expect(db.createProvider).not.toHaveBeenCalled();
  });

  it('update rejects a private baseUrl', async () => {
    saas();
    db.findProviderById.mockResolvedValue({ type: 'model', driver: 'openai-compatible' });
    await expect(updateProviderConfig('t', 'p1', {
      credentials: { baseUrl: 'http://169.254.169.254/' },
    } as never)).rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    expect(db.updateProvider).not.toHaveBeenCalled();
  });
});
