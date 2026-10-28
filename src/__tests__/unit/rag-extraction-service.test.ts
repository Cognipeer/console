/**
 * Knowledge Engine: OCR settings per module, the conversion context of `convertFileToText`, deferred extraction in
 * the ingest job, and the rule that a re-index never runs OCR (only an explicit re-extract does).
 *
 * The extraction engine itself is replaced by a double: what is pinned here is what the Knowledge Engine asks of it
 * and what it keeps of the answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMockDb } from '../helpers/db.mock';

const hoisted = vi.hoisted(() => ({ extract: vi.fn() }));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@cognipeer/to-markdown', () => ({
  convertToMarkdown: vi.fn().mockResolvedValue('## Converted markdown content'),
}));
vi.mock('@/lib/services/extraction/engine', () => ({
  extractDocument: hoisted.extract,
  convertGuarded: vi.fn(),
  DocumentConversionRefused: class extends Error {},
  removePowerPointWorkingFiles: vi.fn(),
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleEmbeddingRequest: vi.fn().mockResolvedValue({
    response: { data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] },
  }),
}));
vi.mock('@/lib/services/vector/vectorService', () => ({
  upsertVectors: vi.fn().mockResolvedValue({ upserted: 1 }),
  queryVectorIndex: vi.fn().mockResolvedValue({ matches: [] }),
  deleteVectors: vi.fn().mockResolvedValue({ deleted: 1 }),
}));
vi.mock('@/lib/services/reranker', () => ({ runReranker: vi.fn() }));
vi.mock('@/lib/services/rag/ragIngestJob', () => ({
  publishRagIngestJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/services/files/fileService', () => ({
  uploadFile: vi.fn().mockResolvedValue({ record: { key: 'stored-object-key' } }),
  downloadFile: vi.fn().mockResolvedValue({
    data: Buffer.from('%PDF-1.4 original bytes'),
    fileName: 'scan.pdf',
    contentType: 'application/pdf',
  }),
  deleteFile: vi.fn().mockResolvedValue(true),
}));

import {
  convertFileToText,
  convertFileToTextDetailed,
  createRagModule,
  indexPendingRagDocument,
  ingestFile,
  reingestDocument,
  updateRagModule,
} from '@/lib/services/rag/ragService';
import { getDatabase } from '@/lib/database';
import { upsertVectors } from '@/lib/services/vector/vectorService';
import { publishRagIngestJob } from '@/lib/services/rag/ragIngestJob';
import { downloadFile, uploadFile } from '@/lib/services/files/fileService';
import type { ExtractionRequest, ExtractionResult } from '@/lib/services/extraction';

const DB_NAME = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';

const OCR = { mode: 'auto' as const, languages: ['tr', 'en'] };

const baseModule = {
  _id: 'ragmod-1',
  key: 'my-rag',
  name: 'My RAG',
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  status: 'active' as const,
  embeddingModelKey: 'text-embed-3',
  vectorProviderKey: 'pinecone',
  vectorIndexKey: 'my-index',
  chunkConfig: { strategy: 'recursive_character' as const, chunkSize: 512, chunkOverlap: 50 },
  totalDocuments: 0,
  totalChunks: 0,
  createdBy: 'user-1',
};
const ocrModule = { ...baseModule, extraction: { ocr: OCR } };
const ocrBucketModule = { ...ocrModule, fileBucketKey: 'kb-bucket', fileProviderKey: 'aws-s3' };

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const PDF = Buffer.from('%PDF-1.4 a scanned contract');

/** What the engine double answers: five pages, two of them read by OCR. */
function engineAnswer(text = 'Text of the scan'): ExtractionResult {
  return {
    raw: text,
    text,
    report: {
      sourceType: 'mixed',
      engine: 'local',
      pageCount: 5,
      ocrPages: [2, 4],
      warnings: ['ocr_timeout: page 5 within https://secret.example/x'],
    },
  };
}
function plainAnswer(text = 'Plain text'): ExtractionResult {
  return { raw: text, text, report: { sourceType: 'converted', warnings: [] } };
}
const lastRequest = () => hoisted.extract.mock.calls.at(-1)![0] as ExtractionRequest;

describe('Knowledge Engine OCR', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    hoisted.extract.mockImplementation(async () => engineAnswer());
    db.updateRagDocument.mockResolvedValue(null);
    db.updateRagModule.mockResolvedValue(null);
    db.deleteRagChunksByDocumentId.mockResolvedValue(0);
    db.bulkInsertRagChunks.mockResolvedValue(undefined);
  });

  describe('module settings', () => {
    it('creates a module with its extraction settings, and without the key when none is given', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      db.createRagModule.mockResolvedValue(ocrModule);
      const request = {
        name: 'My RAG', embeddingModelKey: 'e', vectorProviderKey: 'p', vectorIndexKey: 'i',
        chunkConfig: baseModule.chunkConfig, createdBy: 'user-1',
      };

      await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, extraction: { ocr: OCR } });
      expect(db.createRagModule).toHaveBeenLastCalledWith(expect.objectContaining({ extraction: { ocr: OCR } }));

      await createRagModule(DB_NAME, TENANT_ID, PROJECT_ID, request);
      expect(db.createRagModule.mock.lastCall![0]).not.toHaveProperty('extraction');
    });

    it('updates and clears the settings (null clears) without flagging a re-index', async () => {
      db.findRagModuleById.mockResolvedValue(ocrModule);

      await updateRagModule(DB_NAME, 'ragmod-1', { extraction: { ocr: { mode: 'always' } }, updatedBy: 'u' });
      expect(db.updateRagModule).toHaveBeenLastCalledWith('ragmod-1', expect.objectContaining({ extraction: { ocr: { mode: 'always' } } }));
      expect(db.updateRagModule.mock.lastCall![1]).not.toHaveProperty('reindexRequired');

      await updateRagModule(DB_NAME, 'ragmod-1', { extraction: null, updatedBy: 'u' });
      const patch = db.updateRagModule.mock.lastCall![1] as Record<string, unknown>;
      // Presence, not value: the key is there with `undefined` so both backends clear it.
      expect(Object.hasOwn(patch, 'extraction')).toBe(true);
      expect(patch.extraction).toBeUndefined();

      await updateRagModule(DB_NAME, 'ragmod-1', { name: 'Renamed', updatedBy: 'u' });
      expect(db.updateRagModule.mock.lastCall![1]).not.toHaveProperty('extraction');
    });
  });

  describe('convertFileToText', () => {
    it('keeps the three-argument form: no OCR, pictures as placeholders, plain text read as UTF-8', async () => {
      hoisted.extract.mockResolvedValue(plainAnswer('Converted'));

      expect(await convertFileToText('deck.pptx', Buffer.from('x'))).toBe('Converted');
      expect(lastRequest()).toMatchObject({ fileName: 'deck.pptx', images: 'placeholder', source: 'knowledge-engine' });
      expect(lastRequest()).not.toHaveProperty('ocr');

      hoisted.extract.mockClear();
      expect(await convertFileToText('notes.md', Buffer.from('# hi'))).toBe('# hi');
      expect(hoisted.extract).not.toHaveBeenCalled();
    });

    it('applies the OCR setting of the module named by key, in the scope given', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrModule);

      const result = await convertFileToTextDetailed('scan.pdf', PDF, 'application/pdf', {
        scope: { tenantDbName: DB_NAME, tenantId: TENANT_ID, projectId: PROJECT_ID },
        ragModuleKey: 'my-rag',
        source: 'connector',
      });

      expect(db.findRagModuleByKey).toHaveBeenCalledWith('my-rag', PROJECT_ID);
      expect(lastRequest()).toMatchObject({
        source: 'connector', contentType: 'application/pdf', ocr: OCR, images: 'placeholder',
        scope: { tenantDbName: DB_NAME, tenantId: TENANT_ID, projectId: PROJECT_ID },
      });
      expect(result.text).toBe('Text of the scan');
      expect(result.report.sourceType).toBe('mixed');
    });

    it('lets the caller switch OCR off, or name another setting, whatever the module says', async () => {
      const scope = { tenantDbName: DB_NAME, tenantId: TENANT_ID, projectId: PROJECT_ID };
      await convertFileToText('scan.pdf', PDF, 'application/pdf', { scope, ragModule: ocrModule as never, ocr: null });
      expect(lastRequest()).not.toHaveProperty('ocr');

      await convertFileToText('scan.pdf', PDF, 'application/pdf', { scope, ragModule: ocrModule as never, ocr: { mode: 'always' } });
      expect(lastRequest().ocr).toEqual({ mode: 'always' });
    });

    it('runs no OCR without a scope, and ignores a module whose OCR is off', async () => {
      await convertFileToText('scan.pdf', PDF, 'application/pdf', { ocr: OCR });
      expect(lastRequest()).not.toHaveProperty('ocr');

      await convertFileToText('scan.pdf', PDF, 'application/pdf', {
        scope: { tenantDbName: DB_NAME, tenantId: TENANT_ID },
        ragModule: { ...baseModule, extraction: { ocr: { mode: 'off' } } } as never,
      });
      expect(lastRequest()).not.toHaveProperty('ocr');
    });

    it('still reports a file that gave no text', async () => {
      hoisted.extract.mockResolvedValue(plainAnswer('   '));
      await expect(convertFileToText('blank.pdf', PDF)).rejects.toThrow(/Failed to convert "blank.pdf"/);
    });

    it('names the cause when a scan gave no text because its OCR could not finish', async () => {
      hoisted.extract.mockResolvedValue({
        raw: '', text: '', report: { sourceType: 'converted', warnings: ['ocr_timeout: The document was not read within 120 s'] },
      });
      await expect(convertFileToText('scan.pdf', PDF)).rejects.toThrow(
        'Failed to convert "scan.pdf" to text. OCR could not read it: it ran out of time.',
      );
    });
  });

  describe('ingestFile', () => {
    beforeEach(() => {
      db.createRagDocument.mockResolvedValue({
        _id: 'ragdoc-1', ragModuleKey: 'my-rag', tenantId: TENANT_ID, fileName: 'scan.pdf', status: 'processing', createdBy: 'user-1',
      });
    });

    const upload = (extra: Record<string, unknown> = {}) =>
      ingestFile(DB_NAME, TENANT_ID, PROJECT_ID, {
        ragModuleKey: 'my-rag', fileName: 'scan.pdf', fileData: PDF, contentType: 'application/pdf', createdBy: 'user-1', ...extra,
      });

    it('reads the file with the module OCR and records how, with the hash of the bytes', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrModule);

      await upload();

      expect(lastRequest()).toMatchObject({ budget: 'inline', ocr: OCR, images: 'placeholder', scope: { projectId: PROJECT_ID, userId: 'user-1' } });
      const row = db.createRagDocument.mock.lastCall![0];
      expect(row.extraction).toEqual({
        sourceType: 'mixed', engine: 'local', pageCount: 5, ocrPages: 2,
        fileHash: sha256(PDF), requested: OCR,
        // Only the code survives: what a provider said about the failure stays in the log.
        warnings: ['ocr_timeout'],
      });
      expect(row.extraction).not.toHaveProperty('stage');
      expect(row.sourceText).toBe('Text of the scan');
    });

    it('prefers the setting of the request, and null switches the module off for this file', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrModule);

      await upload({ extraction: { ocr: { mode: 'always' } } });
      expect(lastRequest().ocr).toEqual({ mode: 'always' });

      hoisted.extract.mockClear();
      await upload({ extraction: { ocr: null } });
      expect(lastRequest()).not.toHaveProperty('ocr');
      expect(db.createRagDocument.mock.lastCall![0]).not.toHaveProperty('extraction');
    });

    it('spends no OCR on a module that does not exist or is not active', async () => {
      db.findRagModuleByKey.mockResolvedValue(null);
      await expect(upload({ extraction: { ocr: { mode: 'always' } } })).rejects.toThrow('not found');
      expect(lastRequest()).not.toHaveProperty('ocr');

      hoisted.extract.mockClear();
      db.findRagModuleByKey.mockResolvedValue({ ...ocrModule, status: 'disabled' as const });
      await expect(upload()).rejects.toThrow('not active');
      expect(lastRequest()).not.toHaveProperty('ocr');
    });

    it('leaves a module without OCR exactly as it was: no extraction record', async () => {
      db.findRagModuleByKey.mockResolvedValue(baseModule);
      await upload();
      expect(lastRequest()).not.toHaveProperty('ocr');
      expect(db.createRagDocument.mock.lastCall![0]).not.toHaveProperty('extraction');
    });

    it('does not look the module up for a file OCR cannot apply to', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrModule);
      await ingestFile(DB_NAME, TENANT_ID, PROJECT_ID, {
        ragModuleKey: 'my-rag', fileName: 'sheet.xlsx', fileData: Buffer.from('x'), createdBy: 'user-1',
      });
      // ingestDocument looks the module up once; the plan added none.
      expect(db.findRagModuleByKey).toHaveBeenCalledTimes(1);
    });

    it('stores the upload and queues the extraction through ingestDocument when it may be deferred', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
      db.createRagDocument.mockResolvedValue({
        _id: 'ragdoc-1', ragModuleKey: 'my-rag', tenantId: TENANT_ID, fileName: 'scan.pdf', status: 'pending', createdBy: 'user-1',
      });

      const document = await upload({ deferExtraction: true, metadata: { team: 'legal' } });

      expect(hoisted.extract).not.toHaveBeenCalled();
      expect(db.createRagDocument).toHaveBeenCalledTimes(1);
      expect(db.createRagDocument).toHaveBeenCalledWith(expect.objectContaining({
        status: 'pending',
        size: 0,
        fileKey: 'stored-object-key',
        fileBucketKey: 'kb-bucket',
        metadata: { team: 'legal', _sourceType: 'converted' },
        extraction: { sourceType: 'ocr', stage: 'queued', fileHash: sha256(PDF), requested: OCR },
      }));
      expect(uploadFile).toHaveBeenCalledWith(DB_NAME, TENANT_ID, PROJECT_ID, expect.objectContaining({ bucketKey: 'kb-bucket', fileName: 'scan.pdf' }));
      expect(publishRagIngestJob).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'ragdoc-1', ragModuleKey: 'my-rag' }));
      expect(document.status).toBe('pending');
    });

    it('never skips an upload because its bytes were seen: no lookup by hash, no lookup at all for a queued row', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
      db.findRagDocumentByFileName.mockResolvedValue({
        _id: 'old', status: 'indexed', fileName: 'scan.pdf', sourceHash: createHash('sha256').update('').digest('hex'),
        extraction: { sourceType: 'ocr', fileHash: sha256(PDF) },
      } as never);
      db.createRagDocument.mockResolvedValue({ _id: 'ragdoc-2', status: 'pending', fileName: 'scan.pdf' } as never);

      await upload({ deferExtraction: true });

      expect(db.findRagDocumentByFileName).not.toHaveBeenCalled();
      expect(db.createRagDocument).toHaveBeenCalledTimes(1);
    });

    it('defers with deferIndexing too (the client API async flag), but only when the original can be kept', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
      db.createRagDocument.mockResolvedValue({ _id: 'ragdoc-1', status: 'pending', fileName: 'scan.pdf' } as never);
      await upload({ deferIndexing: true });
      expect(hoisted.extract).not.toHaveBeenCalled();
      expect(db.createRagDocument.mock.lastCall![0].extraction).toMatchObject({ stage: 'queued' });

      // No bucket: the pages are read in the request, then indexing is deferred as asked.
      db.createRagDocument.mockClear();
      db.findRagModuleByKey.mockResolvedValue(ocrModule);
      await upload({ deferExtraction: true });
      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(db.createRagDocument.mock.lastCall![0].extraction).not.toHaveProperty('stage');
    });

    it('extracts in the request when the original could not be stored, instead of queueing a row that cannot succeed', async () => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
      (uploadFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

      await upload({ deferExtraction: true });

      // The queued attempt wrote no row and queued no job; the request read the pages itself.
      expect(publishRagIngestJob).not.toHaveBeenCalled();
      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(db.createRagDocument).toHaveBeenCalledTimes(1);
      expect(db.createRagDocument.mock.lastCall![0].extraction).not.toHaveProperty('stage');
    });

    it('extracts in the request when OCR does not apply, even if deferral was asked', async () => {
      db.findRagModuleByKey.mockResolvedValue({ ...baseModule, fileBucketKey: 'kb-bucket' });
      hoisted.extract.mockResolvedValue(plainAnswer('Converted by the library'));
      await upload({ deferExtraction: true });
      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(db.createRagDocument.mock.lastCall![0].sourceText).toBe('Converted by the library');
    });
  });

  describe('indexPendingRagDocument with a queued extraction', () => {
    const QUEUED = {
      _id: 'ragdoc-1',
      ragModuleKey: 'my-rag',
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
      status: 'pending' as const,
      sourceText: '',
      fileKey: 'original-1.pdf',
      fileBucketKey: 'kb-bucket',
      folderId: 'folder-7',
      createdBy: 'user-1',
      extraction: { sourceType: 'ocr' as const, stage: 'queued' as const, fileHash: 'abc', requested: OCR },
    };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
      db.findRagDocumentById.mockResolvedValue(QUEUED);
      // The row exists: an update answers it, as both providers do (null means it is gone).
      db.updateRagDocument.mockImplementation(async (id: string, patch: object) => ({ ...QUEUED, _id: id, ...patch }));
    });

    it('extracts the stored original in the background, patches the existing row and indexes the text', async () => {
      await indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1');

      expect(downloadFile).toHaveBeenCalledWith(DB_NAME, TENANT_ID, PROJECT_ID, 'kb-bucket', 'original-1.pdf');
      expect(lastRequest()).toMatchObject({ budget: 'background', ocr: OCR, fileName: 'scan.pdf', source: 'knowledge-engine' });
      expect(lastRequest().data.toString()).toBe('%PDF-1.4 original bytes');

      const calls = db.updateRagDocument.mock.calls.map(([, patch]) => patch as Record<string, unknown>);
      expect(calls[0]).toEqual({ extraction: { ...QUEUED.extraction, stage: 'running' } });
      const patch = calls[1];
      expect(patch).toMatchObject({
        sourceText: 'Text of the scan',
        sourceHash: hashOf('Text of the scan'),
        size: Buffer.byteLength('Text of the scan'),
        extraction: { sourceType: 'mixed', engine: 'local', pageCount: 5, ocrPages: 2, fileHash: 'abc', requested: OCR, warnings: ['ocr_timeout'] },
      });
      expect((patch.extraction as Record<string, unknown>)).not.toHaveProperty('stage');
      expect((patch.extraction as Record<string, unknown>)).not.toHaveProperty('progress');
      // The row stays as ingestDocument made it: nothing recreated, nothing about folders or access written.
      expect(db.createRagDocument).not.toHaveBeenCalled();
      for (const call of calls) {
        expect(Object.keys(call)).not.toEqual(expect.arrayContaining(['folderId']));
        expect(call).not.toHaveProperty('acl');
      }
      expect(db.updateRagDocument).toHaveBeenCalledWith('ragdoc-1', expect.objectContaining({ status: 'processing' }));
      expect(upsertVectors).toHaveBeenCalled();
      expect(db.updateRagDocument).toHaveBeenLastCalledWith('ragdoc-1', expect.objectContaining({ status: 'indexed' }));
    });

    it('writes progress at most every few seconds, and never after the run', async () => {
      hoisted.extract.mockImplementation(async (req: ExtractionRequest) => {
        req.onProgress?.({ completed: 1, total: 5 });
        req.onProgress?.({ completed: 2, total: 5 });
        req.onProgress?.({ completed: 3, total: 5 });
        return engineAnswer();
      });

      await indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1');

      const extractions = db.updateRagDocument.mock.calls
        .map(([, patch]) => (patch as { extraction?: Record<string, unknown> }).extraction)
        .filter(Boolean) as Array<Record<string, unknown>>;
      const progressWrites = extractions.filter((e) => e.progress);
      expect(progressWrites).toEqual([{ ...QUEUED.extraction, stage: 'running', progress: { completed: 1, total: 5 } }]);
      // The last write is the settled record.
      expect(extractions.at(-1)).not.toHaveProperty('stage');
    });

    it('fails the document with the spec message when the original was not kept', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...QUEUED, fileKey: undefined });

      await indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1');

      expect(hoisted.extract).not.toHaveBeenCalled();
      expect(db.updateRagDocument).toHaveBeenCalledTimes(1);
      const [, patch] = db.updateRagDocument.mock.lastCall!;
      expect(patch).toMatchObject({ status: 'failed', errorMessage: 'The original file is no longer stored; upload it again.' });
      expect((patch as unknown as { extraction: Record<string, unknown> }).extraction).not.toHaveProperty('stage');
      expect(upsertVectors).not.toHaveBeenCalled();
    });

    it('fails the document, without a stage left behind, when the extraction throws', async () => {
      hoisted.extract.mockRejectedValue(new Error('converter exploded'));

      await expect(indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1')).rejects.toThrow('converter exploded');

      const [, patch] = db.updateRagDocument.mock.lastCall!;
      expect(patch).toMatchObject({ status: 'failed', errorMessage: 'converter exploded' });
      expect((patch as unknown as { extraction: Record<string, unknown> }).extraction).toEqual({ sourceType: 'ocr', fileHash: 'abc', requested: OCR });
    });

    it('fails a scan whose OCR could not run with the cause, and keeps the warning code on the row', async () => {
      hoisted.extract.mockResolvedValue({
        raw: '', text: '', report: { sourceType: 'converted', warnings: ['ocr_model_unavailable: The OCR model "x" was not found at https://secret.example'] },
      });

      await expect(indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1')).rejects.toThrow('the OCR model is not available');

      const [, patch] = db.updateRagDocument.mock.lastCall!;
      expect(patch).toMatchObject({ status: 'failed', errorMessage: expect.stringContaining('OCR could not read it') });
      expect((patch as unknown as { extraction: Record<string, unknown> }).extraction).toEqual({
        sourceType: 'ocr', fileHash: 'abc', requested: OCR, warnings: ['ocr_model_unavailable'],
      });
    });

    it('resumes an extraction a crash left running', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...QUEUED, extraction: { ...QUEUED.extraction, stage: 'running' } });
      await indexPendingRagDocument(DB_NAME, TENANT_ID, PROJECT_ID, 'my-rag', 'ragdoc-1');
      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(db.updateRagDocument).toHaveBeenLastCalledWith('ragdoc-1', expect.objectContaining({ status: 'indexed' }));
    });
  });

  describe('reingestDocument never reads pages with OCR unless asked to', () => {
    const request = { ragModuleKey: 'my-rag', documentId: 'ragdoc-1', updatedBy: 'user-1' };
    const stored = {
      _id: 'ragdoc-1', ragModuleKey: 'my-rag', tenantId: TENANT_ID, projectId: PROJECT_ID,
      fileName: 'scan.pdf', contentType: 'application/pdf', status: 'indexed' as const, chunkCount: 1,
      fileKey: 'original-1.pdf', fileBucketKey: 'kb-bucket', createdBy: 'user-1',
      sourceText: 'The text OCR produced earlier',
    };

    beforeEach(() => {
      db.findRagModuleByKey.mockResolvedValue(ocrBucketModule);
    });

    it('keeps the text of a document that was OCR\'d, without touching its original or the engine', async () => {
      for (const sourceType of ['ocr', 'mixed'] as const) {
        db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType, fileHash: 'abc' } });
        await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, request);
      }
      expect(hoisted.extract).not.toHaveBeenCalled();
      expect(db.updateRagDocument.mock.calls.some(([, patch]) => 'extraction' in (patch as object))).toBe(false);
    });

    it('never falls back to the original without OCR when the kept text cannot be read', async () => {
      // A text in the bucket that cannot be downloaded (and a failed deferred row, which has no text at all).
      (downloadFile as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
        data: Buffer.from('%PDF-1.4 original bytes'), fileName: 'scan.pdf', contentType: 'application/pdf',
      })).mockRejectedValueOnce(new Error('bucket unavailable'));
      db.findRagDocumentById.mockResolvedValue({
        ...stored, sourceText: undefined, sourceTextKey: 'text-1.md', extraction: { sourceType: 'mixed' },
      });

      await expect(reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, request))
        .rejects.toThrow('could not be read');
      expect(hoisted.extract).not.toHaveBeenCalled();
      expect(db.deleteRagChunksByDocumentId).not.toHaveBeenCalled();
    });

    it('returns the new extraction record with the document', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType: 'converted' } });

      const document = await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, reextract: true });

      expect(document.extraction).toMatchObject({ sourceType: 'mixed', pageCount: 5 });
    });

    it('keeps the previous text when a re-extract could not finish its OCR, and gives it the budget of a job', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType: 'ocr' } });
      hoisted.extract.mockResolvedValue({
        raw: 'Worse', text: 'Worse native text', report: { sourceType: 'converted', warnings: ['ocr_budget_exceeded: daily cap'] },
      });

      await expect(reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, reextract: true }))
        .rejects.toMatchObject({ name: 'RagReextractIncompleteError', statusCode: 409 });

      expect(lastRequest()).toMatchObject({ budget: 'background' });
      expect(db.updateRagDocument).not.toHaveBeenCalledWith('ragdoc-1', expect.objectContaining({ sourceText: 'Worse native text' }));
      expect(db.deleteRagChunksByDocumentId).not.toHaveBeenCalled();
    });

    it('re-converts the original of any other document with OCR off', async () => {
      hoisted.extract.mockResolvedValue(plainAnswer('Native text'));
      db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType: 'converted' } });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, request);

      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(lastRequest()).not.toHaveProperty('ocr');
    });

    it('re-extracts the stored original with the module\'s current OCR settings when asked, and records it', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType: 'converted', fileHash: 'old' } });

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, reextract: true });

      expect(lastRequest()).toMatchObject({ ocr: OCR, budget: 'background', images: 'placeholder' });
      expect(db.updateRagDocument).toHaveBeenCalledWith('ragdoc-1', {
        extraction: expect.objectContaining({ sourceType: 'mixed', pageCount: 5, ocrPages: 2, requested: OCR }),
      });
      expect(db.updateRagDocument).toHaveBeenCalledWith('ragdoc-1', expect.objectContaining({ status: 'indexed' }));
    });

    it('re-extracts a document that was OCR\'d before, replacing its stored text', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...stored, extraction: { sourceType: 'ocr' } });
      hoisted.extract.mockResolvedValue(engineAnswer('A better reading'));

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, reextract: true });

      expect(hoisted.extract).toHaveBeenCalledTimes(1);
      expect(db.updateRagDocument).toHaveBeenCalledWith('ragdoc-1', expect.objectContaining({ sourceText: 'A better reading' }));
    });

    it('refuses to re-extract a document whose original was not kept', async () => {
      db.findRagDocumentById.mockResolvedValue({ ...stored, fileKey: undefined, extraction: { sourceType: 'ocr' } });

      await expect(reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, reextract: true }))
        .rejects.toThrow('The original file is no longer stored; upload it again.');
      expect(hoisted.extract).not.toHaveBeenCalled();
    });

    it('reads a newly uploaded file with the module\'s OCR, as any upload', async () => {
      db.findRagDocumentById.mockResolvedValue(stored);

      await reingestDocument(DB_NAME, TENANT_ID, PROJECT_ID, { ...request, fileData: PDF, contentType: 'application/pdf' });

      expect(lastRequest()).toMatchObject({ ocr: OCR });
      expect(db.updateRagDocument).toHaveBeenCalledWith('ragdoc-1', {
        extraction: expect.objectContaining({ fileHash: sha256(PDF), requested: OCR }),
      });
    });
  });
});

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
