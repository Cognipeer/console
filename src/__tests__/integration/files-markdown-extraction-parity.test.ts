/**
 * The extraction settings and result of a file's Markdown copy (`IFileRecord.markdownExtraction`) on both database
 * providers (SQLite and MongoDB via mongodb-memory-server):
 *
 *  - a record created with settings keeps them, and a record created without has none;
 *  - a patch that carries the field replaces it, a patch that leaves it out keeps it, and `null` clears it;
 *  - what the field holds comes back whole (OCR settings, the picture policy and the result of the last run).
 */

import { beforeEach, expect, it } from 'vitest';
import type { IFileMarkdownExtraction, IFileRecord } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('A file record\'s extraction settings', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';

  beforeEach(async () => {
    const slug = `extraction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const put = (key: string, over: Partial<Omit<IFileRecord, '_id' | 'createdAt' | 'updatedAt'>> = {}) => getDb().createFileRecord({
    tenantId, projectId, providerKey: 'disk', bucketKey: 'docs', key, name: key, size: 1, contentType: 'application/pdf',
    markdownStatus: 'pending', createdBy: 'u1', ...over,
  });
  const reload = async (id: unknown) => (await getDb().findFileRecordById(String(id)))!;

  const settings: IFileMarkdownExtraction = {
    ocr: { mode: 'auto', modelKey: 'ocr-1', languages: ['tr', 'en'], maxPages: 20, images: true },
    images: 'placeholder',
  };
  const withResult: IFileMarkdownExtraction = {
    ...settings,
    result: { sourceType: 'mixed', engine: 'model', modelKey: 'ocr-1', pageCount: 5, ocrPages: 2, ocrImages: 1, warnings: ['ocr_failed: page 4'] },
  };

  it('keeps the settings a record is created with, whole', async () => {
    const created = await put('scan.pdf', { markdownExtraction: settings });

    expect((await reload(created._id)).markdownExtraction).toEqual(settings);
  });

  it('has none when it was created without', async () => {
    const created = await put('plain.pdf');

    expect((await reload(created._id)).markdownExtraction ?? null).toBeNull();
  });

  it('takes the result of a run through a patch, and keeps the field when a patch leaves it out', async () => {
    const created = await put('scan.pdf', { markdownExtraction: settings });

    await getDb().updateFileRecord(String(created._id), { markdownExtraction: withResult, markdownStatus: 'succeeded' });
    expect((await reload(created._id)).markdownExtraction).toEqual(withResult);

    await getDb().updateFileRecord(String(created._id), { markdownError: null });
    expect((await reload(created._id)).markdownExtraction).toEqual(withResult);
  });

  it('is cleared by null', async () => {
    const created = await put('scan.pdf', { markdownExtraction: withResult });

    await getDb().updateFileRecord(String(created._id), { markdownExtraction: null });

    expect((await reload(created._id)).markdownExtraction ?? null).toBeNull();
  });

  it('is replaced as a whole: the result of an earlier run does not outlive new settings', async () => {
    const created = await put('scan.pdf', { markdownExtraction: withResult });

    await getDb().updateFileRecord(String(created._id), { markdownExtraction: { ocr: { mode: 'always' } } });

    expect((await reload(created._id)).markdownExtraction).toEqual({ ocr: { mode: 'always' } });
  });
});
