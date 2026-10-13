import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  assertProviderEndpointsAllowed,
  ProviderEndpointError,
} from '@/lib/services/providers/providerEndpointGuard';

const original = getConfigSource();
function use(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
afterEach(() => setConfigSource(original));

const saas = { DEPLOYMENT_MODE: 'saas' };
const onprem = { DEPLOYMENT_MODE: 'onprem' };

describe('assertProviderEndpointsAllowed', () => {
  it('SaaS rejects loopback, private and metadata targets even with the env switch off', async () => {
    use({ ...saas, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    for (const url of ['http://127.0.0.1:8000/v1', 'http://10.0.0.5/v1', 'http://169.254.169.254/latest']) {
      await expect(assertProviderEndpointsAllowed('model', { baseUrl: url }, undefined))
        .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    }
  });

  it('rejects non-http(s) schemes and bad azure instance names', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('model', { baseUrl: 'file:///etc/passwd' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('model', undefined, { instanceName: 'a.evil.com/x' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('accepts public URLs and valid instance names', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('model', { baseUrl: 'https://93.184.216.34/v1' }, { instanceName: 'my-resource' }))
      .resolves.toBeUndefined();
  });

  it('on-prem honours the env switches', async () => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    await expect(assertProviderEndpointsAllowed('model', { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderEndpointsAllowed('model', { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    await expect(assertProviderEndpointsAllowed('model', { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .resolves.toBeUndefined();
  });

  it('ignores non-inference domains', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('vector', { baseUrl: 'http://127.0.0.1' })).resolves.toBeUndefined();
  });
});
