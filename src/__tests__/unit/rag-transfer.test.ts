import { describe, it, expect, vi, beforeEach } from 'vitest';

const ragService = vi.hoisted(() => ({
  getRagModule: vi.fn(),
  listRagDocuments: vi.fn(),
  getRagDocument: vi.fn(),
  ingestDocument: vi.fn(),
}));
const ragSource = vi.hoisted(() => ({ loadSourceText: vi.fn() }));

vi.mock('@/lib/services/rag/ragService', () => ragService);
vi.mock('@/lib/services/rag/ragSource', () => ragSource);

import {
  exportRagModule,
  importRagModuleJsonl,
  RAG_IMPORT_MAX_DOCUMENTS,
} from '@/lib/services/rag/ragTransfer';

const activeModule = { key: 'faq', name: 'FAQ', description: 'Support answers', status: 'active' };

describe('exportRagModule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ragService.getRagModule.mockResolvedValue(activeModule);
  });

  it('writes a header line then one JSON line per document with multi-line content intact', async () => {
    const listed = [
      { fileName: 'a.md', contentType: 'text/markdown', metadata: { lang: 'tr' }, _id: '1' },
      { fileName: 'b.txt', _id: '2' },
    ];
    ragService.listRagDocuments.mockResolvedValue(listed);
    // Listed rows come without their inline text, so the export reads each full row.
    ragService.getRagDocument.mockImplementation(async (_tenant: string, id: string) => ({
      ...listed.find((row) => row._id === id),
      sourceText: `full text of ${id}`,
    }));
    ragSource.loadSourceText
      .mockResolvedValueOnce('line one\nline "two"')
      .mockResolvedValueOnce(undefined);

    const result = await exportRagModule('tenant', 'tid', 'proj', 'faq');

    expect(ragService.getRagDocument.mock.calls).toEqual([['tenant', '1'], ['tenant', '2']]);
    expect(ragSource.loadSourceText).toHaveBeenNthCalledWith(
      1,
      'tenant',
      'tid',
      'proj',
      expect.objectContaining({ _id: '1', sourceText: 'full text of 1' }),
    );
    expect(result).toBeDefined();
    expect(result!.documentCount).toBe(1);
    expect(result!.skippedDocuments).toBe(1);
    expect(result!.fileName).toBe('faq.rag.jsonl');

    const lines = result!.body.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    const header = JSON.parse(lines[0]);
    expect(header).toMatchObject({ format: 'cognipeer.rag-module', version: 1, documentCount: 1, skippedDocuments: 1 });
    expect(header.module).toMatchObject({ key: 'faq', name: 'FAQ' });

    const doc = JSON.parse(lines[1]);
    expect(doc).toMatchObject({
      type: 'document',
      fileName: 'a.md',
      contentType: 'text/markdown',
      metadata: { lang: 'tr' },
      content: 'line one\nline "two"',
    });
  });

  it('returns undefined when the module does not exist', async () => {
    ragService.getRagModule.mockResolvedValue(null);
    expect(await exportRagModule('tenant', 'tid', undefined, 'missing')).toBeUndefined();
  });
});

describe('importRagModuleJsonl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ragService.getRagModule.mockResolvedValue(activeModule);
    ragService.ingestDocument.mockResolvedValue({ _id: 'new' });
  });

  it('round-trips an export: header is skipped and each document is ingested deferred', async () => {
    const data = [
      JSON.stringify({ format: 'cognipeer.rag-module', version: 1, documentCount: 1 }),
      JSON.stringify({ type: 'document', fileName: 'a.md', content: 'hello\nworld', metadata: { k: 1 } }),
    ].join('\n');

    const result = await importRagModuleJsonl('tenant', 'tid', 'proj', 'faq', 'user-1', data);

    expect(result).toEqual({ total: 1, imported: 1, failed: 0, errors: [] });
    expect(ragService.ingestDocument).toHaveBeenCalledWith(
      'tenant',
      'tid',
      'proj',
      expect.objectContaining({
        ragModuleKey: 'faq',
        fileName: 'a.md',
        content: 'hello\nworld',
        metadata: { k: 1 },
        deferIndexing: true,
        createdBy: 'user-1',
      }),
    );
  });

  it('accepts a plain JSONL without a header and reports bad lines by number', async () => {
    const data = [
      JSON.stringify({ fileName: 'ok.txt', content: 'fine' }),
      '{not json',
      JSON.stringify({ fileName: 'no-content.txt' }),
      '',
    ].join('\n');

    const result = await importRagModuleJsonl('tenant', 'tid', undefined, 'faq', 'user-1', data);

    expect(result.total).toBe(3);
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('rejects an unsupported export version before ingesting anything', async () => {
    const data = JSON.stringify({ format: 'cognipeer.rag-module', version: 99 });
    await expect(importRagModuleJsonl('tenant', 'tid', undefined, 'faq', 'u', data)).rejects.toThrow(
      'Unsupported export version',
    );
    expect(ragService.ingestDocument).not.toHaveBeenCalled();
  });

  it('rejects imports above the document cap', async () => {
    const data = Array.from({ length: RAG_IMPORT_MAX_DOCUMENTS + 1 }, (_, i) =>
      JSON.stringify({ fileName: `f${i}.txt`, content: 'x' }),
    ).join('\n');
    await expect(importRagModuleJsonl('tenant', 'tid', undefined, 'faq', 'u', data)).rejects.toThrow('at most');
  });

  it('refuses a module that is not active', async () => {
    ragService.getRagModule.mockResolvedValue({ ...activeModule, status: 'disabled' });
    await expect(
      importRagModuleJsonl('tenant', 'tid', undefined, 'faq', 'u', JSON.stringify({ fileName: 'a', content: 'b' })),
    ).rejects.toThrow('not active');
  });
});
