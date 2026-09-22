/**
 * MongoDB Provider – Agent Skill operations mixin
 *
 * Shape mirrors `prompt.mixin.ts` exactly (project-scoped library, unique
 * key, no versioning) — a skill is architecturally a prompt with a header
 * instead of a name and no deployment/version machinery, so there was no
 * reason to invent a different CRUD pattern for it.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IAgentSkill } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function SkillMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class SkillOps extends Base {
    async createSkill(
      skill: Omit<IAgentSkill, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IAgentSkill> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = { ...skill, createdAt: now, updatedAt: now };
      const result = await db.collection<IAgentSkill>(COLLECTIONS.agentSkills).insertOne(payload);
      return { ...payload, _id: result.insertedId.toString() };
    }

    async updateSkill(id: string, data: Partial<IAgentSkill>): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IAgentSkill> = hasObjectId ? { _id: new ObjectId(id) } : { _id: id };
      const updateData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      delete updateData._id;
      const result = await db
        .collection<IAgentSkill>(COLLECTIONS.agentSkills)
        .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });
      if (!result) return null;
      return { ...result, _id: result._id?.toString() } as IAgentSkill;
    }

    async deleteSkill(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IAgentSkill> = hasObjectId ? { _id: new ObjectId(id) } : { _id: id };
      const result = await db.collection<IAgentSkill>(COLLECTIONS.agentSkills).deleteOne(filter);
      return result.deletedCount > 0;
    }

    async findSkillById(id: string, projectId?: string): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IAgentSkill> = hasObjectId ? { _id: new ObjectId(id) } : { _id: id };
      if (projectId) filter.projectId = projectId;
      const skill = await db.collection<IAgentSkill>(COLLECTIONS.agentSkills).findOne(filter);
      if (!skill) return null;
      return { ...skill, _id: skill._id?.toString() } as IAgentSkill;
    }

    async findSkillByKey(key: string, projectId?: string): Promise<IAgentSkill | null> {
      const db = this.getTenantDb();
      const filter: Filter<IAgentSkill> = { key };
      if (projectId) filter.projectId = projectId;
      const skill = await db.collection<IAgentSkill>(COLLECTIONS.agentSkills).findOne(filter);
      if (!skill) return null;
      return { ...skill, _id: skill._id?.toString() } as IAgentSkill;
    }

    async listSkills(filters?: {
      projectId?: string;
      status?: IAgentSkill['status'];
      search?: string;
    }): Promise<IAgentSkill[]> {
      const db = this.getTenantDb();
      const query: Filter<IAgentSkill> = {};
      if (filters?.projectId) query.projectId = filters.projectId;
      if (filters?.status) query.status = filters.status;
      if (filters?.search) {
        const searchValue = filters.search.trim();
        if (searchValue) {
          const regex = new RegExp(this.escapeRegex(searchValue), 'i');
          query.$or = [{ title: regex }, { key: regex }, { header: regex }];
        }
      }
      const skills = await db
        .collection<IAgentSkill>(COLLECTIONS.agentSkills)
        .find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray();
      return skills.map((skill) => ({ ...skill, _id: skill._id?.toString() }));
    }
  };
}
