/**
 * The reversible PII round trip on its own: keyed tokens, restore, and the
 * stream restorer that must never let half a token through.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { detect } from '@/lib/services/pii/detector';
import {
  PiiRoundTrip,
  clearRoundTripScanCache,
  deriveRoundTripKey,
} from '@/lib/services/pii/roundTrip';

const TC_A = '12345678950';
const TC_B = '98765432150';
const scan = async (text: string) => detect(text, { categories: { tc_kimlik: true, email: true }, languages: ['global', 'tr'] });

const roundTrip = (scope = 'session:1', version = 'policy@1') =>
  new PiiRoundTrip({ key: deriveRoundTripKey('secret', 'tenant-1', scope), version, scan });

beforeEach(() => clearRoundTripScanCache());

describe('tokens', () => {
  it('replaces each value with a bracketed, letters-only token and keeps the rest of the text', async () => {
    const out = await roundTrip().protectText(`Müşteri ${TC_A}, e-posta ayse@example.com`);
    expect(out).toMatch(/^Müşteri \[TC_KIMLIK_[a-z]{8}\], e-posta \[EMAIL_[a-z]{8}\]$/);
    expect(out).not.toContain(TC_A);
  });

  it('gives the same value the same token in every call of a scope, and another token in another scope', async () => {
    const first = await roundTrip('session:1').protectText(TC_A);
    const again = await roundTrip('session:1').protectText(`x ${TC_A} y ${TC_A}`);
    const other = await roundTrip('session:2').protectText(TC_A);
    expect(again).toBe(`x ${first} y ${first}`);
    expect(other).not.toBe(first);
    expect(await roundTrip('session:1').protectText(TC_B)).not.toBe(first);
  });

  it('does not tokenize a token again when the history comes back', async () => {
    const rt = roundTrip();
    const once = await rt.protectText(`TC ${TC_A}`);
    expect(await rt.protectText(once)).toBe(once);
  });

  it('keeps a table one row per line', async () => {
    const csv = `no,tckn,tarih\n1,${TC_A},2026-09-19\n2,${TC_B},2026-10-04`;
    const out = await roundTrip().protectText(csv);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toContain(TC_A);
    expect(out).toContain('2026-09-19');
  });
});

describe('restore', () => {
  it('turns tokens back into values, with or without the brackets, and leaves unknown tokens alone', async () => {
    const rt = roundTrip();
    const token = await rt.protectText(TC_A);
    const bare = token.slice(1, -1);
    expect(rt.restoreText(`A: ${token}. B: ${bare}. C: [TC_KIMLIK_zzzzzzzz]`)).toBe(`A: ${TC_A}. B: ${TC_A}. C: [TC_KIMLIK_zzzzzzzz]`);
  });

  it('JSON-escapes a value restored into tool-call arguments', async () => {
    const rt = new PiiRoundTrip({
      key: deriveRoundTripKey('secret', 't', 's'),
      version: 'custom',
      scan: async (text) => {
        const at = text.indexOf('Ali "Kaya"');
        return at < 0 ? [] : [{ category: 'person', value: 'Ali "Kaya"', start: at, end: at + 10 } as never];
      },
    });
    const token = await rt.protectText('Ali "Kaya"');
    const args = rt.restoreText(`{"name":"${token}"}`, true);
    expect(JSON.parse(args)).toEqual({ name: 'Ali "Kaya"' });
  });
});

describe('stream restorer', () => {
  it('restores a token split at every possible position', async () => {
    const rt = roundTrip();
    const token = await rt.protectText(TC_A);
    const answer = `Kayıt ${token} bulundu; tekrar: ${token.slice(1, -1)}.`;
    const expected = `Kayıt ${TC_A} bulundu; tekrar: ${TC_A}.`;
    for (let cut = 1; cut < answer.length; cut++) {
      const restorer = rt.streamRestorer();
      const out = restorer.push(answer.slice(0, cut)) + restorer.push(answer.slice(cut)) + restorer.flush();
      expect(out).toBe(expected);
    }
  });

  it('restores a token streamed one character at a time and never emits part of it', async () => {
    const rt = roundTrip();
    const token = await rt.protectText(TC_A);
    const restorer = rt.streamRestorer();
    const pieces = [...`TC: ${token} tamam`].map((ch) => restorer.push(ch));
    expect(pieces.join('') + restorer.flush()).toBe(`TC: ${TC_A} tamam`);
    for (const piece of pieces) expect(piece).not.toMatch(/TC_KIMLIK|\[/);
  });

  it('lets ordinary text through without waiting for the end', async () => {
    const restorer = roundTrip().streamRestorer();
    expect(restorer.push('merhaba dünya ')).toBe('merhaba dünya ');
  });
});
