/**
 * The Document Store screens' API client (`src/components/files/filesApi.ts`) against the REAL plugin over a real
 * SQLite database and the real local-disk driver. The UI tests answer from fixtures and the route tests pin the
 * server's decisions with mocks; this is the one place where the client the screens call and the server that
 * answers it meet: the paths `filesRoutes` builds, the bodies the fetchers send, and the answers they read.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));

import {
  archiveObjects,
  batchDeleteObjects,
  convertObject,
  createBucket,
  deleteBucket,
  deleteObject,
  downloadObject,
  FILES_ERROR_CODES,
  fetchObjectText,
  getBucket,
  getFilesLimits,
  getObject,
  importFromStorage,
  isFilesApiError,
  listBuckets,
  listFileProviders,
  listObjects,
  updateBucket,
  uploadFile,
  type FilesApiError,
  type FilesErrorCode,
} from '@/components/files/filesApi';
import { deleteRules } from '@/components/files/bucket/settingsModel';
import { PREVIEW_MAX_BYTES } from '@/components/files/shared/fileKind';
import { filesErrorMessage, type FilesTranslator } from '@/components/files/shared/filesErrors';
import { parseFolder } from '@/components/files/upload/uploadModel';
import { getQueue } from '@/lib/core/queue';
import { en } from '@/lib/i18n/messages/en';
import { PROVIDER_SETTINGS_INVALID } from '@/lib/providers/errors';
import type { FileServiceErrorCode } from '@/lib/services/files/errors';
import { startFilesQueueConsumer } from '@/lib/services/files/jobs/filesConsumer';
import { PROVIDER_ENDPOINT_NOT_ALLOWED } from '@/lib/services/providers/providerEndpointGuard';
import { createFilesStack, type FilesStack } from '../helpers/filesRealStack';

let stack: FilesStack;

/** `fetch` for the client: the request goes into the real plugin, and its answer comes back as a `Response`. */
function routeFetchInto(target: FilesStack) {
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith('/api/')) throw new Error(`the client asked for ${url}, which is not under /api`);
    const method = (init.method ?? 'GET') as 'GET' | 'POST' | 'PATCH' | 'DELETE';
    const payload = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const res = await target.request(method, url.slice('/api'.length), payload);
    const headers = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    }
    const hasNoBody = [101, 204, 205, 304].includes(res.statusCode);
    return new Response(hasNoBody ? null : (res.rawPayload as unknown as BodyInit), { status: res.statusCode, headers });
  });
}

/** `FileReader` is a browser API: the one `uploadFile` reads a file with, over `Blob.arrayBuffer`. */
class BlobFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(
      (buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      },
      () => this.onerror?.(),
    );
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  routeFetchInto(stack);
  vi.stubGlobal('FileReader', BlobFileReader);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await stack.close();
});

const textFile = (name: string, content: string, type = 'text/plain') => new File([content], name, { type });

/** A translator over the real `files.common` messages of English. */
const english: FilesTranslator = (key, values) => {
  const found = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en.files.common);
  if (typeof found !== 'string') throw new Error(`missing files.common.${key}`);
  return found.replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`));
};

/** What a call rejected with: the screens branch on `status` and `code`. */
async function refusalOf(call: Promise<unknown>): Promise<FilesApiError> {
  try {
    await call;
  } catch (error) {
    expect(isFilesApiError(error), String(error)).toBe(true);
    return error as FilesApiError;
  }
  throw new Error('the call was expected to be refused');
}

describe('the pages that draw buckets', () => {
  it('reads the providers a bucket can be created on, each with its standing and where it keeps files', async () => {
    const providers = await listFileProviders();

    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      key: 'local',
      label: 'Server disk',
      driver: 'local-filesystem',
      status: 'active',
      providerHealth: { state: expect.stringMatching(/^(ok|failed|untested|builtin|inactive)$/) },
    });
    expect(providers[0]!).toHaveProperty('storageLocationBase');
    expect(JSON.stringify(providers)).not.toContain('CREDENTIAL-MUST-NOT-LEAK');
  });

  it('reads the limits of the project and of a bucket', async () => {
    await createBucket({ key: 'work', name: 'Work', providerKey: 'local' });

    for (const limits of [await getFilesLimits(), await getFilesLimits({ bucketKey: 'work' })]) {
      expect(limits.maxFileBytes).toBeGreaterThan(0);
      expect(limits.maxRequestBytes).toBeGreaterThan(0);
      expect(limits.allowedMimeTypes === null || Array.isArray(limits.allowedMimeTypes)).toBe(true);
      expect(limits.quota).toEqual({
        usedBytes: expect.any(Number),
        limitBytes: expect.toSatisfy((value: unknown) => value === null || typeof value === 'number'),
        filesUsed: expect.any(Number),
        filesLimit: expect.toSatisfy((value: unknown) => value === null || typeof value === 'number'),
      });
    }
  });

  it('creates a bucket, and lists it with its stats and health, and opens it with who uses it and where it is stored', async () => {
    const created = await createBucket({ key: 'reports', name: ' Reports ', providerKey: 'local', description: 'Quarterly', prefix: 'rep' });

    expect(created).toMatchObject({ key: 'reports', name: 'Reports', providerKey: 'local', status: 'active', prefix: 'rep', description: 'Quarterly' });

    const listed = (await listBuckets()).find((bucket) => bucket.key === 'reports')!;
    expect(listed).toMatchObject({
      key: 'reports',
      stats: { fileCount: 0, totalBytes: 0 },
      providerHealth: { state: expect.any(String) },
    });
    expect(listed.deleting ?? false).toBe(false);

    const detail = await getBucket('reports');
    expect(detail).toMatchObject({ key: 'reports', usedBy: [], stats: { fileCount: 0, totalBytes: 0 } });
    expect(detail).toHaveProperty('storageLocation');
  });

  it('refuses a key that is taken, a provider that is not there and a bucket that does not exist, with the codes the screens read', async () => {
    await createBucket({ key: 'reports', name: 'Reports', providerKey: 'local' });

    const taken = await refusalOf(createBucket({ key: 'reports', name: 'Again', providerKey: 'local' }));
    expect(taken.status).toBe(409);

    const nowhere = await refusalOf(createBucket({ key: 'other', name: 'Other', providerKey: 'nowhere' }));
    expect(nowhere.status).toBeGreaterThanOrEqual(400);
    expect(nowhere.status).toBeLessThan(500);

    const missing = await refusalOf(getBucket('missing'));
    expect(missing).toMatchObject({ status: 404, code: 'bucket_not_found' });
  });
});

describe('the files of a bucket', () => {
  beforeEach(async () => {
    await createBucket({ key: 'reports', name: 'Reports', providerKey: 'local' });
  });

  it('uploads a file into a folder as the upload screen asks, and lists the folder, its sub-folders and its files', async () => {
    const parsed = parseFolder('/q3//2026/');
    expect(parsed.problem ?? null).toBeNull();

    const { record } = await uploadFile('reports', textFile('summary.txt', 'hello'), { folder: parsed.folder, convertToMarkdown: false });
    expect(record).toMatchObject({ bucketKey: 'reports', name: 'summary.txt', size: 5, contentType: 'text/plain' });
    expect(record.key.startsWith('q3/2026/')).toBe(true);
    await uploadFile('reports', textFile('top.txt', 'top'), { convertToMarkdown: false });

    const root = await listObjects('reports', { prefix: '' });
    expect(root.prefix).toBe('');
    expect(root.folders).toEqual(['q3/']);
    expect(root.items.map((item) => item.name)).toEqual(['top.txt']);

    const q3 = await listObjects('reports', { prefix: 'q3/' });
    expect(q3.prefix).toBe('q3/');
    expect(q3.folders).toEqual(['q3/2026/']);
    expect(q3.items).toEqual([]);

    const inner = await listObjects('reports', { prefix: 'q3/2026/' });
    expect(inner.items.map((item) => item.key)).toEqual([record.key]);

    // The stats the bucket page and the list draw follow the files.
    expect((await getBucket('reports')).stats).toEqual({ fileCount: 2, totalBytes: 8 });
    expect((await listBuckets()).find((bucket) => bucket.key === 'reports')!.stats).toEqual({ fileCount: 2, totalBytes: 8 });
  });

  it('lists a search or a type as one flat list, and pages with a cursor', async () => {
    await uploadFile('reports', textFile('alpha.txt', 'a'), { folder: 'one/', convertToMarkdown: false });
    await uploadFile('reports', textFile('beta.txt', 'b'), { folder: 'two/', convertToMarkdown: false });
    await uploadFile('reports', new File([new Uint8Array([37, 80, 68, 70])], 'gamma.pdf', { type: 'application/pdf' }), { convertToMarkdown: false });

    const search = await listObjects('reports', { prefix: '', search: 'alp' });
    expect(search.items.map((item) => item.name)).toEqual(['alpha.txt']);
    expect(search.folders).toEqual([]);
    expect(search).not.toHaveProperty('prefix');

    const texts = await listObjects('reports', { prefix: '', type: 'text' });
    expect(texts.items.map((item) => item.name).sort()).toEqual(['alpha.txt', 'beta.txt']);
    const pdfs = await listObjects('reports', { prefix: '', type: 'pdf' });
    expect(pdfs.items.map((item) => item.name)).toEqual(['gamma.pdf']);

    const first = await listObjects('reports', { prefix: '', type: 'text', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await listObjects('reports', { prefix: '', type: 'text', limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.key).not.toBe(first.items[0]!.key);
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads one record with who uploaded it, its text for the preview, and its bytes under the name it was uploaded with', async () => {
    const { record } = await uploadFile('reports', textFile('Çalışma özeti #2 (son)?.txt', 'merhaba dünya'), { convertToMarkdown: false });

    // A key with spaces, non-ASCII letters, # and ? goes through the address untouched.
    const read = await getObject('reports', record.key);
    expect(read).toMatchObject({ key: record.key, name: 'Çalışma özeti #2 (son)?.txt', size: Buffer.byteLength('merhaba dünya') });
    expect(read.createdByName).toBe('A Member');
    expect(read.createdAt).toEqual(expect.any(String));

    expect(await fetchObjectText('reports', record.key)).toBe('merhaba dünya');

    const downloaded = await downloadObject('reports', record.key);
    expect(Buffer.from(await downloaded.blob.arrayBuffer()).toString('utf8')).toBe('merhaba dünya');
    expect(downloaded.fileName).toBe('Çalışma özeti #2 (son)?.txt');
    expect(downloaded.contentType).toContain('text/plain');
  });

  it('says it cannot preview what is not text, and that a file that is not there is not there', async () => {
    const { record } = await uploadFile('reports', new File([new Uint8Array([0, 1, 2, 3])], 'blob.bin', { type: 'application/octet-stream' }), { convertToMarkdown: false });

    const noPreview = await refusalOf(fetchObjectText('reports', record.key));
    expect(noPreview).toMatchObject({ status: 415, code: 'preview_unsupported', reason: 'unsupported_type' });
    expect(filesErrorMessage(noPreview, english)).toBe(en.files.common.errors.previewUnsupported);

    const noConversion = await refusalOf(convertObject('reports', record.key));
    expect(noConversion).toMatchObject({ status: 415, code: 'conversion_unsupported' });

    const gone = await refusalOf(getObject('reports', 'nowhere/at-all.txt'));
    expect(gone.status).toBe(404);
  });

  it('tells a file too large to preview from a type that cannot be previewed', async () => {
    const big = await stack.putFile('reports', 'big.txt', 'x', { size: PREVIEW_MAX_BYTES + 1 });

    const refused = await refusalOf(fetchObjectText('reports', big.key));

    expect(refused).toMatchObject({ status: 415, code: 'preview_unsupported', reason: 'too_large' });
    expect(filesErrorMessage(refused, english)).toBe(en.files.common.errors.previewTooLarge);
  });

  it('deletes one file, and then the file is gone for the drawer that still has it open', async () => {
    const { record } = await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });

    await expect(deleteObject('reports', record.key)).resolves.toBeUndefined();

    expect((await refusalOf(getObject('reports', record.key))).status).toBe(404);
    expect((await listObjects('reports', { prefix: '' })).items).toEqual([]);
    expect((await getBucket('reports')).stats).toEqual({ fileCount: 0, totalBytes: 0 });
  });

  it('deletes several files in one request and lists the ones it could not delete, with a reason', async () => {
    const one = (await uploadFile('reports', textFile('one.txt', '1'), { convertToMarkdown: false })).record;
    const two = (await uploadFile('reports', textFile('two.txt', '22'), { convertToMarkdown: false })).record;

    const result = await batchDeleteObjects('reports', [one.key, two.key, 'never/existed.txt']);

    expect([...result.deleted].sort()).toEqual([one.key, two.key].sort());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ key: 'never/existed.txt', error: expect.any(String) });
    expect(result.failed[0]!.error.length).toBeGreaterThan(0);
    expect((await listObjects('reports', { prefix: '' })).items).toEqual([]);
  });

  it('downloads several files as one zip', async () => {
    const one = (await uploadFile('reports', textFile('one.txt', 'first'), { convertToMarkdown: false })).record;
    const two = (await uploadFile('reports', textFile('two.txt', 'second'), { folder: 'sub/', convertToMarkdown: false })).record;

    const archive = await archiveObjects('reports', [one.key, two.key]);

    const zip = await JSZip.loadAsync(await archive.arrayBuffer());
    const contents = await Promise.all(
      Object.values(zip.files).filter((entry) => !entry.dir).map(async (entry) => [entry.name, await entry.async('string')] as const),
    );
    expect(contents.map(([, text]) => text).sort()).toEqual(['first', 'second']);
  });

  it('starts a conversion and gets the record back as pending', async () => {
    const { record } = await uploadFile('reports', textFile('notes.txt', 'some notes'), { convertToMarkdown: false });
    expect(record.markdownStatus).toBe('skipped');

    const pending = await convertObject('reports', record.key);

    expect(pending).toMatchObject({ key: record.key, markdownStatus: 'pending' });
    expect((await getObject('reports', record.key)).markdownStatus).toBe('pending');
  });

  it('moves the time of a record whenever a conversion is asked for, so a screen can tell a lost run from a running one', async () => {
    const { record } = await uploadFile('reports', textFile('notes.txt', 'some notes'), { convertToMarkdown: false });
    const before = await getObject('reports', record.key);
    await new Promise((resolve) => setTimeout(resolve, 15));

    const pending = await convertObject('reports', record.key);
    expect(pending.markdownStatus).toBe('pending');
    expect(Date.parse(String(pending.updatedAt))).toBeGreaterThan(Date.parse(String(before.updatedAt)));

    // Asking again for a conversion that never ended (its job was lost) starts it anew and restarts the clock.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const again = await convertObject('reports', record.key);
    expect(again.markdownStatus).toBe('pending');
    expect(Date.parse(String(again.updatedAt))).toBeGreaterThan(Date.parse(String(pending.updatedAt)));
  });

  it('registers the objects that are already in the storage, a page at a time', async () => {
    stack.putObject('reports', 'found/one.txt', 'one');
    stack.putObject('reports', 'found/two.txt', 'two');
    stack.putObject('reports', 'three.txt', 'three');

    const first = await importFromStorage('reports', { limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.imported).toBe(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await importFromStorage('reports', { limit: 2, cursor: first.nextCursor });
    expect(second.imported).toBe(1);
    expect(second.nextCursor).toBeUndefined();

    const all = await listObjects('reports', { prefix: '', search: '.txt' });
    expect(all.items.map((item) => item.name).sort()).toEqual(['one.txt', 'three.txt', 'two.txt']);
    expect((await getBucket('reports')).stats.fileCount).toBe(3);
  });
});

describe('changing and deleting a bucket', () => {
  beforeEach(async () => {
    await createBucket({ key: 'reports', name: 'Reports', providerKey: 'local' });
  });

  it('renames a bucket and describes it, and answers the bucket the way the list reads it', async () => {
    const updated = await updateBucket('reports', { name: '  Q3 reports ', description: 'Numbers' });

    expect(updated).toMatchObject({ key: 'reports', name: 'Q3 reports', description: 'Numbers', status: 'active' });
    expect((await getBucket('reports')).name).toBe('Q3 reports');
  });

  it('refuses every write to a disabled bucket with bucket_inactive, and still reads and downloads', async () => {
    const { record } = await uploadFile('reports', textFile('keep.txt', 'keep'), { convertToMarkdown: false });
    await updateBucket('reports', { status: 'disabled' });

    expect(await refusalOf(uploadFile('reports', textFile('more.txt', 'more')))).toMatchObject({ status: 409, code: 'bucket_inactive' });
    expect(await refusalOf(deleteObject('reports', record.key))).toMatchObject({ status: 409, code: 'bucket_inactive' });
    expect(await refusalOf(batchDeleteObjects('reports', [record.key]))).toMatchObject({ status: 409, code: 'bucket_inactive' });
    expect(await refusalOf(convertObject('reports', record.key))).toMatchObject({ status: 409, code: 'bucket_inactive' });
    expect(await refusalOf(importFromStorage('reports'))).toMatchObject({ status: 409, code: 'bucket_inactive' });

    expect((await listObjects('reports', { prefix: '' })).items).toHaveLength(1);
    expect(await fetchObjectText('reports', record.key)).toBe('keep');
    expect(Buffer.from(await (await downloadObject('reports', record.key)).blob.arrayBuffer()).toString()).toBe('keep');
    expect((await getBucket('reports')).status).toBe('disabled');
  });

  it('fixes the prefix once the bucket holds a file', async () => {
    await updateBucket('reports', { prefix: 'before' });
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });

    expect(await refusalOf(updateBucket('reports', { prefix: 'after' }))).toMatchObject({ status: 409, code: 'prefix_locked' });
  });

  it('deletes an empty bucket at once', async () => {
    await expect(deleteBucket('reports')).resolves.toEqual({ status: 'deleted' });

    expect((await listBuckets()).map((bucket) => bucket.key)).not.toContain('reports');
    expect((await refusalOf(getBucket('reports'))).status).toBe(404);
  });

  it('starts removing a bucket with its files in the background: it answers deleting, and the bucket reports it', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });

    const answer = await deleteBucket('reports', { deleteFiles: true });
    expect(answer).toEqual({ status: 'deleting' });

    // No consumer is running here, so the job waits: the bucket stays, disabled, and says it is being deleted.
    const detail = await getBucket('reports');
    expect(detail.deleting).toBe(true);
    expect(detail.status).toBe('disabled');
    expect((await listBuckets()).find((bucket) => bucket.key === 'reports')!.deleting).toBe(true);
  });

  it('refuses to delete a bucket that holds files without being told what happens to them, then removes only the bucket when asked', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });

    expect(await refusalOf(deleteBucket('reports'))).toMatchObject({ status: 409, code: 'bucket_not_empty' });
    expect((await getBucket('reports')).stats.fileCount).toBe(1);

    await expect(deleteBucket('reports', { force: true })).resolves.toEqual({ status: 'deleted' });
    expect((await refusalOf(getBucket('reports'))).status).toBe(404);
    expect((await listBuckets()).map((bucket) => bucket.key)).not.toContain('reports');
  });

  it('refuses to take the files of a storage location another bucket uses, in the sentences the dialogs translate', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
    // The same folder of the same provider: what is in it is not all this bucket's.
    await createBucket({ key: 'twin', name: 'Twin', providerKey: 'local', prefix: 'reports' });

    const noDelete = await refusalOf(deleteBucket('reports', { deleteFiles: true }));
    expect(noDelete).toMatchObject({ status: 409, code: 'storage_location_shared' });
    expect(noDelete.message).toBe(en.files.common.errors.storageLocationSharedDelete);
    expect(filesErrorMessage(noDelete, english, 'deleteBucket')).toBe(noDelete.message);
    // Nothing was marked: the bucket is as it was.
    expect((await getBucket('reports')).deleting ?? false).toBe(false);

    const noImport = await refusalOf(importFromStorage('reports'));
    expect(noImport).toMatchObject({ status: 409, code: 'storage_location_shared' });
    expect(noImport.message).toBe(en.files.common.errors.storageLocationSharedImport);
    expect(filesErrorMessage(noImport, english, 'importFromStorage')).toBe(noImport.message);

    // The sentence advises what the dialog then offers: the bucket alone can go.
    await expect(deleteBucket('reports', { force: true })).resolves.toEqual({ status: 'deleted' });
    expect((await listBuckets()).map((bucket) => bucket.key)).toEqual(['twin']);
  });

  it('keeps a bucket whose files are being deleted closed to everything but the same request again', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
    await expect(deleteBucket('reports', { deleteFiles: true })).resolves.toEqual({ status: 'deleting' });

    expect(await refusalOf(updateBucket('reports', { name: 'Renamed' }))).toMatchObject({ status: 409, code: 'bucket_deleting' });
    expect(await refusalOf(updateBucket('reports', { status: 'active' }))).toMatchObject({ status: 409, code: 'bucket_deleting' });
    expect(await refusalOf(deleteBucket('reports'))).toMatchObject({ status: 409, code: 'bucket_deleting' });
    expect(filesErrorMessage(await refusalOf(deleteBucket('reports')), english)).toBe(en.files.common.errors.bucketDeleting);

    await expect(deleteBucket('reports', { deleteFiles: true })).resolves.toEqual({ status: 'deleting' });
  });

  it('lets the bucket alone be removed while its files are being deleted: the way out of a run the queue lost', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
    await expect(deleteBucket('reports', { deleteFiles: true })).resolves.toEqual({ status: 'deleting' });
    // Another bucket has come to keep its files in the same folder since, so the deletion cannot be asked for again.
    await createBucket({ key: 'twin', name: 'Twin', providerKey: 'local', prefix: 'reports' });
    expect(await refusalOf(deleteBucket('reports', { deleteFiles: true }))).toMatchObject({ status: 409, code: 'storage_location_shared' });
    expect(await refusalOf(deleteBucket('reports'))).toMatchObject({ status: 409, code: 'bucket_deleting' });

    await expect(deleteBucket('reports', { force: true })).resolves.toEqual({ status: 'deleted' });
    expect((await listBuckets()).map((bucket) => bucket.key)).toEqual(['twin']);
  });

  it('moves the time of a bucket whenever its files are asked to go, which is what a screen judges a lost run by', async () => {
    await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
    const before = await getBucket('reports');
    await new Promise((resolve) => setTimeout(resolve, 15));

    await deleteBucket('reports', { deleteFiles: true });
    const asked = await getBucket('reports');
    expect(Date.parse(String(asked.updatedAt))).toBeGreaterThan(Date.parse(String(before.updatedAt)));
    // Just asked: not a run to offer again.
    expect(deleteRules(asked)).toMatchObject({ deleting: true, stalled: false });

    await new Promise((resolve) => setTimeout(resolve, 15));
    await deleteBucket('reports', { deleteFiles: true });
    const again = await getBucket('reports');
    expect(Date.parse(String(again.updatedAt))).toBeGreaterThan(Date.parse(String(asked.updatedAt)));
    // Long after, the same bucket is the one a screen offers to delete again.
    expect(deleteRules(again, Date.parse(String(again.updatedAt)) + 10 * 60_000)).toMatchObject({ deleting: true, stalled: true });
  });

  describe('when the removal of the files stops', () => {
    it('says why on the list and on the bucket, and forgets it when the bucket is kept', async () => {
      const { record } = await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
      // The object cannot be removed: the job stops with a reason.
      stack.blockObject('reports', record.key);
      await startFilesQueueConsumer();

      await deleteBucket('reports', { deleteFiles: true });
      await vi.waitFor(async () => expect((await getBucket('reports')).deleteError).toBeTruthy(), { timeout: 15_000 });

      const detail = await getBucket('reports');
      expect(detail.deleting ?? false).toBe(false);
      expect(detail.status).toBe('disabled');
      expect(detail.deleteError).toMatch(/^1 file could not be deleted from the storage provider: /);
      const listed = (await listBuckets()).find((bucket) => bucket.key === 'reports')!;
      expect(listed.deleteError).toBe(detail.deleteError);
      // The screens read the same reason from both, and offer to delete again.
      expect(deleteRules(detail)).toMatchObject({ deleting: false, stalled: false, lastError: detail.deleteError });
      expect(deleteRules(listed)).toMatchObject({ lastError: detail.deleteError });

      // "Keep the bucket": switched on again, the reason is forgotten - on the answer and on what is read after it.
      const kept = await updateBucket('reports', { status: 'active' });
      expect(kept.status).toBe('active');
      expect(deleteRules(kept).lastError).toBeNull();
      const after = await getBucket('reports');
      expect(after.deleteError).toBeUndefined();
      expect(deleteRules(after).lastError).toBeNull();
      expect((await listBuckets()).find((bucket) => bucket.key === 'reports')!.deleteError).toBeUndefined();
    });

    it('can be asked again once the cause is gone, and the bucket then disappears', async () => {
      const { record } = await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
      const stuck = stack.blockObject('reports', record.key);
      await startFilesQueueConsumer();
      await deleteBucket('reports', { deleteFiles: true });
      await vi.waitFor(async () => expect((await getBucket('reports')).deleteError).toBeTruthy(), { timeout: 15_000 });

      rmSync(stuck, { recursive: true, force: true });
      writeFileSync(stuck, 'now a plain file');
      await expect(deleteBucket('reports', { deleteFiles: true })).resolves.toEqual({ status: 'deleting' });
      // Asking again clears the old reason at once.
      expect((await getBucket('reports')).deleteError).toBeUndefined();

      await vi.waitFor(async () => expect((await refusalOf(getBucket('reports'))).status).toBe(404), { timeout: 15_000 });
      expect(existsSync(stuck)).toBe(false);
    });

    it('leaves a bucket that could not be queued as it was, with why, and the client treats it as a failed deletion', async () => {
      await uploadFile('reports', textFile('a.txt', 'a'), { convertToMarkdown: false });
      vi.spyOn(await getQueue(), 'publish').mockRejectedValueOnce(new Error('redis is down'));

      const refused = await refusalOf(deleteBucket('reports', { deleteFiles: true }));
      expect(refused).toMatchObject({ status: 503, code: 'queue_unavailable' });
      expect(filesErrorMessage(refused, english)).toBe(en.files.common.errors.queueUnavailable);

      // Still switched on, and carrying the reason: the page offers to try again or to keep it as it is.
      const detail = await getBucket('reports');
      expect(detail).toMatchObject({ status: 'active' });
      expect(detail.deleting ?? false).toBe(false);
      expect(detail.deleteError).toMatch(/queue/i);
      expect(deleteRules(detail).lastError).toBe(detail.deleteError);

      // Keeping it forgets the reason even though it is switched on already.
      await updateBucket('reports', { status: 'active' });
      expect((await getBucket('reports')).deleteError).toBeUndefined();
    });
  });
});

describe('the error codes', () => {
  it('are every one a code the server can answer with, and the client names every code of the file service', () => {
    // The codes the file service raises are `FileServiceErrorCode`; the others are written where the answer is made.
    type ServerCode =
      | FileServiceErrorCode
      // The agents' check on a bucket they keep session files in (`sessionFilesBucket.ts`).
      | 'bucket_in_use'
      // A failure or an outage of the storage, as the HTTP layer words it (`server/api/fileHttp.ts`).
      | 'storage_failure'
      | 'storage_unavailable'
      | 'storage_timeout'
      | 'internal_error'
      // A provider setting or endpoint the console refuses (`providers/errors.ts`, `providerEndpointGuard.ts`).
      | typeof PROVIDER_SETTINGS_INVALID
      | typeof PROVIDER_ENDPOINT_NOT_ALLOWED;

    // At compile time (tsc): the client names no code the server does not have...
    const serverCodes: ReadonlyArray<ServerCode> = FILES_ERROR_CODES;
    expect(serverCodes.length).toBeGreaterThan(0);
    // ...and the file service has no code the client does not name.
    expectTypeOf<Exclude<FileServiceErrorCode, FilesErrorCode>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<ServerCode, FilesErrorCode>>().toEqualTypeOf<never>();

    // At run time: each is written in the files where the server defines them.
    const sources = [
      'src/lib/services/files/errors.ts',
      'src/lib/services/agents/sessionFilesBucket.ts',
      'src/server/api/fileHttp.ts',
      'src/lib/providers/errors.ts',
      'src/lib/services/providers/providerEndpointGuard.ts',
    ]
      .map((file) => readFileSync(path.join(process.cwd(), file), 'utf8'))
      .join('\n');
    expect(FILES_ERROR_CODES.filter((code) => !sources.includes(`'${code}'`))).toEqual([]);
  });
});
