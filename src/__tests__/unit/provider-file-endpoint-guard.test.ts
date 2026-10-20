/**
 * Endpoint rules for file stores (S3-compatible, Azure Blob): validated when the provider is saved or
 * tested, the way a model provider's endpoint is, plus the helper that vets a URL found inside a credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import {
  assertProviderEndpointsAllowed,
  assertProviderTestEndpointsAllowed,
  assertProviderUrlAllowed,
  ProviderEndpointError,
} from '@/lib/services/providers/providerEndpointGuard';

// Names resolve without the network: storage and login hosts are public, *.corp.example is internal, and (as on a
// resolver with a wildcard search domain) the single labels "http" and "https" answer too. An SRV record answers
// from `srv.answers` (an Error there is a resolver failure); one that is not listed has no data.
const srv = vi.hoisted(() => ({ answers: new Map<string, string[] | Error>(), calls: [] as string[] }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host.endsWith('.blob.core.windows.net') || host === 'minio.example.com' || host === 'login.microsoftonline.com'
      || host === 'http' || host === 'https' || host.endsWith('.public.example')) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    if (host.endsWith('.corp.example')) return [{ address: '10.1.2.3', family: 4 }];
    throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }),
  resolveSrv: vi.fn(async (name: string) => {
    srv.calls.push(name);
    const answer = srv.answers.get(name);
    if (answer === undefined) throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
    if (answer instanceof Error) throw answer;
    return answer.map((target) => ({ name: target, port: 27017, priority: 0, weight: 0 }));
  }),
}));

const original = getConfigSource();
function use(overrides: Record<string, string>) {
  setConfigSource({ get: (k: string) => overrides[k] ?? process.env[k] } as ConfigSource);
}
const scope = { tenantId: 't1' };
afterEach(() => {
  setConfigSource(original);
  srv.answers.clear();
  srv.calls.length = 0;
});

const saas = { DEPLOYMENT_MODE: 'saas' };
const onprem = { DEPLOYMENT_MODE: 'onprem' };

const PRIVATE_ENDPOINTS = [
  'http://10.0.0.5:9000',
  'http://127.0.0.1:9000',
  'http://169.254.169.254',
  'http://169.254.169.254/latest/meta-data/',
  'https://localhost',
  'https://[::1]:9000',
  'http://192.168.1.20:9000/bucket',
  'https://storage.corp.example',
  // A bare host:port is read as https by the file clients and is vetted the same way.
  '10.0.0.5:9000',
  '127.0.0.1:9000',
  'localhost:9000',
  'storage.corp.example:9000',
];

describe('assertProviderEndpointsAllowed for file stores', () => {
  it('SaaS refuses a private, loopback or metadata endpoint when the provider is saved', async () => {
    use(saas);
    for (const endpoint of PRIVATE_ENDPOINTS) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        code: 'provider_endpoint_not_allowed',
        field: 'endpoint',
      });
    }
  });

  it('SaaS refuses them even with the deployment switch off or the host allow-listed', async () => {
    use({ ...saas, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'false', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5,127.0.0.1' });
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http://10.0.0.5:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: '127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS accepts public endpoints, including a bare host that is read as https', async () => {
    use(saas);
    for (const endpoint of [
      'https://minio.example.com:9000',
      'http://minio.example.com',
      'https://acct.blob.core.windows.net',
      'minio.example.com',
      'minio.example.com:9000',
      'acct.blob.core.windows.net',
      '  acct.blob.core.windows.net  ',
      '93.184.216.34:9000',
    ]) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).resolves.toBeUndefined();
    }
  });

  it('SaaS refuses a bare host that does not resolve, and a value that is not a host at all', async () => {
    use(saas);
    for (const endpoint of ['no-such-account.invalid', 'has space.example.com', 'file:///etc/passwd', 'ftp://minio.example.com']) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).rejects.toBeInstanceOf(ProviderEndpointError);
    }
  });

  // The URL parser reads these as http(s) URLs on the host after the scheme, so that is the host to vet - not only the
  // bare host "http" that `https://<value>` makes of them.
  const WEB_SCHEME_WITHOUT_SLASHES = [
    'http:/127.0.0.1:9000',
    'https:/127.0.0.1',
    'http:\\\\127.0.0.1:9000',
    'HTTP:/127.0.0.1',
    'http:127.0.0.1:9000',
    'http:/10.0.0.5:9000',
    'http:/169.254.169.254/latest/meta-data/',
    'http:/[::1]:9000',
    'ht\ttp://127.0.0.1:9000',
  ];

  it('SaaS refuses a web scheme written without its // when the host it names is private', async () => {
    use(saas);
    for (const endpoint of WEB_SCHEME_WITHOUT_SLASHES) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        code: 'provider_endpoint_not_allowed',
        field: 'endpoint',
      });
    }
  });

  it('SaaS judges such a value by the host it names: a public one passes, a bare host:port is read as before', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http:/minio.example.com:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'minio.example.com:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'localhost:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: '127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('SaaS vets the hosts of a connection string held in any field of a file provider', async () => {
    use(saas);
    for (const [field, value] of Object.entries({
      uri: 'mongodb://127.0.0.1:27017',
      connectionString: 'mongodb://app:pw@10.0.0.5:27017,minio.example.com:27017/files?replicaSet=rs0',
      mongoUri: 'mongodb://[::1]:27017',
      dsn: 'postgres://app:pw@169.254.169.254:5432/files',
      cache: 'redis://storage.corp.example:6379',
    })) {
      await expect(assertProviderEndpointsAllowed('file', scope, { [field]: value }), field).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        field,
      });
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { [field]: value }), field).rejects.toMatchObject({ field });
    }
    await expect(assertProviderEndpointsAllowed('file', scope, { uri: 'mongodb://app:pw@minio.example.com:27017/files?replicaSet=rs0' })).resolves.toBeUndefined();
  });

  it('SaaS refuses a connection string whose hosts it cannot read: a local socket, no host, a +srv string it cannot read the record of', async () => {
    use(saas);
    for (const uri of [
      'mongodb://%2Ftmp%2Fmongodb-27017.sock',
      'mongodb:///files',
      'mongodb+srv://h1.public.example,h2.public.example/files',
      'mongodb+srv://h1.public.example:27017/files',
      'mongodb+srv:///files',
    ]) {
      await expect(assertProviderEndpointsAllowed('file', scope, { uri }), uri).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        field: 'uri',
      });
    }
    expect(srv.calls).toEqual([]);
  });

  it('only connection-string schemes are read in the other fields: a prefix or a note that looks like a URL is left alone', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, { note: 'ftp://anywhere/x', other: 's3://bucket/key' }, { prefix: 'gridfs://files/', label: 'mongodb notes' })).resolves.toBeUndefined();
  });

  it('on-prem lets connection strings through by default and holds them to the block when it is on', async () => {
    use(onprem);
    for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb+srv://cluster0.corp.example/files', 'mongodb://%2Ftmp%2Fmongodb-27017.sock']) {
      await expect(assertProviderEndpointsAllowed('file', scope, { uri }), uri).resolves.toBeUndefined();
    }
    // nothing is blocked, so no record is looked up either
    expect(srv.calls).toEqual([]);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    srv.answers.set('_mongodb._tcp.cluster0.corp.example', ['db-0.corp.example']);
    for (const uri of ['mongodb://127.0.0.1:27017', 'mongodb+srv://cluster0.corp.example/files', 'mongodb://%2Ftmp%2Fmongodb-27017.sock']) {
      await expect(assertProviderEndpointsAllowed('file', scope, { uri }), uri).rejects.toBeInstanceOf(ProviderEndpointError);
    }
    expect(srv.calls).toEqual(['_mongodb._tcp.cluster0.corp.example']);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5' });
    await expect(assertProviderEndpointsAllowed('file', scope, { uri: 'mongodb://10.0.0.5:27017' })).resolves.toBeUndefined();
  });

  it('does not quote an endpoint it cannot read: people paste keys and signed URLs there, and the error goes to the API response and the log', async () => {
    use(saas);
    for (const endpoint of [
      'https://AKIAEXAMPLE:wJalrXUtnFEMI@mini o.example.com',
      'https://host:99999/?sig=SUPERSECRETSIG',
      'https://acct.blob.core.windows.net:99999?sv=2022&sig=SUPERSECRETSIG',
    ]) {
      const error = await assertProviderEndpointsAllowed('file', scope, {}, { endpoint }).catch((e: unknown) => e);
      expect(error, endpoint).toBeInstanceOf(ProviderEndpointError);
      expect((error as Error).message, endpoint).toBe('Provider endpoint "endpoint" is not allowed: Invalid URL');
      expect((error as Error).message).not.toMatch(/AKIAEXAMPLE|wJalrXUtnFEMI|SUPERSECRETSIG/);
    }
    const url = await assertProviderUrlAllowed('BlobEndpoint', 'https://x:99999/?sig=SUPERSECRETSIG', scope).catch((e: unknown) => e);
    expect((url as Error).message).not.toMatch(/SUPERSECRETSIG/);
  });

  it('checks the Entra authority host (authorityHost) as well', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'https://10.0.0.9' })).rejects.toMatchObject({ field: 'authorityHost' });
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, { authorityHost: 'http://127.0.0.1:8080' })).rejects.toMatchObject({ field: 'authorityHost' });
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'login.corp.example' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'https://login.microsoftonline.com' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'login.microsoftonline.com' })).resolves.toBeUndefined();
    use(onprem);
    await expect(assertProviderEndpointsAllowed('file', scope, { authorityHost: 'https://10.0.0.9' })).resolves.toBeUndefined();
  });

  it('looks in the credentials as well as the settings', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, { endpoint: 'http://10.0.0.5:9000' }, { bucket: 'files' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('only fields that hold an endpoint are looked at, and an empty endpoint is Amazon S3 proper', async () => {
    use(saas);
    await expect(assertProviderEndpointsAllowed('file', scope, { accountKey: 'a'.repeat(88), sasToken: 'sv=2022-11-02&sig=abc' }, {
      accountName: 'acctname1',
      container: 'files',
      prefix: 'http://not-an-endpoint/',
      region: 'eu-west-1',
      bucket: '10.0.0.5',
      endpoint: '   ',
    })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('file', scope, undefined, undefined)).resolves.toBeUndefined();
  });

  it('on-prem lets in-network endpoints through (a local MinIO or Azurite)', async () => {
    use(onprem);
    for (const endpoint of PRIVATE_ENDPOINTS) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).resolves.toBeUndefined();
    }
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http://127.0.0.1:10000/devstoreaccount1' })).resolves.toBeUndefined();
  });

  it('on-prem still refuses what is not an http(s) endpoint', async () => {
    use(onprem);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'file:///etc/passwd' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'gopher://10.0.0.5' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('on-prem with OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK=true refuses private endpoints unless they are allow-listed', async () => {
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    for (const endpoint of ['http://127.0.0.1:10000/devstoreaccount1', 'http://10.0.0.5:9000', '10.0.0.5:9000', 'storage.corp.example']) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).rejects.toBeInstanceOf(ProviderEndpointError);
    }
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '10.0.0.5,.corp.example' });
    for (const endpoint of ['http://10.0.0.5:9000', '10.0.0.5:9000', 'storage.corp.example', 'https://storage.corp.example:9000']) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).resolves.toBeUndefined();
    }
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http://127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('on-prem treats such a value like any in-network endpoint: allowed by default, decided by the host it names when private networks are blocked', async () => {
    use(onprem);
    // with no slash and a port (`http:127.0.0.1:9000`), `https://<value>` is not a URL at all: refused everywhere
    const readable = WEB_SCHEME_WITHOUT_SLASHES.filter((endpoint) => endpoint !== 'http:127.0.0.1:9000');
    for (const endpoint of readable) {
      await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint }), endpoint).resolves.toBeUndefined();
    }
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http:127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http:/127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' });
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: 'http:/127.0.0.1:9000' })).resolves.toBeUndefined();
  });

  it('keeps the rules of the other domains as they were', async () => {
    use(saas);
    // A model URL still has to be a URL: only file stores read a bare host as https.
    await expect(assertProviderEndpointsAllowed('model', scope, {}, { baseUrl: '93.184.216.34:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { endpoint: '93.184.216.34:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('model', scope, {}, { baseUrl: 'http://10.0.0.5:8000/v1' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderEndpointsAllowed('model', scope, {}, { instanceName: 'a.evil.com/x' })).rejects.toBeInstanceOf(ProviderEndpointError);
    // Vector (and any other domain) is not covered here.
    await expect(assertProviderEndpointsAllowed('vector', scope, {}, { url: 'http://10.0.0.5:9200' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('vector', scope, { endpoint: '10.0.0.5:9000' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed('vector', scope, { uri: 'mongodb://127.0.0.1:27017' })).resolves.toBeUndefined();
    await expect(assertProviderEndpointsAllowed(undefined, scope, {}, { endpoint: 'http://10.0.0.5' })).resolves.toBeUndefined();
  });
});

describe('assertProviderTestEndpointsAllowed for file stores', () => {
  it('SaaS refuses private endpoints and authority hosts before anything is dialled', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: 'http://10.0.0.5:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: '127.0.0.1:9000' })).rejects.toBeInstanceOf(ProviderEndpointError);
    await expect(assertProviderTestEndpointsAllowed('file', scope, { authorityHost: 'https://10.0.0.9' })).rejects.toMatchObject({ field: 'authorityHost' });
    await expect(assertProviderTestEndpointsAllowed('file', scope, { authorityHost: 'https://login.microsoftonline.com' }, { endpoint: 'acct.blob.core.windows.net' })).resolves.toBeUndefined();
  });

  it('reads a web scheme without its // in a file endpoint as the host it names, as at save time', async () => {
    use(saas);
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: 'http:/127.0.0.1:9000' })).rejects.toMatchObject({ field: 'endpoint' });
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: 'HTTP:/10.0.0.5' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });

  it('reads the entries of a host field that way too, and leaves bare host:port entries as they were', async () => {
    use(saas);
    for (const source of [
      { url: 'http:/127.0.0.1:6333' },
      { host: 'http:\\\\10.0.0.5' },
      { nodes: 'minio.example.com:9200, http:/10.0.0.5:9200' },
      { brokers: 'HTTPS:/169.254.169.254' },
    ]) {
      await expect(assertProviderTestEndpointsAllowed('vector', scope, {}, source), JSON.stringify(source)).rejects.toBeInstanceOf(ProviderEndpointError);
    }
    await expect(assertProviderTestEndpointsAllowed('vector', scope, {}, { nodes: 'minio.example.com:9200,minio.example.com:9300' })).resolves.toBeUndefined();
    await expect(assertProviderTestEndpointsAllowed('vector', scope, {}, { host: '93.184.216.34:6333' })).resolves.toBeUndefined();
    await expect(assertProviderTestEndpointsAllowed('vector', scope, {}, { url: '10.0.0.5:6333' })).rejects.toBeInstanceOf(ProviderEndpointError);
    use(onprem);
    await expect(assertProviderTestEndpointsAllowed('vector', scope, {}, { url: 'http:/127.0.0.1:6333' })).resolves.toBeUndefined();
  });

  it('on-prem follows the same switches as at save time', async () => {
    use(onprem);
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: 'http://127.0.0.1:10000/devstoreaccount1' })).resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderTestEndpointsAllowed('file', scope, {}, { endpoint: 'http://127.0.0.1:10000/devstoreaccount1' })).rejects.toBeInstanceOf(ProviderEndpointError);
  });
});

describe('assertProviderUrlAllowed', () => {
  it('SaaS refuses a URL that is private, loopback or metadata, naming the field', async () => {
    use(saas);
    for (const url of ['http://127.0.0.1:10000/devstoreaccount1', 'https://10.0.0.9', 'http://169.254.169.254/', 'https://[::1]:8443', 'https://storage.corp.example', 'http://localhost']) {
      await expect(assertProviderUrlAllowed('BlobEndpoint', url, scope), url).rejects.toMatchObject({
        name: 'ProviderEndpointError',
        code: 'provider_endpoint_not_allowed',
        field: 'BlobEndpoint',
      });
    }
  });

  it('refuses a URL that is not http(s) or cannot be read', async () => {
    use(saas);
    for (const url of ['file:///etc/passwd', 'ftp://minio.example.com', 'not a url', 'minio.example.com']) {
      await expect(assertProviderUrlAllowed('authorityHost', url, scope), url).rejects.toBeInstanceOf(ProviderEndpointError);
    }
  });

  it('accepts public URLs, with or without surrounding whitespace', async () => {
    use(saas);
    await expect(assertProviderUrlAllowed('BlobEndpoint', 'https://acct.blob.core.windows.net', scope)).resolves.toBeUndefined();
    await expect(assertProviderUrlAllowed('authorityHost', ' https://login.microsoftonline.com/ ', scope)).resolves.toBeUndefined();
  });

  it('on-prem allows in-network URLs, unless the deployment blocks them and the host is not allow-listed', async () => {
    use(onprem);
    await expect(assertProviderUrlAllowed('BlobEndpoint', 'http://127.0.0.1:10000/devstoreaccount1', scope)).resolves.toBeUndefined();
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    await expect(assertProviderUrlAllowed('BlobEndpoint', 'http://127.0.0.1:10000/devstoreaccount1', scope)).rejects.toBeInstanceOf(ProviderEndpointError);
    use({ ...onprem, OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: '127.0.0.1' });
    await expect(assertProviderUrlAllowed('BlobEndpoint', 'http://127.0.0.1:10000/devstoreaccount1', scope)).resolves.toBeUndefined();
  });
});

describe('mongodb+srv connection strings of a file store', () => {
  const cluster = '_mongodb._tcp.cluster0.public.example';

  it('SaaS resolves the SRV record and vets every host in it', async () => {
    use(saas);
    srv.answers.set(cluster, ['shard-00.cluster0.public.example.', 'SHARD-01.cluster0.public.example', 'shard-01.cluster0.public.example']);
    await expect(assertProviderEndpointsAllowed('file', scope, { uri: 'mongodb+srv://app:pw@cluster0.public.example/files?retryWrites=true' }))
      .resolves.toBeUndefined();
    expect(srv.calls).toEqual([cluster]);
  });

  it('SaaS refuses the string when one host of the record is private, and says nothing of the string', async () => {
    use(saas);
    srv.answers.set(cluster, ['shard-00.cluster0.public.example', 'db-1.corp.example']);
    const error = await assertProviderEndpointsAllowed('file', scope, { uri: 'mongodb+srv://app:pw-SECRET@cluster0.public.example/files' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderEndpointError);
    expect(error).toMatchObject({ field: 'uri', code: 'provider_endpoint_not_allowed' });
    expect((error as Error).message).not.toMatch(/SECRET|cluster0|corp\.example|mongodb/);
  });

  it('SaaS refuses a record with no answer, a resolver failure, a record that is too large and a target it cannot read', async () => {
    use(saas);
    const uri = 'mongodb+srv://app:pw@cluster0.public.example/files';
    // no data
    await expect(assertProviderEndpointsAllowed('file', scope, { uri })).rejects.toMatchObject({ field: 'uri' });
    // an empty answer
    srv.answers.set(cluster, []);
    await expect(assertProviderEndpointsAllowed('file', scope, { uri })).rejects.toMatchObject({ field: 'uri' });
    // a resolver failure
    srv.answers.set(cluster, Object.assign(new Error('queryTxt ESERVFAIL'), { code: 'ESERVFAIL' }));
    await expect(assertProviderEndpointsAllowed('file', scope, { uri })).rejects.toMatchObject({ field: 'uri' });
    // too many hosts to check
    srv.answers.set(cluster, Array.from({ length: 65 }, (_, i) => `shard-${i}.cluster0.public.example`));
    await expect(assertProviderEndpointsAllowed('file', scope, { uri })).rejects.toMatchObject({ field: 'uri' });
    // a target that is not a plain host name
    srv.answers.set(cluster, ['shard-00.cluster0.public.example/@10.0.0.5']);
    await expect(assertProviderEndpointsAllowed('file', scope, { uri })).rejects.toMatchObject({ field: 'uri' });
  });

  it('SaaS looks the record up under the service name the string gives', async () => {
    use(saas);
    srv.answers.set('_custom._tcp.cluster0.public.example', ['shard-00.cluster0.public.example']);
    await expect(assertProviderEndpointsAllowed('file', scope, { uri: 'mongodb+srv://cluster0.public.example/files?SRVSERVICENAME=custom' }))
      .resolves.toBeUndefined();
    expect(srv.calls).toEqual(['_custom._tcp.cluster0.public.example']);
  });

  it('is vetted once when a test connection reads the same string twice', async () => {
    use(saas);
    srv.answers.set(cluster, ['shard-00.cluster0.public.example']);
    await expect(assertProviderTestEndpointsAllowed('file', scope, { uri: 'mongodb+srv://cluster0.public.example/files' }))
      .resolves.toBeUndefined();
    expect(srv.calls).toEqual([cluster]);
  });

  it('is read in any field of a file store, the way a plain connection string is', async () => {
    use(saas);
    srv.answers.set(cluster, ['db-1.corp.example']);
    await expect(assertProviderEndpointsAllowed('file', scope, {}, { anything: 'mongodb+srv://cluster0.public.example/files' }))
      .rejects.toMatchObject({ field: 'anything' });
  });
});
