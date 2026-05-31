/**
 * MongoDB Provider – GPU fleet operations mixin.
 *
 * See sqlite/gpu-fleet.mixin.ts for the shape rationale; this file mirrors
 * that surface against MongoDB collections.
 */

import type {
  GpuFleetCommandStatus,
  GpuHostStatus,
  IGpuFleetCommand,
  IGpuFleetEvent,
  IGpuFleetSettings,
  IGpuHost,
  IGpuSlice,
  ILlmDeployment,
  ILlmPool,
} from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function GpuFleetMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class GpuFleetOps extends Base {
    // ── Hosts ────────────────────────────────────────────────────────

    async createGpuHost(
      host: Omit<IGpuHost, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuHost> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...host, createdAt: now, updatedAt: now };
      await db.collection(COLLECTIONS.gpuHosts).insertOne(doc);
      return doc as IGpuHost;
    }

    async updateGpuHost(
      id: string,
      data: Partial<Omit<IGpuHost, '_id' | 'tenantId' | 'id' | 'createdBy' | 'createdAt'>>,
    ): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.gpuHosts)
        .findOneAndUpdate(
          { id },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      return result as unknown as IGpuHost | null;
    }

    async findGpuHostById(id: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuHosts).findOne({ id });
      return doc as unknown as IGpuHost | null;
    }

    async findGpuHostByAgentTokenHash(hash: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuHosts).findOne({ agentTokenHash: hash });
      return doc as unknown as IGpuHost | null;
    }

    async findGpuHostByRegistrationTokenHash(hash: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuHosts).findOne({ registrationTokenHash: hash });
      return doc as unknown as IGpuHost | null;
    }

    async listGpuHosts(filters: { tenantId: string; status?: GpuHostStatus } = { tenantId: '' }): Promise<IGpuHost[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { tenantId: filters.tenantId };
      if (filters.status) query.status = filters.status;
      const docs = await db
        .collection(COLLECTIONS.gpuHosts)
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as IGpuHost[];
    }

    async deleteGpuHost(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.gpuHosts).deleteOne({ id });
      return result.deletedCount > 0;
    }

    // ── Slices ───────────────────────────────────────────────────────

    async upsertGpuSlice(
      slice: Omit<IGpuSlice, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuSlice> {
      const db = this.getTenantDb();
      const now = new Date();
      await db.collection(COLLECTIONS.gpuSlices).updateOne(
        { uuid: slice.uuid },
        {
          $set: { ...slice, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      const doc = await db.collection(COLLECTIONS.gpuSlices).findOne({ uuid: slice.uuid });
      return doc as unknown as IGpuSlice;
    }

    async listGpuSlicesByHost(hostId: string): Promise<IGpuSlice[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.gpuSlices)
        .find({ hostId })
        .sort({ gpuUuid: 1, migGiId: 1 })
        .toArray();
      return docs as unknown as IGpuSlice[];
    }

    async findGpuSliceByUuid(uuid: string): Promise<IGpuSlice | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuSlices).findOne({ uuid });
      return doc as unknown as IGpuSlice | null;
    }

    async setGpuSliceAssignment(uuid: string, deploymentId: string | null): Promise<void> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.gpuSlices).updateOne(
        { uuid },
        { $set: { assignedDeploymentId: deploymentId, updatedAt: new Date() } },
      );
    }

    async deleteGpuSlicesForGpu(hostId: string, gpuUuid: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.gpuSlices).deleteMany({ hostId, gpuUuid });
      return result.deletedCount;
    }

    async deleteGpuSlicesForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.gpuSlices).deleteMany({ hostId });
      return result.deletedCount;
    }

    async deleteGpuFleetCommandsForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.gpuFleetCommands).deleteMany({ hostId });
      return result.deletedCount;
    }

    async deleteGpuFleetEventsForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.gpuFleetEvents).deleteMany({ hostId });
      return result.deletedCount;
    }

    // ── Deployments ──────────────────────────────────────────────────

    async createLlmDeployment(
      deployment: Omit<ILlmDeployment, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ILlmDeployment> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...deployment, createdAt: now, updatedAt: now };
      await db.collection(COLLECTIONS.llmDeployments).insertOne(doc);
      return doc as ILlmDeployment;
    }

    async updateLlmDeployment(
      id: string,
      data: Partial<Omit<ILlmDeployment, '_id' | 'tenantId' | 'id' | 'createdBy' | 'createdAt'>>,
    ): Promise<ILlmDeployment | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.llmDeployments)
        .findOneAndUpdate(
          { id },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
      return result as unknown as ILlmDeployment | null;
    }

    async findLlmDeploymentById(id: string): Promise<ILlmDeployment | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.llmDeployments).findOne({ id });
      return doc as unknown as ILlmDeployment | null;
    }

    async listLlmDeploymentsByHost(hostId: string): Promise<ILlmDeployment[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.llmDeployments)
        .find({ hostId })
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as ILlmDeployment[];
    }

    async listLlmDeploymentsByTenant(tenantId: string): Promise<ILlmDeployment[]> {
      const db = this.getTenantDb();
      const docs = await db
        .collection(COLLECTIONS.llmDeployments)
        .find({ tenantId })
        .sort({ createdAt: -1 })
        .toArray();
      return docs as unknown as ILlmDeployment[];
    }

    async deleteLlmDeployment(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.llmDeployments).deleteOne({ id });
      return result.deletedCount > 0;
    }

    // ── Command queue ────────────────────────────────────────────────

    async enqueueGpuFleetCommand(
      command: Omit<IGpuFleetCommand, '_id'>,
    ): Promise<IGpuFleetCommand> {
      const db = this.getTenantDb();
      const doc = { ...command };
      await db.collection(COLLECTIONS.gpuFleetCommands).insertOne(doc);
      return doc as IGpuFleetCommand;
    }

    async listPendingGpuFleetCommands(hostId: string, limit = 16): Promise<IGpuFleetCommand[]> {
      const db = this.getTenantDb();
      // Only return 'pending' — see sqlite mixin for the rationale.
      const docs = await db
        .collection(COLLECTIONS.gpuFleetCommands)
        .find({ hostId, status: 'pending' })
        .sort({ issuedAt: 1 })
        .limit(limit)
        .toArray();
      return docs as unknown as IGpuFleetCommand[];
    }

    async listGpuFleetCommandsByHost(
      hostId: string,
      options: { limit?: number; resourceRef?: string } = {},
    ): Promise<IGpuFleetCommand[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { hostId };
      if (options.resourceRef) filter.resourceRef = options.resourceRef;
      const docs = await db
        .collection(COLLECTIONS.gpuFleetCommands)
        .find(filter)
        .sort({ issuedAt: -1 })
        .limit(Math.max(1, Math.min(options.limit ?? 200, 1000)))
        .toArray();
      return docs as unknown as IGpuFleetCommand[];
    }

    async findGpuFleetCommandById(id: string): Promise<IGpuFleetCommand | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuFleetCommands).findOne({ id });
      return doc as unknown as IGpuFleetCommand | null;
    }

    async updateGpuFleetCommandStatus(
      id: string,
      status: GpuFleetCommandStatus,
      meta: { lastError?: string | null; deliveredAt?: Date; completedAt?: Date; attemptsDelta?: number } = {},
    ): Promise<void> {
      const db = this.getTenantDb();
      const set: Record<string, unknown> = { status };
      if (meta.lastError !== undefined) set.lastError = meta.lastError;
      if (meta.deliveredAt) set.deliveredAt = meta.deliveredAt;
      if (meta.completedAt) set.completedAt = meta.completedAt;

      const update: Record<string, unknown> = { $set: set };
      if (meta.attemptsDelta) update.$inc = { attempts: meta.attemptsDelta };

      await db.collection(COLLECTIONS.gpuFleetCommands).updateOne({ id }, update);
    }

    // ── Event log ────────────────────────────────────────────────────

    async appendGpuFleetEvent(
      event: Omit<IGpuFleetEvent, '_id' | 'createdAt'>,
    ): Promise<IGpuFleetEvent> {
      const db = this.getTenantDb();
      const doc = { ...event, createdAt: new Date() };
      await db.collection(COLLECTIONS.gpuFleetEvents).insertOne(doc);
      return doc as IGpuFleetEvent;
    }

    async listGpuFleetEvents(
      hostId: string,
      options?: { afterSequence?: number; limit?: number },
    ): Promise<IGpuFleetEvent[]> {
      const db = this.getTenantDb();
      const query: Record<string, unknown> = { hostId };
      if (typeof options?.afterSequence === 'number') {
        query.sequence = { $gt: options.afterSequence };
      }
      const cursor = db
        .collection(COLLECTIONS.gpuFleetEvents)
        .find(query)
        .sort({ sequence: -1 });
      if (options?.limit) cursor.limit(Math.max(1, Math.min(options.limit, 500)));
      const docs = await cursor.toArray();
      return docs as unknown as IGpuFleetEvent[];
    }

    // ── Fleet settings ───────────────────────────────────────────────

    async getGpuFleetSettings(tenantId: string): Promise<IGpuFleetSettings | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.gpuFleetSettings).findOne({ tenantId });
      return doc as unknown as IGpuFleetSettings | null;
    }

    // ── LLM pools ─────────────────────────────────────────────────────

    async createLlmPool(
      pool: Omit<ILlmPool, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ILlmPool> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...pool, createdAt: now, updatedAt: now };
      await db.collection(COLLECTIONS.llmPools).insertOne(doc);
      return doc as ILlmPool;
    }

    async updateLlmPool(
      tenantId: string,
      key: string,
      data: Partial<Omit<ILlmPool, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<ILlmPool | null> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.llmPools).findOneAndUpdate(
        { tenantId, key },
        { $set: { ...data, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      return result as unknown as ILlmPool | null;
    }

    async findLlmPoolByKey(tenantId: string, key: string): Promise<ILlmPool | null> {
      const db = this.getTenantDb();
      const doc = await db.collection(COLLECTIONS.llmPools).findOne({ tenantId, key });
      return doc as unknown as ILlmPool | null;
    }

    async listLlmPools(tenantId: string): Promise<ILlmPool[]> {
      const db = this.getTenantDb();
      const docs = await db.collection(COLLECTIONS.llmPools).find({ tenantId }).sort({ createdAt: -1 }).toArray();
      return docs as unknown as ILlmPool[];
    }

    async deleteLlmPool(tenantId: string, key: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.llmPools).deleteOne({ tenantId, key });
      return result.deletedCount > 0;
    }

    async upsertGpuFleetSettings(
      settings: Omit<IGpuFleetSettings, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuFleetSettings> {
      const db = this.getTenantDb();
      const now = new Date();
      await db.collection(COLLECTIONS.gpuFleetSettings).updateOne(
        { tenantId: settings.tenantId },
        {
          $set: { ...settings, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      const doc = await db.collection(COLLECTIONS.gpuFleetSettings).findOne({ tenantId: settings.tenantId });
      return doc as unknown as IGpuFleetSettings;
    }
  };
}
