/**
 * MongoDB Provider – Alert operations mixin
 *
 * Includes alert rules and alert events (history).
 */

import { ObjectId } from 'mongodb';
import type { IAlertRule, IAlertEvent, AlertEventStatus } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function AlertMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AlertOps extends Base {
    // ── Alert rule operations ────────────────────────────────────────

    async createAlertRule(
      rule: Omit<IAlertRule, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAlertRule> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...rule, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.alertRules)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAlertRule(
      id: string,
      data: Partial<Omit<IAlertRule, 'tenantId' | 'createdBy'>>,
    ): Promise<IAlertRule | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAlertRule>(COLLECTIONS.alertRules)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAlertRule;
    }

    async deleteAlertRule(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.alertRules)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAlertRuleById(id: string): Promise<IAlertRule | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.alertRules)
        .findOne({ _id: new ObjectId(id) });
      return doc as unknown as IAlertRule | null;
    }

    async listAlertRules(
      tenantId: string,
      filters?: { projectId?: string; enabled?: boolean },
    ): Promise<IAlertRule[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId };
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.enabled !== undefined) filter.enabled = filters.enabled;
      const docs = await db
        .collection(COLLECTIONS.alertRules)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IAlertRule[];
    }

    // ── Alert event (history) operations ─────────────────────────────

    async createAlertEvent(
      event: Omit<IAlertEvent, '_id'>,
    ): Promise<IAlertEvent> {
      const db = this.getTenantDb();
      const doc = { ...event };
      const result = await db
        .collection(COLLECTIONS.alertEvents)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
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
      const filter: Record<string, unknown> = { tenantId };
      if (options?.projectId) filter.projectId = options.projectId;
      if (options?.ruleId) filter.ruleId = options.ruleId;
      if (options?.status) filter.status = options.status;
      const docs = await db
        .collection(COLLECTIONS.alertEvents)
        .find(filter)
        .sort({ firedAt: -1 })
        .skip(options?.skip ?? 0)
        .limit(options?.limit ?? 50)
        .toArray();
      return docs as unknown as IAlertEvent[];
    }

    async updateAlertEvent(
      id: string,
      data: Partial<IAlertEvent>,
    ): Promise<IAlertEvent | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data };
      delete updateData._id;
      const result = await db
        .collection<IAlertEvent>(COLLECTIONS.alertEvents)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAlertEvent;
    }

    async countActiveAlerts(
      tenantId: string,
      projectId?: string,
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId, status: 'fired' };
      if (projectId) filter.projectId = projectId;
      return db
        .collection(COLLECTIONS.alertEvents)
        .countDocuments(filter);
    }
  };
}
