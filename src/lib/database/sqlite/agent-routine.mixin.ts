/**
 * SQLite Provider – Agent routines mixin
 *
 * A routine's `type` is a column; the settings of that type are one JSON
 * column named after it (`schedule`, `once`, `webhook`; manual has none, the
 * others stay NULL), their dates as ISO strings. `nextFireAt` is its own
 * column: the scheduler's `(enabled, nextFireAt)` index reads it; so is a
 * webhook routine's `hookId` (the incoming webhook's lookup). A webhook
 * routine's delivery log is `agent_routine_deliveries`.
 */

import type {
  AgentRoutinePatch,
  AgentRoutineSchedule,
  AgentRoutineType,
  AgentRoutineTypeSettings,
  AgentRoutineWebhook,
  IAgentRoutine,
  IAgentRoutineDelivery,
  NewAgentRoutine,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function AgentRoutineMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AgentRoutineOps extends Base {
    private routineColumns(record: AgentRoutinePatch): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      if (record.name !== undefined) out.name = record.name;
      if (record.description !== undefined) out.description = record.description ?? null;
      if (record.enabled !== undefined) out.enabled = this.toBoolInt(record.enabled);
      if (record.type !== undefined) {
        // A new type replaces the settings as a whole: only its own column is filled.
        out.type = record.type;
        out.schedule = record.type === 'schedule' ? this.toJson(record.schedule) : null;
        out.once = record.type === 'once' ? this.toJson({ runAt: iso(record.once.runAt) }) : null;
        out.webhook = record.type === 'webhook'
          ? this.toJson({ ...record.webhook, previousSecretExpiresAt: iso(record.webhook.previousSecretExpiresAt) })
          : null;
        out.hookId = record.type === 'webhook' ? record.webhook.hookId : null;
      }
      if (record.prompt !== undefined) out.prompt = record.prompt;
      if (record.version !== undefined) out.version = record.version ?? null;
      if (record.runClass !== undefined) out.runClass = record.runClass;
      for (const key of ['inputs', 'metadata', 'callback', 'responseFormat'] as const) {
        if (record[key] !== undefined) out[key] = record[key] === null ? null : this.toJson(record[key]);
      }
      for (const key of ['nextFireAt', 'lastFireAt'] as const) {
        if (record[key] !== undefined) out[key] = iso(record[key]);
      }
      for (const key of ['lastRunId', 'lastStatus', 'lastError', 'updatedBy'] as const) {
        if (record[key] !== undefined) out[key] = record[key] ?? null;
      }
      return out;
    }

    async createAgentRoutine(record: NewAgentRoutine): Promise<IAgentRoutine> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      const columns: Record<string, unknown> = {
        id,
        tenantId: record.tenantId,
        projectId: record.projectId,
        agentKey: record.agentKey,
        createdBy: record.createdBy,
        createdAt: now,
        updatedAt: now,
        // Defaults for the optional columns a new routine leaves out.
        description: null, version: null, inputs: null, metadata: null, callback: null, responseFormat: null,
        nextFireAt: null, lastFireAt: null, lastRunId: null, lastStatus: null, lastError: null, updatedBy: null, hookId: null,
        ...this.routineColumns(record),
      };
      const names = Object.keys(columns);
      db.prepare(
        `INSERT INTO ${TABLES.agentRoutines} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`,
      ).run(columns);
      return (await this.findAgentRoutineRaw(id))!;
    }

    private async findAgentRoutineRaw(id: string): Promise<IAgentRoutine | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${TABLES.agentRoutines} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAgentRoutine(row) : null;
    }

    async getAgentRoutine(id: string, tenantId: string, projectId: string): Promise<IAgentRoutine | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentRoutines} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .get({ id, tenantId, projectId }) as SqliteRow | undefined;
      return row ? this.mapAgentRoutine(row) : null;
    }

    async listAgentRoutines(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentRoutine[]> {
      const params: Record<string, unknown> = { tenantId: filter.tenantId, projectId: filter.projectId };
      let sql = `SELECT * FROM ${TABLES.agentRoutines} WHERE tenantId = @tenantId AND projectId = @projectId`;
      if (filter.agentKey) {
        sql += ' AND agentKey = @agentKey';
        params.agentKey = filter.agentKey;
      }
      const rows = this.getTenantDb().prepare(`${sql} ORDER BY createdAt ASC, rowid ASC`).all(params) as SqliteRow[];
      return rows.map((row) => this.mapAgentRoutine(row));
    }

    async updateAgentRoutine(id: string, tenantId: string, projectId: string, patch: AgentRoutinePatch): Promise<IAgentRoutine | null> {
      const columns = { ...this.routineColumns(patch), updatedAt: this.now() };
      const sets = Object.keys(columns).map((name) => `${name} = @${name}`);
      const res = this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentRoutines} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ ...columns, id, tenantId, projectId });
      return res.changes === 1 ? this.findAgentRoutineRaw(id) : null;
    }

    async deleteAgentRoutine(id: string, tenantId: string, projectId: string): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentRoutines} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ id, tenantId, projectId }).changes === 1;
    }

    async deleteAgentRoutinesForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentRoutines} WHERE tenantId = @tenantId AND projectId = @projectId AND agentKey = @agentKey`)
        .run({ tenantId, projectId, agentKey }).changes;
    }

    async listDueRoutines(now: Date, limit: number): Promise<IAgentRoutine[]> {
      const rows = this.getTenantDb()
        .prepare(`
          SELECT * FROM ${TABLES.agentRoutines}
          WHERE enabled = 1 AND nextFireAt IS NOT NULL AND nextFireAt <= @now
          ORDER BY nextFireAt ASC LIMIT @limit
        `)
        .all({ now: now.toISOString(), limit: Math.max(1, limit) }) as SqliteRow[];
      return rows.map((row) => this.mapAgentRoutine(row));
    }

    async advanceRoutineNextFire(id: string, from: Date, next: Date | null): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentRoutines} SET nextFireAt = @next, updatedAt = @updatedAt WHERE id = @id AND nextFireAt = @from`)
        .run({ id, from: from.toISOString(), next: iso(next), updatedAt: this.now() }).changes === 1;
    }

    async setRoutineFireResult(
      id: string,
      result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
    ): Promise<boolean> {
      // A failed fire started no run: the last run stays the one that did.
      const runIdSet = result.status === 'started' ? ', lastRunId = @runId' : '';
      return this.getTenantDb()
        .prepare(`
          UPDATE ${TABLES.agentRoutines}
          SET lastFireAt = @fireAt, lastStatus = @status, lastError = @error${runIdSet}
          WHERE id = @id AND (lastFireAt IS NULL OR lastFireAt <= @fireAt)
        `)
        .run({
          id,
          fireAt: result.fireAt.toISOString(),
          status: result.status,
          error: result.status === 'failed' ? result.error ?? null : null,
          ...(runIdSet ? { runId: result.runId ?? null } : {}),
        }).changes === 1;
    }

    async findAgentRoutineByHookId(hookId: string): Promise<IAgentRoutine | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentRoutines} WHERE hookId = @hookId LIMIT 1`)
        .get({ hookId }) as SqliteRow | undefined;
      return row ? this.mapAgentRoutine(row) : null;
    }

    // ── Webhook deliveries ────────────────────────────────────────

    async recordAgentRoutineDelivery(record: Omit<IAgentRoutineDelivery, '_id'>): Promise<IAgentRoutineDelivery> {
      const id = this.newId();
      this.getTenantDb().prepare(`
        INSERT INTO ${TABLES.agentRoutineDeliveries}
          (id, tenantId, projectId, routineId, receivedAt, expiresAt, outcome, httpStatus, event, deliveryId, runId, reason, bytes)
        VALUES (@id, @tenantId, @projectId, @routineId, @receivedAt, @expiresAt, @outcome, @httpStatus, @event, @deliveryId, @runId, @reason, @bytes)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId,
        routineId: record.routineId,
        receivedAt: record.receivedAt.toISOString(),
        expiresAt: record.expiresAt.toISOString(),
        outcome: record.outcome,
        httpStatus: record.httpStatus,
        event: record.event ?? null,
        deliveryId: record.deliveryId ?? null,
        runId: record.runId ?? null,
        reason: record.reason ?? null,
        bytes: record.bytes,
      });
      return { ...record, _id: id };
    }

    async listAgentRoutineDeliveries(filter: {
      tenantId: string;
      projectId: string;
      routineId: string;
      limit: number;
      before?: string;
    }): Promise<IAgentRoutineDelivery[]> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = {
        tenantId: filter.tenantId, projectId: filter.projectId, routineId: filter.routineId, limit: Math.max(1, filter.limit),
      };
      let sql = `SELECT rowid AS seq, * FROM ${TABLES.agentRoutineDeliveries} WHERE tenantId = @tenantId AND projectId = @projectId AND routineId = @routineId`;
      if (filter.before) {
        const cursor = db.prepare(`SELECT rowid AS seq, receivedAt FROM ${TABLES.agentRoutineDeliveries} WHERE id = @id AND routineId = @routineId`)
          .get({ id: filter.before, routineId: filter.routineId }) as { seq: number; receivedAt: string } | undefined;
        if (!cursor) return [];
        sql += ' AND (receivedAt < @cursorAt OR (receivedAt = @cursorAt AND rowid < @cursorSeq))';
        params.cursorAt = cursor.receivedAt;
        params.cursorSeq = cursor.seq;
      }
      const rows = db.prepare(`${sql} ORDER BY receivedAt DESC, rowid DESC LIMIT @limit`).all(params) as SqliteRow[];
      return rows.map((row) => ({
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: row.projectId as string,
        routineId: row.routineId as string,
        receivedAt: new Date(String(row.receivedAt)),
        expiresAt: new Date(String(row.expiresAt)),
        outcome: row.outcome as IAgentRoutineDelivery['outcome'],
        httpStatus: Number(row.httpStatus),
        event: (row.event as string) ?? null,
        deliveryId: (row.deliveryId as string) ?? null,
        runId: (row.runId as string) ?? null,
        reason: (row.reason as string) ?? null,
        bytes: Number(row.bytes ?? 0),
      }));
    }

    async cleanupAgentRoutineDeliveryRetention(options: { olderThan: Date; batchSize: number }): Promise<{ deletedCount: number }> {
      const res = this.getTenantDb().prepare(`
        DELETE FROM ${TABLES.agentRoutineDeliveries}
        WHERE id IN (SELECT id FROM ${TABLES.agentRoutineDeliveries} WHERE expiresAt < @olderThan LIMIT @batchSize)
      `).run({ olderThan: options.olderThan.toISOString(), batchSize: Math.max(1, options.batchSize) });
      return { deletedCount: res.changes };
    }

    async deleteAgentRoutineDeliveries(routineId: string): Promise<number> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentRoutineDeliveries} WHERE routineId = @routineId`)
        .run({ routineId }).changes;
    }

    private mapAgentRoutine(row: SqliteRow): IAgentRoutine {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: row.projectId as string,
        agentKey: row.agentKey as string,
        name: row.name as string,
        description: (row.description as string) ?? null,
        enabled: this.fromBoolInt(row.enabled),
        prompt: (row.prompt as string) ?? '',
        inputs: row.inputs ? this.parseJson(row.inputs, null as Record<string, unknown> | null) : null,
        version: row.version === null || row.version === undefined ? null : Number(row.version),
        runClass: (row.runClass as IAgentRoutine['runClass']) ?? 'default',
        metadata: row.metadata ? this.parseJson(row.metadata, null as Record<string, string> | null) : null,
        callback: row.callback ? this.parseJson(row.callback, null as IAgentRoutine['callback']) : null,
        responseFormat: row.responseFormat ? this.parseJson(row.responseFormat, null as IAgentRoutine['responseFormat']) : null,
        nextFireAt: this.toDate(row.nextFireAt) ?? null,
        lastFireAt: this.toDate(row.lastFireAt) ?? null,
        lastRunId: (row.lastRunId as string) ?? null,
        lastStatus: (row.lastStatus as IAgentRoutine['lastStatus']) ?? null,
        lastError: (row.lastError as string) ?? null,
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? null,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
        ...this.mapRoutineTypeSettings(row),
      };
    }

    /** `type` and the settings object of that type; a missing type or settings read as manual. */
    private mapRoutineTypeSettings(row: SqliteRow): AgentRoutineTypeSettings {
      const manual: AgentRoutineTypeSettings = { type: 'manual' };
      switch (row.type as AgentRoutineType | null | undefined) {
        case 'schedule': {
          const schedule = this.parseJson<AgentRoutineSchedule | null>(row.schedule, null);
          return schedule ? { type: 'schedule', schedule } : manual;
        }
        case 'once': {
          const once = this.parseJson<{ runAt: string } | null>(row.once, null);
          return once ? { type: 'once', once: { runAt: new Date(String(once.runAt)) } } : manual;
        }
        case 'webhook': {
          const webhook = this.parseJson<(Omit<AgentRoutineWebhook, 'previousSecretExpiresAt'> & { previousSecretExpiresAt?: string | null }) | null>(row.webhook, null);
          return webhook
            ? { type: 'webhook', webhook: { ...webhook, previousSecretExpiresAt: webhook.previousSecretExpiresAt ? new Date(String(webhook.previousSecretExpiresAt)) : null } }
            : manual;
        }
        default:
          return manual;
      }
    }
  };
}
