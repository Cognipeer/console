#!/usr/bin/env node
/**
 * Ratchet for raw `fetch(` calls in the dashboard UI (src/app and src/components, not src/app/api, not tests).
 *
 * Screens read and write through `@/lib/api/client` helpers and React Query hooks (src/lib/api/queries); a raw
 * `fetch(` re-implements error handling by hand and misses the central 401 redirect. The count may only go down:
 * the script fails when it is above `count` in scripts/raw-fetch-baseline.json, and says so (without failing) when
 * it is below, so a branch that converts calls can lower the number and keep the gain.
 *
 * Files that need a raw `fetch` (streaming responses, upload progress, their own wrapper) are listed under
 * `allow` in the same file, with the reason; they are not counted.
 *
 *   npm run check:raw-fetch            # check
 *   npm run check:raw-fetch -- --write # store the current count as the baseline (after converting calls)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const baselineUrl = new URL('scripts/raw-fetch-baseline.json', root);
const baseline = JSON.parse(readFileSync(baselineUrl, 'utf8'));
const allowed = new Set(baseline.allow.map((entry) => entry.file));

const CALL = /(?<![\w$])fetch\(/g;

/** Source of a file without comments, so a mention of `fetch(` in a doc comment is not a call. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}

const files = execFileSync('git', ['ls-files', '--', 'src/app', 'src/components'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .filter((file) => !file.startsWith('src/app/api/') && !/(^|\/)__tests__\//.test(file) && !/\.test\.tsx?$/.test(file));

const perFile = [];
for (const file of files) {
  if (allowed.has(file)) continue;
  const count = (stripComments(readFileSync(new URL(file, root), 'utf8')).match(CALL) ?? []).length;
  if (count > 0) perFile.push({ file, count });
}
const total = perFile.reduce((sum, entry) => sum + entry.count, 0);

if (process.argv.includes('--write')) {
  writeFileSync(baselineUrl, `${JSON.stringify({ ...baseline, count: total }, null, 2)}\n`);
  console.log(`raw-fetch baseline set to ${total}`);
  process.exit(0);
}

if (total > baseline.count) {
  console.error(`Raw fetch( calls in src/app and src/components: ${total}, baseline ${baseline.count}.`);
  console.error('Use the helpers of @/lib/api/client (apiGet, apiPost, ...) with a React Query hook from src/lib/api/queries.');
  console.error('A call that must stay raw (a stream, an upload with progress) goes in "allow" of scripts/raw-fetch-baseline.json, with the reason.');
  console.error('Files with the most calls:');
  for (const { file, count } of [...perFile].sort((a, b) => b.count - a.count).slice(0, 15)) console.error(`  ${count}  ${file}`);
  process.exit(1);
}

console.log(`raw fetch( calls: ${total} (baseline ${baseline.count}), ${allowed.size} files allowed`);
if (total < baseline.count) console.log('Down from the baseline: run `npm run check:raw-fetch -- --write` to lower it.');
