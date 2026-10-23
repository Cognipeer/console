/**
 * The network policy around the S3-compatible driver: which endpoints a deployment lets a provider reach, checked
 * when the runtime is created and again when a socket connects.
 *
 * DNS is answered by a mock so a name can point at a public address when the URL is checked and at this machine when
 * the socket connects (the rebinding case); the fake S3 server only ever sees the requests that were allowed through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookup } from 'node:dns/promises';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { isS3OperationError, type S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import type { S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import type { S3CompatibleSettings } from '@/lib/providers/contracts/s3/s3Helpers';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { s3Error, startFakeS3, type FakeS3, type FakeS3Options } from '../helpers/fakeS3Server';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

interface Address {
  address: string;
  family: number;
}
const PUBLIC: Address = { address: '93.184.216.34', family: 4 };
const PRIVATE: Address = { address: '10.1.2.3', family: 4 };
const LOOPBACK: Address = { address: '127.0.0.1', family: 4 };

const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' };
const original = getConfigSource();
const servers: FakeS3[] = [];
const runtimes: S3FileRuntime[] = [];

/**
 * A name no other test uses: the guard remembers its verdict about a host name for a while, so a test that makes
 * a name move from a public to a private address needs a name of its own.
 */
let names = 0;
const uniqueHost = (label: string) => `${label}-${(names += 1)}.example.test`;

/** What each name resolves to, one answer per lookup in order (the last answer repeats). */
const answers = new Map<string, Address[][]>();
const resolveTo = (host: string, ...sequence: Address[][]) => answers.set(host, sequence.map((answer) => [...answer]));

function useDeployment(overrides: Record<string, string>) {
  setConfigSource({ get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource);
}

beforeEach(() => {
  answers.clear();
  (lookup as unknown as { mockImplementation: (fn: (host: string) => Promise<Address[]>) => void }).mockImplementation(async (host) => {
    const queue = answers.get(host);
    if (!queue || queue.length === 0) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return queue.length > 1 ? (queue.shift() as Address[]) : queue[0];
  });
});

afterEach(async () => {
  setConfigSource(original);
  vi.mocked(lookup).mockReset();
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const server of servers.splice(0)) await server.close();
});

async function fakeStore(options: FakeS3Options = {}): Promise<FakeS3> {
  const server = await startFakeS3({ buckets: ['bkt3'], ...options });
  servers.push(server);
  return server;
}

async function createRuntime(endpoint: string, settings: Partial<S3CompatibleSettings> = {}): Promise<S3FileRuntime> {
  const runtime = (await S3CompatibleFileProviderContract.createRuntime({
    tenantId: 'tenant1',
    providerKey: 'minio-main',
    credentials,
    settings: { endpoint, bucket: 'bkt3', ...settings },
  })) as S3FileRuntime;
  runtimes.push(runtime);
  return runtime;
}

async function failureOf(run: () => Promise<unknown>): Promise<S3OperationError> {
  try {
    await run();
  } catch (error) {
    expect(isS3OperationError(error), error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toBe(true);
    return error as S3OperationError;
  }
  throw new Error('expected the call to fail');
}

describe('SaaS', () => {
  beforeEach(() => useDeployment({ DEPLOYMENT_MODE: 'saas' }));

  it('refuses an endpoint that points at a private address, before anything is sent', async () => {
    const server = await fakeStore();
    const host = uniqueHost('internal');
    resolveTo(host, [PRIVATE]);
    await expect(createRuntime(`http://${host}:${server.port}`)).rejects.toMatchObject({
      name: 'ProviderEndpointError',
      code: 'provider_endpoint_not_allowed',
      field: 'endpoint',
      retryable: false,
    });
    await expect(createRuntime(server.url)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a name that stands for this machine, and the cloud metadata address', async () => {
    const host = uniqueHost('self');
    resolveTo(host, [LOOPBACK]);
    await expect(createRuntime(`http://${host}:9000`)).rejects.toMatchObject({ name: 'ProviderEndpointError' });
    await expect(createRuntime('http://169.254.169.254')).rejects.toMatchObject({ name: 'ProviderEndpointError' });
    await expect(createRuntime('http://[::1]:9000')).rejects.toMatchObject({ name: 'ProviderEndpointError' });
  });

  it('answers a resolver outage as the setting it is about, and keeps it retryable: it is no policy refusal', async () => {
    const error = await createRuntime(`http://${uniqueHost('nowhere')}:9000`).catch((caught: Error) => caught);
    // the same error, with the same wording, as when the provider is saved or tested (a curated answer with a field)
    expect(error).toBeInstanceOf(ProviderEndpointError);
    expect(error).toMatchObject({ code: 'provider_endpoint_not_allowed', field: 'endpoint', retryable: true });
    expect((error as Error).message).toMatch(/^Provider endpoint "endpoint" is not allowed: Could not resolve host: nowhere-\d+\.example\.test$/);
    expect((error as Error).message).not.toMatch(/private network/);
  });

  it('refuses a name that is public when the URL is checked and points at this machine when the socket connects', async () => {
    const server = await fakeStore();
    // two answers for the URL check (verdict and pinned addresses), then the one the socket asks for
    const host = uniqueHost('moving');
    resolveTo(host, [PUBLIC], [PUBLIC], [LOOPBACK]);
    const runtime = await createRuntime(`http://${host}:${server.port}`);

    const error = await failureOf(() => runtime.listFiles());
    expect(error.code).toBe('endpoint_not_allowed');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/Refusing outbound request to private\/loopback host/);
    expect(server.requests).toHaveLength(0);
  });

  it('reports the same refusal from "Test connection", without throwing', async () => {
    const server = await fakeStore();
    const host = uniqueHost('moving');
    resolveTo(host, [PUBLIC], [PUBLIC], [LOOPBACK]);
    const runtime = await createRuntime(`http://${host}:${server.port}`);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Refusing outbound request to private\/loopback host/);
    expect(server.requests).toHaveLength(0);
  });

  it('lets a provider skip certificate verification without opening a private address', async () => {
    // a public address: the runtime is built with the setting
    await expect(createRuntime('https://93.184.216.34:9000', { allowInsecureTls: true })).resolves.toBeDefined();
    for (const endpoint of ['https://10.0.0.5:9000', 'http://127.0.0.1:9000', 'https://169.254.169.254']) {
      await expect(createRuntime(endpoint, { allowInsecureTls: true }), endpoint).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
    }
  });

  it('takes a plain-http endpoint at a public address', async () => {
    await expect(createRuntime('http://93.184.216.34:9000')).resolves.toBeDefined();
  });

});

describe('a self-hosted deployment', () => {
  it('reaches a store on its own network by default', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem' });
    const server = await fakeStore();
    const runtime = await createRuntime(server.url);
    await expect(runtime.listFiles()).resolves.toMatchObject({ items: [] });
    expect(server.requests).toHaveLength(1);
  });

  it('refuses private targets when it is set to, naming the endpoint field', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    const server = await fakeStore();
    const host = uniqueHost('blocked');
    resolveTo(host, [LOOPBACK]);
    await expect(createRuntime(server.url)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
    await expect(createRuntime(`http://${host}:${server.port}`)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
    expect(server.requests).toHaveLength(0);
  });

  it('lets an allow-listed host through even then', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true', OUTBOUND_HTTP_ALLOWED_HOSTS: 'localhost' });
    const server = await fakeStore();
    resolveTo('localhost', [LOOPBACK]);
    const runtime = await createRuntime(server.localhostUrl);
    await expect(runtime.listFiles()).resolves.toMatchObject({ items: [] });
    expect(server.requests).toHaveLength(1);
  });

  it('checks the address at connect time when it blocks private networks', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' });
    const server = await fakeStore();
    const host = uniqueHost('moving');
    resolveTo(host, [PUBLIC], [PUBLIC], [LOOPBACK]);
    const runtime = await createRuntime(`http://${host}:${server.port}`);
    const error = await failureOf(() => runtime.listFiles());
    expect(error.code).toBe('endpoint_not_allowed');
    expect(server.requests).toHaveLength(0);
  });

  it('accepts the setting that skips certificate verification (what it does is checked over TLS in the integration test)', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem' });
    const server = await fakeStore();
    const runtime = await createRuntime(server.url, { allowInsecureTls: true });
    await expect(runtime.listFiles()).resolves.toMatchObject({ items: [] });
  });
});

describe('redirects', () => {
  it('are never followed: the target of a redirect receives nothing', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem' });
    const target = await fakeStore();
    const source = await fakeStore({ intercept: () => ({ status: 307, headers: { location: `${target.url}/bkt3?list-type=2` } }) });
    const runtime = await createRuntime(source.url);

    const error = await failureOf(() => runtime.listFiles());
    expect(error).toMatchObject({ code: 'redirect', statusCode: 307, retryable: false });
    expect(source.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });

  it('are not followed for an upload either', async () => {
    useDeployment({ DEPLOYMENT_MODE: 'onprem' });
    const target = await fakeStore();
    const source = await fakeStore({ intercept: (request) => (request.method === 'PUT' ? { status: 307, headers: { location: `${target.url}/${request.bucket}/${request.key}` } } : s3Error(500, 'InternalError')) });
    const runtime = await createRuntime(source.url);
    const error = await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('payload') }));
    expect(error.code).toBe('redirect');
    expect(target.requests).toHaveLength(0);
    expect(target.objects.size).toBe(0);
  });
});
