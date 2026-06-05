/**
 * SQLite Provider – Alert operations mixin
 *
 * Includes alert rules and alert events (history).
 */

import type { IAlertRule, IAlertEvent, AlertEventStatus } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function AlertMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AlertOps extends Base {
    // ── Alert rule operations ────────────────────────────────────────

    async createAlertRule(
      rule: Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAlertRule> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.alertRules}
        (id, tenantId, projectId, name, description, module, enabled, metric,
         condition, windowMinutes, cooldownMinutes, scope, channels,
         lastTriggeredAt, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @name, @description, @module, @enabled, @metric,
         @condition, @windowMinutes, @cooldownMinutes, @scope, @channels,
         @lastTriggeredAt, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: rule.tenantId,
        projectId: rule.projectId,
        name: rule.name,
        description: rule.description ?? null,
        module: rule.module,
        enabled: this.toBoolInt(rule.enabled),
        metric: rule.metric,
        condition: this.toJson(rule.condition),
        windowMinutes: rule.windowMinutes,
        cooldownMinutes: rule.cooldownMinutes,
        scope: this.toJson(rule.scope ?? {}),
        channels: this.toJson(rule.channels),
        lastTriggeredAt: rule.lastTriggeredAt ? rule.lastTriggeredAt.toISOString() : null,
        createdBy: rule.createdBy,
        updatedBy: rule.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...rule, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateAlertRule(
      id: string,
      data: Partial<Omit<IAlertRule, 'tenantId' | 'createdBy'>>,
    ): Promise<IAlertRule | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.module !== undefined) { sets.push('module = @module'); params.module = data.module; }
      if (data.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = this.toBoolInt(data.enabled); }
      if (data.metric !== undefined) { sets.push('metric = @metric'); params.metric = data.metric; }
      if (data.condition !== undefined) { sets.push('condition = @condition'); params.condition = this.toJson(data.condition); }
      if (data.windowMinutes !== undefined) { sets.push('windowMinutes = @windowMinutes'); params.windowMinutes = data.windowMinutes; }
      if (data.cooldownMinutes !== undefined) { sets.push('cooldownMinutes = @cooldownMinutes'); params.cooldownMinutes = data.cooldownMinutes; }
      if (data.scope !== undefined) { sets.push('scope = @scope'); params.scope = this.toJson(data.scope); }
      if (data.channels !== undefined) { sets.push('channels = @channels'); params.channels = this.toJson(data.channels); }
      if (data.lastTriggeredAt !== undefined) { sets.push('lastTriggeredAt = @lastTriggeredAt'); params.lastTriggeredAt = data.lastTriggeredAt instanceof Date ? data.lastTriggeredAt.toISOString() : data.lastTriggeredAt; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }

      db.prepare(`UPDATE ${TABLES.alertRules} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAlertRuleById(id);
    }

    async deleteAlertRule(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.alertRules} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findAlertRuleById(id: string): Promise<IAlertRule | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.alertRules} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapRuleRow(row) : null;
    }

    async listAlertRules(
      tenantId: string,
      filters?: { projectId?: string; enabled?: boolean },
    ): Promise<IAlertRule[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.enabled !== undefined) { clauses.push('enabled = @enabled'); params.enabled = this.toBoolInt(filters.enabled); }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.alertRules} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapRuleRow(r));
    }

    // ── Alert event (history) operations ─────────────────────────────

    async createAlertEvent(
      event: Omit<IAlertEvent, '_id'>,
    ): Promise<IAlertEvent> {
      const db = this.getTenantDb();
      const id = this.newId();

      db.prepare(`
        INSERT INTO ${TABLES.alertEvents}
        (id, tenantId, projectId, ruleId, ruleName, metric, threshold, actualValue,
         status, channels, firedAt, resolvedAt, metadata)
        VALUES (@id, @tenantId, @projectId, @ruleId, @ruleName, @metric, @threshold, @actualValue,
         @status, @channels, @firedAt, @resolvedAt, @metadata)
      `).run({
        id,
        tenantId: event.tenantId,
        projectId: event.projectId,
        ruleId: event.ruleId,
        ruleName: event.ruleName,
        metric: event.metric,
        threshold: event.threshold,
        actualValue: event.actualValue,
        status: event.status,
        channels: this.toJson(event.channels),
        firedAt: event.firedAt instanceof Date ? event.firedAt.toISOString() : event.firedAt,
        resolvedAt: event.resolvedAt ? (event.resolvedAt instanceof Date ? event.resolvedAt.toISOString() : event.resolvedAt) : null,
        metadata: this.toJson(event.metadata ?? {}),
      });

      return { ...event, _id: id };
    }

    async listAlertEvents(
      tenantId: string,
      options?: {
        projectId?: string;
        ruleId?: string;
        status?: AlertEventStatus;
        limit?: number;
        skip?: number;
      },
    ): Promise<IAlertEvent[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (options?.projectId) { clauses.push('projectId = @projectId'); params.projectId = options.projectId; }
      if (options?.ruleId) { clauses.push('ruleId = @ruleId'); params.ruleId = options.ruleId; }
      if (options?.status) { clauses.push('status = @status'); params.status = options.status; }

      const limit = options?.limit ?? 50;
      const skip = options?.skip ?? 0;
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.alertEvents} WHERE ${clauses.join(' AND ')} ORDER BY firedAt DESC LIMIT ${limit} OFFSET ${skip}`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapEventRow(r));
    }

    async updateAlertEvent(
      id: string,
      data: Partial<IAlertEvent>,
    ): Promise<IAlertEvent | null> {
      const db = this.getTenantDb();
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };

      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.resolvedAt !== undefined) { sets.push('resolvedAt = @resolvedAt'); params.resolvedAt = data.resolvedAt instanceof Date ? data.resolvedAt.toISOString() : data.resolvedAt; }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }

      if (sets.length === 0) return this.findAlertEventById(id);
      db.prepare(`UPDATE ${TABLES.alertEvents} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findAlertEventById(id);
    }

    async countActiveAlerts(tenantId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const clauses: string[] = ["tenantId = @tenantId", "status = 'fired'"];
      const params: Record<string, unknown> = { tenantId };
      if (projectId) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${TABLES.alertEvents} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow;
      return (row.cnt as number) || 0;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    protected async findAlertEventById(id: string): Promise<IAlertEvent | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.alertEvents} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapEventRow(row) : null;
    }

    protected mapRuleRow(r: SqliteRow): IAlertRule {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        name: r.name as string,
        description: r.description as string | undefined,
        module: r.module as IAlertRule['module'],
        enabled: this.fromBoolInt(r.enabled),
        metric: r.metric as IAlertRule['metric'],
        condition: this.parseJson(r.condition, { operator: 'gt', threshold: 0 }),
        windowMinutes: r.windowMinutes as number,
        cooldownMinutes: r.cooldownMinutes as number,
        scope: this.parseJson(r.scope, {}),
        channels: this.parseJson(r.channels, []),
        lastTriggeredAt: r.lastTriggeredAt ? this.toDate(r.lastTriggeredAt) : undefined,
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapEventRow(r: SqliteRow): IAlertEvent {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string,
        ruleId: r.ruleId as string,
        ruleName: r.ruleName as string,
        metric: r.metric as IAlertEvent['metric'],
        threshold: r.threshold as number,
        actualValue: r.actualValue as number,
        status: r.status as IAlertEvent['status'],
        channels: this.parseJson(r.channels, []),
        firedAt: this.toDate(r.firedAt) ?? new Date(),
        resolvedAt: r.resolvedAt ? this.toDate(r.resolvedAt) : undefined,
        metadata: this.parseJson(r.metadata, {}),
      };
    }
  };
}
