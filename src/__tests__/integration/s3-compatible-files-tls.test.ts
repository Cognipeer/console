/**
 * The S3-compatible driver over TLS: a store with a certificate from a private CA, which is how most self-hosted
 * MinIO, Ceph and SeaweedFS installations are reached. The fake S3 server speaks https with a throwaway certificate
 * made by openssl (the block is skipped where openssl is not installed).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { isS3OperationError, type S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import type { S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import type { S3CompatibleSettings } from '@/lib/providers/contracts/s3/s3Helpers';
import { startFakeS3, type FakeS3 } from '../helpers/fakeS3Server';

function openSslAvailable(): boolean {
  try {
    return spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' };
const original = getConfigSource();
const MIB = 1024 * 1024;

function useDeployment(mode: 'onprem' | 'saas') {
  setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: mode } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
}

describe.runIf(openSslAvailable())('S3-compatible storage behind a certificate from a private CA', () => {
  let certDir = '';
  let cert = { key: '', cert: '' };
  let otherCert = { key: '', cert: '' };
  const servers: FakeS3[] = [];
  const runtimes: S3FileRuntime[] = [];

  function makeCertificate(commonName: string, san: string): { key: string; cert: string } {
    const keyPath = join(certDir, `${commonName}.key.pem`);
    const certPath = join(certDir, `${commonName}.cert.pem`);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', `/CN=${commonName}`,
      '-addext', `subjectAltName=${san}`,
    ], { stdio: 'ignore' });
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  }

  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), 's3-compatible-tls-'));
    cert = makeCertificate('localhost', 'DNS:localhost,IP:127.0.0.1');
    otherCert = makeCertificate('other.example', 'DNS:other.example');
  }, 30_000);

  afterAll(() => {
    rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => useDeployment('onprem'));

  afterEach(async () => {
    setConfigSource(original);
    for (const runtime of runtimes.splice(0)) runtime.close();
    for (const server of servers.splice(0)) await server.close();
  });

  async function tlsStore(tls = cert): Promise<FakeS3> {
    const server = await startFakeS3({ buckets: ['bkt3'], tls });
    servers.push(server);
    return server;
  }

  async function runtimeFor(url: string, settings: Partial<S3CompatibleSettings> = {}): Promise<S3FileRuntime> {
    const runtime = (await S3CompatibleFileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'minio-main',
      credentials,
      settings: { endpoint: url, bucket: 'bkt3', ...settings },
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

  it('does not trust a certificate its own CA signed, and says what to do about it', async () => {
    const server = await tlsStore();
    const runtime = await runtimeFor(server.url);

    const error = await failureOf(() => runtime.listFiles());
    expect(error).toMatchObject({ code: 'tls_untrusted', retryable: false });
    expect(error.message).toMatch(/not trusted/);
    expect(error.message).toMatch(/"CA certificate" \(recommended\)/);
    expect(error.message).toMatch(/"Skip TLS verification"/);

    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toBe(error.message);
    expect(server.requests).toHaveLength(0);
  });

  it('trusts it once the CA certificate is given, for every call, with a 3 MiB upload', async () => {
    const server = await tlsStore();
    const runtime = await runtimeFor(server.url, { caCertificate: cert.cert });

    const check = await runtime.checkConnection();
    expect(check).toMatchObject({ ok: true, message: 'Connected to bucket "bkt3" (list, write, read, delete).' });

    const data = Buffer.alloc(3 * MIB, 'z');
    const { handle } = await runtime.uploadFile({ name: 'büyük dosya.bin', contentType: 'application/octet-stream', data, metadata: { açıklama: 'üç megabayt' } });
    const put = server.requests.filter((request) => request.method === 'PUT' && request.key.endsWith(handle.key))[0];
    expect(put.bytes).toBe(3 * MIB);
    expect(put.headers.expect).toBeUndefined();
    expect(Object.keys(put.headers).filter((name) => name.startsWith('x-amz-checksum-'))).toEqual([]);

    const back = await runtime.downloadFile(handle.key);
    expect(back.data.equals(data)).toBe(true);
    expect(back.metadata?.originalname).toBe('büyük dosya.bin');
    expect(back.metadata?.['a-klama']).toBe('üç megabayt');
    await runtime.deleteFile(handle.key);
    expect(server.objects.size).toBe(0);
  });

  it('accepts the certificate when the provider skips verification', async () => {
    const server = await tlsStore();
    const runtime = await runtimeFor(server.url, { allowInsecureTls: true });
    await expect(runtime.checkConnection()).resolves.toMatchObject({ ok: true });
    const { handle } = await runtime.uploadFile({ name: 'a.bin', data: Buffer.alloc(3 * MIB, 'a') });
    expect((await runtime.downloadFile(handle.key)).data.length).toBe(3 * MIB);
  });

  it('does not skip verification for a value that is only the text "true"', async () => {
    const server = await tlsStore();
    const runtime = await runtimeFor(server.url, { allowInsecureTls: 'true' as never });
    await expect(runtime.listFiles()).rejects.toMatchObject({ code: 'tls_untrusted' });
  });

  it('lets a provider skip verification on SaaS too, where the network policy still applies', async () => {
    useDeployment('saas');
    // a public literal address passes the network policy, and the runtime is built with the setting
    await expect(runtimeFor('https://93.184.216.34:9000', { allowInsecureTls: true })).resolves.toBeDefined();
    // skipping verification does not open a loopback store
    const server = await tlsStore();
    await expect(runtimeFor(server.url, { allowInsecureTls: true })).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
  });

  it('trusts the CA certificate for this provider only', async () => {
    const server = await tlsStore();
    const trusting = await runtimeFor(server.url, { caCertificate: cert.cert });
    const plain = await runtimeFor(server.url);
    await expect(trusting.listFiles()).resolves.toMatchObject({ items: [] });
    await expect(plain.listFiles()).rejects.toMatchObject({ code: 'tls_untrusted' });
    // and again, in the other order, on the same agents
    await expect(trusting.listFiles()).resolves.toMatchObject({ items: [] });
  });

  it('keeps the host name check even for a trusted CA', async () => {
    const server = await tlsStore(otherCert);
    const runtime = await runtimeFor(server.url, { caCertificate: otherCert.cert });
    const error = await failureOf(() => runtime.listFiles());
    expect(error).toMatchObject({ code: 'tls_hostname', retryable: false });
    expect(error.message).toMatch(/not valid for the host name used in the endpoint/);
  });

  it('turns a CA certificate that does not parse into a settings error', async () => {
    const server = await tlsStore();
    await expect(runtimeFor(server.url, { caCertificate: 'not a certificate' })).rejects.toMatchObject({
      name: 'ProviderSettingsError',
      field: 'caCertificate',
    });
    await expect(runtimeFor(server.url, { caCertificate: `${cert.cert}\n${cert.key}` })).rejects.toMatchObject({
      name: 'ProviderSettingsError',
      field: 'caCertificate',
    });
  });

  it('says so when https:// is used for a plain-HTTP port', async () => {
    const plain = await startFakeS3({ buckets: ['bkt3'] });
    servers.push(plain);
    const runtime = await runtimeFor(plain.url.replace('http://', 'https://'));
    const error = await failureOf(() => runtime.listFiles());
    expect(error.code).toBe('tls_protocol');
    expect(error.message).toMatch(/did not speak TLS on this port\. Use http:\/\//);
    expect(plain.requests).toHaveLength(0);
  });

  it('says so when http:// is used for a TLS port', async () => {
    const server = await tlsStore();
    const runtime = await runtimeFor(server.url.replace('https://', 'http://'));
    const error = await failureOf(() => runtime.listFiles());
    expect(error.code).toBe('connection_reset');
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/If this port serves TLS, use https:\/\/ in the endpoint\./);
  });

  it('reports a port that does not answer TLS at all', async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => {
      sockets.add(socket);
      socket.end();
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = silent.address() as net.AddressInfo;
      const runtime = await runtimeFor(`https://127.0.0.1:${port}`);
      const result = await runtime.checkConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/\S/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});
