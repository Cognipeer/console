/**
 * End-to-end smoke runner for Cognipeer Console.
 *
 * What it does, top to bottom:
 *   1. Points the process at an isolated SQLite data dir + in-memory cache/rate
 *      limiter so a run never touches developer data (env is set BEFORE any
 *      `@/`-aliased module is imported, since config is read at import time).
 *   2. Boots the real Fastify API over HTTP (`startSmokeServer`).
 *   3. Signs up a fresh tenant + owner via `/api/auth/register` (the same flow
 *      the UI sign-up form drives) and proves the session works.
 *   4. Runs every per-module suite (`./suites`) against the live server,
 *      reusing the registered cookie session.
 *   5. Prints a grouped summary and writes JSON + Markdown reports under
 *      `scripts/smoke/reports/`.
 *   6. Exits non-zero if any step failed.
 *
 * Usage:  npm run test:smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Environment isolation (must run before importing server/config) --------
const STAMP = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const dataDir = mkdtempSync(join(tmpdir(), 'cognipeer-smoke-'));

process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = dataDir;
process.env.MAIN_DB_NAME = 'smoke_main';
process.env.CACHE_PROVIDER = 'memory';
process.env.RATE_LIMIT_PROVIDER = 'memory';
process.env.JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : 'smoke-test-jwt-secret-please-ignore-0123456789';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';
// NODE_ENV is typed read-only by @types/node; assign through a cast.
(process.env as Record<string, string>).NODE_ENV =
  process.env.NODE_ENV ?? 'development';
// Built-in SQLite vector store writes here; keep it inside the throwaway dir.
process.env.SMOKE_VECTOR_DIR = join(dataDir, 'vectors');

import { SmokeClient } from './client';
import { suites, type SuiteContext } from './suites';

const REPORT_DIR = join(process.cwd(), 'scripts', 'smoke', 'reports');

interface RegisterResponse {
  tenant?: { slug?: string };
  user?: { email?: string };
}

async function main(): Promise<number> {
   
  console.log('▶ Cognipeer Console — end-to-end smoke test\n');
   
  console.log(`  data dir : ${dataDir}`);

  const { startSmokeServer } = await import('./server');
  const server = await startSmokeServer();
   
  console.log(`  base url : ${server.baseUrl}\n`);

  const client = new SmokeClient(server.baseUrl);
  const ctx: SuiteContext = { stamp: STAMP };
  let exitCode = 0;

  try {
    // --- 1. Public health endpoints (no auth) -------------------------------
    client.currentModule = 'health';
    await client.step('liveness', 'GET', '/api/health/live', [200]);
    await client.step('readiness', 'GET', '/api/health/ready', [200, 503]);

    // --- 2. Auth: unauthenticated request must be rejected -------------------
    client.currentModule = 'auth';
    const anon = new SmokeClient(server.baseUrl);
    anon.currentModule = 'auth';
    await anon.step('protected route without session → 401', 'GET', '/api/projects', [401]);
    client.results.push(...anon.results);

    // --- 3. Sign up a fresh tenant + owner (the UI sign-up flow) -------------
    const email = `owner-${STAMP}@smoke.test`;
    const password = 'SmokeTest!2024#Secure';
    const companyName = `Smoke Co ${STAMP}`;
    const register = await client.step<RegisterResponse>(
      'register tenant + owner',
      'POST',
      '/api/auth/register',
      [201],
      { body: { companyName, email, name: 'Smoke Owner', password } },
    );
    if (!register || !client.hasSession()) {
       
      console.error('\n✗ Registration failed — cannot continue. Aborting.\n');
      await server.close();
      writeReports(client, { aborted: true });
      return 1;
    }
    await client.step('session is authenticated', 'GET', '/api/auth/session', [200]);

    // Verify login works independently (fresh client, slug-less login).
    const loginClient = new SmokeClient(server.baseUrl);
    loginClient.currentModule = 'auth';
    await loginClient.step('login with credentials', 'POST', '/api/auth/login', [200], {
      body: { email, password },
    });
    await loginClient.step('wrong password → 401', 'POST', '/api/auth/login', [401], {
      body: { email, password: 'definitely-wrong' },
    });
    await loginClient.step('forgot-password (constant time)', 'POST', '/api/auth/forgot-password', [200], {
      body: { email, slug: register.body?.tenant?.slug ?? companyName },
    });
    client.results.push(...loginClient.results);

    // --- 4. Per-module suites ----------------------------------------------
    for (const suite of suites) {
      client.currentModule = suite.module;
       
      console.log(`\n— ${suite.module} —`);
      try {
        await suite.run(client, ctx);
      } catch (error) {
        client.results.push({
          module: suite.module,
          name: 'suite execution',
          method: '-',
          path: '-',
          expected: '-',
          actualStatus: null,
          status: 'fail',
          durationMs: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
         
        console.error(`  ✗ [${suite.module}] suite threw: ${String(error)}`);
      }
    }
  } finally {
    await server.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }

  exitCode = summarize(client) ? 0 : 1;
  writeReports(client, { aborted: false });
  return exitCode;
}

/** Print a grouped summary. Returns true if everything passed. */
function summarize(client: SmokeClient): boolean {
  const byModule = new Map<string, { pass: number; fail: number; skip: number }>();
  for (const r of client.results) {
    const entry = byModule.get(r.module) ?? { pass: 0, fail: 0, skip: 0 };
    entry[r.status] += 1;
    byModule.set(r.module, entry);
  }

  const total = client.results.length;
  const pass = client.results.filter((r) => r.status === 'pass').length;
  const fail = client.results.filter((r) => r.status === 'fail').length;
  const skip = client.results.filter((r) => r.status === 'skip').length;

   
  console.log('\n────────────────────────────────────────────');
   
  console.log('  SMOKE TEST SUMMARY');
   
  console.log('────────────────────────────────────────────');
  for (const [module, e] of byModule) {
    const flag = e.fail > 0 ? '✗' : '✓';
     
    console.log(
      `  ${flag} ${module.padEnd(22)} pass:${e.pass}  fail:${e.fail}  skip:${e.skip}`,
    );
  }
   
  console.log('────────────────────────────────────────────');
   
  console.log(`  TOTAL ${total}  |  PASS ${pass}  FAIL ${fail}  SKIP ${skip}`);
   
  console.log('────────────────────────────────────────────\n');

  if (fail > 0) {
     
    console.log('  Failures:');
    for (const r of client.results.filter((x) => x.status === 'fail')) {
       
      console.log(`   ✗ [${r.module}] ${r.name}: ${r.detail ?? 'failed'}`);
    }
     
    console.log('');
  }

  return fail === 0;
}

function writeReports(client: SmokeClient, meta: { aborted: boolean }): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  const pass = client.results.filter((r) => r.status === 'pass').length;
  const fail = client.results.filter((r) => r.status === 'fail').length;
  const skip = client.results.filter((r) => r.status === 'skip').length;

  const json = {
    generatedAt: new Date().toISOString(),
    aborted: meta.aborted,
    totals: { total: client.results.length, pass, fail, skip },
    results: client.results,
  };
  writeFileSync(join(REPORT_DIR, 'latest.json'), JSON.stringify(json, null, 2));

  const lines: string[] = [];
  lines.push('# Smoke Test Report');
  lines.push('');
  lines.push(`Generated: ${json.generatedAt}`);
  lines.push('');
  lines.push(`**Total ${json.totals.total} — Pass ${pass}, Fail ${fail}, Skip ${skip}**`);
  lines.push('');
  lines.push('| Module | Step | Method | Path | Expected | Got | Status |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of client.results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'skip' ? '⚪' : '❌';
    lines.push(
      `| ${r.module} | ${r.name} | ${r.method} | ${r.path} | ${r.expected} | ${
        r.actualStatus ?? '-'
      } | ${icon} ${r.status} |`,
    );
  }
  lines.push('');
  if (fail > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const r of client.results.filter((x) => x.status === 'fail')) {
      lines.push(`- **[${r.module}] ${r.name}** — ${r.detail ?? 'failed'}`);
    }
    lines.push('');
  }
  writeFileSync(join(REPORT_DIR, 'latest.md'), lines.join('\n'));

   
  console.log(`  Reports written to ${REPORT_DIR}/latest.{json,md}`);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
     
    console.error('Fatal smoke runner error:', error);
    process.exit(1);
  });
