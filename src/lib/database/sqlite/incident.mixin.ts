/**
 * SQLite Provider – Incident operations mixin
 *
 * Incidents are created when alerts fire and track resolution lifecycle.
 */

import type { IIncident, IncidentStatus, IncidentSeverity } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

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
         metadata, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @alertEventId, @ruleId, @ruleName, @metric,
         @threshold, @actualValue, @severity, @status, @assignedTo, @notes,
         @firedAt, @acknowledgedAt, @resolvedAt, @closedAt, @resolvedBy,
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
        metadata: this.toJson(incident.metadata ?? {}),
        createdAt: now,
        updatedAt: now,
      });

      return { ...incident, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateIncident(
      id: string,
      data: Partial<Omit<IIncident, 'tenantId' | 'alertEventId' | 'ruleId'>>,
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

      db.prepare(`UPDATE ${TABLES.incidents} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findIncidentById(id);
    }

    async findIncidentById(id: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.incidents} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
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

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.incidents} WHERE ${clauses.join(' AND ')} ORDER BY firedAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapIncidentRow(r));
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
        metadata: this.parseJson(r.metadata, {}),
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
