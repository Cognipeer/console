/**
 * The Amazon S3 driver after it moved onto the shared S3 runtime: providers that were saved before the S3-compatible
 * driver existed keep every setting they have and the client they always got, and a custom endpoint set the old way
 * gets the same fixes as the new driver.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { AwsS3FileProviderContract } from '@/lib/providers/contracts/awsS3Files.contract';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { createS3Client, S3_CONNECT_TIMEOUT_MS, S3_MAX_ATTEMPTS, S3_SOCKET_TIMEOUT_MS, type S3ClientBundle, type S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import { startFakeS3, type FakeS3 } from '../helpers/fakeS3Server';

const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: 'secret-secret-secret' };
const original = getConfigSource();
const servers: FakeS3[] = [];
const bundles: S3ClientBundle[] = [];
const runtimes: S3FileRuntime[] = [];

beforeEach(() => {
  setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'onprem' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
});

afterEach(async () => {
  setConfigSource(original);
  for (const bundle of bundles.splice(0)) {
    bundle.client.destroy();
    bundle.agents?.destroy();
  }
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const server of servers.splice(0)) await server.close();
});

async function fakeStore(): Promise<FakeS3> {
  const server = await startFakeS3({ buckets: ['legacy-bucket'] });
  servers.push(server);
  return server;
}

async function clientFor(settings: Record<string, unknown>): Promise<S3ClientBundle> {
  const bundle = await createS3Client(credentials, settings as never, { requireEndpoint: false });
  bundles.push(bundle);
  return bundle;
}

/** The value of a resolved SDK config member, which is a value or a provider function. */
async function resolved(member: unknown): Promise<unknown> {
  return typeof member === 'function' ? (member as () => unknown)() : member;
}

/** The members of the client configuration that make up its behaviour. */
async function behaviourOf(bundle: S3ClientBundle) {
  const config = bundle.client.config as unknown as Record<string, unknown>;
  const endpoint = config.endpoint ? ((await resolved(config.endpoint)) as { protocol: string; hostname: string; port?: number; path: string }) : undefined;
  return {
    forcePathStyle: config.forcePathStyle,
    region: await resolved(config.region),
    endpoint: endpoint ? `${endpoint.protocol}//${endpoint.hostname}${endpoint.port ? `:${endpoint.port}` : ''}${endpoint.path === '/' ? '' : endpoint.path}` : undefined,
    requestChecksumCalculation: await resolved(config.requestChecksumCalculation),
    responseChecksumValidation: await resolved(config.responseChecksumValidation),
    maxAttempts: await resolved(config.maxAttempts),
    expectContinueHeader: config.expectContinueHeader,
    ownAgents: Boolean(bundle.agents),
  };
}

describe('the contract', () => {
  it('is Amazon S3 at version 1.1.0 with the fields it always had, then the TLS settings', () => {
    expect(AwsS3FileProviderContract).toMatchObject({ id: 'aws-s3-files', version: '1.1.0', domains: ['file'] });
    expect(AwsS3FileProviderContract.display.label).toBe('Amazon S3');
    const fields = AwsS3FileProviderContract.form.sections.flatMap((section) => section.fields);
    expect(fields.map((field) => field.name)).toEqual([
      'accessKeyId', 'secretAccessKey', 'sessionToken',
      'region', 'bucket', 'prefix', 'endpoint', 'usePathStyleEndpoint',
      'caCertificate', 'allowInsecureTls',
    ]);

    const field = (name: string) => fields.find((candidate) => candidate.name === name);
    // what a stored provider's form still shows, unchanged
    expect(field('accessKeyId')).toMatchObject({ label: 'Access key ID', type: 'text', required: true, scope: 'credentials' });
    expect(field('secretAccessKey')).toMatchObject({ label: 'Secret access key', type: 'password', required: true, scope: 'credentials' });
    expect(field('sessionToken')).toMatchObject({ type: 'password', scope: 'credentials' });
    expect(field('region')).toMatchObject({ label: 'AWS region', type: 'text', scope: 'settings' });
    expect(field('bucket')).toMatchObject({ label: 'Bucket name', required: true, scope: 'settings' });
    expect(field('prefix')).toMatchObject({ label: 'Bucket prefix', scope: 'settings' });
    expect(field('endpoint')).toMatchObject({ label: 'Custom endpoint', scope: 'settings' });
    expect(field('usePathStyleEndpoint')).toMatchObject({ type: 'switch', scope: 'settings' });
    // the path-style switch has no default: untouched means automatic
    expect(field('usePathStyleEndpoint')).not.toHaveProperty('defaultValue');
    expect(field('usePathStyleEndpoint')?.description).toMatch(/automatic/i);

    expect(field('caCertificate')).toMatchObject({ type: 'textarea', scope: 'settings' });
    expect(field('allowInsecureTls')).toMatchObject({ type: 'switch', defaultValue: false, scope: 'settings' });
    expect(field('caCertificate')?.description).toMatch(/custom endpoint/i);
    expect(field('allowInsecureTls')?.description).toMatch(/custom endpoint/i);
    // the region is only required without an endpoint: the form cannot say that, validateSettings does
    expect(field('region')?.required).toBeFalsy();
    expect(field('region')?.description).toMatch(/Required for Amazon S3/);
  });

  it('points new S3-compatible stores at the new driver', () => {
    const endpoint = AwsS3FileProviderContract.form.sections.flatMap((section) => section.fields).find((field) => field.name === 'endpoint');
    expect(endpoint?.description).toMatch(/S3-compatible storage provider/);
  });
});

describe('the client of every stored settings shape', () => {
  it('Amazon S3 proper (no endpoint) keeps the SDK defaults', async () => {
    const bundle = await clientFor({ region: 'eu-central-1', bucket: 'legacy-bucket' });
    expect(await behaviourOf(bundle)).toEqual({
      forcePathStyle: false,
      region: 'eu-central-1',
      endpoint: undefined,
      requestChecksumCalculation: 'WHEN_SUPPORTED',
      responseChecksumValidation: 'WHEN_SUPPORTED',
      maxAttempts: 3,
      // the SDK's own threshold (2 MiB), untouched
      expectContinueHeader: 2 * 1024 * 1024,
      ownAgents: false,
    });
  });

  it('an endpoint without a path-style flag is path-style, with the S3-compatible client settings', async () => {
    const bundle = await clientFor({ region: 'eu-central-1', bucket: 'legacy-bucket', endpoint: 'http://127.0.0.1:9000' });
    expect(await behaviourOf(bundle)).toEqual({
      forcePathStyle: true,
      region: 'eu-central-1',
      endpoint: 'http://127.0.0.1:9000',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: S3_MAX_ATTEMPTS,
      expectContinueHeader: false,
      ownAgents: true,
    });
    expect(S3_MAX_ATTEMPTS).toBe(2);
  });

  it('an endpoint with path-style switched off stays virtual-hosted', async () => {
    const bundle = await clientFor({ region: 'us-east-1', bucket: 'legacy-bucket', endpoint: 'http://127.0.0.1:9000', usePathStyleEndpoint: false });
    expect(await behaviourOf(bundle)).toMatchObject({ forcePathStyle: false, endpoint: 'http://127.0.0.1:9000', requestChecksumCalculation: 'WHEN_REQUIRED' });
  });

  it('path-style on Amazon S3 itself is honoured', async () => {
    const bundle = await clientFor({ region: 'eu-central-1', bucket: 'legacy-bucket', usePathStyleEndpoint: true });
    expect(await behaviourOf(bundle)).toMatchObject({ forcePathStyle: true, endpoint: undefined, requestChecksumCalculation: 'WHEN_SUPPORTED' });
  });

  it('an endpoint stored without a region signs with us-east-1, and a stray slash or padding is tolerated', async () => {
    const bundle = await clientFor({ bucket: ' legacy-bucket ', endpoint: ' http://127.0.0.1:9000/ ', region: '  ' });
    expect(await behaviourOf(bundle)).toMatchObject({ region: 'us-east-1', endpoint: 'http://127.0.0.1:9000', forcePathStyle: true });
    expect(bundle.bucket).toBe('legacy-bucket');
  });

  it('reads an endpoint with a path prefix and with credentials in the URL the way it always was', async () => {
    const bundle = await clientFor({ region: 'us-east-1', bucket: 'legacy-bucket', endpoint: 'http://user:pass@127.0.0.1:9000/s3/' });
    expect((await behaviourOf(bundle)).endpoint).toBe('http://127.0.0.1:9000/s3');
  });

  it('uses the timeouts of the S3-compatible client only with an endpoint', async () => {
    expect([S3_CONNECT_TIMEOUT_MS, S3_SOCKET_TIMEOUT_MS]).toEqual([10_000, 120_000]);
    const withEndpoint = await clientFor({ region: 'us-east-1', bucket: 'b-1', endpoint: 'http://127.0.0.1:9000' });
    const handler = withEndpoint.client.config.requestHandler as unknown as { config?: Record<string, unknown>; configProvider?: Promise<Record<string, unknown>> };
    const config = handler.config ?? (await handler.configProvider);
    expect(config).toMatchObject({ connectionTimeout: 10_000, socketTimeout: 120_000 });
  });

  it('refuses the settings that could never have worked', async () => {
    await expect(clientFor({ bucket: 'legacy-bucket' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'region' });
    await expect(clientFor({ region: 'eu-central-1' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'bucket' });
    await expect(createS3Client({ accessKeyId: '' , secretAccessKey: 'x' }, { region: 'eu-central-1', bucket: 'b-1' }, { requireEndpoint: false })).rejects.toMatchObject({ field: 'accessKeyId' });
  });
});

describe('a provider with a custom endpoint, set the old way', () => {
  it('stores and reads through the shared runtime, path-style', async () => {
    const server = await fakeStore();
    const runtime = (await AwsS3FileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'legacy-minio',
      credentials,
      settings: { region: 'us-east-1', bucket: 'legacy-bucket', endpoint: server.url, prefix: 'old' },
    })) as S3FileRuntime;
    runtimes.push(runtime);

    const { handle } = await runtime.uploadFile({ name: 'çıktı.docx', data: Buffer.from('docx'), contentType: 'application/octet-stream', metadata: { owner: 'ayşe' } });
    expect(server.objects.has(`legacy-bucket/old/tenant1/legacy-minio/${handle.key}`)).toBe(true);
    expect(server.requests[0].url.startsWith(`/legacy-bucket/old/tenant1/legacy-minio/`)).toBe(true);
    expect(server.requests[0].headers.expect).toBeUndefined();
    expect(server.requests[0].headers['x-amz-checksum-crc32']).toBeUndefined();
    expect((await runtime.downloadFile(handle.key)).metadata).toMatchObject({ originalname: 'çıktı.docx', owner: 'ayşe' });
    expect((await runtime.listFiles()).items.map((item) => item.key)).toEqual([handle.key]);
    await runtime.deleteFile(handle.key);
    await expect(runtime.getFileMetadata(handle.key)).resolves.toBeNull();
  });

  it('has the end-to-end connection check too', async () => {
    const server = await fakeStore();
    const runtime = (await AwsS3FileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'legacy-minio',
      credentials,
      settings: { region: 'us-east-1', bucket: 'legacy-bucket', endpoint: server.url },
    })) as S3FileRuntime;
    runtimes.push(runtime);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected to bucket "legacy-bucket" (list, write, read, delete).');
  });

  it('does not create a bucket on its own: the switch belongs to the S3-compatible driver', async () => {
    const server = await startFakeS3({ buckets: [] });
    servers.push(server);
    const runtime = (await AwsS3FileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'legacy-minio',
      credentials,
      // a stray flag in an old row changes nothing
      settings: { region: 'us-east-1', bucket: 'legacy-bucket', endpoint: server.url, createBucketIfMissing: true } as never,
    })) as S3FileRuntime;
    runtimes.push(runtime);
    await expect(runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') })).rejects.toMatchObject({ code: 'bucket_missing' });
    expect(server.buckets.size).toBe(0);
  });

  it('does not add the S3-compatible switch to the failure message of a provider that has none', async () => {
    const server = await startFakeS3({ buckets: [] });
    servers.push(server);
    const runtime = (await AwsS3FileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'legacy-minio',
      credentials,
      settings: { region: 'us-east-1', bucket: 'legacy-bucket', endpoint: server.url },
    })) as S3FileRuntime;
    runtimes.push(runtime);
    const error = await runtime.listFiles().catch((caught: Error) => caught);
    expect((error as Error).message).not.toMatch(/Create bucket if missing/);
    expect((error as Error).message).toMatch(/Create it first/);
  });
});

describe('the metadata keys an object is written with', () => {
  it('Amazon S3 proper (no endpoint) keeps `_` and `.` in a key, so it reads back as it always did', async () => {
    const sent: Array<Record<string, string> | undefined> = [];
    // no network: the command the client is asked to send is what is looked at
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        sent.push(command.input.Metadata);
        return { ETag: '"etag"' };
      }
      throw new Error('unexpected command');
    }) as never);
    try {
      const runtime = (await AwsS3FileProviderContract.createRuntime({
        tenantId: 'tenant1',
        providerKey: 'legacy-aws',
        credentials,
        settings: { region: 'eu-central-1', bucket: 'legacy-bucket' },
      })) as S3FileRuntime;
      runtimes.push(runtime);
      await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a'), metadata: { user_id: 'u1', 'customer.id': 'c1', 'Source Key': 's' } });
    } finally {
      send.mockRestore();
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(expect.objectContaining({ user_id: 'u1', 'customer.id': 'c1', 'source-key': 's', originalname: 'a.txt' }));
  });

  it('a custom endpoint, behind whatever proxy sits in front of it, is sent [a-z0-9-] only', async () => {
    const server = await fakeStore();
    const runtime = (await AwsS3FileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'legacy-minio',
      credentials,
      settings: { region: 'us-east-1', bucket: 'legacy-bucket', endpoint: server.url },
    })) as S3FileRuntime;
    runtimes.push(runtime);
    const { handle } = await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a'), metadata: { user_id: 'u1', 'customer.id': 'c1' } });
    const names = Object.keys(server.requests[0].headers).filter((name) => name.startsWith('x-amz-meta-'));
    expect(names).toEqual(expect.arrayContaining(['x-amz-meta-user-id', 'x-amz-meta-customer-id']));
    expect(names.some((name) => name.includes('_') || name.includes('.'))).toBe(false);
    expect((await runtime.downloadFile(handle.key)).metadata).toMatchObject({ 'user-id': 'u1', 'customer-id': 'c1' });
  });
});

describe('describeStorageLocation', () => {
  const aws = AwsS3FileProviderContract.describeStorageLocation!;
  const compatible = S3CompatibleFileProviderContract.describeStorageLocation!;

  it('names the bucket and the base prefix for Amazon S3', () => {
    expect(aws({ settings: { region: 'eu-central-1', bucket: 'archive', prefix: 'console/files' }, tenantId: 'tenant1', providerKey: 'amazon-main' }))
      .toBe('s3://archive/console/files/tenant1/amazon-main/');
    expect(aws({ settings: { region: 'eu-central-1', bucket: 'archive' }, tenantId: 'tenant1', providerKey: 'amazon-main' }))
      .toBe('s3://archive/tenant1/amazon-main/');
  });

  it('adds the host of a custom endpoint, on either driver', () => {
    const settings = { region: 'us-east-1', bucket: 'archive', prefix: 'console', endpoint: 'https://minio.internal:9000' };
    expect(aws({ settings, tenantId: 'tenant1', providerKey: 'minio' })).toBe('s3://archive/console/tenant1/minio/ · minio.internal:9000');
    expect(compatible({ settings, tenantId: 'tenant1', providerKey: 'minio' })).toBe('s3://archive/console/tenant1/minio/ · minio.internal:9000');
  });

  it('is the prefix the runtime uses for the keys of the objects', async () => {
    const server = await fakeStore();
    const settings = { region: 'us-east-1', bucket: 'legacy-bucket', prefix: '/a/b/', endpoint: server.url };
    const runtime = (await AwsS3FileProviderContract.createRuntime({ tenantId: 'tenant1', providerKey: 'legacy-minio', credentials, settings })) as S3FileRuntime;
    runtimes.push(runtime);
    const { handle } = await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') });

    const location = aws({ settings, tenantId: 'tenant1', providerKey: 'legacy-minio' }) as string;
    const [path] = location.split(' · ');
    expect(path.startsWith('s3://legacy-bucket/')).toBe(true);
    const storedKey = [...server.objects.keys()][0];
    expect(`s3://${storedKey}`).toBe(`${path}${handle.key}`);
  });

  it('never needs the credentials, and shows nothing without a bucket', () => {
    expect(aws({ settings: { region: 'eu-central-1' } as never, tenantId: 't', providerKey: 'k' })).toBeNull();
    expect(compatible({ settings: { endpoint: 'https://minio.internal:9000' } as never, tenantId: 't', providerKey: 'k' })).toBeNull();
  });

  it('leaves the credentials, the path and the query of an endpoint out of it', () => {
    const settings = { bucket: 'archive', endpoint: 'https://user:hunter2@minio.internal:9000/private/path?token=hunter2' };
    const location = compatible({ settings, tenantId: 't', providerKey: 'k' }) as string;
    expect(location).toBe('s3://archive/t/k/ · minio.internal:9000');
    expect(location).not.toMatch(/hunter2|private|token/);
  });
});
