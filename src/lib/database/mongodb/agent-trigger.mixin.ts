/**
 * MongoDB Provider – Agent triggers mixin
 *
 * A trigger is a saved way of starting an agent (prompt + type). The document
 * keeps `type` and the one settings object named after it (`schedule`, `once`
 * or `webhook`; manual has none). The scheduler reads due triggers tenant-wide
 * (`(enabled, nextFireAt)`), the APIs by agent (`(tenantId, projectId,
 * agentKey)`), an incoming webhook by its hook id (`webhook.hookId`). A webhook
 * trigger's delivery log is `agent_trigger_deliveries`. Indexes are plain
 * (Cosmos DB's Mongo API rejects partial ones) and ensured on the write path,
 * memoized per tenant DB, like `ensureAgentRunsIndexes`.
 */

import { ObjectId, type Filter } from 'mongodb';
import type {
  AgentTriggerPatch,
  AgentTriggerTypeSettings,
  IAgentTrigger,
  IAgentTriggerBase,
  IAgentTriggerDelivery,
  NewAgentTrigger,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

type TriggerDoc = Omit<IAgentTriggerBase, '_id'> & AgentTriggerTypeSettings & { _id: ObjectId };
type DeliveryDoc = Omit<IAgentTriggerDelivery, '_id'> & { _id: ObjectId };

/** The settings objects a trigger can carry, one per type (manual has none). */
const TYPE_SETTINGS_KEYS = ['schedule', 'once', 'webhook'] as const;

function toTrigger(doc: TriggerDoc): IAgentTrigger {
  return { ...doc, _id: doc._id.toString() };
}

/** Null for an id that cannot be an ObjectId (a lookup of it finds nothing). */
function objectIdOrNull(id: string): ObjectId | null {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

export function AgentTriggerMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentTriggerOps extends Base {
    private agentTriggersIndexReady = new Set<string>();

    private async ensureAgentTriggersIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.agentTriggersIndexReady.has(dbName)) return;
      const col = db.collection(COLLECTIONS.agentTriggers);
      let ok = true;
      for (const [keys, name] of [
        [{ tenantId: 1, projectId: 1, agentKey: 1 }, 'idx_tenant_project_agent'],
        [{ enabled: 1, nextFireAt: 1 }, 'idx_enabled_nextFireAt'],
        [{ 'webhook.hookId': 1 }, 'idx_webhook_hookId'],
      ] as Array<[Record<string, 1>, string]>) {
        try {
          await col.createIndex(keys, { name });
        } catch (error) {
          ok = false;
          logger.warn('Could not create agent_triggers index', { dbName, index: name, error });
        }
      }
      if (ok) this.agentTriggersIndexReady.add(dbName);
    }

    private agentTriggerDeliveriesIndexReady = new Set<string>();

    private async ensureAgentTriggerDeliveriesIndexes(): Promise<void> {
      const db = this.getTenantDb();
      const dbName = db.databaseName;
      if (this.agentTriggerDeliveriesIndexReady.has(dbName)) return;
      const col = db.collection(COLLECTIONS.agentTriggerDeliveries);
      let ok = true;
      for (const [keys, name] of [
        [{ tenantId: 1, triggerId: 1, receivedAt: -1 }, 'idx_tenant_trigger_receivedAt'],
        [{ expiresAt: 1 }, 'idx_expiresAt'],
      ] as Array<[Record<string, 1 | -1>, string]>) {
        try {
          await col.createIndex(keys, { name });
        } catch (error) {
          ok = false;
          logger.warn('Could not create agent_trigger_deliveries index', { dbName, index: name, error });
        }
      }
      if (ok) this.agentTriggerDeliveriesIndexReady.add(dbName);
    }

    private agentTriggerDeliveries() {
      return this.getTenantDb().collection<DeliveryDoc>(COLLECTIONS.agentTriggerDeliveries);
    }

    private agentTriggers() {
      return this.getTenantDb().collection<TriggerDoc>(COLLECTIONS.agentTriggers);
    }

    async createAgentTrigger(record: NewAgentTrigger): Promise<IAgentTrigger> {
      await this.ensureAgentTriggersIndexes();
      const now = new Date();
      const doc: TriggerDoc = { ...record, _id: new ObjectId(), createdAt: now, updatedAt: now };
      await this.agentTriggers().insertOne(doc);
      return toTrigger(doc);
    }

    async getAgentTrigger(id: string, tenantId: string, projectId: string): Promise<IAgentTrigger | null> {
      const _id = objectIdOrNull(id);
      if (!_id) return null;
      const doc = await this.agentTriggers().findOne({ _id, tenantId, projectId });
      return doc ? toTrigger(doc) : null;
    }

    async listAgentTriggers(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentTrigger[]> {
      const query: Filter<TriggerDoc> = { tenantId: filter.tenantId, projectId: filter.projectId };
      if (filter.agentKey) query.agentKey = filter.agentKey;
      const docs = await this.agentTriggers().find(query).sort({ createdAt: 1, _id: 1 }).toArray();
      return docs.map(toTrigger);
    }

    async updateAgentTrigger(id: string, tenantId: string, projectId: string, patch: AgentTriggerPatch): Promise<IAgentTrigger | null> {
      const _id = objectIdOrNull(id);
      if (!_id) return null;
      await this.ensureAgentTriggersIndexes();
      const set: Record<string, unknown> = { updatedAt: new Date() };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) set[key] = value;
      }
      // A new type replaces the settings as a whole: the objects of the other types go.
      const unset: Record<string, ''> = {};
      if (patch.type !== undefined) {
        for (const key of TYPE_SETTINGS_KEYS) {
          if (key === patch.type) continue;
          delete set[key];
          unset[key] = '';
        }
      }
      const doc = await this.agentTriggers().findOneAndUpdate(
        { _id, tenantId, projectId },
        { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
        { returnDocument: 'after' },
      );
      return doc ? toTrigger(doc) : null;
    }

    async deleteAgentTrigger(id: string, tenantId: string, projectId: string): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentTriggers().deleteOne({ _id, tenantId, projectId });
      return res.deletedCount === 1;
    }

    async deleteAgentTriggersForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number> {
      const res = await this.agentTriggers().deleteMany({ tenantId, projectId, agentKey });
      return res.deletedCount ?? 0;
    }

    async listDueTriggers(now: Date, limit: number): Promise<IAgentTrigger[]> {
      const docs = await this.agentTriggers()
        .find({ enabled: true, nextFireAt: { $ne: null, $lte: now } })
        .sort({ nextFireAt: 1 })
        .limit(Math.max(1, limit))
        .toArray();
      return docs.map(toTrigger);
    }

    async advanceTriggerNextFire(id: string, from: Date, next: Date | null): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentTriggers().updateOne(
        { _id, nextFireAt: from },
        { $set: { nextFireAt: next, updatedAt: new Date() } },
      );
      return res.modifiedCount === 1;
    }

    async setTriggerFireResult(
      id: string,
      result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
    ): Promise<boolean> {
      const _id = objectIdOrNull(id);
      if (!_id) return false;
      const res = await this.agentTriggers().updateOne(
        // `null` also matches a trigger that never fired (no field).
        { _id, $or: [{ lastFireAt: null }, { lastFireAt: { $lte: result.fireAt } }] },
        {
          $set: {
            lastFireAt: result.fireAt,
            lastStatus: result.status,
            // A failed fire started no run: the last run stays the one that did.
            ...(result.status === 'started' ? { lastRunId: result.runId ?? null } : {}),
            lastError: result.status === 'failed' ? result.error ?? null : null,
          },
        },
      );
      return res.matchedCount === 1;
    }

    async findAgentTriggerByHookId(hookId: string): Promise<IAgentTrigger | null> {
      const doc = await this.agentTriggers().findOne({ 'webhook.hookId': hookId } as Filter<TriggerDoc>);
      return doc ? toTrigger(doc) : null;
    }

    // ── Webhook deliveries ────────────────────────────────────────

    async recordAgentTriggerDelivery(record: Omit<IAgentTriggerDelivery, '_id'>): Promise<IAgentTriggerDelivery> {
      await this.ensureAgentTriggerDeliveriesIndexes();
      const doc: DeliveryDoc = { ...record, _id: new ObjectId() };
      await this.agentTriggerDeliveries().insertOne(doc);
      return { ...doc, _id: doc._id.toString() };
    }

    async listAgentTriggerDeliveries(filter: {
      tenantId: string;
      projectId: string;
      triggerId: string;
      limit: number;
      before?: string;
    }): Promise<IAgentTriggerDelivery[]> {
      const query: Filter<DeliveryDoc> = { tenantId: filter.tenantId, projectId: filter.projectId, triggerId: filter.triggerId };
      if (filter.before) {
        const cursorId = objectIdOrNull(filter.before);
        const cursor = cursorId ? await this.agentTriggerDeliveries().findOne({ _id: cursorId, triggerId: filter.triggerId }) : null;
        if (!cursor) return [];
        query.$or = [
          { receivedAt: { $lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, _id: { $lt: cursor._id } },
        ];
      }
      const docs = await this.agentTriggerDeliveries()
        .find(query)
        .sort({ receivedAt: -1, _id: -1 })
        .limit(Math.max(1, filter.limit))
        .toArray();
      return docs.map((doc) => ({ ...doc, _id: doc._id.toString() }));
    }

    async cleanupAgentTriggerDeliveryRetention(options: { olderThan: Date; batchSize: number }): Promise<{ deletedCount: number }> {
      await this.ensureAgentTriggerDeliveriesIndexes();
      const col = this.agentTriggerDeliveries();
      const ids = await col.find({ expiresAt: { $lt: options.olderThan } }).project({ _id: 1 }).limit(Math.max(1, options.batchSize)).toArray();
      if (ids.length === 0) return { deletedCount: 0 };
      const res = await col.deleteMany({ _id: { $in: ids.map((doc) => doc._id) } });
      return { deletedCount: res.deletedCount ?? 0 };
    }

    async deleteAgentTriggerDeliveries(triggerId: string): Promise<number> {
      const res = await this.agentTriggerDeliveries().deleteMany({ triggerId });
      return res.deletedCount ?? 0;
    }
  };
}
