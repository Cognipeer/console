/**
 * MongoDB Provider – Prompt operations mixin
 *
 * Includes prompts, prompt versions, and prompt comments.
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IPrompt, IPromptVersion, IPromptComment } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';

export function PromptMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class PromptOps extends Base {
    // ── Prompts ──────────────────────────────────────────────────────

    async createPrompt(
      prompt: Omit<IPrompt, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPrompt> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = {
        ...prompt,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .insertOne(payload);

      return {
        ...payload,
        _id: result.insertedId.toString(),
      };
    }

    async updatePrompt(id: string, data: Partial<IPrompt>): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IPrompt> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const updateData: Record<string, unknown> = {
        ...data,
        updatedAt: new Date(),
      };
      delete updateData._id;

      const result = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        return null;
      }

      const updated = result as IPrompt;
      return {
        ...updated,
        _id: updated._id?.toString(),
      } as IPrompt;
    }

    async deletePrompt(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IPrompt> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .deleteOne(filter);

      return result.deletedCount > 0;
    }

    async findPromptById(id: string, projectId?: string): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IPrompt> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };
      if (projectId) {
        filter.projectId = projectId;
      }

      const prompt = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .findOne(filter);

      if (!prompt) return null;
      return { ...prompt, _id: prompt._id?.toString() } as IPrompt;
    }

    async findPromptByKey(key: string, projectId?: string): Promise<IPrompt | null> {
      const db = this.getTenantDb();
      const filter: Filter<IPrompt> = { key };
      if (projectId) {
        filter.projectId = projectId;
      }
      const prompt = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .findOne(filter);

      if (!prompt) return null;
      return { ...prompt, _id: prompt._id?.toString() } as IPrompt;
    }

    async listPrompts(filters?: {
      projectId?: string;
      search?: string;
    }): Promise<IPrompt[]> {
      const db = this.getTenantDb();
      const query: Filter<IPrompt> = {};

      if (filters?.projectId) {
        query.projectId = filters.projectId;
      }

      if (filters?.search) {
        const searchValue = filters.search.trim();
        if (searchValue) {
          const regex = new RegExp(this.escapeRegex(searchValue), 'i');
          query.$or = [{ name: regex }, { key: regex }, { description: regex }];
        }
      }

      const prompts = await db
        .collection<IPrompt>(COLLECTIONS.prompts)
        .find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .toArray();

      return prompts.map((prompt) => ({
        ...prompt,
        _id: prompt._id?.toString(),
      }));
    }

    // ── Prompt Versions ──────────────────────────────────────────────

    async createPromptVersion(
      version: Omit<IPromptVersion, '_id' | 'createdAt'>,
    ): Promise<IPromptVersion> {
      const db = this.getTenantDb();
      const payload = {
        ...version,
        createdAt: new Date(),
      };

      const result = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .insertOne(payload);

      return {
        ...payload,
        _id: result.insertedId.toString(),
      };
    }

    async updatePromptVersion(
      id: string,
      data: Partial<IPromptVersion>,
    ): Promise<IPromptVersion | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IPromptVersion> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const updateData: Record<string, unknown> = { ...data };
      delete updateData._id;

      const result = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .findOneAndUpdate(filter, { $set: updateData }, { returnDocument: 'after' });

      if (!result) {
        return null;
      }

      const updated = result as IPromptVersion;
      return {
        ...updated,
        _id: updated._id?.toString(),
      } as IPromptVersion;
    }

    async updatePromptVersions(
      promptId: string,
      data: Partial<IPromptVersion>,
      projectId?: string,
    ): Promise<number> {
      const db = this.getTenantDb();
      const filter: Filter<IPromptVersion> = { promptId };
      if (projectId) {
        filter.projectId = projectId;
      }
      const updateData: Record<string, unknown> = { ...data };
      delete updateData._id;
      const result = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .updateMany(filter, { $set: updateData });

      return result.modifiedCount ?? 0;
    }

    async findPromptVersionById(
      id: string,
      promptId?: string,
      projectId?: string,
    ): Promise<IPromptVersion | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IPromptVersion> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };
      if (promptId) {
        filter.promptId = promptId;
      }
      if (projectId) {
        filter.projectId = projectId;
      }

      const version = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .findOne(filter);

      if (!version) return null;
      return { ...version, _id: version._id?.toString() } as IPromptVersion;
    }

    async listPromptVersions(
      promptId: string,
      projectId?: string,
    ): Promise<IPromptVersion[]> {
      const db = this.getTenantDb();
      const filter: Filter<IPromptVersion> = { promptId };
      if (projectId) {
        filter.projectId = projectId;
      }

      const versions = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .find(filter)
        .sort({ version: -1, createdAt: -1 })
        .toArray();

      return versions.map((version) => ({
        ...version,
        _id: version._id?.toString(),
      }));
    }

    async deletePromptVersions(promptId: string, projectId?: string): Promise<number> {
      const db = this.getTenantDb();
      const filter: Filter<IPromptVersion> = { promptId };
      if (projectId) {
        filter.projectId = projectId;
      }
      const result = await db
        .collection<IPromptVersion>(COLLECTIONS.promptVersions)
        .deleteMany(filter);
      return result.deletedCount ?? 0;
    }

    async deletePromptVersionsByPromptId(
      promptId: string,
      projectId?: string,
    ): Promise<number> {
      return this.deletePromptVersions(promptId, projectId);
    }

    // ── Prompt Comments ──────────────────────────────────────────────

    async createPromptComment(
      comment: Omit<IPromptComment, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IPromptComment> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = {
        ...comment,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IPromptComment>(COLLECTIONS.promptComments)
        .insertOne(payload);

      return {
        ...payload,
        _id: result.insertedId.toString(),
      };
    }

    async listPromptComments(
      promptId: string,
      options?: { versionId?: string; projectId?: string },
    ): Promise<IPromptComment[]> {
      const db = this.getTenantDb();
      const filter: Filter<IPromptComment> = { promptId };
      if (options?.versionId) {
        filter.versionId = options.versionId;
      }
      if (options?.projectId) {
        filter.projectId = options.projectId;
      }

      const comments = await db
        .collection<IPromptComment>(COLLECTIONS.promptComments)
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();

      return comments.map((c) => ({
        ...c,
        _id: c._id?.toString(),
      }));
    }

    async updatePromptComment(
      id: string,
      data: Partial<Pick<IPromptComment, 'content'>>,
    ): Promise<IPromptComment | null> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IPromptComment>(COLLECTIONS.promptComments)
        .findOneAndUpdate(
          { _id: new ObjectId(id) },
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );

      if (!result) return null;
      return { ...result, _id: result._id?.toString() };
    }

    async deletePromptComment(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IPromptComment>(COLLECTIONS.promptComments)
        .deleteOne({ _id: new ObjectId(id) });
      return result.deletedCount === 1;
    }

    async deletePromptCommentsByPromptId(promptId: string): Promise<number> {
      const db = this.getTenantDb();
      const result = await db
        .collection<IPromptComment>(COLLECTIONS.promptComments)
        .deleteMany({ promptId });
      return result.deletedCount ?? 0;
    }
  };
}
