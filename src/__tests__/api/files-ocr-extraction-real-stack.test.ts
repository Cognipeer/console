/**
 * OCR-aware Markdown conversion in the Document Store, through the REAL plugin over a real SQLite database, the real
 * local-disk driver and the real (in-memory) queue. The extraction engine is replaced by a double that records what
 * it is asked and answers like a scanned document (no OCR model or Tesseract is run):
 *
 *  - the `ocr` / `images` of an upload are checked (400 with a sentence) and kept on the file's record;
 *  - the background job reads them from the record, reports `source: 'files'` / `budget: 'background'`, and stores the
 *    result of the run back;
 *  - the Convert action replaces the settings when the body names them, keeps them when it does not, and an image is
 *    convertible only while OCR is on;
 *  - an upload without settings is converted exactly as before (no `ocr`, no `images`, nothing on the record).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  extract: vi.fn(),
  validateModel: vi.fn(),
}));

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
vi.mock('@/lib/services/extraction/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/extraction/engine')>();
  return { ...actual, extractDocument: hoisted.extract };
});
vi.mock('@/lib/services/extraction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/extraction')>();
  return { ...actual, validateOcrModelRef: hoisted.validateModel };
});

import { uploadFile } from '@/lib/services/files/fileService';
import { startFilesQueueConsumer } from '@/lib/services/files/jobs/filesConsumer';
import type { ExtractionRequest, ExtractionResult } from '@/lib/services/extraction/types';
import { createFilesStack, FILES_DB_NAME, type FilesStack } from '../helpers/filesRealStack';

let stack: FilesStack;

/** Answers like a scanned PDF of five pages, two of them read by OCR; plain files come back as they are. */
function fakeExtract(req: ExtractionRequest): ExtractionResult {
  const text = `extracted:${req.data.toString()}`;
  const ocrOn = Boolean(req.ocr && req.ocr.mode !== 'off');
  return {
    raw: text,
    text,
    report: ocrOn
      ? {
          sourceType: 'mixed', engine: req.ocr?.modelKey ? 'model' : 'local', ...(req.ocr?.modelKey ? { modelKey: req.ocr.modelKey } : {}),
          pageCount: 5, ocrPages: [2, 4], warnings: ['ocr_timeout: page 5'],
        }
      : { sourceType: 'converted', warnings: [] },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  hoisted.extract.mockImplementation(async (req: ExtractionRequest) => fakeExtract(req));
  hoisted.validateModel.mockResolvedValue(undefined);
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
const convert = (body: unknown) => stack.request('POST', '/files/buckets/work/convert', body);
const settled = (key: string) => vi.waitFor(async () => {
  const record = await stack.record('work', key);
  expect(record, `record of ${key}`).not.toBeNull();
  expect(record!.markdownStatus).not.toBe('pending');
  return record!;
}, { timeout: 15_000 });
const lastRequest = () => hoisted.extract.mock.calls.at(-1)![0] as ExtractionRequest;

describe('an upload with OCR settings through the dashboard route', () => {
  it('keeps the settings on the record, and the job reads them, runs as a background job and stores the result', async () => {
    const res = await upload('scan.pdf', 'pdf-bytes', { ocr: { mode: 'auto', languages: ['TUR', 'en'], maxPages: 30 } });

    expect(res.statusCode).toBe(201);
    const { record } = stack.json(res);
    expect(record).toMatchObject({ markdownStatus: 'pending', markdownExtraction: { ocr: { mode: 'auto', languages: ['tr', 'en'], maxPages: 30 } } });
    expect(record.markdownExtraction.result).toBeUndefined();

    await startFilesQueueConsumer();
    const done = await settled(record.key);

    expect(done.markdownStatus).toBe('succeeded');
    expect(readFileSync(stack.objectPath('work', done.markdownKey!), 'utf8')).toBe('extracted:pdf-bytes');
    const request = lastRequest();
    expect(request).toMatchObject({
      source: 'files', fileName: 'scan.pdf', budget: 'background',
      scope: { tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId, userId: stack.userId },
      ocr: { mode: 'auto', languages: ['tr', 'en'], maxPages: 30 },
    });
    expect(request.images).toBeUndefined();
    expect(typeof request.onProgress).toBe('function');
    expect(done.markdownExtraction).toEqual({
      ocr: { mode: 'auto', languages: ['tr', 'en'], maxPages: 30 },
      result: { sourceType: 'mixed', engine: 'local', pageCount: 5, ocrPages: 2, warnings: ['ocr_timeout: page 5'] },
    });
  });

  it('reports the model that read the document, and checks the model before it accepts the upload', async () => {
    const res = await upload('scan.pdf', 'pdf-bytes', { ocr: { mode: 'always', modelKey: 'mistral-ocr' }, images: 'placeholder' });

    expect(res.statusCode).toBe(201);
    expect(hoisted.validateModel).toHaveBeenCalledWith(
      { tenantDbName: FILES_DB_NAME, tenantId: stack.tenantId, projectId: stack.projectId },
      'mistral-ocr',
    );
    await startFilesQueueConsumer();
    const done = await settled(stack.json(res).record.key);

    expect(lastRequest()).toMatchObject({ ocr: { mode: 'always', modelKey: 'mistral-ocr' }, images: 'placeholder' });
    expect(done.markdownExtraction).toMatchObject({
      images: 'placeholder',
      result: { sourceType: 'mixed', engine: 'model', modelKey: 'mistral-ocr' },
    });
  });

  it('queues an image for conversion only because OCR is on', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const withOcr = await upload('scan.png', png, { contentType: 'image/png', ocr: { mode: 'always' } });
    const without = await upload('plain.png', png, { contentType: 'image/png' });
    const off = await upload('off.png', png, { contentType: 'image/png', ocr: { mode: 'off' } });

    expect(stack.json(withOcr).record.markdownStatus).toBe('pending');
    expect(stack.json(without).record.markdownStatus).toBe('skipped');
    expect(stack.json(off).record.markdownStatus).toBe('skipped');
  });

  it('stores nothing for OCR that is off, and for the default picture policy', async () => {
    const res = await upload('notes.txt', 'plain', { ocr: { mode: 'off', modelKey: 'ignored' }, images: 'inline' });

    expect(res.statusCode).toBe(201);
    const { record } = stack.json(res);
    expect(record.markdownExtraction).toBeUndefined();
    expect(hoisted.validateModel).not.toHaveBeenCalled();
    await startFilesQueueConsumer();
    const done = await settled(record.key);
    expect(done.markdownExtraction ?? null).toBeNull();
    const request = lastRequest();
    expect('ocr' in request).toBe(false);
    expect('images' in request).toBe(false);
  });

  it('converts a file without settings as it always was: no ocr, no images, no progress callback', async () => {
    await startFilesQueueConsumer();
    const { record } = stack.json(await upload('notes.txt', 'plain words'));
    const done = await settled(record.key);

    expect(done.markdownStatus).toBe('succeeded');
    const request = lastRequest();
    expect(request).toMatchObject({ source: 'files', budget: 'background' });
    expect('ocr' in request).toBe(false);
    expect('images' in request).toBe(false);
    expect(request.onProgress).toBeUndefined();
    expect(done.markdownExtraction ?? null).toBeNull();
  });

  it('forgets the settings of the old bytes when an upload to the same key brings new ones', async () => {
    const first = await upload('scan.pdf', 'one', { keyHint: 'scan.pdf', ocr: { mode: 'always' } });
    expect(stack.json(first).record.markdownExtraction).toEqual({ ocr: { mode: 'always' } });

    const second = await upload('scan.pdf', 'two', { keyHint: 'scan.pdf' });

    expect(second.statusCode).toBe(201);
    expect(stack.json(second).record.id).toBe(stack.json(first).record.id);
    expect(stack.json(second).record.markdownExtraction).toBeUndefined();
    expect((await stack.record('work', 'scan.pdf'))!.markdownExtraction ?? null).toBeNull();
  });
});

describe('an upload with settings that are refused', () => {
  it.each([
    ['ocr that is not an object', { ocr: 'yes' }, 'ocr must be an object'],
    ['an unknown mode', { ocr: { mode: 'sometimes' } }, "ocr.mode must be one of 'off', 'auto', 'always'"],
    ['an unknown key', { ocr: { mode: 'auto', engine: 'x' } }, 'ocr.engine is not a known setting'],
    ['a language that is no code', { ocr: { mode: 'auto', languages: ['turkish!'] } }, 'invalid language code'],
    ['pages beyond the limit', { ocr: { mode: 'auto', maxPages: 100000 } }, 'ocr.maxPages must be an integer between 1 and'],
    ['a picture policy that does not exist', { images: 'huge' }, "images must be one of 'inline', 'placeholder', 'omit'"],
  ])('answers 400 for %s, and stores nothing', async (_label, body, message) => {
    const res = await upload('scan.pdf', 'pdf-bytes', body);

    expect(res.statusCode).toBe(400);
    expect(stack.json(res).error).toContain(message);
    expect(await stack.records('work')).toHaveLength(0);
  });

  it('answers 400 with the reason when the OCR model cannot be used', async () => {
    hoisted.validateModel.mockResolvedValue('The OCR model "gone" was not found in this project.');

    const res = await upload('scan.pdf', 'pdf-bytes', { ocr: { mode: 'auto', modelKey: 'gone' } });

    expect(res.statusCode).toBe(400);
    expect(stack.json(res).error).toBe('The OCR model "gone" was not found in this project.');
    expect(await stack.records('work')).toHaveLength(0);
  });
});

describe('POST /files/buckets/:bucketKey/convert with OCR settings', () => {
  it('replaces the settings of the file, drops the result of the last run and uses the new settings in the job', async () => {
    await stack.putFile('work', 'scan.pdf', 'pdf-bytes', {
      contentType: 'application/pdf', markdownStatus: 'succeeded', markdownKey: 'scan.md', markdownSize: 3, markdownContentType: 'text/markdown',
      markdownExtraction: { ocr: { mode: 'auto' }, result: { sourceType: 'converted' } },
    });
    stack.putObject('work', 'scan.md', 'old copy');

    const res = await convert({ key: 'scan.pdf', ocr: { mode: 'always', languages: ['en'] }, images: 'omit' });

    expect(res.statusCode).toBe(202);
    expect(stack.json(res).record).toMatchObject({ markdownStatus: 'pending', markdownExtraction: { ocr: { mode: 'always', languages: ['en'] }, images: 'omit' } });
    expect((await stack.record('work', 'scan.pdf'))!.markdownExtraction).toEqual({ ocr: { mode: 'always', languages: ['en'] }, images: 'omit' });

    await startFilesQueueConsumer();
    const done = await settled('scan.pdf');

    expect(lastRequest()).toMatchObject({ ocr: { mode: 'always', languages: ['en'] }, images: 'omit' });
    expect(done.markdownExtraction?.result).toMatchObject({ sourceType: 'mixed', engine: 'local' });
  });

  it('keeps the settings of the file when the body names none, and drops the result of the last run', async () => {
    await stack.putFile('work', 'scan.pdf', 'pdf-bytes', {
      contentType: 'application/pdf', markdownStatus: 'failed',
      markdownExtraction: { ocr: { mode: 'auto', modelKey: 'm1' }, result: { sourceType: 'converted', warnings: ['ocr_failed: x'] } },
    });

    const res = await convert({ key: 'scan.pdf' });

    expect(res.statusCode).toBe(202);
    expect(stack.json(res).record.markdownExtraction).toEqual({ ocr: { mode: 'auto', modelKey: 'm1' } });
    await startFilesQueueConsumer();
    await settled('scan.pdf');
    expect(lastRequest()).toMatchObject({ ocr: { mode: 'auto', modelKey: 'm1' } });
  });

  it('clears the settings when the body says ocr: null, and converts the file plainly', async () => {
    await stack.putFile('work', 'scan.pdf', 'pdf-bytes', {
      contentType: 'application/pdf', markdownStatus: 'succeeded', markdownExtraction: { ocr: { mode: 'always' } },
    });

    const res = await convert({ key: 'scan.pdf', ocr: null });

    expect(res.statusCode).toBe(202);
    expect(stack.json(res).record.markdownExtraction).toBeUndefined();
    await startFilesQueueConsumer();
    const done = await settled('scan.pdf');
    expect('ocr' in lastRequest()).toBe(false);
    expect(done.markdownExtraction ?? null).toBeNull();
  });

  it('converts an image only with OCR: 415 without, 202 with', async () => {
    await stack.putFile('work', 'photo.png', 'png-bytes', { contentType: 'image/png' });

    const refused = await convert({ key: 'photo.png' });
    expect(refused.statusCode).toBe(415);
    expect(stack.json(refused).code ?? stack.json(refused).error).toBeTruthy();
    expect((await stack.record('work', 'photo.png'))!.markdownStatus).toBe('skipped');

    const accepted = await convert({ key: 'photo.png', ocr: { mode: 'always' } });
    expect(accepted.statusCode).toBe(202);
    await startFilesQueueConsumer();
    const done = await settled('photo.png');
    expect(done.markdownStatus).toBe('succeeded');
    expect(lastRequest()).toMatchObject({ fileName: 'photo.png', ocr: { mode: 'always' } });
  });

  it('answers 400 for settings that are refused, and leaves the record as it is', async () => {
    await stack.putFile('work', 'scan.pdf', 'pdf-bytes', { contentType: 'application/pdf', markdownStatus: 'succeeded' });

    const res = await convert({ key: 'scan.pdf', ocr: { mode: 'bogus' } });

    expect(res.statusCode).toBe(400);
    expect(stack.json(res).error).toContain('ocr.mode');
    expect((await stack.record('work', 'scan.pdf'))!.markdownStatus).toBe('succeeded');
  });

  it('fails the job when a conversion that still carries OCR settings cannot run the model: the file says why', async () => {
    hoisted.extract.mockRejectedValue(new Error('Aborted'));
    const { record } = stack.json(await upload('scan.pdf', 'pdf-bytes', { ocr: { mode: 'auto' } }));

    await startFilesQueueConsumer();
    const done = await settled(record.key);

    expect(done.markdownStatus).toBe('failed');
    expect(done.markdownError).toBeTruthy();
    // The settings stay, so converting again uses them.
    expect(done.markdownExtraction).toEqual({ ocr: { mode: 'auto' } });
  });
});

describe('the service called directly (the client API, agents): the conversion waits', () => {
  it('runs inline with the settings of the request and stores the result', async () => {
    const { record } = await uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'scan.pdf', data: Buffer.from('pdf-bytes'), createdBy: stack.userId,
      convertToMarkdown: true, extraction: { ocr: { mode: 'auto', modelKey: 'vlm-1' } },
    });

    expect(record.markdownStatus).toBe('succeeded');
    expect(lastRequest()).toMatchObject({ source: 'files', budget: 'inline', ocr: { mode: 'auto', modelKey: 'vlm-1' } });
    expect(record.markdownExtraction).toMatchObject({
      ocr: { mode: 'auto', modelKey: 'vlm-1' },
      result: { sourceType: 'mixed', engine: 'model', modelKey: 'vlm-1', pageCount: 5, ocrPages: 2 },
    });
    expect((await stack.record('work', record.key))!.markdownExtraction).toEqual(record.markdownExtraction);
  });

  it('is plain without settings', async () => {
    const { record } = await uploadFile(FILES_DB_NAME, stack.tenantId, stack.projectId, {
      bucketKey: 'work', fileName: 'notes.txt', data: Buffer.from('words'), createdBy: stack.userId, convertToMarkdown: true,
    });

    expect(record.markdownStatus).toBe('succeeded');
    const request = lastRequest();
    expect(request).toMatchObject({ budget: 'inline', source: 'files' });
    expect('ocr' in request).toBe(false);
    expect(record.markdownExtraction).toBeUndefined();
  });
});
