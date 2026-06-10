/**
 * MongoDB Provider – Red-team operations mixin
 *
 * CRUD for red-team campaigns and runs. Documents store nested structures
 * (attempts, aggregate) natively. Mirrors the evaluation mixin conventions.
 */

import { ObjectId } from 'mongodb';
import type {
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamCustomProbe,
  RedTeamRunStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function RedTeamMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RedTeamOps extends Base {
    // ── Campaigns ────────────────────────────────────────────────────

    async createRedTeamCampaign(
      campaign: Omit<IRedTeamCampaign, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCampaign> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...campaign, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamCampaigns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRedTeamCampaign(
      id: string,
      data: Partial<Omit<IRedTeamCampaign, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCampaign | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IRedTeamCampaign>(COLLECTIONS.redTeamCampaigns)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamCampaign;
    }

    async deleteRedTeamCampaign(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamCampaigns).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findRedTeamCampaignById(id: string): Promise<IRedTeamCampaign | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamCampaigns).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IRedTeamCampaign | null;
    }

    async findRedTeamCampaignByKey(key: string, projectId?: string): Promise<IRedTeamCampaign | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.redTeamCampaigns).findOne(filter);
      return doc as unknown as IRedTeamCampaign | null;
    }

    async listRedTeamCampaigns(filters?: { projectId?: string; targetKind?: IRedTeamCampaign['targetKind']; search?: string }): Promise<IRedTeamCampaign[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.targetKind !== undefined) filter.targetKind = filters.targetKind;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.redTeamCampaigns).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IRedTeamCampaign[];
    }

    // ── Runs ─────────────────────────────────────────────────────────

    async createRedTeamRun(
      run: Omit<IRedTeamRun, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamRun> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...run, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamRuns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRedTeamRun(
      id: string,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IRedTeamRun>(COLLECTIONS.redTeamRuns)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamRun;
    }

    async findRedTeamRunById(id: string): Promise<IRedTeamRun | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamRuns).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IRedTeamRun | null;
    }

    async listRedTeamRuns(filters?: { projectId?: string; campaignKey?: string; status?: RedTeamRunStatus; limit?: number; skip?: number }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.campaignKey !== undefined) filter.campaignKey = filters.campaignKey;
      if (filters?.status !== undefined) filter.status = filters.status;
      const docs = await db
        .collection(COLLECTIONS.redTeamRuns)
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(filters?.skip ?? 0)
        .limit(filters?.limit ?? 50)
        .toArray();
      return docs as unknown as IRedTeamRun[];
    }

    // ── Custom probes ────────────────────────────────────────────────

    async createRedTeamCustomProbe(
      probe: Omit<IRedTeamCustomProbe, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCustomProbe> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...probe, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamCustomProbes).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRedTeamCustomProbe(
      id: string,
      data: Partial<Omit<IRedTeamCustomProbe, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCustomProbe | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IRedTeamCustomProbe>(COLLECTIONS.redTeamCustomProbes)
        .findOneAndUpdate({ _id: new ObjectId(id) }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamCustomProbe;
    }

    async deleteRedTeamCustomProbe(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamCustomProbes).deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findRedTeamCustomProbeById(id: string): Promise<IRedTeamCustomProbe | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamCustomProbes).findOne({ _id: new ObjectId(id) });
      return doc as unknown as IRedTeamCustomProbe | null;
    }

    async findRedTeamCustomProbeByKey(key: string, projectId?: string): Promise<IRedTeamCustomProbe | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db.collection(COLLECTIONS.redTeamCustomProbes).findOne(filter);
      return doc as unknown as IRedTeamCustomProbe | null;
    }

    async listRedTeamCustomProbes(filters?: { projectId?: string; search?: string }): Promise<IRedTeamCustomProbe[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.search) {
        filter.$or = [
          { name: { $regex: filters.search, $options: 'i' } },
          { description: { $regex: filters.search, $options: 'i' } },
          { key: { $regex: filters.search, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.redTeamCustomProbes).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IRedTeamCustomProbe[];
    }
  };
}
