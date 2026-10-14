/**
 * What a person has done lately, across the services: the "Activity" section of the person's drawer in the Authorization center.
 *
 * Two sources, both of which already carry the person (the usage envelope stamps `userId` / `apiTokenId` on every log and rollup
 * row, and a call an application's token made FOR the person is attributed to the person, see lib/iam/delegationGate.ts):
 *
 *   usage    the daily rollup (`usage_daily`) of the last N days by service: calls, errors, tokens, cost, and which application
 *            tokens the calls came through. The rollup is the one place that is addressable by person without a scan of the
 *            raw logs (model usage, MCP, RAG, tools, tracing ...), which are addressed by their own resource;
 *   actions  the audit trail rows the person is the subject of, newest first: what they did in the dashboard, and the API
 *            calls made for them (the row names the application token and the issuer that vouched for them).
 *
 * Read-only and bounded: a window of at most 90 days, a capped number of rollup rows, one page of audit rows.
 */

import { runWithTenantScope } from '@/lib/database';
import { resolvePrincipalLabels } from './labels';
import type { IamTenant } from './principals';

export const ACTIVITY_DEFAULT_DAYS = 30;
export const ACTIVITY_MAX_DAYS = 90;
export const ACTIVITY_DEFAULT_EVENTS = 25;
export const ACTIVITY_MAX_EVENTS = 100;
/** Rollup rows read per person: a person's rows are (days x services x resources), far below this unless something is wrong. */
const USAGE_ROW_LIMIT = 5_000;
/** A scan of the audit table is abandoned after this long (MongoDB). */
const EVENTS_MAX_TIME_MS = 5_000;

export interface ActivityUsage {
  service: string;
  requests: number;
  errors: number;
  totalTokens: number;
  costUsd: number;
  /** The last UTC day (YYYY-MM-DD) with calls. */
  lastDay: string;
  /** The application tokens the calls came through (a person's own calls have none). */
  viaTokens: Array<{ id: string; label: string; requests: number }>;
}

export interface ActivityEvent {
  id: string;
  at: string;
  service: string;
  event: string;
  method?: string;
  path?: string;
  outcome: string;
  statusCode?: number;
  decisionId?: string;
  /** The application token that made the call for the person. */
  viaToken?: { id: string; label: string };
  /** Who vouched for the person when an application acted for them. */
  via?: { kind: 'delegated'; issuer: string };
}

export interface PersonActivity {
  windowDays: number;
  usage: ActivityUsage[];
  /** The rollup had more rows than were read: the totals are a lower bound. */
  usageTruncated: boolean;
  events: ActivityEvent[];
  hasMoreEvents: boolean;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The person's recent activity, or null when there is no such person in the workspace. */
export async function getPersonActivity(
  tenant: IamTenant,
  userId: string,
  options: { days?: number; eventLimit?: number; now?: Date } = {},
): Promise<PersonActivity | null> {
  const windowDays = Math.max(1, Math.min(ACTIVITY_MAX_DAYS, Math.floor(options.days ?? ACTIVITY_DEFAULT_DAYS)));
  const eventLimit = Math.max(1, Math.min(ACTIVITY_MAX_EVENTS, Math.floor(options.eventLimit ?? ACTIVITY_DEFAULT_EVENTS)));
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const read = await runWithTenantScope(tenant.tenantDbName, async (db) => {
    let user = null;
    try {
      user = await db.findUserById(userId);
    } catch {
      user = null; // an id the provider cannot parse names nobody
    }
    if (!user || String(user.tenantId) !== String(tenant.tenantId)) return null;
    const [rollup, events] = await Promise.all([
      db.listUsageDaily({ userId, fromDay: isoDay(from), toDay: isoDay(now), limit: USAGE_ROW_LIMIT }),
      db.iamListAuditEvents({
        tenantId: tenant.tenantId,
        from,
        actorUserId: userId,
        limit: eventLimit,
        offset: 0,
        maxTimeMs: EVENTS_MAX_TIME_MS,
      }),
    ]);
    return { rollup, events };
  });
  if (!read) return null;

  const byService = new Map<string, ActivityUsage & { viaMap: Map<string, number> }>();
  for (const row of read.rollup) {
    let entry = byService.get(row.service);
    if (!entry) {
      entry = { service: row.service, requests: 0, errors: 0, totalTokens: 0, costUsd: 0, lastDay: '', viaTokens: [], viaMap: new Map() };
      byService.set(row.service, entry);
    }
    entry.requests += row.requests ?? 0;
    entry.errors += row.errors ?? 0;
    entry.totalTokens += row.totalTokens ?? 0;
    entry.costUsd += row.costUsd ?? 0;
    if (row.day > entry.lastDay) entry.lastDay = row.day;
    if (row.apiTokenId) entry.viaMap.set(row.apiTokenId, (entry.viaMap.get(row.apiTokenId) ?? 0) + (row.requests ?? 0));
  }

  const tokenIds = new Set<string>();
  for (const entry of byService.values()) for (const id of entry.viaMap.keys()) tokenIds.add(id);
  for (const row of read.events.items) if (row.apiTokenId) tokenIds.add(row.apiTokenId);
  const labels = tokenIds.size > 0 ? await resolvePrincipalLabels(tenant, { tokens: tokenIds }) : { users: new Map<string, string>(), tokens: new Map<string, string>() };
  const tokenLabel = (id: string): string => labels.tokens.get(id) ?? id;

  const usage = [...byService.values()]
    .map(({ viaMap, ...entry }): ActivityUsage => ({
      ...entry,
      costUsd: Math.round(entry.costUsd * 1e6) / 1e6,
      viaTokens: [...viaMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, requests]) => ({ id, label: tokenLabel(id), requests })),
    }))
    .sort((a, b) => b.requests - a.requests || a.service.localeCompare(b.service));

  const events = read.events.items.map((row): ActivityEvent => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const via = meta.via && typeof meta.via === 'object' ? (meta.via as { kind?: unknown; issuer?: unknown }) : null;
    return {
      id: String(row._id),
      at: new Date(row.createdAt ?? 0).toISOString(),
      service: String(row.service),
      event: row.event,
      ...(row.method ? { method: row.method } : {}),
      ...(row.path ? { path: row.path } : {}),
      outcome: row.outcome,
      ...(typeof row.statusCode === 'number' ? { statusCode: row.statusCode } : {}),
      ...(str(meta.decisionId) ? { decisionId: str(meta.decisionId) } : {}),
      ...(row.apiTokenId ? { viaToken: { id: row.apiTokenId, label: tokenLabel(row.apiTokenId) } } : {}),
      ...(via?.kind === 'delegated' && str(via.issuer) ? { via: { kind: 'delegated' as const, issuer: str(via.issuer) as string } } : {}),
    };
  });

  return {
    windowDays,
    usage,
    usageTruncated: read.rollup.length >= USAGE_ROW_LIMIT,
    events,
    hasMoreEvents: read.events.hasMore,
  };
}
