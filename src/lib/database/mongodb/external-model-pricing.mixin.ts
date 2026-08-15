/**
 * MongoDB Provider – External model pricing mixin
 *
 * Reference prices for models observed via agent observability (traces) that
 * are not in the Model Hub. Small per-tenant catalog; matched by lowercased
 * model name. `projectId` uses '' (never null) for tenant-wide entries so the
 * unique index stays deterministic across providers.
 */

import type { IExternalModelPricing, IExternalPricingVersion, IModelPricing } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

interface ExternalModelPricingDoc {
  tenantId: string;
  projectId: string;
  modelName: string;
  normalizedName: string;
  pricing: IModelPricing;
  versions?: IExternalPricingVersion[];
  createdBy?: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export function ExternalModelPricingMixin<TBase extends Constructor<MongoDBProviderBase>>(
  Base: TBase,
) {
  return class ExternalModelPricingOps extends Base {
    private externalPricingIndexReady = new Set<string>();

    private async ensureExternalPricingIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.externalPricingIndexReady.has(dbName)) return;
      this.externalPricingIndexReady.add(dbName);
      try {
        await db.collection(COLLECTIONS.externalModelPricing).createIndex(
          { tenantId: 1, projectId: 1, normalizedName: 1 },
          { unique: true, name: 'uniq_external_model_pricing' },
        );
      } catch (error) {
        logger.warn('Could not ensure external_model_pricing index', { dbName, error });
      }
    }

    async upsertExternalModelPricing(entry: {
      tenantId: string;
      projectId?: string;
      modelName: string;
      pricing: IModelPricing;
      versions?: IExternalPricingVersion[];
      updatedBy?: string;
    }): Promise<IExternalModelPricing> {
      await this.ensureExternalPricingIndexes();
      const db = this.getTenantDb();
      const col = db.collection<ExternalModelPricingDoc>(COLLECTIONS.externalModelPricing);
      const modelName = entry.modelName.trim();
      const filter = {
        tenantId: entry.tenantId,
        projectId: entry.projectId ?? '',
        normalizedName: modelName.toLowerCase(),
      };

      await col.updateOne(
        filter,
        {
          $set: {
            modelName,
            pricing: entry.pricing,
            versions: entry.versions,
            updatedBy: entry.updatedBy,
            updatedAt: new Date(),
          },
          $setOnInsert: {
            ...filter,
            createdBy: entry.updatedBy,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );

      const doc = await col.findOne(filter);
      return this.mapExternalModelPricing(doc!);
    }

    async listExternalModelPricing(projectId?: string): Promise<IExternalModelPricing[]> {
      const db = this.getTenantDb();
      const query =
        projectId === undefined ? {} : { projectId: { $in: [projectId, ''] } };
      const docs = await db
        .collection<ExternalModelPricingDoc>(COLLECTIONS.externalModelPricing)
        .find(query)
        .sort({ modelName: 1 })
        .toArray();
      return docs.map((doc) => this.mapExternalModelPricing(doc));
    }

    async deleteExternalModelPricing(modelName: string, projectId?: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<ExternalModelPricingDoc>(COLLECTIONS.externalModelPricing)
        .deleteOne({
          projectId: projectId ?? '',
          normalizedName: modelName.trim().toLowerCase(),
        });
      return result.deletedCount > 0;
    }

    private mapExternalModelPricing(
      doc: ExternalModelPricingDoc & { _id?: unknown },
    ): IExternalModelPricing {
      return {
        _id: doc._id?.toString(),
        tenantId: doc.tenantId,
        projectId: doc.projectId,
        modelName: doc.modelName,
        normalizedName: doc.normalizedName,
        pricing: doc.pricing,
        versions: doc.versions,
        createdBy: doc.createdBy,
        updatedBy: doc.updatedBy,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      };
    }
  };
}
