/**
 * MongoDB Provider – Incident operations mixin
 *
 * Incidents are created when alerts fire and track resolution lifecycle.
 */

import { ObjectId } from 'mongodb';
import type { IIncident, IncidentStatus, IncidentSeverity } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function IncidentMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class IncidentOps extends Base {
    async createIncident(
      incident: Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IIncident> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...incident, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.incidents)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateIncident(
      id: string,
      data: Partial<Omit<IIncident, 'tenantId' | 'alertEventId' | 'ruleId'>>,
    ): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IIncident>(COLLECTIONS.incidents)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IIncident;
    }

    async findIncidentById(id: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.incidents)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IIncident | null;
    }

    async findIncidentByAlertEventId(alertEventId: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.incidents)
        .findOne({ alertEventId });
      return doc as unknown as IIncident | null;
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
      const filter: Record<string, unknown> = { tenantId };
      if (options?.projectId) filter.projectId = options.projectId;
      if (options?.ruleId) filter.ruleId = options.ruleId;
      if (options?.status) filter.status = options.status;
      if (options?.severity) filter.severity = options.severity;
      const docs = await db
        .collection(COLLECTIONS.incidents)
        .find(filter)
        .sort({ firedAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IIncident[];
    }

    async countIncidents(
      tenantId: string,
      options?: { projectId?: string; status?: IncidentStatus },
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId };
      if (options?.projectId) filter.projectId = options.projectId;
      if (options?.status) filter.status = options.status;
      return db
        .collection(COLLECTIONS.incidents)
        .countDocuments(filter);
    }
  };
}
