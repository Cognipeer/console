/**
 * SQLite data layer for the Agent Runtime Sandbox subsystem.
 *
 * Fully independent of the GPU fleet mixin — shares no tables or helpers
 * beyond the generic `SQLiteProviderBase`.
 */

import { randomUUID } from 'node:crypto';
import type { Constructor } from './types';
import { SQLiteProviderBase } from './base';
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

type Row = Record<string, unknown>;

const RUNNERS = 'sandbox_runners';
const TEMPLATES = 'sandbox_templates';
const INSTANCES = 'sandbox_instances';
const COMMANDS = 'sandbox_commands';
const EVENTS = 'sandbox_events';
const VOLUMES = 'sandbox_volumes';
const SETTINGS = 'sandbox_settings';

const json = (value: unknown): string | null => (value == null ? null : JSON.stringify(value));
const parseJson = <T>(raw: unknown, fallback: T): T =>
  raw == null ? fallback : (JSON.parse(String(raw)) as T);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const date = (raw: unknown): Date | null => (raw == null ? null : new Date(String(raw)));

function rowToRunner(row: Row): ISandboxRunner {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: String(row.name),
    status: row.status as ISandboxRunner['status'],
    labels: parseJson<Record<string, string>>(row.labels, {}),
    inventory: row.inventory ? parseJson<Record<string, unknown>>(row.inventory, {}) : null,
    agentTokenHash: row.agentTokenHash ? String(row.agentTokenHash) : null,
    agentTokenVersion: Number(row.agentTokenVersion ?? 0),
    registrationTokenHash: row.registrationTokenHash ? String(row.registrationTokenHash) : null,
    registrationTokenExpiresAt: date(row.registrationTokenExpiresAt),
    lastSeenAt: date(row.lastSeenAt),
    lastEventSequence: Number(row.lastEventSequence ?? 0),
    terminalEnabled: Number(row.terminalEnabled ?? 0) === 1,
    createdBy: String(row.createdBy),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

function rowToTemplate(row: Row): ISandboxTemplate {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    projectId: row.projectId ? String(row.projectId) : null,
    key: String(row.key),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    baseImage: String(row.baseImage),
    runtime: String(row.runtime),
    isolation: String(row.isolation),
    resources: parseJson<Record<string, unknown>>(row.resources, {}),
    env: parseJson<Record<string, string>>(row.env, {}),
    entrypoint: row.entrypoint ? parseJson<string[]>(row.entrypoint, []) : null,
    toolboxPort: Number(row.toolboxPort),
    previewPorts: parseJson<Array<Record<string, unknown>>>(row.previewPorts, []),
    volumeMounts: parseJson<Array<Record<string, unknown>>>(row.volumeMounts, []),
    enabled: Number(row.enabled ?? 1) === 1,
    createdBy: String(row.createdBy),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

function rowToInstance(row: Row): ISandboxInstance {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    projectId: row.projectId ? String(row.projectId) : null,
    templateId: String(row.templateId),
    runnerId: row.runnerId ? String(row.runnerId) : null,
    name: String(row.name),
    containerId: row.containerId ? String(row.containerId) : null,
    desiredState: row.desiredState as ISandboxInstance['desiredState'],
    actualState: row.actualState as SandboxInstanceState,
    volumeId: row.volumeId ? String(row.volumeId) : null,
    toolboxPort: row.toolboxPort == null ? null : Number(row.toolboxPort),
    previewPorts: parseJson<Array<Record<string, unknown>>>(row.previewPorts, []),
    isolation: String(row.isolation),
    env: parseJson<Record<string, string>>(row.env, {}),
    lastError: row.lastError ? String(row.lastError) : null,
    lastActivityAt: date(row.lastActivityAt),
    createdBy: String(row.createdBy),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

function rowToCommand(row: Row): ISandboxCommand {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    runnerId: String(row.runnerId),
    instanceId: row.instanceId ? String(row.instanceId) : null,
    kind: String(row.kind),
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    status: row.status as SandboxCommandStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: row.lastError ? String(row.lastError) : null,
    issuedAt: new Date(String(row.issuedAt)),
    deliveredAt: date(row.deliveredAt),
    completedAt: date(row.completedAt),
    createdBy: String(row.createdBy),
  };
}

function rowToVolume(row: Row): ISandboxVolume {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    projectId: row.projectId ? String(row.projectId) : null,
    name: String(row.name),
    provider: row.provider as ISandboxVolume['provider'],
    container: String(row.container),
    prefix: String(row.prefix),
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    createdBy: String(row.createdBy),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

function rowToSettings(row: Row): ISandboxSettings {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    fleetTokenHash: row.fleetTokenHash ? String(row.fleetTokenHash) : null,
    terminalSessionTtlSeconds: Number(row.terminalSessionTtlSeconds ?? 3600),
    defaultStorageProvider: row.defaultStorageProvider ? String(row.defaultStorageProvider) : null,
    defaultIsolation: row.defaultIsolation ? String(row.defaultIsolation) : null,
    idleReapSeconds: Number(row.idleReapSeconds ?? 1800),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  };
}

export function SandboxMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class SandboxOps extends Base {
    /* ----------------------------- Runners ----------------------------- */
    private writeRunner(r: ISandboxRunner): void {
      const db = this.getTenantDb();
      db.prepare(
        `INSERT OR REPLACE INTO ${RUNNERS}
           (id, tenantId, name, status, labels, inventory, agentTokenHash, agentTokenVersion,
            registrationTokenHash, registrationTokenExpiresAt, lastSeenAt, lastEventSequence,
            terminalEnabled, createdBy, createdAt, updatedAt)
         VALUES (@id, @tenantId, @name, @status, @labels, @inventory, @agentTokenHash, @agentTokenVersion,
            @registrationTokenHash, @registrationTokenExpiresAt, @lastSeenAt, @lastEventSequence,
            @terminalEnabled, @createdBy, @createdAt, @updatedAt)`,
      ).run({
        id: r.id,
        tenantId: r.tenantId,
        name: r.name,
        status: r.status,
        labels: json(r.labels ?? {}),
        inventory: json(r.inventory),
        agentTokenHash: r.agentTokenHash,
        agentTokenVersion: r.agentTokenVersion,
        registrationTokenHash: r.registrationTokenHash,
        registrationTokenExpiresAt: iso(r.registrationTokenExpiresAt),
        lastSeenAt: iso(r.lastSeenAt),
        lastEventSequence: r.lastEventSequence,
        terminalEnabled: r.terminalEnabled ? 1 : 0,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    async createSandboxRunner(runner: ISandboxRunner): Promise<ISandboxRunner> {
      this.writeRunner(runner);
      return runner;
    }

    async getSandboxRunner(id: string): Promise<ISandboxRunner | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${RUNNERS} WHERE id = ?`).get(id) as Row | undefined;
      return row ? rowToRunner(row) : null;
    }

    async listSandboxRunners(): Promise<ISandboxRunner[]> {
      const rows = this.getTenantDb().prepare(`SELECT * FROM ${RUNNERS} ORDER BY createdAt DESC`).all() as Row[];
      return rows.map(rowToRunner);
    }

    async updateSandboxRunner(id: string, patch: Partial<ISandboxRunner>): Promise<ISandboxRunner | null> {
      const current = await this.getSandboxRunner(id);
      if (!current) return null;
      const merged: ISandboxRunner = { ...current, ...patch, id, updatedAt: new Date() };
      this.writeRunner(merged);
      return merged;
    }

    async deleteSandboxRunner(id: string): Promise<boolean> {
      const res = this.getTenantDb().prepare(`DELETE FROM ${RUNNERS} WHERE id = ?`).run(id);
      return res.changes > 0;
    }

    async findSandboxRunnerByAgentTokenHash(hash: string): Promise<ISandboxRunner | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${RUNNERS} WHERE agentTokenHash = ?`)
        .get(hash) as Row | undefined;
      return row ? rowToRunner(row) : null;
    }

    /* ---------------------------- Templates ---------------------------- */
    private writeTemplate(t: ISandboxTemplate): void {
      this.getTenantDb()
        .prepare(
          `INSERT OR REPLACE INTO ${TEMPLATES}
             (id, tenantId, projectId, key, name, description, baseImage, runtime, isolation,
              resources, env, entrypoint, toolboxPort, previewPorts, volumeMounts, enabled,
              createdBy, createdAt, updatedAt)
           VALUES (@id, @tenantId, @projectId, @key, @name, @description, @baseImage, @runtime, @isolation,
              @resources, @env, @entrypoint, @toolboxPort, @previewPorts, @volumeMounts, @enabled,
              @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          id: t.id,
          tenantId: t.tenantId,
          projectId: t.projectId,
          key: t.key,
          name: t.name,
          description: t.description,
          baseImage: t.baseImage,
          runtime: t.runtime,
          isolation: t.isolation,
          resources: json(t.resources ?? {}),
          env: json(t.env ?? {}),
          entrypoint: json(t.entrypoint),
          toolboxPort: t.toolboxPort,
          previewPorts: json(t.previewPorts ?? []),
          volumeMounts: json(t.volumeMounts ?? []),
          enabled: t.enabled ? 1 : 0,
          createdBy: t.createdBy,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        });
    }

    async createSandboxTemplate(template: ISandboxTemplate): Promise<ISandboxTemplate> {
      this.writeTemplate(template);
      return template;
    }

    async getSandboxTemplate(id: string): Promise<ISandboxTemplate | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${TEMPLATES} WHERE id = ?`).get(id) as Row | undefined;
      return row ? rowToTemplate(row) : null;
    }

    async listSandboxTemplates(filters?: { projectId?: string }): Promise<ISandboxTemplate[]> {
      const db = this.getTenantDb();
      const rows = (
        filters?.projectId
          ? db.prepare(`SELECT * FROM ${TEMPLATES} WHERE projectId = ? ORDER BY createdAt DESC`).all(filters.projectId)
          : db.prepare(`SELECT * FROM ${TEMPLATES} ORDER BY createdAt DESC`).all()
      ) as Row[];
      return rows.map(rowToTemplate);
    }

    async updateSandboxTemplate(id: string, patch: Partial<ISandboxTemplate>): Promise<ISandboxTemplate | null> {
      const current = await this.getSandboxTemplate(id);
      if (!current) return null;
      const merged: ISandboxTemplate = { ...current, ...patch, id, updatedAt: new Date() };
      this.writeTemplate(merged);
      return merged;
    }

    async deleteSandboxTemplate(id: string): Promise<boolean> {
      const res = this.getTenantDb().prepare(`DELETE FROM ${TEMPLATES} WHERE id = ?`).run(id);
      return res.changes > 0;
    }

    /* ---------------------------- Instances ---------------------------- */
    private writeInstance(i: ISandboxInstance): void {
      this.getTenantDb()
        .prepare(
          `INSERT OR REPLACE INTO ${INSTANCES}
             (id, tenantId, projectId, templateId, runnerId, name, containerId, desiredState,
              actualState, volumeId, toolboxPort, previewPorts, isolation, env, lastError, lastActivityAt,
              createdBy, createdAt, updatedAt)
           VALUES (@id, @tenantId, @projectId, @templateId, @runnerId, @name, @containerId, @desiredState,
              @actualState, @volumeId, @toolboxPort, @previewPorts, @isolation, @env, @lastError, @lastActivityAt,
              @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          id: i.id,
          tenantId: i.tenantId,
          projectId: i.projectId,
          templateId: i.templateId,
          runnerId: i.runnerId,
          name: i.name,
          containerId: i.containerId,
          desiredState: i.desiredState,
          actualState: i.actualState,
          volumeId: i.volumeId,
          toolboxPort: i.toolboxPort,
          previewPorts: json(i.previewPorts ?? []),
          isolation: i.isolation,
          env: json(i.env ?? {}),
          lastError: i.lastError,
          lastActivityAt: iso(i.lastActivityAt),
          createdBy: i.createdBy,
          createdAt: i.createdAt.toISOString(),
          updatedAt: i.updatedAt.toISOString(),
        });
    }

    async createSandboxInstance(instance: ISandboxInstance): Promise<ISandboxInstance> {
      this.writeInstance(instance);
      return instance;
    }

    async getSandboxInstance(id: string): Promise<ISandboxInstance | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${INSTANCES} WHERE id = ?`).get(id) as Row | undefined;
      return row ? rowToInstance(row) : null;
    }

    async listSandboxInstances(filters?: {
      projectId?: string;
      runnerId?: string;
      actualState?: SandboxInstanceState;
    }): Promise<ISandboxInstance[]> {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters?.projectId) {
        clauses.push('projectId = ?');
        params.push(filters.projectId);
      }
      if (filters?.runnerId) {
        clauses.push('runnerId = ?');
        params.push(filters.runnerId);
      }
      if (filters?.actualState) {
        clauses.push('actualState = ?');
        params.push(filters.actualState);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = this.getTenantDb()
        .prepare(`SELECT * FROM ${INSTANCES} ${where} ORDER BY createdAt DESC`)
        .all(...params) as Row[];
      return rows.map(rowToInstance);
    }

    async updateSandboxInstance(id: string, patch: Partial<ISandboxInstance>): Promise<ISandboxInstance | null> {
      const current = await this.getSandboxInstance(id);
      if (!current) return null;
      const merged: ISandboxInstance = { ...current, ...patch, id, updatedAt: new Date() };
      this.writeInstance(merged);
      return merged;
    }

    async deleteSandboxInstance(id: string): Promise<boolean> {
      const res = this.getTenantDb().prepare(`DELETE FROM ${INSTANCES} WHERE id = ?`).run(id);
      return res.changes > 0;
    }

    /* ----------------------------- Commands ---------------------------- */
    async enqueueSandboxCommand(cmd: ISandboxCommand): Promise<ISandboxCommand> {
      this.getTenantDb()
        .prepare(
          `INSERT INTO ${COMMANDS}
             (id, tenantId, runnerId, instanceId, kind, payload, status, attempts, lastError,
              issuedAt, deliveredAt, completedAt, createdBy)
           VALUES (@id, @tenantId, @runnerId, @instanceId, @kind, @payload, @status, @attempts, @lastError,
              @issuedAt, @deliveredAt, @completedAt, @createdBy)`,
        )
        .run({
          id: cmd.id,
          tenantId: cmd.tenantId,
          runnerId: cmd.runnerId,
          instanceId: cmd.instanceId,
          kind: cmd.kind,
          payload: json(cmd.payload ?? {}),
          status: cmd.status,
          attempts: cmd.attempts,
          lastError: cmd.lastError,
          issuedAt: cmd.issuedAt.toISOString(),
          deliveredAt: iso(cmd.deliveredAt),
          completedAt: iso(cmd.completedAt),
          createdBy: cmd.createdBy,
        });
      return cmd;
    }

    async getSandboxCommand(id: string): Promise<ISandboxCommand | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${COMMANDS} WHERE id = ?`).get(id) as Row | undefined;
      return row ? rowToCommand(row) : null;
    }

    async listPendingSandboxCommands(runnerId: string, limit: number): Promise<ISandboxCommand[]> {
      const rows = this.getTenantDb()
        .prepare(
          `SELECT * FROM ${COMMANDS} WHERE runnerId = ? AND status = 'pending' ORDER BY issuedAt ASC LIMIT ?`,
        )
        .all(runnerId, limit) as Row[];
      return rows.map(rowToCommand);
    }

    async updateSandboxCommandStatus(
      id: string,
      status: SandboxCommandStatus,
      extra?: { deliveredAt?: Date; completedAt?: Date; lastError?: string; attemptsDelta?: number },
    ): Promise<void> {
      const sets = ['status = @status'];
      const params: Record<string, unknown> = { id, status };
      if (extra?.deliveredAt) {
        sets.push('deliveredAt = @deliveredAt');
        params.deliveredAt = extra.deliveredAt.toISOString();
      }
      if (extra?.completedAt) {
        sets.push('completedAt = @completedAt');
        params.completedAt = extra.completedAt.toISOString();
      }
      if (extra?.lastError !== undefined) {
        sets.push('lastError = @lastError');
        params.lastError = extra.lastError;
      }
      if (extra?.attemptsDelta) {
        sets.push('attempts = attempts + @attemptsDelta');
        params.attemptsDelta = extra.attemptsDelta;
      }
      this.getTenantDb().prepare(`UPDATE ${COMMANDS} SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }

    /* ------------------------------ Events ----------------------------- */
    async appendSandboxEvent(event: ISandboxEvent): Promise<{ inserted: boolean }> {
      try {
        this.getTenantDb()
          .prepare(
            `INSERT INTO ${EVENTS} (id, tenantId, runnerId, sequence, kind, payload, occurredAt, receivedAt)
             VALUES (@id, @tenantId, @runnerId, @sequence, @kind, @payload, @occurredAt, @receivedAt)`,
          )
          .run({
            id: event.id,
            tenantId: event.tenantId,
            runnerId: event.runnerId,
            sequence: event.sequence,
            kind: event.kind,
            payload: json(event.payload ?? {}),
            occurredAt: event.occurredAt.toISOString(),
            receivedAt: event.receivedAt.toISOString(),
          });
        return { inserted: true };
      } catch (err) {
        // UNIQUE(runnerId, sequence) violation → duplicate event, skip.
        if (err instanceof Error && /UNIQUE/i.test(err.message)) return { inserted: false };
        throw err;
      }
    }

    /* ------------------------------ Volumes ---------------------------- */
    private writeVolume(v: ISandboxVolume): void {
      this.getTenantDb()
        .prepare(
          `INSERT OR REPLACE INTO ${VOLUMES}
             (id, tenantId, projectId, name, provider, container, prefix, sizeBytes, createdBy, createdAt, updatedAt)
           VALUES (@id, @tenantId, @projectId, @name, @provider, @container, @prefix, @sizeBytes, @createdBy, @createdAt, @updatedAt)`,
        )
        .run({
          id: v.id,
          tenantId: v.tenantId,
          projectId: v.projectId,
          name: v.name,
          provider: v.provider,
          container: v.container,
          prefix: v.prefix,
          sizeBytes: v.sizeBytes,
          createdBy: v.createdBy,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        });
    }

    async createSandboxVolume(volume: ISandboxVolume): Promise<ISandboxVolume> {
      this.writeVolume(volume);
      return volume;
    }

    async getSandboxVolume(id: string): Promise<ISandboxVolume | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${VOLUMES} WHERE id = ?`).get(id) as Row | undefined;
      return row ? rowToVolume(row) : null;
    }

    async listSandboxVolumes(filters?: { projectId?: string }): Promise<ISandboxVolume[]> {
      const db = this.getTenantDb();
      const rows = (
        filters?.projectId
          ? db.prepare(`SELECT * FROM ${VOLUMES} WHERE projectId = ? ORDER BY createdAt DESC`).all(filters.projectId)
          : db.prepare(`SELECT * FROM ${VOLUMES} ORDER BY createdAt DESC`).all()
      ) as Row[];
      return rows.map(rowToVolume);
    }

    async updateSandboxVolume(id: string, patch: Partial<ISandboxVolume>): Promise<ISandboxVolume | null> {
      const current = await this.getSandboxVolume(id);
      if (!current) return null;
      const merged: ISandboxVolume = { ...current, ...patch, id, updatedAt: new Date() };
      this.writeVolume(merged);
      return merged;
    }

    async deleteSandboxVolume(id: string): Promise<boolean> {
      const res = this.getTenantDb().prepare(`DELETE FROM ${VOLUMES} WHERE id = ?`).run(id);
      return res.changes > 0;
    }

    /* ----------------------------- Settings ---------------------------- */
    async getSandboxSettings(): Promise<ISandboxSettings | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${SETTINGS} LIMIT 1`).get() as Row | undefined;
      return row ? rowToSettings(row) : null;
    }

    async upsertSandboxSettings(patch: Partial<ISandboxSettings>): Promise<ISandboxSettings> {
      const existing = await this.getSandboxSettings();
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
      this.getTenantDb()
        .prepare(
          `INSERT OR REPLACE INTO ${SETTINGS}
             (id, tenantId, fleetTokenHash, terminalSessionTtlSeconds, defaultStorageProvider,
              defaultIsolation, idleReapSeconds, createdAt, updatedAt)
           VALUES (@id, @tenantId, @fleetTokenHash, @terminalSessionTtlSeconds, @defaultStorageProvider,
              @defaultIsolation, @idleReapSeconds, @createdAt, @updatedAt)`,
        )
        .run({
          id: merged.id,
          tenantId: merged.tenantId,
          fleetTokenHash: merged.fleetTokenHash,
          terminalSessionTtlSeconds: merged.terminalSessionTtlSeconds,
          defaultStorageProvider: merged.defaultStorageProvider,
          defaultIsolation: merged.defaultIsolation,
          idleReapSeconds: merged.idleReapSeconds,
          createdAt: merged.createdAt.toISOString(),
          updatedAt: merged.updatedAt.toISOString(),
        });
      return merged;
    }
  };
}
