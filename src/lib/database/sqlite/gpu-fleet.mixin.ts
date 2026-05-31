/**
 * SQLite Provider – GPU fleet operations mixin.
 *
 * Covers four tenant-scoped resources:
 *   - gpu_hosts            : machines connected to the console
 *   - gpu_slices           : schedulable GPU partitions (MIG or full card)
 *   - llm_deployments      : docker containers running a model on a slice
 *   - gpu_fleet_commands   : command queue, drained via agent long-poll
 *   - gpu_fleet_events     : append-only event log from agents
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
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function GpuFleetMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class GpuFleetOps extends Base {
    // ── Hosts ────────────────────────────────────────────────────────

    async createGpuHost(
      host: Omit<IGpuHost, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuHost> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.gpuHosts}
        (id, tenantId, name, provider, status,
         accelerator, gpuFramework, serviceAddress, terminalEnabled,
         agentTokenHash, agentTokenVersion,
         registrationTokenHash, registrationTokenExpiresAt,
         inventory, labels, lastHeartbeatAt, lastEventSequence,
         agentVersion, createdBy, createdAt, updatedAt)
        VALUES
        (@id, @tenantId, @name, @provider, @status,
         @accelerator, @gpuFramework, @serviceAddress, @terminalEnabled,
         @agentTokenHash, @agentTokenVersion,
         @registrationTokenHash, @registrationTokenExpiresAt,
         @inventory, @labels, @lastHeartbeatAt, @lastEventSequence,
         @agentVersion, @createdBy, @createdAt, @updatedAt)
      `).run({
        id: host.id,
        tenantId: host.tenantId,
        name: host.name,
        provider: host.provider,
        status: host.status,
        accelerator: host.accelerator,
        gpuFramework: host.gpuFramework,
        serviceAddress: host.serviceAddress,
        terminalEnabled: host.terminalEnabled ? 1 : 0,
        agentTokenHash: host.agentTokenHash,
        agentTokenVersion: host.agentTokenVersion,
        registrationTokenHash: host.registrationTokenHash,
        registrationTokenExpiresAt: host.registrationTokenExpiresAt?.toISOString() ?? null,
        inventory: host.inventory ? this.toJson(host.inventory) : null,
        labels: this.toJson(host.labels ?? {}),
        lastHeartbeatAt: host.lastHeartbeatAt?.toISOString() ?? null,
        lastEventSequence: host.lastEventSequence ?? 0,
        agentVersion: host.agentVersion,
        createdBy: host.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return (await this.findGpuHostById(host.id))!;
    }

    async updateGpuHost(
      id: string,
      data: Partial<Omit<IGpuHost, '_id' | 'tenantId' | 'id' | 'createdBy' | 'createdAt'>>,
    ): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.provider !== undefined) { sets.push('provider = @provider'); params.provider = data.provider; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.accelerator !== undefined) { sets.push('accelerator = @accelerator'); params.accelerator = data.accelerator; }
      if (data.gpuFramework !== undefined) { sets.push('gpuFramework = @gpuFramework'); params.gpuFramework = data.gpuFramework; }
      if (data.serviceAddress !== undefined) { sets.push('serviceAddress = @serviceAddress'); params.serviceAddress = data.serviceAddress; }
      if (data.terminalEnabled !== undefined) { sets.push('terminalEnabled = @terminalEnabled'); params.terminalEnabled = data.terminalEnabled ? 1 : 0; }
      if (data.agentTokenHash !== undefined) { sets.push('agentTokenHash = @agentTokenHash'); params.agentTokenHash = data.agentTokenHash; }
      if (data.agentTokenVersion !== undefined) { sets.push('agentTokenVersion = @agentTokenVersion'); params.agentTokenVersion = data.agentTokenVersion; }
      if (data.registrationTokenHash !== undefined) { sets.push('registrationTokenHash = @registrationTokenHash'); params.registrationTokenHash = data.registrationTokenHash; }
      if (data.registrationTokenExpiresAt !== undefined) {
        sets.push('registrationTokenExpiresAt = @registrationTokenExpiresAt');
        params.registrationTokenExpiresAt = data.registrationTokenExpiresAt
          ? data.registrationTokenExpiresAt.toISOString()
          : null;
      }
      if (data.inventory !== undefined) {
        sets.push('inventory = @inventory');
        params.inventory = data.inventory ? this.toJson(data.inventory) : null;
      }
      if (data.labels !== undefined) { sets.push('labels = @labels'); params.labels = this.toJson(data.labels); }
      if (data.lastHeartbeatAt !== undefined) {
        sets.push('lastHeartbeatAt = @lastHeartbeatAt');
        params.lastHeartbeatAt = data.lastHeartbeatAt ? data.lastHeartbeatAt.toISOString() : null;
      }
      if (data.lastEventSequence !== undefined) { sets.push('lastEventSequence = @lastEventSequence'); params.lastEventSequence = data.lastEventSequence; }
      if (data.agentVersion !== undefined) { sets.push('agentVersion = @agentVersion'); params.agentVersion = data.agentVersion; }

      db.prepare(`UPDATE ${TABLES.gpuHosts} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findGpuHostById(id);
    }

    async findGpuHostById(id: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuHosts} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapGpuHostRow(row) : null;
    }

    async findGpuHostByAgentTokenHash(hash: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuHosts} WHERE agentTokenHash = @hash`).get({ hash }) as SqliteRow | undefined;
      return row ? this.mapGpuHostRow(row) : null;
    }

    async findGpuHostByRegistrationTokenHash(hash: string): Promise<IGpuHost | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuHosts} WHERE registrationTokenHash = @hash`).get({ hash }) as SqliteRow | undefined;
      return row ? this.mapGpuHostRow(row) : null;
    }

    async listGpuHosts(filters: { tenantId: string; status?: GpuHostStatus } = { tenantId: '' }): Promise<IGpuHost[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId: filters.tenantId };
      if (filters.status) { clauses.push('status = @status'); params.status = filters.status; }
      const rows = db.prepare(`SELECT * FROM ${TABLES.gpuHosts} WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC`).all(params) as SqliteRow[];
      return rows.map((r) => this.mapGpuHostRow(r));
    }

    async deleteGpuHost(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.gpuHosts} WHERE id = @id`).run({ id }).changes > 0;
    }

    // ── Slices ───────────────────────────────────────────────────────

    async upsertGpuSlice(
      slice: Omit<IGpuSlice, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuSlice> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.gpuSlices}
        (uuid, tenantId, hostId, gpuUuid, migGiId, migCiId, kind, profile,
         memoryMiB, assignedDeploymentId, createdAt, updatedAt)
        VALUES
        (@uuid, @tenantId, @hostId, @gpuUuid, @migGiId, @migCiId, @kind, @profile,
         @memoryMiB, @assignedDeploymentId, @createdAt, @updatedAt)
        ON CONFLICT(uuid) DO UPDATE SET
          hostId = excluded.hostId,
          gpuUuid = excluded.gpuUuid,
          migGiId = excluded.migGiId,
          migCiId = excluded.migCiId,
          kind = excluded.kind,
          profile = excluded.profile,
          memoryMiB = excluded.memoryMiB,
          updatedAt = excluded.updatedAt
      `).run({
        uuid: slice.uuid,
        tenantId: slice.tenantId,
        hostId: slice.hostId,
        gpuUuid: slice.gpuUuid,
        migGiId: slice.migGiId,
        migCiId: slice.migCiId,
        kind: slice.kind,
        profile: slice.profile,
        memoryMiB: slice.memoryMiB,
        assignedDeploymentId: slice.assignedDeploymentId,
        createdAt: now,
        updatedAt: now,
      });
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuSlices} WHERE uuid = @uuid`).get({ uuid: slice.uuid }) as SqliteRow;
      return this.mapGpuSliceRow(row);
    }

    async listGpuSlicesByHost(hostId: string): Promise<IGpuSlice[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.gpuSlices} WHERE hostId = @hostId ORDER BY gpuUuid, migGiId`).all({ hostId }) as SqliteRow[];
      return rows.map((r) => this.mapGpuSliceRow(r));
    }

    async findGpuSliceByUuid(uuid: string): Promise<IGpuSlice | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuSlices} WHERE uuid = @uuid`).get({ uuid }) as SqliteRow | undefined;
      return row ? this.mapGpuSliceRow(row) : null;
    }

    async setGpuSliceAssignment(uuid: string, deploymentId: string | null): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`UPDATE ${TABLES.gpuSlices} SET assignedDeploymentId = @deploymentId, updatedAt = @updatedAt WHERE uuid = @uuid`)
        .run({ uuid, deploymentId, updatedAt: this.now() });
    }

    async deleteGpuSlicesForGpu(hostId: string, gpuUuid: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.gpuSlices} WHERE hostId = @hostId AND gpuUuid = @gpuUuid`)
        .run({ hostId, gpuUuid }).changes;
    }

    async deleteGpuSlicesForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.gpuSlices} WHERE hostId = @hostId`).run({ hostId }).changes;
    }

    async deleteGpuFleetCommandsForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.gpuFleetCommands} WHERE hostId = @hostId`).run({ hostId }).changes;
    }

    async deleteGpuFleetEventsForHost(hostId: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.gpuFleetEvents} WHERE hostId = @hostId`).run({ hostId }).changes;
    }

    // ── Deployments ──────────────────────────────────────────────────

    async createLlmDeployment(
      deployment: Omit<ILlmDeployment, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ILlmDeployment> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.llmDeployments}
        (id, tenantId, hostId, sliceUuid, name, runtime, image, modelName,
         args, env, port, healthPath, volumes, restart,
         desiredState, actualState, containerId, lastHealthyAt, lastError,
         inferenceServerKey, createdBy, createdAt, updatedAt)
        VALUES
        (@id, @tenantId, @hostId, @sliceUuid, @name, @runtime, @image, @modelName,
         @args, @env, @port, @healthPath, @volumes, @restart,
         @desiredState, @actualState, @containerId, @lastHealthyAt, @lastError,
         @inferenceServerKey, @createdBy, @createdAt, @updatedAt)
      `).run({
        id: deployment.id,
        tenantId: deployment.tenantId,
        hostId: deployment.hostId,
        sliceUuid: deployment.sliceUuid,
        name: deployment.name,
        runtime: deployment.runtime,
        image: deployment.image,
        modelName: deployment.modelName,
        args: this.toJson(deployment.args ?? []),
        env: this.toJson(deployment.env ?? {}),
        port: deployment.port,
        healthPath: deployment.healthPath,
        volumes: this.toJson(deployment.volumes ?? []),
        restart: deployment.restart,
        desiredState: deployment.desiredState,
        actualState: deployment.actualState,
        containerId: deployment.containerId,
        lastHealthyAt: deployment.lastHealthyAt?.toISOString() ?? null,
        lastError: deployment.lastError,
        inferenceServerKey: deployment.inferenceServerKey,
        createdBy: deployment.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return (await this.findLlmDeploymentById(deployment.id))!;
    }

    async updateLlmDeployment(
      id: string,
      data: Partial<Omit<ILlmDeployment, '_id' | 'tenantId' | 'id' | 'createdBy' | 'createdAt'>>,
    ): Promise<ILlmDeployment | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: now };

      if (data.hostId !== undefined) { sets.push('hostId = @hostId'); params.hostId = data.hostId; }
      if (data.sliceUuid !== undefined) { sets.push('sliceUuid = @sliceUuid'); params.sliceUuid = data.sliceUuid; }
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.runtime !== undefined) { sets.push('runtime = @runtime'); params.runtime = data.runtime; }
      if (data.image !== undefined) { sets.push('image = @image'); params.image = data.image; }
      if (data.modelName !== undefined) { sets.push('modelName = @modelName'); params.modelName = data.modelName; }
      if (data.args !== undefined) { sets.push('args = @args'); params.args = this.toJson(data.args); }
      if (data.env !== undefined) { sets.push('env = @env'); params.env = this.toJson(data.env); }
      if (data.port !== undefined) { sets.push('port = @port'); params.port = data.port; }
      if (data.healthPath !== undefined) { sets.push('healthPath = @healthPath'); params.healthPath = data.healthPath; }
      if (data.volumes !== undefined) { sets.push('volumes = @volumes'); params.volumes = this.toJson(data.volumes); }
      if (data.restart !== undefined) { sets.push('restart = @restart'); params.restart = data.restart; }
      if (data.desiredState !== undefined) { sets.push('desiredState = @desiredState'); params.desiredState = data.desiredState; }
      if (data.actualState !== undefined) { sets.push('actualState = @actualState'); params.actualState = data.actualState; }
      if (data.containerId !== undefined) { sets.push('containerId = @containerId'); params.containerId = data.containerId; }
      if (data.lastHealthyAt !== undefined) { sets.push('lastHealthyAt = @lastHealthyAt'); params.lastHealthyAt = data.lastHealthyAt ? data.lastHealthyAt.toISOString() : null; }
      if (data.lastError !== undefined) { sets.push('lastError = @lastError'); params.lastError = data.lastError; }
      if (data.inferenceServerKey !== undefined) { sets.push('inferenceServerKey = @inferenceServerKey'); params.inferenceServerKey = data.inferenceServerKey; }

      db.prepare(`UPDATE ${TABLES.llmDeployments} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findLlmDeploymentById(id);
    }

    async findLlmDeploymentById(id: string): Promise<ILlmDeployment | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.llmDeployments} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapLlmDeploymentRow(row) : null;
    }

    async listLlmDeploymentsByHost(hostId: string): Promise<ILlmDeployment[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.llmDeployments} WHERE hostId = @hostId ORDER BY createdAt DESC`).all({ hostId }) as SqliteRow[];
      return rows.map((r) => this.mapLlmDeploymentRow(r));
    }

    async listLlmDeploymentsByTenant(tenantId: string): Promise<ILlmDeployment[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.llmDeployments} WHERE tenantId = @tenantId ORDER BY createdAt DESC`).all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapLlmDeploymentRow(r));
    }

    async deleteLlmDeployment(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.llmDeployments} WHERE id = @id`).run({ id }).changes > 0;
    }

    // ── Command queue ────────────────────────────────────────────────

    async enqueueGpuFleetCommand(
      command: Omit<IGpuFleetCommand, '_id'>,
    ): Promise<IGpuFleetCommand> {
      const db = this.getTenantDb();
      db.prepare(`
        INSERT INTO ${TABLES.gpuFleetCommands}
        (id, tenantId, hostId, kind, payload, status, attempts, lastError,
         issuedAt, deliveredAt, completedAt, resourceRef, createdBy)
        VALUES
        (@id, @tenantId, @hostId, @kind, @payload, @status, @attempts, @lastError,
         @issuedAt, @deliveredAt, @completedAt, @resourceRef, @createdBy)
      `).run({
        id: command.id,
        tenantId: command.tenantId,
        hostId: command.hostId,
        kind: command.kind,
        payload: this.toJson(command.payload ?? {}),
        status: command.status,
        attempts: command.attempts ?? 0,
        lastError: command.lastError,
        issuedAt: command.issuedAt.toISOString(),
        deliveredAt: command.deliveredAt?.toISOString() ?? null,
        completedAt: command.completedAt?.toISOString() ?? null,
        resourceRef: command.resourceRef,
        createdBy: command.createdBy,
      });
      return (await this.findGpuFleetCommandById(command.id))!;
    }

    async listPendingGpuFleetCommands(hostId: string, limit = 16): Promise<IGpuFleetCommand[]> {
      const db = this.getTenantDb();
      // CRITICAL: only return 'pending' commands. `delivered` means the agent
      // has already picked it up and is working on it (e.g. mid-pull of a
      // 10GB image). Returning delivered commands re-issues them on every
      // long-poll, causing parallel `docker pull`s and duplicated work.
      // Stuck-delivered recovery is a separate concern — handled by
      // future timeout-based re-queue, not by this hot path.
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.gpuFleetCommands}
        WHERE hostId = @hostId AND status = 'pending'
        ORDER BY issuedAt ASC
        LIMIT @limit
      `).all({ hostId, limit }) as SqliteRow[];
      return rows.map((r) => this.mapGpuFleetCommandRow(r));
    }

    async listGpuFleetCommandsByHost(
      hostId: string,
      options: { limit?: number; resourceRef?: string } = {},
    ): Promise<IGpuFleetCommand[]> {
      const db = this.getTenantDb();
      const clauses = ['hostId = @hostId'];
      const params: Record<string, unknown> = { hostId };
      if (options.resourceRef) {
        clauses.push('resourceRef = @resourceRef');
        params.resourceRef = options.resourceRef;
      }
      const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.gpuFleetCommands}
        WHERE ${clauses.join(' AND ')}
        ORDER BY issuedAt DESC
        LIMIT ${limit}
      `).all(params) as SqliteRow[];
      return rows.map((r) => this.mapGpuFleetCommandRow(r));
    }

    async findGpuFleetCommandById(id: string): Promise<IGpuFleetCommand | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuFleetCommands} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapGpuFleetCommandRow(row) : null;
    }

    async updateGpuFleetCommandStatus(
      id: string,
      status: GpuFleetCommandStatus,
      meta: { lastError?: string | null; deliveredAt?: Date; completedAt?: Date; attemptsDelta?: number } = {},
    ): Promise<void> {
      const db = this.getTenantDb();
      const sets: string[] = ['status = @status'];
      const params: Record<string, unknown> = { id, status };

      if (meta.lastError !== undefined) { sets.push('lastError = @lastError'); params.lastError = meta.lastError; }
      if (meta.deliveredAt) { sets.push('deliveredAt = @deliveredAt'); params.deliveredAt = meta.deliveredAt.toISOString(); }
      if (meta.completedAt) { sets.push('completedAt = @completedAt'); params.completedAt = meta.completedAt.toISOString(); }
      if (meta.attemptsDelta) { sets.push('attempts = attempts + @attemptsDelta'); params.attemptsDelta = meta.attemptsDelta; }

      db.prepare(`UPDATE ${TABLES.gpuFleetCommands} SET ${sets.join(', ')} WHERE id = @id`).run(params);
    }

    // ── Event log ────────────────────────────────────────────────────

    async appendGpuFleetEvent(
      event: Omit<IGpuFleetEvent, '_id' | 'createdAt'>,
    ): Promise<IGpuFleetEvent> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.gpuFleetEvents}
        (id, tenantId, hostId, sequence, kind, occurredAt, payload, createdAt)
        VALUES
        (@id, @tenantId, @hostId, @sequence, @kind, @occurredAt, @payload, @createdAt)
      `).run({
        id,
        tenantId: event.tenantId,
        hostId: event.hostId,
        sequence: event.sequence,
        kind: event.kind,
        occurredAt: event.occurredAt.toISOString(),
        payload: this.toJson(event.payload ?? {}),
        createdAt: now,
      });
      return { ...event, _id: id, createdAt: new Date(now) };
    }

    async listGpuFleetEvents(
      hostId: string,
      options?: { afterSequence?: number; limit?: number },
    ): Promise<IGpuFleetEvent[]> {
      const db = this.getTenantDb();
      const clauses: string[] = ['hostId = @hostId'];
      const params: Record<string, unknown> = { hostId };
      if (typeof options?.afterSequence === 'number') {
        clauses.push('sequence > @afterSequence');
        params.afterSequence = options.afterSequence;
      }
      let sql = `SELECT * FROM ${TABLES.gpuFleetEvents} WHERE ${clauses.join(' AND ')} ORDER BY sequence DESC`;
      if (options?.limit) sql += ` LIMIT ${Math.max(1, Math.min(options.limit, 500))}`;
      const rows = db.prepare(sql).all(params) as SqliteRow[];
      return rows.map((r) => this.mapGpuFleetEventRow(r));
    }

    // ── Row mappers ──────────────────────────────────────────────────

    private mapGpuHostRow(r: SqliteRow): IGpuHost {
      return {
        _id: r.id as string,
        id: r.id as string,
        tenantId: r.tenantId as string,
        name: r.name as string,
        provider: r.provider as IGpuHost['provider'],
        status: r.status as IGpuHost['status'],
        accelerator: (r.accelerator as IGpuHost['accelerator']) ?? 'cpu',
        gpuFramework: (r.gpuFramework as IGpuHost['gpuFramework']) ?? 'none',
        serviceAddress: (r.serviceAddress as string | null) ?? null,
        terminalEnabled: this.fromBoolInt(r.terminalEnabled),
        agentTokenHash: (r.agentTokenHash as string | null) ?? null,
        agentTokenVersion: (r.agentTokenVersion as number | null) ?? 1,
        registrationTokenHash: (r.registrationTokenHash as string | null) ?? null,
        registrationTokenExpiresAt: this.toDate(r.registrationTokenExpiresAt) ?? null,
        inventory: r.inventory ? this.parseJson(r.inventory, {}) : null,
        labels: this.parseJson<Record<string, string>>(r.labels, {}),
        lastHeartbeatAt: this.toDate(r.lastHeartbeatAt) ?? null,
        lastEventSequence: (r.lastEventSequence as number | null) ?? 0,
        agentVersion: (r.agentVersion as string | null) ?? null,
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    // ── Fleet settings ───────────────────────────────────────────────

    async getGpuFleetSettings(tenantId: string): Promise<IGpuFleetSettings | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.gpuFleetSettings} WHERE tenantId = @tenantId`)
        .get({ tenantId }) as SqliteRow | undefined;
      return row ? this.mapGpuFleetSettingsRow(row) : null;
    }

    async upsertGpuFleetSettings(
      settings: Omit<IGpuFleetSettings, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGpuFleetSettings> {
      const db = this.getTenantDb();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.gpuFleetSettings}
        (tenantId, fleetTokenHash, fleetTokenRotatedAt, fleetTokenRotatedBy,
         agentDistributionMode, agentDistributionExternalUrlTemplate,
         terminalSessionTtlSeconds, createdAt, updatedAt)
        VALUES
        (@tenantId, @fleetTokenHash, @fleetTokenRotatedAt, @fleetTokenRotatedBy,
         @agentDistributionMode, @agentDistributionExternalUrlTemplate,
         @terminalSessionTtlSeconds, @createdAt, @updatedAt)
        ON CONFLICT(tenantId) DO UPDATE SET
          fleetTokenHash = excluded.fleetTokenHash,
          fleetTokenRotatedAt = excluded.fleetTokenRotatedAt,
          fleetTokenRotatedBy = excluded.fleetTokenRotatedBy,
          agentDistributionMode = excluded.agentDistributionMode,
          agentDistributionExternalUrlTemplate = excluded.agentDistributionExternalUrlTemplate,
          terminalSessionTtlSeconds = excluded.terminalSessionTtlSeconds,
          updatedAt = excluded.updatedAt
      `).run({
        tenantId: settings.tenantId,
        fleetTokenHash: settings.fleetTokenHash,
        fleetTokenRotatedAt: settings.fleetTokenRotatedAt?.toISOString() ?? null,
        fleetTokenRotatedBy: settings.fleetTokenRotatedBy,
        agentDistributionMode: settings.agentDistributionMode,
        agentDistributionExternalUrlTemplate: settings.agentDistributionExternalUrlTemplate,
        terminalSessionTtlSeconds: settings.terminalSessionTtlSeconds,
        createdAt: now,
        updatedAt: now,
      });
      return (await this.getGpuFleetSettings(settings.tenantId))!;
    }

    // ── LLM pools ─────────────────────────────────────────────────────

    async createLlmPool(
      pool: Omit<ILlmPool, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<ILlmPool> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.llmPools}
        (id, tenantId, key, name, description, modelName, modelLibraryId,
         algorithm, status, deploymentIds, weights, providerKey, modelKey,
         createdBy, createdAt, updatedAt)
        VALUES
        (@id, @tenantId, @key, @name, @description, @modelName, @modelLibraryId,
         @algorithm, @status, @deploymentIds, @weights, @providerKey, @modelKey,
         @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: pool.tenantId,
        key: pool.key,
        name: pool.name,
        description: pool.description,
        modelName: pool.modelName,
        modelLibraryId: pool.modelLibraryId,
        algorithm: pool.algorithm,
        status: pool.status,
        deploymentIds: this.toJson(pool.deploymentIds ?? []),
        weights: this.toJson(pool.weights ?? {}),
        providerKey: pool.providerKey,
        modelKey: pool.modelKey,
        createdBy: pool.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return (await this.findLlmPoolByKey(pool.tenantId, pool.key))!;
    }

    async updateLlmPool(
      tenantId: string,
      key: string,
      data: Partial<Omit<ILlmPool, '_id' | 'tenantId' | 'key' | 'createdBy' | 'createdAt'>>,
    ): Promise<ILlmPool | null> {
      const db = this.getTenantDb();
      const now = this.now();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { tenantId, key, updatedAt: now };
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.modelName !== undefined) { sets.push('modelName = @modelName'); params.modelName = data.modelName; }
      if (data.algorithm !== undefined) { sets.push('algorithm = @algorithm'); params.algorithm = data.algorithm; }
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status; }
      if (data.deploymentIds !== undefined) { sets.push('deploymentIds = @deploymentIds'); params.deploymentIds = this.toJson(data.deploymentIds); }
      if (data.weights !== undefined) { sets.push('weights = @weights'); params.weights = this.toJson(data.weights); }
      if (data.providerKey !== undefined) { sets.push('providerKey = @providerKey'); params.providerKey = data.providerKey; }
      if (data.modelKey !== undefined) { sets.push('modelKey = @modelKey'); params.modelKey = data.modelKey; }
      db.prepare(`UPDATE ${TABLES.llmPools} SET ${sets.join(', ')} WHERE tenantId = @tenantId AND key = @key`).run(params);
      return this.findLlmPoolByKey(tenantId, key);
    }

    async findLlmPoolByKey(tenantId: string, key: string): Promise<ILlmPool | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.llmPools} WHERE tenantId = @tenantId AND key = @key`)
        .get({ tenantId, key }) as SqliteRow | undefined;
      return row ? this.mapLlmPoolRow(row) : null;
    }

    async listLlmPools(tenantId: string): Promise<ILlmPool[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.llmPools} WHERE tenantId = @tenantId ORDER BY createdAt DESC`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapLlmPoolRow(r));
    }

    async deleteLlmPool(tenantId: string, key: string): Promise<boolean> {
      const db = this.getTenantDb();
      return db.prepare(`DELETE FROM ${TABLES.llmPools} WHERE tenantId = @tenantId AND key = @key`)
        .run({ tenantId, key }).changes > 0;
    }

    private mapLlmPoolRow(r: SqliteRow): ILlmPool {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        key: r.key as string,
        name: r.name as string,
        description: (r.description as string | null) ?? null,
        modelName: r.modelName as string,
        modelLibraryId: (r.modelLibraryId as string | null) ?? null,
        algorithm: r.algorithm as ILlmPool['algorithm'],
        status: r.status as ILlmPool['status'],
        deploymentIds: this.parseJson<string[]>(r.deploymentIds, []),
        weights: this.parseJson<Record<string, number>>(r.weights, {}),
        providerKey: (r.providerKey as string | null) ?? null,
        modelKey: (r.modelKey as string | null) ?? null,
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapGpuFleetSettingsRow(r: SqliteRow): IGpuFleetSettings {
      return {
        tenantId: r.tenantId as string,
        fleetTokenHash: (r.fleetTokenHash as string | null) ?? null,
        fleetTokenRotatedAt: this.toDate(r.fleetTokenRotatedAt) ?? null,
        fleetTokenRotatedBy: (r.fleetTokenRotatedBy as string | null) ?? null,
        agentDistributionMode: (r.agentDistributionMode as IGpuFleetSettings['agentDistributionMode']) ?? 'console-served',
        agentDistributionExternalUrlTemplate: (r.agentDistributionExternalUrlTemplate as string | null) ?? null,
        terminalSessionTtlSeconds: (r.terminalSessionTtlSeconds as number | null) ?? 1800,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapGpuSliceRow(r: SqliteRow): IGpuSlice {
      return {
        uuid: r.uuid as string,
        tenantId: r.tenantId as string,
        hostId: r.hostId as string,
        gpuUuid: r.gpuUuid as string,
        migGiId: (r.migGiId as number | null) ?? null,
        migCiId: (r.migCiId as number | null) ?? null,
        kind: r.kind as IGpuSlice['kind'],
        profile: (r.profile as string | null) ?? null,
        memoryMiB: (r.memoryMiB as number | null) ?? 0,
        assignedDeploymentId: (r.assignedDeploymentId as string | null) ?? null,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapLlmDeploymentRow(r: SqliteRow): ILlmDeployment {
      return {
        _id: r.id as string,
        id: r.id as string,
        tenantId: r.tenantId as string,
        hostId: r.hostId as string,
        sliceUuid: (r.sliceUuid as string | null) ?? null,
        name: r.name as string,
        runtime: r.runtime as ILlmDeployment['runtime'],
        image: r.image as string,
        modelName: r.modelName as string,
        args: this.parseJson<string[]>(r.args, []),
        env: this.parseJson<Record<string, string>>(r.env, {}),
        port: r.port as number,
        healthPath: r.healthPath as string,
        volumes: this.parseJson<ILlmDeployment['volumes']>(r.volumes, []),
        restart: r.restart as ILlmDeployment['restart'],
        desiredState: r.desiredState as ILlmDeployment['desiredState'],
        actualState: r.actualState as ILlmDeployment['actualState'],
        containerId: (r.containerId as string | null) ?? null,
        lastHealthyAt: this.toDate(r.lastHealthyAt) ?? null,
        lastError: (r.lastError as string | null) ?? null,
        inferenceServerKey: (r.inferenceServerKey as string | null) ?? null,
        createdBy: r.createdBy as string,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    private mapGpuFleetCommandRow(r: SqliteRow): IGpuFleetCommand {
      return {
        _id: r.id as string,
        id: r.id as string,
        tenantId: r.tenantId as string,
        hostId: r.hostId as string,
        kind: r.kind as string,
        payload: this.parseJson(r.payload, {}),
        status: r.status as GpuFleetCommandStatus,
        attempts: (r.attempts as number | null) ?? 0,
        lastError: (r.lastError as string | null) ?? null,
        issuedAt: this.toDate(r.issuedAt) ?? new Date(0),
        deliveredAt: this.toDate(r.deliveredAt) ?? null,
        completedAt: this.toDate(r.completedAt) ?? null,
        resourceRef: (r.resourceRef as string | null) ?? null,
        createdBy: r.createdBy as string,
      };
    }

    private mapGpuFleetEventRow(r: SqliteRow): IGpuFleetEvent {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        hostId: r.hostId as string,
        sequence: r.sequence as number,
        kind: r.kind as string,
        occurredAt: this.toDate(r.occurredAt) ?? new Date(0),
        payload: this.parseJson(r.payload, {}),
        createdAt: this.toDate(r.createdAt),
      };
    }
  };
}
