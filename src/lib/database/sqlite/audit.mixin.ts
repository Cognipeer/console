/**
 * SQLite Provider – General audit log operations mixin
 */

import type { IAuditLog } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function AuditMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class AuditOps extends Base {
    async createAuditLog(log: Omit<IAuditLog, '_id' | 'createdAt'>): Promise<IAuditLog> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.auditLogs}
        (id, tenantId, projectId, requestId, actorType, actorUserId, actorEmail, actorRole,
         apiTokenId, service, action, event, method, path, statusCode, outcome, ipAddress,
         userAgent, resourceType, resourceId, metadata, createdAt)
        VALUES
        (@id, @tenantId, @projectId, @requestId, @actorType, @actorUserId, @actorEmail, @actorRole,
         @apiTokenId, @service, @action, @event, @method, @path, @statusCode, @outcome, @ipAddress,
         @userAgent, @resourceType, @resourceId, @metadata, @createdAt)
      `).run({
        id,
        tenantId: log.tenantId,
        projectId: log.projectId ?? null,
        requestId: log.requestId ?? null,
        actorType: log.actorType,
        actorUserId: log.actorUserId ?? null,
        actorEmail: log.actorEmail ?? null,
        actorRole: log.actorRole ?? null,
        apiTokenId: log.apiTokenId ?? null,
        service: log.service,
        action: log.action,
        event: log.event,
        method: log.method ?? null,
        path: log.path ?? null,
        statusCode: log.statusCode ?? null,
        outcome: log.outcome,
        ipAddress: log.ipAddress ?? null,
        userAgent: log.userAgent ?? null,
        resourceType: log.resourceType ?? null,
        resourceId: log.resourceId ?? null,
        metadata: this.toJson(log.metadata ?? {}),
        createdAt: now,
      });

      return { ...log, _id: id, createdAt: new Date(now) };
    }

    async listAuditLogs(filters: {
      actorUserId?: string;
      outcome?: IAuditLog['outcome'];
      service?: string;
      action?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      skip?: number;
    } = {}): Promise<IAuditLog[]> {
      const db = this.getTenantDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters.actorUserId) {
        clauses.push('actorUserId = @actorUserId');
        params.actorUserId = filters.actorUserId;
      }
      if (filters.outcome) {
        clauses.push('outcome = @outcome');
        params.outcome = filters.outcome;
      }
      if (filters.service) {
        clauses.push('service = @service');
        params.service = filters.service;
      }
      if (filters.action) {
        clauses.push('action = @action');
        params.action = filters.action;
      }
      if (filters.from) {
        clauses.push('createdAt >= @from');
        params.from = filters.from.toISOString();
      }
      if (filters.to) {
        clauses.push('createdAt <= @to');
        params.to = filters.to.toISOString();
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
      const skip = Math.max(filters.skip ?? 0, 0);
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.auditLogs}
        ${where}
        ORDER BY createdAt DESC
        LIMIT @limit OFFSET @skip
      `).all({ ...params, limit, skip }) as SqliteRow[];

      return rows.map((row) => this.mapAuditLogRow(row));
    }

    private mapAuditLogRow(row: SqliteRow): IAuditLog {
      return {
        _id: row.id as string,
        tenantId: row.tenantId as string,
        projectId: row.projectId as string | undefined,
        requestId: row.requestId as string | undefined,
        actorType: row.actorType as IAuditLog['actorType'],
        actorUserId: row.actorUserId as string | undefined,
        actorEmail: row.actorEmail as string | undefined,
        actorRole: row.actorRole as string | undefined,
        apiTokenId: row.apiTokenId as string | undefined,
        service: row.service as string,
        action: row.action as IAuditLog['action'],
        event: row.event as string,
        method: row.method as string | undefined,
        path: row.path as string | undefined,
        statusCode: row.statusCode as number | undefined,
        outcome: row.outcome as IAuditLog['outcome'],
        ipAddress: row.ipAddress as string | undefined,
        userAgent: row.userAgent as string | undefined,
        resourceType: row.resourceType as string | undefined,
        resourceId: row.resourceId as string | undefined,
        metadata: this.parseJson<Record<string, unknown>>(row.metadata, {}),
        createdAt: this.toDate(row.createdAt),
      };
    }
  };
}
