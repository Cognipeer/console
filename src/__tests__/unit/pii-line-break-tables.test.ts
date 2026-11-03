/**
 * A PII finding never crosses a line break, and a date is not a phone number.
 *
 * Masking a CSV used to merge its rows: the phone pattern's separator class
 * matched the line break, so "2026-09-19\n2" (the last date cell plus the
 * next row's number) became one phone finding, and in the cognipeer engine
 * "2026-07-18\n118" passed the TCKN checksum. Both engines, through the
 * service entry points the client API and the guardrail use.
 */
import { describe, it, expect } from 'vitest';
import { detect, splitLines } from '@/lib/services/pii/detector';
import { tokenizePii, detokenizePii, maskPii } from '@/lib/services/pii/piiService';

/** Checksum-valid TCKN from nine leading digits. */
function tckn(first9: string): string {
  const d = first9.split('').map(Number);
  const d10 = (((d[0] + d[2] + d[4] + d[6] + d[8]) * 7 - (d[1] + d[3] + d[5] + d[7])) % 10 + 10) % 10;
  const d11 = (d.reduce((s, x) => s + x, 0) + d10) % 10;
  return `${first9}${d10}${d11}`;
}

/** A customer table: row number first, TCKN in the middle, date last. */
function customerCsv(rows: number): { csv: string; ids: string[] } {
  const ids: string[] = [];
  const lines = ['no,ad_soyad,tckn,sehir,tutar,tarih'];
  for (let i = 1; i <= rows; i++) {
    const id = tckn(String(100000000 + i * 7919).slice(0, 9));
    ids.push(id);
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    lines.push(`${i},Ayşe Yılmaz,${id},Ankara,${1000 + i},2026-${month}-${day}`);
  }
  // The exact pair the cognipeer engine read as one TCKN: 20260718118.
  lines.push(`${rows + 1},Ali Kaya,${tckn('456123789')},İzmir,500,2026-07-18`);
  lines.push(`118,Elif Koç,${tckn('987654321')},Bursa,700,2026-01-02`);
  return { csv: lines.join('\n'), ids };
}

describe('splitLines', () => {
  it('cuts at \\n, \\r\\n and \\r and keeps offsets into the text', () => {
    const text = 'a\nbb\r\nccc\rd';
    const lines = splitLines(text);
    expect(lines.map((l) => l.text)).toEqual(['a', 'bb', 'ccc', 'd']);
    for (const l of lines) expect(text.slice(l.start, l.start + l.text.length)).toBe(l.text);
  });
});

describe('regex engine: built-in patterns stay on one line', () => {
  it('does not read a date cell plus the next row number as a phone', () => {
    const findings = detect('1,x,2026-09-19\n2,y,2026-10-04', { categories: { phone: true } });
    expect(findings).toEqual([]);
  });

  it('still finds a phone that sits on the line after a number', () => {
    const text = '12345\n0532 123 45 67';
    const findings = detect(text, { categories: { phone: true } });
    expect(findings.map((f) => f.value)).toEqual(['0532 123 45 67']);
    expect(findings[0].start).toBe(6);
  });

  it('does not take a date for a phone number, in either order', () => {
    for (const date of ['2026-09-19', '19.09.2026', '19/09/2026', '2026.09.19']) {
      expect(detect(`tarih ${date}`, { categories: { phone: true } })).toEqual([]);
    }
    expect(detect('ara: +90 532 123 45 67', { categories: { phone: true } })).toHaveLength(1);
  });

  it('uses a context word on the previous line', () => {
    const text = 'TC Kimlik No:\n12345678950';
    const [finding] = detect(text, { categories: { tc_kimlik: true }, languages: ['global', 'tr'] });
    expect(finding.value).toBe('12345678950');
    expect(finding.evidence?.some((e) => e.includes('context word'))).toBe(true);
  });
});

describe.each(['regex', 'cognipeer'] as const)('%s engine: a tokenized customer table keeps its rows', (engine) => {
  const { csv, ids } = customerCsv(200);
  const lineCount = csv.split('\n').length;

  it('with only tc_kimlik enabled', async () => {
    const result = await tokenizePii({ text: csv, engine, languages: ['global', 'tr'], categories: { tc_kimlik: true } });
    for (const f of result.findings) expect(f.value).not.toMatch(/[\r\n]/);
    expect(result.outputText.split('\n')).toHaveLength(lineCount);
    for (const id of ids) expect(result.outputText).not.toContain(id);
    expect(new Set(Object.values(result.vault).map((v) => v.category))).toEqual(new Set(['tc_kimlik']));
    expect(detokenizePii({ text: result.outputText, vault: result.vault }).outputText).toBe(csv);
  });

  it('with the default categories', async () => {
    const result = await tokenizePii({ text: csv, engine, languages: ['global', 'tr'] });
    for (const f of result.findings) expect(f.value).not.toMatch(/[\r\n]/);
    expect(result.outputText.split('\n')).toHaveLength(lineCount);
    for (const id of ids) expect(result.outputText).not.toContain(id);
    // No date cell is tokenized as a phone.
    const phones = Object.values(result.vault).filter((v) => v.category === 'phone' || v.category === 'tr_phone');
    expect(phones).toEqual([]);
  });

  it('masks a phone on the line after a number without merging the lines', async () => {
    const text = 'tutar 12345\n0532 123 45 67';
    const result = await maskPii({ text, engine, languages: ['global', 'tr'] });
    expect(result.outputText.split('\n')).toHaveLength(2);
    expect(result.outputText.startsWith('tutar 12345\n')).toBe(true);
    expect(result.outputText).not.toContain('123 45 67');
  });
});
