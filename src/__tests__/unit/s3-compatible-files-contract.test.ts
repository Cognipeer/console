/**
 * The S3-compatible storage driver end to end: the real AWS SDK against the in-process fake S3 server.
 *
 * What is checked is what a self-hosted store sees on the wire (printable-ASCII headers, no flexible-checksum headers,
 * no `Expect: 100-continue`), what a person gets back (decoded names and metadata, readable failures), and how the
 * runtime behaves around the edges (pagination, a missing bucket, "Test connection", retries, closing).
 */
import net from 'node:net';
import { createHash } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { getCircuitState, isRetryable, resetAllCircuits, withResilience } from '@/lib/core/resilience';
import { S3CompatibleFileProviderContract } from '@/lib/providers/contracts/s3Compatible.contract';
import { decodeS3MetadataValue } from '@/lib/providers/contracts/s3/s3Helpers';
import { isS3OperationError, type S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { S3_PROBE_CLEANUP_MS, type S3FileRuntime } from '@/lib/providers/contracts/s3/s3FileRuntime';
import type { S3CompatibleSettings } from '@/lib/providers/contracts/s3/s3Helpers';
import { s3Error, startFakeS3, type FakeS3, type FakeS3Options, type RecordedRequest } from '../helpers/fakeS3Server';

// the resilience layer logs every retry and refusal; this file checks outcomes, and the runtime's own logger is injected
vi.mock('@/lib/core/logger', () => ({
  createLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }),
}));

const SECRET = 'secret-secret-secret';
const credentials = { accessKeyId: 'AKIATEST', secretAccessKey: SECRET };
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MIB = 1024 * 1024;

const original = getConfigSource();
const servers: FakeS3[] = [];
const runtimes: S3FileRuntime[] = [];
const raw: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  // a loopback server is a private target: this is a self-hosted deployment
  setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'onprem' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
});

afterEach(async () => {
  resetAllCircuits();
  setConfigSource(original);
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const server of servers.splice(0)) await server.close();
  for (const item of raw.splice(0)) await item.close();
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function fakeStore(options: FakeS3Options = {}): Promise<FakeS3> {
  const server = await startFakeS3({ buckets: ['bkt3'], ...options });
  servers.push(server);
  return server;
}

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function runtimeFor(
  target: { url: string },
  settings: Partial<S3CompatibleSettings> = {},
  logger: ReturnType<typeof makeLogger> = makeLogger(),
): Promise<S3FileRuntime> {
  const runtime = (await S3CompatibleFileProviderContract.createRuntime({
    tenantId: 'tenant1',
    providerKey: 'minio-main',
    credentials,
    settings: { endpoint: target.url, bucket: 'bkt3', ...settings },
    logger,
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

const headerValues = (request: RecordedRequest) => Object.values(request.headers).flatMap((value) => (Array.isArray(value) ? value : [String(value)]));
const headerNames = (request: RecordedRequest) => Object.keys(request.headers);
const putsOf = (server: FakeS3) => server.requests.filter((request) => request.method === 'PUT' && request.key);

/** A TCP port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('the contract', () => {
  it('is registered as the S3-compatible driver of the file domain', () => {
    expect(S3CompatibleFileProviderContract).toMatchObject({ id: 's3-compatible-files', version: '1.0.0', domains: ['file'] });
    expect(S3CompatibleFileProviderContract.display.label).toBe('S3-compatible storage');
    const fields = S3CompatibleFileProviderContract.form.sections.flatMap((section) => section.fields);
    expect(fields.map((field) => field.name)).toEqual([
      'accessKeyId', 'secretAccessKey', 'sessionToken',
      'endpoint', 'region', 'usePathStyleEndpoint',
      'bucket', 'prefix', 'createBucketIfMissing',
      'caCertificate', 'allowInsecureTls',
    ]);
    const scopeOf = (name: string) => fields.find((field) => field.name === name)?.scope;
    for (const name of ['accessKeyId', 'secretAccessKey', 'sessionToken']) expect(scopeOf(name)).toBe('credentials');
    for (const name of ['endpoint', 'region', 'bucket', 'prefix', 'caCertificate', 'allowInsecureTls']) expect(scopeOf(name)).toBe('settings');
    expect(fields.find((field) => field.name === 'endpoint')).toMatchObject({ required: true, type: 'text' });
    expect(fields.find((field) => field.name === 'usePathStyleEndpoint')).toMatchObject({ type: 'switch', defaultValue: true });
    expect(fields.find((field) => field.name === 'createBucketIfMissing')).toMatchObject({ type: 'switch', defaultValue: false });
    expect(fields.find((field) => field.name === 'caCertificate')).toMatchObject({ type: 'textarea' });
  });

  it('refuses to start without an endpoint, a bucket or keys', async () => {
    const make = (settings: Record<string, unknown>, creds: Record<string, unknown> = credentials) => S3CompatibleFileProviderContract.createRuntime({
      tenantId: 't', providerKey: 'k', credentials: creds as never, settings: settings as never,
    });
    await expect(make({ bucket: 'bkt3' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'endpoint' });
    await expect(make({ endpoint: 'http://127.0.0.1:1' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'bucket' });
    await expect(make({ endpoint: 'http://127.0.0.1:1', bucket: 'bkt3' }, { accessKeyId: 'a' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'secretAccessKey' });
    await expect(make({ endpoint: '127.0.0.1:1', bucket: 'bkt3' })).rejects.toMatchObject({ name: 'ProviderSettingsError', field: 'endpoint' });
  });
});

describe('a round trip', () => {
  it('stores, lists, reads, describes and deletes an object under the provider prefix', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server, { prefix: 'console/files' });
    const data = Buffer.from('merhaba dünya');

    const { handle } = await runtime.uploadFile({
      name: 'rapor_şubat.pdf',
      contentType: 'application/pdf',
      data,
      metadata: { department: 'Hukuk', note: 'çıktı', 'Doc Type': 'rapor' },
    });
    expect(handle).toMatchObject({
      name: 'rapor_şubat.pdf',
      size: data.length,
      contentType: 'application/pdf',
      checksum: sha256(data),
      // what the caller gave, not the header-safe form that was sent
      metadata: { department: 'Hukuk', note: 'çıktı', 'Doc Type': 'rapor' },
    });
    expect(handle.etag).toBeTruthy();
    expect(handle.key).toMatch(/^rapor_-ubat-\d+-[0-9a-f]{8}\.pdf$/);

    const stored = server.objects.get(`bkt3/console/files/tenant1/minio-main/${handle.key}`);
    expect(stored?.body.equals(data)).toBe(true);
    expect(stored?.contentType).toBe('application/pdf');
    // what is on the wire: header-safe, lower-case names, ASCII for anything else
    expect(stored?.meta.checksum).toBe(sha256(data));
    expect(stored?.meta.department).toBe('Hukuk');
    expect(stored?.meta.originalname).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decodeS3MetadataValue(stored?.meta.originalname ?? '')).toBe('rapor_şubat.pdf');
    expect(decodeS3MetadataValue(stored?.meta.note ?? '')).toBe('çıktı');
    expect(stored?.meta['doc-type']).toBe('rapor');

    const listing = await runtime.listFiles();
    expect(listing.nextCursor).toBeUndefined();
    expect(listing.items).toHaveLength(1);
    expect(listing.items[0]).toMatchObject({ key: handle.key, name: handle.key, size: data.length });
    expect(listing.items[0].lastModified).toBeInstanceOf(Date);

    const download = await runtime.downloadFile(handle.key);
    expect(download.data.equals(data)).toBe(true);
    expect(download).toMatchObject({ contentType: 'application/pdf', size: data.length, etag: handle.etag });
    expect(download.metadata).toMatchObject({ checksum: sha256(data), originalname: 'rapor_şubat.pdf', department: 'Hukuk', note: 'çıktı', 'doc-type': 'rapor' });

    const described = await runtime.getFileMetadata(handle.key);
    expect(described).toMatchObject({
      key: handle.key,
      name: handle.key,
      size: data.length,
      contentType: 'application/pdf',
      etag: handle.etag,
      metadata: { originalname: 'rapor_şubat.pdf', note: 'çıktı' },
    });
    expect(described?.lastModified).toBeInstanceOf(Date);

    await runtime.deleteFile(handle.key);
    expect(server.objects.size).toBe(0);
    await expect(runtime.getFileMetadata(handle.key)).resolves.toBeNull();
    const gone = await failureOf(() => runtime.downloadFile(handle.key));
    expect(gone).toMatchObject({ code: 'object_missing', statusCode: 404, retryable: false });
    // the one message the file routes turn into a 404
    expect(gone.message).toMatch(/does not exist/);
  });

  it('keeps an explicit key, including non-ASCII folder and file names', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const key = 'raporlar/şubat özet (1).pdf';
    const { handle } = await runtime.uploadFile({ key, name: 'şubat özet (1).pdf', data: Buffer.from('x') });
    expect(handle.key).toBe(key);
    expect(server.objects.has(`bkt3/tenant1/minio-main/${key}`)).toBe(true);
    expect((await runtime.listFiles({ prefix: 'raporlar/' })).items.map((item) => item.key)).toEqual([key]);
    expect((await runtime.downloadFile(key)).data.toString()).toBe('x');
    expect((await runtime.getFileMetadata(key))?.key).toBe(key);
    await runtime.deleteFile(key);
    expect(server.objects.size).toBe(0);
  });

  it('keeps every header on the wire printable ASCII, whatever the names and metadata are', async () => {
    // a Go-style server fails the signature check of a raw non-ASCII header byte
    const server = await fakeStore({ rejectRawNonAscii: true });
    const runtime = await runtimeFor(server);
    const names = ['rapor_şubat.pdf', 'çıktı.docx', 'Güneş_Ağaç.pdf', 'İstanbul İÇ.txt', 'report-\u{1F642}.pdf', '日本語のファイル.txt', ' leading and trailing '];

    for (const name of names) {
      const { handle } = await runtime.uploadFile({ name, data: Buffer.from(name), metadata: { title: name, 'ünvan': name } });
      expect((await runtime.downloadFile(handle.key)).metadata?.originalname).toBe(name);
      expect((await runtime.getFileMetadata(handle.key))?.metadata?.title).toBe(name);
    }

    const puts = putsOf(server);
    expect(puts).toHaveLength(names.length);
    for (const request of puts) {
      for (const name of headerNames(request)) expect(name, name).toMatch(/^[a-z0-9-]+$/);
      for (const value of headerValues(request)) expect(value).toMatch(PRINTABLE_ASCII);
    }
  });

  it('sends a content type a header can carry: trimmed, reduced to its media type when it is not ASCII, refused when it cannot be a header', async () => {
    const server = await fakeStore();
    const logger = makeLogger();
    const runtime = await runtimeFor(server, {}, logger);
    const contentTypeOf = (key: string) => server.objects.get(`bkt3/tenant1/minio-main/${key}`)?.contentType;

    const plain = await runtime.uploadFile({ key: 'a.json', name: 'a.json', contentType: ' application/json; charset=utf-8 ', data: Buffer.from('{}') });
    expect(contentTypeOf('a.json')).toBe('application/json; charset=utf-8');
    expect(plain.handle.contentType).toBe('application/json; charset=utf-8');

    // the SDK signs such a value as UTF-8 and Node writes it as Latin-1: a Go-based store would answer with a signature error
    const accented = await runtime.uploadFile({ key: 'b.txt', name: 'b.txt', contentType: 'text/plain; name=\u00E7ay.txt', data: Buffer.from('b') });
    expect(contentTypeOf('b.txt')).toBe('text/plain');
    expect(contentTypeOf('b.txt')).toMatch(PRINTABLE_ASCII);
    expect(accented.handle.contentType).toBe('text/plain');
    const warning = logger.warn.mock.calls.find(([message]) => String(message).includes('content type outside printable ASCII'));
    expect(warning?.[1]).toEqual({ key: 'tenant1/minio-main/b.txt' });

    const before = server.requests.length;
    for (const contentType of ['text/plain\r\nX-Injected: 1', 'text/\u011F', 'text/plain\u0000']) {
      const error = await failureOf(() => runtime.uploadFile({ key: 'c.txt', name: 'c.txt', contentType, data: Buffer.from('c') }));
      expect(error).toMatchObject({ code: 'invalid_header', retryable: false, statusCode: 400 });
      expect(error.message).toBe('The content type contains characters that are not allowed in an HTTP header.');
    }
    // refused before anything was sent
    expect(server.requests.length).toBe(before);
    expect(server.objects.has('bkt3/tenant1/minio-main/c.txt')).toBe(false);
  });

  it('writes nothing a store without flexible checksums rejects, and sends no Expect header', async () => {
    const server = await fakeStore({ rejectChecksumHeaders: true });
    const runtime = await runtimeFor(server);
    const { handle } = await runtime.uploadFile({ name: 'çıktı.docx', data: Buffer.from('docx') });
    await runtime.downloadFile(handle.key);
    await runtime.getFileMetadata(handle.key);
    await runtime.listFiles();
    await runtime.deleteFile(handle.key);

    expect(server.requests.length).toBeGreaterThan(4);
    for (const request of server.requests) {
      const names = headerNames(request);
      expect(names.filter((name) => name.startsWith('x-amz-checksum-')), `${request.method} ${request.url}`).toEqual([]);
      expect(names).not.toContain('x-amz-sdk-checksum-algorithm');
      expect(names).not.toContain('x-amz-trailer');
      expect(names).not.toContain('expect');
      expect(String(request.headers['content-encoding'] ?? '')).not.toContain('aws-chunked');
    }
  });

  it('is what a client with the SDK defaults is not: such a client is refused by that store', async () => {
    const server = await fakeStore({ rejectChecksumHeaders: true });
    const plain = new S3Client({ region: 'us-east-1', endpoint: server.url, forcePathStyle: true, credentials, maxAttempts: 1 });
    try {
      await expect(plain.send(new PutObjectCommand({ Bucket: 'bkt3', Key: 'k', Body: Buffer.from('x') }))).rejects.toMatchObject({ name: 'NotImplemented' });
    } finally {
      plain.destroy();
    }
  });

  it('uploads 3 MiB without waiting for a 100-continue the store never sends', async () => {
    const server = await fakeStore({ neverContinue: true });
    const runtime = await runtimeFor(server);
    const data = Buffer.alloc(3 * MIB, 'a');

    const started = Date.now();
    const { handle } = await runtime.uploadFile({ name: 'big.bin', contentType: 'application/octet-stream', data });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2500);
    const put = putsOf(server)[0];
    expect(put.headers.expect).toBeUndefined();
    expect(put.bytes).toBe(3 * MIB);
    expect(server.objects.get(`bkt3/tenant1/minio-main/${handle.key}`)?.body.equals(data)).toBe(true);
    expect((await runtime.downloadFile(handle.key)).data.equals(data)).toBe(true);
  });

  it('leaves out the metadata that does not fit, says so in the log, and still uploads', async () => {
    const server = await fakeStore();
    const logger = makeLogger();
    const runtime = await runtimeFor(server, {}, logger);
    const { handle } = await runtime.uploadFile({
      name: 'a.txt',
      data: Buffer.from('a'),
      metadata: { small: 'kept', huge: 'x'.repeat(5000), 'Small': 'collides', '###': 'no name left' },
    });

    expect(handle.metadata).toMatchObject({ small: 'kept', huge: 'x'.repeat(5000) });
    const stored = server.objects.get(`bkt3/tenant1/minio-main/${handle.key}`);
    expect(stored?.meta.small).toBe('kept');
    expect(stored?.meta.huge).toBeUndefined();
    const sentBytes = Object.entries(stored?.meta ?? {}).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0);
    expect(sentBytes).toBeLessThanOrEqual(2000);

    const warning = logger.warn.mock.calls.find(([message]) => String(message).includes('metadata that does not fit'));
    expect(warning?.[1]).toMatchObject({ dropped: expect.arrayContaining(['huge', 'Small', '###']) });
  });

  it('signs with the region and the session token it was given', async () => {
    const server = await fakeStore();
    const withDefaults = await runtimeFor(server);
    await withDefaults.listFiles();
    expect(String(server.requests[0].headers.authorization)).toMatch(/Credential=AKIATEST\/\d{8}\/us-east-1\/s3\/aws4_request/);
    expect(server.requests[0].headers['x-amz-security-token']).toBeUndefined();

    server.requests.length = 0;
    const runtime = (await S3CompatibleFileProviderContract.createRuntime({
      tenantId: 'tenant1',
      providerKey: 'minio-main',
      credentials: { ...credentials, sessionToken: 'session-token-value' },
      settings: { endpoint: server.url, bucket: 'bkt3', region: 'auto' },
    })) as S3FileRuntime;
    runtimes.push(runtime);
    await runtime.listFiles();
    expect(String(server.requests[0].headers.authorization)).toMatch(/\/auto\/s3\/aws4_request/);
    expect(server.requests[0].headers['x-amz-security-token']).toBe('session-token-value');
    // path-style by default: the bucket is the first path segment, the host is the endpoint itself
    expect(server.requests[0].url.startsWith('/bkt3?') || server.requests[0].url.startsWith('/bkt3/?')).toBe(true);
    expect(server.requests[0].headers.host).toBe(`127.0.0.1:${server.port}`);
  });

  it('never puts a key, a secret or the SDK\'s own wording into a log line or an error message', async () => {
    const server = await fakeStore({ intercept: (request) => (request.key.startsWith('tenant1/minio-main/denied') ? s3Error(403, 'AccessDenied', `denied for ${SECRET}`) : undefined) });
    const logger = makeLogger();
    const runtime = await runtimeFor(server, {}, logger);
    await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a'), key: 'ok.txt' });
    const failure = await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a'), key: 'denied.txt' }));
    await runtime.deleteFile('ok.txt');

    const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(credentials.accessKeyId);
    expect(failure.message).not.toContain(SECRET);
  });
});

describe('listing', () => {
  it('pages with the cursor, only inside the provider prefix', async () => {
    const server = await fakeStore();
    const keys = Array.from({ length: 7 }, (_, index) => `docs/f${index}.txt`);
    for (const key of keys) server.seed('bkt3', `tenant1/minio-main/${key}`, `body ${key}`);
    server.seed('bkt3', 'tenant1/other-provider/stranger.txt', 'not mine');
    server.seed('bkt3', 'tenant2/minio-main/stranger.txt', 'not mine either');
    const runtime = await runtimeFor(server);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await runtime.listFiles({ limit: 3, cursor });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((item) => item.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual(keys);
    const lists = server.requests.filter((request) => request.method === 'GET');
    expect(lists[0].query.get('prefix')).toBe('tenant1/minio-main/');
    expect(lists[0].query.get('max-keys')).toBe('3');
    expect(lists[0].query.get('continuation-token')).toBeNull();
    expect(lists[1].query.get('continuation-token')).toBeTruthy();
  });

  it('lists 50 at a time unless told otherwise, and narrows with a prefix', async () => {
    const server = await fakeStore();
    server.seed('bkt3', 'tenant1/minio-main/a/one.txt', '1');
    server.seed('bkt3', 'tenant1/minio-main/a/two.txt', '2');
    server.seed('bkt3', 'tenant1/minio-main/b/three.txt', '3');
    const runtime = await runtimeFor(server);

    expect((await runtime.listFiles()).items).toHaveLength(3);
    expect(server.requests[0].query.get('max-keys')).toBe('50');
    expect((await runtime.listFiles({ prefix: 'a/' })).items.map((item) => item.key)).toEqual(['a/one.txt', 'a/two.txt']);
    // as it always was, the prefix is read as a key: a trailing slash is dropped
    expect(server.requests[1].query.get('prefix')).toBe('tenant1/minio-main/a');
    // a blank prefix means the whole provider
    expect((await runtime.listFiles({ prefix: '  ' })).items).toHaveLength(3);
  });

  it('reads the prefix as text: a folder name also lists the names that merely start with it, with or without the slash', async () => {
    const server = await fakeStore();
    for (const key of ['dir/a.txt', 'dir-other/c.txt', 'dirx.txt', 'other/z.txt']) server.seed('bkt3', `tenant1/minio-main/${key}`, key);
    const runtime = await runtimeFor(server);
    const keys = async (prefix: string) => (await runtime.listFiles({ prefix })).items.map((item) => item.key);

    expect(await keys('dir/')).toEqual(['dir-other/c.txt', 'dir/a.txt', 'dirx.txt']);
    expect(await keys('dir')).toEqual(['dir-other/c.txt', 'dir/a.txt', 'dirx.txt']);
  });

  it('asks for url-encoded keys, so a key XML cannot carry comes back exactly', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const keys = ['plain.txt', 'a b+c%d#e.txt', 'çay şül/\u{1F600}.txt', 'ctl\u0001\u001b.txt', 'bom\uffff.txt', '100%41.txt'];
    for (const key of keys) server.seed('bkt3', `tenant1/minio-main/${key}`, key);

    const page = await runtime.listFiles({ limit: 100 });
    expect(page.items.map((item) => item.key).sort()).toEqual([...keys].sort());
    expect(page.items.find((item) => item.key === 'a b+c%d#e.txt')).toMatchObject({ name: 'a b+c%d#e.txt', size: 'a b+c%d#e.txt'.length });
    const listing = server.requests.find((request) => request.method === 'GET');
    expect(listing?.query.get('encoding-type')).toBe('url');
    // the cursor stays what the store gave: it is not a key
    const first = await runtime.listFiles({ limit: 2 });
    expect(first.nextCursor).toBeTruthy();
    const second = await runtime.listFiles({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.key)).not.toEqual(first.items.map((item) => item.key));
  });

  it('reads the keys as they are from a store that ignores the encoding request', async () => {
    const server = await fakeStore({ ignoreEncodingType: true });
    const runtime = await runtimeFor(server);
    // text that would change if it were decoded
    const keys = ['100%41.txt', 'a+b.txt', 'sp ace.txt'];
    for (const key of keys) server.seed('bkt3', `tenant1/minio-main/${key}`, key);
    expect((await runtime.listFiles()).items.map((item) => item.key).sort()).toEqual([...keys].sort());
  });

  it('decodes "+" as a space, and leaves a key alone when the store says "url" and sends something else', async () => {
    const listing = (keys: string[]) => `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bkt3</Name><Prefix>tenant1/minio-main/</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>50</MaxKeys><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e"</ETag><Size>1</Size></Contents>`).join('')}</ListBucketResult>`;
    const server = await fakeStore({
      intercept: (request) => (request.method === 'GET' && !request.key
        ? { status: 200, headers: { 'content-type': 'application/xml' }, body: listing(['tenant1/minio-main/a+b%2Bc%20d.txt', 'tenant1/minio-main/100%.txt', 'tenant1/minio-main/%C3%A7ay.txt']) }
        : undefined),
    });
    const runtime = await runtimeFor(server);
    expect((await runtime.listFiles()).items.map((item) => item.key)).toEqual(['a b+c d.txt', '100%.txt', 'çay.txt']);
  });

  it('reads an empty cursor as the first page, like the other file drivers do', async () => {
    const server = await fakeStore();
    server.seed('bkt3', 'tenant1/minio-main/one.txt', '1');
    const runtime = await runtimeFor(server);
    expect((await runtime.listFiles({ cursor: '' })).items.map((item) => item.key)).toEqual(['one.txt']);
    const listing = server.requests.find((request) => request.method === 'GET');
    // an empty continuation token is not one: some stores answer it with a 400
    expect(listing?.query.has('continuation-token')).toBe(false);
  });

  it('answers an empty page for a bucket with nothing in it', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    await expect(runtime.listFiles()).resolves.toEqual({ items: [], nextCursor: undefined });
    await expect(runtime.getFileMetadata('absent.txt')).resolves.toBeNull();
  });

  it('keeps the legacy key rules: backslashes become slashes and a run of dots one dot', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const { handle } = await runtime.uploadFile({ key: '\\dir\\..file.txt', name: 'f.txt', data: Buffer.from('x') });
    expect(handle.key).toBe('dir/.file.txt');
    expect(server.objects.has('bkt3/tenant1/minio-main/dir/.file.txt')).toBe(true);
    await expect(runtime.downloadFile('///')).rejects.toThrow('Invalid file key provided.');
  });
});

describe('a key the driver cannot send', () => {
  const BAD = ['///', '', '\\', 'bad/\uD800.txt', 'lone/\uDC00low.txt', 'half\uD83D'];

  it('is refused before any request, as a typed error that says so and is not retried', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    for (const key of BAD) {
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['upload', () => runtime.uploadFile({ key, name: 'x', data: Buffer.from('x') })],
        ['download', () => runtime.downloadFile(key)],
        ['head', () => runtime.getFileMetadata(key)],
        ['delete', () => runtime.deleteFile(key)],
        // a blank prefix means "the whole provider"
        ...(key.trim() === '' ? [] : [['list', () => runtime.listFiles({ prefix: key })] as [string, () => Promise<unknown>]]),
      ];
      for (const [label, run] of calls) {
        const error = await failureOf(run);
        expect(error, `${label} ${JSON.stringify(key)}`).toMatchObject({ code: 'invalid_key', statusCode: 400, retryable: false });
        expect(error.message).toMatch(/^Invalid file key provided/);
        expect(isRetryable(error)).toBe(false);
        expect(error.message).not.toContain(SECRET);
      }
    }
    expect(server.requests).toHaveLength(0);
  });

  it('does not count against the circuit breaker, so one caller cannot shut the provider for the others', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const options = {
      key: 'file-upload:tenant1:minio-main',
      retry: { enabled: true, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2, jitterFactor: 0 },
      circuitBreaker: { enabled: true, threshold: 3, resetMs: 60_000 },
      countFailure: isRetryable,
    };

    let attempts = 0;
    for (let call = 0; call < 6; call += 1) {
      await expect(withResilience(async () => {
        attempts += 1;
        return runtime.uploadFile({ key: 'bad/\uD800.txt', name: 'x', data: Buffer.from('x') });
      }, options)).rejects.toMatchObject({ code: 'invalid_key' });
    }
    expect(attempts).toBe(6);
    expect(getCircuitState(options.key)?.state ?? 'closed').toBe('closed');
    await expect(withResilience(() => runtime.uploadFile({ key: 'good.txt', name: 'good.txt', data: Buffer.from('ok') }), options))
      .resolves.toMatchObject({ handle: { key: 'good.txt' } });

    // the same options do open the circuit for a store that is down, so the check above proves something
    const down = await fakeStore({ intercept: () => s3Error(503, 'SlowDown', 'Please reduce your request rate.') });
    const failing = await runtimeFor(down);
    const downOptions = { ...options, key: 'file-upload:tenant1:down' };
    for (let call = 0; call < 3; call += 1) {
      await expect(withResilience(() => failing.uploadFile({ key: 'a.txt', name: 'a.txt', data: Buffer.from('a') }), downOptions)).rejects.toMatchObject({ code: 'store_unavailable' });
    }
    expect(getCircuitState(downOptions.key)?.state).toBe('open');
  });
});

describe('a missing bucket', () => {
  it('is reported with what to do, and nothing is created when the switch is off', async () => {
    const server = await fakeStore({ buckets: [] });
    const runtime = await runtimeFor(server);
    const error = await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') }));
    expect(error).toMatchObject({ code: 'bucket_missing', retryable: false, statusCode: 404 });
    expect(error.message).toMatch(/Create it first .*turn on "Create bucket if missing"/);
    expect(server.requests.map((request) => `${request.method} ${request.key ? 'object' : 'bucket'}`)).toEqual(['PUT object']);
    expect(server.buckets.size).toBe(0);
  });

  it('is created on the first upload when the switch is on, once, with no location constraint', async () => {
    const server = await fakeStore({ buckets: [] });
    const logger = makeLogger();
    const runtime = await runtimeFor(server, { createBucketIfMissing: true }, logger);

    await runtime.uploadFile({ name: 'one.txt', data: Buffer.from('1'), key: 'one.txt' });
    expect(server.requests.map((request) => `${request.method} ${request.key ? 'object' : 'bucket'}`)).toEqual([
      'PUT object', // NoSuchBucket
      'PUT bucket', // CreateBucket
      'PUT object', // the retried upload
    ]);
    const create = server.requests[1];
    expect(create.bytes).toBe(0); // no <CreateBucketConfiguration><LocationConstraint>
    expect(server.buckets.has('bkt3')).toBe(true);
    expect(logger.info.mock.calls.some(([message]) => String(message).includes('Created S3 bucket'))).toBe(true);

    server.requests.length = 0;
    await runtime.uploadFile({ name: 'two.txt', data: Buffer.from('2'), key: 'two.txt' });
    expect(server.requests.map((request) => `${request.method} ${request.key ? 'object' : 'bucket'}`)).toEqual(['PUT object']);
  });

  it('survives another replica creating the bucket first', async () => {
    let first = true;
    const server = await fakeStore({
      intercept: (request) => {
        if (request.method === 'PUT' && request.key && first) {
          first = false;
          return s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');
        }
        return undefined;
      },
    });
    const runtime = await runtimeFor(server, { createBucketIfMissing: true });
    const { handle } = await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') });
    expect(handle.key).toBeTruthy();
    // CreateBucket answered BucketAlreadyOwnedByYou (the bucket was there): that is success
    expect(server.requests.map((request) => `${request.method} ${request.key ? 'object' : 'bucket'}`)).toEqual(['PUT object', 'PUT bucket', 'PUT object']);
    expect(server.objects.size).toBe(1);
  });

  it('does not try to create a bucket after "access denied"', async () => {
    const server = await fakeStore({ intercept: (request) => (request.method === 'PUT' ? s3Error(403, 'AccessDenied', 'Access Denied.') : undefined) });
    const runtime = await runtimeFor(server, { createBucketIfMissing: true });
    const error = await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') }));
    expect(error.code).toBe('access_denied');
    expect(server.requests.filter((request) => request.method === 'PUT' && !request.key)).toHaveLength(0);
    expect(server.requests).toHaveLength(1);
  });

  it('is not created by a read, a listing or a delete', async () => {
    const server = await fakeStore({ buckets: [] });
    const runtime = await runtimeFor(server, { createBucketIfMissing: true });
    await failureOf(() => runtime.listFiles());
    await failureOf(() => runtime.downloadFile('k.txt'));
    await failureOf(() => runtime.deleteFile('k.txt'));
    // a HEAD has no body to say which of the two is missing: it reads as "no such object", as it always did
    await expect(runtime.getFileMetadata('k.txt')).resolves.toBeNull();
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
    expect(server.buckets.size).toBe(0);
  });
});

describe('retries', () => {
  it('tries a refused request once and no more', async () => {
    const server = await fakeStore({ intercept: () => s3Error(403, 'AccessDenied', 'Access Denied.') });
    const runtime = await runtimeFor(server);
    await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') }));
    expect(server.requests).toHaveLength(1);
  });

  it('retries a transient failure once, transparently', async () => {
    const server = await fakeStore({ failFirst: { status: 503, code: 'ServiceUnavailable', times: 1 } });
    const runtime = await runtimeFor(server);
    await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') });
    expect(putsOf(server)).toHaveLength(2);
    expect(server.objects.size).toBe(1);
  });

  it('gives up after two attempts', async () => {
    const server = await fakeStore({ failFirst: { status: 503, code: 'ServiceUnavailable', times: 10 } });
    const runtime = await runtimeFor(server);
    const error = await failureOf(() => runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') }));
    expect(error).toMatchObject({ code: 'store_unavailable', retryable: true, statusCode: 503 });
    expect(putsOf(server)).toHaveLength(2);
  });
});

describe('Test connection (checkConnection)', () => {
  it('lists, writes, reads back and deletes, and leaves nothing behind', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server, { prefix: 'console' });

    const result = await runtime.checkConnection();
    expect(result).toEqual({
      ok: true,
      message: 'Connected to bucket "bkt3" (list, write, read, delete).',
      steps: [
        { step: 'list', ok: true },
        { step: 'write', ok: true },
        { step: 'read', ok: true },
        { step: 'delete', ok: true },
      ],
    });
    expect(server.objects.size).toBe(0);

    const [listing, put, get, del] = server.requests;
    expect(listing.method).toBe('GET');
    expect(listing.query.get('max-keys')).toBe('1');
    expect(listing.query.get('prefix')).toBe('console/tenant1/minio-main/');
    expect(put.method).toBe('PUT');
    expect(put.key).toMatch(/^console\/tenant1\/minio-main\/\.cognipeer-connection-test\/[0-9a-f-]{36}\.txt$/);
    // the probe sends a non-ASCII name through the metadata encoding on purpose
    expect(String(put.headers['x-amz-meta-originalname'])).toMatch(/^=\?UTF-8\?B\?/);
    for (const value of headerValues(put)) expect(value).toMatch(PRINTABLE_ASCII);
    expect(get.method).toBe('GET');
    expect(get.key).toBe(put.key);
    expect(del.method).toBe('DELETE');
    expect(del.key).toBe(put.key);
  });

  it('only lists when it is told not to write', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection({ write: false });
    expect(result).toEqual({ ok: true, message: 'Connected to bucket "bkt3" (list).', steps: [{ step: 'list', ok: true }] });
    expect(server.requests).toHaveLength(1);
  });

  it('names a missing bucket', async () => {
    const server = await fakeStore({ buckets: [] });
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Bucket "bkt3" is missing on 127\.0\.0\.1:\d+\. /);
    expect(result.steps).toEqual([{ step: 'list', ok: false, message: result.message }]);
    expect(server.requests).toHaveLength(1);
  });

  it('creates the missing bucket when the provider is set to, and says so', async () => {
    const server = await fakeStore({ buckets: [] });
    const runtime = await runtimeFor(server, { createBucketIfMissing: true });
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toBe('Connected to bucket "bkt3" (bucket created, list, write, read, delete).');
    expect(server.buckets.has('bkt3')).toBe(true);
    expect(server.objects.size).toBe(0);
  });

  it('does not create a bucket for a provider that is not set to', async () => {
    const server = await fakeStore({ buckets: [] });
    const runtime = await runtimeFor(server);
    await runtime.checkConnection();
    expect(server.buckets.size).toBe(0);
    expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('reports a wrong access key in the first step', async () => {
    const server = await fakeStore({ accessKeyId: 'SOMEONE-ELSE' });
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not recognise this access key ID/);
    expect(result.steps).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
  });

  it('reports the region a store expects', async () => {
    const server = await fakeStore({ region: 'eu-1' });
    const wrong = await runtimeFor(server);
    const failed = await wrong.checkConnection();
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/expects region "eu-1"/);

    const right = await runtimeFor(server, { region: 'eu-1' });
    expect((await right.checkConnection()).ok).toBe(true);
  });

  it('does not take a web console for an S3 server', async () => {
    const html = await fakeStore({ htmlRoot: true });
    const fromHtml = await (await runtimeFor(html)).checkConnection();
    expect(fromHtml.ok).toBe(false);
    expect(fromHtml.message).toMatch(/answered HTTP 200 but not with an S3 response/);
    expect(fromHtml.steps).toEqual([{ step: 'list', ok: false, message: fromHtml.message }]);

    // an empty 200 deserialises without error: the listing shape is what gives it away
    const empty = await fakeStore({ emptyOk: true });
    const fromEmpty = await (await runtimeFor(empty)).checkConnection();
    expect(fromEmpty.ok).toBe(false);
    expect(fromEmpty.message).toMatch(/answered HTTP 200 but not with an S3 bucket listing/);
    expect(empty.requests).toHaveLength(1);
  });

  it('says where to look when nothing listens on the port', async () => {
    const port = await closedPort();
    const runtime = await runtimeFor({ url: `http://127.0.0.1:${port}` });
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`Connection refused by 127.0.0.1:${port}`);
    expect(result.message).toMatch(/MinIO: 9000, not the 9001 console/);
    expect(result.steps).toEqual([{ step: 'list', ok: false, message: result.message }]);
  });

  it('says that listing works but writing does not, for read-only keys', async () => {
    const server = await fakeStore({ intercept: (request) => (request.method === 'PUT' ? s3Error(403, 'AccessDenied', 'Access Denied.') : undefined) });
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Listing works, but writing a test object failed: Access denied on bucket "bkt3"/);
    expect(result.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:false']);
  });

  it('still removes the test object when reading it back fails', async () => {
    const server = await fakeStore({ intercept: (request) => (request.method === 'GET' && request.key ? s3Error(500, 'InternalError', 'boom') : undefined) });
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Writing works, but reading the test object back failed: .*overloaded or unavailable/);
    expect(result.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:true', 'read:false', 'delete:true']);
    expect(server.objects.size).toBe(0);
  });

  it('passes when only the delete is refused, and says what is left behind', async () => {
    const server = await fakeStore({ intercept: (request) => (request.method === 'DELETE' ? s3Error(403, 'AccessDenied', 'Access Denied.') : undefined) });
    const runtime = await runtimeFor(server);
    const result = await runtime.checkConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^Connected to bucket "bkt3" \(list, write, read\)\. Removing the test object failed \(Access denied on bucket "bkt3"/);
    expect(result.message).toContain('.cognipeer-connection-test/');
    expect(result.message).toMatch(/Deleting files needs the DeleteObject permission\.$/);
    expect(result.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:true', 'read:true', 'delete:false']);
    expect([...server.objects.keys()].filter((key) => key.includes('.cognipeer-connection-test/'))).toHaveLength(1);
  });

  it('stops at once when it is aborted before it starts', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.checkConnection({ signal: controller.signal });
    expect(result).toMatchObject({ ok: false, message: 'The test was stopped before it finished (time limit).' });
    expect(server.requests).toHaveLength(0);
  });

  it('stops when it is aborted while the store does not answer', async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    raw.push({
      close: () => new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        silent.close(() => resolve());
      }),
    });
    const { port } = silent.address() as net.AddressInfo;
    const runtime = await runtimeFor({ url: `http://127.0.0.1:${port}` });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const result = await runtime.checkConnection({ signal: controller.signal });
    clearTimeout(timer);

    expect(result).toMatchObject({ ok: false, message: 'The test was stopped before it finished (time limit).' });
    expect(result.steps).toEqual([{ step: 'list', ok: false, message: 'The test was stopped before it finished (time limit).' }]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('does not blame the store when the time limit ends the test during the write or the read', async () => {
    const STOPPED = 'The test was stopped before it finished (time limit).';

    const duringWrite = new AbortController();
    const writing = await fakeStore({ intercept: (request) => { if (request.method === 'PUT') duringWrite.abort(); return undefined; } });
    const afterList = await (await runtimeFor(writing)).checkConnection({ signal: duringWrite.signal });
    expect(afterList).toMatchObject({ ok: false, message: STOPPED });
    expect(afterList.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:false']);

    const duringRead = new AbortController();
    const reading = await fakeStore({ intercept: (request) => { if (request.method === 'GET' && request.key) duringRead.abort(); return undefined; } });
    const afterWrite = await (await runtimeFor(reading)).checkConnection({ signal: duringRead.signal });
    expect(afterWrite).toMatchObject({ ok: false, message: STOPPED });
    // the object is removed on a signal of its own, so the caller's spent one does not leave it behind
    expect(afterWrite.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:true', 'read:false', 'delete:true']);
  });

  it('removes its test object when the time limit ends the test during the read', async () => {
    const duringRead = new AbortController();
    const server = await fakeStore({ intercept: (request) => { if (request.method === 'GET' && request.key) duringRead.abort(); return undefined; } });
    const result = await (await runtimeFor(server)).checkConnection({ signal: duringRead.signal });
    expect(result.ok).toBe(false);
    expect(server.objects.size).toBe(0);
    const deletes = server.requests.filter((request) => request.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].key).toMatch(/\.cognipeer-connection-test\//);
  });

  it('removes its test object when the time limit ends the test during the write', async () => {
    const duringWrite = new AbortController();
    const server = await fakeStore({ intercept: (request) => { if (request.method === 'PUT' && request.key) duringWrite.abort(); return undefined; } });
    const result = await (await runtimeFor(server)).checkConnection({ signal: duringWrite.signal });
    expect(result).toMatchObject({ ok: false, message: 'The test was stopped before it finished (time limit).' });
    // the store kept the object while the caller gave up: the abort cannot take back a write that was already sent
    expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(server.objects.size).toBe(0);
  });

  it('removes its test object when the store stored it and still answered the write with an error', async () => {
    const server: FakeS3 = await fakeStore({
      intercept: (request) => {
        if (request.method !== 'PUT' || !request.key) return undefined;
        server.seed(request.bucket, request.key, 'cognipeer connection test');
        return s3Error(500, 'InternalError', 'committed, then failed');
      },
    });
    const result = await (await runtimeFor(server)).checkConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^Listing works, but writing a test object failed: /);
    // no delete step in what the person sees: the write is what failed
    expect(result.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:false']);
    expect(server.objects.size).toBe(0);
    expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
  });

  it('does not send a delete when no write was attempted', async () => {
    const server = await fakeStore({ intercept: (request) => (request.method === 'GET' && !request.key ? s3Error(403, 'AccessDenied', 'Access Denied.') : undefined) });
    const result = await (await runtimeFor(server)).checkConnection();
    expect(result.ok).toBe(false);
    expect(server.requests.filter((request) => request.method === 'DELETE' || request.method === 'PUT')).toHaveLength(0);
  });

  it('does not blame the DeleteObject permission when the removal itself ran out of time', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    // the removal gets a limit that is spent before it starts, as a store that never answers the delete would leave it
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      if (ms !== S3_PROBE_CLEANUP_MS) return real(ms);
      const spent = new AbortController();
      spent.abort();
      return spent.signal;
    });
    try {
      const server = await fakeStore();
      const result = await (await runtimeFor(server)).checkConnection();
      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/^Connected to bucket "bkt3" \(list, write, read\)\. Removing the test object did not finish in time; it may be left under "\.cognipeer-connection-test\/"\.$/);
      expect(result.message).not.toMatch(/DeleteObject permission/);
      expect(result.steps?.map((step) => `${step.step}:${step.ok}`)).toEqual(['list:true', 'write:true', 'read:true', 'delete:false']);
    } finally {
      timeout.mockRestore();
    }
  });

  it('never throws, even on a runtime that was closed', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    runtime.close();
    const result = await runtime.checkConnection();
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });
});

describe('close()', () => {
  async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
    const until = Date.now() + ms;
    while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it('releases the connections the runtime keeps alive', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    await runtime.uploadFile({ name: 'a.txt', data: Buffer.from('a') });
    await runtime.listFiles();
    // a keep-alive socket stays open between requests
    expect(server.openSockets()).toBeGreaterThan(0);

    runtime.close();
    await waitFor(() => server.openSockets() === 0);
    expect(server.openSockets()).toBe(0);
  });

  it('can be called twice', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    await runtime.listFiles();
    runtime.close();
    expect(() => runtime.close()).not.toThrow();
  });
});

describe('the network policy', () => {
  it('lets a self-hosted deployment reach a store on its own network', async () => {
    const server = await fakeStore();
    const runtime = await runtimeFor(server);
    await expect(runtime.listFiles()).resolves.toMatchObject({ items: [] });
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it('refuses a loopback endpoint on SaaS before any request is made', async () => {
    const server = await fakeStore();
    setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'saas' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
    await expect(runtimeFor(server)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint', retryable: false });
    expect(server.requests).toHaveLength(0);
  });

  it('refuses it on a self-hosted deployment that blocks private networks', async () => {
    const server = await fakeStore();
    setConfigSource({ get: (key: string) => ({ DEPLOYMENT_MODE: 'onprem', OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK: 'true' } as Record<string, string>)[key] ?? process.env[key] } as ConfigSource);
    await expect(runtimeFor(server)).rejects.toMatchObject({ name: 'ProviderEndpointError', field: 'endpoint' });
    expect(server.requests).toHaveLength(0);
  });
});
