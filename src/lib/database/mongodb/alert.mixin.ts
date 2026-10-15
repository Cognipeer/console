/**
 * MongoDB Provider – Alert operations mixin
 *
 * Includes alert rules and alert events (history).
 */

import { ObjectId } from 'mongodb';
import type { IAlertRule, IAlertEvent, AlertEventStatus } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

const toRule = (doc: Record<string, unknown>): IAlertRule => ({ ...doc, _id: String(doc._id) }) as unknown as IAlertRule;
const toEvent = (doc: Record<string, unknown>): IAlertEvent => ({ ...doc, _id: String(doc._id) }) as unknown as IAlertEvent;

/** `{ _id }` filter for a hex id, plus the optional project scope; null when the id is malformed. */
function idFilter(id: string, projectId?: string): Record<string, unknown> | null {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
  const filter: Record<string, unknown> = { _id: new ObjectId(id) };
  if (projectId !== undefined) filter.projectId = projectId;
  return filter;
}

function clampLimit(value: number | undefined, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 200);
}

function clampSkip(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

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
      projectId?: string,
    ): Promise<IAlertRule | null> {
      const filter = idFilter(id, projectId);
      if (!filter) return null;
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAlertRule>(COLLECTIONS.alertRules)
        .findOneAndUpdate(
          filter,
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return toRule(result as unknown as Record<string, unknown>);
    }

    async deleteAlertRule(id: string, projectId?: string): Promise<boolean> {
      const filter = idFilter(id, projectId);
      if (!filter) return false;
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.alertRules)
        .deleteOne(filter);
      return result.deletedCount === 1;
    }

    async findAlertRuleById(id: string, projectId?: string): Promise<IAlertRule | null> {
      const filter = idFilter(id, projectId);
      if (!filter) return null;
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.alertRules)
        .findOne(filter);
      return doc ? toRule(doc as unknown as Record<string, unknown>) : null;
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
      return docs.map((d) => toRule(d as unknown as Record<string, unknown>));
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
        .skip(clampSkip(options?.skip))
        .limit(clampLimit(options?.limit, 50))
        .toArray();
      return docs.map((d) => toEvent(d as unknown as Record<string, unknown>));
    }

    async updateAlertEvent(
      id: string,
      data: Partial<IAlertEvent>,
    ): Promise<IAlertEvent | null> {
      const filter = idFilter(id);
      if (!filter) return null;
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data };
      delete updateData._id;
      if (Object.keys(updateData).length === 0) return this.findAlertEventById(id);
      const result = await db
        .collection<IAlertEvent>(COLLECTIONS.alertEvents)
        .findOneAndUpdate(
          filter,
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return toEvent(result as unknown as Record<string, unknown>);
    }

    async findAlertEventById(id: string, projectId?: string): Promise<IAlertEvent | null> {
      const filter = idFilter(id, projectId);
      if (!filter) return null;
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.alertEvents)
        .findOne(filter);
      return doc ? toEvent(doc as unknown as Record<string, unknown>) : null;
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
