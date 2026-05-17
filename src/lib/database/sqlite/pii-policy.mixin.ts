/**
 * SQLite Provider – PII Policy operations mixin
 *
 * CRUD for tenant-scoped PII policies. Policies are reusable named configurations
 * that the PII service consumes for detect / redact / mask / scan operations.
 */

import type { IPiiPolicy } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function PiiPolicyMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class PiiPolicyOps extends Base {
    async createPiiPolicy(
      policy: Omit<IPiiPolicy, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPiiPolicy> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.piiPolicies}
        (id, tenantId, projectId, key, name, description, defaultAction,
         categories, customPatterns, languages, enabled, metadata,
         createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @key, @name, @description, @defaultAction,
         @categories, @customPatterns, @languages, @enabled, @metadata,
         @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: policy.tenantId,
        projectId: policy.projectId ?? null,
        key: policy.key,
        name: policy.name,
        description: policy.description ?? null,
        defaultAction: policy.defaultAction,
        categories: this.toJson(policy.categories ?? {}),
        customPatterns: this.toJson(policy.customPatterns ?? []),
        languages: this.toJson(policy.languages ?? []),
        enabled: this.toBoolInt(policy.enabled),
        metadata: this.toJson(policy.metadata ?? {}),
        createdBy: policy.createdBy,
        updatedBy: policy.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...policy, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updatePiiPolicy(
      id: string,
      data: Partial<Omit<IPiiPolicy, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.defaultAction !== undefined) { sets.push('defaultAction = @defaultAction'); params.defaultAction = data.defaultAction; }
      if (data.categories !== undefined) { sets.push('categories = @categories'); params.categories = this.toJson(data.categories); }
      if (data.customPatterns !== undefined) { sets.push('customPatterns = @customPatterns'); params.customPatterns = this.toJson(data.customPatterns); }
      if (data.languages !== undefined) { sets.push('languages = @languages'); params.languages = this.toJson(data.languages); }
      if (data.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = this.toBoolInt(data.enabled); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }

      db.prepare(`UPDATE ${TABLES.piiPolicies} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findPiiPolicyById(id);
    }

    async deletePiiPolicy(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.piiPolicies} WHERE id = @id`).run({ id }).changes === 1;
    }

    async findPiiPolicyById(id: string): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.piiPolicies} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapPiiPolicyRow(row) : null;
    }

    async findPiiPolicyByKey(key: string, projectId?: string): Promise<IPiiPolicy | null> {
      const db = this.getTenantDb();
      const clauses: string[] = ['key = @key'];
      const params: Record<string, unknown> = { key };
      if (projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = projectId; }
      const row = db.prepare(
        `SELECT * FROM ${TABLES.piiPolicies} WHERE ${clauses.join(' AND ')}`,
      ).get(params) as SqliteRow | undefined;
      return row ? this.mapPiiPolicyRow(row) : null;
    }

    async listPiiPolicies(filters?: {
      projectId?: string;
      enabled?: boolean;
      search?: string;
    }): Promise<IPiiPolicy[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId; }
      if (filters?.enabled !== undefined) { clauses.push('enabled = @enabled'); params.enabled = this.toBoolInt(filters.enabled); }
      if (filters?.search) {
        clauses.push('(name LIKE @search OR description LIKE @search OR key LIKE @search)');
        params.search = this.likePattern(filters.search);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.piiPolicies} ${where} ORDER BY createdAt DESC`,
      ).all(params) as SqliteRow[];
      return rows.map((r) => this.mapPiiPolicyRow(r));
    }

    protected mapPiiPolicyRow(r: SqliteRow): IPiiPolicy {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        key: r.key as string,
        name: r.name as string,
        description: r.description as string | undefined,
        defaultAction: r.defaultAction as IPiiPolicy['defaultAction'],
        categories: this.parseJson(r.categories, {}),
        customPatterns: this.parseJson(r.customPatterns, []),
        languages: this.parseJson(r.languages, []),
        enabled: this.fromBoolInt(r.enabled),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
