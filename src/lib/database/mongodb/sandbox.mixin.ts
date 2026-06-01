/**
 * MongoDB data layer for the Agent Runtime Sandbox subsystem.
 *
 * Fully independent of the GPU fleet mixin — its own collections, no shared
 * helpers beyond the generic `MongoDBProviderBase`.
 */

import { randomUUID } from 'node:crypto';
import type { Constructor } from './types';
import { MongoDBProviderBase } from './base';
import type {
  ISandboxRunner,
  ISandboxTemplate,
  ISandboxInstance,
  ISandboxCommand,
  ISandboxEvent,
  ISandboxVolume,
  ISandboxSettings,
  SandboxInstanceState,
  SandboxCommandStatus,
} from '../provider.interface';

const RUNNERS = 'sandbox_runners';
const TEMPLATES = 'sandbox_templates';
const INSTANCES = 'sandbox_instances';
const COMMANDS = 'sandbox_commands';
const EVENTS = 'sandbox_events';
const VOLUMES = 'sandbox_volumes';
const SETTINGS = 'sandbox_settings';

/** Strip Mongo's internal `_id` from returned documents. */
function clean<T>(doc: unknown): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc as Record<string, unknown>;
  void _id;
  return rest as T;
}

export function SandboxMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class SandboxOps extends Base {
    /* ----------------------------- Runners ----------------------------- */
    async createSandboxRunner(runner: ISandboxRunner): Promise<ISandboxRunner> {
      await this.getTenantDb().collection(RUNNERS).insertOne({ ...runner });
      return runner;
    }

    async getSandboxRunner(id: string): Promise<ISandboxRunner | null> {
      const doc = await this.getTenantDb().collection(RUNNERS).findOne({ id });
      return clean<ISandboxRunner>(doc);
    }

    async listSandboxRunners(): Promise<ISandboxRunner[]> {
      const docs = await this.getTenantDb().collection(RUNNERS).find({}).sort({ createdAt: -1 }).toArray();
      return docs.map((d) => clean<ISandboxRunner>(d)!).filter(Boolean);
    }

    async updateSandboxRunner(id: string, patch: Partial<ISandboxRunner>): Promise<ISandboxRunner | null> {
      const doc = await this.getTenantDb()
        .collection(RUNNERS)
        .findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
      return clean<ISandboxRunner>(doc);
    }

    async deleteSandboxRunner(id: string): Promise<boolean> {
      const res = await this.getTenantDb().collection(RUNNERS).deleteOne({ id });
      return res.deletedCount > 0;
    }

    async findSandboxRunnerByAgentTokenHash(hash: string): Promise<ISandboxRunner | null> {
      const doc = await this.getTenantDb().collection(RUNNERS).findOne({ agentTokenHash: hash });
      return clean<ISandboxRunner>(doc);
    }

    /* ---------------------------- Templates ---------------------------- */
    async createSandboxTemplate(template: ISandboxTemplate): Promise<ISandboxTemplate> {
      await this.getTenantDb().collection(TEMPLATES).insertOne({ ...template });
      return template;
    }

    async getSandboxTemplate(id: string): Promise<ISandboxTemplate | null> {
      const doc = await this.getTenantDb().collection(TEMPLATES).findOne({ id });
      return clean<ISandboxTemplate>(doc);
    }

    async listSandboxTemplates(filters?: { projectId?: string }): Promise<ISandboxTemplate[]> {
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      const docs = await this.getTenantDb().collection(TEMPLATES).find(query).sort({ createdAt: -1 }).toArray();
      return docs.map((d) => clean<ISandboxTemplate>(d)!).filter(Boolean);
    }

    async updateSandboxTemplate(id: string, patch: Partial<ISandboxTemplate>): Promise<ISandboxTemplate | null> {
      const doc = await this.getTenantDb()
        .collection(TEMPLATES)
        .findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
      return clean<ISandboxTemplate>(doc);
    }

    async deleteSandboxTemplate(id: string): Promise<boolean> {
      const res = await this.getTenantDb().collection(TEMPLATES).deleteOne({ id });
      return res.deletedCount > 0;
    }

    /* ---------------------------- Instances ---------------------------- */
    async createSandboxInstance(instance: ISandboxInstance): Promise<ISandboxInstance> {
      await this.getTenantDb().collection(INSTANCES).insertOne({ ...instance });
      return instance;
    }

    async getSandboxInstance(id: string): Promise<ISandboxInstance | null> {
      const doc = await this.getTenantDb().collection(INSTANCES).findOne({ id });
      return clean<ISandboxInstance>(doc);
    }

    async listSandboxInstances(filters?: {
      projectId?: string;
      runnerId?: string;
      actualState?: SandboxInstanceState;
    }): Promise<ISandboxInstance[]> {
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.runnerId) query.runnerId = filters.runnerId;
      if (filters?.actualState) query.actualState = filters.actualState;
      const docs = await this.getTenantDb().collection(INSTANCES).find(query).sort({ createdAt: -1 }).toArray();
      return docs.map((d) => clean<ISandboxInstance>(d)!).filter(Boolean);
    }

    async updateSandboxInstance(id: string, patch: Partial<ISandboxInstance>): Promise<ISandboxInstance | null> {
      const doc = await this.getTenantDb()
        .collection(INSTANCES)
        .findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
      return clean<ISandboxInstance>(doc);
    }

    async deleteSandboxInstance(id: string): Promise<boolean> {
      const res = await this.getTenantDb().collection(INSTANCES).deleteOne({ id });
      return res.deletedCount > 0;
    }

    /* ----------------------------- Commands ---------------------------- */
    async enqueueSandboxCommand(cmd: ISandboxCommand): Promise<ISandboxCommand> {
      await this.getTenantDb().collection(COMMANDS).insertOne({ ...cmd });
      return cmd;
    }

    async getSandboxCommand(id: string): Promise<ISandboxCommand | null> {
      const doc = await this.getTenantDb().collection(COMMANDS).findOne({ id });
      return clean<ISandboxCommand>(doc);
    }

    async listPendingSandboxCommands(runnerId: string, limit: number): Promise<ISandboxCommand[]> {
      const docs = await this.getTenantDb()
        .collection(COMMANDS)
        .find({ runnerId, status: 'pending' })
        .sort({ issuedAt: 1 })
        .limit(limit)
        .toArray();
      return docs.map((d) => clean<ISandboxCommand>(d)!).filter(Boolean);
    }

    async updateSandboxCommandStatus(
      id: string,
      status: SandboxCommandStatus,
      extra?: { deliveredAt?: Date; completedAt?: Date; lastError?: string; attemptsDelta?: number },
    ): Promise<void> {
      const set: Record<string, unknown> = { status };
      if (extra?.deliveredAt) set.deliveredAt = extra.deliveredAt;
      if (extra?.completedAt) set.completedAt = extra.completedAt;
      if (extra?.lastError !== undefined) set.lastError = extra.lastError;
      const update: Record<string, unknown> = { $set: set };
      if (extra?.attemptsDelta) update.$inc = { attempts: extra.attemptsDelta };
      await this.getTenantDb().collection(COMMANDS).updateOne({ id }, update);
    }

    /* ------------------------------ Events ----------------------------- */
    async appendSandboxEvent(event: ISandboxEvent): Promise<{ inserted: boolean }> {
      const db = this.getTenantDb();
      const existing = await db
        .collection(EVENTS)
        .findOne({ runnerId: event.runnerId, sequence: event.sequence });
      if (existing) return { inserted: false };
      await db.collection(EVENTS).insertOne({ ...event });
      return { inserted: true };
    }

    /* ------------------------------ Volumes ---------------------------- */
    async createSandboxVolume(volume: ISandboxVolume): Promise<ISandboxVolume> {
      await this.getTenantDb().collection(VOLUMES).insertOne({ ...volume });
      return volume;
    }

    async getSandboxVolume(id: string): Promise<ISandboxVolume | null> {
      const doc = await this.getTenantDb().collection(VOLUMES).findOne({ id });
      return clean<ISandboxVolume>(doc);
    }

    async listSandboxVolumes(filters?: { projectId?: string }): Promise<ISandboxVolume[]> {
      const query: Record<string, unknown> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      const docs = await this.getTenantDb().collection(VOLUMES).find(query).sort({ createdAt: -1 }).toArray();
      return docs.map((d) => clean<ISandboxVolume>(d)!).filter(Boolean);
    }

    async updateSandboxVolume(id: string, patch: Partial<ISandboxVolume>): Promise<ISandboxVolume | null> {
      const doc = await this.getTenantDb()
        .collection(VOLUMES)
        .findOneAndUpdate({ id }, { $set: { ...patch, updatedAt: new Date() } }, { returnDocument: 'after' });
      return clean<ISandboxVolume>(doc);
    }

    async deleteSandboxVolume(id: string): Promise<boolean> {
      const res = await this.getTenantDb().collection(VOLUMES).deleteOne({ id });
      return res.deletedCount > 0;
    }

    /* ----------------------------- Settings ---------------------------- */
    async getSandboxSettings(): Promise<ISandboxSettings | null> {
      const doc = await this.getTenantDb().collection(SETTINGS).findOne({});
      return clean<ISandboxSettings>(doc);
    }

    async upsertSandboxSettings(patch: Partial<ISandboxSettings>): Promise<ISandboxSettings> {
      const db = this.getTenantDb();
      const existing = clean<ISandboxSettings>(await db.collection(SETTINGS).findOne({}));
      const now = new Date();
      const merged: ISandboxSettings = {
        id: existing?.id ?? patch.id ?? randomUUID(),
        tenantId: existing?.tenantId ?? String(patch.tenantId ?? ''),
        fleetTokenHash: patch.fleetTokenHash ?? existing?.fleetTokenHash ?? null,
        terminalSessionTtlSeconds:
          patch.terminalSessionTtlSeconds ?? existing?.terminalSessionTtlSeconds ?? 3600,
        defaultStorageProvider: patch.defaultStorageProvider ?? existing?.defaultStorageProvider ?? null,
        defaultIsolation: patch.defaultIsolation ?? existing?.defaultIsolation ?? null,
        idleReapSeconds: patch.idleReapSeconds ?? existing?.idleReapSeconds ?? 1800,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await db.collection(SETTINGS).updateOne({ id: merged.id }, { $set: { ...merged } }, { upsert: true });
      return merged;
    }
  };
}
