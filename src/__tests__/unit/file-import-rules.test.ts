/**
 * "Import from storage" (services/files/importFromStorage.ts) against a fake provider and database: which of the
 * objects a listing returns become files and which are left alone, what a record of an imported file holds, how the
 * pages are asked for, the project's limits, and that two imports of one bucket never run side by side. The routes
 * and the real disk driver are exercised in api/files-batch-archive-import-real-stack.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/core/resilience', () => ({ withResilience: (run: () => unknown) => run() }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn(), resolveEffectiveLimits: vi.fn() }));
vi.mock('@/lib/services/files/fileService', () => ({
  requireBucketContext: vi.fn(),
  resolveBucketPrefix: vi.fn(),
  findBucketsSharingStorage: vi.fn(),
  fileResilience: vi.fn(() => ({})),
}));

import { getDatabase } from '@/lib/database';
import { checkResourceQuota, resolveEffectiveLimits } from '@/lib/quota/quotaGuard';
import { bucketInactiveError, FileServiceError } from '@/lib/services/files/errors';
import { fileResilience, findBucketsSharingStorage, requireBucketContext, resolveBucketPrefix } from '@/lib/services/files/fileService';
import { IMPORT_DEFAULT_LIMIT, IMPORT_MAX_LIMIT, importFromStorage, isAddressableObjectKey } from '@/lib/services/files/importFromStorage';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

interface Handle { key: string; size?: number; etag?: string; checksum?: string; contentType?: string }
interface KnownRecord { key: string; markdownKey?: string }

const INPUT = { tenantDbName: 'tenant_acme', tenantId: 't1', projectId: 'p1', bucketKey: 'docs', importedBy: 'u1' };

let handles: Handle[];
let nextCursor: string | undefined;
let known: KnownRecord[];
/** Keys another node registers between the lookup of a page and the insert of its records. */
let racing: Set<string>;
/** The bucket as the database holds it after the records were saved; `null` = gone. */
let bucketNow: Record<string, unknown> | null;
let used: number;
let usedBytes: number;
let driver: string;
let folder: string;
let listFiles: ReturnType<typeof vi.fn>;
let db: {
  switchToTenant: ReturnType<typeof vi.fn>;
  listFileRecordsByKeys: ReturnType<typeof vi.fn>;
  findFileRecordByKey: ReturnType<typeof vi.fn>;
  createFileRecord: ReturnType<typeof vi.fn>;
  deleteFileRecord: ReturnType<typeof vi.fn>;
  findFileBucketByKey: ReturnType<typeof vi.fn>;
  countFileRecords: ReturnType<typeof vi.fn>;
  sumFileRecordBytes: ReturnType<typeof vi.fn>;
};

const bucketOf = (key: string) => ({ key, providerKey: 'disk', tenantId: 't1' });
const created = () => db.createFileRecord.mock.calls.map(([record]) => record as Record<string, unknown>);
const createdKeys = () => created().map((record) => record.key).sort();

beforeEach(() => {
  vi.clearAllMocks();
  handles = [];
  nextCursor = undefined;
  known = [];
  racing = new Set();
  bucketNow = { key: 'docs', providerKey: 'disk', tenantId: 't1', status: 'active' };
  used = 0;
  usedBytes = 0;
  driver = 'aws-s3';
  folder = 'docs';

  listFiles = vi.fn(async () => ({ items: handles, ...(nextCursor ? { nextCursor } : {}) }));
  db = {
    switchToTenant: vi.fn(async () => undefined),
    listFileRecordsByKeys: vi.fn(async ({ keys, field }: { keys: string[]; field?: 'key' | 'markdownKey' }) =>
      known.filter((record) => keys.includes((field === 'markdownKey' ? record.markdownKey : record.key) ?? '\u0000'))),
    findFileRecordByKey: vi.fn(async (_provider: string, _bucket: string, key: string) => (racing.has(key) ? { _id: `other-${key}`, key } : null)),
    createFileRecord: vi.fn(async (record: Record<string, unknown>) => ({ _id: `id-${String(record.key)}`, ...record })),
    deleteFileRecord: vi.fn(async () => true),
    findFileBucketByKey: vi.fn(async () => bucketNow),
    countFileRecords: vi.fn(async () => used),
    sumFileRecordBytes: vi.fn(async () => usedBytes),
  };
  mockFn(getDatabase).mockResolvedValue(db);
  mockFn(requireBucketContext).mockImplementation(async (_db: string, _tenant: string, _project: string, key: string) => ({
    bucket: bucketOf(key),
    provider: { driver },
    runtime: { listFiles },
  }));
  mockFn(resolveBucketPrefix).mockImplementation(() => folder);
  mockFn(findBucketsSharingStorage).mockResolvedValue([]);
  mockFn(checkResourceQuota).mockResolvedValue({ allowed: true, effectiveLimits: {} });
  mockFn(resolveEffectiveLimits).mockResolvedValue({});
});

describe('which objects become files', () => {
  it('registers the objects of the bucket folder under their keys inside it, with what the listing says about them', async () => {
    handles = [
      { key: 'docs/a.txt', size: 3, etag: 'e1', checksum: 'c1', contentType: 'text/plain' },
      { key: 'docs/sub/b.pdf', size: 5 },
      { key: 'docs/noextension', size: 1 },
    ];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 3, imported: 3, skipped: 0 });
    const byKey = Object.fromEntries(created().map((record) => [record.key, record]));
    expect(byKey['a.txt']).toEqual({
      tenantId: 't1', projectId: 'p1', providerKey: 'disk', bucketKey: 'docs', key: 'a.txt', name: 'a.txt', size: 3,
      contentType: 'text/plain', checksum: 'c1', etag: 'e1', markdownStatus: 'skipped', origin: 'import', uploadedBy: 'u1', createdBy: 'u1',
    });
    // No content type in the listing: the name says what it is.
    expect(byKey['sub/b.pdf']).toMatchObject({ key: 'sub/b.pdf', name: 'b.pdf', contentType: 'application/pdf' });
    expect(byKey['sub/b.pdf']).not.toHaveProperty('checksum');
    expect(byKey['sub/b.pdf']).not.toHaveProperty('etag');
    // Nothing says what it is: no content type is invented.
    expect(byKey.noextension).not.toHaveProperty('contentType');
  });

  it('works for a bucket without a folder: every object of the provider, under its whole key', async () => {
    folder = '';
    handles = [{ key: 'a.txt', size: 1 }, { key: 'x/y/b.txt', size: 1 }];

    const result = await importFromStorage(INPUT);

    expect(result.imported).toBe(2);
    expect(createdKeys()).toEqual(['a.txt', 'x/y/b.txt']);
    expect(listFiles.mock.calls[0]![0]).not.toHaveProperty('prefix');
  });

  it('leaves out what the listing returns that is not inside the folder: a prefix is matched as text', async () => {
    handles = [
      { key: 'docs-archive/x.txt', size: 1 },
      { key: 'docsx', size: 1 },
      { key: 'other/y.txt', size: 1 },
      { key: 'docs/a.txt', size: 1 },
    ];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 4, imported: 1, skipped: 3 });
    expect(createdKeys()).toEqual(['a.txt']);
  });

  it('takes a key with a leading slash for the key it is', async () => {
    handles = [{ key: '/docs/a.txt', size: 1 }];

    await importFromStorage(INPUT);

    expect(createdKeys()).toEqual(['a.txt']);
  });

  it('leaves out the folder itself and "folder" placeholders', async () => {
    handles = [{ key: 'docs/', size: 0 }, { key: 'docs/sub/', size: 0 }, { key: 'docs/sub/real.txt', size: 1 }];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 3, imported: 1, skipped: 2 });
    expect(createdKeys()).toEqual(['sub/real.txt']);
  });

  it('leaves out the folder the connection test of a provider writes to', async () => {
    handles = [{ key: 'docs/.cognipeer-connection-test/probe', size: 1 }, { key: 'docs/real.txt', size: 1 }];
    expect(await importFromStorage(INPUT)).toEqual({ scanned: 2, imported: 1, skipped: 1 });

    folder = '';
    db.createFileRecord.mockClear();
    handles = [{ key: '.cognipeer-connection-test/probe', size: 1 }, { key: 'real.txt', size: 1 }];
    expect(await importFromStorage(INPUT)).toEqual({ scanned: 2, imported: 1, skipped: 1 });
    expect(createdKeys()).toEqual(['real.txt']);
  });

  it('leaves out the metadata companions only of the drivers that keep them', async () => {
    handles = [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/a.txt.meta.json', size: 1 }];

    driver = 'local-filesystem';
    expect(await importFromStorage(INPUT)).toEqual({ scanned: 2, imported: 1, skipped: 1 });
    expect(createdKeys()).toEqual(['a.txt']);

    // On another driver a file called ".meta.json" is a file like any other.
    driver = 'aws-s3';
    db.createFileRecord.mockClear();
    expect(await importFromStorage(INPUT)).toEqual({ scanned: 2, imported: 2, skipped: 0 });
    expect(createdKeys()).toEqual(['a.txt', 'a.txt.meta.json']);
  });

  it('leaves out the objects that already have a record, and the ones that are the Markdown copy of a record', async () => {
    known = [{ key: 'known.txt' }, { key: 'report.pdf', markdownKey: 'report.md' }];
    handles = [
      { key: 'docs/known.txt', size: 1 },
      { key: 'docs/report.pdf', size: 1 },
      { key: 'docs/report.md', size: 1 },
      { key: 'docs/new.txt', size: 1 },
    ];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 4, imported: 1, skipped: 3 });
    expect(createdKeys()).toEqual(['new.txt']);
  });

  it('asks the database once for the records of the keys and once for the copies, inside the bucket and project', async () => {
    handles = [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/b.txt', size: 1 }];

    await importFromStorage(INPUT);

    expect(db.listFileRecordsByKeys).toHaveBeenCalledTimes(2);
    const base = { providerKey: 'disk', bucketKey: 'docs', projectId: 'p1', keys: ['a.txt', 'b.txt'] };
    expect(db.listFileRecordsByKeys).toHaveBeenCalledWith(base);
    expect(db.listFileRecordsByKeys).toHaveBeenCalledWith({ ...base, field: 'markdownKey' });
    expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
  });

  it('does not ask who the files are for a page that has nothing to register', async () => {
    known = [{ key: 'a.txt' }];
    handles = [{ key: 'docs/a.txt', size: 1 }];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 1, imported: 0, skipped: 1 });
    expect(checkResourceQuota).not.toHaveBeenCalled();
    expect(db.createFileRecord).not.toHaveBeenCalled();
  });

  it('records a size of 0 for an object whose listing has none', async () => {
    handles = [{ key: 'docs/a.txt' }];

    await importFromStorage(INPUT);

    expect(created()[0]).toMatchObject({ key: 'a.txt', size: 0 });
  });

  it('registers at most four files at a time', async () => {
    handles = Array.from({ length: 11 }, (_, index) => ({ key: `docs/f${index}.txt`, size: 1 }));
    let inFlight = 0;
    let peak = 0;
    db.createFileRecord.mockImplementation(async (record: Record<string, unknown>) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return { _id: String(record.key), ...record };
    });

    const result = await importFromStorage(INPUT);

    expect(result.imported).toBe(11);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('the content type of an imported file', () => {
  const typeOf = async (key: string, listed?: string) => {
    db.createFileRecord.mockClear();
    handles = [{ key: `docs/${key}`, size: 1, ...(listed === undefined ? {} : { contentType: listed }) }];
    await importFromStorage(INPUT);
    return created()[0]!.contentType;
  };

  it('is the one the listing reports when it says something specific', async () => {
    expect(await typeOf('photo.png', 'image/png')).toBe('image/png');
    // The store knows better than the name does.
    expect(await typeOf('dump.bin', 'application/pdf')).toBe('application/pdf');
    expect(await typeOf('page.txt', 'text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
  });

  it.each([
    'application/octet-stream',
    'Application/Octet-Stream',
    'application/octet-stream; charset=binary',
    ' application/octet-stream ',
    'binary/octet-stream',
  ])('is asked of the name when the listing reports the generic type %j: a blob written without a type holds that one', async (generic) => {
    expect(await typeOf('report.pdf', generic)).toBe('application/pdf');
    expect(await typeOf('photo.png', generic)).toBe('image/png');
  });

  it('keeps the generic type when the name says nothing better, and invents none when nothing is listed or named', async () => {
    expect(await typeOf('noextension', 'application/octet-stream')).toBe('application/octet-stream');
    expect(await typeOf('data.unknownext', 'binary/octet-stream')).toBe('binary/octet-stream');
    expect(await typeOf('noextension')).toBeUndefined();
    expect(await typeOf('noextension', '')).toBeUndefined();
  });
});

describe('keys the drivers would rewrite', () => {
  it.each([
    ['report.final.txt', true],
    ['sub/dir/file.txt', true],
    ['with space.txt', true],
    ['ünïcode/şirket.pdf', true],
    ['a.b.c.txt', true],
    ['report..final.txt', false],
    ['dir\\file.txt', false],
    ['a//b.txt', false],
    ['/leading.txt', false],
    ['x/./y.txt', false],
    ['./x.txt', false],
    ['x/../y.txt', false],
    [' leading-space.txt', false],
    ['trailing-space.txt ', false],
    ['control\u0001.txt', false],
    ['delete\u007f.txt', false],
    ['line\nbreak.txt', false],
    ['', false],
  ])('judges %j addressable: %s', (key, expected) => {
    expect(isAddressableObjectKey(key)).toBe(expected);
  });

  it('takes a key of exactly the longest length the routes accept, and not one character more', () => {
    expect(isAddressableObjectKey('a'.repeat(1024))).toBe(true);
    expect(isAddressableObjectKey('a'.repeat(1025))).toBe(false);
  });

  it('leaves such objects out and counts them as skipped, so scanned = imported + skipped still holds', async () => {
    handles = [
      { key: 'docs/report.final.txt', size: 1 },
      { key: 'docs/report..final.txt', size: 1 },
      { key: 'docs/dir\\file.txt', size: 1 },
      { key: 'docs/a//b.txt', size: 1 },
      { key: 'docs/x/./y.txt', size: 1 },
      { key: 'docs/ctl\u0001.txt', size: 1 },
      { key: `docs/${'k'.repeat(1030)}`, size: 1 },
    ];

    const result = await importFromStorage(INPUT);

    expect(result).toEqual({ scanned: 7, imported: 1, skipped: 6 });
    expect(createdKeys()).toEqual(['report.final.txt']);
  });
});

describe('a storage location another bucket uses', () => {
  const other = { _id: 'b2', key: 'docs', projectId: 'p2', providerKey: 'disk' };

  it('refuses the import with a 409 before anything is listed or registered', async () => {
    mockFn(findBucketsSharingStorage).mockResolvedValue([other]);
    handles = [{ key: 'docs/theirs.txt', size: 1 }];

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({
      code: 'storage_location_shared',
      status: 409,
      message: 'Another bucket uses this storage location, so objects in it cannot be imported.',
    });

    expect(listFiles).not.toHaveBeenCalled();
    expect(db.listFileRecordsByKeys).not.toHaveBeenCalled();
    expect(db.createFileRecord).not.toHaveBeenCalled();
  });

  it('asks about this bucket of this tenant, across projects', async () => {
    await importFromStorage(INPUT);

    expect(findBucketsSharingStorage).toHaveBeenCalledWith(db, 't1', expect.objectContaining({ key: 'docs', providerKey: 'disk' }));
  });

  it('leaves the bucket free to import again once the other one is gone', async () => {
    mockFn(findBucketsSharingStorage).mockResolvedValueOnce([other]);
    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'storage_location_shared' });

    handles = [{ key: 'docs/a.txt', size: 1 }];
    expect(await importFromStorage(INPUT)).toMatchObject({ imported: 1 });
  });
});

describe('an object another node registered meanwhile', () => {
  it('is not registered twice: the key is asked right before the insert, and the answer counts only what was inserted', async () => {
    handles = [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/b.txt', size: 1 }, { key: 'docs/c.txt', size: 1 }];
    racing = new Set(['b.txt']);

    const result = await importFromStorage(INPUT);

    expect(createdKeys()).toEqual(['a.txt', 'c.txt']);
    expect(result).toEqual({ scanned: 3, imported: 2, skipped: 1 });
    expect(db.findFileRecordByKey).toHaveBeenCalledWith('disk', 'docs', 'b.txt', 'p1');
  });
});

describe('a bucket that stops taking files while the import runs', () => {
  const threeFiles = () => [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/b.txt', size: 1 }, { key: 'docs/c.txt', size: 1 }];
  const takenBack = () => db.deleteFileRecord.mock.calls.map(([id]) => String(id)).sort();

  it.each([
    ['gone', null, 'bucket_deleting'],
    ['switched off', { key: 'docs', providerKey: 'disk', tenantId: 't1', status: 'disabled' }, 'bucket_inactive'],
    ['being deleted', { key: 'docs', providerKey: 'disk', tenantId: 't1', status: 'disabled', metadata: { deleting: true } }, 'bucket_deleting'],
    ['being deleted and still switched on', { key: 'docs', providerKey: 'disk', tenantId: 't1', status: 'active', metadata: { deleting: true } }, 'bucket_deleting'],
  ])('takes back every record of the run and refuses the import when the bucket is %s', async (_label, closed, code) => {
    handles = threeFiles();
    bucketNow = closed;

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code, status: 409 });

    expect(takenBack()).toEqual(['id-a.txt', 'id-b.txt', 'id-c.txt']);
    expect(db.findFileBucketByKey).toHaveBeenCalledWith('t1', 'docs', 'p1');
  });

  it('asks again only after the records are saved, and does not touch the provider', async () => {
    handles = threeFiles();
    const order: string[] = [];
    db.createFileRecord.mockImplementation(async (record: Record<string, unknown>) => {
      order.push(`create ${String(record.key)}`);
      return { _id: `id-${String(record.key)}`, ...record };
    });
    db.findFileBucketByKey.mockImplementation(async () => {
      order.push('bucket');
      return bucketNow;
    });

    await importFromStorage(INPUT);

    expect(order.indexOf('bucket')).toBe(3);
    expect(order.filter((entry) => entry === 'bucket')).toHaveLength(1);
    expect(db.deleteFileRecord).not.toHaveBeenCalled();
  });

  it('takes back only the records this run made: the ones that were already there stay', async () => {
    known = [{ key: 'a.txt' }];
    handles = threeFiles();
    bucketNow = null;

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_deleting' });

    expect(takenBack()).toEqual(['id-b.txt', 'id-c.txt']);
  });

  it('does not take back a record another node registered meanwhile: it is not this run\'s', async () => {
    handles = threeFiles();
    racing = new Set(['b.txt']);
    bucketNow = null;

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_deleting' });

    expect(takenBack()).toEqual(['id-a.txt', 'id-c.txt']);
  });

  it('is still refused when some of the records cannot be taken back: the refusal is the answer, and the rest are taken back', async () => {
    handles = threeFiles();
    bucketNow = null;
    db.deleteFileRecord.mockImplementation(async (id: string) => {
      if (id === 'id-a.txt') throw new Error('SQLITE_BUSY: database is locked');
      return true;
    });

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_deleting' });

    expect(takenBack()).toEqual(['id-a.txt', 'id-b.txt', 'id-c.txt']);
  });

  it('leaves the import as it is when the bucket cannot be read again', async () => {
    handles = threeFiles();
    db.findFileBucketByKey.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

    expect(await importFromStorage(INPUT)).toEqual({ scanned: 3, imported: 3, skipped: 0 });

    expect(db.deleteFileRecord).not.toHaveBeenCalled();
  });

  it('asks nothing of the bucket when there was nothing to register', async () => {
    known = [{ key: 'a.txt' }];
    handles = [{ key: 'docs/a.txt', size: 1 }];
    bucketNow = null;

    expect(await importFromStorage(INPUT)).toEqual({ scanned: 1, imported: 0, skipped: 1 });

    expect(db.findFileBucketByKey).not.toHaveBeenCalled();
  });

  it('lets the next import run once this one has been refused', async () => {
    handles = threeFiles();
    bucketNow = null;
    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_deleting' });

    bucketNow = { key: 'docs', providerKey: 'disk', tenantId: 't1', status: 'active' };
    db.createFileRecord.mockClear();
    expect(await importFromStorage(INPUT)).toEqual({ scanned: 3, imported: 3, skipped: 0 });
  });
});

describe('the pages', () => {
  it('asks for the folder, a default page and no cursor at first', async () => {
    await importFromStorage(INPUT);

    expect(IMPORT_DEFAULT_LIMIT).toBe(200);
    expect(listFiles).toHaveBeenCalledWith({ prefix: 'docs', limit: 200 });
  });

  it('hands the cursor of the previous page on, and the cursor of the next one back', async () => {
    nextCursor = 'next-position';
    handles = [{ key: 'docs/a.txt', size: 1 }];

    const result = await importFromStorage({ ...INPUT, cursor: 'this-position', limit: 1 });

    expect(listFiles).toHaveBeenCalledWith({ prefix: 'docs', limit: 1, cursor: 'this-position' });
    expect(result).toEqual({ scanned: 1, imported: 1, skipped: 0, nextCursor: 'next-position' });
  });

  it('leaves the cursor out of the answer on the last page', async () => {
    handles = [{ key: 'docs/a.txt', size: 1 }];

    expect(await importFromStorage(INPUT)).not.toHaveProperty('nextCursor');
  });

  it.each([
    [undefined, IMPORT_DEFAULT_LIMIT],
    [1, 1],
    [37, 37],
    [IMPORT_MAX_LIMIT, IMPORT_MAX_LIMIT],
    [IMPORT_MAX_LIMIT + 1, IMPORT_MAX_LIMIT],
    [100_000, IMPORT_MAX_LIMIT],
    [0, 1],
    [-4, 1],
    [2.9, 2],
  ])('asks for a page of at most %s objects: %s', async (asked, expected) => {
    await importFromStorage({ ...INPUT, ...(asked === undefined ? {} : { limit: asked }) });

    expect(listFiles.mock.calls[0]![0].limit).toBe(expected);
  });
});

describe('who may import into what', () => {
  it('needs a bucket that takes writes: the bucket is looked up for a write, and a refusal ends the import', async () => {
    mockFn(requireBucketContext).mockRejectedValueOnce(bucketInactiveError());

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_inactive', status: 409 });

    expect(requireBucketContext).toHaveBeenCalledWith('tenant_acme', 't1', 'p1', 'docs', 'write');
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('lets a failing provider end the import with its own error', async () => {
    listFiles.mockRejectedValueOnce(new FileServiceError('provider_invalid', 502, 'The storage provider is not usable.'));

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'provider_invalid' });
  });
});

describe('the project limits', () => {
  const fresh = (count: number, size = 1) => Array.from({ length: count }, (_, index) => ({ key: `docs/new-${index}.txt`, size }));

  it('refuses files that would pass the number of files the project may hold, and registers none', async () => {
    used = 5;
    handles = fresh(3);
    mockFn(checkResourceQuota).mockResolvedValueOnce({ allowed: false, effectiveLimits: { quotas: { maxFilesTotal: 7 } } });

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'quota_exceeded', status: 429, message: expect.stringContaining('7 files') });

    expect(db.createFileRecord).not.toHaveBeenCalled();
  });

  it('asks whether the LAST new file still fits: the limit is the number of files the project may hold', async () => {
    used = 5;
    handles = fresh(3);

    await importFromStorage(INPUT);

    // 5 in use; the third new file is the 8th: the check asks about "7 held, one more".
    expect(checkResourceQuota).toHaveBeenCalledWith(
      { domain: 'file', projectId: 'p1', providerKey: 'disk', resourceKey: 'docs', tenantDbName: 'tenant_acme', tenantId: 't1', userId: 'u1' },
      'filesTotal',
      7,
    );
    expect(db.countFileRecords).toHaveBeenCalledWith({ projectId: 'p1' });
  });

  it('counts only the files that are new', async () => {
    used = 2;
    known = [{ key: 'old-1.txt' }, { key: 'old-2.txt' }];
    handles = [{ key: 'docs/old-1.txt', size: 1 }, { key: 'docs/old-2.txt', size: 1 }, ...fresh(1)];

    await importFromStorage(INPUT);

    expect(checkResourceQuota).toHaveBeenCalledWith(expect.anything(), 'filesTotal', 2);
  });

  it('refuses files that would pass the bytes the project may store, and registers none', async () => {
    usedBytes = 90;
    handles = fresh(2, 6);
    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: { maxStorageBytes: 100 } });

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'quota_exceeded', status: 429, message: expect.stringContaining('102/100') });

    expect(db.createFileRecord).not.toHaveBeenCalled();
  });

  it('takes files that fill the storage exactly', async () => {
    usedBytes = 90;
    handles = fresh(2, 5);
    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: { maxStorageBytes: 100 } });

    expect(await importFromStorage(INPUT)).toMatchObject({ imported: 2 });
  });

  it.each([[undefined], [-1]])('does not add up the stored bytes when the limit is %s: there is none', async (maxStorageBytes) => {
    handles = fresh(2, 999_999_999);
    mockFn(resolveEffectiveLimits).mockResolvedValue({ quotas: maxStorageBytes === undefined ? {} : { maxStorageBytes } });

    expect(await importFromStorage(INPUT)).toMatchObject({ imported: 2 });
    expect(db.sumFileRecordBytes).not.toHaveBeenCalled();
  });
});

describe('two imports of one bucket', () => {
  const blocked = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    listFiles.mockImplementationOnce(async () => {
      await gate;
      return { items: [{ key: 'docs/a.txt', size: 1 }] };
    });
    return release;
  };

  it('do not run side by side: the second is refused with a 409 while the first is running', async () => {
    const release = blocked();
    const first = importFromStorage(INPUT);
    await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));

    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'import_in_progress', status: 409 });

    release();
    await expect(first).resolves.toMatchObject({ imported: 1 });
    // Once the first is done the bucket can be imported again.
    expect(await importFromStorage(INPUT)).toMatchObject({ scanned: 0 });
  });

  it('are independent for different buckets and different projects', async () => {
    const release = blocked();
    const first = importFromStorage(INPUT);
    await vi.waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));

    await expect(importFromStorage({ ...INPUT, bucketKey: 'other' })).resolves.toMatchObject({ scanned: 0 });
    await expect(importFromStorage({ ...INPUT, projectId: 'p2' })).resolves.toMatchObject({ scanned: 0 });

    release();
    await first;
  });

  it('leave the bucket free when one fails, wherever it fails', async () => {
    listFiles.mockRejectedValueOnce(new Error('listing failed'));
    await expect(importFromStorage(INPUT)).rejects.toThrow('listing failed');

    handles = [{ key: 'docs/a.txt', size: 1 }, { key: 'docs/b.txt', size: 1 }];
    db.createFileRecord.mockRejectedValueOnce(new Error('database failed'));
    await expect(importFromStorage(INPUT)).rejects.toThrow('database failed');

    db.createFileRecord.mockClear();
    expect(await importFromStorage(INPUT)).toMatchObject({ scanned: 2 });
  });

  it('are not blocked by a refused request: a bucket that takes no writes holds no lock', async () => {
    mockFn(requireBucketContext).mockRejectedValueOnce(bucketInactiveError());
    await expect(importFromStorage(INPUT)).rejects.toMatchObject({ code: 'bucket_inactive' });

    await expect(importFromStorage(INPUT)).resolves.toMatchObject({ scanned: 0 });
  });
});

describe('the resilience of the listing', () => {
  it('is asked under the provider\'s list policy', async () => {
    await importFromStorage(INPUT);

    expect(fileResilience).toHaveBeenCalledWith('list', 't1', 'disk');
  });
});
