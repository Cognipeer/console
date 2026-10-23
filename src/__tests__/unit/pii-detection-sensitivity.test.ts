/**
 * A PII policy's `detection.minConfidence` / `detection.contextBoost` must mean
 * the same thing for both engines. Before this, the cognipeer engine never saw
 * them (`scanWithCognipeer` hardcoded `{ mode }`), so a threshold set on a
 * cognipeer policy was silently ignored.
 *
 * Runs against the REAL `@cognipeer/pii` package and the real regex detector.
 */
import { describe, expect, it } from 'vitest';
import { detectPii, parseDetectionInput } from '@/lib/services/pii/piiService';
import type { PiiEngine } from '@/lib/database';

// No context words, so the scores are the categories' own: TC 0.95, email 0.9, phone 0.5.
const TEXT = 'Kayıt: 10000000146 / 0532 123 45 67 / ayse@example.com';

describe('parseDetectionInput', () => {
  it('passes an absent field through', () => {
    expect(parseDetectionInput(undefined)).toEqual({});
  });

  it('accepts minConfidence in [0, 1] and a boolean contextBoost', () => {
    expect(parseDetectionInput({ minConfidence: 0.6, contextBoost: false })).toEqual({
      detection: { minConfidence: 0.6, contextBoost: false },
    });
    expect(parseDetectionInput({ minConfidence: 0 })).toEqual({ detection: { minConfidence: 0 } });
    expect(parseDetectionInput({ minConfidence: 1 })).toEqual({ detection: { minConfidence: 1 } });
  });

  it.each([
    [null, 'detection must be an object'],
    [[], 'detection must be an object'],
    [{ minConfidence: 1.2 }, 'detection.minConfidence must be a number between 0 and 1'],
    [{ minConfidence: -0.1 }, 'detection.minConfidence must be a number between 0 and 1'],
    [{ minConfidence: '0.5' }, 'detection.minConfidence must be a number between 0 and 1'],
    [{ contextBoost: 'yes' }, 'detection.contextBoost must be a boolean'],
    [{ mode: 'pattern+dictionary+ner' }, 'detection.mode is not supported (use minConfidence, contextBoost)'],
  ])('rejects %j', (input, error) => {
    expect(parseDetectionInput(input)).toEqual({ error });
  });
});

describe.each<PiiEngine>(['regex', 'cognipeer'])('detection.minConfidence · %s engine', (engine) => {
  it('drops findings below the threshold and keeps the rest', async () => {
    const all = await detectPii({ text: TEXT, engine });
    const scores = all.findings.map((f) => f.confidence ?? 1);
    // The fixture must straddle the threshold for the test to mean anything.
    expect(Math.min(...scores)).toBeLessThan(0.6);
    expect(Math.max(...scores)).toBeGreaterThanOrEqual(0.6);

    const filtered = await detectPii({ text: TEXT, engine, detection: { minConfidence: 0.6 } });
    expect(filtered.findings.length).toBeGreaterThan(0);
    expect(filtered.findings.length).toBeLessThan(all.findings.length);
    for (const finding of filtered.findings) expect(finding.confidence ?? 1).toBeGreaterThanOrEqual(0.6);
  });

  it('treats 0 as "no filtering"', async () => {
    const all = await detectPii({ text: TEXT, engine });
    const zero = await detectPii({ text: TEXT, engine, detection: { minConfidence: 0 } });
    expect(zero.findings.map((f) => f.category)).toEqual(all.findings.map((f) => f.category));
  });
});

describe.each<PiiEngine>(['regex', 'cognipeer'])('detection.contextBoost · %s engine', (engine) => {
  it('raises a finding\'s confidence only while it is on', async () => {
    const text = 'Telefon numaram: 0532 123 45 67';
    const languages = ['tr' as const];
    const on = await detectPii({ text, engine, languages });
    const off = await detectPii({ text, engine, languages, detection: { contextBoost: false } });
    const score = (r: typeof on) => Math.max(...r.findings.map((f) => f.confidence ?? 0));
    expect(score(on)).toBeGreaterThan(score(off));
  });
});
