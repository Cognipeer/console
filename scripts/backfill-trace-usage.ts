/**
 * Backfill trace-derived model usage into the `usage_daily` rollup.
 *
 * Trace ingestion started pricing agent observability usage (rows with
 * source 'tracing', agentKey = agentName) only from the deploy that shipped
 * `recordTraceModelUsage`. Sessions ingested BEFORE that carry token counts
 * in `agent_tracing_events` but never produced rollup rows — so the Cost →
 * Agents view shows nothing for historical agents. This script replays those
 * events: per (project, agent, model, UTC day) it sums tokens, prices them
 * with Model Hub pricing (hub key → hub modelId → external pricing catalog,
 * case-insensitive), and writes additive increments.
 *
 * Events whose metadata carries a gateway marker (gatewayRequestId /
 * consoleRequestId / gateway=true) are skipped — the models service already
 * accounted them at serving time. Unmatched models are written with cost 0
 * (tokens preserved) so they surface as "unpriced" on the Cost page.
 *
 * IDEMPOTENCY: increments are additive — running twice DOUBLES counters.
 * Before writing, a tenant's days that already have (source='tracing',
 * service='models') rows in the range are SKIPPED (logged). Pass --force to
 * write anyway (e.g. after manually deleting the rows).
 *
 * Usage:
 *   npm run backfill:trace-usage                                   # all tenants
 *   npm run backfill:trace-usage -- --tenant kamilco1
 *   npm run backfill:trace-usage -- --from 2026-01-01 --to 2026-06-30
 *   npm run backfill:trace-usage -- --dry-run                      # report only
 *   npm run backfill:trace-usage -- --tenant acme --sleep-ms 250   # Cosmos-friendly
 *
 * REPRICE MODE (--reprice): instead of scanning trace events, recompute
 * `costUsd` on EXISTING (source='tracing', service='models') rollup rows from
 * their stored token counts and the CURRENT pricing (hub → external catalog).
 * Applied as an additive costUsd delta, so it is safe next to live traffic and
 * idempotent while pricing stays unchanged. Flow: run the plain backfill →
 * enter prices on /dashboard/cost → run again with --reprice to price history.
 */
import { loadEnvConfig } from '@next/env';

// Config is read at import time — load env BEFORE any '@/'-aliased import.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

// 100 keeps each page inside one Mongo batch (default batchSize 101) — no
// getMore round-trip for Cosmos to time out (CursorNotFound, code 43).
const SESSION_PAGE_SIZE = 100;
const WRITE_CHUNK_SIZE = 200;
const EXISTING_ROWS_LIMIT = 100_000;

/** Retry transient Cosmos/Mongo errors (killed cursors, hiccups) with backoff. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`   retry ${attempt}/4 after error in ${label}: ${error instanceof Error ? error.message : error}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

interface CliArgs {
  from?: string;
  to?: string;
  tenant?: string;
  force: boolean;
  dryRun: boolean;
  /** Recompute costUsd on EXISTING tracing rows from current pricing. */
  reprice: boolean;
  /** Pause between session pages — keeps Cosmos RU consumption friendly. */
  sleepMs: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false, dryRun: false, reprice: false, sleepMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from' || arg === '--to') {
      const value = argv[i + 1] ?? '';
      if (!DAY_RE.test(value)) throw new Error(`${arg} expects a UTC day: YYYY-MM-DD`);
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
    } else if (arg === '--reprice') {
      args.reprice = true;
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

const GATEWAY_MARKER_KEYS = ['gatewayRequestId', 'consoleRequestId'] as const;

function isGatewayServed(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (metadata.gateway === true) return true;
  return GATEWAY_MARKER_KEYS.some(
    (key) => typeof metadata[key] === 'string' && (metadata[key] as string).length > 0,
  );
}

interface Bucket {
  projectId: string;
  agentKey: string;
  modelName: string;
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const { calculateCost } = await import('../src/lib/services/models/usageLogger');
  const db = await getDatabase();

  const fromDay = args.from;
  const toDay = args.to ?? utcDayOf(new Date());

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
      `Backfilling trace usage for ${tenants.length} tenant(s), `
      + `range ${fromDay ?? '(beginning)'} .. ${toDay}`
      + `${args.dryRun ? ' [dry-run]' : ''}${args.force ? ' [force]' : ''}\n`,
    );

    let grandRows = 0;

    for (const tenant of tenants) {
      const label = `${tenant.slug} (${tenant.dbName})`;
      console.log(`── Tenant ${label}`);

      const run = async () => {
        // Pricing resolution: hub key → hub modelId → external catalog.
        const models = await db.listModels({});
        const byKey = new Map(models.map((m) => [m.key.toLowerCase(), m]));
        const byModelId = new Map(models.map((m) => [m.modelId.toLowerCase(), m]));
        const externalEntries = await db.listExternalModelPricing();
        const externalByName = new Map(
          externalEntries
            .sort((a, b) => (a.projectId === '' ? -1 : 1) - (b.projectId === '' ? -1 : 1))
            .map((entry) => [entry.normalizedName, entry]),
        );
        const resolvePricing = (modelName: string) => {
          const lookup = modelName.toLowerCase();
          const hubModel = byKey.get(lookup) ?? byModelId.get(lookup);
          return { hubModel, pricing: hubModel?.pricing ?? externalByName.get(lookup)?.pricing };
        };

        if (args.reprice) {
          const rows = await db.listUsageDaily({
            source: 'tracing',
            service: 'models',
            fromDay,
            toDay,
            limit: EXISTING_ROWS_LIMIT,
          });
          const deltas = [];
          let unpricedRows = 0;
          for (const row of rows) {
            const { pricing } = resolvePricing(row.refKey ?? '');
            if (!pricing) {
              unpricedRows += 1;
              continue;
            }
            const newCost = calculateCost(pricing, {
              inputTokens: row.inputTokens ?? 0,
              outputTokens: row.outputTokens ?? 0,
              cachedInputTokens: row.cachedInputTokens ?? 0,
            }).totalCost;
            const delta = newCost - (row.costUsd ?? 0);
            if (Math.abs(delta) < 1e-9) continue;
            // costUsd-only additive delta; every other counter stays 0.
            deltas.push({
              tenantId: row.tenantId,
              projectId: row.projectId ?? '',
              userId: row.userId ?? '',
              apiTokenId: row.apiTokenId ?? '',
              actorType: row.actorType ?? '',
              source: row.source,
              service: row.service,
              refKey: row.refKey ?? '',
              agentKey: row.agentKey ?? '',
              day: row.day,
              costUsd: delta,
            });
          }
          const totalDelta = deltas.reduce((sum, row) => sum + row.costUsd, 0);
          console.log(
            `   [reprice] ${rows.length} tracing row(s) → ${deltas.length} to adjust `
            + `(Δ $${totalDelta.toFixed(4)}), ${unpricedRows} still unpriced`,
          );
          if (args.dryRun || deltas.length === 0) return;
          for (let i = 0; i < deltas.length; i += WRITE_CHUNK_SIZE) {
            await db.incrementUsageDaily(deltas.slice(i, i + WRITE_CHUNK_SIZE));
            await sleep(args.sleepMs);
          }
          grandRows += deltas.length;
          return;
        }

        const skipDays = new Set<string>();
        if (!args.force) {
          const existing = await db.listUsageDaily({
            source: 'tracing',
            service: 'models',
            fromDay,
            toDay,
            limit: EXISTING_ROWS_LIMIT,
          });
          for (const row of existing) skipDays.add(row.day);
          if (skipDays.size > 0) {
            console.log(
              `   ${skipDays.size} day(s) already have trace-usage rows — skipping them (use --force to write anyway)`,
            );
          }
        }

        const buckets = new Map<string, Bucket>();
        let sessionsScanned = 0;
        let eventsScanned = 0;
        let fastPathSessions = 0;
        let failedSessions = 0;
        let skip = 0;

        const addToBucket = (params: {
          projectId: string;
          agentKey: string;
          modelName: string;
          day: string;
          calls: number;
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
        }) => {
          if (fromDay && params.day < fromDay) return;
          if (params.day > toDay) return;
          if (skipDays.has(params.day)) return;
          if (
            params.inputTokens === 0 &&
            params.outputTokens === 0 &&
            params.cachedInputTokens === 0
          ) return;
          const id = [params.projectId, params.agentKey, params.modelName.toLowerCase(), params.day].join('\u0000');
          let bucket = buckets.get(id);
          if (!bucket) {
            bucket = {
              projectId: params.projectId,
              agentKey: params.agentKey,
              modelName: params.modelName,
              day: params.day,
              calls: 0,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
            };
            buckets.set(id, bucket);
          }
          bucket.calls += params.calls;
          bucket.inputTokens += params.inputTokens;
          bucket.outputTokens += params.outputTokens;
          bucket.cachedInputTokens += params.cachedInputTokens;
        };

        // Slow path: multi-model sessions need per-event attribution.
        const accountFromEvents = async (session: {
          sessionId: string;
          projectId?: string;
          agentName?: string;
        }) => {
          // Projection drops the heavy fields (sections, tool payloads) —
          // smaller batches keep Cosmos cursors alive under RU pressure.
          const events = await withRetry(
            `events(${session.sessionId})`,
            () => db.listAgentTracingEvents(session.sessionId, session.projectId, {
              projection: {
                model: 1,
                modelNames: 1,
                inputTokens: 1,
                outputTokens: 1,
                cachedInputTokens: 1,
                timestamp: 1,
                metadata: 1,
              },
            }),
          );
          for (const event of events) {
            eventsScanned += 1;
            const modelName =
              (typeof event.model === 'string' && event.model.length > 0
                ? event.model
                : event.modelNames?.find((n) => typeof n === 'string' && n.length > 0)) ?? '';
            if (!modelName) continue;
            if (isGatewayServed(event.metadata)) continue;
            addToBucket({
              projectId: session.projectId ?? '',
              agentKey: session.agentName ?? '',
              modelName,
              day: utcDayOf(event.timestamp ? new Date(event.timestamp) : new Date()),
              calls: 1,
              inputTokens: typeof event.inputTokens === 'number' ? event.inputTokens : 0,
              outputTokens: typeof event.outputTokens === 'number' ? event.outputTokens : 0,
              cachedInputTokens:
                typeof event.cachedInputTokens === 'number' ? event.cachedInputTokens : 0,
            });
          }
        };

        for (;;) {
          const { sessions } = await withRetry(`sessions(skip=${skip})`, () =>
            db.listAgentTracingSessions({
              limit: SESSION_PAGE_SIZE,
              skip,
              projection: {
                sessionId: 1,
                agentName: 1,
                projectId: 1,
                modelsUsed: 1,
                startedAt: 1,
                eventCounts: 1,
                totalInputTokens: 1,
                totalOutputTokens: 1,
                totalCachedInputTokens: 1,
              },
            }),
          );
          if (sessions.length === 0) break;
          skip += sessions.length;
          await sleep(args.sleepMs);

          // FAST PATH: a single-model session is fully described by its own
          // totals — no event fetch. (Historical sessions predate gateway
          // markers, so token-level marker checks don't apply to them.)
          const needEvents: typeof sessions = [];
          for (const session of sessions) {
            sessionsScanned += 1;
            const models = (session.modelsUsed ?? []).filter(
              (name) => typeof name === 'string' && name.length > 0,
            );
            const totalTokens =
              (session.totalInputTokens ?? 0)
              + (session.totalOutputTokens ?? 0)
              + (session.totalCachedInputTokens ?? 0);
            if (models.length === 1 && totalTokens > 0) {
              fastPathSessions += 1;
              addToBucket({
                projectId: session.projectId ?? '',
                agentKey: session.agentName ?? '',
                modelName: models[0],
                day: utcDayOf(session.startedAt ? new Date(session.startedAt) : new Date()),
                calls: session.eventCounts?.ai_call ?? 1,
                inputTokens: session.totalInputTokens ?? 0,
                outputTokens: session.totalOutputTokens ?? 0,
                cachedInputTokens: session.totalCachedInputTokens ?? 0,
              });
            } else if (models.length > 0 && totalTokens > 0) {
              needEvents.push(session);
            }
          }

          // Multi-model sessions: fetch events with LOW concurrency — Cosmos
          // kills cursors under RU pressure. A session that still fails after
          // retries is skipped (and reported), never fatal to the run.
          const CONCURRENCY = 2;
          for (let i = 0; i < needEvents.length; i += CONCURRENCY) {
            await Promise.all(
              needEvents.slice(i, i + CONCURRENCY).map(async (session) => {
                try {
                  await accountFromEvents(session);
                } catch (error) {
                  failedSessions += 1;
                  console.warn(
                    `   ! skipping session ${session.sessionId} (events unreadable: ${error instanceof Error ? error.message : error})`,
                  );
                }
              }),
            );
          }

          if (sessionsScanned % 1000 < SESSION_PAGE_SIZE) {
            console.log(
              `   … ${sessionsScanned} sessions scanned (${fastPathSessions} fast-path, ${eventsScanned} events read)`,
            );
          }
        }

        const increments = [...buckets.values()].map((bucket) => {
          const { hubModel, pricing } = resolvePricing(bucket.modelName);
          const costUsd = pricing
            ? calculateCost(pricing, {
                inputTokens: bucket.inputTokens,
                outputTokens: bucket.outputTokens,
                cachedInputTokens: bucket.cachedInputTokens,
              }).totalCost
            : 0;
          return {
            tenantId: String(tenant._id),
            projectId: bucket.projectId,
            userId: '',
            apiTokenId: '',
            actorType: '',
            source: 'tracing',
            service: 'models',
            refKey: hubModel?.key ?? bucket.modelName,
            agentKey: bucket.agentKey,
            day: bucket.day,
            requests: bucket.calls,
            inputTokens: bucket.inputTokens,
            outputTokens: bucket.outputTokens,
            cachedInputTokens: bucket.cachedInputTokens,
            totalTokens: bucket.inputTokens + bucket.outputTokens + bucket.cachedInputTokens,
            costUsd,
            units: { modelCalls: bucket.calls },
          };
        });

        const totalCost = increments.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
        console.log(
          `   sessions ${sessionsScanned} (${fastPathSessions} fast-path`
          + `${failedSessions > 0 ? `, ${failedSessions} skipped-unreadable` : ''}), events ${eventsScanned} → `
          + `${increments.length} rollup row(s), cost $${totalCost.toFixed(4)}`,
        );
        const unpriced = increments.filter((row) => row.costUsd === 0 && (row.totalTokens ?? 0) > 0);
        if (unpriced.length > 0) {
          const names = [...new Set(unpriced.map((row) => row.refKey))];
          console.log(
            `   ⚠ ${names.length} model(s) have no pricing (cost written as 0): ${names.join(', ')}`
            + `\n     → add reference prices on /dashboard/cost, then re-run with --force after deleting the rows, or leave history unpriced.`,
          );
        }

        if (args.dryRun || increments.length === 0) return;

        for (let i = 0; i < increments.length; i += WRITE_CHUNK_SIZE) {
          await db.incrementUsageDaily(increments.slice(i, i + WRITE_CHUNK_SIZE));
        }
        grandRows += increments.length;
      };

      if (typeof db.runWithTenant === 'function') {
        await db.runWithTenant(tenant.dbName, run);
      } else {
        await db.switchToTenant(tenant.dbName);
        await run();
      }
      console.log('');
    }

    console.log(`Done. ${grandRows} rollup row(s) written${args.dryRun ? ' (dry-run: 0 by definition)' : ''}.`);
    return 0;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
