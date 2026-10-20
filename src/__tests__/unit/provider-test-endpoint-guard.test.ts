import { afterEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  assertProviderTestEndpointsAllowed,
  hasUnvettableEndpoint,
  ProviderEndpointError,
} from '@/lib/services/providers/providerEndpointGuard';

const original = getConfigSource();
function use(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
const scope = { tenantId: 't1' };
afterEach(() => setConfigSource(original));

const saas = { DEPLOYMENT_MODE: 'saas' };
const onprem = { DEPLOYMENT_MODE: 'onprem' };

describe('assertProviderTestEndpointsAllowed (every domain, not only inference)', () => {
  it('SaaS refuses a private http endpoint of a vector or file provider', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { url: 'http://10.0.0.5:9200' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('file', scope, undefined, { endpoint: 'http://169.254.169.254/' }))
      .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed' });
  });

  it('SaaS refuses the host of a connection string, whatever the field is called', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { connectionString: 'postgres://u:p@10.0.0.7:5432/db' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { uri: 'mongodb://127.0.0.1:27017,93.184.216.34:27017/x' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS refuses a bare host field that is private', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { host: '192.168.1.10:6379' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS refuses a scheme-less private endpoint (S3-compatible host:port)', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('file', scope, undefined, { endpoint: '10.1.2.3:9000' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('file', scope, undefined, { endpoint: 'localhost:9000' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS refuses a private Entra authority host of a file provider, and takes a public one', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('file', scope, { authorityHost: 'https://10.0.0.9' }, { endpoint: 'https://93.184.216.34' }))
      .rejects.toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'authorityHost' });
    await expect(assertProviderTestEndpointsAllowed('file', scope, { authorityHost: 'https://93.184.216.34' }, { endpoint: '93.184.216.34:9000' }))
      .resolves.toBeUndefined();
  });

  it('accepts public endpoints and values that name no server', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed(
      'vector',
      scope,
      { apiKey: 'sk-secret-value', url: 'https://93.184.216.34/v1' },
      { region: 'eu-west-1', uri: 'mongodb://93.184.216.34:27017/x' },
    )).resolves.toBeUndefined();
  });

  it('on-prem lets private endpoints through unless the deployment blocks them', async () => {
    use(onprem);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { url: 'http://10.0.0.5:9200' })).resolves.toBeUndefined();
    await expect(assertProviderTestEndpointsAllowed('file', scope, undefined, { endpoint: '10.0.0.5:9000' })).resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { url: 'http://10.0.0.5:9200' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('file', scope, undefined, { endpoint: '10.0.0.5:9000' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS vets the hosts a connection string names in its options, which win over the authority', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { connectionString: 'postgres://u:p@db.example.com/db?host=169.254.169.254' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { connectionString: 'postgresql://u:p@/db?sslmode=require&hostaddr=10.0.0.5' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, { connectionString: 'postgres://u:p@[::1]:5432/db' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('keeps the rules of the inference domains (instance names, URL fields)', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('model', scope, undefined, { instanceName: 'a.evil.com/x' }))
      .rejects.toBeInstanceOf(ProviderEndpointError);
  });
});

describe('hasUnvettableEndpoint', () => {
  it('does not flag a SRV connection string it can read: its record is resolved and vetted instead', () => {
    expect(hasUnvettableEndpoint({ uri: 'mongodb+srv://u:p@cluster0.example.net/db' })).toBe(false);
    expect(hasUnvettableEndpoint({ uri: 'mongodb+srv://cluster0.example.net/db?srvServiceName=custom&retryWrites=true' })).toBe(false);
    expect(hasUnvettableEndpoint({ uri: 'mongodb://h:27017/db' }, { region: 'x' })).toBe(false);
    expect(hasUnvettableEndpoint(undefined)).toBe(false);
  });

  it('flags a SRV connection string it cannot read the record of: a port, a list, a bracket, an odd service name', () => {
    for (const uri of [
      'mongodb+srv://h1.example.net:27017/db',
      'mongodb+srv://h1.example.net,h2.example.net/db',
      'mongodb+srv://[::1]/db',
      'mongodb+srv://%63luster0.example.net/db',
      'mongodb+srv:///db',
      'mongodb+srv://cluster0.example.net/db?srvServiceName=a&srvServiceName=b',
      'mongodb+srv://cluster0.example.net/db?srvServiceName=a.b',
    ]) {
      expect(hasUnvettableEndpoint({ uri }), uri).toBe(true);
    }
  });

  it('flags connection strings without a host, with a local socket, or of a scheme it does not read', () => {
    expect(hasUnvettableEndpoint({ connectionString: 'postgres://u:p@/db' })).toBe(true);
    expect(hasUnvettableEndpoint({ connectionString: 'postgres://u:p@db.example.com/db?host=%2Fvar%2Frun%2Fpostgresql' })).toBe(true);
    expect(hasUnvettableEndpoint({ connectionString: 'postgres://u:p@%2Fvar%2Frun%2Fpostgresql/db' })).toBe(true);
    expect(hasUnvettableEndpoint({ dsn: 'mysql://u:p@db.example.com:3306/db' })).toBe(true);
    expect(hasUnvettableEndpoint({ connectionString: 'postgres://u:p@db.example.com:5432/db?sslmode=require' })).toBe(false);
    expect(hasUnvettableEndpoint({ url: 'https://search.example.com' })).toBe(false);
  });
});
