/**
 * Several files at once, and files that are already there, through the REAL plugin over a real SQLite database and
 * the real local-disk driver:
 *
 *  - POST /files/buckets/:bucketKey/objects/batch-delete - what could be deleted is, what could not is reported;
 *  - POST /files/buckets/:bucketKey/objects/archive      - a ZIP of the chosen files, refused before it starts when
 *    the files are too many or too large;
 *  - POST /files/buckets/:bucketKey/import               - registers the objects in the bucket's folder, a page at a
 *    time, and only ever adds records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, truncateSync } from 'node:fs';
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

import { maxStorageDownloadBytes } from '@/lib/providers/contracts/storageLimits';
import { ARCHIVE_MAX_BYTES } from '@/lib/services/files/archive';
import { BATCH_MAX_KEYS } from '@/lib/services/files/fileBatch';
import { collectApiRoutes } from '../helpers/routeDeclarations';
import { createFilesStack, type FilesStack } from '../helpers/filesRealStack';

const MIB = 1024 * 1024;

let stack: FilesStack;

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.createBucket('work', { name: 'Work files' });
  await stack.createBucket('other', { name: 'Other files' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stack.close();
});

const disable = async (key: string) => stack.db.updateFileBucket(String((await stack.bucket(key))!._id), { status: 'disabled' });

const KEYS_WRONG: Array<[string, unknown]> = [
  ['no keys', {}],
  ['keys that are no list', { keys: 'a.txt' }],
  ['an empty list', { keys: [] }],
  ['a key that is no text', { keys: ['a.txt', 7] }],
  ['an empty key', { keys: ['a.txt', ''] }],
  ['a key of only spaces', { keys: ['   '] }],
  ['a key longer than a key can be', { keys: ['k'.repeat(1025)] }],
];

describe('POST /files/buckets/:bucketKey/objects/batch-delete', () => {
  const batchDelete = (keys: unknown) => stack.request('POST', '/files/buckets/work/objects/batch-delete', typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? keys : { keys });

  it('deletes the files it names: objects, Markdown copies and records, and answers which', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'docs/b.pdf', '%PDF', { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'docs/b.md', markdownSize: 3 });
    stack.putObject('work', 'docs/b.md', '# bee');
    await stack.putFile('work', 'keep.txt', 'stays');

    const res = await batchDelete(['a.txt', 'docs/b.pdf']);

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ deleted: ['a.txt', 'docs/b.pdf'], failed: [] });
    for (const key of ['a.txt', 'docs/b.pdf', 'docs/b.md']) expect(existsSync(stack.objectPath('work', key)), key).toBe(false);
    expect((await stack.records('work')).map((record) => record.key)).toEqual(['keep.txt']);
    expect(existsSync(stack.objectPath('work', 'keep.txt'))).toBe(true);
  });

  it('reports a key without a file as not found and deletes the rest, answering in the order the keys were named', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'b.txt', 'beta');

    const res = await batchDelete(['b.txt', 'nowhere.txt', 'a.txt']);

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ deleted: ['b.txt', 'a.txt'], failed: [{ key: 'nowhere.txt', error: 'File not found' }] });
  });

  it('counts a key named twice once', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');

    const res = await batchDelete(['a.txt', 'a.txt', 'gone.txt', 'gone.txt']);

    expect(stack.json(res)).toEqual({ deleted: ['a.txt'], failed: [{ key: 'gone.txt', error: 'File not found' }] });
  });

  it('does not stop at a file that cannot be deleted: the others go, and it is reported with a sentence', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'b.txt', 'beta');
    await stack.putFile('work', 'c.txt', 'gamma');
    stack.blockObject('work', 'b.txt');

    const res = await batchDelete(['a.txt', 'b.txt', 'c.txt']);

    expect(res.statusCode).toBe(200);
    const body = stack.json(res);
    expect(body.deleted).toEqual(['a.txt', 'c.txt']);
    expect(body.failed).toEqual([{ key: 'b.txt', error: expect.any(String) }]);
    expect(body.failed[0].error).not.toContain(stack.dir);
    expect(body.failed[0].error).not.toMatch(/EISDIR|errno|ENOENT/);
    // The file that could not be deleted keeps its record, so it can be tried again.
    expect((await stack.records('work')).map((record) => record.key)).toEqual(['b.txt']);
  });

  it('treats a file whose object is already gone from the provider as deleted', async () => {
    await stack.putFile('work', 'ghost.txt', 'now missing');
    rmSync(stack.objectPath('work', 'ghost.txt'));

    const res = await batchDelete(['ghost.txt']);

    expect(stack.json(res)).toEqual({ deleted: ['ghost.txt'], failed: [] });
    expect(await stack.record('work', 'ghost.txt')).toBeNull();
  });

  it('leaves a file with the same key in another bucket alone', async () => {
    await stack.putFile('work', 'same.txt', 'mine');
    await stack.putFile('other', 'same.txt', 'theirs');

    const res = await batchDelete(['same.txt']);

    expect(stack.json(res).deleted).toEqual(['same.txt']);
    expect(await stack.record('other', 'same.txt')).not.toBeNull();
    expect(existsSync(stack.objectPath('other', 'same.txt'))).toBe(true);
  });

  it(`takes as many as ${BATCH_MAX_KEYS} files at once`, async () => {
    const keys = Array.from({ length: BATCH_MAX_KEYS }, (_, index) => `bulk/f${String(index).padStart(3, '0')}.txt`);
    for (const key of keys) await stack.putFile('work', key, key);

    const res = await batchDelete(keys);

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ deleted: keys, failed: [] });
    expect(await stack.records('work')).toEqual([]);
  }, 30_000);

  it.each([...KEYS_WRONG, [`more than ${BATCH_MAX_KEYS} keys`, { keys: Array.from({ length: BATCH_MAX_KEYS + 1 }, (_, index) => `k${index}.txt`) }]] as Array<[string, unknown]>)(
    'is a 400 for %s, and deletes nothing',
    async (_label, body) => {
      await stack.putFile('work', 'a.txt', 'alpha');

      const res = await batchDelete(body);

      expect(res.statusCode).toBe(400);
      expect(stack.json(res)).toMatchObject({ code: 'invalid_request' });
      expect(await stack.records('work')).toHaveLength(1);
    },
  );

  it('is a 400 for a body that is no object', async () => {
    for (const body of ['null', '[]', '"a.txt"']) {
      const res = await stack.requestRaw('POST', '/files/buckets/work/objects/batch-delete', body);
      expect(res.statusCode, body).toBe(400);
    }
  });

  it('is a 409 for a switched-off bucket: nothing is deleted from it', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await disable('work');

    const res = await batchDelete(['a.txt']);

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_inactive' });
    expect(await stack.records('work')).toHaveLength(1);
    expect(existsSync(stack.objectPath('work', 'a.txt'))).toBe(true);
  });

  it('is a 404 for a bucket that does not exist', async () => {
    const res = await stack.request('POST', '/files/buckets/nobody/objects/batch-delete', { keys: ['a.txt'] });

    expect(res.statusCode).toBe(404);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_not_found' });
  });
});

/**
 * Two projects can each have a bucket of the same key on one provider (in separate folders): a key the batch names
 * is looked up in the caller's project only, so a file of the other project is "not found", never acted on.
 */
describe('the files of another project that has a bucket of the same key on the same provider', () => {
  let theirs: string;

  beforeEach(async () => {
    theirs = String((await stack.db.createProject({ tenantId: stack.tenantId, key: 'second', name: 'Second', createdBy: 'x' }))._id);
    await stack.db.createFileBucket({
      tenantId: stack.tenantId, projectId: theirs, key: 'work', name: 'Their work', providerKey: 'local', prefix: 'second-work', status: 'active', createdBy: 'x',
    } as never);
    for (const key of ['both.txt', 'only-theirs.txt']) {
      stack.putObject('second-work', key, `their ${key}`);
      await stack.db.createFileRecord({
        tenantId: stack.tenantId, projectId: theirs, providerKey: 'local', bucketKey: 'work', key, name: key, size: Buffer.byteLength(`their ${key}`),
        contentType: 'text/plain', markdownStatus: 'skipped', createdBy: 'x',
      });
    }
  });

  it('are not found by a batch delete: only the caller\'s own file of that key goes', async () => {
    await stack.putFile('work', 'both.txt', 'mine');

    const res = await stack.request('POST', '/files/buckets/work/objects/batch-delete', { keys: ['both.txt', 'only-theirs.txt'] });

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ deleted: ['both.txt'], failed: [{ key: 'only-theirs.txt', error: 'File not found' }] });
    expect(await stack.records('work')).toEqual([]);
    for (const key of ['both.txt', 'only-theirs.txt']) {
      expect(await stack.db.findFileRecordByKey('local', 'work', key, theirs), key).not.toBeNull();
      expect(existsSync(stack.objectPath('second-work', key)), key).toBe(true);
    }
  });

  it('are not found by an archive either: a 404 naming the key, and no ZIP', async () => {
    await stack.putFile('work', 'mine.txt', 'mine');

    const res = await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['mine.txt', 'only-theirs.txt'] });

    expect(res.statusCode).toBe(404);
    expect(stack.json(res)).toMatchObject({ code: 'file_not_found', keys: ['only-theirs.txt'] });
    expect(res.rawPayload.subarray(0, 2).toString()).not.toBe('PK');
  });

  it('are not put in an archive in place of the caller\'s own file of the same key', async () => {
    await stack.putFile('work', 'both.txt', 'mine, and only mine');

    const res = await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['both.txt'] });

    expect(res.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(await zip.file('both.txt')!.async('string')).toBe('mine, and only mine');
  });
});

describe('POST /files/buckets/:bucketKey/objects/archive', () => {
  const archive = (keys: unknown, bucket = 'work') =>
    stack.request('POST', `/files/buckets/${bucket}/objects/archive`, typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? keys : { keys });

  const open = (res: { rawPayload: Buffer }) => JSZip.loadAsync(res.rawPayload);
  const text = async (zip: JSZip, name: string) => zip.file(name)!.async('string');

  it('answers a ZIP of the files, named after the bucket, with each file under its own name in the order asked for', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'docs/b.pdf', '%PDF-1.4 not really', { contentType: 'application/pdf' });
    await stack.putFile('work', 'docs/deep/c.txt', 'gamma');
    await stack.putFile('work', 'left-out.txt', 'not asked for');

    const res = await archive(['docs/b.pdf', 'a.txt', 'docs/deep/c.txt']);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/zip/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="work-files\.zip"/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const zip = await open(res);
    expect(Object.keys(zip.files)).toEqual(['b.pdf', 'a.txt', 'c.txt']);
    expect(await text(zip, 'a.txt')).toBe('alpha');
    expect(await text(zip, 'b.pdf')).toBe('%PDF-1.4 not really');
    expect(await text(zip, 'c.txt')).toBe('gamma');
  });

  it('gives files of different folders that share a name different names, capitals not counting', async () => {
    await stack.putFile('work', 'x/report.txt', 'from x');
    await stack.putFile('work', 'y/report.txt', 'from y');
    await stack.putFile('work', 'z/Report.TXT', 'from z');

    const res = await archive(['x/report.txt', 'y/report.txt', 'z/Report.TXT']);

    const zip = await open(res);
    expect(Object.keys(zip.files)).toEqual(['report.txt', 'report (1).txt', 'Report (2).TXT']);
    expect(await text(zip, 'report.txt')).toBe('from x');
    expect(await text(zip, 'report (1).txt')).toBe('from y');
    expect(await text(zip, 'Report (2).TXT')).toBe('from z');
  });

  it('puts a file named twice in once', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');

    const res = await archive(['a.txt', 'a.txt']);

    expect(Object.keys((await open(res)).files)).toEqual(['a.txt']);
  });

  it('keeps a file of any content intact: binary bytes come out as they went in', async () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7 + 3) % 256));
    stack.putObject('work', 'blob.bin', bytes);
    await stack.db.createFileRecord({
      tenantId: stack.tenantId, projectId: stack.projectId, providerKey: 'local', bucketKey: 'work', key: 'blob.bin', name: 'blob.bin',
      size: bytes.length, contentType: 'application/octet-stream', markdownStatus: 'skipped', createdBy: stack.userId,
    });

    const res = await archive(['blob.bin']);

    const out = await (await open(res)).file('blob.bin')!.async('nodebuffer');
    expect(out.equals(bytes)).toBe(true);
  });

  it('still archives the files of a switched-off bucket: reading them is allowed', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');
    await disable('work');

    const res = await archive(['a.txt']);

    expect(res.statusCode).toBe(200);
    expect(await text(await open(res), 'a.txt')).toBe('alpha');
  });

  it('is a 404 naming the keys that have no file, and sends no ZIP', async () => {
    await stack.putFile('work', 'a.txt', 'alpha');

    const res = await archive(['a.txt', 'nowhere.txt', 'nor-here.txt']);

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(stack.json(res)).toMatchObject({ code: 'file_not_found', keys: ['nowhere.txt', 'nor-here.txt'] });
  });

  it('is a 404 for a bucket that does not exist', async () => {
    const res = await archive(['a.txt'], 'nobody');

    expect(res.statusCode).toBe(404);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_not_found' });
  });

  it.each([...KEYS_WRONG, ['more than 50 keys', { keys: Array.from({ length: 51 }, (_, index) => `k${index}.txt`) }]] as Array<[string, unknown]>)(
    'is a 400 for %s',
    async (_label, body) => {
      const res = await archive(body);

      expect(res.statusCode).toBe(400);
      expect(stack.json(res)).toMatchObject({ code: 'invalid_request' });
    },
  );

  it('takes as many as 50 files', async () => {
    const keys = Array.from({ length: 50 }, (_, index) => `many/f${String(index).padStart(2, '0')}.txt`);
    for (const key of keys) await stack.putFile('work', key, `content of ${key}`);

    const res = await archive(keys);

    expect(res.statusCode).toBe(200);
    const zip = await open(res);
    expect(Object.keys(zip.files)).toHaveLength(50);
    expect(await text(zip, 'f49.txt')).toBe('content of many/f49.txt');
  }, 30_000);

  describe('the size limit', () => {
    it('refuses files that add up to more than 200 MB with a 413, before any ZIP is started', async () => {
      await stack.putFile('work', 'big1.bin', 'x', { size: 150 * MIB });
      await stack.putFile('work', 'big2.bin', 'x', { size: 60 * MIB });

      const res = await archive(['big1.bin', 'big2.bin']);

      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toMatch(/json/);
      const body = stack.json(res);
      expect(body).toMatchObject({ code: 'archive_too_large', limitBytes: ARCHIVE_MAX_BYTES, totalBytes: 210 * MIB });
      expect(body.error).toContain('200 MB');
    });

    it('adds the sizes of the records up: they are what the files were stored as, so nothing is read to know', async () => {
      // The objects are tiny; only the records are large. A refusal can therefore only come from the records.
      await stack.putFile('work', 'one.bin', 'x', { size: 100 * MIB });
      await stack.putFile('work', 'two.bin', 'x', { size: 100 * MIB + 1 });
      rmSync(stack.objectPath('work', 'one.bin'));
      rmSync(stack.objectPath('work', 'two.bin'));

      const res = await archive(['one.bin', 'two.bin']);

      expect(res.statusCode).toBe(413);
      expect(stack.json(res).code).toBe('archive_too_large');
    });

    it('takes files that add up to exactly 200 MB', async () => {
      await stack.putFile('work', 'one.bin', 'first', { size: 100 * MIB });
      await stack.putFile('work', 'two.bin', 'second', { size: 100 * MIB });

      const res = await archive(['one.bin', 'two.bin']);

      expect(res.statusCode).toBe(200);
      expect(Object.keys((await open(res)).files)).toEqual(['one.bin', 'two.bin']);
    });
  });

  describe('a file larger than the server reads into memory at once', () => {
    it('is refused with a 413 before any ZIP is started, the other files with it', async () => {
      const ceiling = maxStorageDownloadBytes();
      await stack.putFile('work', 'small.txt', 'small');
      // Only the record is large: nothing is read to know.
      await stack.putFile('work', 'huge.bin', 'x', { size: ceiling + 1 });

      const res = await archive(['small.txt', 'huge.bin']);

      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(stack.json(res)).toMatchObject({ code: 'object_too_large', limitBytes: ceiling });
      expect(stack.json(res).error).toMatch(/larger than the \d+ MB this server reads into memory at once/);
      expect(res.rawPayload.subarray(0, 2).toString()).not.toBe('PK');
    });

    it('takes a file of exactly that size', async () => {
      await stack.putFile('work', 'edge.bin', 'the object itself is small', { size: maxStorageDownloadBytes() });

      const res = await archive(['edge.bin']);

      expect(res.statusCode).toBe(200);
      expect(Object.keys((await open(res)).files)).toEqual(['edge.bin']);
    });
  });
});

describe('POST /files/buckets/:bucketKey/import', () => {
  const importFiles = (body?: unknown) => stack.request('POST', '/files/buckets/work/import', body);
  const keys = async () => (await stack.records('work')).map((record) => record.key).sort();

  it('registers the objects that have no record, under their keys inside the bucket, as imported files', async () => {
    stack.putObject('work', 'a.txt', 'alpha');
    stack.putObject('work', 'docs/b.pdf', '%PDF-1.4');
    stack.putObject('work', 'docs/deep/c.csv', 'x,y\n1,2\n');
    stack.putObject('work', 'noextension', 'bytes');

    const res = await importFiles();

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ scanned: 4, imported: 4, skipped: 0 });
    expect(await keys()).toEqual(['a.txt', 'docs/b.pdf', 'docs/deep/c.csv', 'noextension']);
    const pdf = await stack.record('work', 'docs/b.pdf');
    expect(pdf).toMatchObject({
      name: 'b.pdf', size: 8, contentType: 'application/pdf', origin: 'import', markdownStatus: 'skipped',
      uploadedBy: stack.userId, createdBy: stack.userId, providerKey: 'local', bucketKey: 'work', projectId: stack.projectId,
    });
    expect(await stack.record('work', 'a.txt')).toMatchObject({ name: 'a.txt', contentType: 'text/plain', size: 5 });
    expect((await stack.record('work', 'noextension'))?.contentType ?? null).toBeNull();
  });

  it('shows the imported files in the bucket like any other, saying where they came from', async () => {
    stack.putObject('work', 'found.txt', 'was here already');
    await importFiles();

    const list = await stack.request('GET', '/files/buckets/work/objects');

    expect(list.statusCode).toBe(200);
    const item = stack.json(list).items.find((entry: { key: string }) => entry.key === 'found.txt');
    expect(item).toMatchObject({ name: 'found.txt', origin: 'import', markdownStatus: 'skipped', size: 16 });
    const download = await stack.request('GET', '/files/buckets/work/objects/found.txt?download=original');
    expect(download.statusCode).toBe(200);
    expect(download.body).toBe('was here already');
  });

  it('changes nothing in the provider: the objects stay as they were', async () => {
    stack.putObject('work', 'a.txt', 'alpha');
    stack.putObject('work', 'docs/b.txt', 'beta');

    await importFiles();

    expect(existsSync(stack.objectPath('work', 'a.txt'))).toBe(true);
    expect(existsSync(stack.objectPath('work', 'docs/b.txt'))).toBe(true);
    expect(await stack.db.listFileRecords({ providerKey: 'local', bucketKey: 'other', projectId: stack.projectId, limit: 10 })).toMatchObject({ items: [] });
  });

  it('can be run again: what it registered is skipped, and only the new objects are added', async () => {
    stack.putObject('work', 'a.txt', 'alpha');
    stack.putObject('work', 'b.txt', 'beta');
    await importFiles();
    const before = await stack.record('work', 'a.txt');

    stack.putObject('work', 'c.txt', 'gamma');
    const again = await importFiles();

    expect(stack.json(again)).toEqual({ scanned: 3, imported: 1, skipped: 2 });
    expect(await keys()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect((await stack.record('work', 'a.txt'))?._id).toEqual(before?._id);

    const third = await importFiles();
    expect(stack.json(third)).toEqual({ scanned: 3, imported: 0, skipped: 3 });
  });

  it('leaves the records it did not create as they are', async () => {
    await stack.putFile('work', 'mine.txt', 'uploaded here', { createdBy: stack.otherUserId, uploadedBy: stack.otherUserId, markdownStatus: 'succeeded', markdownKey: 'mine.md', markdownSize: 4 });
    stack.putObject('work', 'mine.md', 'copy');

    const res = await importFiles();

    expect(stack.json(res)).toEqual({ scanned: 2, imported: 0, skipped: 2 });
    expect(await stack.record('work', 'mine.txt')).toMatchObject({ uploadedBy: stack.otherUserId, markdownStatus: 'succeeded', markdownKey: 'mine.md' });
    // The Markdown copy of a file is not a file of its own.
    expect(await stack.record('work', 'mine.md')).toBeNull();
  });

  it('skips what the disk provider keeps beside the files: the metadata companions of uploaded objects', async () => {
    const uploaded = await stack.request('POST', '/files/buckets/work/objects', {
      fileName: 'lost-record.txt', data: Buffer.from('uploaded through the API').toString('base64'), contentType: 'text/plain', convertToMarkdown: false,
    });
    const { key } = stack.json(uploaded).record;
    // The record is lost; the object and its companion are still on the disk.
    await stack.db.deleteFileRecord(String((await stack.record('work', key))!._id));

    const res = await importFiles();

    expect(stack.json(res)).toEqual({ scanned: 2, imported: 1, skipped: 1 });
    expect(await keys()).toEqual([key]);
    // The original name was on the lost record: what is left to name the file by is its key.
    expect(await stack.record('work', key)).toMatchObject({ name: key, contentType: 'text/plain', origin: 'import' });
  });

  it('skips the folder the connection test of a provider writes to', async () => {
    stack.putObject('work', '.cognipeer-connection-test/probe.txt', 'x');
    stack.putObject('work', 'real.txt', 'y');

    const res = await importFiles();

    expect(stack.json(res)).toEqual({ scanned: 2, imported: 1, skipped: 1 });
    expect(await keys()).toEqual(['real.txt']);
  });

  it('imports nothing from a folder that does not exist yet', async () => {
    const res = await importFiles();

    expect(res.statusCode).toBe(200);
    expect(stack.json(res)).toEqual({ scanned: 0, imported: 0, skipped: 0 });
  });

  it('stays inside the bucket: another bucket\'s folder is not its files', async () => {
    stack.putObject('work', 'mine.txt', 'a');
    stack.putObject('other', 'theirs.txt', 'b');

    await importFiles();

    expect(await keys()).toEqual(['mine.txt']);
    expect(await stack.records('other')).toEqual([]);
  });

  describe('a storage location another bucket uses', () => {
    const SHARED = 'Another bucket uses this storage location, so objects in it cannot be imported.';
    const secondProject = async () => String((await stack.db.createProject({ tenantId: stack.tenantId, key: 'second', name: 'Second', createdBy: 'x' }))._id);
    const bucketOf = (projectId: string, key: string, over: Record<string, unknown> = {}) => stack.db.createFileBucket({
      tenantId: stack.tenantId, projectId, key, name: key, providerKey: 'local', status: 'active', createdBy: 'x', ...over,
    } as never);
    const importOf = (bucketKey: string) => stack.request('POST', `/files/buckets/${bucketKey}/import`, {});

    it('is a 409 when a bucket of another project has the same key: nothing is registered, nothing is touched', async () => {
      stack.putObject('work', 'theirs.txt', 'CONTENT OF THE OTHER PROJECT');
      await bucketOf(await secondProject(), 'work');

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toEqual({ error: SHARED, code: 'storage_location_shared' });
      expect(await keys()).toEqual([]);
      expect(readFileSync(stack.objectPath('work', 'theirs.txt'), 'utf8')).toBe('CONTENT OF THE OTHER PROJECT');
    });

    it.each([
      ['the same folder, named outright', { prefix: 'work' }],
      ['the provider\'s root', { prefix: '' }],
      ['a folder inside it', { prefix: 'work/archive' }],
    ])('is a 409 for a bucket of another project that keeps its files in %s', async (_label, over) => {
      stack.putObject('work', 'a.txt', 'alpha');
      await bucketOf(await secondProject(), 'elsewhere', over);

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(stack.json(res).code).toBe('storage_location_shared');
      expect(await keys()).toEqual([]);
    });

    // Buckets stored before keys and folders were validated can spell a folder in a way the drivers read as another
    // one (the disk driver drops `.` segments and doubled slashes, and reads a backslash as a slash).
    it.each([
      ['a key with a leading dot segment', './work', {}],
      ['a key with a leading dot segment and a closing slash', './work/', {}],
      ['a key with a backslash after a dot', '.\\work', {}],
      ['a folder with a leading dot segment', 'legacy', { prefix: './work' }],
      ['a folder of a run of dots', 'legacy', { prefix: '../work' }],
      ['a folder inside it, spelled with a backslash', 'legacy', { prefix: 'work\\archive' }],
      ['a folder inside it, with a dot segment in the middle', 'legacy', { prefix: 'work/./archive' }],
    ])('is a 409 for a bucket of another project saved with %s: the drivers read it as this folder', async (_label, key, over) => {
      stack.putObject('work', 'theirs.txt', 'CONTENT OF THE OTHER PROJECT');
      await bucketOf(await secondProject(), key, over);

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toEqual({ error: SHARED, code: 'storage_location_shared' });
      expect(await keys()).toEqual([]);
      expect(readFileSync(stack.objectPath('work', 'theirs.txt'), 'utf8')).toBe('CONTENT OF THE OTHER PROJECT');
    });

    it('does not take a bucket whose folder only looks alike for the same one: dots inside a name, and siblings', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      const second = await secondProject();
      await bucketOf(second, 'work.old');
      await bucketOf(second, 'legacy-1', { prefix: './work-archive' });
      await bucketOf(second, 'legacy-2', { prefix: 'other\\work' });

      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res)).toEqual({ scanned: 1, imported: 1, skipped: 0 });
    });

    it('is a 409 for a bucket of the same project whose folder is inside this one', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      await stack.createBucket('inner', { prefix: 'work/inner' });

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(await keys()).toEqual([]);
    });

    it('is a 409 for a bucket whose folder holds this one, the other way round', async () => {
      await stack.createBucket('nested', { prefix: 'team/nested' });
      stack.putObject('team/nested', 'a.txt', 'alpha');
      await bucketOf(await secondProject(), 'team');

      const res = await importOf('nested');

      expect(res.statusCode).toBe(409);
      expect(stack.json(res).code).toBe('storage_location_shared');
      expect(await stack.records('nested')).toEqual([]);
    });

    it('is a 409 for a bucket without a folder of its own, which would take in everything', async () => {
      await stack.createBucket('rootless', { prefix: '' });
      stack.putObject('work', 'a.txt', 'alpha');

      const res = await importOf('rootless');

      expect(res.statusCode).toBe(409);
      expect(stack.json(res).code).toBe('storage_location_shared');
      expect(await stack.records('rootless')).toEqual([]);
    });

    it.each([
      ['switched off', { status: 'disabled' }],
      ['being deleted', { status: 'disabled', metadata: { deleting: true } }],
    ])('counts a bucket that is %s: it still owns its files', async (_label, over) => {
      stack.putObject('work', 'a.txt', 'alpha');
      await bucketOf(await secondProject(), 'work', over);

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(await keys()).toEqual([]);
    });

    it('does not count buckets on other folders, however alike the names: the import goes ahead', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      const second = await secondProject();
      await bucketOf(second, 'work-archive');
      await bucketOf(second, 'ork');
      await bucketOf(second, 'wor');
      await bucketOf(second, 'elsewhere', { prefix: 'elsewhere/work' });

      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res)).toEqual({ scanned: 1, imported: 1, skipped: 0 });
    });

    it('does not count a bucket on another provider that has the same key', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      await bucketOf(await secondProject(), 'work', { providerKey: 'second-disk' });

      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res).imported).toBe(1);
    });

    it('goes ahead once the other bucket is gone, and the refusal left nothing behind', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      const other = await bucketOf(await secondProject(), 'work');
      expect((await importFiles()).statusCode).toBe(409);

      await stack.db.deleteFileBucket(String(other._id));
      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res)).toEqual({ scanned: 1, imported: 1, skipped: 0 });
      expect(await keys()).toEqual(['a.txt']);
    });
  });

  describe('a bucket that stops taking files while the import runs', () => {
    /** Runs `change` right after the first record of the import is saved: the bucket is closed in the middle of the run. */
    function closeAfterFirstRecord(change: () => Promise<unknown>) {
      const real = stack.db.createFileRecord.bind(stack.db);
      let closed = false;
      vi.spyOn(stack.db, 'createFileRecord').mockImplementation(async (record) => {
        const created = await real(record);
        if (!closed) {
          closed = true;
          await change();
        }
        return created;
      });
    }
    const bucketId = async () => String((await stack.bucket('work'))!._id);

    it.each([
      ['switched off', 'bucket_inactive', async () => stack.db.updateFileBucket(await bucketId(), { status: 'disabled' })],
      ['being deleted with its files', 'bucket_deleting', async () => stack.db.updateFileBucket(await bucketId(), { status: 'disabled', metadata: { deleting: true } })],
      ['deleted', 'bucket_deleting', async () => stack.db.deleteFileBucket(await bucketId())],
    ])('keeps no record of the run when the bucket is %s: the import is refused like a write to it', async (_label, code, change) => {
      stack.putObject('work', 'a.txt', 'alpha');
      stack.putObject('work', 'docs/b.txt', 'beta');
      stack.putObject('work', 'docs/c.txt', 'gamma');
      closeAfterFirstRecord(change);

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toMatchObject({ code });
      // Nothing is left that nobody could list or remove, and nothing counts against the project's limits.
      expect(await keys()).toEqual([]);
      expect(await stack.db.countFileRecords({ projectId: stack.projectId })).toBe(0);
      // An import never touches the provider.
      for (const name of ['a.txt', 'docs/b.txt', 'docs/c.txt']) expect(existsSync(stack.objectPath('work', name)), name).toBe(true);
    });

    it('leaves the records of an earlier run, and of the files that were already registered, alone', async () => {
      await stack.putFile('work', 'known.txt', 'registered before');
      stack.putObject('work', 'new.txt', 'fresh');
      closeAfterFirstRecord(async () => stack.db.updateFileBucket(await bucketId(), { status: 'disabled' }));

      const res = await importFiles();

      expect(res.statusCode).toBe(409);
      expect(await keys()).toEqual(['known.txt']);
    });

    it('is not in the way of an import into a bucket that stays open', async () => {
      stack.putObject('work', 'a.txt', 'alpha');
      stack.putObject('work', 'b.txt', 'beta');
      closeAfterFirstRecord(async () => undefined);

      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res)).toEqual({ scanned: 2, imported: 2, skipped: 0 });
      expect(await keys()).toEqual(['a.txt', 'b.txt']);
    });
  });

  describe('objects whose keys the drivers would rewrite', () => {
    it('are left out and counted as skipped, and stay where they are', async () => {
      const awkward = ['back\\slash.txt', 'dots..inside.txt', ' leading-space.txt', 'trailing-space.txt ', 'tab\there.txt', 'control\u0001.txt'];
      for (const name of awkward) stack.putObject('work', name, `content of ${JSON.stringify(name)}`);
      stack.putObject('work', 'fine.txt', 'fine');
      stack.putObject('work', 'dir/also fine.txt', 'fine too');

      const res = await importFiles();

      expect(stack.json(res)).toEqual({ scanned: 8, imported: 2, skipped: 6 });
      expect(await keys()).toEqual(['dir/also fine.txt', 'fine.txt']);
      for (const name of awkward) expect(existsSync(stack.objectPath('work', name)), JSON.stringify(name)).toBe(true);
    });

    it('cannot make a file that reads or deletes another object: the lookalike is untouched by a delete of the plain one', async () => {
      stack.putObject('work', 'report.final.txt', 'the real one');
      stack.putObject('work', 'report..final.txt', 'the lookalike');

      await importFiles();
      const deleted = await stack.request('DELETE', '/files/buckets/work/objects/report.final.txt');

      expect(deleted.statusCode).toBe(200);
      expect(await keys()).toEqual([]);
      expect(existsSync(stack.objectPath('work', 'report..final.txt'))).toBe(true);
      expect(await stack.record('work', 'report..final.txt')).toBeNull();
    });
  });

  describe('an object larger than the server reads into memory at once', () => {
    it('is registered like any object, nothing being read to do it, but cannot be downloaded or archived: 413', async () => {
      const ceiling = maxStorageDownloadBytes();
      const target = stack.putObject('work', 'huge.bin', '');
      // A sparse file: it takes no room on the disk.
      truncateSync(target, ceiling + 1);

      const imported = await importFiles();
      expect(stack.json(imported)).toEqual({ scanned: 1, imported: 1, skipped: 0 });
      expect(await stack.record('work', 'huge.bin')).toMatchObject({ size: ceiling + 1 });

      const download = await stack.request('GET', '/files/buckets/work/objects/huge.bin?download=original');
      expect(download.statusCode).toBe(413);
      expect(stack.json(download)).toMatchObject({ code: 'object_too_large', limitBytes: ceiling });

      const archived = await stack.request('POST', '/files/buckets/work/objects/archive', { keys: ['huge.bin'] });
      expect(archived.statusCode).toBe(413);
      expect(stack.json(archived)).toMatchObject({ code: 'object_too_large', limitBytes: ceiling });
    });

    it('judges a Markdown copy by the size of the copy, and the original by its own', async () => {
      const ceiling = maxStorageDownloadBytes();
      // A small file whose copy the record says is past the ceiling ...
      await stack.putFile('work', 'small.pdf', '%PDF-1.4', { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'small.md', markdownSize: ceiling + 1 });
      stack.putObject('work', 'small.md', '# small');
      // ... and a file the record says is past it, whose copy is small.
      await stack.putFile('work', 'big.pdf', '%PDF-1.4', { contentType: 'application/pdf', size: ceiling + 1, markdownStatus: 'succeeded', markdownKey: 'big.md', markdownSize: 7 });
      stack.putObject('work', 'big.md', '# small');

      const copyOfSmall = await stack.request('GET', '/files/buckets/work/objects/small.pdf?download=markdown');
      expect(copyOfSmall.statusCode).toBe(413);
      expect(stack.json(copyOfSmall)).toMatchObject({ code: 'object_too_large', limitBytes: ceiling });
      expect((await stack.request('GET', '/files/buckets/work/objects/small.pdf?download=original')).statusCode).toBe(200);

      const originalOfBig = await stack.request('GET', '/files/buckets/work/objects/big.pdf?download=original');
      expect(originalOfBig.statusCode).toBe(413);
      expect(stack.json(originalOfBig)).toMatchObject({ code: 'object_too_large', limitBytes: ceiling });
      const copyOfBig = await stack.request('GET', '/files/buckets/work/objects/big.pdf?download=markdown');
      expect(copyOfBig.statusCode).toBe(200);
      expect(copyOfBig.body).toBe('# small');
    });

    it('is refused by the disk driver itself when the record\'s size is out of date: a sentence, never the whole object', async () => {
      const ceiling = maxStorageDownloadBytes();
      await stack.putFile('work', 'grew.bin', 'it was small when it was registered');
      truncateSync(stack.objectPath('work', 'grew.bin'), ceiling + 1);

      const download = await stack.request('GET', '/files/buckets/work/objects/grew.bin?download=original');

      expect(download.statusCode).toBe(502);
      expect(stack.json(download)).toMatchObject({ code: 'storage_failure', error: expect.stringMatching(/larger than the \d+ MB this server reads into memory at once/) });
      expect(download.body).not.toContain(stack.dir);
    });
  });

  describe('a page at a time', () => {
    const names = Array.from({ length: 7 }, (_, index) => `f${index + 1}.txt`);

    it('stops after the limit with where to continue, and continues from there until the folder is done', async () => {
      names.forEach((name) => stack.putObject('work', name, name));

      const first = stack.json(await importFiles({ limit: 3 }));
      expect(first).toMatchObject({ scanned: 3, imported: 3, skipped: 0, nextCursor: expect.any(String) });
      expect(await keys()).toEqual(names.slice(0, 3));

      const second = stack.json(await importFiles({ limit: 3, cursor: first.nextCursor }));
      expect(second).toMatchObject({ scanned: 3, imported: 3, skipped: 0, nextCursor: expect.any(String) });

      const third = stack.json(await importFiles({ limit: 3, cursor: second.nextCursor }));
      expect(third).toEqual({ scanned: 1, imported: 1, skipped: 0 });
      expect(await keys()).toEqual(names);
    });

    it('imports every object once when the pages are followed, whatever the limit', async () => {
      names.forEach((name) => stack.putObject('work', name, name));
      stack.putObject('work', 'docs/inner.txt', 'inner');
      stack.putObject('work', 'Z-capital.txt', 'capital');
      const all = [...names, 'docs/inner.txt', 'Z-capital.txt'].sort();

      for (const limit of [1, 2, 4, 500]) {
        for (const record of await stack.records('work')) await stack.db.deleteFileRecord(String(record._id));
        let cursor: string | undefined;
        let imported = 0;
        let pages = 0;
        do {
          const page = stack.json(await importFiles({ limit, ...(cursor ? { cursor } : {}) }));
          imported += page.imported;
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor && pages < 30);
        expect(await keys(), `limit ${limit}`).toEqual(all);
        expect(imported, `limit ${limit}`).toBe(all.length);
      }
    });

    it('does nothing twice when a page is asked for again', async () => {
      names.forEach((name) => stack.putObject('work', name, name));
      const first = stack.json(await importFiles({ limit: 4 }));

      const again = stack.json(await importFiles({ limit: 4 }));

      expect(again).toMatchObject({ scanned: 4, imported: 0, skipped: 4, nextCursor: first.nextCursor });
      expect(await keys()).toHaveLength(4);
    });
  });

  it.each([
    ['a cursor that is no text', { cursor: 5 }],
    ['an empty cursor', { cursor: '' }],
    ['a cursor longer than any cursor is', { cursor: 'c'.repeat(2049) }],
    ['a limit of 0', { limit: 0 }],
    ['a negative limit', { limit: -3 }],
    ['a limit past 500', { limit: 501 }],
    ['a limit that is no whole number', { limit: 2.5 }],
    ['a limit that is text', { limit: '10' }],
    ['a limit that is null', { limit: null }],
  ])('is a 400 for %s, and registers nothing', async (_label, body) => {
    stack.putObject('work', 'a.txt', 'alpha');

    const res = await importFiles(body);

    expect(res.statusCode).toBe(400);
    expect(stack.json(res)).toMatchObject({ code: 'invalid_request' });
    expect(await keys()).toEqual([]);
  });

  it('takes a limit of 1 and of 500', async () => {
    stack.putObject('work', 'a.txt', 'alpha');
    stack.putObject('work', 'b.txt', 'beta');

    expect(stack.json(await importFiles({ limit: 1 }))).toMatchObject({ imported: 1, nextCursor: expect.any(String) });
    expect(stack.json(await importFiles({ limit: 500 }))).toMatchObject({ imported: 1 });
  });

  it('is a 400 for a body that is a list, not an object', async () => {
    const res = await stack.requestRaw('POST', '/files/buckets/work/import', '[1]');

    expect(res.statusCode).toBe(400);
  });

  it('is a 409 for a switched-off bucket, which takes nothing new', async () => {
    stack.putObject('work', 'a.txt', 'alpha');
    await disable('work');

    const res = await importFiles();

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_inactive' });
    expect(await keys()).toEqual([]);
  });

  it('is a 404 for a bucket that does not exist', async () => {
    const res = await stack.request('POST', '/files/buckets/nobody/import', {});

    expect(res.statusCode).toBe(404);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_not_found' });
  });

  describe('the project limits', () => {
    const limit = (quotas: Record<string, number>) => stack.db.createQuotaPolicy({
      tenantId: stack.tenantId, projectId: stack.projectId, scope: 'tenant', domain: 'file', priority: 0, enabled: true,
      limits: { quotas }, label: 'test limit',
    } as never);

    it('refuses an import that would pass the number of files the project may hold: 429, and registers nothing', async () => {
      await limit({ maxFilesTotal: 3 });
      await stack.putFile('other', 'already.txt', 'one');
      ['a.txt', 'b.txt', 'c.txt'].forEach((name) => stack.putObject('work', name, name));

      const res = await importFiles();

      expect(res.statusCode).toBe(429);
      expect(stack.json(res)).toMatchObject({ code: 'quota_exceeded' });
      expect(stack.json(res).error).toMatch(/3 files/);
      expect(await keys()).toEqual([]);
    });

    it('takes files up to the limit, the file that reaches it included', async () => {
      await limit({ maxFilesTotal: 3 });
      await stack.putFile('other', 'already.txt', 'one');
      ['a.txt', 'b.txt'].forEach((name) => stack.putObject('work', name, name));

      const res = await importFiles();

      expect(res.statusCode).toBe(200);
      expect(stack.json(res).imported).toBe(2);
    });

    it('counts only the files that are new: a second run over the same folder is not a quota question', async () => {
      await limit({ maxFilesTotal: 2 });
      ['a.txt', 'b.txt'].forEach((name) => stack.putObject('work', name, name));
      expect((await importFiles()).statusCode).toBe(200);

      const again = await importFiles();

      expect(again.statusCode).toBe(200);
      expect(stack.json(again)).toEqual({ scanned: 2, imported: 0, skipped: 2 });
    });

    it('refuses an import that would pass the bytes the project may store: 429', async () => {
      await limit({ maxStorageBytes: 10 });
      stack.putObject('work', 'a.txt', '123456');
      stack.putObject('work', 'b.txt', '1234567');

      const res = await importFiles();

      expect(res.statusCode).toBe(429);
      expect(stack.json(res)).toMatchObject({ code: 'quota_exceeded' });
      expect(await keys()).toEqual([]);
    });
  });
});

describe('who may use the new routes', () => {
  it('declares what the routes need: archive only reads (files read), the others resolve to files through the prefix map and write', async () => {
    const routes = await collectApiRoutes();
    const find = (method: string, url: string) => routes.find((route) => route.method === method && route.url === url);

    const archiveRoute = find('POST', '/api/files/buckets/:bucketKey/objects/archive');
    expect(archiveRoute, 'archive route').toBeDefined();
    expect(archiveRoute).toMatchObject({ declared: true, kind: 'service', gated: true, authz: { kind: 'service', service: 'files', level: 'read' } });

    for (const [method, url] of [
      ['PATCH', '/api/files/buckets/:bucketKey'],
      ['DELETE', '/api/files/buckets/:bucketKey'],
      ['POST', '/api/files/buckets/:bucketKey/convert'],
      ['POST', '/api/files/buckets/:bucketKey/objects/batch-delete'],
      ['POST', '/api/files/buckets/:bucketKey/import'],
    ] as const) {
      const route = find(method, url);
      expect(route, `${method} ${url}`).toBeDefined();
      expect(route, `${method} ${url}`).toMatchObject({ declared: false, kind: 'service', service: 'files', gated: true });
    }
  }, 60_000);
});
