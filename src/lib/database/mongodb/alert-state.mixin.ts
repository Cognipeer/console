/**
 * MongoDB Provider – Alert state operations mixin
 *
 * One document per (rule, entity) holding the evaluator's phase machine
 * (ok / pending / firing). Keyed by the unique (tenantId, ruleId, entityKey).
 */

import type { Db } from 'mongodb';
import type { IAlertState, IAlertStateFilter } from '../provider/types.domain';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

const toState = (doc: Record<string, unknown>): IAlertState => ({ ...doc, _id: String(doc._id) }) as unknown as IAlertState;

export function AlertStateMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AlertStateOps extends Base {
    private alertStateIndexesReady = new Set<string>();
    private alertStateIndexInit = new Map<string, Promise<void>>();

    /**
     * Ensured on the write path as well as in the boot manifest (which is
     * existence-guarded). Names/keys are IDENTICAL to the manifest's;
     * memoized only after success, keyed by database name.
     */
    private async ensureAlertStateIndexes(db: Db): Promise<void> {
      const dbName = db.databaseName;
      if (this.alertStateIndexesReady.has(dbName)) return;
      const inflight = this.alertStateIndexInit.get(dbName);
      if (inflight) return inflight;

      const coll = db.collection(COLLECTIONS.alertStates);
      const pending = Promise.all([
        coll.createIndex(
          { tenantId: 1, ruleId: 1, entityKey: 1 },
          { name: 'uniq_alert_states_rule_entity', unique: true },
        ),
        coll.createIndex(
          { tenantId: 1, projectId: 1, phase: 1 },
          { name: 'idx_alert_states_project_phase' },
        ),
        // listAlertStates() filters inside the per-tenant database without tenantId.
        coll.createIndex({ ruleId: 1 }, { name: 'idx_alert_states_rule' }),
        coll.createIndex({ projectId: 1, phase: 1 }, { name: 'idx_alert_states_project_phase_notenant' }),
      ])
        .then(() => {
          this.alertStateIndexesReady.add(dbName);
        })
        .finally(() => {
          this.alertStateIndexInit.delete(dbName);
        });
      this.alertStateIndexInit.set(dbName, pending);
      return pending;
    }

    async listAlertStates(filter: IAlertStateFilter): Promise<IAlertState[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = {};
      // ruleId and ruleIds are ANDed (as in SQLite), never one overwriting the other.
      const ruleConds: Record<string, unknown>[] = [];
      if (filter.ruleId) ruleConds.push({ ruleId: filter.ruleId });
      if (filter.ruleIds) {
        if (filter.ruleIds.length === 0) return [];
        ruleConds.push({ ruleId: { $in: filter.ruleIds } });
      }
      if (ruleConds.length === 1) Object.assign(query, ruleConds[0]);
      else if (ruleConds.length > 1) query.$and = ruleConds;
      if (filter.projectId !== undefined) query.projectId = filter.projectId;
      if (filter.phases) {
        if (filter.phases.length === 0) return [];
        query.phase = { $in: filter.phases };
      }
      const n = Number(filter.limit);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 5000) : 1000;
      const docs = await db
        .collection(COLLECTIONS.alertStates)
        .find(query)
        .sort({ lastEvaluatedAt: -1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => toState(d as unknown as Record<string, unknown>));
    }

    async upsertAlertState(
      state: Omit<IAlertState, '_id' | 'updatedAt'>,
    ): Promise<IAlertState> {
      const db = this.getTenantDb();
      await this.ensureAlertStateIndexes(db).catch((error) => {
        logger.warn('Could not ensure alert_states indexes', { dbName: db.databaseName, error });
      });
      const entityKey = state.entityKey ?? '';
      const { tenantId, ruleId } = state;
      const now = new Date();
      const date = (v: Date | string | null | undefined): Date | null => (v ? new Date(v) : null);
      // Replace semantics, identical to SQLite's ON CONFLICT DO UPDATE: every
      // optional field omitted by the caller is reset, not kept from the old doc.
      const set: Record<string, unknown> = {
        projectId: state.projectId ?? '',
        entityType: state.entityType ?? null,
        phase: state.phase,
        phaseSince: date(state.phaseSince) ?? now,
        breachStreak: state.breachStreak ?? 0,
        okStreak: state.okStreak ?? 0,
        lastValue: state.lastValue ?? null,
        lastBaseline: state.lastBaseline ?? null,
        lastSampleCount: state.lastSampleCount ?? 0,
        lastEvaluatedAt: date(state.lastEvaluatedAt) ?? now,
        incidentId: state.incidentId ?? null,
        eventId: state.eventId ?? null,
        firedAt: date(state.firedAt),
        lastFiredAt: date(state.lastFiredAt),
        lastNotifiedAt: date(state.lastNotifiedAt),
        peakValue: state.peakValue ?? null,
        detail: state.detail ?? null,
        updatedAt: now,
      };
      const run = () => db
        .collection(COLLECTIONS.alertStates)
        .findOneAndUpdate(
          { tenantId, ruleId, entityKey },
          { $set: set },
          { upsert: true, returnDocument: 'after' },
        );
      let doc;
      try {
        doc = await run();
      } catch (error) {
        // Two evaluators upserting the same (rule, entity) concurrently: the
        // loser hits the unique index; the retry then matches the winner's doc.
        if ((error as { code?: number })?.code !== 11000) throw error;
        doc = await run();
      }
      return toState(doc as unknown as Record<string, unknown>);
    }

    async deleteAlertStates(filter: { ruleId: string; entityKeys?: string[] }): Promise<number> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { ruleId: filter.ruleId };
      if (filter.entityKeys) {
        if (filter.entityKeys.length === 0) return 0;
        query.entityKey = { $in: filter.entityKeys };
      }
      const res = await db.collection(COLLECTIONS.alertStates).deleteMany(query);
      return res.deletedCount ?? 0;
    }
  };
}
