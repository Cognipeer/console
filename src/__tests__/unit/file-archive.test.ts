/**
 * The ZIP of several files (`archive.ts`): entry names that are safe and unique, the size cap checked from the
 * records before anything is read, and a stream that reads the files one after another, only when the writer gets
 * to them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

const hoisted = vi.hoisted(() => ({ requireBucketContext: vi.fn(), assertWithinReadCeiling: vi.fn(), readStoredObject: vi.fn() }));

vi.mock('@/lib/services/files/fileService', () => ({
  requireBucketContext: hoisted.requireBucketContext,
  assertWithinReadCeiling: hoisted.assertWithinReadCeiling,
  composeProviderObjectKey: (bucket: { key: string }, key: string) => `${bucket.key}/${key}`,
  readStoredObject: hoisted.readStoredObject,
}));

import {
  ARCHIVE_MAX_BYTES,
  archiveEntryName,
  archiveEntryNames,
  createFilesArchive,
} from '@/lib/services/files/archive';
import { FileServiceError } from '@/lib/services/files/errors';
import type { FileRecordView } from '@/lib/services/files/types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function record(key: string, over: Partial<FileRecordView> = {}): FileRecordView {
  return {
    id: `id-${key}`, tenantId: 't1', providerKey: 'disk', bucketKey: 'docs', key, name: key.split('/').pop()!,
    size: 10, contentType: 'text/plain', markdownStatus: 'skipped', createdBy: 'u1',
    createdAt: new Date('2026-01-02T03:04:05Z'), updatedAt: new Date('2026-01-02T03:04:05Z'),
    ...over,
  } as FileRecordView;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('archiveEntryName', () => {
  it('turns a path into one name, so an entry can neither make a folder nor leave the archive', () => {
    expect(archiveEntryName('a/b.txt')).toBe('a_b.txt');
    expect(archiveEntryName('..\\..\\evil.txt')).toBe('.._.._evil.txt');
    expect(archiveEntryName('/etc/passwd')).toBe('_etc_passwd');
  });

  it('drops control characters and surrounding blanks, and keeps hidden names', () => {
    expect(archiveEntryName('  re\u0000po\nrt.pdf ')).toBe('report.pdf');
    expect(archiveEntryName('.env')).toBe('.env');
  });

  it('never answers a name that means a folder to an unzip tool', () => {
    for (const name of ['', '   ', '.', '..', '....', '\u0000']) expect(archiveEntryName(name)).toBe('file');
  });

  it('keeps a name within the length a ZIP entry may have', () => {
    expect(archiveEntryName('n'.repeat(400))).toHaveLength(255);
  });
});

describe('archiveEntryNames', () => {
  it('numbers the files that share a name, before the extension', () => {
    expect(archiveEntryNames(['a.pdf', 'a.pdf', 'b.pdf', 'a.pdf'])).toEqual(['a.pdf', 'a (1).pdf', 'b.pdf', 'a (2).pdf']);
  });

  it('counts names that differ only by case as the same', () => {
    expect(archiveEntryNames(['Report.PDF', 'report.pdf'])).toEqual(['Report.PDF', 'report (1).pdf']);
  });

  it('also numbers names that become the same once they are made safe, and names without an extension', () => {
    expect(archiveEntryNames(['x/y.txt', 'x_y.txt', 'README', 'README'])).toEqual(['x_y.txt', 'x_y (1).txt', 'README', 'README (1)']);
  });

  it('does not take a name that a numbered one has already taken', () => {
    expect(archiveEntryNames(['a.txt', 'a (1).txt', 'a.txt'])).toEqual(['a.txt', 'a (1).txt', 'a (2).txt']);
  });
});

describe('createFilesArchive', () => {
  const downloads: string[] = [];
  let active = 0;
  let peak = 0;
  let contents: Record<string, Buffer | Error>;

  const runtime = {
    downloadFile: vi.fn(async (key: string) => {
      downloads.push(key);
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      const content = contents[key];
      if (content instanceof Error || content === undefined) throw content ?? new Error(`no object ${key}`);
      return { data: content, size: content.length };
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    downloads.length = 0;
    active = 0;
    peak = 0;
    contents = {};
    hoisted.requireBucketContext.mockResolvedValue({ bucket: { key: 'docs', tenantId: 't1', providerKey: 'disk' }, provider: {}, runtime });
    hoisted.assertWithinReadCeiling.mockReset();
    // The service's read keeps the retries of a file call; the memory budget has a test of its own.
    hoisted.readStoredObject.mockReset();
    hoisted.readStoredObject.mockImplementation(async (from: typeof runtime, objectKey: string, source: { tenantId: string; providerKey: string }) => {
      const { withResilience } = await import('@/lib/core/resilience');
      return withResilience(() => from.downloadFile(objectKey), { key: `file-download:${source.tenantId}:${source.providerKey}` });
    });
  });

  it('holds the files under their names, with their bytes, and is named after the bucket', async () => {
    contents = { 'docs/a.txt': Buffer.from('alpha'), 'docs/sub/b.bin': Buffer.from([0, 1, 2, 255]), 'docs/other/a.txt': Buffer.from('beta') };

    const archive = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('a.txt'), record('sub/b.bin', { contentType: 'application/octet-stream' }), record('other/a.txt')]);
    expect(archive.fileName).toBe('docs-files.zip');
    expect(archive.count).toBe(3);

    const zip = await JSZip.loadAsync(await collect(archive.stream));
    expect(Object.keys(zip.files).sort()).toEqual(['a (1).txt', 'a.txt', 'b.bin']);
    expect(await zip.file('a.txt')!.async('string')).toBe('alpha');
    expect(await zip.file('a (1).txt')!.async('string')).toBe('beta');
    expect([...(await zip.file('b.bin')!.async('uint8array'))]).toEqual([0, 1, 2, 255]);
  });

  it('reads a switched-off bucket too', async () => {
    contents = { 'docs/a.txt': Buffer.from('x') };
    await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('a.txt')]);
    expect(hoisted.requireBucketContext).toHaveBeenCalledWith('tenant_x', 't1', 'p1', 'docs', 'read');
  });

  it('reads the objects one after another, and only when the stream is read', async () => {
    contents = Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [`docs/${name}.txt`, Buffer.from(name.repeat(1000))]));

    const archive = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', ['a', 'b', 'c', 'd'].map((name) => record(`${name}.txt`)));
    await sleep(30);
    expect(downloads).toEqual([]);

    await collect(archive.stream);
    expect(downloads).toEqual(['docs/a.txt', 'docs/b.txt', 'docs/c.txt', 'docs/d.txt']);
    expect(peak).toBe(1);
  });

  it('reads each object as one of the reads of the process, by the size its record gives', async () => {
    contents = { 'docs/a.txt': Buffer.from('alpha'), 'docs/b.txt': Buffer.from('beta') };

    const archive = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('a.txt', { size: 5 }), record('b.txt', { size: 4 })]);
    await collect(archive.stream);

    expect(hoisted.readStoredObject.mock.calls.map(([, objectKey, source]) => [objectKey, source])).toEqual([
      ['docs/a.txt', { tenantId: 't1', providerKey: 'disk', size: 5 }],
      ['docs/b.txt', { tenantId: 't1', providerKey: 'disk', size: 4 }],
    ]);
  });

  it('refuses files that add up to more than the limit before it reads any of them', async () => {
    const big = (key: string) => record(key, { size: ARCHIVE_MAX_BYTES / 2 + 1 });
    await expect(createFilesArchive('tenant_x', 't1', 'p1', 'docs', [big('a.bin'), big('b.bin')])).rejects.toMatchObject({
      code: 'archive_too_large',
      status: 413,
      details: { limitBytes: ARCHIVE_MAX_BYTES, totalBytes: ARCHIVE_MAX_BYTES + 2 },
    });
    expect(runtime.downloadFile).not.toHaveBeenCalled();
  });

  it('asks, for every file, whether the server may read it whole, and reads nothing when one is too large', async () => {
    hoisted.assertWithinReadCeiling.mockImplementation((size?: number) => {
      if ((size ?? 0) > 1000) throw new FileServiceError('object_too_large', 413, 'The file is larger than the ceiling.');
    });

    await expect(createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('a.txt', { size: 10 }), record('huge.bin', { size: 2000 })])).rejects.toMatchObject({
      code: 'object_too_large',
      status: 413,
    });

    expect(hoisted.assertWithinReadCeiling.mock.calls.map(([size]) => size)).toEqual([10, 2000]);
    expect(runtime.downloadFile).not.toHaveBeenCalled();
  });

  it('takes files that add up to exactly the limit', async () => {
    const half = (key: string) => record(key, { size: ARCHIVE_MAX_BYTES / 2 });
    const archive = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [half('a.bin'), half('b.bin')]);
    expect(archive.count).toBe(2);
    archive.stream.destroy();
  });

  it('ends the stream with an error when an object cannot be read, and reads no further', async () => {
    contents = { 'docs/a.txt': Buffer.from('alpha'), 'docs/b.txt': new Error('storage down'), 'docs/c.txt': Buffer.from('gamma') };

    const archive = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', ['a', 'b', 'c'].map((name) => record(`${name}.txt`)));
    await expect(collect(archive.stream)).rejects.toThrow('storage down');
    // The failing object may be tried again (the file calls retry); the one after it is never reached.
    expect(downloads[0]).toBe('docs/a.txt');
    expect(downloads.slice(1).every((key) => key === 'docs/b.txt')).toBe(true);
    expect(downloads).not.toContain('docs/c.txt');
  });

  it('compresses what compresses well and stores the rest', async () => {
    const repetitive = Buffer.alloc(20_000, 'a');
    contents = { 'docs/notes.txt': repetitive, 'docs/blob.bin': repetitive };

    const text = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('notes.txt', { size: repetitive.length })]);
    const binary = await createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('blob.bin', { size: repetitive.length, contentType: 'application/octet-stream' })]);

    expect((await collect(text.stream)).length).toBeLessThan(2_000);
    expect((await collect(binary.stream)).length).toBeGreaterThan(repetitive.length);
  });

  it('does not build an archive when the bucket or its provider cannot be used', async () => {
    hoisted.requireBucketContext.mockRejectedValueOnce(Object.assign(new Error('File provider is not active.'), { code: 'provider_inactive' }));
    await expect(createFilesArchive('tenant_x', 't1', 'p1', 'docs', [record('a.txt')])).rejects.toThrow('not active');
  });
});
