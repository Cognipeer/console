/**
 * MongoDB Provider – Red-team operations mixin
 *
 * CRUD for red-team campaigns and runs. Documents store nested structures
 * (aggregate, legacy embedded attempts) natively; newer runs keep one row per
 * attempt in `redteam_run_attempts`. Mirrors the evaluation mixin conventions.
 */

import { ObjectId } from 'mongodb';
import type {
  IRedTeamCampaign,
  IRedTeamRun,
  IRedTeamRunAttempt,
  IRedTeamRunGuard,
  IRedTeamReview,
  IRedTeamCustomProbe,
  RedTeamRunStatus,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, escapeRegex } from './base';
import { definedFields } from './definedFields';
import { ensureTenantCollectionIndexes } from './indexManifest';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** A malformed id finds nothing; `new ObjectId(id)` would throw on it. */
function toObjectId(id: unknown): ObjectId | null {
  return typeof id === 'string' && OBJECT_ID_PATTERN.test(id) ? new ObjectId(id) : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function withStringId<T extends { _id?: unknown }>(doc: T): T {
  return { ...doc, _id: doc._id === undefined ? undefined : String(doc._id) };
}

/** Attempt fields that may be absent on a row; an upsert removes them when the new row has none. */
const OPTIONAL_ATTEMPT_FIELDS = ['projectId', 'latencyMs', 'error', 'partial', 'kbRestricted', 'polarity'] as const;

function statusFilter(status: RedTeamRunStatus | RedTeamRunStatus[]): RedTeamRunStatus | { $in: RedTeamRunStatus[] } {
  return Array.isArray(status) ? { $in: status } : status;
}

export function RedTeamMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class RedTeamOps extends Base {
    // ── Campaigns ────────────────────────────────────────────────────

    async createRedTeamCampaign(
      campaign: Omit<IRedTeamCampaign, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCampaign> {
      const db = this.getTenantDb();
      // The collection may not exist yet: its unique (projectId, key) index has to be there before the first insert.
      await ensureTenantCollectionIndexes(db, COLLECTIONS.redTeamCampaigns);
      const now = new Date();
      const doc = { ...campaign, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamCampaigns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRedTeamCampaign(
      id: string,
      data: Partial<Omit<IRedTeamCampaign, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCampaign | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const updateData = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IRedTeamCampaign>(COLLECTIONS.redTeamCampaigns)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamCampaign;
    }

    async deleteRedTeamCampaign(id: string): Promise<boolean> {
      const oid = toObjectId(id);
      if (!oid) return false;
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamCampaigns).deleteOne({ _id: oid });
      return result.deletedCount === 1;
    }

    async findRedTeamCampaignById(id: string): Promise<IRedTeamCampaign | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamCampaigns).findOne({ _id: oid });
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
        // A literal substring search, like the SQLite provider's LIKE: the term is escaped before it reaches $regex.
        const term = escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: term, $options: 'i' } },
          { description: { $regex: term, $options: 'i' } },
          { key: { $regex: term, $options: 'i' } },
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
      const doc = { ...definedFields(run), createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamRuns).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() } as unknown as IRedTeamRun;
    }

    async updateRedTeamRun(
      id: string,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IRedTeamRun>(COLLECTIONS.redTeamRuns)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamRun;
    }

    async updateRedTeamRunIf(
      id: string,
      guard: IRedTeamRunGuard,
      data: Partial<Omit<IRedTeamRun, 'tenantId' | 'campaignKey' | 'createdBy'>>,
    ): Promise<IRedTeamRun | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      // Only the guard fields that were given take part; the one findOneAndUpdate is the whole compare-and-set.
      const filter: Record<string, unknown> = { _id: oid };
      if (guard.status !== undefined) filter.status = statusFilter(guard.status);
      if (guard.workerId !== undefined) filter.workerId = guard.workerId;
      if (guard.updatedAt !== undefined) filter.updatedAt = guard.updatedAt;
      const updateData: Record<string, unknown> = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection(COLLECTIONS.redTeamRuns)
        .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as unknown as IRedTeamRun;
    }

    async findRedTeamRunById(id: string): Promise<IRedTeamRun | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamRuns).findOne({ _id: oid });
      return doc as unknown as IRedTeamRun | null;
    }

    protected redTeamRunFilter(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
    }): Record<string, unknown> {
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.campaignKey !== undefined) filter.campaignKey = filters.campaignKey;
      if (filters?.status !== undefined) filter.status = statusFilter(filters.status);
      return filter;
    }

    async listRedTeamRuns(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
      limit?: number;
      skip?: number;
      omitAttempts?: boolean;
    }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.redTeamRuns)
        .find(this.redTeamRunFilter(filters), filters?.omitAttempts ? { projection: { attempts: 0 } } : undefined)
        .sort({ createdAt: -1, _id: -1 })
        .skip(clampInt(filters?.skip, 0, 0, Number.MAX_SAFE_INTEGER))
        .limit(clampInt(filters?.limit, 50, 1, 200))
        .toArray();
      const runs = docs as unknown as IRedTeamRun[];
      return filters?.omitAttempts ? runs.map((run) => ({ ...run, attempts: [] })) : runs;
    }

    async countRedTeamRuns(filters?: {
      projectId?: string;
      campaignKey?: string;
      status?: RedTeamRunStatus | RedTeamRunStatus[];
    }): Promise<number> {
      const db = this.getTenantDb();
      return db.collection(COLLECTIONS.redTeamRuns).countDocuments(this.redTeamRunFilter(filters));
    }

    async listStaleRedTeamRuns(params: {
      leaseExpiredBefore: Date;
      legacyUpdatedBefore: Date;
      pendingCreatedBefore: Date;
      limit?: number;
    }): Promise<IRedTeamRun[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.redTeamRuns)
        .find(
          {
            $or: [
              { status: 'running', leaseUntil: { $lt: params.leaseExpiredBefore } },
              // Recorded before leases: judged by the last write instead (`null` also matches a missing field).
              { status: 'running', leaseUntil: null, updatedAt: { $lt: params.legacyUpdatedBefore } },
              { status: 'pending', createdAt: { $lt: params.pendingCreatedBefore } },
            ],
          },
          { projection: { attempts: 0 } },
        )
        .sort({ createdAt: 1, _id: 1 })
        .limit(clampInt(params.limit, 50, 1, 200))
        .toArray();
      return (docs as unknown as IRedTeamRun[]).map((run) => ({ ...run, attempts: [] }));
    }

    async deleteRedTeamRun(id: string): Promise<boolean> {
      const oid = toObjectId(id);
      if (!oid) return false;
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamRuns).deleteOne({ _id: oid });
      // The run goes first: a failure in between leaves rows the retention sweep ages out, never a run without its attempts.
      await db.collection(COLLECTIONS.redTeamRunAttempts).deleteMany({ runId: String(id) });
      return result.deletedCount === 1;
    }

    // ── Run attempts ─────────────────────────────────────────────────

    async upsertRedTeamRunAttempts(
      rows: Array<Omit<IRedTeamRunAttempt, '_id' | 'createdAt' | 'updatedAt'>>,
    ): Promise<void> {
      if (rows.length === 0) return;
      const db = this.getTenantDb();
      // The collection may not exist yet and the manifest pass skips missing collections:
      // the unique (runId, attemptKey) index has to be there before the first upsert.
      await ensureTenantCollectionIndexes(db, COLLECTIONS.redTeamRunAttempts);
      const now = new Date();
      const operations = rows.map((row) => {
        // `review` is stored only when the row is inserted (a legacy embedded review) and is changed afterwards
        // only by setRedTeamRunAttemptReview; `restricted` is never stored.
        const stored: Record<string, unknown> = { ...row };
        for (const field of ['_id', 'createdAt', 'updatedAt', 'review', 'restricted']) delete stored[field];
        const $set: Record<string, unknown> = { ...definedFields(stored), updatedAt: now };
        // A re-upsert replaces the row: an optional field the new attempt lacks must not survive from the old one.
        const $unset: Record<string, ''> = {};
        for (const field of OPTIONAL_ATTEMPT_FIELDS) {
          if (stored[field] === undefined) $unset[field] = '';
        }
        const update: Record<string, unknown> = {
          $set,
          $setOnInsert: { createdAt: now, ...(row.review ? { review: row.review } : {}) },
        };
        if (Object.keys($unset).length > 0) update.$unset = $unset;
        return {
          updateOne: {
            filter: { runId: row.runId, attemptKey: row.attemptKey },
            update,
            upsert: true,
          },
        };
      });
      await db.collection(COLLECTIONS.redTeamRunAttempts).bulkWrite(operations as never, { ordered: false });
    }

    async listRedTeamRunAttempts(
      runId: string,
      opts?: { limit?: number; skip?: number },
    ): Promise<IRedTeamRunAttempt[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.redTeamRunAttempts)
        .find({ runId: String(runId) })
        .sort({ seq: 1, _id: 1 })
        .skip(clampInt(opts?.skip, 0, 0, Number.MAX_SAFE_INTEGER))
        .limit(clampInt(opts?.limit, 1000, 1, 1000))
        .toArray();
      return (docs as unknown as IRedTeamRunAttempt[]).map(withStringId);
    }

    async countRedTeamRunAttempts(runId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.collection(COLLECTIONS.redTeamRunAttempts).countDocuments({ runId: String(runId) });
    }

    async findRedTeamRunAttempt(runId: string, attemptKey: string): Promise<IRedTeamRunAttempt | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.redTeamRunAttempts)
        .findOne({ runId: String(runId), attemptKey });
      return doc ? withStringId(doc as unknown as IRedTeamRunAttempt) : null;
    }

    async setRedTeamRunAttemptReview(
      runId: string,
      attemptKey: string,
      review: IRedTeamReview | null,
    ): Promise<boolean> {
      const db = this.getTenantDb();
      const update = review
        ? { $set: { review, updatedAt: new Date() } }
        : { $set: { updatedAt: new Date() }, $unset: { review: '' as const } };
      const result = await db
        .collection(COLLECTIONS.redTeamRunAttempts)
        .updateOne({ runId: String(runId), attemptKey }, update);
      return result.matchedCount === 1;
    }

    async deleteRedTeamRunAttempts(runId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamRunAttempts).deleteMany({ runId: String(runId) });
      return result.deletedCount ?? 0;
    }

    // ── Custom probes ────────────────────────────────────────────────

    async createRedTeamCustomProbe(
      probe: Omit<IRedTeamCustomProbe, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IRedTeamCustomProbe> {
      const db = this.getTenantDb();
      // See createRedTeamCampaign: the unique (projectId, key) index comes first.
      await ensureTenantCollectionIndexes(db, COLLECTIONS.redTeamCustomProbes);
      const now = new Date();
      const doc = { ...probe, createdAt: now, updatedAt: now };
      const result = await db.collection(COLLECTIONS.redTeamCustomProbes).insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateRedTeamCustomProbe(
      id: string,
      data: Partial<Omit<IRedTeamCustomProbe, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IRedTeamCustomProbe | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const updateData = { ...definedFields(data), updatedAt: new Date() };
      const result = await db
        .collection<IRedTeamCustomProbe>(COLLECTIONS.redTeamCustomProbes)
        .findOneAndUpdate({ _id: oid }, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IRedTeamCustomProbe;
    }

    async deleteRedTeamCustomProbe(id: string): Promise<boolean> {
      const oid = toObjectId(id);
      if (!oid) return false;
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.redTeamCustomProbes).deleteOne({ _id: oid });
      return result.deletedCount === 1;
    }

    async findRedTeamCustomProbeById(id: string): Promise<IRedTeamCustomProbe | null> {
      const oid = toObjectId(id);
      if (!oid) return null;
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.redTeamCustomProbes).findOne({ _id: oid });
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
        // A literal substring search, like the SQLite provider's LIKE: the term is escaped before it reaches $regex.
        const term = escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: term, $options: 'i' } },
          { description: { $regex: term, $options: 'i' } },
          { key: { $regex: term, $options: 'i' } },
        ];
      }
      const docs = await db.collection(COLLECTIONS.redTeamCustomProbes).find(filter).sort({ createdAt: -1 }).toArray();
      return docs as unknown as IRedTeamCustomProbe[];
    }
  };
}
