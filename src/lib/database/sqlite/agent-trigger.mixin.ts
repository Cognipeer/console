/**
 * SQLite Provider – Agent triggers mixin
 *
 * A trigger's `type` is a column; the settings of that type are one JSON
 * column named after it (`schedule`, `once`, `webhook`, `connector`; manual has none, the
 * others stay NULL), their dates as ISO strings. `nextFireAt` is its own
 * column: the scheduler's `(enabled, nextFireAt)` index reads it; so is a
 * webhook trigger's `hookId` (the incoming webhook's lookup) and a connector
 * trigger's `connectorSubscriptionId` (the Connectors module's lookup). A webhook
 * trigger's delivery log is `agent_trigger_deliveries`.
 */

import type {
  AgentTriggerPatch,
  AgentTriggerConnector,
  AgentTriggerSchedule,
  AgentTriggerType,
  AgentTriggerTypeSettings,
  AgentTriggerWebhook,
  IAgentTrigger,
  IAgentTriggerDelivery,
  NewAgentTrigger,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function AgentTriggerMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AgentTriggerOps extends Base {
    private triggerColumns(record: AgentTriggerPatch): Record<string, unknown> {
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
        out.connector = record.type === 'connector' ? this.toJson(record.connector) : null;
        out.connectorSubscriptionId = record.type === 'connector' ? record.connector.subscriptionId ?? null : null;
      }
      if (record.prompt !== undefined) out.prompt = record.prompt;
      if (record.version !== undefined) out.version = record.version ?? null;
      if (record.runClass !== undefined) out.runClass = record.runClass;
      for (const key of ['variables', 'metadata', 'callback', 'responseFormat'] as const) {
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

    async createAgentTrigger(record: NewAgentTrigger): Promise<IAgentTrigger> {
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
        // Defaults for the optional columns a new trigger leaves out.
        description: null, version: null, variables: null, metadata: null, callback: null, responseFormat: null,
        nextFireAt: null, lastFireAt: null, lastRunId: null, lastStatus: null, lastError: null, updatedBy: null, hookId: null,
        connectorSubscriptionId: null,
        ...this.triggerColumns(record),
      };
      const names = Object.keys(columns);
      db.prepare(
        `INSERT INTO ${TABLES.agentTriggers} (${names.join(', ')}) VALUES (${names.map((name) => `@${name}`).join(', ')})`,
      ).run(columns);
      return (await this.findAgentTriggerRaw(id))!;
    }

    private async findAgentTriggerRaw(id: string): Promise<IAgentTrigger | null> {
      const row = this.getTenantDb().prepare(`SELECT * FROM ${TABLES.agentTriggers} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapAgentTrigger(row) : null;
    }

    async getAgentTrigger(id: string, tenantId: string, projectId: string): Promise<IAgentTrigger | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentTriggers} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .get({ id, tenantId, projectId }) as SqliteRow | undefined;
      return row ? this.mapAgentTrigger(row) : null;
    }

    async listAgentTriggers(filter: { tenantId: string; projectId: string; agentKey?: string }): Promise<IAgentTrigger[]> {
      const params: Record<string, unknown> = { tenantId: filter.tenantId, projectId: filter.projectId };
      let sql = `SELECT * FROM ${TABLES.agentTriggers} WHERE tenantId = @tenantId AND projectId = @projectId`;
      if (filter.agentKey) {
        sql += ' AND agentKey = @agentKey';
        params.agentKey = filter.agentKey;
      }
      const rows = this.getTenantDb().prepare(`${sql} ORDER BY createdAt ASC, rowid ASC`).all(params) as SqliteRow[];
      return rows.map((row) => this.mapAgentTrigger(row));
    }

    async updateAgentTrigger(id: string, tenantId: string, projectId: string, patch: AgentTriggerPatch): Promise<IAgentTrigger | null> {
      const columns = { ...this.triggerColumns(patch), updatedAt: this.now() };
      const sets = Object.keys(columns).map((name) => `${name} = @${name}`);
      const res = this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentTriggers} SET ${sets.join(', ')} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ ...columns, id, tenantId, projectId });
      return res.changes === 1 ? this.findAgentTriggerRaw(id) : null;
    }

    async deleteAgentTrigger(id: string, tenantId: string, projectId: string): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentTriggers} WHERE id = @id AND tenantId = @tenantId AND projectId = @projectId`)
        .run({ id, tenantId, projectId }).changes === 1;
    }

    async deleteAgentTriggersForAgent(tenantId: string, projectId: string, agentKey: string): Promise<number> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentTriggers} WHERE tenantId = @tenantId AND projectId = @projectId AND agentKey = @agentKey`)
        .run({ tenantId, projectId, agentKey }).changes;
    }

    async listDueTriggers(now: Date, limit: number): Promise<IAgentTrigger[]> {
      const rows = this.getTenantDb()
        .prepare(`
          SELECT * FROM ${TABLES.agentTriggers}
          WHERE enabled = 1 AND nextFireAt IS NOT NULL AND nextFireAt <= @now
          ORDER BY nextFireAt ASC LIMIT @limit
        `)
        .all({ now: now.toISOString(), limit: Math.max(1, limit) }) as SqliteRow[];
      return rows.map((row) => this.mapAgentTrigger(row));
    }

    async advanceTriggerNextFire(id: string, from: Date, next: Date | null): Promise<boolean> {
      return this.getTenantDb()
        .prepare(`UPDATE ${TABLES.agentTriggers} SET nextFireAt = @next, updatedAt = @updatedAt WHERE id = @id AND nextFireAt = @from`)
        .run({ id, from: from.toISOString(), next: iso(next), updatedAt: this.now() }).changes === 1;
    }

    async setTriggerFireResult(
      id: string,
      result: { fireAt: Date; status: 'started' | 'failed'; runId?: string | null; error?: string | null },
    ): Promise<boolean> {
      // A failed fire started no run: the last run stays the one that did.
      const runIdSet = result.status === 'started' ? ', lastRunId = @runId' : '';
      return this.getTenantDb()
        .prepare(`
          UPDATE ${TABLES.agentTriggers}
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

    async findAgentTriggerByHookId(hookId: string): Promise<IAgentTrigger | null> {
      const row = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentTriggers} WHERE hookId = @hookId LIMIT 1`)
        .get({ hookId }) as SqliteRow | undefined;
      return row ? this.mapAgentTrigger(row) : null;
    }

    async listAgentTriggersBySubscription(subscriptionId: string): Promise<IAgentTrigger[]> {
      const rows = this.getTenantDb()
        .prepare(`SELECT * FROM ${TABLES.agentTriggers} WHERE connectorSubscriptionId = @subscriptionId ORDER BY createdAt ASC, rowid ASC`)
        .all({ subscriptionId }) as SqliteRow[];
      return rows.map((row) => this.mapAgentTrigger(row));
    }

    async countAgentTriggersBySubscription(subscriptionId: string, opts?: { enabledOnly?: boolean }): Promise<number> {
      const row = this.getTenantDb()
        .prepare(`SELECT COUNT(*) AS n FROM ${TABLES.agentTriggers} WHERE connectorSubscriptionId = @subscriptionId${opts?.enabledOnly ? ' AND enabled = 1' : ''}`)
        .get({ subscriptionId }) as { n: number };
      return Number(row.n);
    }

    // ── Webhook deliveries ────────────────────────────────────────

    async recordAgentTriggerDelivery(record: Omit<IAgentTriggerDelivery, '_id'>): Promise<IAgentTriggerDelivery> {
      const id = this.newId();
      this.getTenantDb().prepare(`
        INSERT INTO ${TABLES.agentTriggerDeliveries}
          (id, tenantId, projectId, triggerId, receivedAt, expiresAt, outcome, httpStatus, event, deliveryId, runId, reason, bytes)
        VALUES (@id, @tenantId, @projectId, @triggerId, @receivedAt, @expiresAt, @outcome, @httpStatus, @event, @deliveryId, @runId, @reason, @bytes)
      `).run({
        id,
        tenantId: record.tenantId,
        projectId: record.projectId,
        triggerId: record.triggerId,
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

    async listAgentTriggerDeliveries(filter: {
      tenantId: string;
      projectId: string;
      triggerId: string;
      limit: number;
      before?: string;
    }): Promise<IAgentTriggerDelivery[]> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = {
        tenantId: filter.tenantId, projectId: filter.projectId, triggerId: filter.triggerId, limit: Math.max(1, filter.limit),
      };
      let sql = `SELECT rowid AS seq, * FROM ${TABLES.agentTriggerDeliveries} WHERE tenantId = @tenantId AND projectId = @projectId AND triggerId = @triggerId`;
      if (filter.before) {
        const cursor = db.prepare(`SELECT rowid AS seq, receivedAt FROM ${TABLES.agentTriggerDeliveries} WHERE id = @id AND triggerId = @triggerId`)
          .get({ id: filter.before, triggerId: filter.triggerId }) as { seq: number; receivedAt: string } | undefined;
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
        triggerId: row.triggerId as string,
        receivedAt: new Date(String(row.receivedAt)),
        expiresAt: new Date(String(row.expiresAt)),
        outcome: row.outcome as IAgentTriggerDelivery['outcome'],
        httpStatus: Number(row.httpStatus),
        event: (row.event as string) ?? null,
        deliveryId: (row.deliveryId as string) ?? null,
        runId: (row.runId as string) ?? null,
        reason: (row.reason as string) ?? null,
        bytes: Number(row.bytes ?? 0),
      }));
    }

    async cleanupAgentTriggerDeliveryRetention(options: { olderThan: Date; batchSize: number }): Promise<{ deletedCount: number }> {
      const res = this.getTenantDb().prepare(`
        DELETE FROM ${TABLES.agentTriggerDeliveries}
        WHERE id IN (SELECT id FROM ${TABLES.agentTriggerDeliveries} WHERE expiresAt < @olderThan LIMIT @batchSize)
      `).run({ olderThan: options.olderThan.toISOString(), batchSize: Math.max(1, options.batchSize) });
      return { deletedCount: res.changes };
    }

    async deleteAgentTriggerDeliveries(triggerId: string): Promise<number> {
      return this.getTenantDb()
        .prepare(`DELETE FROM ${TABLES.agentTriggerDeliveries} WHERE triggerId = @triggerId`)
        .run({ triggerId }).changes;
    }

    private mapAgentTrigger(row: SqliteRow): IAgentTrigger {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: row.projectId as string,
        agentKey: row.agentKey as string,
        name: row.name as string,
        description: (row.description as string) ?? null,
        enabled: this.fromBoolInt(row.enabled),
        prompt: (row.prompt as string) ?? '',
        variables: row.variables ? this.parseJson(row.variables, null as Record<string, unknown> | null) : null,
        version: row.version === null || row.version === undefined ? null : Number(row.version),
        runClass: (row.runClass as IAgentTrigger['runClass']) ?? 'default',
        metadata: row.metadata ? this.parseJson(row.metadata, null as Record<string, string> | null) : null,
        callback: row.callback ? this.parseJson(row.callback, null as IAgentTrigger['callback']) : null,
        responseFormat: row.responseFormat ? this.parseJson(row.responseFormat, null as IAgentTrigger['responseFormat']) : null,
        nextFireAt: this.toDate(row.nextFireAt) ?? null,
        lastFireAt: this.toDate(row.lastFireAt) ?? null,
        lastRunId: (row.lastRunId as string) ?? null,
        lastStatus: (row.lastStatus as IAgentTrigger['lastStatus']) ?? null,
        lastError: (row.lastError as string) ?? null,
        createdBy: row.createdBy as string,
        updatedBy: (row.updatedBy as string) ?? null,
        createdAt: this.toDate(row.createdAt),
        updatedAt: this.toDate(row.updatedAt),
        ...this.mapTriggerTypeSettings(row),
      };
    }

    /** `type` and the settings object of that type; a missing type or settings read as manual. */
    private mapTriggerTypeSettings(row: SqliteRow): AgentTriggerTypeSettings {
      const manual: AgentTriggerTypeSettings = { type: 'manual' };
      switch (row.type as AgentTriggerType | null | undefined) {
        case 'schedule': {
          const schedule = this.parseJson<AgentTriggerSchedule | null>(row.schedule, null);
          return schedule ? { type: 'schedule', schedule } : manual;
        }
        case 'once': {
          const once = this.parseJson<{ runAt: string } | null>(row.once, null);
          return once ? { type: 'once', once: { runAt: new Date(String(once.runAt)) } } : manual;
        }
        case 'webhook': {
          const webhook = this.parseJson<(Omit<AgentTriggerWebhook, 'previousSecretExpiresAt'> & { previousSecretExpiresAt?: string | null }) | null>(row.webhook, null);
          return webhook
            ? { type: 'webhook', webhook: { ...webhook, previousSecretExpiresAt: webhook.previousSecretExpiresAt ? new Date(String(webhook.previousSecretExpiresAt)) : null } }
            : manual;
        }
        case 'connector': {
          const connector = this.parseJson<AgentTriggerConnector | null>(row.connector, null);
          return connector ? { type: 'connector', connector } : manual;
        }
        default:
          return manual;
      }
    }
  };
}
