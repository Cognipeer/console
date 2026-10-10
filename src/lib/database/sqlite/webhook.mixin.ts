/**
 * SQLite Provider – Webhook subscriptions mixin
 *
 * Endpoints (`webhook_endpoints`) and the deliveries owed to them
 * (`webhook_deliveries`). Ids are `whk_…` / `whd_…`.
 */

import type {
  IWebhookDelivery,
  IWebhookEndpoint,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

export function WebhookMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class WebhookOps extends Base {
    // ── Endpoints ────────────────────────────────────────────────

    async createWebhookEndpoint(
      endpoint: Omit<IWebhookEndpoint, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IWebhookEndpoint> {
      const db = this.getTenantDb();
      const id = `whk_${this.newId().replace(/-/g, '').slice(0, 24)}`;
      const now = this.now();
      db.prepare(`
        INSERT INTO ${TABLES.webhookEndpoints}
        (id, tenantId, projectId, url, description, events, secretSealed, status, disabledReason, failingSince,
         createdBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @projectId, @url, @description, @events, @secretSealed, @status, @disabledReason,
         @failingSince, @createdBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: endpoint.tenantId,
        projectId: endpoint.projectId ?? null,
        url: endpoint.url,
        description: endpoint.description ?? null,
        events: this.toJson(endpoint.events ?? []),
        secretSealed: endpoint.secretSealed,
        status: endpoint.status,
        disabledReason: endpoint.disabledReason ?? null,
        failingSince: iso(endpoint.failingSince),
        createdBy: endpoint.createdBy,
        createdAt: now,
        updatedAt: now,
      });
      return { ...endpoint, projectId: endpoint.projectId ?? null, _id: id, createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async findWebhookEndpointById(id: string): Promise<IWebhookEndpoint | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.webhookEndpoints} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapWebhookEndpoint(row) : null;
    }

    async listWebhookEndpoints(
      tenantId: string,
      filter?: { projectScopes?: Array<string | null>; status?: WebhookEndpointStatus },
    ): Promise<IWebhookEndpoint[]> {
      const db = this.getTenantDb();
      const conditions = ['tenantId = @tenantId'];
      const params: Record<string, unknown> = { tenantId };
      if (filter?.status) { conditions.push('status = @status'); params.status = filter.status; }
      if (filter?.projectScopes) {
        const ids = filter.projectScopes.filter((scope): scope is string => scope !== null);
        const clauses: string[] = [];
        if (filter.projectScopes.includes(null)) clauses.push('projectId IS NULL');
        ids.forEach((id, i) => { clauses.push(`projectId = @scope${i}`); params[`scope${i}`] = id; });
        if (clauses.length === 0) return [];
        conditions.push(`(${clauses.join(' OR ')})`);
      }
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.webhookEndpoints} WHERE ${conditions.join(' AND ')} ORDER BY createdAt ASC, rowid ASC`,
      ).all(params) as SqliteRow[];
      return rows.map((row) => this.mapWebhookEndpoint(row));
    }

    async updateWebhookEndpoint(
      id: string,
      data: Partial<Omit<IWebhookEndpoint, '_id' | 'tenantId' | 'projectId' | 'createdBy' | 'createdAt'>>,
    ): Promise<IWebhookEndpoint | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };
      for (const field of ['url', 'secretSealed', 'status'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field]; }
      }
      for (const field of ['description', 'disabledReason'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field] ?? null; }
      }
      if (data.events !== undefined) { sets.push('events = @events'); params.events = this.toJson(data.events); }
      if (data.failingSince !== undefined) { sets.push('failingSince = @failingSince'); params.failingSince = iso(data.failingSince); }
      const result = db.prepare(`UPDATE ${TABLES.webhookEndpoints} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      if (result.changes === 0) return null;
      return this.findWebhookEndpointById(id);
    }

    async deleteWebhookEndpoint(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.webhookDeliveries} WHERE endpointId = @id`).run({ id });
      return db.prepare(`DELETE FROM ${TABLES.webhookEndpoints} WHERE id = @id`).run({ id }).changes > 0;
    }

    // ── Deliveries ───────────────────────────────────────────────

    async createWebhookDeliveries(
      deliveries: Array<Omit<IWebhookDelivery, '_id'>>,
    ): Promise<IWebhookDelivery[]> {
      if (deliveries.length === 0) return [];
      const db = this.getTenantDb();
      const insert = db.prepare(`
        INSERT INTO ${TABLES.webhookDeliveries}
        (id, tenantId, projectId, endpointId, eventId, eventType, payload, status, attempts, nextAttemptAt,
         lastStatusCode, lastError, lastDurationMs, createdAt, deliveredAt)
        VALUES (@id, @tenantId, @projectId, @endpointId, @eventId, @eventType, @payload, @status, @attempts,
         @nextAttemptAt, @lastStatusCode, @lastError, @lastDurationMs, @createdAt, @deliveredAt)
      `);
      const created: IWebhookDelivery[] = deliveries.map((delivery) => ({
        ...delivery,
        _id: `whd_${this.newId().replace(/-/g, '').slice(0, 24)}`,
      }));
      db.transaction(() => {
        for (const delivery of created) {
          insert.run({
            id: delivery._id,
            tenantId: delivery.tenantId,
            projectId: delivery.projectId ?? null,
            endpointId: delivery.endpointId,
            eventId: delivery.eventId,
            eventType: delivery.eventType,
            payload: this.toJson(delivery.payload),
            status: delivery.status,
            attempts: delivery.attempts,
            nextAttemptAt: iso(delivery.nextAttemptAt),
            lastStatusCode: delivery.lastStatusCode ?? null,
            lastError: delivery.lastError ?? null,
            lastDurationMs: delivery.lastDurationMs ?? null,
            createdAt: new Date(delivery.createdAt).toISOString(),
            deliveredAt: iso(delivery.deliveredAt),
          });
        }
      })();
      return created;
    }

    async findWebhookDeliveryById(id: string): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.webhookDeliveries} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapWebhookDelivery(row) : null;
    }

    async listWebhookDeliveries(
      endpointId: string,
      options?: { limit?: number; skip?: number; status?: WebhookDeliveryStatus },
    ): Promise<IWebhookDelivery[]> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { endpointId };
      let sql = `SELECT * FROM ${TABLES.webhookDeliveries} WHERE endpointId = @endpointId`;
      if (options?.status) { sql += ' AND status = @status'; params.status = options.status; }
      sql += ' ORDER BY createdAt DESC, rowid DESC';
      if (options?.limit && options.limit > 0) { sql += ' LIMIT @limit'; params.limit = options.limit; }
      if (options?.skip && options.skip > 0) {
        if (!options.limit) sql += ' LIMIT -1';
        sql += ' OFFSET @skip';
        params.skip = options.skip;
      }
      return (db.prepare(sql).all(params) as SqliteRow[]).map((row) => this.mapWebhookDelivery(row));
    }

    async updateWebhookDelivery(
      id: string,
      data: Partial<Omit<IWebhookDelivery, '_id' | 'tenantId' | 'endpointId' | 'eventId' | 'createdAt'>>,
    ): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const field of ['status', 'attempts'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field]; }
      }
      for (const field of ['lastStatusCode', 'lastError', 'lastDurationMs'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = data[field] ?? null; }
      }
      for (const field of ['nextAttemptAt', 'deliveredAt'] as const) {
        if (data[field] !== undefined) { sets.push(`${field} = @${field}`); params[field] = iso(data[field]); }
      }
      if (sets.length === 0) return this.findWebhookDeliveryById(id);
      const result = db.prepare(`UPDATE ${TABLES.webhookDeliveries} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      if (result.changes === 0) return null;
      return this.findWebhookDeliveryById(id);
    }

    async claimWebhookDelivery(id: string, now: Date, leaseUntil: Date): Promise<IWebhookDelivery | null> {
      const db = this.getTenantDb();
      const result = db.prepare(`
        UPDATE ${TABLES.webhookDeliveries} SET nextAttemptAt = @leaseUntil
        WHERE id = @id AND status = 'pending' AND nextAttemptAt IS NOT NULL AND nextAttemptAt <= @now
      `).run({ id, now: now.toISOString(), leaseUntil: leaseUntil.toISOString() });
      if (result.changes === 0) return null;
      return this.findWebhookDeliveryById(id);
    }

    async listDueWebhookDeliveries(tenantId: string, now: Date, limit = 200): Promise<IWebhookDelivery[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.webhookDeliveries}
        WHERE tenantId = @tenantId AND status = 'pending' AND nextAttemptAt IS NOT NULL AND nextAttemptAt <= @now
        ORDER BY nextAttemptAt ASC LIMIT @limit
      `).all({ tenantId, now: now.toISOString(), limit }) as SqliteRow[];
      return rows.map((row) => this.mapWebhookDelivery(row));
    }

    async failPendingWebhookDeliveries(endpointId: string, reason: string): Promise<number> {
      const db = this.getTenantDb();
      return db.prepare(`
        UPDATE ${TABLES.webhookDeliveries} SET status = 'failed', nextAttemptAt = NULL, lastError = @reason
        WHERE endpointId = @endpointId AND status = 'pending'
      `).run({ endpointId, reason }).changes;
    }

    async cleanupWebhookDeliveryRetention(options: { olderThan: Date; batchSize?: number }): Promise<{ deletedCount: number }> {
      const db = this.getTenantDb();
      const params: Record<string, unknown> = { olderThan: options.olderThan.toISOString() };
      const batched = Boolean(options.batchSize && options.batchSize > 0);
      const sql = batched
        ? `DELETE FROM ${TABLES.webhookDeliveries} WHERE id IN (SELECT id FROM ${TABLES.webhookDeliveries} WHERE status != 'pending' AND createdAt < @olderThan LIMIT @batchSize)`
        : `DELETE FROM ${TABLES.webhookDeliveries} WHERE status != 'pending' AND createdAt < @olderThan`;
      return { deletedCount: db.prepare(sql).run(batched ? { ...params, batchSize: options.batchSize } : params).changes };
    }

    // ── Private helpers ──────────────────────────────────────────

    private mapWebhookEndpoint(row: SqliteRow): IWebhookEndpoint {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : null,
        url: String(row.url),
        ...(row.description ? { description: String(row.description) } : {}),
        events: this.parseJson<string[]>(row.events, []),
        secretSealed: String(row.secretSealed),
        status: String(row.status) as WebhookEndpointStatus,
        disabledReason: row.disabledReason ? (String(row.disabledReason) as IWebhookEndpoint['disabledReason']) : null,
        failingSince: row.failingSince ? new Date(String(row.failingSince)) : null,
        createdBy: String(row.createdBy),
        createdAt: new Date(String(row.createdAt)),
        updatedAt: new Date(String(row.updatedAt)),
      };
    }

    private mapWebhookDelivery(row: SqliteRow): IWebhookDelivery {
      return {
        _id: String(row.id),
        tenantId: String(row.tenantId),
        projectId: row.projectId ? String(row.projectId) : null,
        endpointId: String(row.endpointId),
        eventId: String(row.eventId),
        eventType: String(row.eventType),
        payload: this.parseJson<Record<string, unknown>>(row.payload, {}),
        status: String(row.status) as WebhookDeliveryStatus,
        attempts: Number(row.attempts ?? 0),
        nextAttemptAt: row.nextAttemptAt ? new Date(String(row.nextAttemptAt)) : null,
        lastStatusCode: row.lastStatusCode === null || row.lastStatusCode === undefined ? null : Number(row.lastStatusCode),
        lastError: row.lastError ? String(row.lastError) : null,
        lastDurationMs: row.lastDurationMs === null || row.lastDurationMs === undefined ? null : Number(row.lastDurationMs),
        createdAt: new Date(String(row.createdAt)),
        deliveredAt: row.deliveredAt ? new Date(String(row.deliveredAt)) : null,
      };
    }
  };
}
