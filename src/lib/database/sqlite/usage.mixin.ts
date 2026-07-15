/**
 * SQLite Provider – Cross-service usage rollup mixin
 *
 * Mirrors mongodb/usage.mixin.ts. Counters are additive; the flush applies a
 * read-merge-write per row inside a single transaction (better-sqlite3 is
 * synchronous single-process, so this is race-free and fast).
 */

import type { IUsageDaily, IUsageDailyIncrement } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const COUNTER_FIELDS = [
  'requests',
  'errors',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'totalTokens',
  'costUsd',
  'latencyMsSum',
  'latencyCount',
] as const;

export function UsageRollupMixin<TBase extends Constructor<SQLiteProviderBase>>(
  Base: TBase,
) {
  return class UsageRollupOps extends Base {
    async incrementUsageDaily(rows: IUsageDailyIncrement[]): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();

      const select = db.prepare(`
        SELECT id, units FROM ${TABLES.usageDaily}
        WHERE tenantId = @tenantId AND projectId = @projectId AND userId = @userId
          AND apiTokenId = @apiTokenId AND source = @source AND service = @service
          AND refKey = @refKey AND day = @day
      `);
      const insert = db.prepare(`
        INSERT INTO ${TABLES.usageDaily}
        (id, tenantId, projectId, userId, apiTokenId, actorType, source, service, refKey, day, dayDate,
         requests, errors, inputTokens, outputTokens, cachedInputTokens, totalTokens,
         costUsd, latencyMsSum, latencyCount, units, updatedAt)
        VALUES (@id, @tenantId, @projectId, @userId, @apiTokenId, @actorType, @source, @service, @refKey, @day, @dayDate,
         @requests, @errors, @inputTokens, @outputTokens, @cachedInputTokens, @totalTokens,
         @costUsd, @latencyMsSum, @latencyCount, @units, @updatedAt)
      `);
      const update = db.prepare(`
        UPDATE ${TABLES.usageDaily} SET
          requests = requests + @requests,
          errors = errors + @errors,
          inputTokens = inputTokens + @inputTokens,
          outputTokens = outputTokens + @outputTokens,
          cachedInputTokens = cachedInputTokens + @cachedInputTokens,
          totalTokens = totalTokens + @totalTokens,
          costUsd = costUsd + @costUsd,
          latencyMsSum = latencyMsSum + @latencyMsSum,
          latencyCount = latencyCount + @latencyCount,
          units = @units,
          updatedAt = @updatedAt
        WHERE id = @id
      `);

      const applyAll = db.transaction((increments: IUsageDailyIncrement[]) => {
        for (const row of increments) {
          const dims = {
            tenantId: row.tenantId,
            projectId: row.projectId,
            userId: row.userId,
            apiTokenId: row.apiTokenId,
            source: row.source,
            service: row.service,
            refKey: row.refKey,
            day: row.day,
          };
          const counters = Object.fromEntries(
            COUNTER_FIELDS.map((field) => [field, row[field] ?? 0]),
          ) as Record<(typeof COUNTER_FIELDS)[number], number>;
          const existing = select.get(dims) as
            | { id: string; units: string | null }
            | undefined;

          if (existing) {
            const units = this.parseJson<Record<string, number>>(existing.units, {});
            for (const [unit, value] of Object.entries(row.units ?? {})) {
              if (typeof value === 'number' && value !== 0) {
                units[unit] = (units[unit] ?? 0) + value;
              }
            }
            update.run({
              id: existing.id,
              ...counters,
              units: Object.keys(units).length > 0 ? this.toJson(units) : null,
              updatedAt: this.now(),
            });
          } else {
            insert.run({
              id: this.newId(),
              ...dims,
              actorType: row.actorType,
              // Real Date (ISO) for the reports engine's range filters/bucketing.
              dayDate: `${row.day}T00:00:00.000Z`,
              ...counters,
              units:
                row.units && Object.keys(row.units).length > 0
                  ? this.toJson(row.units)
                  : null,
              updatedAt: this.now(),
            });
          }
        }
      });

      applyAll(rows);
    }

    async listUsageDaily(filter: {
      projectId?: string;
      userId?: string;
      apiTokenId?: string;
      service?: string;
      refKey?: string;
      source?: string;
      fromDay?: string;
      toDay?: string;
      limit?: number;
    }): Promise<IUsageDaily[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      const eqFilters: Array<[keyof typeof filter, string]> = [
        ['projectId', 'projectId'],
        ['userId', 'userId'],
        ['apiTokenId', 'apiTokenId'],
        ['service', 'service'],
        ['refKey', 'refKey'],
        ['source', 'source'],
      ];
      for (const [key, column] of eqFilters) {
        if (filter[key] !== undefined) {
          clauses.push(`${column} = @${column}`);
          params[column] = filter[key];
        }
      }
      if (filter.fromDay) {
        clauses.push('day >= @fromDay');
        params.fromDay = filter.fromDay;
      }
      if (filter.toDay) {
        clauses.push('day <= @toDay');
        params.toDay = filter.toDay;
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(
          `SELECT * FROM ${TABLES.usageDaily} ${where} ORDER BY day DESC LIMIT @limit`,
        )
        .all({ ...params, limit: filter.limit ?? 1000 }) as SqliteRow[];

      return rows.map((row) => this.mapUsageDailyRow(row));
    }

    private mapUsageDailyRow(row: SqliteRow): IUsageDaily {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        userId: String(row.userId ?? ''),
        apiTokenId: String(row.apiTokenId ?? ''),
        actorType: String(row.actorType ?? ''),
        source: String(row.source ?? ''),
        service: String(row.service),
        refKey: String(row.refKey ?? ''),
        day: String(row.day),
        dayDate: row.dayDate ? new Date(String(row.dayDate)) : undefined,
        requests: Number(row.requests ?? 0),
        errors: Number(row.errors ?? 0),
        inputTokens: Number(row.inputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
        cachedInputTokens: Number(row.cachedInputTokens ?? 0),
        totalTokens: Number(row.totalTokens ?? 0),
        costUsd: Number(row.costUsd ?? 0),
        latencyMsSum: Number(row.latencyMsSum ?? 0),
        latencyCount: Number(row.latencyCount ?? 0),
        units: this.parseJson<Record<string, number> | null>(row.units, null) ?? undefined,
        updatedAt: row.updatedAt ? new Date(String(row.updatedAt)) : undefined,
      };
    }
  };
}
