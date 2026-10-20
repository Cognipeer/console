/**
 * Unit tests - the file service's upload, download and delete flows:
 *
 *  - a blank content type is no content type (dropped before anything is validated);
 *  - an object whose record could not be saved is removed again, and only when no record names it;
 *  - deleting a file does not rewrite its record first;
 *  - a switched-off bucket is read-only: its files list, read and download (listing even with the provider down),
 *    while upload, delete and rewrite are refused with 409 `bucket_inactive` before the provider is touched;
 *  - every refusal is a typed `FileServiceError` with the status the routes answer with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadProviderRuntimeData: vi.fn(),
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  createProviderConfig: vi.fn(),
  createRuntime: vi.fn(),
  convert: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: mocks.createProviderConfig,
  getProviderConfigByKey: mocks.getProviderConfigByKey,
  listProviderConfigs: mocks.listProviderConfigs,
  loadProviderRuntimeData: mocks.loadProviderRuntimeData,
}));
vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: vi.fn().mockReturnValue([]),
    getContract: vi.fn().mockReturnValue({ id: 'memory-files', capabilities: { upload: true, download: true } }),
    createRuntime: mocks.createRuntime,
  },
}));
vi.mock('@cognipeer/to-markdown', () => ({ convertToMarkdown: mocks.convert }));
vi.mock('@/lib/core/logger', () => ({ createLogger: () => mocks.log }));

import { resetAllCircuits } from '@/lib/core/resilience';
import { getConfigSource, setConfigSource } from '@/lib/core/config';
import { runtimePool } from '@/lib/core/runtimePool';
import { getDatabase, type IFileRecord } from '@/lib/database';
import { FileServiceError } from '@/lib/services/files/errors';
import {
  cleanContentType,
  createFileBucket,
  deleteFile,
  deleteFileBucket,
  downloadFile,
  getFileBucket,
  getFileRecord,
  listFiles,
  replaceFileContent,
  updateFileBucket,
  uploadFile,
} from '@/lib/services/files/fileService';
import { createMockDb } from '../helpers/db.mock';

const ORIGINAL_SOURCE = getConfigSource();
const TENANT_DB = 'tenant_db';
const TENANT = 't1';
const PROJECT = 'p1';

interface FakeRuntime {
  uploadFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
}

let runtime: FakeRuntime;
let db: ReturnType<typeof createMockDb>;
let bucketStatus: 'active' | 'disabled';
let providerStatus: 'active' | 'disabled';

function configure(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GATEWAY_RETRY_ENABLED: 'false',
    GATEWAY_CIRCUIT_BREAKER_ENABLED: 'true',
    PROVIDER_RUNTIME_DISPOSE_GRACE_SECONDS: '0',
    ...overrides,
  };
  setConfigSource({ name: 'test', get: (key) => values[key] ?? process.env[key] });
}

const bucketRecord = () => ({
  _id: 'b1', tenantId: TENANT, projectId: PROJECT, key: 'docs', name: 'Docs', providerKey: 'store', status: bucketStatus, createdBy: 'u1',
});
const fileRecord = (over: Record<string, unknown> = {}) => ({
  _id: 'f1', tenantId: TENANT, projectId: PROJECT, providerKey: 'store', bucketKey: 'docs', key: 'a.txt', name: 'a.txt', size: 3,
  contentType: 'text/plain', markdownStatus: 'skipped', createdBy: 'u1', ...over,
}) as unknown as IFileRecord;

const upload = (extra: Record<string, unknown> = {}) =>
  uploadFile(TENANT_DB, TENANT, PROJECT, {
    bucketKey: 'docs', fileName: 'a.txt', contentType: 'text/plain', data: Buffer.from('abc'), createdBy: 'u1', convertToMarkdown: false, ...extra,
  });
const remove = () => deleteFile(TENANT_DB, TENANT, PROJECT, 'docs', 'a.txt', 'u1');
const download = (variant?: 'markdown') => downloadFile(TENANT_DB, TENANT, PROJECT, 'docs', 'a.txt', variant ? { variant } : undefined);
const replace = () => replaceFileContent(TENANT_DB, TENANT, PROJECT, 'docs', 'a.txt', { data: Buffer.from('abcd'), updatedBy: 'u1', convertToMarkdown: false });

beforeEach(() => {
  vi.clearAllMocks();
  resetAllCircuits();
  configure();
  bucketStatus = 'active';
  providerStatus = 'active';
  runtime = {
    uploadFile: vi.fn(async (input: { key: string; name: string; data: Buffer; contentType?: string }) => ({
      handle: { key: input.key, name: input.name, size: input.data.length, contentType: input.contentType },
    })),
    downloadFile: vi.fn(async () => ({ data: Buffer.from('abc'), contentType: 'text/plain', size: 3 })),
    deleteFile: vi.fn(async () => undefined),
  };

  mocks.loadProviderRuntimeData.mockReset();
  mocks.loadProviderRuntimeData.mockImplementation(async (_tenantDb: string, ref: { key: string }) => ({
    record: { key: ref.key, type: 'file', status: providerStatus, driver: 'memory-files', settings: {}, metadata: {} },
    credentials: {},
  }));
  mocks.createRuntime.mockReset();
  mocks.createRuntime.mockImplementation(async () => runtime);
  mocks.convert.mockReset();
  mocks.convert.mockResolvedValue({ markdown: '# a' });

  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findFileBucketByKey.mockImplementation((async () => bucketRecord()) as never);
  db.findFileRecordByKey.mockImplementation((async () => fileRecord()) as never);
  db.createFileRecord.mockImplementation((async (input: Record<string, unknown>) => ({ _id: 'f2', ...input })) as never);
  db.deleteFileRecord.mockResolvedValue(true);
  db.listFileRecords.mockResolvedValue({ items: [fileRecord()], nextCursor: undefined });
});

afterEach(() => {
  runtimePool.invalidateByPrefix('file:');
  resetAllCircuits();
  setConfigSource(ORIGINAL_SOURCE);
});

const refusal = (promise: Promise<unknown>) => promise.then(
  () => { throw new Error('expected a refusal'); },
  (error: unknown) => {
    expect(error).toBeInstanceOf(FileServiceError);
    const { code, status, message } = error as FileServiceError;
    return { code, status, message };
  },
);

// ── Content type ──────────────────────────────────────────────────────────

describe('cleanContentType', () => {
  it('drops a blank value and trims the rest', () => {
    expect(cleanContentType('')).toBeUndefined();
    expect(cleanContentType('   ')).toBeUndefined();
    expect(cleanContentType('\t\n')).toBeUndefined();
    expect(cleanContentType(' text/plain ')).toBe('text/plain');
    expect(cleanContentType('image/png')).toBe('image/png');
  });

  it('leaves what is not text alone, for the validation to refuse', () => {
    expect(cleanContentType(undefined)).toBeUndefined();
    expect(cleanContentType(null)).toBeNull();
    expect(cleanContentType(42)).toBe(42);
  });
});

describe('a content type that is blank', () => {
  it.each([[''], ['   '], ['\t']])('(%j) stores the file without one, instead of refusing it as invalid', async (contentType) => {
    const { record } = await upload({ contentType });
    expect(mockedUpload().contentType).toBeUndefined();
    expect(record.contentType).toBeUndefined();
    expect(db.createFileRecord).toHaveBeenCalledWith(expect.objectContaining({ contentType: undefined }));
  });

  it('is trimmed when it is not blank', async () => {
    await upload({ contentType: '  application/pdf  ' });
    expect(mockedUpload().contentType).toBe('application/pdf');
  });

  it('meets the allowlist as no content type at all', async () => {
    configure({ FILE_UPLOAD_ALLOWED_MIME_TYPES: 'application/pdf' });
    expect(await refusal(upload({ contentType: '' }))).toMatchObject({ code: 'content_type_not_allowed', status: 415 });
    expect(runtime.uploadFile).not.toHaveBeenCalled();
  });

  it('still refuses a value that is no content type (400 invalid_content_type)', async () => {
    for (const contentType of ['not a type', 'text', 'a/b/c', 42]) {
      expect(await refusal(upload({ contentType })), String(contentType)).toMatchObject({ code: 'invalid_content_type', status: 400 });
    }
    expect(runtime.uploadFile).not.toHaveBeenCalled();
  });

  /** What the provider was asked to store. */
  function mockedUpload() {
    return runtime.uploadFile.mock.calls[0]![0] as { key: string; contentType?: string };
  }
});

// ── An object without a record ────────────────────────────────────────────

describe('an upload whose record cannot be saved', () => {
  const dbDown = new Error('database is down');

  it('removes the object it just wrote, and reports the failure that got it there', async () => {
    db.createFileRecord.mockRejectedValue(dbDown);
    db.findFileRecordByKey.mockResolvedValue(null);
    await expect(upload({ keyHint: 'reports/a.txt' })).rejects.toBe(dbDown);

    expect(runtime.deleteFile).toHaveBeenCalledTimes(1);
    expect(runtime.deleteFile).toHaveBeenCalledWith('docs/reports/a.txt');
    // Asked first whether a record owns the key.
    expect(db.findFileRecordByKey).toHaveBeenCalledWith('store', 'docs', 'reports/a.txt', PROJECT);
  });

  it('removes the object under the key the provider reports, not the one asked for', async () => {
    runtime.uploadFile.mockImplementation(async (input: { name: string; data: Buffer }) => ({ handle: { key: 'docs/renamed.txt', name: input.name, size: input.data.length } }));
    db.createFileRecord.mockRejectedValue(dbDown);
    db.findFileRecordByKey.mockResolvedValue(null);
    await expect(upload()).rejects.toBe(dbDown);
    expect(runtime.deleteFile).toHaveBeenCalledWith('docs/renamed.txt');
  });

  it('leaves an object alone when a record names its key (a caller can name the whole key and overwrite a file)', async () => {
    db.createFileRecord.mockRejectedValue(dbDown);
    db.findFileRecordByKey.mockResolvedValue(fileRecord({ key: 'reports/a.txt' }));
    await expect(upload({ keyHint: 'reports/a.txt' })).rejects.toBe(dbDown);
    expect(runtime.deleteFile).not.toHaveBeenCalled();
  });

  it('still reports the original failure when the clean-up fails too, and logs the clean-up', async () => {
    db.createFileRecord.mockRejectedValue(dbDown);
    db.findFileRecordByKey.mockResolvedValue(null);
    runtime.deleteFile.mockRejectedValue(new Error('storage is down too'));
    await expect(upload({ keyHint: 'a.txt' })).rejects.toBe(dbDown);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'Could not remove an uploaded object after saving its record failed',
      expect.objectContaining({ bucketKey: 'docs', key: 'a.txt' }),
    );
  });

  it('still reports the original failure when the ownership lookup fails', async () => {
    db.createFileRecord.mockRejectedValue(dbDown);
    db.findFileRecordByKey.mockRejectedValue(new Error('lookup failed'));
    await expect(upload()).rejects.toBe(dbDown);
    expect(runtime.deleteFile).not.toHaveBeenCalled();
  });

  it('does not touch the provider when the record is saved', async () => {
    db.findFileRecordByKey.mockResolvedValue(null);
    await upload();
    expect(runtime.deleteFile).not.toHaveBeenCalled();
  });

  it('has nothing to remove when the provider itself failed', async () => {
    runtime.uploadFile.mockRejectedValue(Object.assign(new Error('denied'), { statusCode: 403, retryable: false }));
    await expect(upload()).rejects.toThrow('denied');
    expect(db.createFileRecord).not.toHaveBeenCalled();
    expect(runtime.deleteFile).not.toHaveBeenCalled();
  });

  it('keeps the original when only the Markdown copy fails (the failure is the record\'s status)', async () => {
    mocks.convert.mockRejectedValue(new Error('cannot convert'));
    db.updateFileRecord.mockResolvedValue(fileRecord());
    db.findFileRecordById.mockResolvedValue(fileRecord({ markdownStatus: 'failed' }));
    const { record } = await upload({ convertToMarkdown: true });
    expect(record.markdownStatus).toBe('failed');
    expect(runtime.deleteFile).not.toHaveBeenCalled();
  });
});

// ── Delete ────────────────────────────────────────────────────────────────

describe('deleting a file', () => {
  it('removes the object and then the record, and rewrites nothing in between', async () => {
    const deleted = await remove();
    expect(deleted).toBe(true);
    expect(runtime.deleteFile).toHaveBeenCalledWith('docs/a.txt');
    expect(db.deleteFileRecord).toHaveBeenCalledWith('f1');
    expect(db.updateFileRecord).not.toHaveBeenCalled();
    expect(runtime.deleteFile.mock.invocationCallOrder[0]).toBeLessThan(db.deleteFileRecord.mock.invocationCallOrder[0]!);
  });

  it('removes the Markdown copy too, and survives a copy that will not go', async () => {
    db.findFileRecordByKey.mockResolvedValue(fileRecord({ markdownKey: 'a.md', markdownStatus: 'succeeded' }));
    runtime.deleteFile.mockImplementation(async (key: string) => { if (key === 'docs/a.md') throw new Error('gone already'); });
    expect(await remove()).toBe(true);
    expect(runtime.deleteFile.mock.calls.map((call) => call[0])).toEqual(['docs/a.txt', 'docs/a.md']);
    expect(db.deleteFileRecord).toHaveBeenCalledWith('f1');
    expect(mocks.log.warn).toHaveBeenCalledWith('Failed to delete markdown file', expect.objectContaining({ key: 'a.md' }));
  });

  it('keeps the record when the provider will not delete the object', async () => {
    runtime.deleteFile.mockRejectedValue(Object.assign(new Error('denied'), { statusCode: 403, retryable: false }));
    await expect(remove()).rejects.toThrow('denied');
    expect(db.deleteFileRecord).not.toHaveBeenCalled();
  });
});

// ── A switched-off bucket ─────────────────────────────────────────────────

describe('a switched-off bucket', () => {
  beforeEach(() => {
    bucketStatus = 'disabled';
    mocks.getProviderConfigByKey.mockResolvedValue({ id: 'p1', key: 'store', type: 'file', driver: 'memory-files', status: 'active', settings: {} });
  });

  describe('is read-only', () => {
    it('lists its files without ever building a runtime (so it lists while the provider is down)', async () => {
      mocks.loadProviderRuntimeData.mockRejectedValue(new Error('provider unreachable'));
      const page = await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs' });
      expect(page.items).toHaveLength(1);
      expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
      expect(mocks.createRuntime).not.toHaveBeenCalled();
    });

    it('lists a folder, a search and a kind of file the same way', async () => {
      mocks.loadProviderRuntimeData.mockRejectedValue(new Error('provider unreachable'));
      db.listFileEntries.mockResolvedValue({ folders: ['reports/'], items: [], nextCursor: undefined });
      expect((await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', prefix: '' })).folders).toEqual(['reports/']);
      await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', search: 'a' });
      await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', type: 'pdf' });
      expect(db.listFileRecords).toHaveBeenCalledTimes(2);
    });

    it('reads a file\'s record without a runtime, whatever the provider\'s state', async () => {
      mocks.loadProviderRuntimeData.mockRejectedValue(new Error('provider unreachable'));
      expect((await getFileRecord(TENANT_DB, TENANT, PROJECT, 'docs', 'a.txt')).key).toBe('a.txt');
      expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
    });

    it('describes the bucket', async () => {
      expect(await getFileBucket(TENANT_DB, TENANT, PROJECT, 'docs')).toMatchObject({ key: 'docs', status: 'disabled' });
    });

    it('gives a file back: the download works', async () => {
      const result = await download();
      expect(result.data.toString()).toBe('abc');
      expect(runtime.downloadFile).toHaveBeenCalledWith('docs/a.txt');
    });

    it('gives the Markdown copy back too', async () => {
      db.findFileRecordByKey.mockResolvedValue(fileRecord({ markdownKey: 'a.md', markdownStatus: 'succeeded' }));
      await download('markdown');
      expect(runtime.downloadFile).toHaveBeenCalledWith('docs/a.md');
    });

    it('can be switched on again', async () => {
      db.updateFileBucket.mockResolvedValue({ ...bucketRecord(), status: 'active' });
      const view = await updateFileBucket(TENANT_DB, TENANT, PROJECT, 'docs', { status: 'active' });
      expect(view.status).toBe('active');
    });
  });

  describe('takes nothing new and drops nothing (409 bucket_inactive, before the provider is touched)', () => {
    it.each([
      ['upload', () => upload()],
      ['delete', () => remove()],
      ['rewrite', () => replace()],
    ])('refuses %s', async (_name, run) => {
      expect(await refusal(run())).toEqual({ code: 'bucket_inactive', status: 409, message: 'File bucket is not active.' });
      expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
      expect(runtime.uploadFile).not.toHaveBeenCalled();
      expect(runtime.deleteFile).not.toHaveBeenCalled();
      expect(db.createFileRecord).not.toHaveBeenCalled();
      expect(db.deleteFileRecord).not.toHaveBeenCalled();
    });
  });
});

describe('an active bucket whose provider is switched off', () => {
  beforeEach(() => {
    providerStatus = 'disabled';
  });

  it('still lists, but cannot give a file back or take one (409 provider_inactive)', async () => {
    expect((await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs' })).items).toHaveLength(1);
    for (const run of [() => upload(), () => download(), () => remove()]) {
      expect(await refusal(run())).toMatchObject({ code: 'provider_inactive', status: 409 });
    }
  });
});

// ── Typed refusals ────────────────────────────────────────────────────────

describe('a refusal of the file service', () => {
  it('is a 404 bucket_not_found wherever the bucket is missing', async () => {
    db.findFileBucketByKey.mockResolvedValue(null);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['listFiles', () => listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'gone' })],
      ['getFileRecord', () => getFileRecord(TENANT_DB, TENANT, PROJECT, 'gone', 'a.txt')],
      ['getFileBucket', () => getFileBucket(TENANT_DB, TENANT, PROJECT, 'gone')],
      ['upload', () => upload({ bucketKey: 'gone' })],
      ['download', () => downloadFile(TENANT_DB, TENANT, PROJECT, 'gone', 'a.txt')],
      ['delete', () => deleteFile(TENANT_DB, TENANT, PROJECT, 'gone', 'a.txt', 'u1')],
      ['rewrite', () => replaceFileContent(TENANT_DB, TENANT, PROJECT, 'gone', 'a.txt', { data: Buffer.from('x'), updatedBy: 'u1' })],
      ['updateFileBucket', () => updateFileBucket(TENANT_DB, TENANT, PROJECT, 'gone', { name: 'x' })],
    ];
    for (const [name, run] of calls) {
      expect(await refusal(run()), name).toEqual({ code: 'bucket_not_found', status: 404, message: 'File bucket not found.' });
    }
  });

  it('is a 404 file_not_found for a file with no record, before any runtime is built', async () => {
    db.findFileRecordByKey.mockResolvedValue(null);
    for (const run of [() => getFileRecord(TENANT_DB, TENANT, PROJECT, 'docs', 'gone.txt'), () => download(), () => remove(), () => replace()]) {
      expect(await refusal(run())).toEqual({ code: 'file_not_found', status: 404, message: 'File record not found.' });
    }
    expect(mocks.loadProviderRuntimeData).not.toHaveBeenCalled();
  });

  it('is a 409 markdown_unavailable for a Markdown copy that does not exist', async () => {
    expect(await refusal(download('markdown'))).toMatchObject({ code: 'markdown_unavailable', status: 409 });
  });

  it('is a 400 provider_mismatch for a provider key that is not the bucket\'s', async () => {
    expect(await refusal(upload({ providerKey: 'other' }))).toMatchObject({ code: 'provider_mismatch', status: 400 });
    expect(await refusal(listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', providerKey: 'other' }))).toMatchObject({ code: 'provider_mismatch', status: 400 });
  });

  it('is a 413 file_too_large for a file over the configured limit', async () => {
    configure({ FILE_UPLOAD_MAX_MB: '1' });
    const refused = await refusal(upload({ data: Buffer.alloc(1024 * 1024 + 1) }));
    expect(refused).toMatchObject({ code: 'file_too_large', status: 413 });
    expect(refused.message).toBe('File exceeds maximum allowed size of 1 MB (got 2 MB).');
    expect(runtime.uploadFile).not.toHaveBeenCalled();
  });

  it('is a 415 content_type_not_allowed for a type the allowlist does not name', async () => {
    configure({ FILE_UPLOAD_ALLOWED_MIME_TYPES: 'application/pdf,image/*' });
    expect(await refusal(upload({ contentType: 'text/plain' }))).toMatchObject({ code: 'content_type_not_allowed', status: 415 });
    await expect(upload({ contentType: 'image/png' })).resolves.toBeDefined();
    await expect(upload({ contentType: 'APPLICATION/PDF; charset=binary' })).resolves.toBeDefined();
  });

  describe('about the provider of a bucket', () => {
    it('tells a provider that is gone from one that was never given to the project (409)', async () => {
      mocks.loadProviderRuntimeData.mockRejectedValue(new Error('Provider configuration "store" not found.'));
      expect(await refusal(upload())).toEqual({
        code: 'provider_missing', status: 409, message: 'The storage provider "store" of this bucket no longer exists.',
      });
      mocks.loadProviderRuntimeData.mockRejectedValue(new Error('Provider "store" exists but is not assigned to project p1.'));
      expect(await refusal(download())).toMatchObject({ code: 'provider_unassigned', status: 409, message: 'Provider "store" exists but is not assigned to project p1.' });
    });

    it('passes any other failure of the lookup on untouched (it is not a refusal)', async () => {
      const outage = new Error('database is down');
      mocks.loadProviderRuntimeData.mockRejectedValue(outage);
      await expect(upload()).rejects.toBe(outage);
    });

    it('is a 409 provider_invalid for a provider that is not a file provider', async () => {
      mocks.loadProviderRuntimeData.mockResolvedValue({ record: { key: 'store', type: 'model', status: 'active', driver: 'x', settings: {}, metadata: {} }, credentials: {} });
      expect(await refusal(upload())).toMatchObject({ code: 'provider_invalid', status: 409 });
    });
  });

  describe('about a bucket', () => {
    beforeEach(() => {
      mocks.getProviderConfigByKey.mockResolvedValue({ id: 'p1', key: 'store', type: 'file', driver: 'memory-files', status: 'active', settings: {} });
    });

    it('is a 409 duplicate_key when the key is taken', async () => {
      expect(await refusal(createFileBucket(TENANT_DB, TENANT, PROJECT, { key: 'docs', name: 'Docs', providerKey: 'store', createdBy: 'u1' })))
        .toEqual({ code: 'duplicate_key', status: 409, message: 'Bucket with key "docs" already exists.' });
    });

    it('is a 400 provider_missing when the provider does not exist, and a 409 provider_inactive when it is off', async () => {
      db.findFileBucketByKey.mockResolvedValue(null);
      mocks.getProviderConfigByKey.mockResolvedValue(null);
      expect(await refusal(createFileBucket(TENANT_DB, TENANT, PROJECT, { key: 'new', name: 'New', providerKey: 'nope', createdBy: 'u1' })))
        .toMatchObject({ code: 'provider_missing', status: 400 });
      mocks.getProviderConfigByKey.mockResolvedValue({ id: 'p1', key: 'store', type: 'file', driver: 'memory-files', status: 'disabled', settings: {} });
      expect(await refusal(createFileBucket(TENANT_DB, TENANT, PROJECT, { key: 'new', name: 'New', providerKey: 'store', createdBy: 'u1' })))
        .toMatchObject({ code: 'provider_inactive', status: 409 });
    });

    it('is a 409 bucket_not_empty to delete a bucket that holds files without force', async () => {
      expect(await refusal(deleteFileBucket(TENANT_DB, TENANT, PROJECT, 'docs')))
        .toEqual({ code: 'bucket_not_empty', status: 409, message: 'Bucket contains files. Remove files or use force delete.' });
      db.deleteFileBucket.mockResolvedValue(true);
      await expect(deleteFileBucket(TENANT_DB, TENANT, PROJECT, 'docs', { force: true })).resolves.toBe(true);
    });
  });
});

// ── Listing ───────────────────────────────────────────────────────────────

describe('listing files', () => {
  it('lists a folder (files and sub-folders) when given a prefix alone', async () => {
    db.listFileEntries.mockResolvedValue({ folders: ['reports/'], items: [fileRecord()], nextCursor: 'c1' });
    const page = await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', prefix: 'reports' });
    expect(db.listFileEntries).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'store', bucketKey: 'docs', projectId: PROJECT, prefix: 'reports/' }));
    expect(page).toMatchObject({ folders: ['reports/'], prefix: 'reports/', nextCursor: 'c1' });
  });

  it('lists a kind of file flat, like a search, even inside a folder', async () => {
    await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs', prefix: 'reports/', type: 'pdf' });
    expect(db.listFileEntries).not.toHaveBeenCalled();
    expect(db.listFileRecords).toHaveBeenCalledWith(expect.objectContaining({ providerKey: 'store', bucketKey: 'docs', projectId: PROJECT, prefix: 'reports/', type: 'pdf' }));
  });

  it('does not pass a type on when none was asked for', async () => {
    await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs' });
    expect(db.listFileRecords.mock.calls[0]![0]).not.toHaveProperty('type');
  });

  it('answers records as views with an id and no _id', async () => {
    const page = await listFiles(TENANT_DB, TENANT, PROJECT, { bucketKey: 'docs' });
    expect(page.items[0]).toMatchObject({ id: 'f1', key: 'a.txt' });
    expect(page.items[0]).not.toHaveProperty('_id');
  });
});
