/**
 * The `usage` namespace (split files usage.en.ts / usage.tr.ts): English and Turkish carry the
 * same keys with the same placeholders, nothing is left in English, the Turkish addresses the
 * reader formally, and the public-repo wording rule holds (no prices or currencies).
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
const SAME = /^(api|mcp|a2a|webhook|portal|plan)$/i;

describe('usage messages', () => {
  const enTree = (messages.en as unknown as Record<string, Tree>).usage;
  const trTree = (messages.tr as unknown as Record<string, Tree>).usage;

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
    const hasWords = (text: string) => /\p{L}/u.test(text.replace(/\{\w+\}/g, ''));
    const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text) && hasWords(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('addresses the reader formally in Turkish (sizin/siz, never senin/sen)', () => {
    const INFORMAL = /(?<![\p{L}])(iznin yok|yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
  });

  it('names every credit redeem error, ledger kind, event outcome and row the page can show', () => {
    for (const code of ['invalid_code', 'code_expired', 'wrong_tenant', 'already_redeemed', 'code_void', 'credits_unavailable', 'unknown']) {
      expect(en.has(`credits.errors.${code}`), code).toBe(true);
    }
    for (const kind of ['monthly_grant', 'redeem', 'charge', 'refund', 'adjust', 'expire']) {
      expect(en.has(`credits.kinds.${kind}`), kind).toBe(true);
    }
    for (const outcome of ['refused', 'would_refuse', 'queued', 'waited']) {
      expect(en.has(`events.outcomes.${outcome}`), outcome).toBe(true);
    }
    for (const row of ['apiRpm', 'agent', 'flow', 'job', 'browser', 'realtime', 'sandbox', 'searches', 'flowRuns', 'crawlerPages', 'sandboxHours']) {
      expect(en.has(`rows.${row}`), row).toBe(true);
    }
  });

  it('keeps prices and currencies out of the texts', () => {
    for (const [key, text] of [...en, ...tr]) expect(text, key).not.toMatch(/[$€£]|\bUSD\b|\bEUR\b/);
  });
});
