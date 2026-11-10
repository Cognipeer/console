/**
 * SQLite Provider – Plan limits usage mixin
 *
 * Monthly meters, limit events and capacity peaks live in the MAIN database.
 */

import type { MonthlyMeter, PlanLimitEvent, PlanLimitKind } from '@/lib/limits/types';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const MONTHLY_METERS: readonly MonthlyMeter[] = ['searches', 'flowRuns', 'crawlerPages', 'sandboxSeconds'];
const DIMENSION_RE = /^[a-zA-Z0-9_]+$/;

function pickMeters(row: SqliteRow): Partial<Record<MonthlyMeter, number>> {
  const out: Partial<Record<MonthlyMeter, number>> = {};
  for (const meter of MONTHLY_METERS) {
    const value = row[meter];
    if (typeof value === 'number') out[meter] = value;
  }
  return out;
}

export function PlanLimitsMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class PlanLimitsOps extends Base {
    async incrementPlanUsageMonthly(
      tenantId: string,
      period: string,
      deltas: Partial<Record<MonthlyMeter, number>>,
    ): Promise<void> {
      const params: Record<string, unknown> = {
        id: `${tenantId}:${period}`,
        tenantId,
        period,
        updatedAt: this.now(),
      };
      let any = false;
      for (const meter of MONTHLY_METERS) {
        const value = deltas[meter];
        const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
        params[meter] = n;
        if (n !== 0) any = true;
      }
      if (!any) return;
      this.getMainDb().prepare(`
        INSERT INTO ${TABLES.planUsageMonthly}
        (id, tenantId, period, searches, flowRuns, crawlerPages, sandboxSeconds, updatedAt)
        VALUES (@id, @tenantId, @period, @searches, @flowRuns, @crawlerPages, @sandboxSeconds, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          searches = searches + excluded.searches,
          flowRuns = flowRuns + excluded.flowRuns,
          crawlerPages = crawlerPages + excluded.crawlerPages,
          sandboxSeconds = sandboxSeconds + excluded.sandboxSeconds,
          updatedAt = excluded.updatedAt
      `).run(params);
    }

    async getPlanUsageMonthly(
      tenantId: string,
      period: string,
    ): Promise<Partial<Record<MonthlyMeter, number>>> {
      const row = this.getMainDb()
        .prepare(`SELECT * FROM ${TABLES.planUsageMonthly} WHERE id = ?`)
        .get(`${tenantId}:${period}`) as SqliteRow | undefined;
      return row ? pickMeters(row) : {};
    }

    async listPlanUsageMonthly(
      period: string,
      opts: { tenantIds?: string[] } = {},
    ): Promise<Array<{ tenantId: string; period: string } & Partial<Record<MonthlyMeter, number>>>> {
      const db = this.getMainDb();
      let rows: SqliteRow[];
      if (opts.tenantIds) {
        if (opts.tenantIds.length === 0) return [];
        const marks = opts.tenantIds.map(() => '?').join(',');
        rows = db.prepare(
          `SELECT * FROM ${TABLES.planUsageMonthly} WHERE period = ? AND tenantId IN (${marks}) ORDER BY tenantId ASC`,
        ).all(period, ...opts.tenantIds) as SqliteRow[];
      } else {
        rows = db.prepare(
          `SELECT * FROM ${TABLES.planUsageMonthly} WHERE period = ? ORDER BY tenantId ASC`,
        ).all(period) as SqliteRow[];
      }
      return rows.map((row) => ({
        tenantId: row.tenantId as string,
        period: row.period as string,
        ...pickMeters(row),
      }));
    }

    async insertPlanLimitEvents(events: PlanLimitEvent[]): Promise<void> {
      if (events.length === 0) return;
      const db = this.getMainDb();
      const stmt = db.prepare(`
        INSERT INTO ${TABLES.planLimitEvents}
        (tenantId, kind, dimension, outcome, mode, "limit", used, waitMs, source, count, at)
        VALUES (@tenantId, @kind, @dimension, @outcome, @mode, @limit, @used, @waitMs, @source, @count, @at)
      `);
      const run = db.transaction((items: PlanLimitEvent[]) => {
        for (const event of items) {
          stmt.run({
            tenantId: event.tenantId,
            kind: event.kind,
            dimension: event.dimension ?? null,
            outcome: event.outcome,
            mode: event.mode,
            limit: event.limit ?? null,
            used: event.used ?? null,
            waitMs: event.waitMs ?? null,
            source: event.source ? JSON.stringify(event.source) : null,
            count: event.count,
            at: event.at.toISOString(),
          });
        }
      });
      run(events);
    }

    async listPlanLimitEvents(
      tenantId: string,
      opts: { since?: Date; kind?: PlanLimitKind; limit: number },
    ): Promise<PlanLimitEvent[]> {
      const clauses = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId, limit: opts.limit };
      if (opts.since) {
        clauses.push('at >= @since');
        params.since = opts.since.toISOString();
      }
      if (opts.kind) {
        clauses.push('kind = @kind');
        params.kind = opts.kind;
      }
      const rows = this.getMainDb().prepare(`
        SELECT * FROM ${TABLES.planLimitEvents}
        WHERE ${clauses.join(' AND ')}
        ORDER BY at DESC, id DESC
        LIMIT @limit
      `).all(params) as SqliteRow[];
      return rows.map((row) => this.mapPlanLimitEventRow(row));
    }

    async deletePlanLimitEventsBefore(cutoff: Date): Promise<number> {
      const result = this.getMainDb()
        .prepare(`DELETE FROM ${TABLES.planLimitEvents} WHERE at < ?`)
        .run(cutoff.toISOString());
      return result.changes;
    }

    async maxPlanUsagePeak(
      tenantId: string,
      day: string,
      dimension: string,
      hour: number,
      value: number,
    ): Promise<void> {
      if (!DIMENSION_RE.test(dimension)) {
        throw new Error(`Invalid plan usage dimension: ${dimension}`);
      }
      const hh = Math.trunc(hour);
      if (!Number.isFinite(hh) || hh < 0 || hh > 23) throw new Error(`Invalid hour: ${hour}`);
      this.getMainDb().prepare(`
        INSERT INTO ${TABLES.planUsagePeaks} (tenantId, day, dimension, hour, value)
        VALUES (@tenantId, @day, @dimension, @hour, @value)
        ON CONFLICT(tenantId, day, dimension, hour) DO UPDATE SET value = max(value, excluded.value)
      `).run({ tenantId, day, dimension, hour: hh, value });
    }

    async getPlanUsagePeaks(
      tenantId: string,
      days: string[],
    ): Promise<Array<{ day: string; dimension: string; hour: number; value: number }>> {
      if (days.length === 0) return [];
      const marks = days.map(() => '?').join(',');
      const rows = this.getMainDb().prepare(`
        SELECT day, dimension, hour, value FROM ${TABLES.planUsagePeaks}
        WHERE tenantId = ? AND day IN (${marks})
        ORDER BY day ASC, dimension ASC, hour ASC
      `).all(tenantId, ...days) as SqliteRow[];
      return rows.map((row) => ({
        day: row.day as string,
        dimension: row.dimension as string,
        hour: row.hour as number,
        value: row.value as number,
      }));
    }

    // ── Row mappers ─────────────────────────────────────────────────

    private mapPlanLimitEventRow(row: SqliteRow): PlanLimitEvent {
      const event: PlanLimitEvent = {
        tenantId: row.tenantId as string,
        kind: row.kind as PlanLimitKind,
        outcome: row.outcome as PlanLimitEvent['outcome'],
        mode: row.mode as PlanLimitEvent['mode'],
        count: (row.count as number) ?? 1,
        at: this.toDate(row.at) ?? new Date(0),
      };
      if (row.dimension != null) event.dimension = row.dimension as string;
      if (row.limit != null) event.limit = row.limit as number;
      if (row.used != null) event.used = row.used as number;
      if (row.waitMs != null) event.waitMs = row.waitMs as number;
      if (row.source != null) event.source = JSON.parse(row.source as string);
      return event;
    }
  };
}
