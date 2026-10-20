/**
 * The client Files API (`plugins/client-files.ts`) answers a failed call the way the Document Store does: the same
 * statuses, the same stable `code`, the same safe messages, and an unrecognised failure is a generic 502.
 * Also here: the body limit of the upload route, the quotas of the bucket's provider, header-safe downloads, and a
 * switched-off bucket that is read-only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  auth: {
    token: 'tok',
    tokenRecord: { _id: 'tok-1', userId: 'user-1' },
    tenant: { licenseType: 'STARTER' },
    tenantId: 'tenant-1',
    tenantDbName: 'tenant_acme',
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
  },
}));

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    // The token gate is covered by the rbac / route-declaration tests; the handlers are under test here.
    withClientApiRequestContext: (handler: (...args: unknown[]) => unknown) =>
      (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth),
    getApiTokenContextForRequest: async () => hoisted.auth,
  };
});
// Who may see which session file is the session access module's question (api/agent-session-access-routes.test.ts has
// the real engine behind it); here the default caller sees every session.
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
  return {
    ...actual,
    refuseSessionLinked: vi.fn(async () => null),
    pageOfVisibleRows: async (_request: unknown, input: { start: unknown; limit: number; fetchPage: (position: unknown, size: number) => Promise<{ rows: unknown[]; after: (consumed: number) => unknown }> }) => {
      const page = await input.fetchPage(input.start, input.limit);
      return { restricted: false, rows: page.rows, next: page.after(page.rows.length) };
    },
  };
});
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
}));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkPerRequestLimits: vi.fn(async () => ({ allowed: true, effectiveLimits: {} })),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkResourceQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/services/files', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/files/fileService')>('@/lib/services/files/fileService');
  return {
    composeUploadKeyHint: actual.composeUploadKeyHint,
    createFileProvider: vi.fn(),
    deleteFile: vi.fn(),
    downloadFile: vi.fn(),
    getFileBucket: vi.fn(),
    getFileRecord: vi.fn(),
    listFileBuckets: vi.fn(),
    listFileProviders: vi.fn(),
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
  };
});

import { getDatabase } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { CircuitOpenError, RequestTimeoutError } from '@/lib/core/resilience';
import { ProviderEndpointError } from '@/lib/services/providers/providerEndpointGuard';
import { AzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import { S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { StorageInvalidKeyError } from '@/lib/providers/contracts/storageLimits';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { deleteFile, downloadFile, getFileBucket, getFileRecord, listFileBuckets, listFiles, uploadFile } from '@/lib/services/files';
import { FileServiceError, bucketInactiveError } from '@/lib/services/files/errors';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const BASE = '/api/client/v1/files/buckets/docs/objects';
const DATA = Buffer.from('hello').toString('base64');
const MIB = 1024 * 1024;

const originalConfig = getConfigSource();
function configure(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource);
}

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  configure();
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    switchToTenant: vi.fn(),
    countFileRecords: vi.fn(async () => 0),
    sumFileRecordBytes: vi.fn(async () => 0),
  } as never));
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 's3-main' });
  mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1', key: 'stored.txt' } });
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
  setConfigSource(originalConfig);
});

const upload = (payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: BASE, payload: { fileName: 'report.txt', data: DATA, ...payload } as never });
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

describe('an upload that cannot be done answers with a status, a code and a safe message', () => {
  const sdkFailure = Object.assign(
    new Error('getaddrinfo ENOTFOUND minio.internal (https://minio.internal:9000/files/t1/docs/a.txt?sig=topsecret)'),
    { code: 'ENOTFOUND' },
  );

  it.each([
    ['a bucket that does not exist: 404', () => mockFn(getFileBucket).mockRejectedValue(new FileServiceError('bucket_not_found', 404, 'File bucket not found.')), 404, { error: 'Bucket not found', code: 'bucket_not_found' }],
    ['a provider that is switched off: 409', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('provider_inactive', 409, 'File provider is not active.')), 409, { error: 'File provider is not active.', code: 'provider_inactive' }],
    ['a file over the size limit: 413', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('file_too_large', 413, 'File exceeds maximum allowed size of 50 MB (got 51 MB).')), 413, { code: 'file_too_large' }],
    ['a content type the allowlist does not accept: 415', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('content_type_not_allowed', 415, 'Content type "image/gif" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.')), 415, { code: 'content_type_not_allowed' }],
    ['a content type that is not one: 400', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('invalid_content_type', 400, 'Invalid content-type header for upload.')), 400, { error: 'Invalid content-type header for upload.', code: 'invalid_content_type' }],
    ['an open circuit breaker: 503', () => mockFn(uploadFile).mockRejectedValue(new CircuitOpenError('file-upload:tenant-1:s3-main')), 503, { code: 'storage_unavailable' }],
    ['a storage call that timed out: 504', () => mockFn(uploadFile).mockRejectedValue(new RequestTimeoutError('file-upload:tenant-1:s3-main', 30_000)), 504, { code: 'storage_timeout' }],
    ['a failure the S3 driver put into words: 502 with its message', () => mockFn(uploadFile).mockRejectedValue(new S3OperationError({ code: 'access_denied', message: 'The access key is not allowed to write to bucket "files".', statusCode: 403, retryable: false })), 502, { error: 'The access key is not allowed to write to bucket "files".', code: 'storage_failure' }],
    ['a failure the Azure driver put into words: 502 with its message', () => mockFn(uploadFile).mockRejectedValue(new AzureBlobError('The storage account key is not accepted. Check the account name and key.', { statusCode: 403, code: 'AuthenticationFailed' })), 502, { error: 'The storage account key is not accepted. Check the account name and key.', code: 'storage_failure' }],
    ['a key the S3 store refuses: 400 invalid_request with its message', () => mockFn(uploadFile).mockRejectedValue(new S3OperationError({ code: 'invalid_key', message: 'Invalid file key provided: it is longer than the store allows (Amazon S3: 1024 bytes in UTF-8, the provider prefix included).', statusCode: 400, retryable: false })), 400, { error: 'Invalid file key provided: it is longer than the store allows (Amazon S3: 1024 bytes in UTF-8, the provider prefix included).', code: 'invalid_request' }],
    ['a key the Azure driver refuses: 400 invalid_request with its message', () => mockFn(uploadFile).mockRejectedValue(new AzureBlobError('Invalid file key provided: the blob name would exceed 1024 characters or 254 path segments.', { statusCode: 400, code: 'InvalidFileKey', retryable: false })), 400, { error: 'Invalid file key provided: the blob name would exceed 1024 characters or 254 path segments.', code: 'invalid_request' }],
    ['a key the disk or GridFS driver refuses: 400 invalid_request with its message', () => mockFn(uploadFile).mockRejectedValue(new StorageInvalidKeyError('it holds a character that has no UTF-8 form (a lone surrogate).')), 400, { error: 'Invalid file key provided: it holds a character that has no UTF-8 form (a lone surrogate).', code: 'invalid_request' }],
    ['an endpoint the outbound guard refuses: 502 with its message and field', () => mockFn(uploadFile).mockRejectedValue(new ProviderEndpointError('endpoint', 'private addresses are not allowed')), 502, { code: 'storage_failure', field: 'endpoint' }],
    ['anything else from the provider: a generic 502', () => mockFn(uploadFile).mockRejectedValue(sdkFailure), 502, { error: 'The storage provider request failed.', code: 'storage_failure' }],
  ])('%s', async (_name, arrange, status, body) => {
    arrange();
    const res = await upload();
    expect(res.statusCode, res.body).toBe(status);
    expect(json(res)).toMatchObject(body);
    expect(Object.keys(json(res)).filter((key) => !['error', 'code', 'field'].includes(key))).toEqual([]);
  });

  it('keeps every detail of an unrecognised failure out of the answer (it goes to the log)', async () => {
    mockFn(uploadFile).mockRejectedValue(sdkFailure);
    const res = await upload();
    for (const leaked of ['ENOTFOUND', 'minio.internal', 'topsecret']) expect(res.body).not.toContain(leaked);
  });

  it('refuses a switched-off bucket with 409 bucket_inactive before any quota is spent or byte stored', async () => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'disabled', providerKey: 's3-main' });
    const res = await upload();
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'File bucket is not active.', code: 'bucket_inactive' });
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(checkResourceQuota).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('is a 201 with the stored file otherwise', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    expect(json(res)).toEqual({ file: { id: 'f1', key: 'stored.txt' }, message: 'File uploaded successfully' });
  });
});

describe('the quotas of an upload are those of the bucket\'s provider', () => {
  it('reads the bucket first and puts its provider key, the bucket key and the token in every quota check', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const expected = {
      domain: 'file', providerKey: 's3-main', resourceKey: 'docs', tenantDbName: 'tenant_acme', tenantId: 'tenant-1',
      projectId: 'proj-1', tokenId: 'tok-1', userId: 'user-1',
    };
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![0]).toMatchObject(expected);
    expect(mockFn(checkRateLimit).mock.calls[0]![0]).toMatchObject(expected);
    expect(mockFn(checkResourceQuota).mock.calls[0]![0]).toMatchObject(expected);
    expect(mockFn(getFileBucket).mock.invocationCallOrder[0]).toBeLessThan(mockFn(checkPerRequestLimits).mock.invocationCallOrder[0]!);
  });

  it('is the same context the Document Store builds for the same bucket', async () => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b2', key: 'docs', status: 'active', providerKey: 'azure-eu' });
    await upload();
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![0]).toMatchObject({ providerKey: 'azure-eu', resourceKey: 'docs' });
  });
});

describe('an upload past the route\'s body limit', () => {
  async function appWithLimit(maxMb: number, options: { rawJsonBody?: boolean } = {}) {
    await app.close();
    configure({ FILE_UPLOAD_MAX_MB: String(maxMb) });
    app = await createFastifyApiTestApp(clientFilesApiPlugin, options);
  }
  const base64Of = (bytes: number) => Buffer.alloc(bytes, 65).toString('base64');

  it('is a file that is too large: 413 in the API\'s own words, and nothing runs', async () => {
    await appWithLimit(1);
    const res = await upload({ data: base64Of(3 * MIB) });
    expect(res.statusCode).toBe(413);
    expect(json(res)).toEqual({ error: 'File is larger than the 1 MB upload limit.', code: 'file_too_large' });
    expect(getFileBucket).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('lets a file at the limit through', async () => {
    await appWithLimit(1);
    const res = await upload({ data: base64Of(1 * MIB) });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('answers a body that is not a JSON object as 400', async () => {
    await appWithLimit(50, { rawJsonBody: true });
    for (const raw of ['{"fileName": ', '', 'null', '7']) {
      const res = await app.inject({ method: 'POST', url: BASE, headers: { 'content-type': 'application/json' }, payload: raw });
      expect(res.statusCode, JSON.stringify(raw)).toBe(400);
      expect(json(res), JSON.stringify(raw)).toEqual({ error: 'The request body must be valid JSON.', code: 'invalid_request' });
    }
  });

  it('hands any other request error on to the server', async () => {
    const res = await app.inject({ method: 'POST', url: BASE, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'fileName=a.txt' });
    expect(res.statusCode).toBe(415);
    expect(json<{ code: string }>(res).code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
  });
});

describe('a download', () => {
  const record = { id: 'f1', key: 'report.txt', name: 'report.txt', size: 5, contentType: 'text/plain' };
  const download = (query = '') => app.inject({ method: 'GET', url: `${BASE}/report.txt/download${query}` });

  beforeEach(() => {
    mockFn(getFileRecord).mockResolvedValue(record);
    mockFn(downloadFile).mockResolvedValue({ fileName: 'report.txt', data: Buffer.from('hello'), contentType: 'text/plain', size: 5, etag: '"abc"' });
  });

  it('is an attachment, declared as the stored type, that the browser may not sniff into another', async () => {
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="report.txt"; filename*=UTF-8''report.txt`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe('5');
    expect(res.headers.etag).toBe('"abc"');
    // The body is for the token that asked: a shared cache or a proxy keeps none of it.
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.toString()).toBe('hello');
  });

  it.each([
    ['a Turkish name', 'Çalışma Planı İçin.pdf', `attachment; filename="Cal_sma Plan_ Icin.pdf"; filename*=UTF-8''%C3%87al%C4%B1%C5%9Fma%20Plan%C4%B1%20%C4%B0%C3%A7in.pdf`],
    ['a CJK name', '报告 2024年.pdf', `attachment; filename="__ 2024_.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202024%E5%B9%B4.pdf`],
    ['a name with quotes and a semicolon', 'a"b;c.txt', `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%3Bc.txt`],
  ])('keeps %s intact in filename* and readable in the fallback', async (_label, fileName, expected) => {
    mockFn(downloadFile).mockResolvedValue({ fileName, data: Buffer.from('x'), contentType: 'application/pdf', size: 1 });
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(expected);
  });

  it('cannot be used to inject a header: CR and LF in a name are dropped', async () => {
    mockFn(downloadFile).mockResolvedValue({ fileName: 'evil\r\nSet-Cookie: session=stolen.txt', data: Buffer.from('x'), contentType: 'text/plain', size: 1 });
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-disposition']).toBe(`attachment; filename="evilSet-Cookie: session=stolen.txt"; filename*=UTF-8''evilSet-Cookie%3A%20session%3Dstolen.txt`);
  });

  it('refuses a variant that is neither the original nor the Markdown copy', async () => {
    const res = await download('?variant=zip');
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'Invalid variant. Must be "original" or "markdown"' });
  });

  it.each([
    ['a file that is not there: 404', () => mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.')), 404, { error: 'File not found', code: 'file_not_found' }],
    ['an object the provider no longer has (ENOENT): 404, with no server path', () => mockFn(downloadFile).mockRejectedValue(Object.assign(new Error("ENOENT: no such file or directory, open '/srv/data/files/t1/disk/docs/report.txt'"), { code: 'ENOENT' })), 404, { error: 'File not found', code: 'file_not_found' }],
    ['an open circuit breaker: 503', () => mockFn(downloadFile).mockRejectedValue(new CircuitOpenError('file-download:tenant-1:s3-main')), 503, { code: 'storage_unavailable' }],
    ['a failure nobody recognises: a generic 502', () => mockFn(downloadFile).mockRejectedValue(new Error('read ECONNRESET from 10.4.4.4')), 502, { error: 'The storage provider request failed.', code: 'storage_failure' }],
  ])('%s', async (_name, arrange, status, body) => {
    arrange();
    const res = await download();
    expect(res.statusCode, res.body).toBe(status);
    expect(json(res)).toMatchObject(body);
    expect(res.body).not.toMatch(/\/srv|10\.4\.4\.4/);
  });

  it('answers a Markdown copy that does not exist with 400, as this API always has (the Document Store says 409)', async () => {
    mockFn(downloadFile).mockRejectedValue(new FileServiceError('markdown_unavailable', 409, 'Markdown conversion not available for this file.'));
    const res = await download('?variant=markdown');
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: 'Markdown conversion not available for this file.', code: 'markdown_unavailable' });
  });
});

describe('reading and deleting an object', () => {
  it('answers a file that is not there with 404 and the stable code', async () => {
    mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.'));
    const res = await app.inject({ method: 'GET', url: `${BASE}/gone.txt` });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found' });
  });

  it('answers a bucket that is not there with 404 and the stable code', async () => {
    mockFn(getFileBucket).mockRejectedValue(new FileServiceError('bucket_not_found', 404, 'File bucket not found.'));
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/files/buckets/gone' });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'Bucket not found', code: 'bucket_not_found' });
  });

  it('answers a delete the provider fails with a generic 502', async () => {
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.txt', name: 'a.txt' });
    mockFn(deleteFile).mockRejectedValue(new Error('socket hang up while talking to 10.9.8.7'));
    const res = await app.inject({ method: 'DELETE', url: `${BASE}/a.txt` });
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: 'The storage provider request failed.', code: 'storage_failure' });
  });

  it('answers a database failure behind a read with a plain 500', async () => {
    mockFn(listFileBuckets).mockRejectedValue(new Error('SQLITE_BUSY'));
    const res = await app.inject({ method: 'GET', url: '/api/client/v1/files/buckets' });
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: 'Internal server error', code: 'internal_error' });
  });
});

describe('a switched-off bucket is read-only here too', () => {
  beforeEach(() => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'disabled', providerKey: 's3-main' });
  });

  it('still lists, reads and downloads its files', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'f1', key: 'a.txt' }], nextCursor: undefined });
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.txt', name: 'a.txt', size: 3, contentType: 'text/plain' });
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.txt', data: Buffer.from('abc'), contentType: 'text/plain', size: 3 });

    expect((await app.inject({ method: 'GET', url: BASE })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/a.txt` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${BASE}/a.txt/download` })).statusCode).toBe(200);
  });

  it('takes nothing new and drops nothing: upload and delete answer 409 bucket_inactive', async () => {
    expect((await upload()).statusCode).toBe(409);
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.txt', name: 'a.txt' });
    mockFn(deleteFile).mockRejectedValue(bucketInactiveError());
    const deleted = await app.inject({ method: 'DELETE', url: `${BASE}/a.txt` });
    expect(deleted.statusCode).toBe(409);
    expect(json(deleted)).toEqual({ error: 'File bucket is not active.', code: 'bucket_inactive' });
  });
});
