/**
 * Read-only report: how much data the platform generates, per request
 * ("soru") and per user per day, across ALL request-generating collections
 * (LLM gateway, agent observability/tracing, MCP, tools, guardrails, RAG,
 * websearch, reranker, realtime) — not just gateway model usage.
 *
 * Uses the `collStats` command (metadata only, no collection scan) for row
 * counts + sizes wherever supported, falling back to estimatedDocumentCount
 * + a bounded $sample aggregation when it isn't. The only full(ish) scans are
 * bounded, indexed aggregations over `usage_daily` (indexed on
 * tenantId+userId+day) and a date-bounded aggregation over
 * `agent_tracing_sessions` (small: tracing is opt-in).
 *
 * Usage:
 *   npm run report:data-footprint                       # all tenants, last 30 days
 *   npm run report:data-footprint -- --days 7
 *   npm run report:data-footprint -- --tenant acme
 *   npm run report:data-footprint -- --skip-agent-daily  # skip the agent_tracing_sessions pass
 */
import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

interface CliArgs {
  days: number;
  tenant?: string;
  sleepMs: number;
  sampleSize: number;
  skipAgentDaily: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { days: 30, sleepMs: 50, sampleSize: 500, skipAgentDaily: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') {
      args.days = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days expects a positive integer');
      i += 1;
    } else if (arg === '--tenant') {
      args.tenant = argv[i + 1];
      if (!args.tenant) throw new Error('--tenant expects a tenant slug or dbName');
      i += 1;
    } else if (arg === '--sleep-ms') {
      args.sleepMs = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
    } else if (arg === '--sample-size') {
      args.sampleSize = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
    } else if (arg === '--skip-agent-daily') {
      args.skipAgentDaily = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface CategoryDef {
  key: string;
  label: string;
  collection: string;
  /** Counts toward the blended "per soru" (per-request) average. */
  isSoruUnit: boolean;
}

// Every collection that gets one document per user/system-initiated
// "request" somewhere in the platform. agent_tracing_events is the one
// exception left out of the blended soru average — it's the child rows of
// agent_tracing_sessions, so including both would double-count.
const CATEGORIES: CategoryDef[] = [
  { key: 'gateway', label: 'LLM Gateway (chat/embeddings/audio/OCR requests)', collection: 'model_usage_logs', isSoruUnit: true },
  { key: 'agent_sessions', label: 'Agent Observability — Sessions (opt-in tracing)', collection: 'agent_tracing_sessions', isSoruUnit: true },
  { key: 'agent_events', label: 'Agent Observability — Events (LLM/tool calls within sessions)', collection: 'agent_tracing_events', isSoruUnit: false },
  { key: 'mcp', label: 'MCP Tool Calls', collection: 'mcp_request_logs', isSoruUnit: true },
  { key: 'tools', label: 'Tool Calls', collection: 'tool_request_logs', isSoruUnit: true },
  { key: 'guardrails', label: 'Guardrail Evaluations', collection: 'guardrail_evaluation_logs', isSoruUnit: true },
  { key: 'rag', label: 'RAG Queries', collection: 'rag_query_logs', isSoruUnit: true },
  { key: 'websearch', label: 'Web Search Runs', collection: 'websearch_run_logs', isSoruUnit: true },
  { key: 'reranker', label: 'Reranker Runs', collection: 'reranker_run_logs', isSoruUnit: true },
  { key: 'realtime', label: 'Realtime Voice Sessions', collection: 'realtime_sessions', isSoruUnit: true },
];

interface CategoryTotals {
  count: number;
  totalBytes: number;
  tenantsWithData: number;
  estimated: boolean;
}

async function statsFor(
  tenantDb: import('mongodb').Db,
  collection: string,
  sampleSize: number,
): Promise<{ count: number; totalBytes: number; estimated: boolean } | null> {
  try {
    const stats = await tenantDb.command({ collStats: collection, scale: 1 });
    const count = typeof stats.count === 'number' ? stats.count : 0;
    if (count === 0) return null;
    const totalBytes = typeof stats.size === 'number' ? stats.size : 0;
    return { count, totalBytes, estimated: false };
  } catch (error: any) {
    // NamespaceNotFound (26) — tenant simply never wrote this collection.
    if (error?.code === 26 || /ns not found/i.test(String(error?.message))) return null;
    // Command unsupported on this Cosmos tier — fall back to a bounded sample.
    const coll = tenantDb.collection(collection);
    const count = await coll.estimatedDocumentCount().catch(() => 0);
    if (count === 0) return null;
    const n = Math.min(sampleSize, count);
    const sampled = await coll
      .aggregate([{ $sample: { size: n } }, { $group: { _id: null, avgSize: { $avg: { $bsonSize: '$$ROOT' } } } }])
      .maxTimeMS(30_000)
      .toArray()
      .catch(() => []);
    const avgSize = sampled[0]?.avgSize ?? 0;
    return { count, totalBytes: avgSize * count, estimated: true };
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const db = await getDatabase();
  const client = (db as { getClient?: () => import('mongodb').MongoClient | null }).getClient?.();
  if (!client) {
    console.error('Raw MongoClient not available — is DB_PROVIDER=mongodb?');
    return 1;
  }

  let tenants = await db.listTenants();
  if (args.tenant) {
    tenants = tenants.filter((t) => t.slug === args.tenant || t.dbName === args.tenant);
    if (tenants.length === 0) {
      console.error(`No tenant matched --tenant ${args.tenant}`);
      return 1;
    }
  }

  const cutoff = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  console.log(
    `Scanning ${tenants.length} tenant(s) across ${CATEGORIES.length} categories `
    + `(daily-average window: last ${args.days} day(s), cutoff ${cutoff.toISOString().slice(0, 10)})\n`,
  );

  const totals = new Map<string, CategoryTotals>(
    CATEGORIES.map((c) => [c.key, { count: 0, totalBytes: 0, tenantsWithData: 0, estimated: false }]),
  );

  for (const tenant of tenants) {
    const tdb = client.db(tenant.dbName);
    for (const cat of CATEGORIES) {
      const result = await statsFor(tdb, cat.collection, args.sampleSize);
      if (!result) continue;
      const acc = totals.get(cat.key)!;
      acc.count += result.count;
      acc.totalBytes += result.totalBytes;
      acc.tenantsWithData += 1;
      acc.estimated = acc.estimated || result.estimated;
    }
    await sleep(args.sleepMs);
  }

  // ── General view: rows + size per category ──────────────────────────
  console.log('── Data footprint by category (all-time, all tenants) ──────────────────────');
  console.log(
    `${'Category'.padEnd(58)} ${'Rows'.padStart(10)} ${'Avg/row'.padStart(10)} ${'Total size'.padStart(12)}`,
  );
  const sorted = [...CATEGORIES].sort((a, b) => totals.get(b.key)!.totalBytes - totals.get(a.key)!.totalBytes);
  for (const cat of sorted) {
    const t = totals.get(cat.key)!;
    if (t.count === 0) continue;
    const avg = t.totalBytes / t.count;
    const label = `${cat.label}${t.estimated ? ' (sampled est.)' : ''}`;
    console.log(
      `${label.padEnd(58)} ${t.count.toLocaleString().padStart(10)} ${fmtBytes(avg).padStart(10)} ${fmtBytes(t.totalBytes).padStart(12)}`,
    );
  }
  const grandCount = [...totals.values()].reduce((s, t) => s + t.count, 0);
  const grandBytes = [...totals.values()].reduce((s, t) => s + t.totalBytes, 0);
  console.log(`${'TOTAL'.padEnd(58)} ${grandCount.toLocaleString().padStart(10)} ${''.padStart(10)} ${fmtBytes(grandBytes).padStart(12)}`);

  // ── Blended "per soru" (per-request) average ─────────────────────────
  const soruCount = CATEGORIES.filter((c) => c.isSoruUnit).reduce((s, c) => s + totals.get(c.key)!.count, 0);
  const soruBytes = CATEGORIES.filter((c) => c.isSoruUnit).reduce((s, c) => s + totals.get(c.key)!.totalBytes, 0);
  const avgBytesPerSoru = soruCount > 0 ? soruBytes / soruCount : 0;
  console.log('\n── Soru başına ortalama üretilen veri (blended, all request-level categories) ──');
  console.log(`  ${soruCount.toLocaleString()} request(s) → avg ${fmtBytes(avgBytesPerSoru)} / request, total ${fmtBytes(soruBytes)}`);
  const eventsTotal = totals.get('agent_events')!;
  if (eventsTotal.count > 0) {
    console.log(
      `  (for reference — Agent Observability event-level, i.e. per LLM/tool call inside a traced session: `
      + `${eventsTotal.count.toLocaleString()} event(s) → avg ${fmtBytes(eventsTotal.totalBytes / eventsTotal.count)} / event)`,
    );
  }

  // ── Per-user daily average, blended across all services (usage_daily) ─
  console.log(`\n── Kullanıcı başına ortalama günlük üretilen veri (last ${args.days} day(s)) ──`);
  let totalUserDays = 0;
  let totalRequestsInWindow = 0;
  const distinctUsers = new Set<string>();
  const runInTenant = async (dbName: string, fn: () => Promise<void>) => {
    if (typeof db.runWithTenant === 'function') {
      await db.runWithTenant(dbName, fn);
    } else {
      await db.switchToTenant(dbName);
      await fn();
    }
  };
  for (const tenant of tenants) {
    await runInTenant(tenant.dbName, async () => {
      const rows = await db.listUsageDaily({ fromDay: cutoff.toISOString().slice(0, 10), limit: 200_000 });
      const byUserDay = new Map<string, number>();
      for (const row of rows) {
        if (!row.userId) continue;
        const key = `${row.userId} ${row.day}`;
        byUserDay.set(key, (byUserDay.get(key) ?? 0) + (row.requests ?? 0));
        distinctUsers.add(`${tenant.dbName} ${row.userId}`);
      }
      for (const reqs of byUserDay.values()) {
        totalUserDays += 1;
        totalRequestsInWindow += reqs;
      }
    });
    await sleep(args.sleepMs);
  }
  const avgRequestsPerUserPerDay = totalUserDays > 0 ? totalRequestsInWindow / totalUserDays : 0;
  const avgBytesPerUserPerDay = avgRequestsPerUserPerDay * avgBytesPerSoru;
  console.log(
    `  ${distinctUsers.size} distinct user(s), ${totalUserDays.toLocaleString()} user-day(s), `
    + `${totalRequestsInWindow.toLocaleString()} request(s) in window`,
  );
  console.log(`  avg requests/user/day = ${avgRequestsPerUserPerDay.toFixed(2)}`);
  console.log(
    `  avg data/user/day (blended, all services × overall avg bytes/request) = ${fmtBytes(avgBytesPerUserPerDay)}`,
  );

  // ── Agent-observability-specific per-user-daily (explicit ask) ───────
  if (!args.skipAgentDaily) {
    console.log('\n── Agent Observability — kullanıcı başına günlük veri (sessions, opt-in tracing) ──');
    let agentUserDays = 0;
    let agentSessionsInWindow = 0;
    let agentBytesInWindow = 0;
    const agentDistinctUsers = new Set<string>();
    for (const tenant of tenants) {
      const tdb = client.db(tenant.dbName);
      try {
        const rows = await tdb
          .collection('agent_tracing_sessions')
          .aggregate([
            { $match: { startedAt: { $gte: cutoff }, userId: { $exists: true, $ne: '' } } },
            {
              $group: {
                _id: { userId: '$userId', day: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt' } } },
                sessions: { $sum: 1 },
                bytes: { $sum: { $bsonSize: '$$ROOT' } },
              },
            },
          ])
          .maxTimeMS(30_000)
          .toArray();
        for (const row of rows) {
          agentUserDays += 1;
          agentSessionsInWindow += row.sessions;
          agentBytesInWindow += row.bytes;
          agentDistinctUsers.add(`${tenant.dbName} ${row._id.userId}`);
        }
      } catch (error: any) {
        if (error?.code !== 26) {
          console.warn(`   ! ${tenant.slug}: agent_tracing_sessions aggregation failed (${error?.message ?? error})`);
        }
      }
      await sleep(args.sleepMs);
    }
    if (agentUserDays === 0) {
      console.log('  No traced agent sessions with userId in this window (tracing is opt-in and off by default).');
    } else {
      const avgAgentSessionsPerUserPerDay = agentSessionsInWindow / agentUserDays;
      const avgAgentBytesPerUserPerDay = agentBytesInWindow / agentUserDays;
      console.log(
        `  ${agentDistinctUsers.size} distinct user(s), ${agentUserDays.toLocaleString()} user-day(s), `
        + `${agentSessionsInWindow.toLocaleString()} session(s) in window`,
      );
      console.log(`  avg sessions/user/day = ${avgAgentSessionsPerUserPerDay.toFixed(2)}`);
      console.log(`  avg data/user/day (agent tracing sessions only) = ${fmtBytes(avgAgentBytesPerUserPerDay)}`);
    }
  }

  await disconnectDatabase().catch(() => undefined);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
