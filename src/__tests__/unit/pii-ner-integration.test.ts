/**
 * Integration test against the REAL local ONNX model
 * (`akdeniz27/bert-base-turkish-cased-ner`, downloaded directly from Hugging
 * Face — see `internal-notes/pii-v2-nlp-ve-asset-registry-plani.md`).
 *
 * Conditionally skipped when the model isn't present on disk (it's ~440MB,
 * gitignored, and never committed — see `.gitignore`'s `.models-local/`
 * entry) so CI and a clean checkout stay green; this is how the design is
 * actually exercised for the local benchmark/report, not a substitute for
 * it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { detectAsync } from '@/lib/services/pii/detector';
import { reloadConfig } from '@/lib/core/config';

const MODEL_PATH = path.resolve(process.cwd(), '.models-local');
const MODEL_ONNX = path.join(MODEL_PATH, 'tr-ner', 'onnx', 'model.onnx');
const hasModel = existsSync(MODEL_ONNX);

describe.skipIf(!hasModel)('NER (L3) against the real local tr-ner model', () => {
  const previousPath = process.env.PII_NER_MODEL_PATH;

  beforeAll(() => {
    process.env.PII_NER_MODEL_PATH = MODEL_PATH;
    reloadConfig();
  });

  afterAll(() => {
    if (previousPath === undefined) delete process.env.PII_NER_MODEL_PATH;
    else process.env.PII_NER_MODEL_PATH = previousPath;
    reloadConfig();
  });

  it(
    'finds a person and an organization NER alone would catch (no dictionary hit)',
    async () => {
      // "Zeliha Aköz" and "Vestel Elektronik" are deliberately absent from
      // the seed gazetteer (data/trGazetteer.ts) — this proves the NER pass
      // is doing real work, not being rescued by the dictionary pass.
      const text = 'Zeliha Aköz, Vestel Elektronik firmasında çalışıyor.';
      const { findings } = await detectAsync(
        text,
        { categories: { person: true, organization: true }, languages: ['tr'], detection: { mode: 'pattern+dictionary+ner' } },
        'detect',
      );
      const person = findings.find((f) => f.category === 'person');
      const org = findings.find((f) => f.category === 'organization');
      expect(person, JSON.stringify(findings)).toBeDefined();
      expect(person!.detector).toBe('ner');
      expect(org, JSON.stringify(findings)).toBeDefined();
    },
    30_000, // first call loads the model (~440MB fp32) — generous timeout
  );

  it('reconstructs correct character offsets (value matches text.slice(start,end))', async () => {
    const text = 'Toplantıya Ayşe Demir ve Barış Kaya katıldı.';
    const { findings } = await detectAsync(
      text,
      { categories: { person: true }, languages: ['tr'], detection: { mode: 'pattern+dictionary+ner' } },
      'detect',
    );
    const persons = findings.filter((f) => f.category === 'person');
    expect(persons.length).toBeGreaterThanOrEqual(1);
    for (const f of persons) {
      expect(text.slice(f.start, f.end)).toBe(f.value);
    }
  }, 30_000);

  it('reports degraded (not throwing) when the input is clipped by maxChars', async () => {
    const longText = 'Ahmet Yılmaz geldi. '.repeat(500); // well over a 200-char cap
    const { degraded } = await detectAsync(
      longText,
      {
        categories: { person: true },
        languages: ['tr'],
        detection: { mode: 'pattern+dictionary+ner', ner: { maxChars: 200 } },
      },
      'detect',
    );
    expect(degraded.some((d) => d.includes('clipped'))).toBe(true);
  }, 30_000);
});

describe('NER (L3) — degrades gracefully with no model configured', () => {
  it('runs pattern+dictionary and reports degraded instead of throwing when PII_NER_MODEL_PATH is unset', async () => {
    const previousPath = process.env.PII_NER_MODEL_PATH;
    delete process.env.PII_NER_MODEL_PATH;
    reloadConfig();
    try {
      const { findings, degraded } = await detectAsync(
        'Sayın Ahmet Yılmaz geldi.',
        { categories: { person: true }, languages: ['tr'], detection: { mode: 'pattern+dictionary+ner' } },
        'detect',
      );
      expect(findings.some((f) => f.category === 'person')).toBe(true); // dictionary pass still ran
      expect(degraded.length).toBeGreaterThan(0);
    } finally {
      if (previousPath === undefined) delete process.env.PII_NER_MODEL_PATH;
      else process.env.PII_NER_MODEL_PATH = previousPath;
      reloadConfig();
    }
  });
});
