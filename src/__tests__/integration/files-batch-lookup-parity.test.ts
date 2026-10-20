/**
 * What the Document Store's batch and background work asks the database - the contract both providers must keep
 * (SQLite and MongoDB via mongodb-memory-server):
 *
 *  - the records of many keys of one bucket in ONE read (`listFileRecordsByKeys`), by the key or by the key of the
 *    Markdown copy: the batch delete, the archive and "Import from storage" stand on it;
 *  - a record patch that clears the error of a conversion (`markdownError: null`) while a patch that leaves the
 *    field out keeps it: a conversion that is retried must not show the error of the last try;
 *  - the origin of a record (`import`) and the deletion marks on a bucket's metadata round-trip;
 *  - the buckets of a whole tenant in one read (`listFileBuckets` without a project), which "Import from storage" and
 *    "Delete the bucket with its files" use to find the buckets that keep files in the same place.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { IFileRecord } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Looking files up by key, and patching a conversion', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';
  const providerKey = 'disk';
  const bucketKey = 'docs';

  beforeEach(async () => {
    const slug = `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const put = (key: string, overrides: Partial<Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>> = {}) => getDb().createFileRecord({
    tenantId, projectId, providerKey, bucketKey, key, name: key.split('/').pop()!, size: 1, contentType: 'text/plain',
    markdownStatus: 'skipped', createdBy: 'u1', ...overrides,
  });
  const keys = (records: IFileRecord[]) => records.map((record) => record.key).sort();
  const lookup = (wanted: string[], over: Record<string, unknown> = {}) => getDb().listFileRecordsByKeys({
    providerKey, bucketKey, projectId, keys: wanted, ...over,
  });

  describe('listFileRecordsByKeys', () => {
    it('answers the records of the keys asked for, and nothing else', async () => {
      await put('a.txt');
      await put('b.txt');
      await put('sub/c.txt');
      await put('d.txt');

      expect(keys(await lookup(['a.txt', 'sub/c.txt']))).toEqual(['a.txt', 'sub/c.txt']);
    });

    it('leaves out a key that has no record, and answers nothing for no keys', async () => {
      await put('a.txt');

      expect(keys(await lookup(['a.txt', 'nowhere.txt']))).toEqual(['a.txt']);
      expect(await lookup([])).toEqual([]);
    });

    it('answers a key named twice once', async () => {
      await put('a.txt');

      expect(keys(await lookup(['a.txt', 'a.txt', 'a.txt']))).toEqual(['a.txt']);
    });

    it('stays inside the bucket: the same key in another bucket, provider or project is another file', async () => {
      await put('a.txt', { size: 10 });
      await put('a.txt', { bucketKey: 'other', size: 20 });
      await put('a.txt', { providerKey: 'second-disk', size: 30 });
      await put('a.txt', { projectId: 'proj-2', size: 40 });

      const found = await lookup(['a.txt']);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ key: 'a.txt', bucketKey, providerKey, projectId, size: 10 });
    });

    it('does not narrow to a project when none is named', async () => {
      await put('a.txt');
      await put('b.txt', { projectId: 'proj-2' });

      const found = await getDb().listFileRecordsByKeys({ providerKey, bucketKey, keys: ['a.txt', 'b.txt'] });
      expect(keys(found)).toEqual(['a.txt', 'b.txt']);
    });

    it('matches a key exactly: quotes, wildcards and non-ASCII letters mean nothing special', async () => {
      const awkward = ["it's.txt", '100%.txt', 'under_score.txt', 'ünï/çödé.txt', 'a b.txt', '.hidden'];
      for (const key of [...awkward, 'itXs.txt', '100x.txt', 'underXscore.txt']) await put(key);

      expect(keys(await lookup(awkward))).toEqual([...awkward].sort());
      expect(keys(await lookup(['it%.txt', '_nder_score.txt']))).toEqual([]);
    });

    it('hands back a usable record: an id, the stored fields, the origin', async () => {
      await put('imported.txt', { size: 42, etag: 'e1', origin: 'import', uploadedBy: 'u9' });

      const [record] = await lookup(['imported.txt']);
      expect(typeof record!._id).toBe('string');
      expect(record).toMatchObject({ key: 'imported.txt', name: 'imported.txt', size: 42, etag: 'e1', origin: 'import', uploadedBy: 'u9' });
    });

    it('finds the records whose Markdown copy has these keys when asked by the copy', async () => {
      await put('report.pdf', { markdownStatus: 'succeeded', markdownKey: 'report.md', markdownSize: 5 });
      await put('notes.txt', { markdownStatus: 'succeeded', markdownKey: 'notes.md', markdownSize: 5 });
      await put('report.md');
      await put('plain.txt');

      const owners = await lookup(['report.md', 'plain.txt', 'missing.md'], { field: 'markdownKey' });
      expect(keys(owners)).toEqual(['report.pdf']);
    });

    it('asks for more keys than one statement can carry', async () => {
      const many = Array.from({ length: 950 }, (_, index) => `bulk/file-${String(index).padStart(4, '0')}.txt`);
      for (const key of many.slice(0, 450)) await put(key);

      const found = await lookup(many);
      expect(found).toHaveLength(450);
      expect(keys(found)).toEqual(many.slice(0, 450).sort());
    });
  });

  describe('updateFileRecord on a conversion', () => {
    const failed = () => put('doc.pdf', { markdownStatus: 'failed', markdownError: 'The converter gave up.', markdownKey: 'doc.md', markdownSize: 9 });

    it('clears the error with null', async () => {
      const record = await failed();

      const updated = await getDb().updateFileRecord(String(record._id), { markdownStatus: 'pending', markdownError: null });
      expect(updated?.markdownStatus).toBe('pending');
      expect(updated?.markdownError ?? null).toBeNull();
      expect((await getDb().findFileRecordById(String(record._id)))?.markdownError ?? null).toBeNull();
    });

    it('keeps the error, the copy and everything else the patch leaves out', async () => {
      const record = await failed();

      const updated = await getDb().updateFileRecord(String(record._id), { updatedBy: 'u2' });
      expect(updated).toMatchObject({
        markdownStatus: 'failed',
        markdownError: 'The converter gave up.',
        markdownKey: 'doc.md',
        markdownSize: 9,
        updatedBy: 'u2',
      });
    });

    it('writes a new error and a finished copy', async () => {
      const record = await failed();

      const again = await getDb().updateFileRecord(String(record._id), { markdownStatus: 'failed', markdownError: 'Another reason.' });
      expect(again).toMatchObject({ markdownError: 'Another reason.', markdownKey: 'doc.md' });

      const done = await getDb().updateFileRecord(String(record._id), {
        markdownStatus: 'succeeded', markdownError: null, markdownKey: 'doc2.md', markdownSize: 12, markdownContentType: 'text/markdown',
      });
      expect(done).toMatchObject({ markdownStatus: 'succeeded', markdownKey: 'doc2.md', markdownSize: 12, markdownContentType: 'text/markdown' });
      expect(done?.markdownError ?? null).toBeNull();
    });

    it('answers null for a record that is not there', async () => {
      const record = await put('gone.txt');
      await getDb().deleteFileRecord(String(record._id));

      expect(await getDb().updateFileRecord(String(record._id), { markdownStatus: 'pending' })).toBeNull();
    });
  });

  describe('listFileRecords while the records it returned are deleted', () => {
    it('continues after the last record of a page: a delete of the page does not make the next one skip any', async () => {
      const all = Array.from({ length: 7 }, (_, index) => `file-${index}.txt`);
      for (const key of all) await put(key);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await getDb().listFileRecords({ providerKey, bucketKey, projectId, limit: 3, ...(cursor ? { cursor } : {}) });
        for (const record of page.items) {
          seen.push(record.key);
          await getDb().deleteFileRecord(String(record._id));
        }
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen.sort()).toEqual(all);
      expect((await getDb().listFileRecords({ providerKey, bucketKey, projectId, limit: 50 })).items).toEqual([]);
    });
  });

  describe('a bucket that is being deleted', () => {
    it('keeps the marks on its metadata, and replaces them wholesale', async () => {
      const db = getDb();
      const bucket = await db.createFileBucket({
        tenantId, projectId, key: bucketKey, name: 'Docs', providerKey, status: 'active', prefix: 'docs', createdBy: 'u1',
      });

      const marked = await db.updateFileBucket(String(bucket._id), {
        status: 'disabled',
        metadata: { team: 'legal', deleting: true },
      });
      expect(marked).toMatchObject({ status: 'disabled', metadata: { team: 'legal', deleting: true } });

      const failedRun = await db.updateFileBucket(String(bucket._id), { metadata: { team: 'legal', deleteError: '2 files could not be deleted.' } });
      expect(failedRun?.metadata).toEqual({ team: 'legal', deleteError: '2 files could not be deleted.' });
      expect((await db.findFileBucketByKey(tenantId, bucketKey, projectId))?.metadata).toEqual({ team: 'legal', deleteError: '2 files could not be deleted.' });
    });
  });

  describe('listFileBuckets without a project', () => {
    const bucketIn = (inProject: string, key: string, over: Record<string, unknown> = {}) => getDb().createFileBucket({
      tenantId, projectId: inProject, key, name: key, providerKey, status: 'active', createdBy: 'u1', ...over,
    } as never);
    const pairs = (buckets: Array<{ projectId?: string; key: string }>) => buckets.map((bucket) => `${bucket.projectId}/${bucket.key}`).sort();

    it('answers the buckets of every project of the tenant, whatever their state, with their prefix and marks', async () => {
      await bucketIn('proj-1', 'docs');
      await bucketIn('proj-2', 'docs', { prefix: '' });
      await bucketIn('proj-3', 'old', { status: 'disabled', metadata: { deleting: true } });

      const all = await getDb().listFileBuckets(tenantId);

      expect(pairs(all)).toEqual(['proj-1/docs', 'proj-2/docs', 'proj-3/old']);
      expect(all.find((bucket) => bucket.projectId === 'proj-2')?.prefix).toBe('');
      expect(all.find((bucket) => bucket.projectId === 'proj-3')).toMatchObject({ status: 'disabled', metadata: { deleting: true } });
      expect(all.every((bucket) => typeof bucket._id === 'string' && bucket._id.length > 0)).toBe(true);
    });

    it('still narrows to one project when one is named', async () => {
      await bucketIn('proj-1', 'docs');
      await bucketIn('proj-1', 'media');
      await bucketIn('proj-2', 'docs');

      expect(pairs(await getDb().listFileBuckets(tenantId, 'proj-1'))).toEqual(['proj-1/docs', 'proj-1/media']);
      expect(pairs(await getDb().listFileBuckets(tenantId, 'proj-2'))).toEqual(['proj-2/docs']);
    });

    it('answers nothing for a tenant without buckets', async () => {
      expect(await getDb().listFileBuckets(tenantId)).toEqual([]);
    });
  });
});
