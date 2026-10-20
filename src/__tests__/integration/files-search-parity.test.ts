/**
 * The search box of a bucket's file table (`listFileRecords({ search })`) - the contract both database providers
 * must keep (SQLite and MongoDB via mongodb-memory-server):
 *
 *  - what is typed is looked for as typed: `%`, `_` and `\` are characters of a name, never wildcards;
 *  - case does not matter for non-ASCII letters either ("ŞÖYLE" finds "şöyle.txt"), and the four letters of the
 *    Turkish i family (I, İ, i, ı) meet at "i", like the directory searches;
 *  - the name of the file is what is searched, never the key made from it or the folders above it, so a word of a
 *    folder path finds nothing and a search inside a folder is not answered by the folder's own name.
 *
 * The providers are written independently (SQLite `LIKE` folds ASCII only and treats nothing as an escape unless
 * told so); the same assertions run on both.
 */

import { beforeEach, expect, it } from 'vitest';
import type { IFileRecord } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('File search', (getDb) => {
  let tenantId: string;
  const projectId = 'proj-1';
  const providerKey = 'disk';
  const bucketKey = 'docs';

  beforeEach(async () => {
    const slug = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  const search = async (text: string, extra: { prefix?: string; limit?: number } = {}) => (
    await getDb().listFileRecords({ providerKey, bucketKey, projectId, search: text, ...extra })
  ).items.map((record) => record.key).sort();

  const seed = async () => {
    for (const key of [
      'a/ascii-report.txt',
      'türkçe/şöyle.txt',
      'ÇAĞRI_notu.txt',
      'İstanbul.txt',
      'ISPARTA.txt',
      'ılık.txt',
      'my_report_final.txt',
      'my.report.final.txt',
      '100%_done.txt',
      '1000_done.txt',
      'notes.txt',
    ]) await put(key);
    // A name with a backslash cannot come from an upload, but a record can hold one (an imported object).
    await put('imported/a\\b.txt', { name: 'a\\b.txt' });
    await put('imported/ab.txt');
    // Other buckets, providers and projects never answer.
    await put('elsewhere/ascii-report.txt', { bucketKey: 'other' });
    await put('elsewhere/ascii-report-2.txt', { providerKey: 'other-disk' });
    await put('elsewhere/ascii-report-3.txt', { projectId: 'proj-2' });
  };

  it('ignores the case of ASCII letters', async () => {
    await seed();
    expect(await search('ASCII-REPORT')).toEqual(['a/ascii-report.txt']);
    expect(await search('Ascii-Rep')).toEqual(['a/ascii-report.txt']);
  });

  it('ignores the case of non-ASCII letters, in both directions', async () => {
    await seed();
    expect(await search('ŞÖYLE')).toEqual(['türkçe/şöyle.txt']);
    expect(await search('şöyle')).toEqual(['türkçe/şöyle.txt']);
    expect(await search('çağrı')).toEqual(['ÇAĞRI_notu.txt']);
    expect(await search('ÇAĞRI')).toEqual(['ÇAĞRI_notu.txt']);
  });

  it('pairs the four letters of the Turkish i family', async () => {
    await seed();
    expect(await search('istanbul')).toEqual(['İstanbul.txt']);
    expect(await search('ISTANBUL')).toEqual(['İstanbul.txt']);
    expect(await search('ısparta')).toEqual(['ISPARTA.txt']);
    expect(await search('Isparta')).toEqual(['ISPARTA.txt']);
    expect(await search('ILIK')).toEqual(['ılık.txt']);
  });

  it('looks for an underscore as an underscore, not as any one character', async () => {
    await seed();
    expect(await search('report_final')).toEqual(['my_report_final.txt']);
    expect(await search('y_r')).toEqual(['my_report_final.txt']);
    expect(await search('_')).toEqual(['100%_done.txt', '1000_done.txt', 'my_report_final.txt', 'ÇAĞRI_notu.txt']);
  });

  it('looks for a percent sign as a percent sign, not as any run of characters', async () => {
    await seed();
    expect(await search('100%')).toEqual(['100%_done.txt']);
    expect(await search('%')).toEqual(['100%_done.txt']);
    expect(await search('%_done')).toEqual(['100%_done.txt']);
  });

  it('looks for a backslash as a backslash', async () => {
    await seed();
    expect(await search('a\\b')).toEqual(['imported/a\\b.txt']);
    expect(await search('\\')).toEqual(['imported/a\\b.txt']);
  });

  it('keeps a dot, a bracket or a star in the words typed from acting as a pattern', async () => {
    await seed();
    expect(await search('my.report')).toEqual(['my.report.final.txt']);
    expect(await search('.*')).toEqual([]);
    expect(await search('[a-z]')).toEqual([]);
    expect(await search('(')).toEqual([]);
  });

  it('does not count the blanks around the words', async () => {
    await seed();
    expect(await search('  notes  ')).toEqual(['notes.txt']);
  });

  it('answers nothing for words no name holds, and composes with a folder prefix', async () => {
    await seed();
    expect(await search('zzz-not-there')).toEqual([]);
    expect(await search('ascii', { prefix: 'a/' })).toEqual(['a/ascii-report.txt']);
    expect(await search('ascii', { prefix: 'türkçe/' })).toEqual([]);
  });

  it('looks at the name only: a word of a folder path or of a generated key finds nothing', async () => {
    await put('invoices/2025/report.pdf', { name: 'report.pdf' });
    await put('notes/invoices.txt');
    await put('misc/quarterly-1792466088612-444243be.txt', { name: 'Quarterly.txt' });
    expect(await search('invoices')).toEqual(['notes/invoices.txt']);
    // Inside a folder, the folder's own name does not match every file below it.
    expect(await search('invoices', { prefix: 'invoices/' })).toEqual([]);
    expect(await search('report', { prefix: 'invoices/' })).toEqual(['invoices/2025/report.pdf']);
    // The file as it was named is searched, not the key made from that name.
    expect(await search('444243be')).toEqual([]);
    expect(await search('quarterly')).toEqual(['misc/quarterly-1792466088612-444243be.txt']);
  });

  it('finds a name stored decomposed with the composed word, and a composed name with the decomposed word', async () => {
    // An imported object can carry a name from a system that stores letters as base + combining mark.
    const decomposed = 'su\u0308rec\u0327.txt'; // "sürec" with u + U+0308 and c + U+0327
    const composed = 'ba\u011fl\u0131.txt'; // "bağlı", composed
    await put('imported/decomposed.txt', { name: decomposed });
    await put('imported/composed.txt', { name: composed });
    expect(await search('s\u00fcre\u00e7')).toEqual(['imported/decomposed.txt']);
    expect(await search('su\u0308rec\u0327')).toEqual(['imported/decomposed.txt']);
    expect(await search('ba\u011fl\u0131')).toEqual(['imported/composed.txt']);
    expect(await search('bag\u0306l\u0131')).toEqual(['imported/composed.txt']);
  });

  it('finds a dotted capital I stored as I + a combining dot, whatever way the i is typed', async () => {
    await put('imported/izmir.txt', { name: 'I\u0307zmir.txt' });
    await put('imported/other.txt', { name: 'Ankara.txt' });
    for (const typed of ['izmir', 'IZMIR', '\u0130zmir', '\u0131zmir', 'I\u0307zmir', 'i\u0307zmir']) {
      expect(await search(typed), typed).toEqual(['imported/izmir.txt']);
    }
  });

  it('pages through a search with its cursor: every match once', async () => {
    for (let index = 0; index < 5; index += 1) await put(`reports/q_${index}.txt`);
    await put('reports/qx0.txt');
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await getDb().listFileRecords({ providerKey, bucketKey, projectId, search: 'q_', limit: 2, cursor });
      seen.push(...page.items.map((record) => record.key));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(['reports/q_0.txt', 'reports/q_1.txt', 'reports/q_2.txt', 'reports/q_3.txt', 'reports/q_4.txt']);
  });
});
