/**
 * MongoDB Provider – Project operations mixin
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IProject } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

export function ProjectMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class ProjectOps extends Base {
    async createProject(
      project: Omit<IProject, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IProject> {
      const db = this.getTenantDb();
      const now = new Date();

      const payload = {
        ...project,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db
        .collection<IProject>(COLLECTIONS.projects)
        .insertOne(payload);

      return {
        ...payload,
        _id: result.insertedId.toString(),
      };
    }

    async updateProject(
      id: string,
      data: Partial<Omit<IProject, 'tenantId' | 'key'>>,
    ): Promise<IProject | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IProject> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await db
        .collection<IProject>(COLLECTIONS.projects)
        .findOneAndUpdate(
          filter,
          { $set: { ...data, updatedAt: new Date() } },
          { returnDocument: 'after' },
        );

      if (!result) return null;

      const updated = result as IProject;
      return {
        ...updated,
        _id: updated._id?.toString(),
      } as IProject;
    }

    async deleteProject(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IProject> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await db
        .collection<IProject>(COLLECTIONS.projects)
        .deleteOne(filter);

      return result.deletedCount > 0;
    }

    async findProjectById(id: string): Promise<IProject | null> {
      const db = this.getTenantDb();
      const hasObjectId = ObjectId.isValid(id);
      const filter: Filter<IProject> = hasObjectId
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const project = await db
        .collection<IProject>(COLLECTIONS.projects)
        .findOne(filter);

      if (!project) return null;
      return { ...project, _id: project._id?.toString() };
    }

    async findProjectByKey(tenantId: string, key: string): Promise<IProject | null> {
      const db = this.getTenantDb();
      const project = await db
        .collection<IProject>(COLLECTIONS.projects)
        .findOne({ tenantId, key } as Filter<IProject>);
      if (!project) return null;
      return { ...project, _id: project._id?.toString() };
    }

    async listProjects(tenantId: string): Promise<IProject[]> {
      const db = this.getTenantDb();
      const projects = await db
        .collection<IProject>(COLLECTIONS.projects)
        .find({ tenantId } as Filter<IProject>)
        .sort({ createdAt: -1 })
        .toArray();

      return projects.map((project) => ({
        ...project,
        _id: project._id?.toString(),
      }));
    }

    async assignProjectIdToLegacyRecords(tenantId: string, projectId: string): Promise<void> {
      const db = this.getTenantDb();
      const collections = [
        COLLECTIONS.providers,
        COLLECTIONS.models,
        COLLECTIONS.vectorIndexes,
        COLLECTIONS.fileBuckets,
        COLLECTIONS.files,
        COLLECTIONS.prompts,
        COLLECTIONS.promptVersions,
        COLLECTIONS.quotaPolicies,
        COLLECTIONS.agentTracingSessions,
        COLLECTIONS.agentTracingThreads,
        COLLECTIONS.agentTracingEvents,
        COLLECTIONS.modelUsageLogs,
      ];

      await Promise.all(
        collections.map(async (collectionName) => {
          try {
            await db.collection(collectionName).updateMany(
              { tenantId, projectId: { $exists: false } },
              { $set: { projectId } },
            );
          } catch (error) {
            logger.warn('Legacy migration skipped for collection', { collectionName, error });
          }
        }),
      );
    }
  };
}
