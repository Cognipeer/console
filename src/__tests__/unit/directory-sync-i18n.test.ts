/**
 * The `directorySync` namespace (the directory-sync part of the SSO and LDAP settings
 * screens): English and Turkish carry the same keys with the same placeholders, nothing
 * is left in English, and the Turkish addresses the reader formally.
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

const en = flatten((messages.en as unknown as Record<string, Tree>).directorySync!);
const tr = flatten((messages.tr as unknown as Record<string, Tree>).directorySync!);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('directorySync messages', () => {
  it('has the same keys in English and Turkish', () => {
    expect([...tr.keys()].sort()).toEqual([...en.keys()].sort());
    expect(en.size).toBeGreaterThan(10);
  });

  it('has the same placeholders in both languages and no empty text', () => {
    for (const [key, text] of en) {
      expect(text.trim(), `${key} (en) is empty`).not.toBe('');
      expect(tr.get(key)?.trim(), `${key} (tr) is empty`).not.toBe('');
      expect(placeholders(tr.get(key) ?? ''), `${key} placeholders`).toEqual(placeholders(text));
    }
  });

  it('is actually translated (no key is left in English)', () => {
    // words that are legitimately the same in both languages
    const SAME = /^(groups|engineers)$/i;
    const untranslated = [...en].filter(([key, text]) => tr.get(key) === text && !SAME.test(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('addresses the reader formally in Turkish (sizin/siz, never senin/sen)', () => {
    const INFORMAL = /(?<![\p{L}])(iznin yok|yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
    for (const [key, text] of tr) expect(text, key).not.toMatch(INFORMAL);
  });

  it('keeps the product terms of the rest of the console', () => {
    // a directory group feeds a "konsol grubu"; the roles are "rol", the workspace is "çalışma alanı"
    expect(tr.get('groups.consoleGroupLabel')).toBe('Konsol grubu');
    expect(tr.get('role.label')).toContain('Rol');
    expect(tr.get('role.descriptionOidc')).toMatch(/çalışma alanı/iu);
  });
});
