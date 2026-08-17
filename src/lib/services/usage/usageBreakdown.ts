/**
 * Usage breakdown — read-side grouping of `usage_daily` rollup rows by user,
 * API token or agent.
 *
 * The rollup table is the only place per-request attribution (userId /
 * apiTokenId / agentKey) survives aggregation, so any "who spent what" view
 * reads from here rather than the raw service logs. Rows are daily aggregates
 * (small), so grouping happens in JS.
 *
 * Attribution only exists from the deploy that introduced the rollup onward;
 * rows written by the backfill script carry '' dimensions and surface as the
 * "unattributed / legacy" bucket.
 */

import { getDatabase } from '@/lib/database';
import type { IUsageDaily } from '@/lib/database';

/**
 * `metadata.<key>` groups by one key of the free-form `metadata` bag callers
 * attach at tracing ingest time (e.g. `metadata.complexity`) — dynamic, no
 * schema change needed for a new key. Key format is validated where the
 * string is parsed from a request (`parseMetadataGroupByKey`); this type only
 * documents the shape.
 */
export type UsageBreakdownGroupBy = 'user' | 'token' | 'agent' | `metadata.${string}`;

const METADATA_GROUP_BY_PREFIX = 'metadata.';
/** Same charset/length the ingest side enforces on metadata keys
 *  (see `sanitizeTracingMetadata` in `client-tracing.ts`). */
const METADATA_KEY_PATTERN = /^[a-zA-Z0-9_]{1,40}$/;

function metadataGroupByKey(groupBy: UsageBreakdownGroupBy): string | undefined {
  return groupBy.startsWith(METADATA_GROUP_BY_PREFIX)
    ? groupBy.slice(METADATA_GROUP_BY_PREFIX.length)
    : undefined;
}

/**
 * Parse+validate a `group_by`/`group_by_entity` request value of the form
 * `metadata.<key>` into its key, or `undefined` if it isn't that shape.
 * Callers MUST reject the request (400) when a value that merely starts with
 * `metadata.` fails this — never fall back to treating it as a literal id:
 * the key ends up in a Mongo `metadata.<key>` dot-path / row property lookup
 * downstream, so an unvalidated key is a query-injection surface.
 */
export function parseMetadataGroupByKey(value: string): string | undefined {
  if (!value.startsWith(METADATA_GROUP_BY_PREFIX)) return undefined;
  const key = value.slice(METADATA_GROUP_BY_PREFIX.length);
  return METADATA_KEY_PATTERN.test(key) ? key : undefined;
}

export interface UsageBreakdownEntry {
  /** userId, apiTokenId or agentKey depending on groupBy; '' = unattributed. */
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
 * Pure grouping over daily rollup rows: one entry per userId / apiTokenId /
 * agentKey, sorted by cost descending, plus overall totals. Rows with an
 * empty dimension value collapse into a single '' entry (unattributed).
 */
export function groupUsageDailyRows(
  rows: Array<
    Pick<
      IUsageDaily,
      | 'userId'
      | 'apiTokenId'
      | 'requests'
      | 'errors'
      | 'inputTokens'
      | 'outputTokens'
      | 'totalTokens'
      | 'costUsd'
    > &
      Partial<Pick<IUsageDaily, 'agentKey' | 'metadata'>>
  >,
  groupBy: UsageBreakdownGroupBy,
): { totals: UsageBreakdownTotals; entries: UsageBreakdownEntry[] } {
  const metadataKey = metadataGroupByKey(groupBy);
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
    // Legacy rows predate the agentKey/metadata dimensions — treat missing as ''.
    const id =
      (groupBy === 'user'
        ? row.userId
        : groupBy === 'token'
          ? row.apiTokenId
          : metadataKey !== undefined
            ? row.metadata?.[metadataKey]
            : row.agentKey) ?? '';
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

  // Agent keys (and metadata values) are plain strings the caller sent —
  // there is no entity record to resolve; the key itself is the display name.
  if (groupBy === 'agent' || metadataGroupByKey(groupBy) !== undefined) {
    for (const entry of entries) {
      if (entry.id !== '') entry.name = entry.id;
    }
    return;
  }

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
  /** Restrict to one agent's usage (agentKey dimension). */
  agentKey?: string;
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
    agentKey: options.agentKey,
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
