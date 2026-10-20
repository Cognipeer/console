import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { OutboundDnsError, OutboundNetworkError, OutboundPrivateTargetError } from '@/lib/security/outboundFetch';
import {
  assertProviderEndpointsAllowed,
  ProviderEndpointError,
  toProviderEndpointError,
} from '@/lib/services/providers/providerEndpointGuard';

const original = getConfigSource();
function use(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
const scope = { tenantId: 't1' };
afterEach(() => setConfigSource(original));

const saas = { DEPLOYMENT_MODE: 'saas' };
const onprem = { DEPLOYMENT_MODE: 'onprem' };

describe('assertProviderEndpointsAllowed', () => {
  it('SaaS rejects loopback, private and metadata targets even with the env switch off', async () => {
    use({ ...saas, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    for (const url of ['http://127.0.0.1:8000/v1', 'http://10.0.0.5/v1', 'http://169.254.169.254/latest']) {
      await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: url }, undefined))
        .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
    }
  });

  it('rejects non-http(s) schemes and bad azure instance names', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'file:///etc/passwd' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('model', scope, undefined, { instanceName: 'a.evil.com/x' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('accepts public URLs and valid instance names', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'https://93.184.216.34/v1' }, { instanceName: 'my-resource' }))
      .resolves.toBeUndefined();
  });

  it('on-prem honours the env switches', async () => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false' });
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'http://10.0.0.5:11434/v1' }))
      .resolves.toBeUndefined();
  });

  // The switch is read the way the rest of the configuration reads a boolean: "true" and "1" are on, everything else is off.
  const SOURCES: Array<[type: 'model' | 'file', sources: Array<Record<string, unknown>>]> = [
    ['model', [{ baseUrl: 'http://10.0.0.5:11434/v1' }]],
    ['file', [{}, { endpoint: 'http://10.0.0.5:9000' }]],
  ];

  it.each(['true', '1'])('on-prem refuses private endpoints of every guarded domain when OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK is %j', async (value) => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: value });
    for (const [type, sources] of SOURCES) {
      await expect(assertProviderEndpointsAllowed(type, scope, ...sources), `${type} with ${value}`).rejects.toBeInstanceOf(ProviderEndpointError);
    }
  });

  it.each(['false', '0', ''])('on-prem allows private endpoints of every guarded domain when OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK is %j', async (value) => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: value });
    for (const [type, sources] of SOURCES) {
      await expect(assertProviderEndpointsAllowed(type, scope, ...sources), `${type} with ${value}`).resolves.toBeUndefined();
    }
  });

  it('on-prem allows private and loopback endpoints by default', async () => {
    use(onprem);
    for (const url of ['http://127.0.0.1:8000/v1', 'http://10.1.2.3:11434/v1']) {
      await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: url })).resolves.toBeUndefined();
    }
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: 'file:///etc/passwd' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('ignores domains that hold no guarded endpoints', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('vector', scope, { baseUrl: 'http://127.0.0.1' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('vector', scope, undefined, { endpoint: '10.0.0.5:9200', authorityHost: 'https://10.0.0.9' }))
      .resolves.toBeUndefined();
  });

  it('guards file stores like model endpoints, and reads their bare hosts as https', async () => {
    use(saas);
    for (const endpoint of ['http://10.0.0.5:9000', 'http://127.0.0.1:9000', 'http://169.254.169.254', '10.0.0.5:9000', 'localhost:9000']) {
      await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint }), endpoint)
        .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint' });
    }
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: 'https://93.184.216.34:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: '93.184.216.34:9000' })).resolves.toBeUndefined();
    // Only a file store takes a bare host: a model URL has to be a URL.
    await expect(assertProviderEndpointsAllowed('model', scope, { baseUrl: '93.184.216.34:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('checks an authority host wherever the domain is guarded', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'https://10.0.0.9' }))
      .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'authorityHost' });
    await expect(assertProviderEndpointsAllowed('model', scope, undefined, { authorityHost: 'http://169.254.169.254' }))
      .rejects.toMatchObject({ field: 'authorityHost' });
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'https://93.184.216.34' })).resolves.toBeUndefined();
  });

  it('on-prem lets a file store reach in-network hosts, unless the deployment blocks them', async () => {
    use(onprem);
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: 'http://10.0.0.5:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: '10.0.0.5:9000' })).resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: '10.0.0.5:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { endpoint: '10.0.0.5:9000' })).resolves.toBeUndefined();
  });
});

describe('toProviderEndpointError', () => {
  it('words a refused private address neutrally: no host, no range, and no second try', () => {
    const error = toProviderEndpointError('endpoint', new OutboundPrivateTargetError('storage.internal.example'));
    expect(error).toBeInstanceOf(ProviderEndpointError);
    expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint', retryable: false });
    expect((error as Error).message).toBe('Provider endpoint "endpoint" is not allowed: private network addresses are reachable only through networks the operator has opened for this organization');
  });

  it('keeps a name that did not resolve retryable, with the words of the error it comes from', () => {
    const error = toProviderEndpointError('connectionString', new OutboundDnsError('Could not resolve host: files.example.test'));
    expect(error).toBeInstanceOf(ProviderEndpointError);
    expect(error).toMatchObject({ field: 'connectionString', retryable: true });
    expect((error as Error).message).toBe('Provider endpoint "connectionString" is not allowed: Could not resolve host: files.example.test');
  });

  it('keeps every other refusal as one that stays refused', () => {
    const error = toProviderEndpointError('endpoint', new OutboundNetworkError('Unsupported protocol for outbound request: ftp:'));
    expect(error).toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint', retryable: false });
    expect((error as Error).message).toContain('Unsupported protocol');
  });

  it('hands back an error that is not a refusal as it is', () => {
    const other = new Error('socket hang up');
    expect(toProviderEndpointError('endpoint', other)).toBe(other);
    expect(toProviderEndpointError('endpoint', 'text')).toBe('text');
  });

  it('is an error that is not retryable unless it says so', () => {
    expect(new ProviderEndpointError('endpoint', 'x').retryable).toBe(false);
    expect(new ProviderEndpointError('endpoint', 'x', { retryable: false }).retryable).toBe(false);
    expect(new ProviderEndpointError('endpoint', 'x', {}).retryable).toBe(false);
    expect(new ProviderEndpointError('endpoint', 'x', { retryable: true }).retryable).toBe(true);
  });
});
