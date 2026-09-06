#!/usr/bin/env tsx
/**
 * Endpoint coverage gate.
 *
 * Scans every Fastify route in `src/server/api/plugins/**` and verifies that
 * at least one test file under `src/__tests__/api/**` references the route's
 * HTTP method + path. Exits non-zero if any route is unreferenced.
 *
 * Intentionally lenient — it does not parse route schemas or enforce specific
 * assertions; the goal is to make "I added a new endpoint and forgot to test
 * it" caught at PR time instead of in production.
 *
 * Run via: `npm run check:endpoints`
 * Skip a route by adding `// @test-skip: reason` on the line above it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'src/server/api/plugins');
const TESTS_DIR = path.join(ROOT, 'src/__tests__/api');
const BASELINE_PATH = path.join(__dirname, 'endpoint-coverage.baseline.json');

/**
 * Baseline file format:
 *   { allowedUncovered: ["GET /foo", "POST /bar"], note: "..." }
 *
 * The baseline freezes known gaps. A new uncovered route NOT in this list
 * fails the gate. A baseline entry that has since gained coverage prints a
 * warning so the team can ratchet the list down over time.
 */
type Baseline = { allowedUncovered: string[]; note?: string };

async function loadBaseline(): Promise<Baseline> {
  try {
    const text = await fs.readFile(BASELINE_PATH, 'utf8');
    return JSON.parse(text) as Baseline;
  } catch {
    return { allowedUncovered: [] };
  }
}

function routeKey(r: { method: string; pathPattern: string }): string {
  return `${r.method} ${r.pathPattern}`;
}

type Route = {
  method: string;
  pathPattern: string;
  file: string;
  line: number;
};

const ROUTE_RE = /app\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/;
const SKIP_RE = /@test-skip/;

async function walk(dir: string, exts: string[]): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, exts)));
    else if (exts.some((ext) => e.name.endsWith(ext))) out.push(full);
  }
  return out;
}

async function extractRoutes(): Promise<Route[]> {
  const files = await walk(PLUGINS_DIR, ['.ts']);
  const routes: Route[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(ROUTE_RE);
      if (!m) continue;
      const prev = lines[i - 1] ?? '';
      if (SKIP_RE.test(prev)) continue;
      routes.push({
        method: m[1].toUpperCase(),
        pathPattern: m[2],
        file: path.relative(ROOT, file),
        line: i + 1,
      });
    }
  }
  return routes;
}

/** Tokenize a route path so `:agentId` matches tests that hit `/agents/123`. */
function pathFragments(pathPattern: string): string[] {
  return pathPattern
    .split('/')
    .filter(Boolean)
    .filter((seg) => !seg.startsWith(':'));
}

async function loadTestFiles(): Promise<string[]> {
  const files = await walk(TESTS_DIR, ['.ts']);
  return Promise.all(files.map((f) => fs.readFile(f, 'utf8')));
}

/**
 * Path-and-method must both appear in the SAME test file. Concatenating every
 * test file into one haystack (the previous approach) let an unrelated test
 * "cover" a route just because some other file happened to share a path
 * fragment, and never checked the HTTP method at all — a GET-only test for
 * `/agents/:id` counted as coverage for `DELETE /agents/:id` too. Still cheap
 * regex/substring work, no route-schema parsing, per the file's own design
 * goal — just checked per-file and method-aware instead of globally and
 * method-blind.
 *
 * The method check is a whole-word search for the literal method name
 * (`POST`, `GET`, ...), which matches both styles this repo's tests use:
 * `app.inject({ method: 'POST', ... })` for a live Fastify plugin, and
 * `import { POST } from '.../route'` for the legacy Next.js route handlers —
 * both spell the method as that literal uppercase word somewhere in the file.
 */
function isReferenced(route: Route, testFiles: string[]): boolean {
  const frags = pathFragments(route.pathPattern);
  const methodRe = new RegExp(`\\b${route.method}\\b`);

  return testFiles.some((text) => {
    const pathMatches = text.includes(route.pathPattern)
      || (frags.length > 0 && frags.every((f) => text.includes('/' + f)));
    return pathMatches && methodRe.test(text);
  });
}

async function main(): Promise<void> {
  const [routes, testFiles, baseline] = await Promise.all([
    extractRoutes(),
    loadTestFiles(),
    loadBaseline(),
  ]);

  const baselineSet = new Set(baseline.allowedUncovered);

  const missing: Route[] = [];
  for (const r of routes) {
    if (!isReferenced(r, testFiles)) missing.push(r);
  }
  const missingKeys = new Set(missing.map(routeKey));

  const newGaps = missing.filter((r) => !baselineSet.has(routeKey(r)));
  const closedBaselineEntries = [...baselineSet].filter((k) => !missingKeys.has(k));

  console.log(`Scanned ${routes.length} routes in ${PLUGINS_DIR.replace(ROOT + '/', '')}`);
  console.log(`Covered:   ${routes.length - missing.length}`);
  console.log(`Uncovered: ${missing.length}  (baseline tolerates ${baselineSet.size})`);
  console.log('');

  if (closedBaselineEntries.length > 0) {
    console.log(`✓ ${closedBaselineEntries.length} baseline entry/entries now covered — ratchet the baseline:`);
    for (const k of closedBaselineEntries.slice(0, 20)) console.log(`    ${k}`);
    if (closedBaselineEntries.length > 20) console.log(`    … and ${closedBaselineEntries.length - 20} more`);
    console.log('');
  }

  if (newGaps.length === 0) {
    console.log('✓ No new uncovered routes vs. baseline.');
    process.exit(0);
  }

  console.error(`✗ ${newGaps.length} new uncovered route(s) (not in baseline):`);
  for (const r of newGaps) {
    console.error(`  ${r.method.padEnd(6)} ${r.pathPattern}    (${r.file}:${r.line})`);
  }
  console.error('');
  console.error('Add a test under src/__tests__/api/ that references this route,');
  console.error('annotate with `// @test-skip: <reason>` above the route,');
  console.error('or add it to scripts/endpoint-coverage.baseline.json (only if intentional).');
  process.exit(1);
}

main().catch((err) => {
  console.error('check-endpoint-coverage failed:', err);
  process.exit(2);
});
