/**
 * SQLite Provider – Cluster operations mixin
 *
 * Nodes and instance assignments live in the MAIN database so that all
 * tenants share a single cluster topology.
 */

import type {
  IInstanceAssignment,
  INodeRecord,
  InstanceEntityType,
  NodeStatus,
} from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';

export function ClusterMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class ClusterOps extends Base {
    // ── Nodes ────────────────────────────────────────────────────────

    async upsertNode(
      record: Omit<INodeRecord, 'lastHeartbeatAt'> & { lastHeartbeatAt?: Date },
    ): Promise<INodeRecord> {
      const db = this.getMainDb();
      const now = this.now();
      const lastHeartbeatAt = (record.lastHeartbeatAt ?? new Date()).toISOString();
      const startedAt = record.startedAt instanceof Date
        ? record.startedAt.toISOString()
        : now;

      db.prepare(`
        INSERT INTO ${TABLES.nodes}
        (name, role, url, tags, status, lastHeartbeatAt, startedAt, version, hostname, pid)
        VALUES
        (@name, @role, @url, @tags, @status, @lastHeartbeatAt, @startedAt, @version, @hostname, @pid)
        ON CONFLICT(name) DO UPDATE SET
          role = excluded.role,
          url = excluded.url,
          tags = excluded.tags,
          status = excluded.status,
          lastHeartbeatAt = excluded.lastHeartbeatAt,
          startedAt = excluded.startedAt,
          version = excluded.version,
          hostname = excluded.hostname,
          pid = excluded.pid
      `).run({
        name: record.name,
        role: record.role,
        url: record.url ?? null,
        tags: this.toJson(record.tags ?? []),
        status: record.status,
        lastHeartbeatAt,
        startedAt,
        version: record.version ?? null,
        hostname: record.hostname ?? null,
        pid: record.pid ?? null,
      });

      const row = db.prepare(`SELECT * FROM ${TABLES.nodes} WHERE name = ?`).get(record.name) as SqliteRow;
      return this.mapNodeRow(row);
    }

    async heartbeatNode(name: string, at?: Date): Promise<void> {
      const db = this.getMainDb();
      db.prepare(`
        UPDATE ${TABLES.nodes}
        SET lastHeartbeatAt = @at,
            status = CASE WHEN status = 'offline' THEN 'online' ELSE status END
        WHERE name = @name
      `).run({ name, at: (at ?? new Date()).toISOString() });
    }

    async setNodeStatus(name: string, status: NodeStatus): Promise<void> {
      const db = this.getMainDb();
      db.prepare(`UPDATE ${TABLES.nodes} SET status = @status WHERE name = @name`)
        .run({ name, status });
    }

    async findNode(name: string): Promise<INodeRecord | null> {
      const db = this.getMainDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.nodes} WHERE name = ?`).get(name) as SqliteRow | undefined;
      return row ? this.mapNodeRow(row) : null;
    }

    async listNodes(filters: { status?: NodeStatus } = {}): Promise<INodeRecord[]> {
      const db = this.getMainDb();
      const where = filters.status ? 'WHERE status = @status' : '';
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.nodes}
        ${where}
        ORDER BY name ASC
      `).all(filters.status ? { status: filters.status } : {}) as SqliteRow[];
      return rows.map((row) => this.mapNodeRow(row));
    }

    async markStaleNodesOffline(olderThan: Date): Promise<number> {
      const db = this.getMainDb();
      const result = db.prepare(`
        UPDATE ${TABLES.nodes}
        SET status = 'offline'
        WHERE status != 'offline' AND lastHeartbeatAt < @olderThan
      `).run({ olderThan: olderThan.toISOString() });
      return result.changes;
    }

    async deleteNode(name: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`DELETE FROM ${TABLES.nodes} WHERE name = ?`).run(name);
      return result.changes > 0;
    }

    // ── Instance assignments ─────────────────────────────────────────

    async setInstanceAssignment(
      assignment: Omit<IInstanceAssignment, 'updatedAt'> & { updatedAt?: Date },
    ): Promise<IInstanceAssignment> {
      const db = this.getMainDb();
      const updatedAt = (assignment.updatedAt ?? new Date()).toISOString();

      db.prepare(`
        INSERT INTO ${TABLES.instanceAssignments}
        (entityType, entityId, nodeName, mode, updatedAt, updatedBy)
        VALUES
        (@entityType, @entityId, @nodeName, @mode, @updatedAt, @updatedBy)
        ON CONFLICT(entityType, entityId) DO UPDATE SET
          nodeName = excluded.nodeName,
          mode = excluded.mode,
          updatedAt = excluded.updatedAt,
          updatedBy = excluded.updatedBy
      `).run({
        entityType: assignment.entityType,
        entityId: assignment.entityId,
        nodeName: assignment.nodeName,
        mode: assignment.mode,
        updatedAt,
        updatedBy: assignment.updatedBy ?? null,
      });

      return {
        entityType: assignment.entityType,
        entityId: assignment.entityId,
        nodeName: assignment.nodeName,
        mode: assignment.mode,
        updatedAt: new Date(updatedAt),
        updatedBy: assignment.updatedBy ?? null,
      };
    }

    async findInstanceAssignment(
      entityType: InstanceEntityType,
      entityId: string,
    ): Promise<IInstanceAssignment | null> {
      const db = this.getMainDb();
      const row = db.prepare(`
        SELECT * FROM ${TABLES.instanceAssignments}
        WHERE entityType = ? AND entityId = ?
      `).get(entityType, entityId) as SqliteRow | undefined;
      return row ? this.mapInstanceAssignmentRow(row) : null;
    }

    async listInstanceAssignments(filters: {
      entityType?: InstanceEntityType;
      nodeName?: string;
    } = {}): Promise<IInstanceAssignment[]> {
      const db = this.getMainDb();
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};

      if (filters.entityType) {
        clauses.push('entityType = @entityType');
        params.entityType = filters.entityType;
      }
      if (filters.nodeName) {
        clauses.push('nodeName = @nodeName');
        params.nodeName = filters.nodeName;
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT * FROM ${TABLES.instanceAssignments}
        ${where}
        ORDER BY entityType ASC, entityId ASC
      `).all(params) as SqliteRow[];
      return rows.map((row) => this.mapInstanceAssignmentRow(row));
    }

    async deleteInstanceAssignment(
      entityType: InstanceEntityType,
      entityId: string,
    ): Promise<boolean> {
      const db = this.getMainDb();
      const result = db.prepare(`
        DELETE FROM ${TABLES.instanceAssignments}
        WHERE entityType = ? AND entityId = ?
      `).run(entityType, entityId);
      return result.changes > 0;
    }

    // ── Row mappers ─────────────────────────────────────────────────

    private mapNodeRow(row: SqliteRow): INodeRecord {
      return {
        name: row.name as string,
        role: row.role as INodeRecord['role'],
        url: (row.url as string | null) ?? null,
        tags: this.parseJson<string[]>(row.tags, []),
        status: row.status as NodeStatus,
        lastHeartbeatAt: this.toDate(row.lastHeartbeatAt) ?? new Date(0),
        startedAt: this.toDate(row.startedAt) ?? new Date(0),
        version: (row.version as string | null) ?? null,
        hostname: (row.hostname as string | null) ?? null,
        pid: (row.pid as number | null) ?? null,
      };
    }

    private mapInstanceAssignmentRow(row: SqliteRow): IInstanceAssignment {
      return {
        entityType: row.entityType as InstanceEntityType,
        entityId: row.entityId as string,
        nodeName: row.nodeName as string,
        mode: row.mode as IInstanceAssignment['mode'],
        updatedAt: this.toDate(row.updatedAt) ?? new Date(0),
        updatedBy: (row.updatedBy as string | null) ?? null,
      };
    }
  };
}
