/**
 * MongoDB Provider – Incident operations mixin
 *
 * Incidents are created when alerts fire and track resolution lifecycle.
 */

import { ObjectId, type Db } from 'mongodb';
import type { IIncident, IIncidentStatRow, IncidentSort, IncidentStatus, IncidentSeverity, AlertModule } from '../provider.interface';
import { foldedRegexSource } from '@/lib/shared/searchFold';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

const INCIDENT_STATUSES: IncidentStatus[] = ['open', 'acknowledged', 'investigating', 'resolved', 'closed'];

const toIncident = (doc: Record<string, unknown>): IIncident => ({ ...doc, _id: String(doc._id) }) as unknown as IIncident;

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

/** `{ _id }` filter for a hex id, plus the optional project scope; null when the id is malformed. */
function idFilter(id: string, projectId?: string): Record<string, unknown> | null {
  if (typeof id !== 'string' || !ObjectId.isValid(id)) return null;
  const filter: Record<string, unknown> = { _id: new ObjectId(id) };
  if (projectId !== undefined) filter.projectId = projectId;
  return filter;
}

export function IncidentMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class IncidentOps extends Base {
    /** Per-process memo: incident indexes are ensured on the first write per tenant DB. */
    private incidentIndexesReady = new Set<string>();

    /**
     * Ensured on the write path as well as in the boot manifest (which is
     * existence-guarded). Names/keys are IDENTICAL to the manifest's.
     */
    private async ensureIncidentIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.incidentIndexesReady.has(dbName)) return;
      const coll = db.collection(COLLECTIONS.incidents);
      await Promise.all([
        coll.createIndex({ projectId: 1, status: 1, firedAt: -1 }, { name: 'idx_incidents_project_status_firedAt' }),
        coll.createIndex({ ruleId: 1, entityKey: 1 }, { name: 'idx_incidents_rule_entity' }),
        coll.createIndex({ projectId: 1, entityKey: 1, firedAt: -1 }, { name: 'idx_incidents_project_entity_firedAt' }),
        coll.createIndex({ alertEventId: 1 }, { name: 'idx_incidents_alertEventId' }),
        coll.createIndex({ tenantId: 1, projectId: 1, updatedAt: 1 }, { name: 'idx_incidents_tenant_project_updatedAt' }),
      ]);
      this.incidentIndexesReady.add(dbName);
    }

    async createIncident(
      incident: Omit<IIncident, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IIncident> {
      const db = this.getTenantDb();
      await this.ensureIncidentIndexes(db).catch(() => undefined);
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
      projectId?: string,
    ): Promise<IIncident | null> {
      const filter = idFilter(id, projectId);
      if (!filter) return null;
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IIncident>(COLLECTIONS.incidents)
        .findOneAndUpdate(
          filter,
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return toIncident(result as unknown as Record<string, unknown>);
    }

    async findIncidentById(id: string, projectId?: string): Promise<IIncident | null> {
      const filter = idFilter(id, projectId);
      if (!filter) return null;
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.incidents)
        .findOne(filter);
      return doc ? toIncident(doc as unknown as Record<string, unknown>) : null;
    }

    async findIncidentByAlertEventId(alertEventId: string): Promise<IIncident | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.incidents)
        .findOne({ alertEventId });
      return doc ? toIncident(doc as unknown as Record<string, unknown>) : null;
    }

    async listIncidents(
      tenantId: string,
      options?: {
        projectId?: string;
        ruleId?: string;
        status?: IncidentStatus;
        severity?: IncidentSeverity;
        entityKey?: string;
        module?: AlertModule;
        updatedAfter?: Date;
        firedAfter?: Date;
        q?: string;
        assignee?: string | null;
        snoozed?: boolean;
        excludeId?: string;
        sort?: IncidentSort;
        limit?: number;
        skip?: number;
      },
    ): Promise<IIncident[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { tenantId };
      const and: Record<string, unknown>[] = [];
      if (options?.projectId) filter.projectId = options.projectId;
      if (options?.ruleId) filter.ruleId = options.ruleId;
      if (options?.status) filter.status = options.status;
      if (options?.severity) filter.severity = options.severity;
      if (options?.entityKey) filter.entityKey = options.entityKey;
      if (options?.module) filter.module = options.module;
      if (options?.updatedAfter) filter.updatedAt = { $gt: options.updatedAfter };
      if (options?.firedAfter) filter.firedAt = { $gte: options.firedAfter };
      if (options?.excludeId) {
        if (ObjectId.isValid(options.excludeId)) filter._id = { $ne: new ObjectId(options.excludeId) };
      }
      const q = options?.q?.trim();
      if (q) {
        const rx = { $regex: foldedRegexSource(q), $options: 'i' };
        and.push({ $or: [{ ruleName: rx }, { entityKey: rx }, { metric: rx }] });
      }
      // `{ assignedTo: null }` matches both null and a missing field (unassigned).
      if (options?.assignee === null) filter.assignedTo = null;
      else if (typeof options?.assignee === 'string') filter.assignedTo = options.assignee;
      if (options?.snoozed !== undefined) {
        const now = new Date();
        and.push(options.snoozed
          ? { snoozedUntil: { $gt: now } }
          : { $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: now } }] });
      }
      if (and.length > 0) filter.$and = and;

      const limit = clampLimit(options?.limit, 50);
      const skip = clampSkip(options?.skip);
      const coll = db.collection(COLLECTIONS.incidents);
      const sort = options?.sort;

      if (sort === 'severity' || sort === '-severity') {
        // A computed rank cannot be sorted by a plain find (and Cosmos needs an index for every
        // sort key), so walk the severities in rank order, newest first inside each one.
        const order: IncidentSeverity[] = sort === '-severity'
          ? ['critical', 'warning', 'info']
          : ['info', 'warning', 'critical'];
        const segments = options?.severity ? [options.severity] : order;
        const out: IIncident[] = [];
        let toSkip = skip;
        for (const severity of segments) {
          const remaining = limit - out.length;
          if (remaining <= 0) break;
          const segFilter = { ...filter, severity };
          if (toSkip > 0) {
            const inSegment = await coll.countDocuments(segFilter);
            if (toSkip >= inSegment) { toSkip -= inSegment; continue; }
          }
          const docs = await coll.find(segFilter).sort({ firedAt: -1 }).skip(toSkip).limit(remaining).toArray();
          toSkip = 0;
          out.push(...docs.map((d) => toIncident(d as unknown as Record<string, unknown>)));
        }
        return out;
      }

      const sortSpec: Record<string, 1 | -1> =
        sort === 'firedAt' ? { firedAt: 1 }
          : sort === 'updatedAt' ? { updatedAt: 1 }
            : sort === '-updatedAt' ? { updatedAt: -1 }
              : { firedAt: -1 };
      const docs = await coll.find(filter).sort(sortSpec).skip(skip).limit(limit).toArray();
      return docs.map((d) => toIncident(d as unknown as Record<string, unknown>));
    }

    async listIncidentStatRows(
      projectId: string,
      options: { firedSince?: Date; resolvedSince?: Date; limit?: number },
    ): Promise<IIncidentStatRow[]> {
      const or: Record<string, unknown>[] = [];
      if (options.firedSince) or.push({ firedAt: { $gte: options.firedSince } });
      if (options.resolvedSince) or.push({ resolvedAt: { $gte: options.resolvedSince } });
      if (or.length === 0) return [];
      const n = Number(options.limit);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 5000) : 5000;
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.incidents)
        .find(or.length === 1 ? { projectId, ...or[0] } : { projectId, $or: or })
        .project({ status: 1, firedAt: 1, acknowledgedAt: 1, resolvedAt: 1, closedAt: 1, reopenedAt: 1, autoResolved: 1 })
        .sort({ firedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => ({ ...d, _id: String(d._id) }) as unknown as IIncidentStatRow);
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

    async countIncidentsByStatus(projectId: string): Promise<Record<IncidentStatus, number>> {
      const db = this.getTenantDb();
      const rows = await db
        .collection(COLLECTIONS.incidents)
        .aggregate<{ _id: string; count: number }>([
          { $match: { projectId } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ])
        .toArray();
      const counts = Object.fromEntries(INCIDENT_STATUSES.map((st) => [st, 0])) as Record<IncidentStatus, number>;
      for (const row of rows) {
        if (row._id in counts) counts[row._id as IncidentStatus] = row.count;
      }
      return counts;
    }
  };
}
