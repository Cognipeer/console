/**
 * The Document Store's writes to a bucket through the REAL plugin over a real SQLite database and the real
 * local-disk driver (the queue is the real in-memory one):
 *
 *  - PATCH /files/buckets/:bucketKey - every field is checked on the server, the prefix is fixed once the bucket
 *    holds files, the metadata keeps the marks the file service writes for itself, a bucket that is being deleted
 *    is not changed;
 *  - DELETE /files/buckets/:bucketKey?deleteFiles=true - 202 and a background job that removes the objects, then the
 *    records, then the bucket; a failure leaves the bucket where it is, with why, and the delete can be asked again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, writeFileSync, existsSync, promises as fsPromises } from 'node:fs';

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
import { startFilesQueueConsumer } from '@/lib/services/files/jobs/filesConsumer';
import { runBucketDeletionJob } from '@/lib/services/files/jobs/bucketDeletion';
import { createFilesStack, FILES_DB_NAME, type FilesStack } from '../helpers/filesRealStack';

let stack: FilesStack;

beforeEach(async () => {
  vi.clearAllMocks();
  stack = await createFilesStack(hoisted.getDatabase);
  await stack.createBucket('work', { name: 'Work files', description: 'Everything in progress' });
  await stack.createBucket('empty', { prefix: 'e' });
});

afterEach(async () => {
  await stack.close();
});

/** The object of a file where the disk driver keeps it, replaced by a folder: removing it then fails. */
const makeUndeletable = (bucketPrefix: string, key: string) => stack.blockObject(bucketPrefix, key);

describe('PATCH /files/buckets/:bucketKey', () => {
  it('changes the name, description and status, and answers the bucket', async () => {
    const res = await stack.request('PATCH', '/files/buckets/work', { name: '  Work in progress ', description: 'Drafts only', status: 'disabled' });

    expect(res.statusCode).toBe(200);
    expect(stack.json(res).bucket).toMatchObject({ key: 'work', name: 'Work in progress', description: 'Drafts only', status: 'disabled', updatedBy: stack.userId });
    expect(await stack.bucket('work')).toMatchObject({ name: 'Work in progress', description: 'Drafts only', status: 'disabled' });
  });

  it('never changes the key or the provider, whatever the body says', async () => {
    const res = await stack.request('PATCH', '/files/buckets/work', { key: 'other', providerKey: 'elsewhere', name: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(await stack.bucket('work')).toMatchObject({ key: 'work', providerKey: 'local', name: 'Renamed' });
    expect(await stack.bucket('other')).toBeNull();
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: '   ' }, 'name'],
    [{ name: 'n'.repeat(121) }, 'name'],
    [{ name: 42 }, 'name'],
    [{ description: 7 }, 'description'],
    [{ description: 'd'.repeat(1001) }, 'description'],
    [{ status: 'paused' }, 'status'],
    [{ status: null }, 'status'],
    [{ prefix: '../outside' }, 'prefix'],
    [{ prefix: 'a//b' }, 'prefix'],
    [{ prefix: 'back\\slash' }, 'prefix'],
    [{ prefix: 12 }, 'prefix'],
    [{ metadata: 'text' }, 'metadata'],
    [{ metadata: ['a'] }, 'metadata'],
  ])('refuses %j with 400 naming %s, and changes nothing', async (body, field) => {
    const res = await stack.request('PATCH', '/files/buckets/work', body);

    expect(res.statusCode).toBe(400);
    expect(stack.json(res)).toMatchObject({ code: 'invalid_request', error: expect.stringContaining(field) });
    expect(await stack.bucket('work')).toMatchObject({ name: 'Work files', description: 'Everything in progress', status: 'active' });
  });

  it('refuses a body that is not a JSON object', async () => {
    for (const body of ['null', '[]', '"text"', '7']) {
      const res = await stack.requestRaw('PATCH', '/files/buckets/work', body);
      expect(res.statusCode, body).toBe(400);
      expect(stack.json(res).code, body).toBe('invalid_request');
    }
    expect((await stack.bucket('work'))?.name).toBe('Work files');
  });

  it('is a 404 for a bucket that does not exist', async () => {
    const res = await stack.request('PATCH', '/files/buckets/nobody', { name: 'x' });
    expect(res.statusCode).toBe(404);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_not_found' });
  });

  describe('the prefix', () => {
    it('can change while the bucket holds no file', async () => {
      const res = await stack.request('PATCH', '/files/buckets/empty', { prefix: '/archive/2026/' });

      expect(res.statusCode).toBe(200);
      expect(stack.json(res).bucket.prefix).toBe('archive/2026');
      expect((await stack.bucket('empty'))?.prefix).toBe('archive/2026');
    });

    it('is fixed once the bucket holds a file: 409 prefix_locked', async () => {
      await stack.putFile('work', 'a.txt', 'hello');

      const res = await stack.request('PATCH', '/files/buckets/work', { prefix: 'moved', name: 'Not applied either' });

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toMatchObject({ code: 'prefix_locked' });
      expect(await stack.bucket('work')).toMatchObject({ name: 'Work files' });
    });

    it('may be sent again unchanged, with or without its slashes, so a form can send every field', async () => {
      await stack.putFile('work', 'a.txt', 'hello');
      // The bucket was made without a prefix: its folder is its key.
      for (const prefix of ['work', '/work/', ' work ']) {
        const res = await stack.request('PATCH', '/files/buckets/work', { prefix, name: `Named via ${prefix.trim()}` });
        expect(res.statusCode).toBe(200);
      }
    });

    it('does not count the files of another bucket', async () => {
      await stack.putFile('work', 'a.txt', 'hello');
      const res = await stack.request('PATCH', '/files/buckets/empty', { prefix: 'free' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('the metadata', () => {
    it('is replaced by what the caller sends, without the keys the file service keeps for itself', async () => {
      const res = await stack.request('PATCH', '/files/buckets/work', { metadata: { team: 'legal', deleting: true, deleteError: 'made up' } });

      expect(res.statusCode).toBe(200);
      expect((await stack.bucket('work'))?.metadata).toEqual({ team: 'legal' });
    });

    it('keeps the reason a deletion stopped while the caller replaces the rest', async () => {
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { metadata: { team: 'old', deleteError: '1 file could not be deleted.' } });

      const res = await stack.request('PATCH', '/files/buckets/work', { metadata: { team: 'new' } });

      expect(res.statusCode).toBe(200);
      expect((await stack.bucket('work'))?.metadata).toEqual({ team: 'new', deleteError: '1 file could not be deleted.' });
    });

    it('drops that reason when the bucket is switched on again', async () => {
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { team: 'old', deleteError: '1 file could not be deleted.' } });

      const res = await stack.request('PATCH', '/files/buckets/work', { status: 'active' });

      expect(res.statusCode).toBe(200);
      expect(await stack.bucket('work')).toMatchObject({ status: 'active', metadata: { team: 'old' } });
      const shown = await stack.request('GET', '/files/buckets/work');
      expect(stack.json(shown).bucket.deleteError).toBeUndefined();
    });
  });

  it('is refused for a bucket that is being deleted: 409 bucket_deleting', async () => {
    const bucket = await stack.bucket('work');
    await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });

    const res = await stack.request('PATCH', '/files/buckets/work', { name: 'Renamed', status: 'active' });

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_deleting' });
    expect(await stack.bucket('work')).toMatchObject({ name: 'Work files', status: 'disabled' });
  });

  it('still refuses to switch off a bucket an agent keeps its session files in', async () => {
    await stack.db.createAgent({
      tenantId: stack.tenantId, projectId: stack.projectId, key: 'support', name: 'Support',
      config: { modelKey: 'm', attachments: { enabled: true, bucketKey: 'work' } }, status: 'active', createdBy: 'x',
    } as never);

    const res = await stack.request('PATCH', '/files/buckets/work', { status: 'disabled' });

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_in_use' });
    expect((await stack.bucket('work'))?.status).toBe('active');
  });
});

describe('POST /files/buckets (the same rules)', () => {
  it('checks the name, description, prefix and status the way an update does', async () => {
    const create = (body: Record<string, unknown>) => stack.request('POST', '/files/buckets', { key: 'fresh', providerKey: 'local', name: 'Fresh', ...body });

    for (const body of [{ name: 'n'.repeat(121) }, { prefix: '../x' }, { status: 'paused' }, { description: 5 }]) {
      const res = await create(body);
      expect(res.statusCode).toBe(400);
      expect(stack.json(res).code).toBe('invalid_request');
    }
    expect(await stack.bucket('fresh')).toBeNull();

    const ok = await create({ name: ' Fresh ones ', prefix: '/team/fresh/', description: ' New ' });
    expect(ok.statusCode).toBe(201);
    expect(stack.json(ok).bucket).toMatchObject({ key: 'fresh', name: 'Fresh ones', prefix: 'team/fresh', description: 'New', status: 'active' });
  });

  it('uses the key as the prefix when none is given, and may be left without one on purpose', async () => {
    const plain = await stack.request('POST', '/files/buckets', { key: 'plain', providerKey: 'local', name: 'Plain' });
    expect(stack.json(plain).bucket.prefix).toBe('plain');

    const root = await stack.request('POST', '/files/buckets', { key: 'rooted', providerKey: 'local', name: 'Rooted', prefix: '' });
    expect(stack.json(root).bucket.prefix).toBe('');
  });
});

describe('DELETE /files/buckets/:bucketKey without deleteFiles', () => {
  it('is what it was: an empty bucket goes, one with files is a 409, force removes the bucket', async () => {
    expect((await stack.request('DELETE', '/files/buckets/empty')).statusCode).toBe(200);
    expect(await stack.bucket('empty')).toBeNull();

    await stack.putFile('work', 'a.txt', 'hello');
    const refused = await stack.request('DELETE', '/files/buckets/work');
    expect(refused.statusCode).toBe(409);
    expect(stack.json(refused)).toMatchObject({ code: 'bucket_not_empty' });

    expect((await stack.request('DELETE', '/files/buckets/work?force=true')).statusCode).toBe(200);
    expect(await stack.bucket('work')).toBeNull();
    // Its files were not touched.
    expect(existsSync(stack.objectPath('work', 'a.txt'))).toBe(true);
  });

  it('is a 404 for a bucket that does not exist', async () => {
    expect((await stack.request('DELETE', '/files/buckets/nobody')).statusCode).toBe(404);
    expect((await stack.request('DELETE', '/files/buckets/nobody?deleteFiles=true')).statusCode).toBe(404);
  });
});

describe('DELETE /files/buckets/:bucketKey?deleteFiles=true', () => {
  /** The files of the "work" bucket: two with a Markdown copy, one in a folder. */
  async function fill() {
    await stack.putFile('work', 'a.txt', 'alpha');
    await stack.putFile('work', 'docs/b.pdf', '%PDF-1.4', { contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'docs/b.md', markdownSize: 6 });
    stack.putObject('work', 'docs/b.md', '# bee');
    await stack.putFile('work', 'docs/deep/c.txt', 'gamma');
  }

  const gone = async (key: string) => (await stack.bucket(key)) === null;

  it('answers 202 at once: the bucket is switched off and marked while the job is still to run', async () => {
    await fill();

    const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

    expect(res.statusCode).toBe(202);
    expect(stack.json(res)).toEqual({ status: 'deleting' });
    // No consumer is running, so the job is waiting in the queue.
    expect(await stack.bucket('work')).toMatchObject({ status: 'disabled', metadata: { deleting: true } });
    expect(await stack.records('work')).toHaveLength(3);
    expect(existsSync(stack.objectPath('work', 'a.txt'))).toBe(true);
  });

  it('shows the bucket as deleting, takes nothing new and lets nothing change while it waits', async () => {
    await fill();
    await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

    const list = await stack.request('GET', '/files/buckets');
    expect(stack.json(list).buckets.find((bucket: { key: string }) => bucket.key === 'work')).toMatchObject({ deleting: true, status: 'disabled' });
    const one = await stack.request('GET', '/files/buckets/work');
    expect(stack.json(one).bucket).toMatchObject({ deleting: true });

    const patch = await stack.request('PATCH', '/files/buckets/work', { name: 'Renamed' });
    expect(patch.statusCode).toBe(409);
    expect(stack.json(patch).code).toBe('bucket_deleting');

    const upload = await stack.request('POST', '/files/buckets/work/objects', { fileName: 'late.txt', data: Buffer.from('late').toString('base64'), convertToMarkdown: false });
    expect(upload.statusCode).toBe(409);
    expect(stack.json(upload).code).toBe('bucket_inactive');

    const plain = await stack.request('DELETE', '/files/buckets/work?force=true');
    expect(plain.statusCode).toBe(409);
    expect(stack.json(plain).code).toBe('bucket_deleting');
  });

  it('removes every object and its Markdown copy, then the records, then the bucket', async () => {
    await fill();
    await startFilesQueueConsumer();

    const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
    expect(res.statusCode).toBe(202);

    await vi.waitFor(async () => expect(await gone('work')).toBe(true), { timeout: 10_000 });
    for (const key of ['a.txt', 'docs/b.pdf', 'docs/b.md', 'docs/deep/c.txt']) {
      expect(existsSync(stack.objectPath('work', key)), key).toBe(false);
    }
    expect(await stack.records('work')).toEqual([]);
    // Another bucket is left alone.
    expect(await stack.bucket('empty')).not.toBeNull();
  });

  it('deletes a bucket without files without asking its provider anything', async () => {
    await stack.db.updateProvider?.(String((await stack.db.findProviderByKey?.(stack.tenantId, 'local', stack.projectId))?._id), { status: 'disabled' } as never);
    await startFilesQueueConsumer();

    const res = await stack.request('DELETE', '/files/buckets/empty?deleteFiles=true');
    expect(res.statusCode).toBe(202);

    await vi.waitFor(async () => expect(await gone('empty')).toBe(true), { timeout: 10_000 });
  });

  it('refuses a bucket an agent keeps its session files in, whatever else is asked', async () => {
    await stack.db.createAgent({
      tenantId: stack.tenantId, projectId: stack.projectId, key: 'support', name: 'Support',
      config: { modelKey: 'm', attachments: { enabled: true, bucketKey: 'work' } }, status: 'active', createdBy: 'x',
    } as never);
    await fill();

    const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

    expect(res.statusCode).toBe(409);
    expect(stack.json(res)).toMatchObject({ code: 'bucket_in_use' });
    expect(await stack.bucket('work')).toMatchObject({ status: 'active' });
    expect((await stack.bucket('work'))?.metadata ?? {}).not.toHaveProperty('deleting');
  });

  describe('when something cannot be deleted', () => {
    it('keeps the bucket, switched off, with why, and has deleted what it could', async () => {
      await fill();
      makeUndeletable('work', 'a.txt');
      await startFilesQueueConsumer();

      await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      await vi.waitFor(async () => expect((await stack.bucket('work'))?.metadata?.deleting).not.toBe(true), { timeout: 15_000 });
      const bucket = await stack.bucket('work');
      expect(bucket).toMatchObject({ status: 'disabled' });
      expect(bucket?.metadata).not.toHaveProperty('deleting');
      expect(bucket?.metadata?.deleteError).toMatch(/^1 file could not be deleted from the storage provider: /);
      // The others are gone, with their copies; the one that could not be removed keeps its record.
      expect((await stack.records('work')).map((record) => record.key)).toEqual(['a.txt']);
      expect(existsSync(stack.objectPath('work', 'docs/b.md'))).toBe(false);
      expect(existsSync(stack.objectPath('work', 'docs/deep/c.txt'))).toBe(false);
    });

    it('keeps the record of a file whose Markdown copy could not be removed: the copy is not left with nothing that names it', async () => {
      await fill();
      // docs/b.pdf has the copy docs/b.md; the copy is the one that cannot be removed.
      makeUndeletable('work', 'docs/b.md');
      await startFilesQueueConsumer();

      await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      await vi.waitFor(async () => expect((await stack.bucket('work'))?.metadata?.deleteError).toBeTruthy(), { timeout: 15_000 });
      expect((await stack.bucket('work'))?.metadata?.deleteError).toMatch(/^1 file could not be deleted from the storage provider: /);
      // Its record stays, and so does the copy; the original is already gone, which the next attempt takes as done.
      expect((await stack.records('work')).map((record) => record.key)).toEqual(['docs/b.pdf']);
      expect(existsSync(stack.objectPath('work', 'docs/b.md'))).toBe(true);
      expect(existsSync(stack.objectPath('work', 'docs/b.pdf'))).toBe(false);
      expect(existsSync(stack.objectPath('work', 'a.txt'))).toBe(false);
    });

    it('tells the screens what went wrong, and lets the delete be asked again until it works', async () => {
      await fill();
      const stuck = makeUndeletable('work', 'a.txt');
      await startFilesQueueConsumer();
      await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
      await vi.waitFor(async () => expect((await stack.bucket('work'))?.metadata?.deleteError).toBeTruthy(), { timeout: 15_000 });

      const shown = await stack.request('GET', '/files/buckets/work');
      expect(stack.json(shown).bucket.deleteError).toMatch(/could not be deleted/);
      expect(stack.json(shown).bucket.deleting).toBeUndefined();
      // The reason is a sentence for people: no path of this machine, nothing from the SDK.
      expect(stack.json(shown).bucket.deleteError).not.toContain(stack.dir);
      expect(stack.json(shown).bucket.deleteError).not.toMatch(/EISDIR|ENOENT|errno|\/var\/|\/tmp\//);

      rmSync(stuck, { recursive: true, force: true });
      writeFileSync(stuck, 'now a plain file');
      const again = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
      expect(again.statusCode).toBe(202);
      // Asking again clears the old reason at once.
      expect((await stack.bucket('work'))?.metadata?.deleteError).toBeUndefined();

      await vi.waitFor(async () => expect(await gone('work')).toBe(true), { timeout: 10_000 });
      expect(existsSync(stuck)).toBe(false);
      expect(await stack.records('work')).toEqual([]);
    });

    it('may be given up on: switching the bucket on again forgets the reason', async () => {
      await fill();
      makeUndeletable('work', 'a.txt');
      await startFilesQueueConsumer();
      await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
      await vi.waitFor(async () => expect((await stack.bucket('work'))?.metadata?.deleteError).toBeTruthy(), { timeout: 15_000 });

      const res = await stack.request('PATCH', '/files/buckets/work', { status: 'active' });

      expect(res.statusCode).toBe(200);
      expect(await stack.bucket('work')).toMatchObject({ status: 'active' });
      expect((await stack.bucket('work'))?.metadata ?? {}).not.toHaveProperty('deleteError');
    });
  });

  describe('when the job cannot be queued', () => {
    it('is a 503 and puts the bucket back as it was, with why', async () => {
      await fill();
      vi.spyOn(await getQueue(), 'publish').mockRejectedValueOnce(new Error('redis is down'));

      const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      expect(res.statusCode).toBe(503);
      expect(stack.json(res)).toMatchObject({ code: 'queue_unavailable' });
      expect(res.body).not.toContain('redis');
      const bucket = await stack.bucket('work');
      expect(bucket).toMatchObject({ status: 'active' });
      expect(bucket?.metadata).not.toHaveProperty('deleting');
      expect(bucket?.metadata?.deleteError).toMatch(/queue/i);
    });
  });

  describe('the job itself', () => {
    const payload = () => ({ tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', actor: stack.userId });

    it('does nothing for a bucket that is not being deleted: a job left over from an earlier request', async () => {
      await fill();

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      expect(await stack.records('work')).toHaveLength(3);
      expect(await stack.bucket('work')).toMatchObject({ status: 'active' });
    });

    it('does nothing for a bucket that is already gone, and can run twice', async () => {
      await fill();
      await startFilesQueueConsumer();
      await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
      await vi.waitFor(async () => expect(await gone('work')).toBe(true), { timeout: 10_000 });

      await expect(stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()))).resolves.toBeUndefined();
    });

    it('finishes a deletion an earlier run left half done', async () => {
      await fill();
      // The first file and its record are already gone, as after a run that stopped there.
      rmSync(stack.objectPath('work', 'a.txt'));
      await stack.db.deleteFileRecord(String((await stack.record('work', 'a.txt'))!._id));
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      expect(await gone('work')).toBe(true);
      expect(existsSync(stack.objectPath('work', 'docs/deep/c.txt'))).toBe(false);
    });

    it('treats a record whose object is already missing as deleted', async () => {
      await fill();
      rmSync(stack.objectPath('work', 'docs/deep/c.txt'));
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      expect(await gone('work')).toBe(true);
    });

    it('leaves a reason on the bucket, and does not throw, when the bucket cannot even be looked up', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      // The lookup that opens the run fails once; the one that writes the reason down works.
      vi.spyOn(stack.db, 'findFileBucketByKey').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));

      await expect(stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()))).resolves.toBeUndefined();

      const after = await stack.bucket('work');
      expect(after).toMatchObject({ status: 'disabled' });
      expect(after?.metadata).not.toHaveProperty('deleting');
      expect(after?.metadata?.deleteError).toMatch(/^The deletion stopped: /);
      expect(after?.metadata?.deleteError).not.toMatch(/SQLITE|locked/);
      expect(await stack.records('work')).toHaveLength(3);
    });

    it('does not throw either when nothing at all can be written down', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      vi.spyOn(stack.db, 'findFileBucketByKey').mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

      await expect(stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()))).resolves.toBeUndefined();

      expect(await stack.records('work')).toHaveLength(3);
    });

    it('goes through the bucket again for the files that arrived while it was going through them', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      const real = stack.db.deleteFileRecord.bind(stack.db);
      let arrived = false;
      vi.spyOn(stack.db, 'deleteFileRecord').mockImplementation(async (id) => {
        const result = await real(id);
        if (!arrived) {
          arrived = true;
          // An upload that began before the bucket was switched off lands after the first pass has listed it.
          await stack.putFile('work', 'late.txt', 'late');
        }
        return result;
      });

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      expect(await gone('work')).toBe(true);
      expect(await stack.records('work')).toEqual([]);
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(false);
    });

    it('gives up when files keep arriving, says so on the bucket, and finishes once they stop', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      const real = stack.db.deleteFileRecord.bind(stack.db);
      let counter = 0;
      const spy = vi.spyOn(stack.db, 'deleteFileRecord').mockImplementation(async (id) => {
        const result = await real(id);
        counter += 1;
        await stack.putFile('work', `late-${counter}.txt`, 'late');
        return result;
      });

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      const stuck = await stack.bucket('work');
      expect(stuck).toMatchObject({ status: 'disabled' });
      expect(stuck?.metadata).not.toHaveProperty('deleting');
      expect(stuck?.metadata?.deleteError).toBe('Files were still being added to the bucket while it was deleted. Delete it again.');

      // Asked again when no upload is in flight any more, it ends.
      spy.mockRestore();
      expect((await stack.request('DELETE', '/files/buckets/work?deleteFiles=true')).statusCode).toBe(202);
      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));
      expect(await gone('work')).toBe(true);
      expect(await stack.records('work')).toEqual([]);
    });
  });

  describe('an upload that is still being written when the bucket is deleted', () => {
    const payload = () => ({ tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', actor: stack.userId });

    /** Holds the write of one object on the disk until `release` is called; `started` is true once the write was asked for. */
    function holdWriteOf(fileName: string) {
      let release!: () => void;
      let begun!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { begun = resolve; });
      const write = fsPromises.writeFile.bind(fsPromises);
      vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, ...rest) => {
        if (String(file).endsWith(`/${fileName}`)) {
          begun();
          await gate;
        }
        return (write as (...args: unknown[]) => Promise<void>)(file, ...rest);
      });
      return { release, started };
    }

    const lateUpload = () => stack.request('POST', '/files/buckets/work/objects', {
      fileName: 'late.txt', keyHint: 'late.txt', data: Buffer.from('arrives late').toString('base64'), convertToMarkdown: false,
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('leaves no file behind when the deletion has finished before the upload does: refused, no record, no object, nothing counted', async () => {
      const held = holdWriteOf('late.txt');
      const uploading = lateUpload();
      await held.started;

      expect((await stack.request('DELETE', '/files/buckets/work?deleteFiles=true')).statusCode).toBe(202);
      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));
      expect(await gone('work')).toBe(true);
      held.release();
      const res = await uploading;

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toMatchObject({ code: 'bucket_deleting' });
      expect(await stack.records('work')).toEqual([]);
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(false);
      expect(await stack.db.countFileRecords({ projectId: stack.projectId })).toBe(0);
    });

    it('is withdrawn too while the bucket still waits for its deletion: the deletion then has nothing to find', async () => {
      const held = holdWriteOf('late.txt');
      const uploading = lateUpload();
      await held.started;

      expect((await stack.request('DELETE', '/files/buckets/work?deleteFiles=true')).statusCode).toBe(202);
      held.release();
      const res = await uploading;

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toMatchObject({ code: 'bucket_deleting' });
      expect(await stack.records('work')).toEqual([]);
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(false);
      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));
      expect(await gone('work')).toBe(true);
    });

    it('is withdrawn as a write to a switched-off bucket is refused when the bucket was only switched off', async () => {
      const held = holdWriteOf('late.txt');
      const uploading = lateUpload();
      await held.started;

      await stack.db.updateFileBucket(String((await stack.bucket('work'))!._id), { status: 'disabled' });
      held.release();
      const res = await uploading;

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toMatchObject({ code: 'bucket_inactive' });
      expect(await stack.records('work')).toEqual([]);
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(false);
    });

    it('is kept when the bucket is still open for files: the check does not get in the way of an ordinary upload', async () => {
      const held = holdWriteOf('late.txt');
      const uploading = lateUpload();
      await held.started;
      held.release();

      const res = await uploading;

      expect(res.statusCode).toBe(201);
      expect(await stack.record('work', 'late.txt')).not.toBeNull();
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(true);
    });
  });

  describe('a storage location another bucket uses', () => {
    const SHARED = 'Another bucket uses this storage location. Delete the bucket without its files, or remove the other bucket first.';
    const OBJECTS = ['a.txt', 'docs/b.pdf', 'docs/b.md', 'docs/deep/c.txt'];
    const secondProject = async () => String((await stack.db.createProject({ tenantId: stack.tenantId, key: 'second', name: 'Second', createdBy: 'x' }))._id);
    const bucketOf = (projectId: string, key: string, over: Record<string, unknown> = {}) => stack.db.createFileBucket({
      tenantId: stack.tenantId, projectId, key, name: key, providerKey: 'local', status: 'active', createdBy: 'x', ...over,
    } as never);
    const payload = () => ({ tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, bucketKey: 'work', actor: stack.userId });
    const untouched = async () => {
      expect(await stack.records('work')).toHaveLength(3);
      for (const key of OBJECTS) expect(existsSync(stack.objectPath('work', key)), key).toBe(true);
    };

    it('is a 409 with nothing marked, queued or deleted when a bucket of another project has the same key', async () => {
      await fill();
      await bucketOf(await secondProject(), 'work');
      const publish = vi.spyOn(await getQueue(), 'publish');

      const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      expect(res.statusCode).toBe(409);
      expect(stack.json(res)).toEqual({ error: SHARED, code: 'storage_location_shared' });
      const bucket = await stack.bucket('work');
      expect(bucket).toMatchObject({ status: 'active' });
      expect(bucket?.metadata ?? {}).not.toHaveProperty('deleting');
      expect(bucket?.metadata ?? {}).not.toHaveProperty('deleteError');
      expect(publish).not.toHaveBeenCalled();
      await untouched();
    });

    it.each([
      ['the same folder, named outright', { prefix: 'work' }],
      ['the provider\'s root', { prefix: '' }],
      ['a folder inside it', { prefix: 'work/archive' }],
      ['switched off', { prefix: 'work', status: 'disabled' }],
      ['being deleted', { prefix: 'work', status: 'disabled', metadata: { deleting: true } }],
    ])('is a 409 for a bucket of another project that keeps its files in %s', async (_label, over) => {
      await fill();
      await bucketOf(await secondProject(), 'elsewhere', over);

      const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      expect(res.statusCode).toBe(409);
      expect(stack.json(res).code).toBe('storage_location_shared');
      await untouched();
    });

    it('is a 409 for a bucket of the same project that sits inside this one', async () => {
      await fill();
      await stack.createBucket('inner', { prefix: 'work/inner' });

      const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      expect(res.statusCode).toBe(409);
      await untouched();
    });

    it('is still possible without the files: the bucket goes, every object stays, and so does the other bucket', async () => {
      await fill();
      const second = await secondProject();
      await bucketOf(second, 'work');

      const res = await stack.request('DELETE', '/files/buckets/work?force=true');

      expect(res.statusCode).toBe(200);
      expect(await stack.bucket('work')).toBeNull();
      expect(await stack.db.findFileBucketByKey(stack.tenantId, 'work', second)).not.toBeNull();
      for (const key of OBJECTS) expect(existsSync(stack.objectPath('work', key)), key).toBe(true);
    });

    it('goes ahead for buckets on other folders, however alike the names: the files are deleted as before', async () => {
      await fill();
      const second = await secondProject();
      await bucketOf(second, 'work-archive');
      await bucketOf(second, 'wor');
      await bucketOf(second, 'elsewhere', { prefix: 'elsewhere/work' });
      await bucketOf(second, 'work', { providerKey: 'another-disk' });
      await startFilesQueueConsumer();

      const res = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');

      expect(res.statusCode).toBe(202);
      await vi.waitFor(async () => expect(await gone('work')).toBe(true), { timeout: 10_000 });
      for (const key of OBJECTS) expect(existsSync(stack.objectPath('work', key)), key).toBe(false);
    });

    it('is checked again by the job before it deletes anything: a bucket that came since the request leaves every file alone, with the reason on the bucket', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      await bucketOf(await secondProject(), 'work');

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      const after = await stack.bucket('work');
      expect(after).toMatchObject({ status: 'disabled' });
      expect(after?.metadata).not.toHaveProperty('deleting');
      expect(after?.metadata?.deleteError).toBe(SHARED);
      await untouched();
    });

    it('can be asked again once the other bucket is gone', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      const other = await bucketOf(await secondProject(), 'work');
      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));
      expect((await stack.bucket('work'))?.metadata?.deleteError).toBe(SHARED);

      await stack.db.deleteFileBucket(String(other._id));
      const again = await stack.request('DELETE', '/files/buckets/work?deleteFiles=true');
      expect(again.statusCode).toBe(202);
      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      expect(await gone('work')).toBe(true);
      expect(await stack.records('work')).toEqual([]);
    });

    it('is asked again before every pass: a bucket that comes while the files go stops the run before it deletes more', async () => {
      await fill();
      const bucket = await stack.bucket('work');
      await stack.db.updateFileBucket(String(bucket!._id), { status: 'disabled', metadata: { deleting: true } });
      const second = await secondProject();
      const real = stack.db.deleteFileRecord.bind(stack.db);
      let arranged = false;
      vi.spyOn(stack.db, 'deleteFileRecord').mockImplementation(async (id) => {
        const result = await real(id);
        if (!arranged) {
          arranged = true;
          // A file lands after the first pass has listed the bucket, and a bucket of another project takes the folder.
          await stack.putFile('work', 'late.txt', 'late');
          await bucketOf(second, 'work');
        }
        return result;
      });

      await stack.db.runWithTenant(FILES_DB_NAME, () => runBucketDeletionJob(payload()));

      const after = await stack.bucket('work');
      expect(after?.metadata?.deleteError).toBe(SHARED);
      expect(after?.metadata).not.toHaveProperty('deleting');
      expect((await stack.records('work')).map((record) => record.key)).toEqual(['late.txt']);
      expect(existsSync(stack.objectPath('work', 'late.txt'))).toBe(true);
    });
  });
});
