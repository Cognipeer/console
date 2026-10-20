/**
 * What the docs tooling generates stays out of the repository and out of the lint run.
 *
 * VitePress writes its dependency cache to `.vitepress/cache` of the directory it was started from: `docs/` for the
 * `npm run docs:*` scripts, the repository root for a run started there by hand. `npm run lint` lints every file the
 * ESLint config does not ignore (dot-directories included), so a cache it does not ignore turns the lint check red,
 * and one that git does not ignore ends up in a commit.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

/** Generated paths of a run started at the repository root, and of one started in `docs/`. */
const GENERATED = [
  '.vitepress/cache/deps/vue.js',
  '.vitepress/dist/index.html',
  'docs/.vitepress/cache/deps/vue.js',
  'docs/.vitepress/dist/index.html',
];

const insideGitCheckout = (() => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** `git check-ignore` exits with 0 when a rule ignores the path (whether or not the path is tracked: `--no-index`). */
function gitIgnores(file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', file], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('generated VitePress output', () => {
  it('is not linted, wherever VitePress was started', async () => {
    const eslint = new ESLint({ cwd: root });

    for (const file of GENERATED) {
      expect(await eslint.isPathIgnored(path.join(root, file)), file).toBe(true);
    }
    // Source is still linted: the rule is about the generated directory, not about everything under a dot-directory.
    expect(await eslint.isPathIgnored(path.join(root, 'src/lib/core/logger.ts'))).toBe(false);
  });

  it.skipIf(!insideGitCheckout)('is ignored by git, wherever VitePress was started', () => {
    for (const file of GENERATED) {
      expect(gitIgnores(file), file).toBe(true);
    }
    expect(gitIgnores('src/lib/core/logger.ts')).toBe(false);
  });
});
