/**
 * The IAM center's `iamCenter` namespace: English and Turkish carry exactly the
 * same keys, and every translation key the center's own source files use exists.
 * (A missing key would render as the raw key path in the UI.)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const ROOT = process.cwd();

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`),
  );
}

function resolve(tree: Tree, path: string): unknown {
  let current: unknown = tree;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Source files whose `t(...)` is the `iamCenter` translator (the other tabs use their own namespaces). */
function centerSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name)) {
        out.push(full);
      }
    }
  };
  const base = join(ROOT, 'src/components/iam');
  for (const sub of ['policies', 'check', 'pickers']) walk(join(base, sub));
  for (const name of readdirSync(base)) {
    const full = join(base, name);
    if (statSync(full).isFile() && /\.(ts|tsx)$/.test(name)) out.push(full);
  }
  out.push(join(ROOT, 'src/app/dashboard/iam/page.tsx'));
  return out;
}

const enCenter = (en as unknown as { iamCenter: Tree }).iamCenter;
const trCenter = (tr as unknown as { iamCenter: Tree }).iamCenter;

describe('iamCenter i18n', () => {
  it('has the same keys in English and Turkish', () => {
    expect(leaves(trCenter).sort()).toEqual(leaves(enCenter).sort());
  });

  it('keeps interpolation tokens identical between languages', () => {
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const path of leaves(enCenter)) {
      expect(tokens(resolve(trCenter, path) as string), path).toEqual(tokens(resolve(enCenter, path) as string));
    }
  });

  it('defines every literal key the center uses', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of centerSources()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?<![\w.$])t\(\s*'([^']+)'/g)) {
        const key = match[1];
        checked++;
        if (typeof resolve(enCenter, key) !== 'string') missing.push(`${relative(ROOT, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    // Guards the scan itself: an empty scan would pass vacuously.
    expect(checked).toBeGreaterThan(250);
  });

  it('defines the keys built at runtime', () => {
    const families: Record<string, string[]> = {
      levels: ['none', 'read', 'write', 'admin'],
      actionGroups: ['read', 'write', 'admin'],
      channels: ['dashboard', 'api', 'portal'],
      effects: ['permit', 'forbid', 'mixed'],
      modes: ['monitor', 'enforce'],
      authzModes: ['legacy', 'shadow', 'enforce'],
      tabs: ['overview', 'policies', 'principals', 'check', 'audit', 'limits', 'settings'],
      'matrix.categories': ['build', 'data', 'operate', 'admin', 'other'],
      'result.modeNote': ['legacy', 'shadow', 'enforce'],
      // verbs of RESOURCE_CRUD_VERBS and RESOURCE_EXTRA_VERBS in lib/iam/actions.ts
      verbs: ['get', 'list', 'create', 'update', 'delete', 'invoke', 'execute', 'call', 'query', 'infer', 'use'],
    };
    const missing: string[] = [];
    for (const [family, names] of Object.entries(families)) {
      for (const name of names) {
        const key = `${family}.${name}`;
        if (typeof resolve(enCenter, key) !== 'string') missing.push(key);
        if (typeof resolve(trCenter, key) !== 'string') missing.push(`tr:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('translates the Turkish namespace (no English left over)', () => {
    const same = leaves(enCenter).filter((path) => {
      const a = resolve(enCenter, path) as string;
      const b = resolve(trCenter, path) as string;
      // Short product words (API, Portal, Cedar...) are legitimately identical.
      return a === b && a.length > 12;
    });
    expect(same).toEqual([]);
  });
});
