/**
 * fileService — the text (markdown) copy of a stored file, against an in-memory object store:
 *  - a markdown original keeps its own object (its text copy is written beside it, not over it);
 *  - `convertToMarkdown: false` stores the bytes as the only version, on upload and on a rewrite
 *    (what an agent writes to its files is stored byte for byte; the recorded size is the bytes stored).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  convert: vi.fn(),
  records: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/providers/providerService', () => ({
  createProviderConfig: vi.fn(),
  getProviderConfigByKey: vi.fn(),
  listProviderConfigs: vi.fn(),
  loadProviderRuntimeData: vi.fn(async () => ({
    record: { key: 'store', type: 'file', status: 'active', driver: 'memory-files', settings: {}, metadata: {} },
    credentials: {},
  })),
}));
vi.mock('@/lib/providers', () => ({
  providerRegistry: {
    listDescriptors: vi.fn().mockReturnValue([]),
    getContract: vi.fn().mockReturnValue({ id: 'memory-files', capabilities: { upload: true, download: true } }),
    createRuntime: vi.fn(async () => ({
      uploadFile: async (input: { key: string; name: string; contentType?: string; data: Buffer }) => {
        hoisted.objects.set(input.key, Buffer.from(input.data));
        return { handle: { key: input.key, name: input.name, contentType: input.contentType, size: input.data.length } };
      },
      // The copy is not written over an object that is already there: the store is asked first.
      getFileMetadata: async (key: string) => (hoisted.objects.has(key) ? { key, name: key, size: hoisted.objects.get(key)!.length } : null),
      deleteFile: async (key: string) => { hoisted.objects.delete(key); },
    })),
  },
}));
// Like the real converter: the text copy is normalized (surrounding whitespace is dropped).
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: hoisted.convert,
}));

import { getDatabase } from '@/lib/database';
import { replaceFileContent, uploadFile } from '@/lib/services/files/fileService';
import { createMockDb } from '../helpers/db.mock';

const BUCKET = { _id: 'b1', tenantId: 't1', projectId: 'p1', key: 'docs', name: 'Docs', providerKey: 'store', status: 'active', createdBy: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.objects.clear();
  hoisted.records.clear();
  hoisted.convert.mockImplementation(async (data: Buffer) => ({ markdown: data.toString('utf8').trim() }));
  const db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findFileBucketByKey.mockResolvedValue(BUCKET as never);
  db.createFileRecord.mockImplementation((async (input: Record<string, unknown>) => {
    const record = { _id: 'f1', ...input };
    hoisted.records.set('f1', record);
    return record;
  }) as never);
  db.findFileRecordById.mockImplementation((async (id: string) => hoisted.records.get(id)) as never);
  db.listFileRecordsByKeys.mockResolvedValue([] as never);
  db.findFileRecordByKey.mockImplementation((async () => hoisted.records.get('f1')) as never);
  db.updateFileRecord.mockImplementation((async (id: string, patch: Record<string, unknown>) => {
    const next = { ...hoisted.records.get(id), ...patch };
    hoisted.records.set(id, next);
    return next;
  }) as never);
});

const TEXT = '# report\n\nline 1\n';

describe('a markdown original', () => {
  it('keeps its own object: the text copy goes to a different key', async () => {
    const { record } = await uploadFile('tenant_x', 't1', 'p1', {
      bucketKey: 'docs', fileName: 'report.md', contentType: 'text/markdown', data: Buffer.from(TEXT), createdBy: 'u1', keyHint: 'out/report.md',
    });
    expect(hoisted.objects.get('docs/out/report.md')?.toString()).toBe(TEXT);
    expect(record.markdownKey).not.toBe(record.key);
    expect(hoisted.objects.get(`docs/${record.markdownKey}`)?.toString()).toBe(TEXT.trim());
  });
});

describe('convertToMarkdown: false', () => {
  it('stores the bytes as the only version, and records their size', async () => {
    const { record } = await uploadFile('tenant_x', 't1', 'p1', {
      bucketKey: 'docs', fileName: 'report.md', contentType: 'text/markdown', data: Buffer.from(TEXT), createdBy: 'u1', keyHint: 'out/report.md', convertToMarkdown: false,
    });
    expect([...hoisted.objects.keys()]).toEqual(['docs/out/report.md']);
    expect(hoisted.objects.get('docs/out/report.md')?.toString()).toBe(TEXT);
    expect(hoisted.convert).not.toHaveBeenCalled();
    expect(record).toMatchObject({ size: Buffer.byteLength(TEXT), markdownStatus: 'skipped' });
  });

  it('a rewrite keeps every byte (the trailing newline, an appended line) and the size is the new length', async () => {
    await uploadFile('tenant_x', 't1', 'p1', {
      bucketKey: 'docs', fileName: 'report.md', contentType: 'text/markdown', data: Buffer.from(TEXT), createdBy: 'u1', keyHint: 'out/report.md', convertToMarkdown: false,
    });
    const grown = Buffer.concat([hoisted.objects.get('docs/out/report.md')!, Buffer.from('line 2\n')]);
    const updated = await replaceFileContent('tenant_x', 't1', 'p1', 'docs', 'out/report.md', { data: grown, updatedBy: 'u1', convertToMarkdown: false });
    expect(hoisted.objects.get('docs/out/report.md')?.toString()).toBe('# report\n\nline 1\nline 2\n');
    expect([...hoisted.objects.keys()]).toEqual(['docs/out/report.md']);
    expect(hoisted.convert).not.toHaveBeenCalled();
    expect(updated.size).toBe(grown.length);
  });

  it('a rewrite without the option still converts (the default is unchanged)', async () => {
    await uploadFile('tenant_x', 't1', 'p1', {
      bucketKey: 'docs', fileName: 'notes.txt', contentType: 'text/plain', data: Buffer.from('a\n'), createdBy: 'u1', keyHint: 'out/notes.txt', convertToMarkdown: false,
    });
    await replaceFileContent('tenant_x', 't1', 'p1', 'docs', 'out/notes.txt', { data: Buffer.from('a\nb\n'), updatedBy: 'u1' });
    expect(hoisted.convert).toHaveBeenCalledTimes(1);
    expect(hoisted.objects.get('docs/out/notes.md')?.toString()).toBe('a\nb');
  });
});
