/**
 * Usage breakdown — read-side grouping of `usage_daily` rollup rows by user
 * or API token.
 *
 * The rollup table is the only place per-request attribution (userId /
 * apiTokenId) survives aggregation, so any "who spent what" view reads from
 * here rather than the raw service logs. Rows are daily aggregates (small),
 * so grouping happens in JS.
 *
 * Attribution only exists from the deploy that introduced the rollup onward;
 * rows written by the backfill script carry '' dimensions and surface as the
 * "unattributed / legacy" bucket.
 */

import { getDatabase } from '@/lib/database';
import type { IUsageDaily } from '@/lib/database';

export type UsageBreakdownGroupBy = 'user' | 'token';

export interface UsageBreakdownEntry {
  /** userId or apiTokenId depending on groupBy; '' = unattributed/legacy. */
  id: string;
  /** Display name (user.name); undefined when the entity no longer exists. */
  name?: string;
  /** Secondary label: user email or API token label. */
  label?: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageBreakdownTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageBreakdown {
  groupBy: UsageBreakdownGroupBy;
  fromDay?: string;
  toDay?: string;
  totals: UsageBreakdownTotals;
  entries: UsageBreakdownEntry[];
}

/** Format a Date as the rollup's UTC calendar day ('YYYY-MM-DD'). */
export function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Pure grouping over daily rollup rows: one entry per userId (or apiTokenId),
 * sorted by cost descending, plus overall totals. Rows with an empty
 * dimension value collapse into a single '' entry (unattributed/legacy).
 */
export function groupUsageDailyRows(
  rows: Pick<
    IUsageDaily,
    | 'userId'
    | 'apiTokenId'
    | 'requests'
    | 'errors'
    | 'inputTokens'
    | 'outputTokens'
    | 'totalTokens'
    | 'costUsd'
  >[],
  groupBy: UsageBreakdownGroupBy,
): { totals: UsageBreakdownTotals; entries: UsageBreakdownEntry[] } {
  const byId = new Map<string, UsageBreakdownEntry>();
  const totals: UsageBreakdownTotals = {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  for (const row of rows) {
    const id = (groupBy === 'user' ? row.userId : row.apiTokenId) ?? '';
    const entry = byId.get(id) ?? {
      id,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    entry.requests += row.requests ?? 0;
    entry.errors += row.errors ?? 0;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;
    byId.set(id, entry);

    totals.requests += row.requests ?? 0;
    totals.errors += row.errors ?? 0;
    totals.inputTokens += row.inputTokens ?? 0;
    totals.outputTokens += row.outputTokens ?? 0;
    totals.totalTokens += row.totalTokens ?? 0;
    totals.costUsd += row.costUsd ?? 0;
  }

  const entries = [...byId.values()].sort((a, b) => b.costUsd - a.costUsd);
  return { totals, entries };
}

/**
 * Decorate breakdown entries with display names, read-side only.
 * Users resolve one-by-one via findUserById (unique ids, batched with
 * Promise.all); tokens resolve from one listTenantApiTokens call. Missing or
 * deleted entities keep the raw id with name/label undefined.
 *
 * Assumes the caller already bound the tenant DB.
 */
export async function resolveUsageEntityNames(
  entries: UsageBreakdownEntry[],
  groupBy: UsageBreakdownGroupBy,
  tenantId: string,
): Promise<void> {
  const ids = [...new Set(entries.map((entry) => entry.id).filter((id) => id !== ''))];
  if (ids.length === 0) return;

  const db = await getDatabase();

  if (groupBy === 'user') {
    const users = await Promise.all(
      ids.map(async (id) => {
        try {
          return await db.findUserById(id);
        } catch {
          return null; // malformed/legacy id — keep raw id, name undefined
        }
      }),
    );
    const byId = new Map(
      users
        .filter((user): user is NonNullable<typeof user> => Boolean(user))
        .map((user) => [String(user._id), user]),
    );
    for (const entry of entries) {
      const user = byId.get(entry.id);
      if (user) {
        entry.name = user.name;
        entry.label = user.email;
      }
    }
    return;
  }

  const tokens = await db.listTenantApiTokens(tenantId);
  const byId = new Map(tokens.map((token) => [String(token._id), token]));
  for (const entry of entries) {
    const token = byId.get(entry.id);
    if (token) {
      entry.label = token.label;
    }
  }
}

export interface GetUsageBreakdownOptions {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  /** Service slug, e.g. 'models'. */
  service: string;
  /** Service-local resource key, e.g. modelKey. Omit for all resources. */
  refKey?: string;
  groupBy: UsageBreakdownGroupBy;
  from?: Date;
  to?: Date;
}

/** Rollup rows are daily aggregates; this bounds pathological reads only. */
const MAX_ROLLUP_ROWS = 20_000;

/**
 * Read `usage_daily` for one service/resource, group by user or API token and
 * resolve display names.
 */
export async function getUsageBreakdown(
  options: GetUsageBreakdownOptions,
): Promise<UsageBreakdown> {
  const db = await getDatabase();
  await db.switchToTenant(options.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const rows = await db.listUsageDaily({
    projectId: options.projectId,
    service: options.service,
    refKey: options.refKey,
    fromDay,
    toDay,
    limit: MAX_ROLLUP_ROWS,
  });

  const { totals, entries } = groupUsageDailyRows(rows, options.groupBy);
  await resolveUsageEntityNames(entries, options.groupBy, options.tenantId);

  return {
    groupBy: options.groupBy,
    fromDay,
    toDay,
    totals,
    entries,
  };
}

export interface UsageServiceBreakdownEntry {
  /** Service slug, e.g. 'models' | 'websearch' | 'mcp'; '' = unattributed. */
  service: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageServiceBreakdown {
  fromDay?: string;
  toDay?: string;
  totals: UsageBreakdownTotals;
  entries: UsageServiceBreakdownEntry[];
}

/**
 * Read `usage_daily` across ALL services and group by `service`. Unlike
 * {@link getUsageBreakdown} (which requires a single service slug and groups by
 * user/token), this reduces every rollup row by its `service` field to answer
 * "which service cost what". No new DB primitive — reuses `listUsageDaily`.
 */
export async function getUsageServiceBreakdown(
  ctx: { tenantDbName: string; tenantId: string; projectId?: string },
  options: { from?: Date; to?: Date } = {},
): Promise<UsageServiceBreakdown> {
  const db = await getDatabase();
  await db.switchToTenant(ctx.tenantDbName);

  const fromDay = options.from ? toUtcDay(options.from) : undefined;
  const toDay = options.to ? toUtcDay(options.to) : undefined;

  const rows = await db.listUsageDaily({
    projectId: ctx.projectId,
    fromDay,
    toDay,
    limit: MAX_ROLLUP_ROWS,
  });

  const byService = new Map<string, UsageServiceBreakdownEntry>();
  const totals: UsageBreakdownTotals = {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  for (const row of rows) {
    const service = row.service ?? '';
    const entry = byService.get(service) ?? {
      service,
      requests: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    entry.requests += row.requests ?? 0;
    entry.errors += row.errors ?? 0;
    entry.inputTokens += row.inputTokens ?? 0;
    entry.outputTokens += row.outputTokens ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;
    byService.set(service, entry);

    totals.requests += row.requests ?? 0;
    totals.errors += row.errors ?? 0;
    totals.inputTokens += row.inputTokens ?? 0;
    totals.outputTokens += row.outputTokens ?? 0;
    totals.totalTokens += row.totalTokens ?? 0;
    totals.costUsd += row.costUsd ?? 0;
  }

  const entries = [...byService.values()].sort((a, b) => b.costUsd - a.costUsd);
  return { fromDay, toDay, totals, entries };
}
