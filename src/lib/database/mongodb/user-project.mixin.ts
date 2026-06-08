/**
 * MongoDB Provider – UserProject (project membership) operations mixin
 */

import { ObjectId } from 'mongodb';
import type { IGroup, IGroupMember, IGroupProject, IUserProject, ProjectRole } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';

export function UserProjectMixin<TBase extends Constructor<MongoDBProviderBase>>(Base: TBase) {
  return class UserProjectOps extends Base {

    // ── UserProject CRUD ─────────────────────────────────────────────────

    async findUserProject(userId: string, projectId: string): Promise<IUserProject | null> {
      const db = this.getTenantDb();
      const doc = await db.collection<IUserProject>(COLLECTIONS.userProjects).findOne({ userId, projectId });
      return doc ? this.mapUserProject(doc) : null;
    }

    async listUserProjectsByUser(userId: string): Promise<IUserProject[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IUserProject>(COLLECTIONS.userProjects)
        .find({ userId })
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => this.mapUserProject(d));
    }

    async listUserProjectsByProject(projectId: string): Promise<IUserProject[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IUserProject>(COLLECTIONS.userProjects)
        .find({ projectId })
        .sort({ createdAt: -1 })
        .toArray();
      return docs.map((d) => this.mapUserProject(d));
    }

    async upsertUserProject(
      data: Omit<IUserProject, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IUserProject> {
      const db = this.getTenantDb();
      const now = new Date();
      const servicePermissions = normalizeServicePermissions(data.servicePermissions);

      const result = await db.collection<IUserProject>(COLLECTIONS.userProjects).findOneAndUpdate(
        { tenantId: data.tenantId, userId: data.userId, projectId: data.projectId },
        {
          $set: { role: data.role, servicePermissions, updatedAt: now },
          $setOnInsert: {
            tenantId: data.tenantId,
            userId: data.userId,
            projectId: data.projectId,
            invitedBy: data.invitedBy,
            createdAt: now,
          },
        },
        { upsert: true, returnDocument: 'after' },
      );

      return this.mapUserProject(result!);
    }

    async deleteUserProject(userId: string, projectId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.userProjects).deleteOne({ userId, projectId });
      return result.deletedCount > 0;
    }

    async deleteUserProjectsByProject(projectId: string): Promise<void> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.userProjects).deleteMany({ projectId });
    }

    async deleteUserProjectsByUser(userId: string): Promise<void> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.userProjects).deleteMany({ userId });
    }

    private mapUserProject(doc: IUserProject & { _id?: unknown }): IUserProject {
      return {
        ...doc,
        _id: doc._id instanceof ObjectId ? doc._id.toString() : String(doc._id ?? ''),
        servicePermissions: normalizeServicePermissions(doc.servicePermissions),
      };
    }

    // ── Group CRUD (future) ──────────────────────────────────────────────

    async createGroup(data: Omit<IGroup, '_id' | 'createdAt' | 'updatedAt'>): Promise<IGroup> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = {
        ...data,
        source: data.source ?? 'local',
        servicePermissions: normalizeServicePermissions(data.servicePermissions),
        createdAt: now,
        updatedAt: now,
      };
      const result = await db.collection<IGroup>(COLLECTIONS.groups).insertOne(payload);
      return { ...payload, _id: result.insertedId.toString() };
    }

    async findGroupById(id: string): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const oid = ObjectId.isValid(id) ? new ObjectId(id) : null;
      const doc = oid
        ? await db.collection<IGroup>(COLLECTIONS.groups).findOne({ _id: oid as unknown as IGroup['_id'] })
        : null;
      if (!doc) return null;
      return this.mapGroup(doc);
    }

    async findGroupByExternalId(externalId: string): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const doc = await db.collection<IGroup>(COLLECTIONS.groups)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .findOne({ externalId } as any);
      if (!doc) return null;
      return this.mapGroup(doc);
    }

    async listGroups(tenantId: string): Promise<IGroup[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IGroup>(COLLECTIONS.groups)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find({ tenantId } as any)
        .sort({ name: 1 })
        .toArray();
      return docs.map((d) => this.mapGroup(d));
    }

    async updateGroup(
      id: string,
      data: Partial<Pick<IGroup, 'name' | 'description' | 'updatedBy' | 'tenantRole' | 'servicePermissions' | 'source' | 'externalId'>>,
    ): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const oid = ObjectId.isValid(id) ? new ObjectId(id) : null;
      if (!oid) return null;
      const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (data.servicePermissions !== undefined) {
        patch.servicePermissions = normalizeServicePermissions(data.servicePermissions);
      }
      const result = await db.collection<IGroup>(COLLECTIONS.groups).findOneAndUpdate(
        { _id: oid as unknown as IGroup['_id'] },
        { $set: patch },
        { returnDocument: 'after' },
      );
      if (!result) return null;
      return this.mapGroup(result);
    }

    private mapGroup(doc: IGroup & { _id?: unknown }): IGroup {
      return {
        ...doc,
        _id: doc._id?.toString(),
        source: doc.source ?? 'local',
        servicePermissions: normalizeServicePermissions(doc.servicePermissions),
      };
    }

    async deleteGroup(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const oid = ObjectId.isValid(id) ? new ObjectId(id) : null;
      if (!oid) return false;
      const result = await db.collection(COLLECTIONS.groups).deleteOne({ _id: oid });
      return result.deletedCount > 0;
    }

    // ── GroupMember CRUD ─────────────────────────────────────────────────

    async addGroupMember(data: Omit<IGroupMember, '_id' | 'createdAt'>): Promise<IGroupMember> {
      const db = this.getTenantDb();
      const now = new Date();
      const payload = { ...data, source: data.source ?? 'local', createdAt: now };
      await db.collection<IGroupMember>(COLLECTIONS.groupMembers).replaceOne(
        { tenantId: data.tenantId, groupId: data.groupId, userId: data.userId },
        payload,
        { upsert: true },
      );
      const doc = await db.collection<IGroupMember>(COLLECTIONS.groupMembers)
        .findOne({ tenantId: data.tenantId, groupId: data.groupId, userId: data.userId });
      return { ...doc!, _id: doc!._id?.toString() };
    }

    async removeGroupMember(groupId: string, userId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.groupMembers).deleteOne({ groupId, userId });
      return result.deletedCount > 0;
    }

    async listGroupMembers(groupId: string): Promise<IGroupMember[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IGroupMember>(COLLECTIONS.groupMembers).find({ groupId }).toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }));
    }

    async listGroupMembersByUser(userId: string): Promise<IGroupMember[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IGroupMember>(COLLECTIONS.groupMembers).find({ userId }).toArray();
      return docs.map((d) => ({ ...d, _id: d._id?.toString() }));
    }

    // ── GroupProject CRUD ────────────────────────────────────────────────

    async upsertGroupProject(data: Omit<IGroupProject, '_id' | 'createdAt' | 'updatedAt'>): Promise<IGroupProject> {
      const db = this.getTenantDb();
      const now = new Date();
      const servicePermissions = normalizeServicePermissions(data.servicePermissions);

      const result = await db.collection<IGroupProject>(COLLECTIONS.groupProjects).findOneAndUpdate(
        { tenantId: data.tenantId, groupId: data.groupId, projectId: data.projectId },
        {
          $set: { role: data.role, servicePermissions, updatedAt: now },
          $setOnInsert: { tenantId: data.tenantId, groupId: data.groupId, projectId: data.projectId, createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );

      return { ...result!, _id: result!._id?.toString(), servicePermissions };
    }

    async removeGroupProject(groupId: string, projectId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = await db.collection(COLLECTIONS.groupProjects).deleteOne({ groupId, projectId });
      return result.deletedCount > 0;
    }

    async listGroupProjectsByProject(projectId: string): Promise<IGroupProject[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IGroupProject>(COLLECTIONS.groupProjects).find({ projectId }).toArray();
      return docs.map((d) => this.mapGroupProject(d));
    }

    async listGroupProjectsByGroup(groupId: string): Promise<IGroupProject[]> {
      const db = this.getTenantDb();
      const docs = await db.collection<IGroupProject>(COLLECTIONS.groupProjects).find({ groupId }).toArray();
      return docs.map((d) => this.mapGroupProject(d));
    }

    async deleteGroupMembersByGroup(groupId: string): Promise<void> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.groupMembers).deleteMany({ groupId });
    }

    async deleteGroupProjectsByGroup(groupId: string): Promise<void> {
      const db = this.getTenantDb();
      await db.collection(COLLECTIONS.groupProjects).deleteMany({ groupId });
    }

    private mapGroupProject(d: IGroupProject & { _id?: unknown }): IGroupProject {
      return {
        ...d,
        _id: d._id?.toString(),
        servicePermissions: normalizeServicePermissions(d.servicePermissions),
        role: d.role as ProjectRole,
      };
    }
  };
}
