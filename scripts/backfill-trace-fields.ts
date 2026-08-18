/**
 * Backfill `finishReason` / `reasoningTokens` from legacy `metadata` JSON
 * into their first-class columns on already-stored tracing data.
 *
 * `IAgentTracingEvent.finishReason` / `.reasoningTokens` used to live only
 * inside each event's free-form `metadata` blob (under a handful of
 * provider-specific key spellings). They are now persisted columns
 * (`agent_tracing_events.finishReason` / `.reasoningTokens`), populated by
 * ingest going forward. Events written BEFORE that change still carry the
 * value only in `metadata` — this script moves it into the column and
 * strips the now-redundant metadata key(s), then recomputes the owning
 * session's `totalReasoningTokens` / `truncatedEvents` roll-ups from the
 * corrected events.
 *
 * Recognized legacy metadata keys (checked in this order, first match
 * wins): `finishReason`, `finish_reason`, `stop_reason`, `finishReasons`
 * (array or comma-separated string — first entry is used). The value is run
 * through `normalizeFinishReason` before being persisted, same as ingest.
 * `metadata.reasoningTokens` is migrated only when it is a finite number > 0
 * (a stored 0/negative/non-numeric value is left alone — nothing meaningful
 * to move).
 *
 * Tracing events are otherwise write-once — ingest creates them and nothing
 * else mutates them — so per-event writes here go through the narrow,
 * migration-only `DatabaseProvider.updateAgentTracingEvent` primitive, which
 * accepts only `finishReason` / `reasoningTokens` / `metadata`. Session-level
 * `totalReasoningTokens` / `truncatedEvents` roll-ups are recomputed through
 * the existing `updateAgentTracingSession`.
 *
 * IDEMPOTENT: an event is only ever touched when its column is still empty
 * AND a legacy metadata key still carries a value — once migrated (or once
 * there was nothing to migrate), re-running finds nothing to do. Session
 * totals are recomputed (not incremented), so re-running is a no-op once
 * correct.
 *
 * Usage:
 *   npm run backfill:trace-fields                                    # all tenants
 *   npm run backfill:trace-fields -- --tenant kamilco1
 *   npm run backfill:trace-fields -- --from 2026-01-01 --to 2026-06-30
 *   npm run backfill:trace-fields -- --dry-run                       # report only
 *   npm run backfill:trace-fields -- --tenant acme --sleep-ms 250    # Cosmos-friendly
 */
import { loadEnvConfig } from '@next/env';

// Config is read at import time — load env BEFORE any '@/'-aliased import.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

import { isTruncatedFinishReason, normalizeFinishReason } from '../src/lib/shared/finishReason';
import type { IAgentTracingEvent, IAgentTracingSession } from '../src/lib/database';

const SESSION_PAGE_SIZE = 100;
const EVENT_FETCH_CONCURRENCY = 2;

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
  dryRun: boolean;
  sleepMs: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, sleepMs: 0 };
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
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Backfill finishReason/reasoningTokens from tracing event metadata into their columns.

Usage:
  npm run backfill:trace-fields -- [options]

Options:
  --tenant <slug|dbName>   Only this tenant (default: all tenants)
  --from <YYYY-MM-DD>      Only sessions started on/after this UTC day
  --to <YYYY-MM-DD>        Only sessions started on/before this UTC day
  --sleep-ms <n>           Pause between session pages (Cosmos-friendly)
  --dry-run                Report what would change; write nothing
  --help                   Show this help
`);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Legacy metadata key spellings, checked in this priority order.
const FINISH_REASON_KEYS = ['finishReason', 'finish_reason', 'stop_reason', 'finishReasons'] as const;
const REASONING_TOKENS_KEY = 'reasoningTokens';

function firstStringFromFinishReasons(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === 'string' && v.trim().length > 0);
    return typeof first === 'string' ? first : undefined;
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',')[0]?.trim();
  }
  return undefined;
}

interface EventPatch {
  finishReason?: string;
  reasoningTokens?: number;
  metadata: Record<string, unknown>;
  removedKeys: string[];
}

/**
 * Computes the column values an event's metadata implies, if its columns
 * are still empty. Returns `null` when there is nothing to migrate.
 */
function computeEventPatch(event: IAgentTracingEvent): EventPatch | null {
  const metadata = event.metadata ?? {};
  const nextMetadata: Record<string, unknown> = { ...metadata };
  const removedKeys: string[] = [];
  let finishReason: string | undefined;
  let reasoningTokens: number | undefined;

  if (!event.finishReason) {
    for (const key of FINISH_REASON_KEYS) {
      if (!(key in metadata)) continue;
      const raw = metadata[key];
      const candidate = key === 'finishReasons' ? firstStringFromFinishReasons(raw)
        : (typeof raw === 'string' ? raw : undefined);
      const normalized = normalizeFinishReason(candidate);
      if (normalized) {
        finishReason = normalized;
        break;
      }
    }
    if (finishReason) {
      for (const key of FINISH_REASON_KEYS) {
        if (key in nextMetadata) {
          delete nextMetadata[key];
          removedKeys.push(key);
        }
      }
    }
  }

  if (event.reasoningTokens === undefined && REASONING_TOKENS_KEY in metadata) {
    const num = Number(metadata[REASONING_TOKENS_KEY]);
    if (Number.isFinite(num) && num > 0) {
      reasoningTokens = num;
      delete nextMetadata[REASONING_TOKENS_KEY];
      removedKeys.push(REASONING_TOKENS_KEY);
    }
  }

  if (finishReason === undefined && reasoningTokens === undefined) return null;
  return { finishReason, reasoningTokens, metadata: nextMetadata, removedKeys };
}

/** The value a session-totals recompute should use for this event, whether
 *  or not the column write for a pending patch actually happened. */
function effectiveFields(event: IAgentTracingEvent, patch: EventPatch | null): {
  finishReason?: string;
  reasoningTokens: number;
} {
  const finishReason = event.finishReason ?? patch?.finishReason;
  const reasoningTokensRaw = event.reasoningTokens ?? patch?.reasoningTokens ?? 0;
  const reasoningTokens = Number.isFinite(reasoningTokensRaw) && reasoningTokensRaw > 0 ? reasoningTokensRaw : 0;
  return { finishReason, reasoningTokens };
}

interface TenantStats {
  sessionsScanned: number;
  eventsScanned: number;
  finishReasonFound: number;
  finishReasonWritten: number;
  reasoningTokensFound: number;
  reasoningTokensWritten: number;
  sessionsRecomputed: number;
  failedSessions: number;
}

function emptyStats(): TenantStats {
  return {
    sessionsScanned: 0,
    eventsScanned: 0,
    finishReasonFound: 0,
    finishReasonWritten: 0,
    reasoningTokensFound: 0,
    reasoningTokensWritten: 0,
    sessionsRecomputed: 0,
    failedSessions: 0,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { getDatabase, disconnectDatabase } = await import('../src/lib/database');
  const db = await getDatabase();

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
      `Backfilling trace fields (finishReason/reasoningTokens) for ${tenants.length} tenant(s), `
      + `range ${args.from ?? '(beginning)'} .. ${args.to ?? '(now)'}`
      + `${args.dryRun ? ' [dry-run]' : ''}\n`,
    );

    const grandStats = emptyStats();

    for (const tenant of tenants) {
      const label = `${tenant.slug} (${tenant.dbName})`;
      console.log(`── Tenant ${label}`);

      const run = async () => {
        const stats = emptyStats();
        let skip = 0;

        for (;;) {
          const { sessions } = await withRetry(`sessions(skip=${skip})`, () =>
            db.listAgentTracingSessions({
              limit: SESSION_PAGE_SIZE,
              skip,
              from: args.from,
              to: args.to,
              projection: {
                sessionId: 1,
                projectId: 1,
                agentName: 1,
                startedAt: 1,
                totalReasoningTokens: 1,
                truncatedEvents: 1,
              },
            }),
          );
          if (sessions.length === 0) break;
          skip += sessions.length;

          for (let i = 0; i < sessions.length; i += EVENT_FETCH_CONCURRENCY) {
            await Promise.all(
              sessions.slice(i, i + EVENT_FETCH_CONCURRENCY).map((session) =>
                processSession(session, {
                  db,
                  dryRun: args.dryRun,
                  stats,
                }).catch((error) => {
                  stats.failedSessions += 1;
                  console.warn(
                    `   ! skipping session ${session.sessionId} (${error instanceof Error ? error.message : error})`,
                  );
                }),
              ),
            );
          }

          await sleep(args.sleepMs);

          if (stats.sessionsScanned % 1000 < SESSION_PAGE_SIZE) {
            console.log(`   … ${stats.sessionsScanned} sessions scanned (${stats.eventsScanned} events read)`);
          }
        }

        console.log(
          `   sessions ${stats.sessionsScanned}${stats.failedSessions > 0 ? ` (${stats.failedSessions} skipped-unreadable)` : ''}, `
          + `events ${stats.eventsScanned}`,
        );
        console.log(
          `   finishReason: ${stats.finishReasonFound} found in metadata, `
          + `${stats.finishReasonWritten} written to column`,
        );
        console.log(
          `   reasoningTokens: ${stats.reasoningTokensFound} found in metadata, `
          + `${stats.reasoningTokensWritten} written to column`,
        );
        console.log(
          `   sessions recomputed (totalReasoningTokens/truncatedEvents): ${stats.sessionsRecomputed}`
          + `${args.dryRun ? ' (dry-run: 0 by definition)' : ''}`,
        );

        grandStats.sessionsScanned += stats.sessionsScanned;
        grandStats.eventsScanned += stats.eventsScanned;
        grandStats.finishReasonFound += stats.finishReasonFound;
        grandStats.finishReasonWritten += stats.finishReasonWritten;
        grandStats.reasoningTokensFound += stats.reasoningTokensFound;
        grandStats.reasoningTokensWritten += stats.reasoningTokensWritten;
        grandStats.sessionsRecomputed += stats.sessionsRecomputed;
        grandStats.failedSessions += stats.failedSessions;
      };

      if (typeof db.runWithTenant === 'function') {
        await db.runWithTenant(tenant.dbName, run);
      } else {
        await db.switchToTenant(tenant.dbName);
        await run();
      }
      console.log('');
    }

    console.log(
      `Done. ${grandStats.finishReasonWritten} finishReason + ${grandStats.reasoningTokensWritten} reasoningTokens `
      + `column write(s), ${grandStats.sessionsRecomputed} session(s) recomputed`
      + `${args.dryRun ? ' (dry-run: 0 writes by definition)' : ''}.`,
    );
    return 0;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

async function processSession(
  session: Pick<IAgentTracingSession, 'sessionId' | 'projectId' | 'totalReasoningTokens' | 'truncatedEvents'>,
  ctx: {
    db: Awaited<ReturnType<typeof import('../src/lib/database').getDatabase>>;
    dryRun: boolean;
    stats: TenantStats;
  },
): Promise<void> {
  const { db, dryRun, stats } = ctx;
  stats.sessionsScanned += 1;

  const events = await withRetry(`events(${session.sessionId})`, () =>
    db.listAgentTracingEvents(session.sessionId, session.projectId),
  );

  let totalReasoningTokens = 0;
  let truncatedEvents = 0;
  let sessionChanged = false;

  for (const event of events) {
    stats.eventsScanned += 1;
    const patch = computeEventPatch(event);

    if (patch) {
      if (patch.finishReason !== undefined) stats.finishReasonFound += 1;
      if (patch.reasoningTokens !== undefined) stats.reasoningTokensFound += 1;
      sessionChanged = true;

      if (!dryRun) {
        const eventId = event.id ?? String(event._id);
        const data: Partial<Pick<IAgentTracingEvent, 'finishReason' | 'reasoningTokens' | 'metadata'>> = {
          metadata: patch.metadata,
        };
        if (patch.finishReason !== undefined) data.finishReason = patch.finishReason;
        if (patch.reasoningTokens !== undefined) data.reasoningTokens = patch.reasoningTokens;
        await db.updateAgentTracingEvent(session.sessionId, eventId, data, session.projectId);
        if (patch.finishReason !== undefined) stats.finishReasonWritten += 1;
        if (patch.reasoningTokens !== undefined) stats.reasoningTokensWritten += 1;
      }
    }

    const { finishReason, reasoningTokens } = effectiveFields(event, patch);
    totalReasoningTokens += reasoningTokens;
    if (isTruncatedFinishReason(normalizeFinishReason(finishReason))) truncatedEvents += 1;
  }

  const totalsChanged =
    (session.totalReasoningTokens ?? 0) !== totalReasoningTokens
    || (session.truncatedEvents ?? 0) !== truncatedEvents;

  // Recompute only sessions whose events actually needed migrating, or whose
  // stored roll-ups already disagree with what their events imply — not
  // every session in the tenant (those are already correct from ingest).
  if ((sessionChanged || totalsChanged) && !dryRun) {
    await db.updateAgentTracingSession(
      session.sessionId,
      { totalReasoningTokens, truncatedEvents },
      session.projectId,
    );
    stats.sessionsRecomputed += 1;
  } else if ((sessionChanged || totalsChanged) && dryRun) {
    stats.sessionsRecomputed += 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
