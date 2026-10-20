/**
 * Which buckets keep their files in the same place: `storageFoldersOverlap` (two folders of one provider) and
 * `findBucketsSharingStorage` (the other buckets of a tenant that share a bucket's folder). The rule behind "Import
 * from storage" and "Delete the bucket with its files": what a bucket does to its own folder is only safe when no
 * other bucket keeps files there.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(),
}));
vi.mock('@/lib/providers', () => ({
  providerRegistry: { listDescriptors: vi.fn().mockReturnValue([]), getContract: vi.fn() },
}));
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: vi.fn().mockResolvedValue('## Markdown'),
}));

import type { IFileBucketRecord } from '@/lib/database';
import { findBucketsSharingStorage, resolveBucketPrefix, storageFoldersOverlap } from '@/lib/services/files/fileService';

describe('storageFoldersOverlap', () => {
  it.each([
    ['docs', 'docs', 'the same folder'],
    ['', '', 'the provider root and itself'],
    ['', 'docs', 'the provider root, which holds every folder'],
    ['docs', '', 'a folder and the provider root'],
    ['a', 'a/b', 'a folder and one inside it'],
    ['a/b', 'a', 'a folder inside another one, the other way round'],
    ['a/b/c', 'a/b', 'a folder two levels inside'],
    ['team/docs', 'team', 'a nested folder and its parent'],
  ])('overlap: %j and %j (%s)', (a, b) => {
    expect(storageFoldersOverlap(a, b)).toBe(true);
    expect(storageFoldersOverlap(b, a)).toBe(true);
  });

  it.each([
    ['a', 'ab', 'a folder whose name only starts the same way'],
    ['docs', 'docs-archive', 'a sibling that begins with the folder\'s name'],
    ['a/b', 'a/c', 'two folders of one parent'],
    ['a/b', 'a/bc', 'a nested sibling that begins with the folder\'s name'],
    ['docs', 'archive/docs', 'the same name under another parent'],
    ['a', 'b', 'two folders'],
  ])('do not overlap: %j and %j (%s)', (a, b) => {
    expect(storageFoldersOverlap(a, b)).toBe(false);
    expect(storageFoldersOverlap(b, a)).toBe(false);
  });
});

describe('findBucketsSharingStorage', () => {
  const TENANT = 'tenant-1';
  const bucket = (over: Partial<IFileBucketRecord> = {}): IFileBucketRecord => ({
    _id: 'b-self',
    tenantId: TENANT,
    projectId: 'p1',
    key: 'docs',
    name: 'Docs',
    providerKey: 'disk',
    status: 'active',
    createdBy: 'u1',
    ...over,
  });
  const dbOf = (buckets: IFileBucketRecord[]) => ({ listFileBuckets: vi.fn().mockResolvedValue(buckets) });
  const keysOf = (found: IFileBucketRecord[]) => found.map((entry) => entry.key).sort();

  it('asks for the buckets of the whole tenant, not of one project', async () => {
    const db = dbOf([]);

    await findBucketsSharingStorage(db, TENANT, bucket());

    expect(db.listFileBuckets).toHaveBeenCalledTimes(1);
    expect(db.listFileBuckets).toHaveBeenCalledWith(TENANT);
  });

  it('finds nothing when the bucket is alone, and never counts the bucket itself', async () => {
    const self = bucket();

    expect(await findBucketsSharingStorage(dbOf([self]), TENANT, self)).toEqual([]);
    expect(await findBucketsSharingStorage(dbOf([]), TENANT, self)).toEqual([]);
  });

  it('finds a bucket of another project with the same key: the default folder is the key', async () => {
    const twin = bucket({ _id: 'b-twin', projectId: 'p2' });

    const found = await findBucketsSharingStorage(dbOf([bucket(), twin]), TENANT, bucket());

    expect(found).toEqual([twin]);
  });

  it('finds a bucket of the same project whose folder lies inside, or around, this one', async () => {
    const self = bucket({ prefix: 'team/docs' });
    const inside = bucket({ _id: 'b-in', key: 'inside', prefix: 'team/docs/archive' });
    const around = bucket({ _id: 'b-around', key: 'around', prefix: 'team' });

    const found = await findBucketsSharingStorage(dbOf([self, inside, around]), TENANT, self);

    expect(keysOf(found)).toEqual(['around', 'inside']);
  });

  it('finds a bucket without a folder of its own, which keeps its files at the provider root', async () => {
    const root = bucket({ _id: 'b-root', key: 'everything', prefix: '' });

    expect(await findBucketsSharingStorage(dbOf([bucket(), root]), TENANT, bucket())).toEqual([root]);
    // And from the root bucket's side, every other bucket of the provider is in its folder.
    expect(await findBucketsSharingStorage(dbOf([bucket(), root]), TENANT, root)).toEqual([bucket()]);
  });

  it('counts a bucket in every state: switched off and being deleted still own their files', async () => {
    const off = bucket({ _id: 'b-off', projectId: 'p2', status: 'disabled' });
    const deleting = bucket({ _id: 'b-deleting', key: 'docs', projectId: 'p3', status: 'disabled', metadata: { deleting: true } });

    const found = await findBucketsSharingStorage(dbOf([bucket(), off, deleting]), TENANT, bucket());

    expect(found).toEqual([off, deleting]);
  });

  it('leaves out a bucket of another provider, however alike the folder', async () => {
    const elsewhere = bucket({ _id: 'b-else', projectId: 'p2', providerKey: 'object-store' });

    expect(await findBucketsSharingStorage(dbOf([bucket(), elsewhere]), TENANT, bucket())).toEqual([]);
  });

  it('leaves out buckets whose folder only begins the same way', async () => {
    const buckets = [
      bucket(),
      bucket({ _id: 'b-1', key: 'docs-archive', projectId: 'p2' }),
      bucket({ _id: 'b-2', key: 'do', projectId: 'p2' }),
      bucket({ _id: 'b-3', key: 'elsewhere', prefix: 'archive/docs', projectId: 'p2' }),
      bucket({ _id: 'b-4', key: 'sibling', prefix: 'docs2' }),
    ];

    expect(await findBucketsSharingStorage(dbOf(buckets), TENANT, bucket())).toEqual([]);
  });

  it('reads a folder as the file service does: surrounding slashes and blanks do not matter', async () => {
    const spaced = bucket({ _id: 'b-spaced', key: 'other', projectId: 'p2', prefix: ' /docs/ ' });
    expect(resolveBucketPrefix(spaced)).toBe('docs');

    expect(await findBucketsSharingStorage(dbOf([bucket(), spaced]), TENANT, bucket())).toEqual([spaced]);
  });

  it('tells the bucket itself by its id, so a second bucket with the same key in another project is not "itself"', async () => {
    const mine = bucket({ _id: 'b-mine', projectId: 'p1' });
    const theirs = bucket({ _id: 'b-theirs', projectId: 'p2' });

    expect(await findBucketsSharingStorage(dbOf([mine, theirs]), TENANT, mine)).toEqual([theirs]);
    expect(await findBucketsSharingStorage(dbOf([mine, theirs]), TENANT, theirs)).toEqual([mine]);
  });

  it('tells the bucket itself by its project and key when it has no id yet', async () => {
    const unsaved = bucket();
    delete unsaved._id;
    const same = bucket({ _id: 'b-same-key' });
    const twin = bucket({ _id: 'b-twin', projectId: 'p2' });

    expect(await findBucketsSharingStorage(dbOf([same, twin]), TENANT, unsaved)).toEqual([twin]);
  });

  it('counts another bucket of the same project that keeps its files in the folder of a bucket that has no id yet', async () => {
    const unsaved = bucket();
    delete unsaved._id;
    const sibling = bucket({ _id: 'b-sibling', key: 'sibling', prefix: 'docs' });

    expect(await findBucketsSharingStorage(dbOf([sibling]), TENANT, unsaved)).toEqual([sibling]);
  });
});
