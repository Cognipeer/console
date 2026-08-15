/**
 * SQLite Provider – External model pricing mixin
 *
 * Mirrors mongodb/external-model-pricing.mixin.ts. `projectId` uses ''
 * (never NULL) for tenant-wide entries — NULLs are distinct in SQLite UNIQUE
 * constraints, which would allow duplicate tenant-wide rows.
 */

import type { IExternalModelPricing, IExternalPricingVersion, IModelPricing } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ExternalModelPricingMixin<TBase extends Constructor<SQLiteProviderBase>>(
  Base: TBase,
) {
  return class ExternalModelPricingOps extends Base {
    async upsertExternalModelPricing(entry: {
      tenantId: string;
      projectId?: string;
      modelName: string;
      pricing: IModelPricing;
      versions?: IExternalPricingVersion[];
      updatedBy?: string;
    }): Promise<IExternalModelPricing> {
      const db = this.getTenantDb();
      const modelName = entry.modelName.trim();
      const params = {
        id: this.newId(),
        tenantId: entry.tenantId,
        projectId: entry.projectId ?? '',
        modelName,
        normalizedName: modelName.toLowerCase(),
        pricing: this.toJson(entry.pricing),
        versions: entry.versions ? this.toJson(entry.versions) : null,
        updatedBy: entry.updatedBy ?? null,
        now: this.now(),
      };

      db.prepare(`
        INSERT INTO ${TABLES.externalModelPricing}
        (id, tenantId, projectId, modelName, normalizedName, pricing, versions, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @modelName, @normalizedName, @pricing, @versions, @updatedBy, @updatedBy, @now, @now)
        ON CONFLICT(tenantId, projectId, normalizedName) DO UPDATE SET
          modelName = @modelName,
          pricing = @pricing,
          versions = @versions,
          updatedBy = @updatedBy,
          updatedAt = @now
      `).run(params);

      const row = db.prepare(`
        SELECT * FROM ${TABLES.externalModelPricing}
        WHERE tenantId = @tenantId AND projectId = @projectId AND normalizedName = @normalizedName
      `).get(params) as SqliteRow;
      return this.mapExternalModelPricingRow(row);
    }

    async listExternalModelPricing(projectId?: string): Promise<IExternalModelPricing[]> {
      const db = this.getTenantDb();
      const where = projectId === undefined
        ? ''
        : "WHERE (projectId = @projectId OR projectId = '')";
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.externalModelPricing}
        ${where}
        ORDER BY modelName ASC
      `).all(projectId === undefined ? {} : { projectId }) as SqliteRow[];
      return rows.map((row) => this.mapExternalModelPricingRow(row));
    }

    async deleteExternalModelPricing(modelName: string, projectId?: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`
        DELETE FROM ${TABLES.externalModelPricing}
        WHERE projectId = @projectId AND normalizedName = @normalizedName
      `).run({
        projectId: projectId ?? '',
        normalizedName: modelName.trim().toLowerCase(),
      });
      return result.changes > 0;
    }

    private mapExternalModelPricingRow(row: SqliteRow): IExternalModelPricing {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: String(row.projectId ?? ''),
        modelName: String(row.modelName),
        normalizedName: String(row.normalizedName),
        pricing: this.parseJson<IModelPricing>(row.pricing, {
          inputTokenPer1M: 0,
          outputTokenPer1M: 0,
        }),
        versions: row.versions
          ? this.parseJson<IExternalPricingVersion[]>(row.versions, [])
          : undefined,
        createdBy: (row.createdBy as string | null) ?? undefined,
        updatedBy: (row.updatedBy as string | null) ?? undefined,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
      };
    }
  };
}
