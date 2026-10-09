/**
 * MongoDB Provider – IAM document store mixin.
 *
 * Generic id → JSON document store for the policy engine (custom policies,
 * policy-version counter, shadow-mode aggregates). Collections are created on
 * first write by MongoDB itself; there is no index requirement (documents are
 * addressed by `_id`).
 *
 * Single-database mode makes every tenant share one physical database, so each
 * document is keyed `<tenantDbName>::<id>` and carries its tenant label; every
 * read is filtered by it. In database-per-tenant mode the label is redundant
 * but harmless, which keeps both layouts on a single code path.
 */

import { IAM_COLLECTIONS, type IIamDoc, type IamCollectionName } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase } from './base';

interface IamDocRow {
  _id: string;
  tenant: string;
  id: string;
  data: Record<string, unknown>;
  updatedAt: Date;
}

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertCollection(collection: string): asserts collection is IamCollectionName {
  if (!(IAM_COLLECTIONS as readonly string[]).includes(collection)) {
    throw new Error(`Unknown IAM collection "${collection}"`);
  }
}

export function IamDocsMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class IamDocsOps extends Base {
    private iamTenantKey(): string {
      return this.getCurrentTenantDbName() ?? '';
    }

    private iamCollection(collection: IamCollectionName) {
      assertCollection(collection);
      return this.getTenantDb().collection<IamDocRow>(collection);
    }

    private mapIamDoc(row: IamDocRow): IIamDoc {
      return { id: row.id, data: row.data ?? {}, updatedAt: row.updatedAt };
    }

    async iamDocGet(collection: IamCollectionName, id: string): Promise<IIamDoc | null> {
      const tenant = this.iamTenantKey();
      const row = await this.iamCollection(collection).findOne({ _id: `${tenant}::${id}` });
      return row ? this.mapIamDoc(row) : null;
    }

    async iamDocPut(
      collection: IamCollectionName,
      id: string,
      data: Record<string, unknown>,
    ): Promise<IIamDoc> {
      const tenant = this.iamTenantKey();
      const row: IamDocRow = { _id: `${tenant}::${id}`, tenant, id, data, updatedAt: new Date() };
      await this.iamCollection(collection).replaceOne({ _id: row._id }, row, { upsert: true });
      return this.mapIamDoc(row);
    }

    async iamDocList(
      collection: IamCollectionName,
      options: { idPrefix?: string; limit?: number } = {},
    ): Promise<IIamDoc[]> {
      const tenant = this.iamTenantKey();
      const filter: Record<string, unknown> = { tenant };
      if (options.idPrefix) filter.id = { $regex: `^${this.escapeRegex(options.idPrefix)}` };
      const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
      const rows = await this.iamCollection(collection)
        .find(filter)
        .sort({ id: 1 })
        .limit(limit)
        .toArray();
      return rows.map((row) => this.mapIamDoc(row));
    }

    async iamDocDelete(collection: IamCollectionName, id: string): Promise<boolean> {
      const tenant = this.iamTenantKey();
      const result = await this.iamCollection(collection).deleteOne({ _id: `${tenant}::${id}` });
      return result.deletedCount === 1;
    }

    async iamDocClear(collection: IamCollectionName): Promise<number> {
      const tenant = this.iamTenantKey();
      const result = await this.iamCollection(collection).deleteMany({ tenant });
      return result.deletedCount ?? 0;
    }

    async iamDocIncrement(
      collection: IamCollectionName,
      id: string,
      field: string,
      by = 1,
    ): Promise<number> {
      if (!FIELD_RE.test(field)) throw new Error(`Invalid IAM counter field "${field}"`);
      const tenant = this.iamTenantKey();
      const result = await this.iamCollection(collection).findOneAndUpdate(
        { _id: `${tenant}::${id}` },
        {
          $inc: { [`data.${field}`]: by },
          $set: { updatedAt: new Date() },
          $setOnInsert: { tenant, id },
        },
        { upsert: true, returnDocument: 'after' },
      );
      const value = result?.data?.[field];
      return typeof value === 'number' ? value : by;
    }
  };
}
