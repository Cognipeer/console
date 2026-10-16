/**
 * The `tracingHealth` namespace: English and Turkish carry the same keys with the same placeholders, nothing is
 * left in English, the Turkish addresses the reader formally, and every key the tracing health views ask for exists.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { TRACING_STATUS_LABELED } from '@/components/tracing/sessionStatus';

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

const en = flatten((messages.en as unknown as Record<string, Tree>).tracingHealth!);
const tr = flatten((messages.tr as unknown as Record<string, Tree>).tracingHealth!);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('tracingHealth messages', () => {
  it('has the same keys in English and Turkish', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
    expect(en.size).toBeGreaterThan(150);
  });

  it('has the same placeholders in both languages and no empty text', () => {
    for (const [key, text] of en) {
      expect(text.trim(), `${key} (en) is empty`).not.toBe('');
      expect(tr.get(key)?.trim(), `${key} (tr) is empty`).not.toBe('');
      expect(placeholders(tr.get(key) ?? ''), `${key} placeholders`).toEqual(placeholders(text));
    }
  });

  it('is actually translated (no key is left in English)', () => {
    // Percentile names are the same in both languages.
    const SAME = /^(p50|p95)$/i;
    const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('addresses the reader formally in Turkish (sizin/siz, never senin/sen)', () => {
    const INFORMAL = /(?<![\p{L}])(yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
  });

  it('labels every status the tracing pages draw', () => {
    for (const status of TRACING_STATUS_LABELED) {
      expect(en.get(`status.${status}`), status).toBeTruthy();
      expect(tr.get(`status.${status}`), status).toBeTruthy();
    }
  });
});

describe('the tracing health views only ask for keys that exist', () => {
  const SRC = path.resolve(__dirname, '../..');
  const roots = ['components/tracing', 'app/dashboard/tracing'].map((dir) => path.join(SRC, dir));

  function files(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) files(full, out);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it('resolves every literal tracingHealth key in both languages', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of roots.flatMap((root) => files(root))) {
      const source = readFileSync(file, 'utf8');
      for (const bound of source.matchAll(/\bconst\s+(\w+)\s*=\s*useTranslations\(\s*'tracingHealth'\s*\)/g)) {
        const name = bound[1]!;
        for (const call of source.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*'([^']+)'`, 'g'))) {
          checked += 1;
          for (const [locale, table] of [['en', en], ['tr', tr]] as const) {
            if (!table.has(call[1]!)) missing.push(`${locale}: ${call[1]} (${path.relative(SRC, file)})`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});

describe('the Alerts entry of the main navigation', () => {
  const nav = (locale: 'en' | 'tr') =>
    (messages[locale] as unknown as { navigation: Record<string, string> }).navigation.alertsDescription;

  it('describes all four rule kinds and no longer calls itself threshold-only, in both languages', () => {
    expect(nav('en')).toMatch(/baseline/i);
    expect(nav('en')).toMatch(/absence/i);
    expect(nav('en')).toMatch(/SLO/);
    expect(nav('en')).not.toMatch(/quality, cost/i);
    // Turkish has its own text (not the English fallback) and the same kinds.
    expect(nav('tr')).toBeTruthy();
    expect(nav('tr')).not.toBe(nav('en'));
    expect(nav('tr')).toMatch(/taban çizgisi/);
    expect(nav('tr')).toMatch(/yokluk/);
    expect(nav('tr')).toMatch(/SLO/);
  });
});
