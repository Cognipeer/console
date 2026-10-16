/**
 * MongoDB Provider – Alert operations mixin
 *
 * Includes alert rules and alert events (history).
 */

import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import type { IAlertRule, IAlertEvent, IAlertDelivery, AlertEventStatus } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

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

const toDelivery = (doc: Record<string, unknown>): IAlertDelivery => ({ ...doc, _id: String(doc._id) }) as unknown as IAlertDelivery;

export function AlertMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AlertOps extends Base {
    private alertDeliveryIndexesReady = new Set<string>();

    /**
     * Ensured on the write path as well as in the boot manifest (which is
     * existence-guarded). Names/keys are IDENTICAL to the manifest's.
     */
    private async ensureAlertDeliveryIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.alertDeliveryIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.alertDeliveries);
      await Promise.all([
        coll.createIndex(
          { tenantId: 1, incidentId: 1, attemptAt: -1 },
          { name: 'idx_alert_deliveries_incident_attemptAt' },
        ),
        coll.createIndex(
          { tenantId: 1, ruleId: 1, attemptAt: -1 },
          { name: 'idx_alert_deliveries_rule_attemptAt' },
        ),
      ]);
      this.alertDeliveryIndexesReady.add(dbName);
    }

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
      // The evaluator's summary write is bookkeeping, not an edit: it must not move updatedAt.
      const bookkeepingOnly = Object.keys(data).every((key) => key === 'lastEvaluation');
      const updateData: Record<string, unknown> = bookkeepingOnly ? { ...data } : { ...data, updatedAt: new Date() };
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

    async listAlertFirings(
      tenantId: string,
      options: { projectId?: string; since: Date; limit?: number },
    ): Promise<Array<{ ruleId: string; firedAt: Date }>> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId, firedAt: { $gte: options.since } };
      if (options.projectId) filter.projectId = options.projectId;
      const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 5000), 1), 20000);
      const docs = await db
        .collection(COLLECTIONS.alertEvents)
        .find(filter, { projection: { ruleId: 1, firedAt: 1 } })
        .sort({ firedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({ ruleId: String(d.ruleId), firedAt: new Date(d.firedAt as Date) }));
    }

    // ── Alert delivery log ───────────────────────────────────────────

    async createAlertDeliveries(rows: Array<Omit<IAlertDelivery, '_id'>>): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();
      await this.ensureAlertDeliveryIndexes(db).catch((error) => {
        logger.warn('Could not ensure alert_deliveries indexes', { dbName: db.databaseName, error });
      });
      await db.collection(COLLECTIONS.alertDeliveries).insertMany(
        rows.map((row) => ({
          ...row,
          incidentId: row.incidentId ?? null,
          eventId: row.eventId ?? null,
          attemptAt: new Date(row.attemptAt),
        })),
      );
    }

    async listAlertDeliveries(
      tenantId: string,
      options: { incidentId?: string; ruleId?: string; limit?: number },
    ): Promise<IAlertDelivery[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId };
      if (options.incidentId) filter.incidentId = options.incidentId;
      if (options.ruleId) filter.ruleId = options.ruleId;
      const docs = await db
        .collection(COLLECTIONS.alertDeliveries)
        .find(filter)
        .sort({ attemptAt: -1 })
        .limit(clampLimit(options.limit, 200))
        .toArray();
      return docs.map((d) => toDelivery(d as unknown as Record<string, unknown>));
    }

    async pruneAlertDeliveries(before: Date): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.alertDeliveries)
        .deleteMany({ attemptAt: { $lt: before } });
      return result.deletedCount ?? 0;
    }
  };
}
