/**
 * The Document Store's Markdown conversion in the background, through the REAL plugin over a real SQLite database,
 * the real local-disk driver, the real converter and the real (in-memory) queue:
 *
 *  - an upload through the dashboard route does not wait for the converter: the record is `pending`, a job fills it
 *    in (`succeeded`, `skipped` or `failed` with why);
 *  - POST /files/buckets/:bucketKey/convert queues a conversion again (202, record `pending`) and refuses what cannot
 *    be converted;
 *  - the job only runs a record that is still waiting, and gives up quietly on one that is gone;
 *  - the service's own default (the client API, agents) still converts before it returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsPromises, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';

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

import { getQueue } from '@/lib/core/queue';
import { uploadFile } from '@/lib/services/files/fileService';
import { startFilesQueueConsumer } from '@/lib/services/files/jobs/filesConsumer';
import { runMarkdownConversionJob } from '@/lib/services/files/jobs/markdownConversion';
import { uploadMaxBytes } from '@/lib/services/files/uploadLimits';
import { createFilesStack, FILES_DB_NAME, type FilesStack } from '../helpers/filesRealStack';
import { documentOf, MIB } from '../helpers/zipFixtures';

let stack: FilesStack;

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.createBucket('work', { name: 'Work files' });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stack.close();
});

const base64 = (content: string | Buffer) => Buffer.from(content).toString('base64');

const upload = (fileName: string, content: string | Buffer, extra: Record<string, unknown> = {}) =>
  stack.request('POST', '/files/buckets/work/objects', { fileName, data: base64(content), ...extra });

/** Waits until the conversion of a file is no longer waiting, and answers its record. */
const settled = (key: string) => vi.waitFor(async () => {
  const record = await stack.record('work', key);
  expect(record, `record of ${key}`).not.toBeNull();
  expect(record!.markdownStatus).not.toBe('pending');
  return record!;
}, { timeout: 15_000 });

const publishSpy = async () => vi.spyOn(await getQueue(), 'publish');

const jobPayload = (key: string) => ({
  tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', key, actor: stack.userId,
});

const runJob = (key: string) => stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob(jobPayload(key)));

describe('an upload through the dashboard route', () => {
  it('answers at once with the file pending, and the job fills in the copy', async () => {
    const res = await upload('notes.txt', 'Quarterly notes: revenue grew.');

    expect(res.statusCode).toBe(201);
    const { record } = stack.json(res);
    expect(record).toMatchObject({ name: 'notes.txt', markdownStatus: 'pending' });
    expect(record.origin).toBeUndefined();
    expect(record.markdownKey).toBeUndefined();
    // Nobody is consuming yet: the job waits, and the original is stored.
    expect(existsSync(stack.objectPath('work', record.key))).toBe(true);
    expect(await stack.record('work', record.key)).toMatchObject({ markdownStatus: 'pending' });

    await startFilesQueueConsumer();
    const done = await settled(record.key);

    expect(done).toMatchObject({ markdownStatus: 'succeeded', markdownContentType: 'text/markdown', updatedBy: stack.userId });
    expect(done.markdownSize).toBeGreaterThan(0);
    expect(done.markdownError ?? null).toBeNull();
    const copy = stack.objectPath('work', done.markdownKey!);
    expect(readFileSync(copy, 'utf8')).toContain('revenue grew');
  });

  it('is converted by a consumer that was already running', async () => {
    await startFilesQueueConsumer();

    const { record } = stack.json(await upload('running.txt', 'Already listening.'));
    const done = await settled(record.key);

    expect(done.markdownStatus).toBe('succeeded');
    expect(readFileSync(stack.objectPath('work', done.markdownKey!), 'utf8')).toContain('Already listening');
  });

  it('serves the finished copy as the Markdown variant of the file', async () => {
    await startFilesQueueConsumer();
    const { record } = stack.json(await upload('served.txt', 'Plain words to read back.'));
    await settled(record.key);

    const res = await stack.request('GET', `/files/buckets/work/objects/${record.key}?download=markdown`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Plain words to read back');
  });

  it('stores a file the converter has no reader for as skipped, without queueing anything', async () => {
    const publish = await publishSpy();

    const res = await upload('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { contentType: 'image/png' });

    expect(res.statusCode).toBe(201);
    expect(stack.json(res).record).toMatchObject({ name: 'photo.png', markdownStatus: 'skipped' });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ['an image', 'sketch.jpg'],
    ['an audio file', 'voice.mp3'],
    ['an archive', 'bundle.zip'],
    ['a Markdown file', 'readme.md'],
    ['a file with no extension', 'LICENSE'],
  ])('skips %s without queueing a job', async (_label, fileName) => {
    const publish = await publishSpy();

    const res = await upload(fileName, 'content');

    expect(res.statusCode).toBe(201);
    expect(stack.json(res).record.markdownStatus).toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not convert when the caller turns conversion off', async () => {
    const publish = await publishSpy();

    const res = await upload('plain.txt', 'Leave me as I am.', { convertToMarkdown: false });

    expect(res.statusCode).toBe(201);
    expect(stack.json(res).record).toMatchObject({ markdownStatus: 'skipped' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('ends as failed, with a reason, for a document the converter cannot read, and leaves the others alone', async () => {
    await startFilesQueueConsumer();

    const broken = stack.json(await upload('broken.pdf', 'this is not a pdf at all')).record;
    const fine = stack.json(await upload('fine.txt', 'a perfectly good text')).record;

    const failed = await settled(broken.key);
    const succeeded = await settled(fine.key);

    expect(failed.markdownStatus).toBe('failed');
    expect(failed.markdownError).toEqual(expect.any(String));
    expect(failed.markdownError!.length).toBeGreaterThan(0);
    expect(failed.markdownKey ?? null).toBeNull();
    expect(succeeded.markdownStatus).toBe('succeeded');
    // The original of the failed one is still there, and can be downloaded.
    expect(existsSync(stack.objectPath('work', broken.key))).toBe(true);
  });

  it('ends as failed when the copy cannot be stored, with a sentence that names no path of the machine', async () => {
    await startFilesQueueConsumer();
    // The disk refuses the write of the copy (and only of the copy), in the words of the operating system.
    const write = fsPromises.writeFile.bind(fsPromises);
    vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.md')) {
        throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${String(file)}'`), { code: 'EISDIR', errno: -21 });
      }
      return (write as (...args: unknown[]) => Promise<void>)(file, ...rest);
    });
    const { record } = stack.json(await upload('blocked.txt', 'text', { keyHint: 'blocked.txt' }));

    const done = await settled(record.key);

    expect(done.markdownStatus).toBe('failed');
    expect(done.markdownError).toEqual(expect.any(String));
    expect(done.markdownError).not.toContain(stack.dir);
    expect(done.markdownError).not.toMatch(/EISDIR|errno/);
  });

  it('is stored with the file failed, not refused, when the job cannot be queued', async () => {
    (await publishSpy()).mockRejectedValueOnce(new Error('redis is down at 10.0.0.7'));

    const res = await upload('queued.txt', 'The upload itself worked.');

    expect(res.statusCode).toBe(201);
    const { record } = stack.json(res);
    expect(record).toMatchObject({ name: 'queued.txt', markdownStatus: 'failed' });
    expect(record.markdownError).toMatch(/queue/i);
    expect(JSON.stringify(record)).not.toContain('redis');
    expect(JSON.stringify(record)).not.toContain('10.0.0.7');
    expect(existsSync(stack.objectPath('work', record.key))).toBe(true);
    expect(await stack.record('work', record.key)).toMatchObject({ markdownStatus: 'failed' });
  });
});

describe('POST /files/buckets/:bucketKey/convert', () => {
  const convert = (body: unknown) => stack.request('POST', '/files/buckets/work/convert', body);

  it('queues the conversion again: 202 with the record pending and the old error forgotten, then the job succeeds', async () => {
    await stack.putFile('work', 'retry.txt', 'Second time lucky.', { markdownStatus: 'failed', markdownError: 'The converter gave up.' });

    const res = await convert({ key: 'retry.txt' });

    expect(res.statusCode).toBe(202);
    const { record } = stack.json(res);
    expect(record).toMatchObject({ key: 'retry.txt', markdownStatus: 'pending', updatedBy: stack.userId });
    expect(record.markdownError ?? null).toBeNull();
    expect((await stack.record('work', 'retry.txt'))?.markdownError ?? null).toBeNull();

    await startFilesQueueConsumer();
    const done = await settled('retry.txt');

    expect(done.markdownStatus).toBe('succeeded');
    expect(readFileSync(stack.objectPath('work', done.markdownKey!), 'utf8')).toContain('Second time lucky');
  });

  it('converts a file that was converted before from what it holds now', async () => {
    await stack.putFile('work', 'again.txt', 'first version', {
      markdownStatus: 'succeeded', markdownKey: 'again.md', markdownSize: 5, markdownContentType: 'text/markdown',
    });
    stack.putObject('work', 'again.md', 'first version copy');
    writeFileSync(stack.objectPath('work', 'again.txt'), 'second version with news');

    const res = await convert({ key: 'again.txt' });
    expect(res.statusCode).toBe(202);
    expect(stack.json(res).record.markdownStatus).toBe('pending');
    // The copy that exists stays where it is until the new one replaces it.
    expect(readFileSync(stack.objectPath('work', 'again.md'), 'utf8')).toBe('first version copy');

    await startFilesQueueConsumer();
    const done = await settled('again.txt');

    expect(done.markdownStatus).toBe('succeeded');
    expect(readFileSync(stack.objectPath('work', 'again.md'), 'utf8')).toContain('second version with news');
  });

  it('works for a file that was imported, which has no copy yet', async () => {
    await stack.putFile('work', 'imported.csv', 'a,b\n1,2\n', { markdownStatus: 'skipped', origin: 'import', contentType: 'text/csv' });
    await startFilesQueueConsumer();

    expect((await convert({ key: 'imported.csv' })).statusCode).toBe(202);
    const done = await settled('imported.csv');

    expect(done).toMatchObject({ markdownStatus: 'succeeded', origin: 'import' });
    expect(readFileSync(stack.objectPath('work', done.markdownKey!), 'utf8')).toContain('1');
  });

  it('refuses a type the converter does not read: 415 conversion_unsupported, nothing changes', async () => {
    await stack.putFile('work', 'photo.png', 'png-bytes', { contentType: 'image/png' });
    const publish = await publishSpy();

    const res = await convert({ key: 'photo.png' });

    expect(res.statusCode).toBe(415);
    expect(stack.json(res)).toMatchObject({ code: 'conversion_unsupported' });
    expect((await stack.record('work', 'photo.png'))?.markdownStatus).toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a file past the size limit: 413 conversion_too_large', async () => {
    await stack.putFile('work', 'huge.txt', 'x', { size: uploadMaxBytes() + 1 });
    const publish = await publishSpy();

    const res = await convert({ key: 'huge.txt' });

    expect(res.statusCode).toBe(413);
    expect(stack.json(res)).toMatchObject({ code: 'conversion_too_large' });
    expect((await stack.record('work', 'huge.txt'))?.markdownStatus).toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });

  it('is a 404 for a file that is not in the bucket, and for a bucket that does not exist', async () => {
    const missing = await convert({ key: 'nowhere.txt' });
    expect(missing.statusCode).toBe(404);
    expect(stack.json(missing)).toMatchObject({ code: 'file_not_found' });

    const noBucket = await stack.request('POST', '/files/buckets/nobody/convert', { key: 'a.txt' });
    expect(noBucket.statusCode).toBe(404);
    expect(stack.json(noBucket)).toMatchObject({ code: 'bucket_not_found' });
  });

  it('is a 409 for a switched-off bucket: the copy would be a new object', async () => {
    await stack.putFile('work', 'a.txt', 'text');
    await stack.db.updateFileBucket(String((await stack.bucket('work'))!._id), { status: 'disabled' });

    const res = await convert({ key: 'a.txt' });

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_inactive' });
    expect((await stack.record('work', 'a.txt'))?.markdownStatus).toBe('skipped');
  });

  it.each([
    ['no key', {}],
    ['an empty key', { key: '' }],
    ['a key that is no text', { key: 7 }],
    ['a key that is only spaces', { key: '   ' }],
    ['a key longer than a key can be', { key: 'k'.repeat(1025) }],
  ])('is a 400 for %s', async (_label, body) => {
    const res = await convert(body);

    expect(res.statusCode).toBe(400);
    expect(stack.json(res)).toMatchObject({ code: 'invalid_request' });
  });

  it('is a 503 when the job cannot be queued, and the record then says it failed and why', async () => {
    await stack.putFile('work', 'a.txt', 'text');
    (await publishSpy()).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));

    const res = await convert({ key: 'a.txt' });

    expect(res.statusCode).toBe(503);
    expect(stack.json(res)).toMatchObject({ code: 'queue_unavailable' });
    expect(res.body).not.toContain('ECONNREFUSED');
    const record = await stack.record('work', 'a.txt');
    expect(record?.markdownStatus).toBe('failed');
    expect(record?.markdownError).toMatch(/queue/i);
    expect(record?.markdownError).not.toContain('ECONNREFUSED');

    // And it can be asked again.
    const again = await convert({ key: 'a.txt' });
    expect(again.statusCode).toBe(202);
  });
});

describe('the conversion job', () => {
  it('leaves a record alone that is no longer waiting, so a job run twice converts once', async () => {
    await stack.putFile('work', 'done.txt', 'original words', {
      markdownStatus: 'succeeded', markdownKey: 'done.md', markdownSize: 3, markdownContentType: 'text/markdown',
    });
    stack.putObject('work', 'done.md', 'the copy as it was');

    await runJob('done.txt');

    expect(readFileSync(stack.objectPath('work', 'done.md'), 'utf8')).toBe('the copy as it was');
    expect(await stack.record('work', 'done.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownSize: 3 });
  });

  it('does not touch a failed record either: only a new request makes it wait again', async () => {
    await stack.putFile('work', 'stuck.txt', 'text', { markdownStatus: 'failed', markdownError: 'Earlier reason.' });

    await runJob('stuck.txt');

    expect(await stack.record('work', 'stuck.txt')).toMatchObject({ markdownStatus: 'failed', markdownError: 'Earlier reason.' });
  });

  it('gives up quietly on a file that was deleted, and on a bucket that was', async () => {
    await expect(runJob('never-existed.txt')).resolves.toBeUndefined();
    await expect(stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload('a.txt'), bucketKey: 'nobody' }))).resolves.toBeUndefined();
    expect(existsSync(stack.objectPath('work', 'never-existed.md'))).toBe(false);
  });

  it('removes the copy it made when the file was deleted while it was converted', async () => {
    await stack.putFile('work', 'vanishing.txt', 'text that disappears', { markdownStatus: 'pending' });
    const real = stack.db.updateFileRecord.bind(stack.db);
    vi.spyOn(stack.db, 'updateFileRecord').mockImplementationOnce(async (id, patch) => {
      await stack.db.deleteFileRecord(id);
      return real(id, patch);
    });

    await runJob('vanishing.txt');

    expect(await stack.record('work', 'vanishing.txt')).toBeNull();
    expect(existsSync(stack.objectPath('work', 'vanishing.md'))).toBe(false);
  });

  it('marks a waiting record skipped when its file is of a kind that is not converted', async () => {
    await stack.putFile('work', 'cover.png', 'png-bytes', { markdownStatus: 'pending', contentType: 'image/png' });

    await runJob('cover.png');

    const record = await stack.record('work', 'cover.png');
    expect(record?.markdownStatus).toBe('skipped');
    expect(record?.markdownKey ?? null).toBeNull();
    expect(existsSync(stack.objectPath('work', 'cover.md'))).toBe(false);
  });

  it('marks a waiting record skipped, with why, when its file is past the size limit', async () => {
    await stack.putFile('work', 'enormous.txt', 'x', { markdownStatus: 'pending', size: uploadMaxBytes() + 1 });

    await runJob('enormous.txt');

    const record = await stack.record('work', 'enormous.txt');
    expect(record?.markdownStatus).toBe('skipped');
    expect(record?.markdownError).toMatch(/larger than the limit/i);
  });

  it('judges the size again on what it read: an object that holds more than its record says is skipped too', async () => {
    await stack.putFile('work', 'understated.txt', 'x', { markdownStatus: 'pending' });
    // The record says one byte; the object (a sparse file, it takes no room) is past the limit.
    truncateSync(stack.objectPath('work', 'understated.txt'), uploadMaxBytes() + 1);

    await runJob('understated.txt');

    const record = await stack.record('work', 'understated.txt');
    expect(record?.markdownStatus).toBe('skipped');
    expect(record?.markdownError).toMatch(/larger than the limit/i);
    expect(record?.markdownKey ?? null).toBeNull();
    expect(existsSync(stack.objectPath('work', 'understated.md'))).toBe(false);
  });

  it('marks a waiting record failed, with why, when the bucket was switched off meanwhile', async () => {
    await stack.putFile('work', 'late.txt', 'text', { markdownStatus: 'pending' });
    await stack.db.updateFileBucket(String((await stack.bucket('work'))!._id), { status: 'disabled' });

    await runJob('late.txt');

    const record = await stack.record('work', 'late.txt');
    expect(record?.markdownStatus).toBe('failed');
    expect(record?.markdownError).toMatch(/bucket/i);
  });

  it('marks a waiting record failed, with why, when the original is gone from the storage provider', async () => {
    await stack.putFile('work', 'lost.txt', 'text', { markdownStatus: 'pending' });
    rmSync(stack.objectPath('work', 'lost.txt'));

    await runJob('lost.txt');

    const record = await stack.record('work', 'lost.txt');
    expect(record?.markdownStatus).toBe('failed');
    expect(record?.markdownError).toEqual(expect.any(String));
    expect(record?.markdownError).not.toContain(stack.dir);
  });
});

/**
 * The copy is written before the record says so. Whatever happened to the record or its bucket meanwhile is read again
 * before anything is settled, and a copy that nothing will carry is removed - in the provider, where nothing lists it.
 */
describe('a conversion that is settled after another writer acted', () => {
  const copyWrites = (writes: { mock: { calls: unknown[][] } }) => writes.mock.calls.filter(([file]) => /\.md$/.test(String(file)));

  /** Runs the job queued for this record (a job names the record it was queued for). */
  const runFor = (record: { key: string; _id?: unknown }) =>
    stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload(record.key), recordId: String(record._id) }));

  /** Runs `act` at the second read of the record by id: the one the job makes after it has converted. */
  function afterConversion(act: (id: string) => Promise<unknown>) {
    const real = stack.db.findFileRecordById.bind(stack.db);
    let reads = 0;
    return vi.spyOn(stack.db, 'findFileRecordById').mockImplementation(async (id: string) => {
      reads += 1;
      if (reads === 2) await act(id);
      return real(id);
    });
  }

  describe('two jobs for one record', () => {
    it('take turns: the second finds the record settled and converts nothing, so the copy is written once and the record names it', async () => {
      const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes: revenue grew.', { markdownStatus: 'pending' });
      const writes = vi.spyOn(fsPromises, 'writeFile');
      const job = { ...jobPayload('notes.txt'), recordId: String(waiting._id) };

      await Promise.all([
        stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob(job)),
        stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob(job)),
      ]);

      expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'notes.md' });
      expect(copyWrites(writes)).toHaveLength(1);
      expect(readFileSync(stack.objectPath('work', 'notes.md'), 'utf8')).toContain('revenue grew');
      expect(existsSync(stack.objectPath('work', 'notes.txt.md'))).toBe(false);
    });

    it('do not hold up the jobs of other records', async () => {
      const first = await stack.putFile('work', 'one.txt', 'first words', { markdownStatus: 'pending' });
      const second = await stack.putFile('work', 'two.txt', 'second words', { markdownStatus: 'pending' });

      await Promise.all([first, second].map((record) => stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload(String(record.key)), recordId: String(record._id) }))));

      expect(await stack.record('work', 'one.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'one.md' });
      expect(await stack.record('work', 'two.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'two.md' });
    });

    it('take turns by the key too when the job comes from a node that sent no record id', async () => {
      await stack.putFile('work', 'older.txt', 'old node words', { markdownStatus: 'pending' });
      const writes = vi.spyOn(fsPromises, 'writeFile');

      await Promise.all([runJob('older.txt'), runJob('older.txt')]);

      expect(await stack.record('work', 'older.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'older.md' });
      expect(copyWrites(writes)).toHaveLength(1);
    });
  });

  it('leaves the record to the run that settled it first, and removes its own copy: no object is left that the record does not name', async () => {
    const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
    // Another node settles the record while this run converts, with a copy of its own under the other name.
    afterConversion(async (id) => {
      stack.putObject('work', 'notes.txt.md', '# the other run\'s copy');
      await stack.db.updateFileRecord(id, { markdownStatus: 'succeeded', markdownKey: 'notes.txt.md', markdownSize: 21, markdownContentType: 'text/markdown' });
    });

    await runFor(waiting);

    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'notes.txt.md', markdownSize: 21 });
    expect(readFileSync(stack.objectPath('work', 'notes.txt.md'), 'utf8')).toBe('# the other run\'s copy');
    expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(false);
  });

  it('keeps the copy the record already names when the other run wrote the same object', async () => {
    const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
    afterConversion(async (id) => {
      await stack.db.updateFileRecord(id, { markdownStatus: 'succeeded', markdownKey: 'notes.md', markdownSize: 15, markdownContentType: 'text/markdown' });
    });

    await runFor(waiting);

    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'notes.md', markdownSize: 15 });
    expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(true);
  });

  it('leaves a record as it is that another run settled and a new request has put back to waiting: this run\'s copy would be a second one', async () => {
    const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
    // The first run settled (a copy under another name), and a new request put the record back to waiting.
    afterConversion(async (id) => {
      stack.putObject('work', 'notes.txt.md', '# first run');
      await stack.db.updateFileRecord(id, { markdownStatus: 'pending', markdownKey: 'notes.txt.md', markdownSize: 11 });
    });

    await runFor(waiting);

    // The new request has its own job: this run neither settles the record nor leaves a second copy beside the first.
    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'pending', markdownKey: 'notes.txt.md' });
    expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(false);
    expect(existsSync(stack.objectPath('work', 'notes.txt.md'))).toBe(true);
  });

  describe('when the bucket stops taking files while the file is converted', () => {
    it('removes the copy and marks the file failed, with why, when the bucket began to be deleted', async () => {
      const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
      afterConversion(async () => stack.db.updateFileBucket(String((await stack.bucket('work'))!._id), { status: 'disabled', metadata: { deleting: true } }));

      await runFor(waiting);

      const record = await stack.record('work', 'notes.txt');
      expect(record?.markdownStatus).toBe('failed');
      expect(record?.markdownError).toMatch(/being deleted/i);
      expect(record?.markdownKey ?? null).toBeNull();
      expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(false);
      expect(existsSync(stack.objectPath('work', 'notes.txt'))).toBe(true);
    });

    it('does the same for a bucket that was only switched off', async () => {
      const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
      afterConversion(async () => stack.db.updateFileBucket(String((await stack.bucket('work'))!._id), { status: 'disabled' }));

      await runFor(waiting);

      const record = await stack.record('work', 'notes.txt');
      expect(record?.markdownStatus).toBe('failed');
      expect(record?.markdownError).toMatch(/not active/i);
      expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(false);
    });

    it('leaves no copy when the bucket is gone', async () => {
      const waiting = await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
      afterConversion(async () => stack.db.deleteFileBucket(String((await stack.bucket('work'))!._id)));

      await expect(runFor(waiting)).resolves.toBeUndefined();

      expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(false);
    });

    it('settles the file as usual when the bucket cannot be read again: not knowing is not a reason to drop a finished copy', async () => {
      await stack.putFile('work', 'notes.txt', 'Quarterly notes', { markdownStatus: 'pending' });
      const real = stack.db.findFileBucketByKey.bind(stack.db);
      vi.spyOn(stack.db, 'findFileBucketByKey').mockImplementation(async (...args) => {
        // Every lookup before the copy was written works; the first one after it fails.
        if (existsSync(stack.objectPath('work', 'notes.md'))) throw new Error('SQLITE_BUSY: database is locked');
        return real(...args);
      });

      await runJob('notes.txt');

      expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'notes.md' });
      expect(existsSync(stack.objectPath('work', 'notes.md'))).toBe(true);
    });
  });
});

describe('the consumer of the files queue', () => {
  it('registers once on a node, however often it is started', async () => {
    const queue = await getQueue();
    const consume = vi.spyOn(queue, 'consume');

    await startFilesQueueConsumer();
    await startFilesQueueConsumer();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]![0]).toBe('files');
    expect(queue.hasLocalConsumer('files')).toBe(true);
  });

  it('takes the jobs published before it started: the queue holds them until a node can run them', async () => {
    const first = stack.json(await upload('early-1.txt', 'queued before anyone listened')).record;
    const second = stack.json(await upload('early-2.txt', 'also queued before')).record;
    expect(first.markdownStatus).toBe('pending');
    expect(second.markdownStatus).toBe('pending');

    await startFilesQueueConsumer();

    expect((await settled(first.key)).markdownStatus).toBe('succeeded');
    expect((await settled(second.key)).markdownStatus).toBe('succeeded');
  });
});

describe('the service itself', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    bucketKey: 'work', fileName: 'service.txt', data: base64('Service words.'), createdBy: stack.userId, ...over,
  });
  const run = (over: Record<string, unknown> = {}) => uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, input(over) as never);

  it('converts before it returns by default: the client API and the agents do not wait for a job', async () => {
    const publish = await publishSpy();

    const { record } = await run();

    expect(record.markdownStatus).toBe('succeeded');
    expect(readFileSync(stack.objectPath('work', record.markdownKey!), 'utf8')).toContain('Service words');
    expect(publish).not.toHaveBeenCalled();
  });

  it('queues the conversion when asked to', async () => {
    const publish = await publishSpy();

    const { record } = await run({ markdown: 'queued' });

    expect(record.markdownStatus).toBe('pending');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('files', 'convert-markdown', expect.objectContaining({ bucketKey: 'work', key: record.key, actor: stack.userId }), expect.anything());
  });

  it('queues nothing for a file that would not be converted, or when conversion is off', async () => {
    const publish = await publishSpy();

    expect((await run({ markdown: 'queued', fileName: 'song.mp3' })).record.markdownStatus).toBe('skipped');
    expect((await run({ markdown: 'queued', convertToMarkdown: false })).record.markdownStatus).toBe('skipped');
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('the name of a Markdown copy', () => {
  const NOTES = 'MY OWN HAND-WRITTEN NOTES, DO NOT TOUCH';

  it('is the original\'s name with .md in place of its extension, in the original\'s folder', async () => {
    await stack.putFile('work', 'docs/plain.txt', 'words', { markdownStatus: 'pending' });

    await runJob('docs/plain.txt');

    expect(await stack.record('work', 'docs/plain.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'docs/plain.md' });
  });

  it('never takes the place of a file with the same stem: the copy of notes.txt is notes.txt.md, and notes.md stays as written', async () => {
    await stack.putFile('work', 'notes.md', NOTES);
    await stack.putFile('work', 'notes.txt', 'alpha beta gamma', { markdownStatus: 'pending' });

    await runJob('notes.txt');

    expect(await stack.record('work', 'notes.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'notes.txt.md' });
    expect(readFileSync(stack.objectPath('work', 'notes.txt.md'), 'utf8')).toContain('alpha beta gamma');
    expect(readFileSync(stack.objectPath('work', 'notes.md'), 'utf8')).toBe(NOTES);
    expect(await stack.record('work', 'notes.md')).toMatchObject({ size: NOTES.length, markdownStatus: 'skipped' });
  });

  it('leaves the other file whole when the original is deleted: only the file\'s own copy goes', async () => {
    await stack.putFile('work', 'notes.md', NOTES);
    await stack.putFile('work', 'notes.txt', 'alpha beta gamma', { markdownStatus: 'pending' });
    await runJob('notes.txt');

    const deleted = await stack.request('DELETE', '/files/buckets/work/objects/notes.txt');

    expect(deleted.statusCode).toBe(200);
    expect(existsSync(stack.objectPath('work', 'notes.txt.md'))).toBe(false);
    expect(readFileSync(stack.objectPath('work', 'notes.md'), 'utf8')).toBe(NOTES);
    const read = await stack.request('GET', '/files/buckets/work/objects/notes.md?download=original');
    expect(read.statusCode).toBe(200);
    expect(read.body).toBe(NOTES);
  });

  it('never takes the place of an object nobody registered, one put in the folder by another tool', async () => {
    stack.putObject('work', 'plan.md', 'NOT REGISTERED, NOT YOURS');
    await stack.putFile('work', 'plan.txt', 'the plan', { markdownStatus: 'pending' });

    await runJob('plan.txt');

    expect(await stack.record('work', 'plan.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'plan.txt.md' });
    expect(readFileSync(stack.objectPath('work', 'plan.md'), 'utf8')).toBe('NOT REGISTERED, NOT YOURS');
  });

  it('never takes the name of a file that has a record, though its object is gone', async () => {
    await stack.putFile('work', 'plan.md', 'the other file');
    // Removed by another tool; the file still has its record, and so still has the name.
    rmSync(stack.objectPath('work', 'plan.md'));
    await stack.putFile('work', 'plan.txt', 'the plan', { markdownStatus: 'pending' });

    await runJob('plan.txt');

    expect(await stack.record('work', 'plan.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'plan.txt.md' });
    expect(existsSync(stack.objectPath('work', 'plan.md'))).toBe(false);
    expect(await stack.record('work', 'plan.md')).toMatchObject({ markdownStatus: 'skipped' });
  });

  it('never takes the name of the Markdown copy of another file, though that copy\'s object is gone', async () => {
    await stack.putFile('work', 'plan.pdf', '%PDF-1.4', { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'plan.md', markdownSize: 5 });
    await stack.putFile('work', 'plan.txt', 'the plan', { markdownStatus: 'pending' });

    await runJob('plan.txt');

    expect(await stack.record('work', 'plan.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'plan.txt.md' });
    expect(await stack.record('work', 'plan.pdf')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'plan.md' });
    expect(existsSync(stack.objectPath('work', 'plan.md'))).toBe(false);
  });

  it('keeps two convertible files with one stem apart: each has its own copy, and deleting one leaves the other\'s', async () => {
    await stack.putFile('work', 'report.txt', 'from the text file', { markdownStatus: 'pending' });
    await stack.putFile('work', 'report.csv', 'x,y\n7,8\n', { markdownStatus: 'pending', contentType: 'text/csv' });

    await runJob('report.txt');
    await runJob('report.csv');

    const text = await stack.record('work', 'report.txt');
    const sheet = await stack.record('work', 'report.csv');
    expect(text).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'report.md' });
    expect(sheet).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'report.csv.md' });
    expect(readFileSync(stack.objectPath('work', 'report.md'), 'utf8')).toContain('from the text file');
    expect(readFileSync(stack.objectPath('work', 'report.csv.md'), 'utf8')).toContain('7');

    expect((await stack.request('DELETE', '/files/buckets/work/objects/report.txt')).statusCode).toBe(200);

    const read = await stack.request('GET', '/files/buckets/work/objects/report.csv?download=markdown');
    expect(read.statusCode).toBe(200);
    expect(read.body).toContain('7');
  });

  it('is never one name for two files whose conversions run at the same moment: each copy keeps its own content', async () => {
    await stack.putFile('work', 'twin.txt', 'from the text file', { markdownStatus: 'pending' });
    await stack.putFile('work', 'twin.csv', 'x,y\n7,8\n', { markdownStatus: 'pending', contentType: 'text/csv' });

    await Promise.all([runJob('twin.txt'), runJob('twin.csv')]);

    const text = (await stack.record('work', 'twin.txt'))!;
    const sheet = (await stack.record('work', 'twin.csv'))!;
    expect([text.markdownStatus, sheet.markdownStatus]).toEqual(['succeeded', 'succeeded']);
    expect(text.markdownKey).not.toBe(sheet.markdownKey);
    expect(readFileSync(stack.objectPath('work', text.markdownKey!), 'utf8')).toContain('from the text file');
    expect(readFileSync(stack.objectPath('work', sheet.markdownKey!), 'utf8')).toContain('7');
  });

  it('fails the conversion, with a sentence, when both names it could take belong to other files', async () => {
    await stack.putFile('work', 'both.md', 'first');
    await stack.putFile('work', 'both.txt.md', 'second');
    await stack.putFile('work', 'both.txt', 'the original', { markdownStatus: 'pending' });

    await runJob('both.txt');

    const record = await stack.record('work', 'both.txt');
    expect(record?.markdownStatus).toBe('failed');
    expect(record?.markdownError).toBe('The Markdown copy was not stored: the names it would take belong to other files of the bucket.');
    expect(record?.markdownKey ?? null).toBeNull();
    expect(readFileSync(stack.objectPath('work', 'both.md'), 'utf8')).toBe('first');
    expect(readFileSync(stack.objectPath('work', 'both.txt.md'), 'utf8')).toBe('second');
  });

  it('is decided the same way by the service\'s default, which converts before it returns', async () => {
    await stack.putFile('work', 'sync.md', NOTES);

    const { record } = await uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'sync.txt', keyHint: 'sync.txt', data: base64('plain words'), createdBy: stack.userId,
    } as never);

    expect(record).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'sync.txt.md' });
    expect(readFileSync(stack.objectPath('work', 'sync.md'), 'utf8')).toBe(NOTES);
  });
});

describe('uploading again under a whole key', () => {
  const ofKey = async (key: string) => (await stack.records('work')).filter((record) => record.key === key);

  it('replaces the file: one record, the same id, now describing the new bytes', async () => {
    const first = stack.json(await upload('nda.txt', 'first version', { keyHint: 'contracts/nda.txt', metadata: { round: 1 } })).record;
    const before = await stack.record('work', 'contracts/nda.txt');

    const second = stack.json(await upload('nda-final.txt', 'second, longer version', { keyHint: 'contracts/nda.txt', metadata: { round: 2 } })).record;

    expect(second.key).toBe(first.key);
    expect(second.id).toBe(first.id);
    const records = await ofKey('contracts/nda.txt');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: 'nda-final.txt',
      size: Buffer.byteLength('second, longer version'),
      markdownStatus: 'pending',
      createdBy: before!.createdBy,
      updatedBy: stack.userId,
    });
    expect(records[0]!.checksum).not.toBe(before!.checksum);
    expect(records[0]!.metadata).toMatchObject({ round: 2 });
    expect(records[0]!.metadata).not.toHaveProperty('round', 1);
    expect(new Date(records[0]!.createdAt!).getTime()).toBe(new Date(before!.createdAt!).getTime());
    expect(readFileSync(stack.objectPath('work', 'contracts/nda.txt'), 'utf8')).toBe('second, longer version');
  });

  it('converts the new bytes: the job settles the one record, and its copy is of the new text', async () => {
    await upload('nda.txt', 'first version of the agreement', { keyHint: 'contracts/nda.txt' });
    await upload('nda.txt', 'second version of the agreement', { keyHint: 'contracts/nda.txt' });
    // Both uploads are done and the one object holds the last version: the jobs, which wait in the queue, read it whole
    // (a job that read while the second upload was still writing could see half of it).
    await startFilesQueueConsumer();

    const done = await settled('contracts/nda.txt');

    expect(done.markdownStatus).toBe('succeeded');
    expect(await ofKey('contracts/nda.txt')).toHaveLength(1);
    const copy = readFileSync(stack.objectPath('work', done.markdownKey!), 'utf8');
    expect(copy).toContain('second version');
    expect(copy).not.toContain('first version');
  });

  it('lets go of the Markdown copy of the old bytes, and its object is removed', async () => {
    await startFilesQueueConsumer();
    await upload('nda.txt', 'first version of the agreement', { keyHint: 'contracts/nda.txt' });
    const converted = await settled('contracts/nda.txt');
    const oldCopy = stack.objectPath('work', converted.markdownKey!);
    expect(existsSync(oldCopy)).toBe(true);

    const second = stack.json(await upload('nda.txt', 'second version of the agreement', { keyHint: 'contracts/nda.txt', convertToMarkdown: false })).record;

    expect(second).toMatchObject({ markdownStatus: 'skipped' });
    expect(second.markdownKey ?? null).toBeNull();
    expect(second.markdownSize ?? null).toBeNull();
    expect(second.markdownContentType ?? null).toBeNull();
    expect(existsSync(oldCopy)).toBe(false);
    const stored = await stack.record('work', 'contracts/nda.txt');
    expect(stored).toMatchObject({ markdownStatus: 'skipped' });
    expect(stored!.markdownKey ?? null).toBeNull();
    const served = await stack.request('GET', '/files/buckets/work/objects/contracts%2Fnda.txt?download=markdown');
    expect(served.statusCode).toBe(409);
  });

  it('takes the name of the copy again when the new bytes are converted', async () => {
    await startFilesQueueConsumer();
    await upload('nda.txt', 'first version of the agreement', { keyHint: 'contracts/nda.txt' });
    const first = await settled('contracts/nda.txt');
    expect(first.markdownKey).toBe('contracts/nda.md');

    await upload('nda.txt', 'second version of the agreement', { keyHint: 'contracts/nda.txt' });
    const second = await vi.waitFor(async () => {
      const record = await stack.record('work', 'contracts/nda.txt');
      expect(record!.markdownStatus).toBe('succeeded');
      expect(readFileSync(stack.objectPath('work', record!.markdownKey!), 'utf8')).toContain('second version');
      return record!;
    }, { timeout: 15_000 });

    expect(second.markdownKey).toBe('contracts/nda.md');
    expect(existsSync(stack.objectPath('work', 'contracts/nda.txt.md'))).toBe(false);
  });

  it('with the service\'s own default (converting before it returns) leaves one copy, under one name', async () => {
    const put = (content: string) => uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'sync.txt', keyHint: 'docs/sync.txt', data: base64(content), createdBy: stack.userId,
    } as never);

    const first = (await put('first words')).record;
    const second = (await put('second words')).record;

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'docs/sync.md' });
    expect(readFileSync(stack.objectPath('work', 'docs/sync.md'), 'utf8')).toContain('second words');
    expect(await ofKey('docs/sync.txt')).toHaveLength(1);
    expect((await stack.records('work')).map((record) => record.key)).toEqual(['docs/sync.txt']);
  });

  it('keeps what the record says about its place: the session a file belongs to, and when it expires', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    await stack.putFile('work', 'chats/agent/s1/report.txt', 'old words', {
      purpose: 'conversation', conversationId: 'conv-1', agentKey: 'agent', uploadedBy: stack.userId, expiresAt,
    });

    const { record } = await uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'report.txt', keyHint: 'chats/agent/s1/report.txt', data: base64('new words'), convertToMarkdown: false, createdBy: stack.userId,
    } as never);

    expect(record).toMatchObject({ purpose: 'conversation', conversationId: 'conv-1', agentKey: 'agent', uploadedBy: stack.userId });
    expect(new Date(record.expiresAt!).getTime()).toBe(expiresAt.getTime());
    expect(await ofKey('chats/agent/s1/report.txt')).toHaveLength(1);
    expect(readFileSync(stack.objectPath('work', 'chats/agent/s1/report.txt'), 'utf8')).toBe('new words');
  });

  it('settles on one record when two uploads to the key are made at the same moment', async () => {
    const results = await Promise.all([
      upload('race.txt', 'the first of two uploads', { keyHint: 'race/race.txt' }),
      upload('race.txt', 'the second upload, which is longer than the first', { keyHint: 'race/race.txt' }),
    ]);

    expect(results.map((res) => res.statusCode)).toEqual([201, 201]);
    const records = await ofKey('race/race.txt');
    expect(records).toHaveLength(1);
    // The record describes the bytes that are stored, whichever upload came last.
    const stored = readFileSync(stack.objectPath('work', 'race/race.txt'));
    expect(records[0]!.size).toBe(stored.length);
    expect(records[0]!.checksum).toBe(createHash('sha256').update(stored).digest('hex'));
  });

  it('does not touch the uploads to a folder or with no key: each is a file of its own', async () => {
    const one = stack.json(await upload('same.txt', 'one', { keyHint: 'folder/' })).record;
    const two = stack.json(await upload('same.txt', 'two', { keyHint: 'folder/' })).record;
    const three = stack.json(await upload('same.txt', 'three')).record;
    const four = stack.json(await upload('same.txt', 'four')).record;

    expect(new Set([one.id, two.id, three.id, four.id]).size).toBe(4);
    expect(new Set([one.key, two.key, three.key, four.key]).size).toBe(4);
  });

  it('keeps the object when the record could not be updated: the file is still there to be listed and deleted', async () => {
    await upload('keep.txt', 'first words', { keyHint: 'keep/keep.txt' });
    vi.spyOn(stack.db, 'updateFileRecord').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    const res = await upload('keep.txt', 'second words', { keyHint: 'keep/keep.txt' });

    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(await ofKey('keep/keep.txt')).toHaveLength(1);
    expect(existsSync(stack.objectPath('work', 'keep/keep.txt'))).toBe(true);
  });

  it('keeps the file\'s record when the bucket stopped taking files during the upload, and refuses the upload', async () => {
    await upload('closing.txt', 'first words', { keyHint: 'closing/closing.txt' });
    const bucket = await stack.bucket('work');
    const real = stack.db.updateFileRecord.bind(stack.db);
    vi.spyOn(stack.db, 'updateFileRecord').mockImplementationOnce(async (id, patch) => {
      const updated = await real(id, patch);
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled' } as never);
      return updated;
    });

    const res = await upload('closing.txt', 'second words', { keyHint: 'closing/closing.txt' });

    expect(res.statusCode).toBe(409);
    // The record of the file that was there stays, and describes the object as it is.
    const records = await ofKey('closing/closing.txt');
    expect(records).toHaveLength(1);
    expect(records[0]!.size).toBe(Buffer.byteLength('second words'));
    expect(existsSync(stack.objectPath('work', 'closing/closing.txt'))).toBe(true);
  });

  it('drops a conversion whose bytes were replaced while it ran: it settles nothing and leaves no copy of the old bytes', async () => {
    const waiting = await stack.putFile('work', 'moving.txt', 'the bytes that were read', { markdownStatus: 'pending', checksum: 'before', etag: '"before"' });
    const real = stack.db.findFileRecordById.bind(stack.db);
    let reads = 0;
    vi.spyOn(stack.db, 'findFileRecordById').mockImplementation(async (id: string) => {
      reads += 1;
      // The first read is the job's own, at its start; the second is after the conversion: an upload has replaced the file.
      if (reads === 2) await stack.db.updateFileRecord(id, { size: 99, checksum: 'after', etag: '"after"', markdownStatus: 'pending' });
      return real(id);
    });

    await stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload('moving.txt'), recordId: String(waiting._id) }));

    expect(reads).toBeGreaterThanOrEqual(2);
    const record = await stack.record('work', 'moving.txt');
    expect(record).toMatchObject({ markdownStatus: 'pending', checksum: 'after' });
    expect(record!.markdownKey ?? null).toBeNull();
    expect(String(waiting._id)).toBe(String(record!._id));
    expect(existsSync(stack.objectPath('work', 'moving.md'))).toBe(false);
    expect(existsSync(stack.objectPath('work', 'moving.txt.md'))).toBe(false);
  });

  it('settles a conversion whose file was written again with the very same bytes', async () => {
    await stack.putFile('work', 'same.txt', 'unchanged words', { markdownStatus: 'pending', checksum: 'same', etag: '"same"' });

    await runJob('same.txt');

    expect(await stack.record('work', 'same.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'same.md' });
  });

  it('runs the job of the record it was queued for, not the first record of the key', async () => {
    await stack.putFile('work', 'twice.txt', 'older record', { markdownStatus: 'succeeded', markdownKey: 'twice.md', markdownSize: 3 });
    stack.putObject('work', 'twice.md', 'older copy');
    const newer = await stack.db.createFileRecord({
      tenantId: stack.tenantId, projectId: stack.projectId, providerKey: 'local', bucketKey: 'work', key: 'twice.txt', name: 'twice.txt',
      size: 12, contentType: 'text/plain', markdownStatus: 'pending', createdBy: stack.userId,
    });

    await stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload('twice.txt'), recordId: String(newer._id) }));

    const after = await stack.db.findFileRecordById(String(newer._id));
    expect(after?.markdownStatus).toBe('succeeded');
    // The older record, which was already converted, is left alone and so is its copy.
    expect(readFileSync(stack.objectPath('work', 'twice.md'), 'utf8')).toBe('older copy');
  });

  it('ignores a job whose record is another file\'s: an id and a key that do not belong together convert nothing', async () => {
    const other = await stack.putFile('work', 'other.txt', 'other', { markdownStatus: 'pending' });
    await stack.putFile('work', 'named.txt', 'named', { markdownStatus: 'pending' });

    await stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload('named.txt'), recordId: String(other._id) }));

    expect((await stack.record('work', 'other.txt'))?.markdownStatus).toBe('pending');
    expect((await stack.record('work', 'named.txt'))?.markdownStatus).toBe('pending');
  });
});

describe('a conversion job whose lookups fail', () => {
  it('leaves the file failed, with a sentence that shows nothing of the database, not waiting for ever', async () => {
    await stack.putFile('work', 'a.txt', 'text', { markdownStatus: 'pending' });
    vi.spyOn(stack.db, 'findFileBucketByKey').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    await expect(runJob('a.txt')).resolves.toBeUndefined();

    const record = await stack.record('work', 'a.txt');
    expect(record?.markdownStatus).toBe('failed');
    expect(record?.markdownError).toEqual(expect.any(String));
    expect(record?.markdownError).not.toMatch(/SQLITE|locked/);
  });

  it('does the same when the lookup of the record is what fails', async () => {
    const record = await stack.putFile('work', 'b.txt', 'text', { markdownStatus: 'pending' });
    vi.spyOn(stack.db, 'findFileRecordById').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    await stack.db.runWithTenant(FILES_DB_NAME, () => runMarkdownConversionJob({ ...jobPayload('b.txt'), recordId: String(record._id) }));

    expect((await stack.record('work', 'b.txt'))?.markdownStatus).toBe('failed');
  });

  it('does not throw when nothing at all can be written down, and the file stays as it was', async () => {
    await stack.putFile('work', 'c.txt', 'text', { markdownStatus: 'pending' });
    vi.spyOn(stack.db, 'findFileBucketByKey').mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

    await expect(runJob('c.txt')).resolves.toBeUndefined();

    expect((await stack.record('work', 'c.txt'))?.markdownStatus).toBe('pending');
  });

  it('leaves a file that was settled meanwhile as it is', async () => {
    await stack.putFile('work', 'd.txt', 'text', { markdownStatus: 'succeeded', markdownKey: 'd.md', markdownSize: 1 });
    vi.spyOn(stack.db, 'findFileBucketByKey').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

    await runJob('d.txt');

    expect(await stack.record('work', 'd.txt')).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'd.md' });
  });
});

describe('a document that unpacks to far more than its size', () => {
  const BOMB_MESSAGE = 'The document unpacks to more than 100 MB, so it was not converted.';
  const bomb = () => documentOf(101 * MIB);

  it('ends as failed, with a sentence, through the background job; the original is kept and the others go on', async () => {
    await startFilesQueueConsumer();
    const archive = bomb();
    expect(archive.length).toBeLessThan(1_000_000);

    const bad = stack.json(await upload('bomb.docx', archive)).record;
    const fine = stack.json(await upload('fine.txt', 'a perfectly good text')).record;

    const failed = await settled(bad.key);
    expect(failed.markdownStatus).toBe('failed');
    expect(failed.markdownError).toBe(BOMB_MESSAGE);
    expect(failed.markdownKey ?? null).toBeNull();
    expect(existsSync(stack.objectPath('work', bad.key))).toBe(true);
    expect((await settled(fine.key)).markdownStatus).toBe('succeeded');
  });

  it('is turned away by the service\'s default too, which converts before it returns: the upload stays, the conversion failed', async () => {
    const { record } = await uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'bomb.docx', data: bomb(), createdBy: stack.userId,
    } as never);

    expect(record).toMatchObject({ markdownStatus: 'failed', markdownError: BOMB_MESSAGE });
    expect(existsSync(stack.objectPath('work', record.key))).toBe(true);
  });

  it('is turned away when a file that was imported is converted from its page', async () => {
    stack.putObject('work', 'imported.docx', bomb());
    await stack.db.createFileRecord({
      tenantId: stack.tenantId, projectId: stack.projectId, providerKey: 'local', bucketKey: 'work', key: 'imported.docx', name: 'imported.docx',
      size: bomb().length, markdownStatus: 'skipped', origin: 'import', createdBy: stack.userId,
    });
    await startFilesQueueConsumer();

    expect((await stack.request('POST', '/files/buckets/work/convert', { key: 'imported.docx' })).statusCode).toBe(202);
    const done = await settled('imported.docx');

    expect(done).toMatchObject({ markdownStatus: 'failed', markdownError: BOMB_MESSAGE });
  });
});
