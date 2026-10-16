/**
 * MongoDB Provider – Alert channel library mixin
 *
 * Tenant-wide reusable notification channels (secrets stay sealed inside
 * `config`). Collection `alert_channel_library`, created on first write; the
 * set is tiny and always read per tenant, so no index is needed.
 */

import { ObjectId } from 'mongodb';
import type { IAlertChannelLibraryEntry } from '../provider/types.domain';
import type { Constructor } from './types';
import { MongoDBProviderBase } from './base';

const COLLECTION = 'alert_channel_library';

const toEntry = (doc: Record<string, unknown>): IAlertChannelLibraryEntry =>
  ({ ...doc, _id: String(doc._id) }) as unknown as IAlertChannelLibraryEntry;

function idFilter(id: string): { _id: ObjectId } | null {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
  return { _id: new ObjectId(id) };
}

export function AlertChannelLibraryMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AlertChannelLibraryOps extends Base {
    async listAlertChannelLibrary(tenantId: string): Promise<IAlertChannelLibraryEntry[]> {
      const docs = await this.getTenantDb()
        .collection(COLLECTION)
        .find({ tenantId })
        .sort({ name: 1 })
        .limit(500)
        .toArray();
      return docs.map((doc) => toEntry(doc as Record<string, unknown>));
    }

    async findAlertChannelLibraryEntry(id: string): Promise<IAlertChannelLibraryEntry | null> {
      const filter = idFilter(id);
      if (!filter) return null;
      const doc = await this.getTenantDb().collection(COLLECTION).findOne(filter);
      return doc ? toEntry(doc as Record<string, unknown>) : null;
    }

    async createAlertChannelLibraryEntry(
      entry: Omit<IAlertChannelLibraryEntry, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAlertChannelLibraryEntry> {
      const now = new Date();
      const doc = { ...entry, createdAt: now, updatedAt: now };
      const result = await this.getTenantDb().collection(COLLECTION).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as IAlertChannelLibraryEntry;
    }

    async updateAlertChannelLibraryEntry(
      id: string,
      data: Partial<Pick<IAlertChannelLibraryEntry, 'name' | 'config'>>,
    ): Promise<IAlertChannelLibraryEntry | null> {
      const filter = idFilter(id);
      if (!filter) return null;
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) set.name = data.name;
      if (data.config !== undefined) {
        set.config = data.config;
        set.kind = data.config.type;
      }
      const doc = await this.getTenantDb()
        .collection(COLLECTION)
        .findOneAndUpdate(filter, { $set: set }, { returnDocument: 'after' });
      return doc ? toEntry(doc as Record<string, unknown>) : null;
    }

    async deleteAlertChannelLibraryEntry(id: string): Promise<boolean> {
      const filter = idFilter(id);
      if (!filter) return false;
      const result = await this.getTenantDb().collection(COLLECTION).deleteOne(filter);
      return result.deletedCount === 1;
    }
  };
}
