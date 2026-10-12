/**
 * The portal strings of the "Now" release and of the embed with a host-signed identity
 * (`portals.*`, portalsNow.en.ts / portalsNow.tr.ts): English and Turkish carry the same keys with the same
 * placeholders, every message is valid ICU (next-intl would otherwise throw while rendering a page), nothing is left
 * in English in the Turkish file, and the existing portal strings are untouched by the spread.
 */
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { portalsNowEn } from '@/lib/i18n/messages/portalsNow.en';
import { portalsNowTr } from '@/lib/i18n/messages/portalsNow.tr';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

const en = flatten(portalsNowEn as unknown as Tree);
const tr = flatten(portalsNowTr as unknown as Tree);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('portalsNow messages', () => {
  it('has a good number of strings (the lane that builds the portal screens relies on them)', () => {
    expect(en.size).toBeGreaterThan(400);
  });

  it('has the same keys in English and Turkish', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it('has the same placeholders in both languages and no empty text', () => {
    for (const [key, text] of en) {
      const turkish = tr.get(key);
      expect(text.trim(), `${key} (en) is empty`).not.toBe('');
      expect(turkish?.trim(), `${key} (tr) is empty`).not.toBe('');
      expect(placeholders(turkish ?? ''), `${key} placeholders`).toEqual(placeholders(text));
    }
  });

  it('is valid ICU message syntax in both languages', () => {
    for (const [locale, table] of [['en', en], ['tr', tr]] as const) {
      for (const [key, text] of table) {
        expect(() => new IntlMessageFormat(text, locale), `${locale}: ${key}`).not.toThrow();
      }
    }
  });

  it('is actually translated (no key is left in English)', () => {
    // Words that are legitimately the same in both languages (technical names, codes, example values).
    const SAME = /^(Model|HS256|RS256|ES256|iframe|React|JSON|CSV|URL|PEM|JWKS|Markdown|\{\w+\}|10\.0\.0\.0\/8|https:\/\/|https:\/\/(intranet|app)\.example\.com)$/;
    const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('addresses the reader formally in Turkish', () => {
    const INFORMAL = /(?<![\p{L}])(iznin yok|yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
  });

  it('is part of the portals namespace of both languages, next to the strings that were already there', () => {
    for (const locale of ['en', 'tr'] as const) {
      const portals = (messages[locale] as unknown as { portals: Tree }).portals;
      const all = flatten(portals);
      const source = locale === 'en' ? en : tr;
      for (const [key, text] of source) expect(all.get(key), `${locale}: portals.${key}`).toBe(text);
      // the pre-existing sections are still there
      for (const key of ['detail.tabs.access', 'form.sectionAccess', 'runtime.noAccess.title', 'runtime.reference']) {
        expect(all.has(key), `${locale}: portals.${key}`).toBe(true);
      }
    }
  });

  it('keeps the new top-level sections the portal lane was promised', () => {
    expect(Object.keys(portalsNowEn).sort()).toEqual([
      'announcements', 'apiErrors', 'audit', 'compliance', 'embed', 'experience', 'gate', 'limits', 'menu', 'meta',
      'network', 'newTabs', 'testMode', 'transfer',
    ]);
  });
});
