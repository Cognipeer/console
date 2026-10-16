/**
 * SQLite Provider – Incident operations mixin
 *
 * Incidents are created when alerts fire and track resolution lifecycle.
 */

import type { IIncident, IIncidentStatRow, IncidentSort, IncidentStatus, IncidentSeverity, AlertModule } from '../provider.interface';
import { toLikePattern } from '../provider/conversationSearch';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];

function clampLimit(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

function clampSkip(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

const SEVERITY_RANK_SQL = `CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;

/** ORDER BY for an incident sort; ties break on id so pages never reorder. */
function incidentOrderBy(sort: IncidentSort | undefined): string {
  switch (sort) {
    case 'firedAt': return 'firedAt ASC, id ASC';
    case 'updatedAt': return 'updatedAt ASC, id ASC';
    case '-updatedAt': return 'updatedAt DESC, id DESC';
    // Severity: worst first when descending (critical > warning > info), newest first inside a rank.
    case '-severity': return `${SEVERITY_RANK_SQL} ASC, firedAt DESC, id DESC`;
    case 'severity': return `${SEVERITY_RANK_SQL} DESC, firedAt DESC, id DESC`;
    default: return 'firedAt DESC, id DESC';
  }
}

export function IncidentMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class IncidentOps extends Base {
    async createIncident(
      incident: Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IIncident> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.incidents}
        (id, tenantId, projectId, alertEventId, ruleId, ruleName, metric,
         threshold, actualValue, severity, status, assignedTo, notes,
         firedAt, acknowledgedAt, resolvedAt, closedAt, resolvedBy,
         module, entityType, entityKey, baselineValue, lastValue, peakValue,
         autoResolved, acknowledgedBy, context,
         snoozedUntil, snoozedBy, reopenedAt, reopenCount,
         metadata, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @alertEventId, @ruleId, @ruleName, @metric,
         @threshold, @actualValue, @severity, @status, @assignedTo, @notes,
         @firedAt, @acknowledgedAt, @resolvedAt, @closedAt, @resolvedBy,
         @module, @entityType, @entityKey, @baselineValue, @lastValue, @peakValue,
         @autoResolved, @acknowledgedBy, @context,
         @snoozedUntil, @snoozedBy, @reopenedAt, @reopenCount,
         @metadata, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: incident.tenantId,
        projectId: incident.projectId,
        alertEventId: incident.alertEventId,
        ruleId: incident.ruleId,
        ruleName: incident.ruleName,
        metric: incident.metric,
        threshold: incident.threshold,
        actualValue: incident.actualValue,
        severity: incident.severity,
        status: incident.status,
        assignedTo: incident.assignedTo ?? null,
        notes: this.toJson(incident.notes ?? []),
        firedAt: incident.firedAt instanceof Date ? incident.firedAt.toISOString() : incident.firedAt,
        acknowledgedAt: incident.acknowledgedAt
          ? (incident.acknowledgedAt instanceof Date ? incident.acknowledgedAt.toISOString() : incident.acknowledgedAt)
          : null,
        resolvedAt: incident.resolvedAt
          ? (incident.resolvedAt instanceof Date ? incident.resolvedAt.toISOString() : incident.resolvedAt)
          : null,
        closedAt: incident.closedAt
          ? (incident.closedAt instanceof Date ? incident.closedAt.toISOString() : incident.closedAt)
          : null,
        resolvedBy: incident.resolvedBy ?? null,
        module: incident.module ?? null,
        entityType: incident.entityType ?? null,
        entityKey: incident.entityKey ?? null,
        baselineValue: incident.baselineValue ?? null,
        lastValue: incident.lastValue ?? null,
        peakValue: incident.peakValue ?? null,
        autoResolved: incident.autoResolved === undefined ? null : this.toBoolInt(incident.autoResolved),
        acknowledgedBy: incident.acknowledgedBy ?? null,
        context: incident.context ? this.toJson(incident.context) : null,
        snoozedUntil: isoOrNull(incident.snoozedUntil),
        snoozedBy: incident.snoozedBy ?? null,
        reopenedAt: isoOrNull(incident.reopenedAt),
        reopenCount: incident.reopenCount ?? null,
        metadata: this.toJson(incident.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      });

      return { ...incident, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateIncident(
      id: string,
      data: Partial<Omit<IIncident, 'tenantId' | 'alertEventId' | 'ruleId'>>,
      projectId?: string,
    ): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.severity !== undefined) { sets.push('severity = @severity'); params.severity = data.severity; }
      if (data.assignedTo !== undefined) { sets.push('assignedTo = @assignedTo'); params.assignedTo = data.assignedTo; }
      if (data.notes !== undefined) { sets.push('notes = @notes'); params.notes = this.toJson(data.notes); }
      if (data.acknowledgedAt !== undefined) {
        sets.push('acknowledgedAt = @acknowledgedAt');
        params.acknowledgedAt = data.acknowledgedAt instanceof Date ? data.acknowledgedAt.toISOString() : data.acknowledgedAt;
      }
      if (data.resolvedAt !== undefined) {
        sets.push('resolvedAt = @resolvedAt');
        params.resolvedAt = data.resolvedAt instanceof Date ? data.resolvedAt.toISOString() : data.resolvedAt;
      }
      if (data.closedAt !== undefined) {
        sets.push('closedAt = @closedAt');
        params.closedAt = data.closedAt instanceof Date ? data.closedAt.toISOString() : data.closedAt;
      }
      if (data.resolvedBy !== undefined) { sets.push('resolvedBy = @resolvedBy'); params.resolvedBy = data.resolvedBy; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.ruleName !== undefined) { sets.push('ruleName = @ruleName'); params.ruleName = data.ruleName; }
      if (data.actualValue !== undefined) { sets.push('actualValue = @actualValue'); params.actualValue = data.actualValue; }
      if (data.module !== undefined) { sets.push('module = @module'); params.module = data.module ?? null; }
      if (data.entityType !== undefined) { sets.push('entityType = @entityType'); params.entityType = data.entityType ?? null; }
      if (data.entityKey !== undefined) { sets.push('entityKey = @entityKey'); params.entityKey = data.entityKey ?? null; }
      if (data.baselineValue !== undefined) { sets.push('baselineValue = @baselineValue'); params.baselineValue = data.baselineValue ?? null; }
      if (data.lastValue !== undefined) { sets.push('lastValue = @lastValue'); params.lastValue = data.lastValue ?? null; }
      if (data.peakValue !== undefined) { sets.push('peakValue = @peakValue'); params.peakValue = data.peakValue ?? null; }
      if (data.autoResolved !== undefined) { sets.push('autoResolved = @autoResolved'); params.autoResolved = data.autoResolved === null ? null : this.toBoolInt(data.autoResolved); }
      if (data.acknowledgedBy !== undefined) { sets.push('acknowledgedBy = @acknowledgedBy'); params.acknowledgedBy = data.acknowledgedBy ?? null; }
      if (data.context !== undefined) { sets.push('context = @context'); params.context = data.context ? this.toJson(data.context) : null; }
      if (data.snoozedUntil !== undefined) { sets.push('snoozedUntil = @snoozedUntil'); params.snoozedUntil = isoOrNull(data.snoozedUntil); }
      if (data.snoozedBy !== undefined) { sets.push('snoozedBy = @snoozedBy'); params.snoozedBy = data.snoozedBy ?? null; }
      if (data.reopenedAt !== undefined) { sets.push('reopenedAt = @reopenedAt'); params.reopenedAt = isoOrNull(data.reopenedAt); }
      if (data.reopenCount !== undefined) { sets.push('reopenCount = @reopenCount'); params.reopenCount = data.reopenCount ?? null; }

      let where = 'id = @id';
      if (projectId !== undefined) { where += ' AND projectId = @scopeProjectId'; params.scopeProjectId = projectId; }
      const result = db.prepare(`UPDATE ${TABLES.incidents} SET ${sets.join(', ')} WHERE ${where}`).run(params);
      if (result.changes === 0) return null;
      return this.findIncidentById(id, projectId);
    }

    async findIncidentById(id: string, projectId?: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { id };
      let where = 'id = @id';
      if (projectId !== undefined) { where += ' AND projectId = @projectId'; params.projectId = projectId; }
      const row = db.prepare(`SELECT * FROM ${TABLES.incidents} WHERE ${where}`).get(params) as SqliteRow | undefined;
      return row ? this.mapIncidentRow(row) : null;
    }

    async findIncidentByAlertEventId(alertEventId: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.incidents} WHERE alertEventId = @alertEventId`,
      ).get({ alertEventId }) as SqliteRow | undefined;
      return row ? this.mapIncidentRow(row) : null;
    }

    async listIncidents(
      tenantId: string,
      options?: {
        projectId?: string;
        ruleId?: string;
        status?: IncidentStatus;
        severity?: IncidentSeverity;
        entityKey?: string;
        module?: AlertModule;
        updatedAfter?: Date;
        firedAfter?: Date;
        q?: string;
        assignee?: string | null;
        snoozed?: boolean;
        excludeId?: string;
        sort?: IncidentSort;
        limit?: number;
        skip?: number;
      },
    ): Promise<IIncident[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (options?.projectId) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      if (options?.ruleId) { clauses.push('ruleId = @ruleId'); params.ruleId = options.ruleId; }
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      if (options?.severity) { clauses.push('severity = @severity'); params.severity = options.severity; }
      if (options?.entityKey) { clauses.push('entityKey = @entityKey'); params.entityKey = options.entityKey; }
      if (options?.module) { clauses.push('module = @module'); params.module = options.module; }
      if (options?.updatedAfter) { clauses.push('updatedAt > @updatedAfter'); params.updatedAfter = options.updatedAfter.toISOString(); }
      if (options?.firedAfter) { clauses.push('firedAt >= @firedAfter'); params.firedAfter = options.firedAfter.toISOString(); }
      if (options?.excludeId) { clauses.push('id != @excludeId'); params.excludeId = options.excludeId; }
      const q = options?.q?.trim();
      if (q) {
        clauses.push(`(iam_fold(ruleName) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(entityKey) LIKE iam_fold(@q) ESCAPE '\\' OR iam_fold(metric) LIKE iam_fold(@q) ESCAPE '\\')`);
        params.q = toLikePattern(q);
      }
      if (options?.assignee === null) clauses.push('assignedTo IS NULL');
      else if (typeof options?.assignee === 'string') { clauses.push('assignedTo = @assignee'); params.assignee = options.assignee; }
      if (options?.snoozed !== undefined) {
        params.nowIso = this.now();
        clauses.push(options.snoozed
          ? 'snoozedUntil IS NOT NULL AND snoozedUntil > @nowIso'
          : '(snoozedUntil IS NULL OR snoozedUntil <= @nowIso)');
      }

      params.limit = clampLimit(options?.limit, 50);
      params.skip = clampSkip(options?.skip);
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.incidents} WHERE ${clauses.join(' AND ')} ORDER BY ${incidentOrderBy(options?.sort)} LIMIT @limit OFFSET @skip`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapIncidentRow(r));
    }

    async listIncidentStatRows(
      projectId: string,
      options: { firedSince?: Date; resolvedSince?: Date; limit?: number },
    ): Promise<IIncidentStatRow[]> {
      const db = this.getTenantDb();
      const or: string[] = [];
      const params: Record<string, unknown> = { projectId };
      if (options.firedSince) { or.push('firedAt >= @firedSince'); params.firedSince = options.firedSince.toISOString(); }
      if (options.resolvedSince) { or.push('(resolvedAt IS NOT NULL AND resolvedAt >= @resolvedSince)'); params.resolvedSince = options.resolvedSince.toISOString(); }
      if (or.length === 0) return [];
      const n = Number(options.limit);
      params.limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 5000) : 5000;
      const rows = db.prepare(
        `SELECT id, status, firedAt, acknowledgedAt, resolvedAt, closedAt, reopenedAt, autoResolved FROM ${TABLES.incidents}
         WHERE projectId = @projectId AND (${or.join(' OR ')}) ORDER BY firedAt DESC, id DESC LIMIT @limit`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => ({
        _id: r.id as string,
        status: r.status as IncidentStatus,
        firedAt: this.toDate(r.firedAt) ?? new Date(),
        acknowledgedAt: r.acknowledgedAt ? this.toDate(r.acknowledgedAt) : null,
        resolvedAt: r.resolvedAt ? this.toDate(r.resolvedAt) : null,
        closedAt: r.closedAt ? this.toDate(r.closedAt) : null,
        reopenedAt: r.reopenedAt ? this.toDate(r.reopenedAt) : null,
        ...(r.autoResolved !== null && r.autoResolved !== undefined ? { autoResolved: this.fromBoolInt(r.autoResolved) } : {}),
      }));
    }

    async countIncidents(
      tenantId: string,
      options?: { projectId?: string; status?: IncidentStatus },
    ): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (options?.projectId) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.incidents} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    async countIncidentsByStatus(projectId: string): Promise<Record<IncidentStatus, number>> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT status, COUNT(*) as cnt FROM ${TABLES.incidents} WHERE projectId = @projectId GROUP BY status`,
      ).all({ projectId }) as SqliteRow[];
      const counts = Object.fromEntries(INCIDENT_STATUSES.map((st) => [st, 0])) as Record<IncidentStatus, number>;
      for (const row of rows) {
        const status = row.status as IncidentStatus;
        if (status in counts) counts[status] = (row.cnt as number) || 0;
      }
      return counts;
    }

    protected mapIncidentRow(r: SqliteRow): IIncident {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        alertEventId: r.alertEventId as string,
        ruleId: r.ruleId as string,
        ruleName: r.ruleName as string,
        metric: r.metric as IIncident['metric'],
        threshold: r.threshold as number,
        actualValue: r.actualValue as number,
        severity: r.severity as IIncident['severity'],
        status: r.status as IIncident['status'],
        assignedTo: r.assignedTo as string | undefined,
        notes: this.parseJson(r.notes, []),
        firedAt: this.toDate(r.firedAt) ?? new Date(),
        acknowledgedAt: r.acknowledgedAt ? this.toDate(r.acknowledgedAt) : undefined,
        resolvedAt: r.resolvedAt ? this.toDate(r.resolvedAt) : undefined,
        closedAt: r.closedAt ? this.toDate(r.closedAt) : undefined,
        resolvedBy: r.resolvedBy as string | undefined,
        ...(r.module ? { module: r.module as IIncident['module'] } : {}),
        ...(r.entityType ? { entityType: r.entityType as IIncident['entityType'] } : {}),
        ...(r.entityKey !== null && r.entityKey !== undefined ? { entityKey: r.entityKey as string } : {}),
        ...(r.baselineValue !== null && r.baselineValue !== undefined ? { baselineValue: r.baselineValue as number } : {}),
        ...(r.lastValue !== null && r.lastValue !== undefined ? { lastValue: r.lastValue as number } : {}),
        ...(r.peakValue !== null && r.peakValue !== undefined ? { peakValue: r.peakValue as number } : {}),
        ...(r.autoResolved !== null && r.autoResolved !== undefined ? { autoResolved: this.fromBoolInt(r.autoResolved) } : {}),
        ...(r.acknowledgedBy ? { acknowledgedBy: r.acknowledgedBy as string } : {}),
        ...(r.context ? { context: this.parseJson(r.context, undefined) } : {}),
        ...(r.snoozedUntil ? { snoozedUntil: this.toDate(r.snoozedUntil) } : {}),
        ...(r.snoozedBy ? { snoozedBy: r.snoozedBy as string } : {}),
        ...(r.reopenedAt ? { reopenedAt: this.toDate(r.reopenedAt) } : {}),
        ...(r.reopenCount !== null && r.reopenCount !== undefined ? { reopenCount: r.reopenCount as number } : {}),
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
