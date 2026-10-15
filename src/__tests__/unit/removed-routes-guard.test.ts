/**
 * Nothing points at the pages that were removed. People, groups and API tokens
 * of others live in the IAM center; the old URLs exist only as redirects in the
 * Next config. This walks the sources and the docs so a stale link, component or
 * message cannot creep back in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

/** Files allowed to name the old routes: the redirects, this guard, the tests that assert their absence and the change logs. */
const ALLOWED = new Set([
  'next.config.mjs',
  'src/__tests__/unit/removed-routes-guard.test.ts',
  'src/__tests__/unit/next-config-redirects.test.ts',
  'src/__tests__/unit/nav-registry.test.ts',
  'src/__tests__/unit/iam-principals-ui.test.ts',
  'src/__tests__/unit/iam-directory-drawer.test.ts',
  'CHANGELOG.md',
  'docs/changelog.md',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|json|md|mdx|yaml|yml|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'docs'))]
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
  .filter((f) => !ALLOWED.has(f));

const sourceOf = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

function offenders(pattern: RegExp): string[] {
  return FILES.filter((file) => pattern.test(sourceOf(file)));
}

describe('removed routes and components', () => {
  it('scans a meaningful number of files', () => {
    expect(FILES.length).toBeGreaterThan(500);
  });

  it('no link to /dashboard/members or /dashboard/tenant-settings', () => {
    expect(offenders(/\/dashboard\/(members|tenant-settings)\b/)).toEqual([]);
  });

  it('no import or mention of the components that were replaced', () => {
    expect(offenders(/\b(UserManagement|GroupManagement|AddUserModal|ImportUsersModal)\b/)).toEqual([]);
  });

  it('no use of the member-page link builder or the old message namespaces', () => {
    expect(offenders(/iamLinks\.member\b|settings\.userManagement|settings\.addUserModal/)).toEqual([]);
  });

  it('no instruction or screenshot that sends a reader to the removed screens', () => {
    // These are menu paths and images, not URLs: the route checks above cannot see them.
    expect(offenders(/(Settings|Configure)\s*(→|->|>|&rarr;)\s*Members|Members\s*(→|->|>|&rarr;)\s*Groups|multi-tenancy\/02-members/)).toEqual([]);
  });

  it('the pages themselves are gone (a redirect lives in the config, not in a stub page)', () => {
    for (const gone of ['src/app/dashboard/members', 'src/app/dashboard/tenant-settings']) {
      expect(() => statSync(path.join(ROOT, gone))).toThrow();
    }
  });

  it('the breadcrumbs no longer name them', () => {
    const source = sourceOf('src/components/layout/DashboardBreadcrumbs.tsx');
    expect(source).not.toMatch(/'tenant-settings'|\bmembers:/);
    expect(source).toMatch(/account:/);
  });
});
