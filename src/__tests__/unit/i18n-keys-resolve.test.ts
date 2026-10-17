/**
 * A word a screen asks for must exist, in English AND Turkish. A missing key does not fail anything: the screen
 * prints its own dotted path ("agents.sessionAccess.ownerYou"). It happened once because a block of strings was
 * pasted into the wrong place of the message file, so both languages agreed with each other and with nothing else.
 *
 * Reads every component and service for `const t = useTranslations('some.namespace')` and the literal keys it is
 * called with (`t('key')`), and looks each one up in both message files. Keys built at run time are not seen here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function lookup(locale: 'en' | 'tr', key: string): unknown {
  let node: unknown = messages[locale];
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe('every literal translation key a component asks for exists in both languages', () => {
  it('(scans the sources)', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      // A name bound to ONE namespace in this file; a name reused for two namespaces is skipped (it cannot be told apart here).
      const namespaces = new Map<string, Set<string>>();
      for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*useTranslations\(\s*'([^']+)'\s*\)/g)) {
        if (!namespaces.has(match[1])) namespaces.set(match[1], new Set());
        namespaces.get(match[1])!.add(match[2]);
      }
      for (const [name, set] of namespaces) {
        if (set.size !== 1) continue;
        const namespace = [...set][0];
        for (const call of source.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*'([^']+)'`, 'g'))) {
          checked += 1;
          for (const locale of ['en', 'tr'] as const) {
            if (typeof lookup(locale, `${namespace}.${call[1]}`) !== 'string') {
              missing.push(`${locale}: ${namespace}.${call[1]}  (${path.relative(SRC, file)})`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });
});

describe('agents.sessionAccess (who started a session, who may answer it)', () => {
  const KEYS = [
    'ownerColumn', 'ownerYou', 'ownerRoutine', 'ownerPublicA2a', 'ownerEvaluation', 'ownerRedteam', 'ownerSystem',
    'ownOnlyNotice', 'waitingElsewhereBadge', 'waitingElsewhereTooltip',
  ];

  it.each(KEYS)('%s is a sentence in English and in Turkish', (key) => {
    expect(typeof lookup('en', `agents.sessionAccess.${key}`), key).toBe('string');
    expect(typeof lookup('tr', `agents.sessionAccess.${key}`), `tr:${key}`).toBe('string');
    expect(lookup('tr', `agents.sessionAccess.${key}`), `tr:${key}`).not.toBe(lookup('en', `agents.sessionAccess.${key}`));
  });

  it('is not tucked into the dashboard quick start, where it was once pasted', () => {
    for (const locale of ['en', 'tr'] as const) {
      expect(Object.keys(lookup(locale, 'dashboardOverview.quickStart.steps.agents') as object).sort()).toEqual(['description', 'title']);
    }
  });
});
