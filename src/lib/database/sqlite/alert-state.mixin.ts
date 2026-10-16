/**
 * SQLite Provider – Alert state operations mixin
 *
 * One row per (rule, entity) holding the evaluator's phase machine
 * (ok / pending / firing).
 */

import type { IAlertState, IAlertStateFilter } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

export function AlertStateMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AlertStateOps extends Base {
    // ── Alert state operations ───────────────────────────────────────

    async listAlertStates(filter: IAlertStateFilter): Promise<IAlertState[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter.ruleId) { clauses.push('ruleId = @ruleId'); params.ruleId = filter.ruleId; }
      if (filter.ruleIds) {
        if (filter.ruleIds.length === 0) return [];
        const names = filter.ruleIds.map((rid, i) => { params[`r${i}`] = rid; return `@r${i}`; });
        clauses.push(`ruleId IN (${names.join(', ')})`);
      }
      if (filter.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filter.projectId; }
      if (filter.phases) {
        if (filter.phases.length === 0) return [];
        const names = filter.phases.map((ph, i) => { params[`p${i}`] = ph; return `@p${i}`; });
        clauses.push(`phase IN (${names.join(', ')})`);
      }
      params.limit = clampLimit(filter.limit, 1000, 5000);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.alertStates} ${where} ORDER BY lastEvaluatedAt DESC LIMIT @limit`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapStateRow(r));
    }

    async upsertAlertState(
      state: Omit<IAlertState, '_id' | 'updatedAt'>,
    ): Promise<IAlertState> {
      const db = this.getTenantDb();
      const now = this.now();
      const iso = (v: Date | string | null | undefined) =>
        v ? (v instanceof Date ? v.toISOString() : v) : null;
      const entityKey = state.entityKey ?? '';
      db.prepare(`
        INSERT INTO ${TABLES.alertStates}
        (id, tenantId, projectId, ruleId, entityKey, entityType, phase, phaseSince,
         breachStreak, okStreak, lastValue, lastBaseline, lastSampleCount, lastEvaluatedAt,
         incidentId, eventId, firedAt, lastFiredAt, lastNotifiedAt, peakValue, detail, updatedAt)
        VALUES (@id, @tenantId, @projectId, @ruleId, @entityKey, @entityType, @phase, @phaseSince,
         @breachStreak, @okStreak, @lastValue, @lastBaseline, @lastSampleCount, @lastEvaluatedAt,
         @incidentId, @eventId, @firedAt, @lastFiredAt, @lastNotifiedAt, @peakValue, @detail, @updatedAt)
        ON CONFLICT(tenantId, ruleId, entityKey) DO UPDATE SET
          projectId = excluded.projectId,
          entityType = excluded.entityType,
          phase = excluded.phase,
          phaseSince = excluded.phaseSince,
          breachStreak = excluded.breachStreak,
          okStreak = excluded.okStreak,
          lastValue = excluded.lastValue,
          lastBaseline = excluded.lastBaseline,
          lastSampleCount = excluded.lastSampleCount,
          lastEvaluatedAt = excluded.lastEvaluatedAt,
          incidentId = excluded.incidentId,
          eventId = excluded.eventId,
          firedAt = excluded.firedAt,
          lastFiredAt = excluded.lastFiredAt,
          lastNotifiedAt = excluded.lastNotifiedAt,
          peakValue = excluded.peakValue,
          detail = excluded.detail,
          updatedAt = excluded.updatedAt
      `).run({
        id: this.newId(),
        tenantId: state.tenantId,
        projectId: state.projectId ?? '',
        ruleId: state.ruleId,
        entityKey,
        entityType: state.entityType ?? null,
        phase: state.phase,
        phaseSince: iso(state.phaseSince) ?? now,
        breachStreak: state.breachStreak ?? 0,
        okStreak: state.okStreak ?? 0,
        lastValue: state.lastValue ?? null,
        lastBaseline: state.lastBaseline ?? null,
        lastSampleCount: state.lastSampleCount ?? 0,
        lastEvaluatedAt: iso(state.lastEvaluatedAt) ?? now,
        incidentId: state.incidentId ?? null,
        eventId: state.eventId ?? null,
        firedAt: iso(state.firedAt),
        lastFiredAt: iso(state.lastFiredAt),
        lastNotifiedAt: iso(state.lastNotifiedAt),
        peakValue: state.peakValue ?? null,
        detail: state.detail ? this.toJson(state.detail) : null,
        updatedAt: now,
      });
      const row = db.prepare(
        `SELECT * FROM ${TABLES.alertStates} WHERE tenantId = @tenantId AND ruleId = @ruleId AND entityKey = @entityKey`,
      ).get({ tenantId: state.tenantId, ruleId: state.ruleId, entityKey }) as SqliteRow;
      return this.mapStateRow(row);
    }

    async deleteAlertStates(filter: { ruleId: string; entityKeys?: string[] }): Promise<number> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { ruleId: filter.ruleId };
      let where = 'ruleId = @ruleId';
      if (filter.entityKeys) {
        if (filter.entityKeys.length === 0) return 0;
        const names = filter.entityKeys.map((k, i) => { params[`k${i}`] = k; return `@k${i}`; });
        where += ` AND entityKey IN (${names.join(', ')})`;
      }
      return db.prepare(`DELETE FROM ${TABLES.alertStates} WHERE ${where}`).run(params).changes;
    }

    protected mapStateRow(r: SqliteRow): IAlertState {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: (r.projectId as string) ?? '',
        ruleId: r.ruleId as string,
        entityKey: (r.entityKey as string) ?? '',
        entityType: (r.entityType as IAlertState['entityType']) ?? null,
        phase: r.phase as IAlertState['phase'],
        phaseSince: this.toDate(r.phaseSince) ?? new Date(),
        breachStreak: (r.breachStreak as number) ?? 0,
        okStreak: (r.okStreak as number) ?? 0,
        lastValue: (r.lastValue as number | null) ?? null,
        lastBaseline: (r.lastBaseline as number | null) ?? null,
        lastSampleCount: (r.lastSampleCount as number) ?? 0,
        lastEvaluatedAt: this.toDate(r.lastEvaluatedAt) ?? new Date(),
        incidentId: (r.incidentId as string | null) ?? null,
        eventId: (r.eventId as string | null) ?? null,
        firedAt: r.firedAt ? this.toDate(r.firedAt) : null,
        lastFiredAt: r.lastFiredAt ? this.toDate(r.lastFiredAt) : null,
        lastNotifiedAt: r.lastNotifiedAt ? this.toDate(r.lastNotifiedAt) : null,
        peakValue: (r.peakValue as number | null) ?? null,
        detail: r.detail ? this.parseJson<Record<string, unknown> | null>(r.detail, null) : null,
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
