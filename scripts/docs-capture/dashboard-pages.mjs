import { resolve } from 'node:path';
import { createSession } from './lib.mjs';

const OUT_ROOT = resolve(process.cwd(), 'docs/public/screenshots');

const targets = [
  { section: 'inference', name: '01-inference-monitoring', url: '/dashboard/inference-monitoring', signal: /Inference|Servers|Tokens|Sessions/i },
  { section: 'prompts', name: '01-prompts-list', url: '/dashboard/prompts', signal: /Prompts|Templates|Library|Catalog/i },
  { section: 'tracing', name: '01-tracing-overview', url: '/dashboard/tracing', signal: /Tracing|Agents|Sessions|Trace/i },
  { section: 'rag', name: '01-rag-list', url: '/dashboard/rag', signal: /RAG|Knowledge|Datasource|Indexing/i },
  { section: 'vector-stores', name: '01-vector-list', url: '/dashboard/vector', signal: /Vector|Index|Embedding|Search/i },
  { section: 'guardrails', name: '01-guardrails-list', url: '/dashboard/guardrails', signal: /Guardrails|Policy|Filter|Compliance/i },
  { section: 'memory', name: '01-memory-list', url: '/dashboard/memory', signal: /Memory|Stores|Items|Recall/i },
  { section: 'files', name: '01-files-list', url: '/dashboard/files', signal: /Files|Buckets|Storage|Document/i },
  { section: 'monitoring', name: '01-alerts-overview', url: '/dashboard/alerts', signal: /Alerts|Incidents|Threshold|Severity/i },
  { section: 'monitoring', name: '02-alerts-history', url: '/dashboard/alerts/history', signal: /History|Triggered|Resolved|Alert/i },
  { section: 'monitoring', name: '03-audit-log', url: '/dashboard/audit', signal: /Audit|Action|Resource|Actor/i },
  { section: 'monitoring', name: '04-license', url: '/dashboard/license', signal: /License|Plan|Features|Quota/i },
];

const sectionOutDirs = {};
for (const t of targets) {
  sectionOutDirs[t.section] = resolve(OUT_ROOT, t.section);
}

// Use first section's dir to bootstrap; createSession only needs an outDir.
const sess = await createSession({ outDir: sectionOutDirs[targets[0].section] });

for (const t of targets) {
  const out = sectionOutDirs[t.section];
  try {
    const file = await sess.shot(t.name, async ({ page, gotoStable }) => {
      await gotoStable(t.url);
      await page.waitForFunction(
        (re) => new RegExp(re, 'i').test(document.body.innerText || ''),
        t.signal.source,
        { timeout: 25_000 },
      ).catch(() => {});
      await page.waitForTimeout(900);
    });
    // Move the screenshot to its section dir (shot saves to the session's outDir).
    const path = await import('node:fs/promises');
    const sourcePath = resolve(sectionOutDirs[targets[0].section], `${t.name}.png`);
    if (out !== sectionOutDirs[targets[0].section]) {
      await path.mkdir(out, { recursive: true });
      await path.rename(sourcePath, resolve(out, `${t.name}.png`));
    }
  } catch (e) {
    console.log(`FAILED ${t.section}/${t.name}: ${e.message.slice(0, 120)}`);
  }
}

await sess.close();
console.log('dashboard pages capture done');
