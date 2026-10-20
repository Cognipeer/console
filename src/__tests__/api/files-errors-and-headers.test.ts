/**
 * The live Files API (`plugins/files.ts`), as the Document Store sees it:
 *
 *  - every refusal and every storage failure has a status, a stable `code` and a message that is safe to show
 *    (404 / 409 / 413 / 415 / 400 / 502 / 503 / 504), and an error nobody recognises is a generic 502 whose
 *    details only reach the log;
 *  - an upload past the route's body limit is "a file that is too large", in the API's own words;
 *  - the quotas of an upload are those of the bucket's provider (the bucket is read first);
 *  - a download is an attachment with a header-safe name and `nosniff`; a preview is inline, only for types that
 *    render without running anything, sandboxed, size-capped, and subject to the session-file rules;
 *  - the limits endpoint, the bucket and provider reads, and the objects listing's `type` filter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});
// Who may see which session file is the session access module's question (api/agent-session-access-routes.test.ts has
// the real engine behind it); here the refusal is an answer the test chooses, and the default caller sees every session.
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
    createFileBucket: vi.fn(),
    createFileProvider: vi.fn(),
    deleteFile: vi.fn(),
    deleteFileBucket: vi.fn(),
    downloadFile: vi.fn(),
    getFileBucket: vi.fn(),
    getFileRecord: vi.fn(),
    listFileBuckets: vi.fn(),
    listFiles: vi.fn(),
    updateFileBucket: vi.fn(),
    uploadFile: vi.fn(),
  };
});
vi.mock('@/lib/services/files/fileReads', () => ({
  getFileBucketDetail: vi.fn(),
  listFileBucketItems: vi.fn(),
  listFileProviderItems: vi.fn(),
}));
vi.mock('@/lib/services/files/fileLimits', () => ({ getFileLimits: vi.fn() }));
vi.mock('@/lib/services/agents/sessionFilesBucket', () => ({
  bucketInUseBody: vi.fn(),
  findAgentsUsingBucket: vi.fn(async () => []),
}));
vi.mock('@/lib/services/users/userDisplayNames', () => ({
  withUploaderNames: async (_tenantDbName: string, rows: unknown[]) => rows,
}));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { refuseSessionLinked } from '@/server/api/plugins/agent-session-access';
import { getDatabase } from '@/lib/database';
import { getConfigSource, setConfigSource, type ConfigSource } from '@/lib/core/config';
import { CircuitOpenError, RequestTimeoutError } from '@/lib/core/resilience';
import { ProviderSettingsError } from '@/lib/providers/errors';
import { AzureBlobError } from '@/lib/providers/contracts/azure/blobErrors';
import { S3OperationError } from '@/lib/providers/contracts/s3/s3Errors';
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import {
  createFileBucket,
  deleteFile,
  downloadFile,
  getFileBucket,
  getFileRecord,
  listFileBuckets,
  listFiles,
  uploadFile,
} from '@/lib/services/files';
import { getFileBucketDetail, listFileBucketItems, listFileProviderItems } from '@/lib/services/files/fileReads';
import { getFileLimits } from '@/lib/services/files/fileLimits';
import { FileServiceError, bucketInactiveError } from '@/lib/services/files/errors';
import { filesApiPlugin } from '@/server/api/plugins/files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const headers = { authorization: 'Bearer t' };
const CTX = {
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'admin' },
  userProject: { role: 'project_admin' },
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1', licenseType: 'STARTER' },
};
const DATA = Buffer.from('hello').toString('base64');
const UPLOAD_URL = '/api/files/buckets/docs/objects';
const MIB = 1024 * 1024;

const originalConfig = getConfigSource();
function configure(overrides: Record<string, string> = {}) {
  setConfigSource({ get: (key: string) => overrides[key] ?? process.env[key] } as ConfigSource);
}

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  configure();
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    switchToTenant: vi.fn(),
    countFileRecords: vi.fn(async () => 0),
    sumFileRecordBytes: vi.fn(async () => 0),
  } as never));
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 's3-main' });
  mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1', key: 'stored.txt' } });
  mockFn(refuseSessionLinked).mockResolvedValue(null);
  app = await createFastifyApiTestApp(filesApiPlugin);
});

afterEach(async () => {
  await app.close();
  setConfigSource(originalConfig);
});

const upload = (payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: UPLOAD_URL, headers, payload: { fileName: 'report.txt', data: DATA, ...payload } as never });
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);

// ── Status codes ──────────────────────────────────────────────────────────

describe('an upload that cannot be done answers with a status, a code and a safe message', () => {
  const sdkFailure = Object.assign(
    new Error('connect ECONNREFUSED 10.1.2.3:9000 (https://minio.internal:9000/files/t1/s3-main/docs/a.txt?X-Amz-Signature=abc123token)'),
    { code: 'ECONNREFUSED' },
  );

  it.each([
    ['a bucket that does not exist: 404', () => mockFn(getFileBucket).mockRejectedValue(new FileServiceError('bucket_not_found', 404, 'File bucket not found.')), 404, { error: 'Bucket not found', code: 'bucket_not_found' }],
    ['a provider that is switched off: 409', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('provider_inactive', 409, 'File provider is not active.')), 409, { error: 'File provider is not active.', code: 'provider_inactive' }],
    ['a provider the bucket lost: 409', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('provider_missing', 409, 'The storage provider "s3-main" of this bucket no longer exists.')), 409, { code: 'provider_missing' }],
    ['a file over the size limit: 413', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('file_too_large', 413, 'File exceeds maximum allowed size of 50 MB (got 51 MB).')), 413, { error: 'File exceeds maximum allowed size of 50 MB (got 51 MB).', code: 'file_too_large' }],
    ['a content type the allowlist does not accept: 415', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('content_type_not_allowed', 415, 'Content type "image/gif" is not in the FILE_UPLOAD_ALLOWED_MIME_TYPES allowlist.')), 415, { code: 'content_type_not_allowed' }],
    ['a content type that is not one: 400', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('invalid_content_type', 400, 'Invalid content-type header for upload.')), 400, { error: 'Invalid content-type header for upload.', code: 'invalid_content_type' }],
    ['a provider key that is not the bucket\'s: 400', () => mockFn(uploadFile).mockRejectedValue(new FileServiceError('provider_mismatch', 400, 'Bucket is not associated with the provided provider key.')), 400, { code: 'provider_mismatch' }],
    ['an open circuit breaker: 503, without the breaker key', () => mockFn(uploadFile).mockRejectedValue(new CircuitOpenError('file-upload:tenant-1:s3-main')), 503, { error: 'The storage provider is temporarily unavailable. Try again in a moment.', code: 'storage_unavailable' }],
    ['a storage call that timed out: 504', () => mockFn(uploadFile).mockRejectedValue(new RequestTimeoutError('file-upload:tenant-1:s3-main', 30_000)), 504, { error: 'The storage provider did not answer in time. Try again in a moment.', code: 'storage_timeout' }],
    ['a failure the S3 driver put into words: 502 with its message', () => mockFn(uploadFile).mockRejectedValue(new S3OperationError({ code: 'access_denied', message: 'The access key is not allowed to write to bucket "files".', statusCode: 403, retryable: false })), 502, { error: 'The access key is not allowed to write to bucket "files".', code: 'storage_failure' }],
    ['a failure the Azure driver put into words: 502 with its message', () => mockFn(uploadFile).mockRejectedValue(new AzureBlobError('The storage account key is not accepted. Check the account name and key.', { statusCode: 403, code: 'AuthenticationFailed' })), 502, { error: 'The storage account key is not accepted. Check the account name and key.', code: 'storage_failure' }],
    ['a setting the console refuses: 502 with its message and field', () => mockFn(uploadFile).mockRejectedValue(new ProviderSettingsError('endpoint', 'Endpoint must start with http:// or https://.')), 502, { error: 'Endpoint must start with http:// or https://.', code: 'storage_failure', field: 'endpoint' }],
    ['anything else from the provider: a generic 502', () => mockFn(uploadFile).mockRejectedValue(sdkFailure), 502, { error: 'The storage provider request failed.', code: 'storage_failure' }],
  ])('%s', async (_name, arrange, status, body) => {
    arrange();
    const res = await upload();
    expect(res.statusCode, res.body).toBe(status);
    expect(json(res)).toMatchObject(body);
    // Nothing but the message and the stable code (and the form field of a setting) travels.
    expect(Object.keys(json(res)).filter((key) => !['error', 'code', 'field'].includes(key))).toEqual([]);
  });

  it('keeps every detail of an unrecognised failure out of the answer (it goes to the log)', async () => {
    mockFn(uploadFile).mockRejectedValue(sdkFailure);
    const res = await upload();
    expect(res.statusCode).toBe(502);
    for (const leaked of ['ECONNREFUSED', '10.1.2.3', 'minio.internal', 'X-Amz-Signature', 'abc123token']) {
      expect(res.body).not.toContain(leaked);
    }
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

  it('refuses a missing file name and data as 400 (as it always did)', async () => {
    const noName = await app.inject({ method: 'POST', url: UPLOAD_URL, headers, payload: { data: DATA } as never });
    expect(noName.statusCode).toBe(400);
    expect(json(noName)).toEqual({ error: 'fileName is required' });
    const noData = await app.inject({ method: 'POST', url: UPLOAD_URL, headers, payload: { fileName: 'a.txt' } as never });
    expect(noData.statusCode).toBe(400);
    expect(json(noData)).toEqual({ error: 'data is required' });
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('answers 429 for a quota the guard refuses, as before', async () => {
    mockFn(checkPerRequestLimits).mockResolvedValueOnce({ allowed: false, reason: 'File size (10 bytes) exceeds limit (5 bytes)', effectiveLimits: {} });
    const res = await upload();
    expect(res.statusCode).toBe(429);
    expect(json(res)).toEqual({ error: 'File size (10 bytes) exceeds limit (5 bytes)' });
  });

  it('hands a blank content type to the service, which drops it before validating (unit/file-upload-flow.test.ts)', async () => {
    for (const contentType of ['', '   ']) {
      mockFn(uploadFile).mockClear();
      const res = await upload({ contentType });
      expect(res.statusCode).toBe(201);
      expect(mockFn(uploadFile).mock.calls[0]![3]).toMatchObject({ contentType });
    }
  });
});

describe('the quotas of an upload are those of the bucket\'s provider', () => {
  it('reads the bucket first and puts its provider key and the bucket key in every quota check', async () => {
    const res = await upload();
    expect(res.statusCode).toBe(201);
    const expected = { domain: 'file', providerKey: 's3-main', resourceKey: 'docs', tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' };
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![0]).toMatchObject(expected);
    expect(mockFn(checkRateLimit).mock.calls[0]![0]).toMatchObject(expected);
    expect(mockFn(checkResourceQuota).mock.calls[0]![0]).toMatchObject(expected);
    const bucketRead = mockFn(getFileBucket).mock.invocationCallOrder[0]!;
    expect(bucketRead).toBeLessThan(mockFn(checkPerRequestLimits).mock.invocationCallOrder[0]!);
  });

  it('takes the provider from the bucket, not from the request body', async () => {
    await upload({ providerKey: 'some-other-provider' });
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![0]).toMatchObject({ providerKey: 's3-main' });
    // The body\'s provider key still goes to the service, which refuses a mismatch (400 provider_mismatch).
    expect(mockFn(uploadFile).mock.calls[0]![3]).toMatchObject({ providerKey: 'some-other-provider' });
  });

  it('measures the file from its base64 data', async () => {
    const data = Buffer.alloc(3000, 1).toString('base64');
    await upload({ data });
    expect(mockFn(checkPerRequestLimits).mock.calls[0]![1]).toEqual({ fileSize: 3000, filesPerRequest: 1 });
  });
});

// ── The body limit ────────────────────────────────────────────────────────

describe('an upload past the route\'s body limit', () => {
  /** An app registered after the file limit is set: the route reads the limit when it is registered. */
  async function appWithLimit(maxMb: number, options: { rawJsonBody?: boolean } = {}) {
    await app.close();
    configure({ FILE_UPLOAD_MAX_MB: String(maxMb) });
    app = await createFastifyApiTestApp(filesApiPlugin, options);
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

  it('names the configured limit', async () => {
    await appWithLimit(2);
    const res = await upload({ data: base64Of(4 * MIB) });
    expect(res.statusCode).toBe(413);
    expect(json<{ error: string }>(res).error).toBe('File is larger than the 2 MB upload limit.');
  });

  it('lets a file at the limit through: the body limit allows for base64 and the JSON around the data', async () => {
    await appWithLimit(1);
    const res = await upload({ data: base64Of(1 * MIB), fileName: 'exactly-one-mb.bin' });
    expect(res.statusCode, res.body).toBe(201);
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('raises the server\'s default body limit for this route only', async () => {
    await appWithLimit(5);
    // 2 MiB of file is 2.7 MiB of body: past Fastify\'s default limit (1 MiB), under this route\'s.
    expect((await upload({ data: base64Of(2 * MIB) })).statusCode).toBe(201);
    // Any other route keeps the server\'s own limit and its own 413.
    const other = await app.inject({ method: 'POST', url: '/api/files/buckets', headers, payload: { key: 'b', name: 'B', providerKey: 'p', description: 'x'.repeat(2 * MIB) } as never });
    expect(other.statusCode).toBe(413);
    expect(json<{ code: string }>(other).code).not.toBe('file_too_large');
  });

  it('hands any other request error on to the server: a wrong media type is not "too large"', async () => {
    const res = await app.inject({ method: 'POST', url: UPLOAD_URL, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'fileName=a.txt' });
    expect(res.statusCode).toBe(415);
    expect(json<{ code: string }>(res).code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
  });

  it('answers a body that is not JSON as 400 (the production parser hands the route the raw text)', async () => {
    await appWithLimit(50, { rawJsonBody: true });
    for (const raw of ['{"fileName": "a.txt", ', '', 'null', '"just text"', '42']) {
      const res = await app.inject({ method: 'POST', url: UPLOAD_URL, headers: { ...headers, 'content-type': 'application/json' }, payload: raw });
      expect(res.statusCode, JSON.stringify(raw)).toBe(400);
      expect(json(res), JSON.stringify(raw)).toEqual({ error: 'The request body must be valid JSON.', code: 'invalid_request' });
    }
    // A list is JSON but names no file: the same 400 as any upload without a file name.
    const list = await app.inject({ method: 'POST', url: UPLOAD_URL, headers: { ...headers, 'content-type': 'application/json' }, payload: '[1, 2]' });
    expect(list.statusCode).toBe(400);
    expect(json(list)).toEqual({ error: 'fileName is required' });
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

// ── Other writes ──────────────────────────────────────────────────────────

describe('a delete or a bucket create that cannot be done', () => {
  it('answers 409 bucket_inactive for a file in a switched-off bucket', async () => {
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.txt', name: 'a.txt' });
    mockFn(deleteFile).mockRejectedValue(bucketInactiveError());
    const res = await app.inject({ method: 'DELETE', url: `${UPLOAD_URL}/a.txt`, headers });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'File bucket is not active.', code: 'bucket_inactive' });
  });

  it('answers 404 for a file that is not there', async () => {
    mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.'));
    const res = await app.inject({ method: 'DELETE', url: `${UPLOAD_URL}/gone.txt`, headers });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'File not found', code: 'file_not_found' });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('answers a generic 502 when the provider fails to delete', async () => {
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.txt', name: 'a.txt' });
    mockFn(deleteFile).mockRejectedValue(new Error('socket hang up while talking to 10.9.8.7'));
    const res = await app.inject({ method: 'DELETE', url: `${UPLOAD_URL}/a.txt`, headers });
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: 'The storage provider request failed.', code: 'storage_failure' });
  });

  it('answers 409 for a bucket key that is taken', async () => {
    mockFn(listFileBuckets).mockResolvedValue([]);
    mockFn(createFileBucket).mockRejectedValue(new FileServiceError('duplicate_key', 409, 'Bucket with key "docs" already exists.'));
    const res = await app.inject({ method: 'POST', url: '/api/files/buckets', headers, payload: { key: 'docs', name: 'Docs', providerKey: 's3-main' } as never });
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'Bucket with key "docs" already exists.', code: 'duplicate_key' });
  });
});

// ── Downloads ─────────────────────────────────────────────────────────────

describe('a download', () => {
  const record = { id: 'f1', key: 'reports/a.pdf', name: 'a.pdf', size: 5, contentType: 'application/pdf' };
  const download = (query = 'download=1') => app.inject({ method: 'GET', url: `${UPLOAD_URL}/reports/a.pdf?${query}`, headers });

  beforeEach(() => {
    mockFn(getFileRecord).mockResolvedValue(record);
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.pdf', data: Buffer.from('%PDF-'), contentType: 'application/pdf' });
  });

  it('is an attachment, declared as the stored type, that the browser may not sniff into another', async () => {
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-length']).toBe('5');
    expect(res.rawPayload.toString()).toBe('%PDF-');
  });

  it('serves a file of unknown type as opaque bytes', async () => {
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.bin', data: Buffer.from('x'), contentType: undefined });
    expect((await download()).headers['content-type']).toBe('application/octet-stream');
  });

  it.each([
    ['a Turkish name', 'Çalışma Planı İçin.pdf', `attachment; filename="Cal_sma Plan_ Icin.pdf"; filename*=UTF-8''%C3%87al%C4%B1%C5%9Fma%20Plan%C4%B1%20%C4%B0%C3%A7in.pdf`],
    ['a CJK name', '报告 2024年.pdf', `attachment; filename="__ 2024_.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%202024%E5%B9%B4.pdf`],
    ['a name with quotes and a semicolon', 'a"b;c.txt', `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%3Bc.txt`],
  ])('keeps %s intact in filename* and readable in the fallback', async (_label, fileName, expected) => {
    mockFn(downloadFile).mockResolvedValue({ fileName, data: Buffer.from('x'), contentType: 'application/pdf' });
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(expected);
  });

  it('cannot be used to inject a header: CR and LF in a name are dropped', async () => {
    mockFn(downloadFile).mockResolvedValue({ fileName: 'evil\r\nSet-Cookie: session=stolen.txt', data: Buffer.from('x'), contentType: 'text/plain' });
    const res = await download();
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['content-disposition']).toBe(`attachment; filename="evilSet-Cookie: session=stolen.txt"; filename*=UTF-8''evilSet-Cookie%3A%20session%3Dstolen.txt`);
    expect(String(res.headers['content-disposition'])).not.toMatch(/[\r\n]/);
  });

  it('asks the service for the Markdown copy when told to, and names it .md', async () => {
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.md', data: Buffer.from('# a'), contentType: 'text/markdown' });
    const res = await download('download=markdown');
    expect(res.statusCode).toBe(200);
    expect(mockFn(downloadFile).mock.calls[0]![5]).toEqual({ variant: 'markdown' });
    expect(res.headers['content-disposition']).toContain('filename="a.md"');
  });

  it.each([
    ['a file that is not there: 404', () => mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.')), 404, { error: 'File not found', code: 'file_not_found' }],
    ['an object the provider no longer has (ENOENT): 404, with no server path', () => mockFn(downloadFile).mockRejectedValue(Object.assign(new Error("ENOENT: no such file or directory, open '/srv/data/files/t1/disk/docs/a.pdf'"), { code: 'ENOENT' })), 404, { error: 'File not found', code: 'file_not_found' }],
    ['a Markdown copy that does not exist: 409', () => mockFn(downloadFile).mockRejectedValue(new FileServiceError('markdown_unavailable', 409, 'Markdown conversion not available for this file.')), 409, { error: 'Markdown conversion not available for this file.', code: 'markdown_unavailable' }],
    ['an open circuit breaker: 503', () => mockFn(downloadFile).mockRejectedValue(new CircuitOpenError('file-download:tenant-1:s3-main')), 503, { code: 'storage_unavailable' }],
    ['a failure nobody recognises: a generic 502', () => mockFn(downloadFile).mockRejectedValue(new Error('read ECONNRESET from 10.4.4.4')), 502, { error: 'The storage provider request failed.', code: 'storage_failure' }],
  ])('%s', async (_name, arrange, status, body) => {
    arrange();
    const res = await download();
    expect(res.statusCode, res.body).toBe(status);
    expect(json(res)).toMatchObject(body);
    expect(res.body).not.toMatch(/\/srv|10\.4\.4\.4/);
  });
});

// ── Previews ──────────────────────────────────────────────────────────────

describe('a preview', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const recordOf = (over: Record<string, unknown> = {}) => ({ id: 'f1', key: 'pics/logo.png', name: 'logo.png', size: PNG.length, contentType: 'image/png', ...over });
  const preview = (query = 'preview=1', key = 'pics/logo.png') => app.inject({ method: 'GET', url: `${UPLOAD_URL}/${key}?${query}`, headers });

  beforeEach(() => {
    mockFn(getFileRecord).mockResolvedValue(recordOf());
    mockFn(downloadFile).mockResolvedValue({ fileName: 'logo.png', data: PNG, contentType: 'image/png' });
  });

  it('is inline, inert and uncached: the type as stored, nosniff, a sandbox, no shared cache', async () => {
    const res = await preview();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe(`inline; filename="logo.png"; filename*=UTF-8''logo.png`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-length']).toBe(String(PNG.length));
    expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
    expect(mockFn(downloadFile).mock.calls[0]![5]).toEqual({ variant: 'original' });
  });

  it('also reads preview=true', async () => {
    expect((await preview('preview=true')).statusCode).toBe(200);
  });

  it('wins over download: asking for both is a preview', async () => {
    const res = await preview('download=1&preview=1');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
  });

  it('shows a PDF as a PDF', async () => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'a.pdf', name: 'a.pdf', contentType: 'application/pdf' }));
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.pdf', data: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' });
    const res = await preview('preview=1', 'a.pdf');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
  });

  it.each([
    ['text/plain'],
    ['text/markdown'],
    ['text/csv'],
    ['application/json'],
    ['text/plain; charset=iso-8859-9'],
  ])('shows %s as plain text, never as itself', async (contentType) => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'n.txt', name: 'n.txt', contentType }));
    mockFn(downloadFile).mockResolvedValue({ fileName: 'n.txt', data: Buffer.from('<b>text</b>'), contentType });
    const res = await preview('preview=1', 'n.txt');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-security-policy']).toBe('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it.each([
    ['image/svg+xml'],
    ['text/html'],
    ['application/xhtml+xml'],
    ['text/xml'],
    ['application/javascript'],
    ['application/octet-stream'],
    ['application/zip'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    [undefined],
  ])('refuses %s (415 preview_unsupported) without reading a byte', async (contentType) => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'x.bin', name: 'x.bin', contentType }));
    const res = await preview('preview=1', 'x.bin');
    expect(res.statusCode).toBe(415);
    expect(json(res)).toEqual({ error: 'This file type cannot be previewed. Download it instead.', code: 'preview_unsupported', reason: 'unsupported_type' });
    expect(downloadFile).not.toHaveBeenCalled();
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('refuses a file over 10 MB by its record, without reading a byte', async () => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ size: 10 * MIB + 1 }));
    const res = await preview();
    expect(res.statusCode).toBe(415);
    expect(json(res)).toMatchObject({ code: 'preview_unsupported', reason: 'too_large' });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it('accepts a file of exactly 10 MB', async () => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ size: 10 * MIB }));
    expect((await preview()).statusCode).toBe(200);
  });

  it('refuses by the bytes it read when the record understates them', async () => {
    mockFn(getFileRecord).mockResolvedValue(recordOf({ size: 10 }));
    mockFn(downloadFile).mockResolvedValue({ fileName: 'logo.png', data: Buffer.alloc(10 * MIB + 1), contentType: 'image/png' });
    const res = await preview();
    expect(res.statusCode).toBe(415);
    expect(json(res)).toMatchObject({ code: 'preview_unsupported', reason: 'too_large' });
  });

  describe('of the Markdown copy', () => {
    beforeEach(() => {
      mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'a.pdf', name: 'a.pdf', contentType: 'application/pdf', size: 50 * MIB, markdownKey: 'a.md', markdownSize: 12 }));
      mockFn(downloadFile).mockResolvedValue({ fileName: 'a.md', data: Buffer.from('# Heading'), contentType: 'text/markdown' });
    });

    it('is plain text whatever the original is, and is sized by the copy, not the original', async () => {
      const res = await preview('variant=markdown&preview=1', 'a.pdf');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(`inline; filename="a.md"; filename*=UTF-8''a.md`);
      expect(res.headers['content-security-policy']).toBe('sandbox');
      expect(mockFn(downloadFile).mock.calls[0]![5]).toEqual({ variant: 'markdown' });
    });

    it('also reads download=markdown with preview', async () => {
      const res = await preview('download=markdown&preview=1', 'a.pdf');
      expect(res.statusCode).toBe(200);
      expect(mockFn(downloadFile).mock.calls[0]![5]).toEqual({ variant: 'markdown' });
    });

    it('is refused when the copy itself is over 10 MB', async () => {
      mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'a.pdf', contentType: 'application/pdf', markdownKey: 'a.md', markdownSize: 10 * MIB + 1 }));
      const res = await preview('variant=markdown&preview=1', 'a.pdf');
      expect(res.statusCode).toBe(415);
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it('is a 409 when the file has none', async () => {
      mockFn(getFileRecord).mockResolvedValue(recordOf({ key: 'a.pdf', contentType: 'application/pdf' }));
      mockFn(downloadFile).mockRejectedValue(new FileServiceError('markdown_unavailable', 409, 'Markdown conversion not available for this file.'));
      const res = await preview('variant=markdown&preview=1', 'a.pdf');
      expect(res.statusCode).toBe(409);
      expect(json(res)).toMatchObject({ code: 'markdown_unavailable' });
    });
  });

  it('names a file safely in the inline disposition too', async () => {
    mockFn(downloadFile).mockResolvedValue({ fileName: 'Çalışma\r\nX-Evil: 1.png', data: PNG, contentType: 'image/png' });
    const res = await preview();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-evil']).toBeUndefined();
    expect(res.headers['content-disposition']).toBe(`inline; filename="Cal_smaX-Evil: 1.png"; filename*=UTF-8''%C3%87al%C4%B1%C5%9FmaX-Evil%3A%201.png`);
  });

  it('is a 404 for a file that is not there, and a generic 502 for a provider that fails', async () => {
    mockFn(getFileRecord).mockRejectedValue(new FileServiceError('file_not_found', 404, 'File record not found.'));
    expect((await preview()).statusCode).toBe(404);
    mockFn(getFileRecord).mockResolvedValue(recordOf());
    mockFn(downloadFile).mockRejectedValue(new Error('boom at https://storage.internal/secret?sig=1'));
    const failed = await preview();
    expect(failed.statusCode).toBe(502);
    expect(json(failed)).toEqual({ error: 'The storage provider request failed.', code: 'storage_failure' });
  });

  describe('of a file a session holds', () => {
    const sessionRecord = recordOf({ key: 'agent-sessions/support/s1/pic.png', purpose: 'conversation', conversationId: 'conv-1', agentKey: 'support' });
    const refusal = { ok: false, status: 403, reason: 'forbidden', need: 'view' } as const;

    it('is asked as the session it belongs to, for every way of reading the file', async () => {
      mockFn(getFileRecord).mockResolvedValue(sessionRecord);
      for (const query of ['preview=1', 'download=1', 'preview=1&variant=markdown', '']) {
        mockFn(refuseSessionLinked).mockClear();
        await app.inject({ method: 'GET', url: `${UPLOAD_URL}/agent-sessions/support/s1/pic.png?${query}`, headers });
        expect(refuseSessionLinked, query).toHaveBeenCalledTimes(1);
        expect(mockFn(refuseSessionLinked).mock.calls[0]!.slice(1), query).toEqual(['conv-1', 'view']);
      }
    });

    it('is refused to a caller who may not view that session: no bytes are read', async () => {
      mockFn(getFileRecord).mockResolvedValue(sessionRecord);
      mockFn(refuseSessionLinked).mockResolvedValue(refusal);
      for (const query of ['preview=1', 'preview=1&variant=markdown', 'download=1', '']) {
        const res = await app.inject({ method: 'GET', url: `${UPLOAD_URL}/agent-sessions/support/s1/pic.png?${query}`, headers });
        expect(res.statusCode, query).toBe(403);
        expect(res.headers['content-disposition'], query).toBeUndefined();
      }
      expect(downloadFile).not.toHaveBeenCalled();
    });

    it('is shown to a caller who may', async () => {
      mockFn(getFileRecord).mockResolvedValue(sessionRecord);
      const res = await app.inject({ method: 'GET', url: `${UPLOAD_URL}/agent-sessions/support/s1/pic.png?preview=1`, headers });
      expect(res.statusCode).toBe(200);
    });

    it('does not ask the session question about an ordinary file', async () => {
      await preview();
      expect(mockFn(refuseSessionLinked).mock.calls[0]![1]).toBeNull();
    });
  });
});

// ── A switched-off bucket is read-only ────────────────────────────────────

describe('a switched-off bucket still gives its files back', () => {
  it('lists, reads, downloads and previews without asking whether the bucket is active', async () => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'disabled', providerKey: 's3-main' });
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'f1', key: 'a.png' }], nextCursor: undefined });
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.png', name: 'a.png', size: 3, contentType: 'image/png' });
    mockFn(downloadFile).mockResolvedValue({ fileName: 'a.png', data: Buffer.from('abc'), contentType: 'image/png' });

    expect((await app.inject({ method: 'GET', url: UPLOAD_URL, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${UPLOAD_URL}/a.png`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${UPLOAD_URL}/a.png?download=1`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${UPLOAD_URL}/a.png?preview=1`, headers })).statusCode).toBe(200);
    expect(getFileBucket).not.toHaveBeenCalled();
  });

  it('takes nothing new and drops nothing: upload and delete answer 409 bucket_inactive', async () => {
    mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'disabled', providerKey: 's3-main' });
    expect((await upload()).statusCode).toBe(409);
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'a.png', name: 'a.png' });
    mockFn(deleteFile).mockRejectedValue(bucketInactiveError());
    const deleted = await app.inject({ method: 'DELETE', url: `${UPLOAD_URL}/a.png`, headers });
    expect(deleted.statusCode).toBe(409);
    expect(json<{ code: string }>(deleted).code).toBe('bucket_inactive');
  });
});

// ── Reads ─────────────────────────────────────────────────────────────────

describe('GET /files/limits', () => {
  const limits = {
    maxFileBytes: 50 * MIB,
    maxRequestBytes: 70_000_000,
    allowedMimeTypes: null,
    quota: { usedBytes: 10, limitBytes: null, filesUsed: 2, filesLimit: 100 },
  };

  it('answers what an upload may be and how much room is left', async () => {
    mockFn(getFileLimits).mockResolvedValue(limits);
    const res = await app.inject({ method: 'GET', url: '/api/files/limits', headers });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual(limits);
    expect(getFileLimits).toHaveBeenCalledWith({ tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', userId: 'user-1' });
  });

  it('resolves the quota of a bucket when asked about one', async () => {
    mockFn(getFileLimits).mockResolvedValue(limits);
    await app.inject({ method: 'GET', url: '/api/files/limits?bucketKey=docs', headers });
    expect(getFileLimits).toHaveBeenCalledWith(expect.objectContaining({ bucketKey: 'docs' }));
  });

  it('is a 404 for a bucket that does not exist', async () => {
    mockFn(getFileLimits).mockRejectedValue(new FileServiceError('bucket_not_found', 404, 'File bucket not found.'));
    const res = await app.inject({ method: 'GET', url: '/api/files/limits?bucketKey=gone', headers });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'Bucket not found', code: 'bucket_not_found' });
  });

  it('only reads: it spends no quota', async () => {
    mockFn(getFileLimits).mockResolvedValue(limits);
    await app.inject({ method: 'GET', url: '/api/files/limits', headers });
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(checkResourceQuota).not.toHaveBeenCalled();
  });

  it('is a read: nothing else is routed there', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/files/limits', headers, payload: {} as never });
    expect(res.statusCode).toBe(404);
  });
});

describe('bucket and provider reads', () => {
  it('GET /files/buckets answers the list with numbers and health', async () => {
    const buckets = [{ id: 'b1', key: 'docs', stats: { fileCount: 3, totalBytes: 30 }, providerHealth: { state: 'ok' } }];
    mockFn(listFileBucketItems).mockResolvedValue(buckets);
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets', headers });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ buckets });
    expect(listFileBucketItems).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1');
  });

  it('GET /files/buckets/:bucketKey answers one bucket with who uses it and where its files are', async () => {
    const bucket = { id: 'b1', key: 'docs', usedBy: [{ agentId: 'a1', agentKey: 'support', name: 'Support' }], storageLocation: 's3://files/t1/s3-main/docs/' };
    mockFn(getFileBucketDetail).mockResolvedValue(bucket);
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/docs', headers });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ bucket });
    expect(getFileBucketDetail).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', 'docs');
  });

  it('GET /files/buckets/:bucketKey is a 404 for a bucket that does not exist', async () => {
    mockFn(getFileBucketDetail).mockRejectedValue(new FileServiceError('bucket_not_found', 404, 'File bucket not found.'));
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets/gone', headers });
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: 'Bucket not found', code: 'bucket_not_found' });
  });

  it('GET /files/providers answers each provider with its health and storage location base, and passes the filters on', async () => {
    const providers = [{ id: 'p1', key: 's3-main', providerHealth: { state: 'untested' }, storageLocationBase: 's3://files/t1/s3-main/' }];
    mockFn(listFileProviderItems).mockResolvedValue(providers);
    const res = await app.inject({ method: 'GET', url: '/api/files/providers?driver=aws-s3-files&status=active', headers });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ providers });
    expect(listFileProviderItems).toHaveBeenCalledWith('tenant_acme', 'tenant-1', 'proj-1', { driver: 'aws-s3-files', status: 'active' });
  });

  it('a read that fails inside the database is a plain 500, not a storage failure', async () => {
    mockFn(listFileBucketItems).mockRejectedValue(new Error('SQLITE_BUSY'));
    const res = await app.inject({ method: 'GET', url: '/api/files/buckets', headers });
    expect(res.statusCode).toBe(500);
    expect(json(res)).toEqual({ error: 'Internal server error', code: 'internal_error' });
  });
});

describe('the objects listing\'s type filter', () => {
  beforeEach(() => {
    mockFn(listFiles).mockResolvedValue({ items: [], nextCursor: undefined });
  });
  const list = (query: string) => app.inject({ method: 'GET', url: `${UPLOAD_URL}?${query}`, headers });
  const requestOf = () => mockFn(listFiles).mock.calls.at(-1)![3] as Record<string, unknown>;

  it.each(['pdf', 'image', 'text', 'office', 'other'])('passes %s on to the listing', async (type) => {
    expect((await list(`type=${type}`)).statusCode).toBe(200);
    expect(requestOf()).toMatchObject({ bucketKey: 'docs', type });
  });

  it.each(['', 'video', 'PDF', 'all', 'pdf,image'])('ignores %j: the listing stays unfiltered', async (type) => {
    expect((await list(`type=${encodeURIComponent(type)}`)).statusCode).toBe(200);
    expect(requestOf()).not.toHaveProperty('type');
  });

  it('composes with the other parameters of the listing', async () => {
    await list('type=pdf&prefix=reports%2F&search=q1&purpose=other&limit=20');
    expect(requestOf()).toMatchObject({ type: 'pdf', prefix: 'reports/', search: 'q1', purpose: 'other', limit: 20 });
  });

  it('answers a flat page: no folders', async () => {
    mockFn(listFiles).mockResolvedValue({ items: [{ id: 'f1', key: 'a/b.pdf' }], nextCursor: 'c2' });
    const res = await list('type=pdf');
    expect(json(res)).toEqual({ items: [{ id: 'f1', key: 'a/b.pdf' }], nextCursor: 'c2' });
  });
});
