/**
 * Every request of every workspace is decided by the policy engine from the
 * first request. What the product used to have around that is gone and stays
 * gone: workspace modes (legacy / shadow / enforce) and the switch, the shadow
 * recorder and its report, the kill switches, and the dry-run mode of a policy (a
 * policy is enabled or disabled). This pins the removal at the library surface and
 * in the source tree, so a leftover import or a revived switch fails loudly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as iam from '@/lib/iam';
import * as audit from '@/lib/iam/audit';
import * as auditFeed from '@/lib/iam/auditFeed';
import * as engine from '@/lib/iam/engine';
import * as enforce from '@/lib/iam/enforce';
import * as policyRows from '@/lib/iam/policyRows';
import * as principalCache from '@/lib/iam/principalCache';
import * as store from '@/lib/iam/store';

const ROOT = process.cwd();

const REMOVED: Record<string, { module: Record<string, unknown>; names: string[] }> = {
  '@/lib/iam (barrel)': {
    module: iam,
    names: ['AUTHZ_MODES', 'getAuthzMode', 'setAuthzMode', 'peekAuthzMode', 'resolveEnforcement', 'recordShadowEvent', 'listShadowEntries', 'summarizeShadowEntries'],
  },
  '@/lib/iam/enforce': {
    module: enforce,
    names: ['isEnforceKillSwitchOn', 'isShadowKillSwitchOn', 'getModeLookupStats'],
  },
  '@/lib/iam/engine': {
    module: engine,
    names: ['getAuthzMode', 'peekAuthzMode'],
  },
  '@/lib/iam/store': {
    module: store,
    names: ['getPolicyMonitorTotals', 'clearPolicyMonitorStats'],
  },
  '@/lib/iam/principalCache': {
    module: principalCache,
    names: ['resolveUserPrincipal', 'resolveTokenPrincipal'],
  },
  '@/lib/iam/policyRows': {
    module: policyRows,
    names: ['getPolicyMonitorTotals'],
  },
  '@/lib/iam/auditFeed': {
    module: auditFeed,
    names: ['monitor'],
  },
  '@/lib/iam/audit': {
    module: audit,
    names: ['IAM_MODE_CHANGE'],
  },
};

describe('the library no longer offers', () => {
  for (const [label, { module, names }] of Object.entries(REMOVED)) {
    it(`any mode, shadow or monitor API from ${label}`, () => {
      for (const name of names) expect(name in module, name).toBe(false);
    });
  }
});

describe('the source tree', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
  const sources = walk(join(ROOT, 'src'));

  it('has no shadow directory any more', () => {
    expect(existsSync(join(ROOT, 'src/lib/iam/shadow'))).toBe(false);
  });

  // Vitest does not type-check, and a module that fails to load only breaks the test files that import it: a leftover
  // import of the removed tree has to be caught by reading the sources, not by waiting for the build.
  it('imports nothing from the removed shadow tree and asks no workspace for a mode', () => {
    const importsShadow = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/shadow(?:\/[^'"]*)?['"]/;
    const offenders = sources.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return importsShadow.test(text) || /\bresolveEnforcement\b/.test(text);
    });
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('does not read the retired switches (IAM_ENFORCE_DISABLED, IAM_SHADOW_DISABLED, IAM_SHADOW_SAMPLE_RATE)', () => {
    const offenders = sources.filter((file) => /IAM_ENFORCE_DISABLED|IAM_SHADOW_DISABLED|IAM_SHADOW_SAMPLE_RATE/.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
    expect(sources.length).toBeGreaterThan(500); // (an empty scan would pass vacuously)
  });

  it('does not store a mode on a policy or ask for one', () => {
    const store = readFileSync(join(ROOT, 'src/lib/iam/store.ts'), 'utf8');
    expect(store).not.toMatch(/mode:\s*policy\.mode/);
    expect(store).not.toMatch(/export type IamPolicyMode/);
  });
});
