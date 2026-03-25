/**
 * SQLite Provider – Unified provider record operations mixin
 */

import type { IProviderRecord, ProviderDomain } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ProviderRecordMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ProviderRecordOps extends Base {

    async createProvider(provider: Omit<IProviderRecord, '_id' | 'createdAt' | 'updatedAt'>): Promise<IProviderRecord> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.providers}
        (id, tenantId, projectId, projectIds, key, type, driver, label, description, status,
         credentialsEnc, settings, capabilitiesOverride, metadata, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @projectIds, @key, @type, @driver, @label, @description, @status,
         @credentialsEnc, @settings, @capabilitiesOverride, @metadata, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: provider.tenantId,
        projectId: provider.projectId ?? null,
        projectIds: this.toJson(provider.projectIds ?? []),
        key: provider.key,
        type: provider.type,
        driver: provider.driver,
        label: provider.label,
        description: provider.description ?? null,
        status: provider.status,
        credentialsEnc: provider.credentialsEnc,
        settings: this.toJson(provider.settings ?? {}),
        capabilitiesOverride: this.toJson(provider.capabilitiesOverride ?? []),
        metadata: this.toJson(provider.metadata ?? {}),
        createdBy: provider.createdBy,
        updatedBy: provider.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return { ...provider, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async updateProvider(
      id: string,
      data: Partial<Omit<IProviderRecord, 'tenantId' | 'key'>>,
    ): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.label !== undefined) { sets.push('label = @label'); params.label = data.label; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.credentialsEnc !== undefined) { sets.push('credentialsEnc = @credentialsEnc'); params.credentialsEnc = data.credentialsEnc; }
      if (data.settings !== undefined) { sets.push('settings = @settings'); params.settings = this.toJson(data.settings); }
      if (data.capabilitiesOverride !== undefined) { sets.push('capabilitiesOverride = @capabilitiesOverride'); params.capabilitiesOverride = this.toJson(data.capabilitiesOverride); }
      if (data.metadata !== undefined) { sets.push('metadata = @metadata'); params.metadata = this.toJson(data.metadata); }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.driver !== undefined) { sets.push('driver = @driver'); params.driver = data.driver; }
      if (data.type !== undefined) { sets.push('type = @type'); params.type = data.type; }
      if (data.projectId !== undefined) { sets.push('projectId = @projectId'); params.projectId = data.projectId; }
      if (data.projectIds !== undefined) { sets.push('projectIds = @projectIds'); params.projectIds = this.toJson(data.projectIds); }

      db.prepare(`UPDATE ${TABLES.providers} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findProviderById(id);
    }

    async findProviderById(id: string): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.providers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapProviderRow(row) : null;
    }

    async findProviderByKey(tenantId: string, key: string, projectId?: string): Promise<IProviderRecord | null> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { tenantId, key };
      let sql: string;
      if (projectId) {
        // Support legacy single-project providers (projectId) and multi-assigned providers (projectIds JSON array)
        sql = `SELECT * FROM ${TABLES.providers} WHERE tenantId = @tenantId AND key = @key AND (projectId = @projectId OR projectIds LIKE @projectIdLike)`;
        params.projectId = projectId;
        params.projectIdLike = `%"${projectId}"%`;
      } else {
        sql = `SELECT * FROM ${TABLES.providers} WHERE tenantId = @tenantId AND key = @key`;
      }
      const row = db.prepare(sql).get(params) as SqliteRow | undefined;
      return row ? this.mapProviderRow(row) : null;
    }

    async listProviders(
      tenantId: string,
      filters?: { type?: ProviderDomain; driver?: string; status?: IProviderRecord['status']; projectId?: string },
    ): Promise<IProviderRecord[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };

      if (filters?.type) { clauses.push('type = @type'); params.type = filters.type; }
      if (filters?.driver) { clauses.push('driver = @driver'); params.driver = filters.driver; }
      if (filters?.status) { clauses.push('status = @status'); params.status = filters.status; }
      if (filters?.projectId) {
        clauses.push('(projectId = @projectId OR projectIds LIKE @projectIdLike)');
        params.projectId = filters.projectId;
        params.projectIdLike = `%"${filters.projectId}"%`;
      }

      const where = `WHERE ${clauses.join(' AND ')}`;
      const rows = db.prepare(`SELECT * FROM ${TABLES.providers} ${where} ORDER BY createdAt DESC`)
        .all(params) as SqliteRow[];
      return rows.map((r) => this.mapProviderRow(r));
    }

    async deleteProvider(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.providers} WHERE id = @id`).run({ id }).changes > 0;
    }

    // ── Rate limiting ────────────────────────────────────────────────

    async incrementRateLimit(
      key: string,
      windowSeconds: number,
      amount: number = 1,
    ): Promise<{ count: number; resetAt: Date }> {
      const db = this.getTenantDb();
      const now = new Date();
      const resetAt = new Date(now.getTime() + windowSeconds * 1000);
      const nowIso = now.toISOString();
      const resetAtIso = resetAt.toISOString();

      // Try to find existing record
      const existing = db.prepare(
        `SELECT count, resetAt FROM ${TABLES.rateLimits} WHERE key = @key`,
      ).get({ key }) as { count: number; resetAt: string } | undefined;

      if (!existing || existing.resetAt < nowIso) {
        // Expired or not found → upsert with new window
        db.prepare(`
          INSERT INTO ${TABLES.rateLimits} (key, count, resetAt) VALUES (@key, @amount, @resetAt)
          ON CONFLICT(key) DO UPDATE SET count = @amount, resetAt = @resetAt
        `).run({ key, amount, resetAt: resetAtIso });
        return { count: amount, resetAt };
      }

      // Active window → increment
      db.prepare(
        `UPDATE ${TABLES.rateLimits} SET count = count + @amount WHERE key = @key`,
      ).run({ key, amount });

      const updated = db.prepare(
        `SELECT count, resetAt FROM ${TABLES.rateLimits} WHERE key = @key`,
      ).get({ key }) as { count: number; resetAt: string };

      return { count: updated.count, resetAt: new Date(updated.resetAt) };
    }

    protected mapProviderRow(r: SqliteRow): IProviderRecord {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        projectId: r.projectId as string | undefined,
        projectIds: this.parseJson<string[]>(r.projectIds, []),
        key: r.key as string,
        type: r.type as ProviderDomain,
        driver: r.driver as string,
        label: r.label as string,
        description: r.description as string | undefined,
        status: r.status as IProviderRecord['status'],
        credentialsEnc: r.credentialsEnc as string,
        settings: this.parseJson(r.settings, {}),
        capabilitiesOverride: this.parseJson<string[]>(r.capabilitiesOverride, []),
        metadata: this.parseJson(r.metadata, {}),
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
