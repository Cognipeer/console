/**
 * The Document Store screens' API client (`src/components/files/filesApi.ts`) against the REAL plugin over a real
 * SQLite database and the real local-disk driver. The UI tests answer from fixtures and the route tests pin the
 * server's decisions with mocks; this is the one place where the client the screens call and the server that
 * answers it meet: the paths `filesRoutes` builds, the bodies the fetchers send, and the answers they read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
} from '@/components/files/filesApi';
import { parseFolder } from '@/components/files/upload/uploadModel';
import type { FileServiceErrorCode } from '@/lib/services/files/errors';
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
    expect(noPreview).toMatchObject({ status: 415, code: 'preview_unsupported' });

    const noConversion = await refusalOf(convertObject('reports', record.key));
    expect(noConversion).toMatchObject({ status: 415, code: 'conversion_unsupported' });

    const gone = await refusalOf(getObject('reports', 'nowhere/at-all.txt'));
    expect(gone.status).toBe(404);
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
});

describe('the error codes', () => {
  it('are every one a code the server can answer with', () => {
    // At compile time (tsc): the client names no code the service does not have (`bucket_in_use` is the agents' own).
    const serverCodes: ReadonlyArray<FileServiceErrorCode | 'bucket_in_use'> = FILES_ERROR_CODES;
    expect(serverCodes.length).toBeGreaterThan(0);

    // At run time: each is written in the files where the server defines them.
    const sources = ['src/lib/services/files/errors.ts', 'src/lib/services/agents/sessionFilesBucket.ts']
      .map((file) => readFileSync(path.join(process.cwd(), file), 'utf8'))
      .join('\n');
    expect(FILES_ERROR_CODES.filter((code) => !sources.includes(`'${code}'`))).toEqual([]);
  });
});
