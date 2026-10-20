/**
 * Two reads the Document Store's bucket list and file table depend on - the contract both database providers
 * must keep (SQLite and MongoDB via mongodb-memory-server):
 *
 *  - a bucket's numbers (`listFileBucketStats`): how many files it holds and how many bytes they take, in ONE
 *    grouped read for any number of buckets; and the project total (`sumFileRecordBytes`) they add up to;
 *  - the objects listing narrowed to a kind of file (`listFileRecords({ type })`), decided by the content
 *    type first and by the extension of the name only when the content type names no kind.
 *
 * The providers are written independently; the same assertions run on both, and the rule they implement
 * (`classifyFileKind`) is the oracle for every record that is listed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { FileTypeFilter, IFileRecord } from '@/lib/database/provider.interface';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { FILE_TYPE_FILTERS, classifyFileKind } from '@/lib/database/fileTypeFilter';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Bucket stats and the file type filter', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  const providerKey = 'disk';
  const bucketKey = 'docs';

  beforeEach(async () => {
    const slug = `stats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
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
  const byBucket = <T extends { providerKey: string; bucketKey: string }>(rows: T[]) => [...rows].sort(
    (a, b) => `${a.providerKey}/${a.bucketKey}`.localeCompare(`${b.providerKey}/${b.bucketKey}`),
  );

  // ── Bucket stats ──────────────────────────────────────────────────────

  describe('listFileBucketStats', () => {
    const seed = async () => {
      await put('a.txt', { size: 100 });
      await put('b.pdf', { size: 200, markdownSize: 50, markdownStatus: 'succeeded', markdownKey: 'b.md' });
      await put('c.bin', { size: 0 });
      await put('sessions/x.txt', { size: 7, purpose: 'conversation', conversationId: 'c1', agentKey: 'bot' });
      // Other buckets, providers and projects.
      await put('other-1.txt', { bucketKey: 'other', size: 1000 });
      await put('other-2.txt', { bucketKey: 'other', size: 2000, markdownSize: 3, markdownStatus: 'succeeded', markdownKey: 'other-2.md' });
      await put('same-bucket-key-elsewhere.txt', { providerKey: 'second-disk', size: 5000 });
      await put('project-two.txt', { projectId: 'proj-2', size: 9000 });
    };

    it('adds up a bucket: the files it holds and the bytes of the originals and their Markdown copies', async () => {
      await seed();
      const rows = await getDb().listFileBucketStats({ projectId, buckets: [{ providerKey, bucketKey }] });
      expect(rows).toEqual([{ providerKey, bucketKey, fileCount: 4, totalBytes: 100 + 200 + 50 + 0 + 7 }]);
    });

    it('answers every bucket asked for in one read, each with its own numbers', async () => {
      await seed();
      const rows = await getDb().listFileBucketStats({
        projectId,
        buckets: [
          { providerKey, bucketKey },
          { providerKey, bucketKey: 'other' },
          { providerKey: 'second-disk', bucketKey },
        ],
      });
      expect(byBucket(rows)).toEqual(byBucket([
        { providerKey, bucketKey, fileCount: 4, totalBytes: 357 },
        { providerKey, bucketKey: 'other', fileCount: 2, totalBytes: 3003 },
        { providerKey: 'second-disk', bucketKey, fileCount: 1, totalBytes: 5000 },
      ]));
    });

    it('tells a bucket key apart by its provider: the same key under another provider is another bucket', async () => {
      await seed();
      const [row] = await getDb().listFileBucketStats({ projectId, buckets: [{ providerKey: 'second-disk', bucketKey }] });
      expect(row).toMatchObject({ providerKey: 'second-disk', fileCount: 1, totalBytes: 5000 });
      // A pair that exists in no record is not mixed up with one that does.
      expect(await getDb().listFileBucketStats({ projectId, buckets: [{ providerKey: 'second-disk', bucketKey: 'other' }] })).toEqual([]);
    });

    it('leaves out a bucket with no files (the caller shows zero)', async () => {
      await seed();
      const rows = await getDb().listFileBucketStats({ projectId, buckets: [{ providerKey, bucketKey: 'empty' }, { providerKey, bucketKey }] });
      expect(rows.map((row) => row.bucketKey)).toEqual([bucketKey]);
    });

    it('keeps another project out of the numbers', async () => {
      await seed();
      const rows = await getDb().listFileBucketStats({ projectId: 'proj-2', buckets: [{ providerKey, bucketKey }] });
      expect(rows).toEqual([{ providerKey, bucketKey, fileCount: 1, totalBytes: 9000 }]);
    });

    it('answers nothing for no buckets - not every bucket', async () => {
      await seed();
      expect(await getDb().listFileBucketStats({ projectId, buckets: [] })).toEqual([]);
    });

    it('answers a list of buckets far longer than a project has, as one list', async () => {
      await seed();
      const many = Array.from({ length: 1500 }, (_, index) => ({ providerKey, bucketKey: `bucket-${index}` }));
      const rows = await getDb().listFileBucketStats({
        projectId,
        buckets: [...many.slice(0, 700), { providerKey, bucketKey }, ...many.slice(700), { providerKey, bucketKey: 'other' }],
      });
      expect(byBucket(rows)).toEqual(byBucket([
        { providerKey, bucketKey, fileCount: 4, totalBytes: 357 },
        { providerKey, bucketKey: 'other', fileCount: 2, totalBytes: 3003 },
      ]));
    });

    it('reports a bucket once, however often it is asked for', async () => {
      await seed();
      const asked = { providerKey, bucketKey };
      const filler = Array.from({ length: 1200 }, (_, index) => ({ providerKey, bucketKey: `bucket-${index}` }));
      const rows = await getDb().listFileBucketStats({ projectId, buckets: [asked, ...filler, asked] });
      expect(rows).toEqual([{ providerKey, bucketKey, fileCount: 4, totalBytes: 357 }]);
    });

    it('without a list of buckets, groups every bucket of the project', async () => {
      await seed();
      const rows = await getDb().listFileBucketStats({ projectId });
      expect(byBucket(rows)).toEqual(byBucket([
        { providerKey, bucketKey, fileCount: 4, totalBytes: 357 },
        { providerKey, bucketKey: 'other', fileCount: 2, totalBytes: 3003 },
        { providerKey: 'second-disk', bucketKey, fileCount: 1, totalBytes: 5000 },
      ]));
    });

    it('is served by the index on (provider, bucket, key), not by a scan of the files', async () => {
      await seed();
      const db = getDb();
      const pairs = [{ providerKey, bucketKey }, { providerKey, bucketKey: 'other' }];

      if (db instanceof SQLiteProvider) {
        const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
        const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN
          SELECT providerKey, bucketKey, COUNT(*), COALESCE(SUM(size + COALESCE(markdownSize, 0)), 0)
          FROM files
          WHERE projectId = @projectId AND ((providerKey = @p0 AND bucketKey = @b0) OR (providerKey = @p1 AND bucketKey = @b1))
          GROUP BY providerKey, bucketKey`).all({
          projectId, p0: pairs[0]!.providerKey, b0: pairs[0]!.bucketKey, p1: pairs[1]!.providerKey, b1: pairs[1]!.bucketKey,
        }) as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
        expect(plan).toContain('idx_files_bucket_key');
        expect(plan).not.toMatch(/\bSCAN files\b(?! USING)/);
      } else if (db instanceof MongoDBProvider) {
        const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();
        const explained = JSON.stringify(await tenantDb.collection('files').find({
          projectId,
          $or: pairs.map((pair) => ({ providerKey: pair.providerKey, bucketKey: pair.bucketKey })),
        }).explain('queryPlanner'));
        expect(explained).toContain('IXSCAN');
        expect(explained).not.toContain('COLLSCAN');
      }
    });
  });

  describe('sumFileRecordBytes', () => {
    it('counts the Markdown copy of a file too, as the stored bytes it is', async () => {
      await put('a.pdf', { size: 100, markdownSize: 40, markdownStatus: 'succeeded', markdownKey: 'a.md' });
      await put('b.txt', { size: 10 });
      await put('c.txt', { size: 5, projectId: 'proj-2' });
      expect(await getDb().sumFileRecordBytes({ projectId })).toBe(150);
      expect(await getDb().sumFileRecordBytes({ projectId: 'proj-2' })).toBe(5);
      expect(await getDb().sumFileRecordBytes()).toBe(155);
    });

    it('is the sum of the bucket numbers', async () => {
      await put('a.pdf', { size: 100, markdownSize: 40, markdownStatus: 'succeeded', markdownKey: 'a.md' });
      await put('b.txt', { size: 10, bucketKey: 'other' });
      const total = (await getDb().listFileBucketStats({ projectId })).reduce((sum, row) => sum + row.totalBytes, 0);
      expect(total).toBe(await getDb().sumFileRecordBytes({ projectId }));
    });

    it('is zero for a project with no files', async () => {
      expect(await getDb().sumFileRecordBytes({ projectId: 'nobody' })).toBe(0);
    });
  });

  // ── Paging the flat listing ───────────────────────────────────────────

  describe('listFileRecords paging', () => {
    const list = (extra: Record<string, unknown>) => getDb().listFileRecords({ providerKey, bucketKey, projectId, ...extra });
    const pageThrough = async (filters: Record<string, unknown>, limit: number) => {
      const pages: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ ...filters, limit, cursor });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        pages.push(page.items.map((item) => item.key));
        cursor = page.nextCursor;
      } while (cursor && pages.length < 20);
      return pages;
    };

    it('reads every row once: the row that proves there is a next page is on it, not lost between the two', async () => {
      for (let i = 0; i < 7; i += 1) await put(`file-${i}.txt`);
      const pages = await pageThrough({}, 3);
      expect(pages.map((page) => page.length)).toEqual([3, 3, 1]);
      const seen = pages.flat();
      expect(new Set(seen).size).toBe(7);
      expect([...seen].sort()).toEqual(Array.from({ length: 7 }, (_, i) => `file-${i}.txt`));
    });

    it('has no next page when the rows fill the last page exactly', async () => {
      for (let i = 0; i < 6; i += 1) await put(`file-${i}.txt`);
      const pages = await pageThrough({}, 3);
      expect(pages.map((page) => page.length)).toEqual([3, 3]);
      expect((await list({ limit: 6 })).nextCursor).toBeUndefined();
      expect((await list({ limit: 5 })).nextCursor).toBeDefined();
    });

    it('does the same for a search and for a folder prefix', async () => {
      for (let i = 0; i < 5; i += 1) await put(`reports/q${i}.txt`);
      for (let i = 0; i < 4; i += 1) await put(`misc/note-${i}.txt`);
      expect((await pageThrough({ search: 'q' }, 2)).flat().sort()).toEqual(['reports/q0.txt', 'reports/q1.txt', 'reports/q2.txt', 'reports/q3.txt', 'reports/q4.txt']);
      expect((await pageThrough({ prefix: 'misc/' }, 3)).flat()).toHaveLength(4);
    });
  });

  // ── The type filter ───────────────────────────────────────────────────

  describe('listFileRecords({ type })', () => {
    /** Content type (or none) and name of each record: every way a kind can be decided. */
    const FILES: Array<{ key: string; contentType?: string; name?: string }> = [
      { key: 'pdf/by-type.bin', contentType: 'application/pdf' },
      { key: 'pdf/by-type-params.bin', contentType: 'application/pdf; qs=1' },
      { key: 'pdf/by-extension.PDF' },
      { key: 'pdf/by-extension-octet.pdf', contentType: 'application/octet-stream' },
      { key: 'pdf/blank-type.pdf', contentType: '' },
      { key: 'img/by-type.bin', contentType: 'image/png' },
      { key: 'img/upper.bin', contentType: 'IMAGE/PNG' },
      { key: 'img/svg', contentType: 'image/svg+xml' },
      { key: 'img/by-extension.jpg' },
      { key: 'img/by-extension-2.WebP', contentType: 'application/octet-stream' },
      { key: 'txt/by-type.bin', contentType: 'text/plain' },
      { key: 'txt/params.bin', contentType: 'text/plain; charset=utf-8' },
      { key: 'txt/params-no-space.bin', contentType: 'text/markdown;charset=utf-8' },
      { key: 'txt/spaced.bin', contentType: ' text/csv ' },
      { key: 'txt/html.bin', contentType: 'text/html' },
      { key: 'txt/json.bin', contentType: 'application/json' },
      { key: 'txt/json-params.bin', contentType: 'application/json; charset=utf-8' },
      { key: 'txt/by-extension.md' },
      { key: 'txt/by-extension.csv', contentType: 'application/octet-stream' },
      { key: 'office/word.bin', contentType: 'application/msword' },
      { key: 'office/docx.bin', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { key: 'office/xlsx.bin', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; x=1' },
      { key: 'office/xls.bin', contentType: 'application/vnd.ms-excel' },
      { key: 'office/ppt.bin', contentType: 'application/vnd.ms-powerpoint' },
      { key: 'office/odt.bin', contentType: 'application/vnd.oasis.opendocument.text' },
      { key: 'office/by-extension.docx' },
      { key: 'office/by-extension.XLSX', contentType: 'application/octet-stream' },
      { key: 'other/zip.bin', contentType: 'application/zip' },
      { key: 'other/video.bin', contentType: 'video/mp4' },
      { key: 'other/no-type-no-extension' },
      { key: 'other/octet.bin', contentType: 'application/octet-stream' },
      { key: 'other/json-lookalike.bin', contentType: 'application/jsonx' },
      { key: 'other/pdf-lookalike.bin', contentType: 'application/pdfx' },
      // The type wins over the name, in both directions.
      { key: 'conflict/pdf-named-txt.txt', contentType: 'application/pdf' },
      { key: 'conflict/text-named-pdf.pdf', contentType: 'text/plain' },
      { key: 'conflict/image-named-docx.docx', contentType: 'image/png' },
      // An extension counts only at the end of the name, and a wildcard character in a name is just a character.
      { key: 'edge/archive.pdf.bak' },
      { key: 'edge/100%_done.pdf' },
      { key: 'edge/100%_done.zip' },
      { key: 'edge/under_score.TXT' },
      { key: 'edge/dot.', contentType: undefined },
      { key: 'edge/a%b', contentType: 'text/%' },
    ];

    const seed = async () => {
      for (const file of FILES) await put(file.key, { name: file.name ?? file.key.split('/').pop()!, contentType: file.contentType });
      // The same kinds in another bucket, provider and project must stay out.
      await put('x/foreign.pdf', { bucketKey: 'other', contentType: 'application/pdf' });
      await put('x/foreign-2.pdf', { providerKey: 'second-disk', contentType: 'application/pdf' });
      await put('x/foreign-3.pdf', { projectId: 'proj-2', contentType: 'application/pdf' });
    };

    const list = (extra: Record<string, unknown>) => getDb().listFileRecords({ providerKey, bucketKey, projectId, ...extra });
    const expected = (type: FileTypeFilter, keep: (file: typeof FILES[number]) => boolean = () => true) => FILES
      .filter((file) => keep(file) && classifyFileKind(file.contentType, file.name ?? file.key.split('/').pop()!) === type)
      .map((file) => file.key)
      .sort();

    it.each(FILE_TYPE_FILTERS)('lists exactly the %s files, as the rule says', async (type) => {
      await seed();
      const { items, nextCursor } = await list({ type, limit: 200 });
      expect(nextCursor).toBeUndefined();
      expect(keys(items)).toEqual(expected(type));
      expect(items.length).toBeGreaterThan(0);
    });

    it('gives every file one kind: the five lists add up to the bucket', async () => {
      await seed();
      const all = keys((await list({ limit: 200 })).items);
      expect(all).toHaveLength(FILES.length);
      const listed: string[] = [];
      for (const type of FILE_TYPE_FILTERS) listed.push(...keys((await list({ type, limit: 200 })).items));
      expect(listed.sort()).toEqual(all);
      expect(new Set(listed).size).toBe(listed.length);
    });

    it('lists the spots that are easy to get wrong the way the rule does', async () => {
      await seed();
      const kindOf = async (type: FileTypeFilter) => new Set(keys((await list({ type, limit: 200 })).items));
      const [pdf, image, text, office, other] = await Promise.all(FILE_TYPE_FILTERS.map(kindOf));
      // The extension decides when the type is missing, blank or generic...
      expect(pdf!.has('pdf/by-extension.PDF') && pdf!.has('pdf/blank-type.pdf') && pdf!.has('pdf/by-extension-octet.pdf')).toBe(true);
      expect(image!.has('img/by-extension-2.WebP')).toBe(true);
      expect(office!.has('office/by-extension.XLSX')).toBe(true);
      // ...and loses to a type that names a kind.
      expect(pdf!.has('conflict/pdf-named-txt.txt')).toBe(true);
      expect(text!.has('conflict/text-named-pdf.pdf')).toBe(true);
      expect(image!.has('conflict/image-named-docx.docx')).toBe(true);
      expect(pdf!.has('conflict/text-named-pdf.pdf')).toBe(false);
      // Parameters, case and padding of the type do not matter.
      expect(text!.has('txt/params-no-space.bin') && text!.has('txt/spaced.bin') && text!.has('txt/json-params.bin')).toBe(true);
      expect(image!.has('img/upper.bin')).toBe(true);
      // A type that only starts like a known one is not that kind.
      expect(other!.has('other/json-lookalike.bin') && other!.has('other/pdf-lookalike.bin')).toBe(true);
      // An extension counts at the end of the name only; a wildcard in a name is a plain character.
      expect(other!.has('edge/archive.pdf.bak') && other!.has('edge/100%_done.zip')).toBe(true);
      expect(pdf!.has('edge/100%_done.pdf')).toBe(true);
      expect(text!.has('edge/under_score.TXT')).toBe(true);
    });

    it('keeps the other buckets, providers and projects out', async () => {
      await seed();
      for (const type of FILE_TYPE_FILTERS) {
        expect(JSON.stringify((await list({ type, limit: 200 })).items), type).not.toContain('foreign');
      }
    });

    it('lists a kind flat, however deep it is, like a search', async () => {
      await seed();
      const { items } = await list({ type: 'pdf', limit: 200 });
      expect(new Set(items.map((item) => item.key.split('/')[0]))).toEqual(new Set(['pdf', 'conflict', 'edge']));
    });

    it('composes with the folder prefix', async () => {
      await seed();
      expect(keys((await list({ type: 'pdf', prefix: 'pdf/', limit: 200 })).items)).toEqual(expected('pdf', (file) => file.key.startsWith('pdf/')));
      expect(keys((await list({ type: 'text', prefix: 'conflict/', limit: 200 })).items)).toEqual(['conflict/text-named-pdf.pdf']);
      expect(keys((await list({ type: 'image', prefix: 'office/', limit: 200 })).items)).toEqual([]);
    });

    it('composes with a search on the name', async () => {
      await seed();
      expect(keys((await list({ type: 'pdf', search: 'extension', limit: 200 })).items)).toEqual(['pdf/by-extension-octet.pdf', 'pdf/by-extension.PDF']);
      expect(keys((await list({ type: 'office', search: 'zzz', limit: 200 })).items)).toEqual([]);
    });

    it('composes with the session-file purpose', async () => {
      await put('sessions/s1/report.pdf', { contentType: 'application/pdf', purpose: 'conversation', conversationId: 'c1', agentKey: 'bot' });
      await put('upload/plain.pdf', { contentType: 'application/pdf' });
      await put('sessions/s1/notes.txt', { contentType: 'text/plain', purpose: 'conversation', conversationId: 'c1', agentKey: 'bot' });
      expect(keys((await list({ type: 'pdf', purpose: 'conversation' })).items)).toEqual(['sessions/s1/report.pdf']);
      expect(keys((await list({ type: 'pdf', purpose: 'other' })).items)).toEqual(['upload/plain.pdf']);
      expect(keys((await list({ type: 'pdf' })).items)).toEqual(['sessions/s1/report.pdf', 'upload/plain.pdf']);
    });

    it('pages with a cursor: every match once, none missed', async () => {
      await seed();
      const want = expected('text');
      expect(want.length).toBeGreaterThan(4);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list({ type: 'text', limit: 3, cursor });
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((item) => item.key));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 20);
      expect(seen.sort()).toEqual(want);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBe(Math.ceil(want.length / 3));
    });

    it('without a type the listing is the whole bucket, as before', async () => {
      await seed();
      expect((await list({ limit: 200 })).items).toHaveLength(FILES.length);
    });

    it('is served from the (provider, bucket, key) index: the kind only narrows what the index range returns', async () => {
      await seed();
      const db = getDb();
      if (db instanceof SQLiteProvider) {
        const sqlite = (db as unknown as { getTenantDb(): import('better-sqlite3').Database }).getTenantDb();
        for (const type of FILE_TYPE_FILTERS) {
          const clause = (db as unknown as { fileTypeClause(type: FileTypeFilter): string }).fileTypeClause(type);
          const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM files WHERE providerKey = @p AND bucketKey = @b AND projectId = @pr AND ${clause} ORDER BY id LIMIT 51`)
            .all({ p: providerKey, b: bucketKey, pr: projectId }) as Array<{ detail: string }>).map((row) => row.detail).join(' | ');
          expect(plan, type).toContain('idx_files_bucket_key');
          expect(plan, type).not.toMatch(/\bSCAN files\b(?! USING)/);
        }
      } else if (db instanceof MongoDBProvider) {
        const tenantDb = (db as unknown as { getTenantDb(): import('mongodb').Db }).getTenantDb();
        for (const type of FILE_TYPE_FILTERS) {
          const condition = (db as unknown as { fileTypeCondition(type: FileTypeFilter): Record<string, unknown> }).fileTypeCondition(type);
          const explained = JSON.stringify(await tenantDb.collection('files').find({ providerKey, bucketKey, projectId, $and: [condition] }).sort({ _id: 1 }).explain('queryPlanner'));
          expect(explained, type).toContain('IXSCAN');
          expect(explained, type).not.toContain('COLLSCAN');
        }
      }
    });
  });
});
