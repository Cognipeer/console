import { describe, it, expect } from 'vitest';
import { detect, detectAsync, fuseCandidates } from '@/lib/services/pii/detector';
import type { Candidate } from '@/lib/services/pii/confidence';
import type { PiiLanguage } from '@/lib/database';

describe('detectAsync — fast path (mode: "pattern" or absent)', () => {
  it('is byte-for-byte identical to detect() when no detection.mode is set', async () => {
    const text = 'contact ahmet@example.com or call 0532 123 45 67';
    const config = { categories: { email: true, tr_phone: true }, languages: ['tr'] as PiiLanguage[] };
    const sync = detect(text, config, 'detect');
    const { findings, degraded } = await detectAsync(text, config, 'detect');
    expect(findings).toEqual(sync);
    expect(degraded).toEqual([]);
  });

  it('is identical when detection.mode is explicitly "pattern"', async () => {
    const text = 'a@b.com';
    const config = { categories: { email: true }, detection: { mode: 'pattern' as const } };
    const sync = detect(text, config, 'detect');
    const { findings } = await detectAsync(text, config, 'detect');
    expect(findings).toEqual(sync);
  });
});

describe('detectAsync — mode: "pattern+dictionary"', () => {
  it('adds person findings the pattern layer alone cannot see', async () => {
    const text = 'Sayın Ahmet Yılmaz, TCKN 12345678950 ile kayıtlıdır.'; // TCKN checksum irrelevant here, category not enabled
    const config = {
      categories: { person: true },
      languages: ['tr'] as PiiLanguage[],
      detection: { mode: 'pattern+dictionary' as const },
    };
    const { findings } = await detectAsync(text, config, 'detect');
    const person = findings.find((f) => f.category === 'person');
    expect(person).toBeDefined();
    expect(person!.value).toBe('Sayın Ahmet Yılmaz');
    expect(person!.detector).toBe('dictionary');
    expect(person!.replacement).toBe('[İSİM]'); // mask strategy came from categories.ts's `person` entry
  });

  it('a policy-set minConfidence filters out a weak, uncorroborated candidate', async () => {
    const text = 'Bugün Can çok mutluydu.'; // "Can" — capitalized but ambiguous common word, no title/surname
    const config = {
      categories: { person: true },
      languages: ['tr'] as PiiLanguage[],
      detection: { mode: 'pattern+dictionary' as const, minConfidence: 0.5 },
    };
    const { findings } = await detectAsync(text, config, 'detect');
    expect(findings.filter((f) => f.category === 'person')).toHaveLength(0);
  });
});

describe('fuseCandidates', () => {
  const base = (over: Partial<Candidate>): Candidate => ({
    category: 'person',
    start: 0,
    end: 5,
    value: 'Ahmet',
    baseScore: 0.4,
    detector: 'dictionary',
    severity: 'high',
    label: 'Person name',
    evidence: [],
    ...over,
  });

  it('combines two independent same-category detectors on the same span via noisy-OR', () => {
    const text = 'Ahmet geldi bugün.';
    const fused = fuseCandidates(text, [
      base({ baseScore: 0.4, detector: 'dictionary' }),
      base({ baseScore: 0.5, detector: 'ner' }),
    ], 0);
    expect(fused).toHaveLength(1);
    expect(fused[0].baseScore).toBeCloseTo(0.7, 5); // 1 - 0.6*0.5
  });

  it('resolves a cross-category overlap by highest confidence', () => {
    const text = 'Ankara güzel.';
    const fused = fuseCandidates(text, [
      { ...base({ category: 'person', baseScore: 0.3, start: 0, end: 6, value: 'Ankara' }) },
      { ...base({ category: 'location', baseScore: 0.6, start: 0, end: 6, value: 'Ankara', severity: 'low' }) },
    ], 0);
    expect(fused).toHaveLength(1);
    expect(fused[0].category).toBe('location');
  });

  it('drops everything below minConfidence after fusion', () => {
    const fused = fuseCandidates('Ahmet', [base({ baseScore: 0.3 })], 0.5);
    expect(fused).toHaveLength(0);
  });

  it('keeps a long structural match over a short, high-confidence span it fully contains', () => {
    // Regression: NER tagging "Kızılay" as `location` inside `address_tr`'s
    // full "Kızılay Mahallesi ... No:12" span used to silently replace the
    // whole address with just the neighbourhood name (found during the
    // v2 benchmark — see the report).
    const text = 'Kızılay Mahallesi Atatürk Caddesi No:12 adresine gönderin.';
    const fullSpan = text.indexOf('Kızılay Mahallesi Atatürk Caddesi No:12');
    const shortSpan = text.indexOf('Kızılay');
    const fused = fuseCandidates(text, [
      base({
        category: 'address_tr', start: fullSpan, end: fullSpan + 'Kızılay Mahallesi Atatürk Caddesi No:12'.length,
        value: 'Kızılay Mahallesi Atatürk Caddesi No:12', baseScore: 0.9, severity: 'medium',
      }),
      base({
        category: 'location', start: shortSpan, end: shortSpan + 'Kızılay'.length,
        value: 'Kızılay', baseScore: 0.97, severity: 'low', detector: 'ner',
      }),
    ], 0);
    expect(fused).toHaveLength(1);
    expect(fused[0].category).toBe('address_tr');
  });

  it('still lets a much more confident short span win over a weak long one', () => {
    const text = 'xxxxxxxxxxxxxxxxxxxxAhmetxxxxxxxxxxxxxxxxxxxx';
    const fused = fuseCandidates(text, [
      base({ category: 'address_tr', start: 0, end: text.length, value: text, baseScore: 0.2, severity: 'medium' }),
      base({ category: 'person', start: 20, end: 25, value: 'Ahmet', baseScore: 0.9, severity: 'high', detector: 'ner' }),
    ], 0);
    expect(fused).toHaveLength(1);
    expect(fused[0].category).toBe('person');
  });

  it('re-slices the merged value from the full combined span, not either input candidate alone', () => {
    const text = 'Ahmet Yılmaz burada.';
    const fused = fuseCandidates(text, [
      base({ start: 0, end: 5, value: 'Ahmet', baseScore: 0.4 }), // "Ahmet"
      base({ start: 0, end: 12, value: 'Ahmet Yılmaz', baseScore: 0.5 }), // "Ahmet Yılmaz"
    ], 0);
    expect(fused).toHaveLength(1);
    expect(fused[0].value).toBe('Ahmet Yılmaz');
    expect(fused[0].start).toBe(0);
    expect(fused[0].end).toBe(12);
  });
});
