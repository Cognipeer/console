/**
 * The strings of the Overview, Limits and dashboard-home polish exist in
 * English AND Turkish (a missing key renders as its dotted path), and the
 * Turkish is a translation, not the English repeated.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { QUICK_START_SERVICES } from '@/components/dashboard/quickStartModel';

const ROOT = path.resolve(__dirname, '../..');

function lookup(locale: 'en' | 'tr', key: string): unknown {
  let node: unknown = messages[locale];
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const leaves = (node: unknown, prefix = ''): Array<[string, string]> =>
  node && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`))
    : [[prefix.slice(0, -1), String(node)]];

const tokens = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dashboard quick start strings', () => {
  it('has a title and a sentence for every step, in both languages', () => {
    for (const service of QUICK_START_SERVICES) {
      for (const field of ['title', 'description']) {
        const key = `dashboardOverview.quickStart.steps.${service}.${field}`;
        expect(typeof lookup('en', key), key).toBe('string');
        expect(typeof lookup('tr', key), `tr:${key}`).toBe('string');
      }
    }
  });

  it('has the same keys and placeholders in both languages', () => {
    const en = leaves(lookup('en', 'dashboardOverview.quickStart'));
    const tr = leaves(lookup('tr', 'dashboardOverview.quickStart'));
    expect(tr.map(([k]) => k).sort()).toEqual(en.map(([k]) => k).sort());
    const trByKey = new Map(tr);
    for (const [key, value] of en) expect(tokens(trByKey.get(key)!), key).toEqual(tokens(value));
  });

  it('translates them instead of repeating the English', () => {
    const en = new Map(leaves(lookup('en', 'dashboardOverview.quickStart')));
    const untranslated = leaves(lookup('tr', 'dashboardOverview.quickStart'))
      .filter(([key, value]) => value === en.get(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('is read through the keys the component builds', () => {
    const source = readFileSync(path.join(ROOT, 'components/dashboard/QuickStart.tsx'), 'utf8');
    expect(source).toContain("useTranslations('dashboardOverview.quickStart')");
    for (const key of ['title', 'subtitle', 'step']) {
      expect(typeof lookup('en', `dashboardOverview.quickStart.${key}`), key).toBe('string');
      expect(source).toContain(`t('${key}'`);
    }
  });
});

describe('the "not found" badge and the deleted-policy note', () => {
  it.each([
    'iamLimits.target.notFound',
    'iamLimits.target.notFoundHint',
    'iamOverview.denials.policyDeleted',
  ])('%s exists in both languages and is translated', (key) => {
    expect(typeof lookup('en', key)).toBe('string');
    expect(typeof lookup('tr', key)).toBe('string');
    expect(lookup('tr', key)).not.toBe(lookup('en', key));
  });

  it('replaced the old "deleted" badge text', () => {
    expect(lookup('en', 'iamLimits.target.deleted')).toBeUndefined();
    expect(lookup('tr', 'iamLimits.target.deleted')).toBeUndefined();
  });
});

describe('the quota editor and its cards in Turkish', () => {
  const SAME_ON_PURPOSE = new Set([
    // product and unit names
    'form.perRequest.llm',
    'card.rpm',
    'card.rph',
    'card.rpd',
    'card.tpm',
    'card.tpd',
    'card.model',
    'card.unlimited',
    'target.kind.model',
    'target.types.model',
  ]);

  it('translates every string of the quota section instead of falling back to the English', () => {
    const en = new Map(leaves(lookup('en', 'settings.quotaSection')));
    const untranslated = leaves(lookup('tr', 'settings.quotaSection'))
      .filter(([key, value]) => value === en.get(key) && !SAME_ON_PURPOSE.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('keeps the same placeholders in both languages', () => {
    const en = leaves(lookup('en', 'settings.quotaSection'));
    const tr = new Map(leaves(lookup('tr', 'settings.quotaSection')));
    for (const [key, value] of en) expect(tokens(tr.get(key) ?? ''), key).toEqual(tokens(value));
  });

  it('translates the editor\'s own headings, summary and checklist', () => {
    const en = leaves(lookup('en', 'iamLimits.form.editor'));
    const tr = new Map(leaves(lookup('tr', 'iamLimits.form.editor')));
    expect([...tr.keys()].sort()).toEqual(en.map(([k]) => k).sort());
    for (const [key, value] of en) {
      expect(tr.get(key), key).not.toBe(value);
      expect(tokens(tr.get(key)!), key).toEqual(tokens(value));
    }
  });

  it('leaves no sentence of the editor written in English in the source', () => {
    const source = readFileSync(path.join(ROOT, 'components/quota/QuotaPolicyModal.tsx'), 'utf8');
    // A heading, label or description given as a plain string literal prop would show in English in Turkish.
    const literal = [...source.matchAll(/\b(?:title|description|label|subtitle)="([A-Z][^"]*)"/g)].map((m) => m[1]);
    expect(literal).toEqual([]);
  });
});

describe('the dashboard home in Turkish', () => {
  // Product names and a figure line that reads the same.
  const SAME_ON_PURPOSE = new Set(['stats.models', 'resources.sdk', 'home.topResources.modelsHint']);

  it('translates every string of the page instead of falling back to the English', () => {
    const en = new Map(leaves(lookup('en', 'dashboardOverview')));
    const untranslated = leaves(lookup('tr', 'dashboardOverview'))
      .filter(([key, value]) => value === en.get(key) && !SAME_ON_PURPOSE.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it('has the same keys and placeholders in both languages', () => {
    const en = leaves(lookup('en', 'dashboardOverview'));
    const tr = new Map(leaves(lookup('tr', 'dashboardOverview')));
    expect([...tr.keys()].sort()).toEqual(en.map(([k]) => k).sort());
    for (const [key, value] of en) expect(tokens(tr.get(key) ?? ''), key).toEqual(tokens(value));
  });

  it('leaves no heading or label of the page written in English in the source', () => {
    const source = readFileSync(path.join(ROOT, 'app/dashboard/overview/page.tsx'), 'utf8');
    const literal = [...source.matchAll(/\b(?:eyebrow|title|label|subtitle)="([A-Z][^"]*)"/g)].map((m) => m[1]);
    expect(literal).toEqual([]);
    // ...nor a sentence between tags
    expect([...source.matchAll(/>\s*([A-Z][a-z]+(?: [a-z]+)+)\s*</g)].map((m) => m[1])).toEqual([]);
  });
});
