/**
 * The `alerts` and `incidents` namespaces (split files alerts.en.ts / alerts.tr.ts) plus the
 * `tracingHealth` and `entityHealth` skeleton namespaces: English and Turkish carry the same
 * keys with the same placeholders, nothing is left in English, and the Turkish addresses the
 * reader formally.
 */
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

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

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

// words that are legitimately the same in both languages
const SAME = /^(model|guardrail|api|mcp|email|e-posta|webhook|slack|teams|pagerduty)$/i;

for (const namespace of ['alerts', 'incidents', 'tracingHealth', 'entityHealth'] as const) {
  describe(`${namespace} messages`, () => {
    const enTree = (messages.en as unknown as Record<string, Tree>)[namespace];
    const trTree = (messages.tr as unknown as Record<string, Tree>)[namespace];

    it('exists in both languages', () => {
      expect(enTree).toBeDefined();
      expect(trTree).toBeDefined();
    });

    const en = flatten(enTree!);
    const tr = flatten(trTree!);

    it('has the same keys in English and Turkish', () => {
      expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
      expect(en.size).toBeGreaterThan(0);
    });

    it('has the same placeholders in both languages and no empty text', () => {
      for (const [key, text] of en) {
        expect(text.trim(), `${key} (en) is empty`).not.toBe('');
        expect(tr.get(key)?.trim(), `${key} (tr) is empty`).not.toBe('');
        expect(placeholders(tr.get(key) ?? ''), `${key} placeholders`).toEqual(placeholders(text));
      }
    });

    it('is actually translated (no key is left in English)', () => {
      // A pure format string ('{label}: {value}') has no words to translate.
      const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{\w+\}/g, ''));
      const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text) && hasWords(text));
      expect(untranslated.map(([key]) => key)).toEqual([]);
    });

    it('addresses the reader formally in Turkish (sizin/siz, never senin/sen)', () => {
      const INFORMAL = /(?<![\p{L}])(iznin yok|yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
      for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
    });
  });
}

describe('alerts and incidents keep the console terms', () => {
  const tr = messages.tr as unknown as { alerts: { title: string; form: Record<string, string> }; incidents: Record<string, string> };
  it('uses the established Turkish product terms', () => {
    expect(tr.alerts.title).toBe('Uyarılar ve Olaylar');
    expect(tr.alerts.form.ragModuleKey).toContain('Bilgi Motoru');
    expect(tr.incidents.title).toBe('Olaylar');
  });
});
