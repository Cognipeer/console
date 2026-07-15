/**
 * Backfill the cross-service `usage_daily` rollup from raw model usage logs.
 *
 * For every tenant (or one via --tenant), pages through `model_usage_logs`
 * per model, aggregates by (projectId, modelKey, UTC day) and writes rows via
 * `db.incrementUsageDaily` with EMPTY attribution dimensions (userId '',
 * apiTokenId '', actorType '', source '') — raw logs written before the
 * rollup deploy carry no attribution, so backfilled traffic surfaces as the
 * "unattributed / legacy" bucket in breakdowns.
 *
 * IDEMPOTENCY: `incrementUsageDaily` is additive — running the backfill twice
 * for the same range DOUBLES the counters. Before writing a tenant's rows the
 * script lists existing usage_daily rows with userId='' AND source='' AND
 * service='models' in the day range and SKIPS those days (logged). Pass
 * --force to write anyway (e.g. after manually deleting backfilled rows).
 *
 * Reads the same .env as the server (DB_PROVIDER, MONGODB_URI /
 * SQLITE_DATA_DIR, MAIN_DB_NAME) — run from the project root against the
 * deployment you want to backfill.
 *
 * Usage:
 *   npm run backfill:usage-daily                                  # everything, all tenants
 *   npm run backfill:usage-daily -- --from 2026-01-01 --to 2026-06-30
 *   npm run backfill:usage-daily -- --tenant acme --sleep-ms 250  # Cosmos-friendly
 *   npm run backfill:usage-daily -- --dry-run                     # report only, no writes
 *   npm run backfill:usage-daily -- --force                       # skip the already-backfilled check
 */
import { loadEnvConfig } from '@next/env';

// Config is read at import time — load env BEFORE any '@/'-aliased import.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

const LOG_PAGE_SIZE = 200; // listModelUsageLogs caps limit at 200
const WRITE_CHUNK_SIZE = 200;
const EXISTING_ROWS_LIMIT = 100_000;

interface CliArgs {
  from?: string;
  to?: string;
  tenant?: string;
  force: boolean;
  dryRun: boolean;
  sleepMs: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false, dryRun: false, sleepMs: 0 };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from' || arg === '--to') {
      const value = argv[i + 1] ?? '';
      if (!DAY_RE.test(value)) {
        throw new Error(`${arg} expects a UTC day: YYYY-MM-DD`);
      }
      if (arg === '--from') args.from = value;
      else args.to = value;
      i += 1;
    } else if (arg === '--tenant') {
      args.tenant = argv[i + 1];
      if (!args.tenant) throw new Error('--tenant expects a tenant slug or dbName');
      i += 1;
    } else if (arg === '--sleep-ms') {
      args.sleepMs = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(args.sleepMs) || args.sleepMs < 0) {
        throw new Error('--sleep-ms expects a non-negative integer');
      }
      i += 1;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface DayBucket {
  projectId: string;
  modelKey: string;
  day: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMsSum: number;
  latencyCount: number;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const db = await getDatabase();

  // Bound the raw-log scan. `to` defaults to script start so pages stay
  // stable while new logs keep arriving at the head of the sort.
  const fromDate = args.from ? new Date(`${args.from}T00:00:00.000Z`) : undefined;
  const toDate = args.to ? new Date(`${args.to}T23:59:59.999Z`) : new Date();
  const fromDay = args.from;
  const toDay = utcDayOf(toDate);

  try {
    let tenants = await db.listTenants();
    if (args.tenant) {
      tenants = tenants.filter(
        (tenant) => tenant.slug === args.tenant || tenant.dbName === args.tenant,
      );
      if (tenants.length === 0) {
        console.error(`No tenant matched --tenant ${args.tenant}`);
        return 1;
      }
    }

    console.log(
      `Backfilling usage_daily for ${tenants.length} tenant(s), `
      + `range ${fromDay ?? '(beginning)'} .. ${toDay}`
      + `${args.dryRun ? ' [dry-run]' : ''}${args.force ? ' [force]' : ''}\n`,
    );

    let grandTotalRows = 0;
    let grandSkippedDays = 0;

    for (const tenant of tenants) {
      const label = `${tenant.slug} (${tenant.dbName})`;
      console.log(`── Tenant ${label}`);

      const run = async () => {
        // Days already covered by a previous backfill run: rows with empty
        // attribution AND empty source are (in practice) backfill-authored.
        const skipDays = new Set<string>();
        if (!args.force) {
          const existing = await db.listUsageDaily({
            userId: '',
            source: '',
            service: 'models',
            fromDay,
            toDay,
            limit: EXISTING_ROWS_LIMIT,
          });
          for (const row of existing) skipDays.add(row.day);
          if (skipDays.size > 0) {
            console.log(
              `   ${skipDays.size} day(s) already have backfilled rows — skipping them `
              + '(use --force to re-write; WARNING: force doubles counters for existing days)',
            );
          }
        }

        const models = await db.listModels();
        console.log(`   ${models.length} model(s)`);

        // (projectId, modelKey, day) → counters
        const buckets = new Map<string, DayBucket>();
        for (const model of models) {
          let skip = 0;
          for (;;) {
            const logs = await db.listModelUsageLogs(model.key, {
              limit: LOG_PAGE_SIZE,
              skip,
              from: fromDate,
              to: toDate,
            });
            for (const log of logs) {
              if (!log.createdAt) continue;
              const day = utcDayOf(new Date(log.createdAt));
              const projectId = log.projectId ? String(log.projectId) : '';
              const key = `${projectId}\u0000${model.key}\u0000${day}`;
              const bucket = buckets.get(key) ?? {
                projectId,
                modelKey: model.key,
                day,
                requests: 0,
                errors: 0,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 0,
                costUsd: 0,
                latencyMsSum: 0,
                latencyCount: 0,
              };
              bucket.requests += 1;
              if (log.status === 'error') bucket.errors += 1;
              bucket.inputTokens += log.inputTokens ?? 0;
              bucket.outputTokens += log.outputTokens ?? 0;
              bucket.cachedInputTokens += log.cachedInputTokens ?? 0;
              bucket.totalTokens += log.totalTokens ?? 0;
              bucket.costUsd += log.pricingSnapshot?.totalCost ?? 0;
              if (typeof log.latencyMs === 'number') {
                bucket.latencyMsSum += log.latencyMs;
                bucket.latencyCount += 1;
              }
              buckets.set(key, bucket);
            }
            if (logs.length < LOG_PAGE_SIZE) break;
            skip += LOG_PAGE_SIZE;
            await sleep(args.sleepMs);
          }
        }

        const allRows = [...buckets.values()];
        const skippedRows = allRows.filter((row) => skipDays.has(row.day));
        const rows = allRows
          .filter((row) => !skipDays.has(row.day))
          .map((row) => ({
            tenantId: tenant._id ? String(tenant._id) : '',
            projectId: row.projectId,
            userId: '',
            apiTokenId: '',
            actorType: '',
            source: '',
            service: 'models',
            refKey: row.modelKey,
            day: row.day,
            requests: row.requests,
            errors: row.errors,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokens: row.cachedInputTokens,
            totalTokens: row.totalTokens,
            costUsd: row.costUsd,
            latencyMsSum: row.latencyMsSum,
            latencyCount: row.latencyCount,
          }));

        if (skippedRows.length > 0) {
          console.log(`   skipped ${skippedRows.length} row(s) on already-backfilled days`);
        }
        grandSkippedDays += skipDays.size;

        if (rows.length === 0) {
          console.log('   nothing to write\n');
          return;
        }

        if (args.dryRun) {
          console.log(`   [dry-run] would write ${rows.length} usage_daily row(s)\n`);
          return;
        }

        for (let offset = 0; offset < rows.length; offset += WRITE_CHUNK_SIZE) {
          await db.incrementUsageDaily(rows.slice(offset, offset + WRITE_CHUNK_SIZE));
          await sleep(args.sleepMs);
        }
        grandTotalRows += rows.length;
        console.log(`   wrote ${rows.length} usage_daily row(s)\n`);
      };

      if (db.runWithTenant) {
        await db.runWithTenant(tenant.dbName, run);
      } else {
        await db.switchToTenant(tenant.dbName);
        await run();
      }

      await sleep(args.sleepMs);
    }

    console.log(
      `Done. Wrote ${grandTotalRows} row(s)`
      + `${grandSkippedDays > 0 ? `, skipped ${grandSkippedDays} already-backfilled day(s)` : ''}.`,
    );
    return 0;
  } finally {
    await disconnectDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Backfill failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
