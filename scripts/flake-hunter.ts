#!/usr/bin/env tsx
/**
 * Flake hunter.
 *
 * Runs `vitest run` N times (default 3) and reports any test that succeeded in
 * one run and failed in another. Designed for CI nightly use; locally also
 * useful to confirm a fix for a suspected flake actually sticks.
 *
 * Why this and not vitest's built-in `--retry`? Retry hides flakes by passing
 * green on the second attempt. We want them visible so the team can fix the
 * root cause before they leak into PR cycles.
 *
 * Run via: `npm run test:flake` (defaults to 3 iterations)
 *   FLAKE_RUNS=5 npm run test:flake     # custom iteration count
 *   FLAKE_FILTER='src/__tests__/api'    # vitest path filter
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type RunResult = {
  passed: string[];
  failed: string[];
  duration: number;
};

type JsonReport = {
  testResults: Array<{
    assertionResults: Array<{
      fullName: string;
      status: 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';
    }>;
  }>;
};

const RUNS = Number(process.env.FLAKE_RUNS ?? '3');
const FILTER = process.env.FLAKE_FILTER ?? '';
const REPORT_PATH = path.resolve('.flake-report.json');

async function runOnce(idx: number): Promise<RunResult> {
  console.log(`\n── Run ${idx + 1}/${RUNS} ──`);
  const start = Date.now();
  const args = [
    'vitest',
    'run',
    '--reporter=json',
    `--outputFile=${REPORT_PATH}`,
  ];
  if (FILTER) args.push(FILTER);

  // We tolerate non-zero exit (failures are the whole point). Capture stdio to
  // avoid drowning the console with vitest's own output across N iterations.
  const result = spawnSync('npx', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === null) {
    throw new Error(`vitest invocation crashed: ${result.error?.message}`);
  }

  const text = await fs.readFile(REPORT_PATH, 'utf8');
  const report = JSON.parse(text) as JsonReport;
  const passed: string[] = [];
  const failed: string[] = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'passed') passed.push(t.fullName);
      else if (t.status === 'failed') failed.push(t.fullName);
    }
  }
  const duration = Date.now() - start;
  console.log(`  passed=${passed.length} failed=${failed.length} duration=${duration}ms`);
  return { passed, failed, duration };
}

async function main(): Promise<void> {
  if (!Number.isFinite(RUNS) || RUNS < 2) {
    console.error('FLAKE_RUNS must be ≥ 2');
    process.exit(2);
  }

  const results: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) {
    results.push(await runOnce(i));
  }

  // A flake = at least one pass and at least one fail across runs.
  const everSeen = new Set<string>();
  results.forEach((r) => {
    r.passed.forEach((n) => everSeen.add(n));
    r.failed.forEach((n) => everSeen.add(n));
  });

  const flaky: Array<{ name: string; passes: number; failures: number }> = [];
  for (const name of everSeen) {
    let passes = 0;
    let failures = 0;
    for (const r of results) {
      if (r.passed.includes(name)) passes += 1;
      if (r.failed.includes(name)) failures += 1;
    }
    if (passes > 0 && failures > 0) {
      flaky.push({ name, passes, failures });
    }
  }

  console.log('\n── Summary ──');
  console.log(`Total runs:         ${RUNS}`);
  console.log(`Avg duration:       ${Math.round(results.reduce((s, r) => s + r.duration, 0) / RUNS)}ms`);
  console.log(`Total unique tests: ${everSeen.size}`);
  console.log(`Flaky tests:        ${flaky.length}`);

  // Always-failing tests: also call those out separately so they're not lumped in.
  const alwaysFailing = [...everSeen].filter((n) =>
    results.every((r) => r.failed.includes(n)),
  );
  if (alwaysFailing.length > 0) {
    console.log(`Always failing:     ${alwaysFailing.length}`);
  }

  if (flaky.length === 0) {
    console.log('\n✓ No flakes detected.');
    if (alwaysFailing.length > 0) {
      console.log(`(Note: ${alwaysFailing.length} test(s) failed in every run — not flakes, but still broken.)`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.log('\n✗ Flaky tests:');
  for (const f of flaky.sort((a, b) => b.failures - a.failures)) {
    console.log(`  ${f.passes}/${RUNS} pass, ${f.failures}/${RUNS} fail   ${f.name}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('flake-hunter failed:', err);
  process.exit(2);
});
