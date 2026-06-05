/**
 * MongoDB Provider – Cluster operations mixin
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
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

interface NodeDoc extends Omit<INodeRecord, 'lastHeartbeatAt' | 'startedAt'> {
  lastHeartbeatAt: Date;
  startedAt: Date;
}

interface InstanceAssignmentDoc extends Omit<IInstanceAssignment, 'updatedAt'> {
  updatedAt: Date;
}

export function ClusterMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ClusterOps extends Base {
    // ── Nodes ────────────────────────────────────────────────────────

    async upsertNode(
      record: Omit<INodeRecord, 'lastHeartbeatAt'> & { lastHeartbeatAt?: Date },
    ): Promise<INodeRecord> {
      const db = this.getMainDb();
      const now = new Date();
      const doc: NodeDoc = {
        name: record.name,
        role: record.role,
        url: record.url ?? null,
        tags: record.tags ?? [],
        status: record.status,
        lastHeartbeatAt: record.lastHeartbeatAt ?? now,
        startedAt: record.startedAt ?? now,
        version: record.version ?? null,
        hostname: record.hostname ?? null,
        pid: record.pid ?? null,
      };

      await db.collection<NodeDoc>(COLLECTIONS.nodes).updateOne(
        { name: record.name },
        { $set: doc },
        { upsert: true },
      );

      return doc;
    }

    async heartbeatNode(name: string, at: Date = new Date()): Promise<void> {
      const db = this.getMainDb();
      await db.collection<NodeDoc>(COLLECTIONS.nodes).updateOne(
        { name },
        [
          {
            $set: {
              lastHeartbeatAt: at,
              status: {
                $cond: [
                  { $eq: ['$status', 'offline'] },
                  'online',
                  '$status',
                ],
              },
            },
          },
        ],
      );
    }

    async setNodeStatus(name: string, status: NodeStatus): Promise<void> {
      const db = this.getMainDb();
      await db.collection<NodeDoc>(COLLECTIONS.nodes).updateOne(
        { name },
        { $set: { status } },
      );
    }

    async findNode(name: string): Promise<INodeRecord | null> {
      const db = this.getMainDb();
      const doc = await db.collection<NodeDoc>(COLLECTIONS.nodes).findOne({ name });
      return doc ? this.mapNode(doc) : null;
    }

    async listNodes(filters: { status?: NodeStatus } = {}): Promise<INodeRecord[]> {
      const db = this.getMainDb();
      const query: Record<string, unknown> = {};
      if (filters.status) query.status = filters.status;
      const docs = await db
        .collection<NodeDoc>(COLLECTIONS.nodes)
        .find(query)
        .sort({ name: 1 })
        .toArray();
      return docs.map((doc) => this.mapNode(doc));
    }

    async markStaleNodesOffline(olderThan: Date): Promise<number> {
      const db = this.getMainDb();
      const result = await db.collection<NodeDoc>(COLLECTIONS.nodes).updateMany(
        { status: { $ne: 'offline' }, lastHeartbeatAt: { $lt: olderThan } },
        { $set: { status: 'offline' } },
      );
      return result.modifiedCount;
    }

    async deleteNode(name: string): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db.collection<NodeDoc>(COLLECTIONS.nodes).deleteOne({ name });
      return result.deletedCount > 0;
    }

    // ── Instance assignments ─────────────────────────────────────────

    async setInstanceAssignment(
      assignment: Omit<IInstanceAssignment, 'updatedAt'> & { updatedAt?: Date },
    ): Promise<IInstanceAssignment> {
      const db = this.getMainDb();
      const doc: InstanceAssignmentDoc = {
        entityType: assignment.entityType,
        entityId: assignment.entityId,
        nodeName: assignment.nodeName,
        mode: assignment.mode,
        updatedAt: assignment.updatedAt ?? new Date(),
        updatedBy: assignment.updatedBy ?? null,
      };

      await db.collection<InstanceAssignmentDoc>(COLLECTIONS.instanceAssignments).updateOne(
        { entityType: assignment.entityType, entityId: assignment.entityId },
        { $set: doc },
        { upsert: true },
      );

      return doc;
    }

    async findInstanceAssignment(
      entityType: InstanceEntityType,
      entityId: string,
    ): Promise<IInstanceAssignment | null> {
      const db = this.getMainDb();
      const doc = await db
        .collection<InstanceAssignmentDoc>(COLLECTIONS.instanceAssignments)
        .findOne({ entityType, entityId });
      return doc ? this.mapAssignment(doc) : null;
    }

    async listInstanceAssignments(filters: {
      entityType?: InstanceEntityType;
      nodeName?: string;
    } = {}): Promise<IInstanceAssignment[]> {
      const db = this.getMainDb();
      const query: Record<string, unknown> = {};
      if (filters.entityType) query.entityType = filters.entityType;
      if (filters.nodeName) query.nodeName = filters.nodeName;
      const docs = await db
        .collection<InstanceAssignmentDoc>(COLLECTIONS.instanceAssignments)
        .find(query)
        .sort({ entityType: 1, entityId: 1 })
        .toArray();
      return docs.map((doc) => this.mapAssignment(doc));
    }

    async deleteInstanceAssignment(
      entityType: InstanceEntityType,
      entityId: string,
    ): Promise<boolean> {
      const db = this.getMainDb();
      const result = await db
        .collection<InstanceAssignmentDoc>(COLLECTIONS.instanceAssignments)
        .deleteOne({ entityType, entityId });
      return result.deletedCount > 0;
    }

    // ── Mappers ─────────────────────────────────────────────────────

    private mapNode(doc: NodeDoc): INodeRecord {
      return {
        name: doc.name,
        role: doc.role,
        url: doc.url ?? null,
        tags: doc.tags ?? [],
        status: doc.status,
        lastHeartbeatAt: doc.lastHeartbeatAt,
        startedAt: doc.startedAt,
        version: doc.version ?? null,
        hostname: doc.hostname ?? null,
        pid: doc.pid ?? null,
      };
    }

    private mapAssignment(doc: InstanceAssignmentDoc): IInstanceAssignment {
      return {
        entityType: doc.entityType,
        entityId: doc.entityId,
        nodeName: doc.nodeName,
        mode: doc.mode,
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy ?? null,
      };
    }
  };
}
