/**
 * The client Files API (`plugins/client-files.ts`):
 *  - an upload's `keyHint` follows the Document Store's destination rules (no "." / ".." segments, no control
 *    characters, text of at most 512 characters) and an invalid one is a 400 before any quota is spent;
 *  - `X-File-Metadata` is ASCII-escaped JSON, so metadata in any language downloads instead of failing the response;
 *    it is the metadata the file was stored with (the record's), whatever spelling the store keeps on the object, and
 *    a value too large for a response header is left out of it.
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
    chooseRelativeFileKey: actual.chooseRelativeFileKey,
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
import { checkPerRequestLimits, checkRateLimit, checkResourceQuota } from '@/lib/quota/quotaGuard';
import { downloadFile, getFileBucket, getFileRecord, uploadFile } from '@/lib/services/files';
import { clientFilesApiPlugin } from '@/server/api/plugins/client-files';
import { createMockDb } from '../helpers/db.mock';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const UPLOAD_URL = '/api/client/v1/files/buckets/docs/objects';
const DOWNLOAD_URL = '/api/client/v1/files/buckets/docs/objects/report.txt/download';
const DATA = Buffer.from('hello').toString('base64');

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFn(getDatabase).mockResolvedValue(createMockDb({
    switchToTenant: vi.fn(),
    countFileRecords: vi.fn(async () => 0),
    sumFileRecordBytes: vi.fn(async () => 0),
  } as never));
  mockFn(getFileBucket).mockResolvedValue({ id: 'b1', key: 'docs', status: 'active', providerKey: 'disk' });
  mockFn(uploadFile).mockResolvedValue({ record: { id: 'f1', key: 'stored.txt' } });
  app = await createFastifyApiTestApp(clientFilesApiPlugin);
});

afterEach(async () => {
  await app.close();
});

const upload = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: UPLOAD_URL, payload: { fileName: 'report.txt', data: DATA, ...payload } as never });

describe('upload keyHint', () => {
  it.each([
    ['no hint', {}, undefined],
    ['a null hint', { keyHint: null }, undefined],
    ['an empty hint', { keyHint: '' }, undefined],
    ['a plain name', { keyHint: 'report.pdf' }, 'report.pdf'],
    ['a path', { keyHint: 'reports/2024/q1.pdf' }, 'reports/2024/q1.pdf'],
    ['a folder (the file gets a generated name in it)', { keyHint: 'reports/2024/' }, 'reports/2024/'],
    ['text with surrounding space and doubled slashes', { keyHint: '  a//b  ' }, 'a/b'],
    ['backslashes, read as slashes', { keyHint: 'a\\b' }, 'a/b'],
    ['names in any language', { keyHint: 'raporlar/Şirket Bütçesi 報告書.pdf' }, 'raporlar/Şirket Bütçesi 報告書.pdf'],
    ['the longest hint', { keyHint: 'k'.repeat(512) }, 'k'.repeat(512)],
  ])('accepts %s', async (_name, payload, expected) => {
    const res = await upload(payload);
    expect(res.statusCode).toBe(201);
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const input = mockFn(uploadFile).mock.calls[0]![3] as { keyHint?: string };
    expect(input.keyHint).toBe(expected);
  });

  it.each([
    ['.. alone', '..'],
    ['a leading ..', '../x'],
    ['a .. in the middle', 'a/../b'],
    ['a leading ./', './x'],
    ['a . in the middle', 'a/./b'],
    ['. alone', '.'],
    ['a climb written with backslashes', '..\\secret'],
    ['a climb in the middle written with backslashes', 'a\\..\\b'],
  ])('refuses %s (400), before anything is stored or any quota is spent', async (_name, keyHint) => {
    const res = await upload({ keyHint });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('keyHint cannot contain "." or ".." segments.');
    expect(uploadFile).not.toHaveBeenCalled();
    expect(checkPerRequestLimits).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(checkResourceQuota).not.toHaveBeenCalled();
  });

  it.each([
    ['a NUL', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a tab', 'a\tb'],
    ['a unit separator', 'a\u001fb'],
  ])('refuses %s (400)', async (_name, keyHint) => {
    const res = await upload({ keyHint });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('keyHint cannot contain control characters.');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a number', 5],
    ['zero', 0],
    ['a boolean', true],
    ['an object', { path: 'a' }],
    ['a list', ['a']],
  ])('refuses %s (400): the hint is text', async (_name, keyHint) => {
    const res = await upload({ keyHint });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('keyHint must be text.');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a hint of more than 512 characters (400)', async () => {
    const res = await upload({ keyHint: 'k'.repeat(513) });
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>(res.body).error).toBe('keyHint must be at most 512 characters.');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('still asks for a file name and data first', async () => {
    const noName = await app.inject({ method: 'POST', url: UPLOAD_URL, payload: { data: DATA, keyHint: '..' } as never });
    expect(parseJsonBody<{ error: string }>(noName.body).error).toBe('fileName is required');
    const noData = await app.inject({ method: 'POST', url: UPLOAD_URL, payload: { fileName: 'a.txt', keyHint: '..' } as never });
    expect(parseJsonBody<{ error: string }>(noData.body).error).toBe('data is required (base64 or data URL)');
  });
});

describe('X-File-Metadata on download', () => {
  /** `stored`: the metadata of the file's record; `fromStore`: what the driver read back from the object (its own spelling). */
  const download = (stored: unknown, fromStore: unknown = stored) => {
    mockFn(getFileRecord).mockResolvedValue({ id: 'f1', key: 'report.txt', metadata: stored });
    mockFn(downloadFile).mockResolvedValue({
      data: Buffer.from('hello'),
      contentType: 'text/plain',
      size: 5,
      fileName: 'şirket bütçesi.txt',
      etag: '"abc"',
      metadata: fromStore,
    });
    return app.inject({ method: 'GET', url: DOWNLOAD_URL });
  };

  it('plain ASCII metadata is the JSON it always was', async () => {
    const metadata = { checksum: 'abc123', originalName: 'report.txt', team: 'finance' };
    const res = await download(metadata);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-file-metadata']).toBe(JSON.stringify(metadata));
    expect(res.body).toBe('hello');
  });

  it.each([
    ['Turkish letters', { originalName: 'şirket bütçesi İçin.pdf', owner: 'Çağrı Öğütçü', note: 'ığİş' }],
    ['CJK text', { originalName: '報告書.pdf', owner: '山田太郎', cn: '报告书' }],
    ['an emoji', { originalName: 'party 🎉.txt', mood: '👍🏽', flag: '🇹🇷' }],
    ['all of them, nested', { names: ['şğıİ', '日本語', '😀'], deep: { 'Müşteri Adı': { değer: '€ 10' } } }],
  ])('metadata with %s downloads, and the header parses back to the original', async (_name, metadata) => {
    const res = await download(metadata);
    expect(res.statusCode).toBe(200);
    const header = res.headers['x-file-metadata'];
    expect(typeof header).toBe('string');
    expect(header as string).toMatch(/^[ -~]*$/);
    expect(JSON.parse(header as string)).toEqual(metadata);
    expect(res.body).toBe('hello');
  });

  it('a file without metadata has no header, and metadata that cannot be serialized does not fail the download', async () => {
    expect((await download(undefined)).headers['x-file-metadata']).toBeUndefined();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const res = await download(circular);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-file-metadata']).toBeUndefined();
    expect(res.body).toBe('hello');
  });

  it('is the metadata the file was stored with, not the store\'s own spelling of it', async () => {
    // S3 keeps names in lower case and re-encodes the values, and adds a checksum of its own to the object.
    const stored = { Team: 'Finance', Owner: 'Çağrı Öğütçü', 'Cost Centre': '42' };
    const spelledByTheStore = { team: 'Finance', owner: '=?UTF-8?B?w4dhxJ9ybMSx?=', 'cost-centre': '42', 'x-amz-checksum': 'abc' };
    const res = await download(stored, spelledByTheStore);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.headers['x-file-metadata'] as string)).toEqual(stored);
  });

  it('is the same whether or not the driver reads metadata back from the object', async () => {
    const stored = { team: 'finance' };
    expect(JSON.parse((await download(stored, undefined)).headers['x-file-metadata'] as string)).toEqual(stored);
    expect(JSON.parse((await download(stored, {})).headers['x-file-metadata'] as string)).toEqual(stored);
  });

  it('has no header for a file stored with no metadata, even when the driver read some back', async () => {
    expect((await download(undefined, { team: 'finance' })).headers['x-file-metadata']).toBeUndefined();
    expect((await download({}, { team: 'finance' })).headers['x-file-metadata']).toBeUndefined();
  });

  it('is left out, with the download unchanged, when it would be too large for a response header', async () => {
    const small = { note: 'x'.repeat(8 * 1024 - 20) };
    expect((await download(small)).headers['x-file-metadata']).toBeDefined();
    const res = await download({ note: 'x'.repeat(8 * 1024) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-file-metadata']).toBeUndefined();
    expect(res.body).toBe('hello');
  });

  it('is measured as it travels: escapes for characters outside ASCII count', async () => {
    // 1000 characters outside ASCII are 6000 characters of header (\uXXXX each); 1400 are 8400.
    expect((await download({ note: 'ş'.repeat(1000) })).headers['x-file-metadata']).toBeDefined();
    expect((await download({ note: 'ş'.repeat(1400) })).headers['x-file-metadata']).toBeUndefined();
  });
});
