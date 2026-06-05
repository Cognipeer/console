/**
 * SQLite Provider – Quota policy operations mixin
 */

import type { IQuotaPolicy } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function QuotaMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class QuotaOps extends Base {

    async createQuotaPolicy(policy: Omit<IQuotaPolicy, '_id'>): Promise<IQuotaPolicy> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.quotaPolicies}
        (id, tenantId, projectId, scope, scopeId, domain, priority, enabled, label, description, limits, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @scope, @scopeId, @domain, @priority, @enabled, @label, @description, @limits, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: policy.tenantId,
        projectId: policy.projectId ?? null,
        scope: policy.scope,
        scopeId: policy.scopeId ?? null,
        domain: policy.domain,
        priority: policy.priority ?? 100,
        enabled: this.toBoolInt(policy.enabled ?? true),
        label: policy.label ?? null,
        description: policy.description ?? null,
        limits: this.toJson(policy.limits),
        createdBy: policy.createdBy ?? null,
        updatedBy: policy.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...policy, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async listQuotaPolicies(tenantId: string, projectId?: string): Promise<IQuotaPolicy[]> {
      const db = this.getTenantDb();
      let sql = `SELECT * FROM ${TABLES.quotaPolicies} WHERE tenantId = @tenantId`;
      const params: Record<string, unknown> = { tenantId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      sql += ' ORDER BY priority ASC, createdAt DESC';
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapQuotaRow(r));
    }

    async updateQuotaPolicy(
      id: string, tenantId: string, data: Partial<IQuotaPolicy>, projectId?: string,
    ): Promise<IQuotaPolicy | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, tenantId, updatedAt: now };

      if (data.limits !== undefined) { sets.push('limits = @limits'); params.limits = this.toJson(data.limits); }
      if (data.scope !== undefined) { sets.push('scope = @scope'); params.scope = data.scope; }
      if (data.scopeId !== undefined) { sets.push('scopeId = @scopeId'); params.scopeId = data.scopeId ?? null; }
      if (data.domain !== undefined) { sets.push('domain = @domain'); params.domain = data.domain; }
      if (data.priority !== undefined) { sets.push('priority = @priority'); params.priority = data.priority; }
      if (data.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = this.toBoolInt(data.enabled); }
      if (data.label !== undefined) { sets.push('label = @label'); params.label = data.label ?? null; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description ?? null; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy ?? null; }

      let where = 'id = @id AND tenantId = @tenantId';
      if (projectId) { where += ' AND projectId = @projectId'; params.projectId = projectId; }

      db.prepare(`UPDATE ${TABLES.quotaPolicies} SET ${sets.join(', ')} WHERE ${where}`).run(params);

      const row = db.prepare(`SELECT * FROM ${TABLES.quotaPolicies} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapQuotaRow(row) : null;
    }

    async deleteQuotaPolicy(id: string, tenantId: string, projectId?: string): Promise<boolean> {
      const db = this.getTenantDb();
      let sql = `DELETE FROM ${TABLES.quotaPolicies} WHERE id = @id AND tenantId = @tenantId`;
      const params: Record<string, unknown> = { id, tenantId };
      if (projectId) { sql += ' AND projectId = @projectId'; params.projectId = projectId; }
      return db.prepare(sql).run(params).changes > 0;
    }

    protected mapQuotaRow(r: SqliteRow): IQuotaPolicy {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        scope: r.scope as IQuotaPolicy['scope'],
        scopeId: r.scopeId as string | undefined,
        domain: r.domain as IQuotaPolicy['domain'],
        priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
        enabled: r.enabled === undefined || r.enabled === null ? true : this.fromBoolInt(r.enabled),
        label: r.label as string | undefined,
        description: r.description as string | undefined,
        limits: this.parseJson(r.limits, {}),
        createdBy: r.createdBy as string | undefined,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      } as IQuotaPolicy;
    }
  };
}
