/**
 * MongoDB Provider – Agent operations mixin
 *
 * Includes agent CRUD and conversation management.
 */

import { ObjectId } from 'mongodb';
import type { IAgent, AgentStatus, IAgentConversation } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function AgentMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class AgentOps extends Base {
    // ── Agent CRUD ───────────────────────────────────────────────

    async createAgent(
      agent: Omit<IAgent, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgent> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...agent, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.agents)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAgent(
      id: string,
      data: Partial<Omit<IAgent, 'tenantId' | 'key' | 'createdBy'>>,
    ): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAgent>(COLLECTIONS.agents)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAgent;
    }

    async deleteAgent(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agents)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAgentById(id: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agents)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgent;
    }

    async findAgentByKey(key: string, projectId?: string): Promise<IAgent | null> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { key };
      if (projectId !== undefined) filter.projectId = projectId;
      const doc = await db
        .collection(COLLECTIONS.agents)
        .findOne(filter);
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgent;
    }

    async listAgents(filters?: {
      projectId?: string;
      status?: AgentStatus;
      search?: string;
    }): Promise<IAgent[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      if (filters?.status) filter.status = filters.status;
      if (filters?.search) {
        const escaped = this.escapeRegex(filters.search);
        filter.$or = [
          { name: { $regex: escaped, $options: 'i' } },
          { key: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
        ];
      }
      const docs = await db
        .collection(COLLECTIONS.agents)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as IAgent[];
    }

    async countAgents(projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = {};
      if (projectId !== undefined) filter.projectId = projectId;
      return db.collection(COLLECTIONS.agents).countDocuments(filter);
    }

    // ── Agent Conversation operations ────────────────────────────

    async createAgentConversation(
      conversation: Omit<IAgentConversation, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentConversation> {
      const db = this.getTenantDb();
      const now = new Date();
      const doc = { ...conversation, createdAt: now, updatedAt: now };
      const result = await db
        .collection(COLLECTIONS.agentConversations)
        .insertOne(doc);
      return { ...doc, _id: result.insertedId.toString() };
    }

    async updateAgentConversation(
      id: string,
      data: Partial<Omit<IAgentConversation, 'tenantId' | 'agentKey' | 'createdBy'>>,
    ): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAgentConversation>(COLLECTIONS.agentConversations)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: updateData },
          { returnDocument: 'after' },
        );
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAgentConversation;
    }

    async deleteAgentConversation(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection(COLLECTIONS.agentConversations)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async findAgentConversationById(id: string): Promise<IAgentConversation | null> {
      const db = this.getTenantDb();
      const doc = await db
        .collection(COLLECTIONS.agentConversations)
        .findOne({ _id: new ObjectId(id) });
      if (!doc) return null;
      return { ...doc, _id: doc._id?.toString() } as unknown as IAgentConversation;
    }

    async listAgentConversations(
      agentKey: string,
      filters?: { projectId?: string; limit?: number; skip?: number },
    ): Promise<IAgentConversation[]> {
      const db = this.getTenantDb();
      const filter: Record<string, unknown> = { agentKey };
      if (filters?.projectId !== undefined) filter.projectId = filters.projectId;
      let cursor = db
        .collection(COLLECTIONS.agentConversations)
        .find(filter)
        .sort({ updatedAt: -1 });
      if (filters?.skip) cursor = cursor.skip(filters.skip);
      if (filters?.limit) cursor = cursor.limit(filters.limit);
      const docs = await cursor.toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() })) as unknown as IAgentConversation[];
    }
  };
}
