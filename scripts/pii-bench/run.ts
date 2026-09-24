/**
 * PII v2 local benchmark: measures the impact and performance of the new
 * dictionary (L2) and NER (L3) layers on top of the existing regex engine
 * (L1), directly at the detector-module level (no HTTP/DB layer — see the
 * report for why that's the right scope for this question).
 *
 * Usage:
 *   PII_NER_MODEL_PATH=.models-local node --import tsx scripts/pii-bench/run.ts [--skip-ner] [--quick]
 *
 * Writes a JSON results file next to this script and prints summary tables.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { detect, detectAsync } from '@/lib/services/pii/detector';
import { reloadConfig, getConfig } from '@/lib/core/config';
import type { PiiLanguage } from '@/lib/database';
import { CORPUS, type Sample } from './corpus';

// ── CLI flags ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const SKIP_NER = args.includes('--skip-ner') || !process.env.PII_NER_MODEL_PATH;
const QUICK = args.includes('--quick');

reloadConfig();
const appConfig = getConfig();
console.log(`[bench] PII_NER_MODEL_PATH=${appConfig.pii.nerModelPath || '(unset)'} skipNer=${SKIP_NER} quick=${QUICK}`);

// ── Shared policy-equivalent detector config for each mode ─────────────
const CATEGORIES = {
  email: true, phone: true, creditCard: true, iban: true, tc_kimlik: true,
  tr_phone: true, tr_iban: true, tr_vkn: true, tr_plaka: true, tr_passport: true,
  address_tr: true, birthDate: true, person: true, organization: true, location: true,
};

type Mode = 'pattern' | 'pattern+dictionary' | 'pattern+dictionary+ner';
const MODES: Mode[] = SKIP_NER ? ['pattern', 'pattern+dictionary'] : ['pattern', 'pattern+dictionary', 'pattern+dictionary+ner'];

function configFor(mode: Mode) {
  return {
    categories: CATEGORIES,
    languages: ['tr', 'en'] as PiiLanguage[],
    detection: { mode, ner: { timeoutMs: 3000 } },
  };
}

async function runOnce(text: string, mode: Mode) {
  if (mode === 'pattern') return detect(text, configFor(mode), 'detect');
  const { findings } = await detectAsync(text, configFor(mode), 'detect');
  return findings;
}

// ── Timing helpers ──────────────────────────────────────────────────────
function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(latencies: number[]) {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    meanMs: round(mean),
    p50Ms: round(percentile(sorted, 50)),
    p90Ms: round(percentile(sorted, 90)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function rssMb(): number {
  return round(process.memoryUsage().rss / (1024 * 1024));
}

// ── 1. Correctness / impact comparison ──────────────────────────────────
async function impactReport() {
  console.log('\n=== 1. Detection impact per sample (finding count by mode) ===');
  const rows: Record<string, unknown>[] = [];
  for (const sample of CORPUS) {
    const row: Record<string, unknown> = { id: sample.id, bucket: sample.bucket, chars: sample.text.length };
    for (const mode of MODES) {
      const findings = await runOnce(sample.text, mode);
      row[mode] = findings.length;
      row[`${mode}_categories`] = [...new Set(findings.map((f) => f.category))].sort().join(',');
    }
    rows.push(row);
  }
  console.table(rows);
  return rows;
}

// ── 2. Single-call latency per bucket, per mode ─────────────────────────
async function latencyReport() {
  console.log('\n=== 2. Single-call latency (ms) by mode × bucket ===');
  const iterations = QUICK ? 20 : 100;
  const results: Record<string, unknown>[] = [];
  for (const mode of MODES) {
    for (const bucket of ['short', 'medium', 'long'] as const) {
      const samples = CORPUS.filter((s) => s.bucket === bucket);
      if (samples.length === 0) continue;
      const latencies: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const sample = samples[i % samples.length];
        const t0 = nowMs();
        await runOnce(sample.text, mode);
        latencies.push(nowMs() - t0);
      }
      results.push({ mode, bucket, avgChars: Math.round(samples.reduce((a, s) => a + s.text.length, 0) / samples.length), ...summarize(latencies) });
    }
  }
  console.table(results);
  return results;
}

// ── 3. Concurrency / throughput ──────────────────────────────────────────
async function concurrencyReport() {
  console.log('\n=== 3. Throughput & latency under concurrency ===');
  const concurrencies = QUICK ? [1, 10] : [1, 5, 20, 50];
  const totalPerLevel = QUICK ? 40 : 150;
  const sample = CORPUS.find((s) => s.id === 'medium-tr-support-ticket')!;
  const results: Record<string, unknown>[] = [];

  for (const mode of MODES) {
    for (const concurrency of concurrencies) {
      const latencies: number[] = [];
      let completed = 0;
      const wallStart = nowMs();
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < totalPerLevel) {
          nextIndex += 1;
          const t0 = nowMs();
          await runOnce(sample.text, mode);
          latencies.push(nowMs() - t0);
          completed += 1;
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      const wallMs = nowMs() - wallStart;
      results.push({
        mode,
        concurrency,
        total: completed,
        wallMs: round(wallMs),
        reqPerSec: round((completed / wallMs) * 1000),
        ...summarize(latencies),
      });
    }
  }
  console.table(results);
  return results;
}

// ── 4. Sustained load (backpressure / memory over time) ─────────────────
async function sustainedLoadReport() {
  console.log('\n=== 4. Sustained load (fixed concurrency, ~12s) — latency & memory over time ===');
  const durationMs = QUICK ? 4000 : 12000;
  const concurrency = 20;
  const sample = CORPUS.find((s) => s.id === 'medium-tr-support-ticket')!;
  const results: Record<string, unknown>[] = [];

  for (const mode of MODES) {
    if (global.gc) global.gc();
    const startRss = rssMb();
    const buckets = new Map<number, number[]>(); // 2s bucket -> latencies
    let completed = 0;
    let errors = 0;
    const start = nowMs();
    const deadline = start + durationMs;
    // Wall-clock deadline, NOT a `setTimeout`-flipped boolean: with
    // `concurrency` workers chaining promises that resolve near-instantly
    // (the 'pattern' mode is sub-millisecond), the microtask queue never
    // empties long enough for the event loop to reach the timers phase —
    // a real starvation bug hit while building this script, not a
    // hypothetical one. `nowMs()` needs no timer to fire at all.
    async function worker() {
      while (nowMs() < deadline) {
        const t0 = nowMs();
        try {
          await runOnce(sample.text, mode);
        } catch {
          errors += 1;
        }
        const elapsed = t0 - start;
        const bucketKey = Math.floor(elapsed / 2000);
        const list = buckets.get(bucketKey) ?? [];
        list.push(nowMs() - t0);
        buckets.set(bucketKey, list);
        completed += 1;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const endRss = rssMb();

    const bucketRows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, lat]) => ({
      windowSec: `${k * 2}-${k * 2 + 2}`,
      count: lat.length,
      ...summarize(lat),
    }));
    console.log(`\n-- mode=${mode} concurrency=${concurrency} duration=${durationMs}ms --`);
    console.table(bucketRows);
    results.push({ mode, concurrency, completed, errors, startRssMb: startRss, endRssMb: endRss, deltaRssMb: round(endRss - startRss), buckets: bucketRows });
  }
  return results;
}

// ── 0. Cold vs warm NER call, and model memory footprint ────────────────
// MUST run before anything else touches 'pattern+dictionary+ner' mode —
// this is the only measurement that needs the model to genuinely be
// unloaded beforehand.
async function nerColdWarmReport() {
  if (SKIP_NER) return null;
  console.log('\n=== 0. NER cold-start vs warm, and memory footprint ===');
  const sample = CORPUS.find((s) => s.id === 'medium-tr-support-ticket')!;
  const beforeRss = rssMb();
  const t0 = nowMs();
  await runOnce(sample.text, 'pattern+dictionary+ner'); // first call = model load + first inference
  const coldMs = nowMs() - t0;
  const afterLoadRss = rssMb();

  const warmLatencies: number[] = [];
  for (let i = 0; i < (QUICK ? 10 : 50); i++) {
    const t1 = nowMs();
    await runOnce(sample.text, 'pattern+dictionary+ner');
    warmLatencies.push(nowMs() - t1);
  }
  const row = {
    beforeRssMb: beforeRss,
    afterModelLoadRssMb: afterLoadRss,
    modelFootprintMb: round(afterLoadRss - beforeRss),
    coldCallMs: round(coldMs),
    ...summarize(warmLatencies),
  };
  console.table([row]);
  return row;
}

async function main() {
  const startedAt = new Date(0).toISOString(); // placeholder; real timestamp stamped by caller/report, not here
  const nerColdWarm = await nerColdWarmReport(); // must run first — see its own comment
  const impact = await impactReport();
  const latency = await latencyReport();
  const concurrency = await concurrencyReport();
  const sustained = await sustainedLoadReport();

  const outPath = path.resolve(process.cwd(), 'scripts/pii-bench/results.json');
  writeFileSync(outPath, JSON.stringify({ startedAt, skipNer: SKIP_NER, quick: QUICK, impact, latency, nerColdWarm, concurrency, sustained }, null, 2));
  console.log(`\n[bench] wrote ${outPath}`);
}

main()
  .then(() => process.exit(0)) // onnxruntime-node's native thread pool otherwise keeps the process alive indefinitely after main() resolves
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
