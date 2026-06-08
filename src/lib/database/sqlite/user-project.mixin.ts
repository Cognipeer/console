/**
 * SQLite Provider – UserProject (project membership) operations mixin
 */

import type { IGroup, IGroupMember, IGroupProject, IUserProject, ProjectRole } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';

export function UserProjectMixin<TBase extends Constructor<SQLiteProviderBase>>(Base: TBase) {
  return class UserProjectOps extends Base {

    // ── UserProject CRUD ─────────────────────────────────────────────────

    async findUserProject(userId: string, projectId: string): Promise<IUserProject | null> {
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT * FROM ${TABLES.userProjects} WHERE userId = @userId AND projectId = @projectId LIMIT 1`,
      ).get({ userId, projectId }) as SqliteRow | undefined;
      return row ? this.mapUserProjectRow(row) : null;
    }

    async listUserProjectsByUser(userId: string): Promise<IUserProject[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.userProjects} WHERE userId = @userId ORDER BY createdAt DESC`,
      ).all({ userId }) as SqliteRow[];
      return rows.map((r) => this.mapUserProjectRow(r));
    }

    async listUserProjectsByProject(projectId: string): Promise<IUserProject[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(
        `SELECT * FROM ${TABLES.userProjects} WHERE projectId = @projectId ORDER BY createdAt DESC`,
      ).all({ projectId }) as SqliteRow[];
      return rows.map((r) => this.mapUserProjectRow(r));
    }

    async upsertUserProject(
      data: Omit<IUserProject, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IUserProject> {
      const db = this.getTenantDb();
      const now = this.now();

      const existing = db.prepare(
        `SELECT id FROM ${TABLES.userProjects} WHERE tenantId = @tenantId AND userId = @userId AND projectId = @projectId`,
      ).get({ tenantId: data.tenantId, userId: data.userId, projectId: data.projectId }) as SqliteRow | undefined;

      const servicePermsJson = this.toJson(normalizeServicePermissions(data.servicePermissions));

      if (existing) {
        db.prepare(`
          UPDATE ${TABLES.userProjects}
          SET role = @role, servicePermissions = @servicePermissions, updatedAt = @updatedAt
          WHERE id = @id
        `).run({ id: existing.id, role: data.role, servicePermissions: servicePermsJson, updatedAt: now });

        const updated = db.prepare(`SELECT * FROM ${TABLES.userProjects} WHERE id = @id`)
          .get({ id: existing.id }) as SqliteRow;
        return this.mapUserProjectRow(updated);
      }

      const id = this.newId();
      db.prepare(`
        INSERT INTO ${TABLES.userProjects}
        (id, tenantId, userId, projectId, role, servicePermissions, invitedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @userId, @projectId, @role, @servicePermissions, @invitedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: data.tenantId,
        userId: data.userId,
        projectId: data.projectId,
        role: data.role,
        servicePermissions: servicePermsJson,
        invitedBy: data.invitedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...data,
        _id: id,
        servicePermissions: normalizeServicePermissions(data.servicePermissions),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
    }

    async deleteUserProject(userId: string, projectId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.userProjects} WHERE userId = @userId AND projectId = @projectId`,
      ).run({ userId, projectId });
      return result.changes > 0;
    }

    async deleteUserProjectsByProject(projectId: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.userProjects} WHERE projectId = @projectId`).run({ projectId });
    }

    async deleteUserProjectsByUser(userId: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.userProjects} WHERE userId = @userId`).run({ userId });
    }

    protected mapUserProjectRow(r: SqliteRow): IUserProject {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        userId: r.userId as string,
        projectId: r.projectId as string,
        role: r.role as ProjectRole,
        servicePermissions: normalizeServicePermissions(this.parseJson(r.servicePermissions, {})),
        invitedBy: r.invitedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    // ── Group CRUD (future) ──────────────────────────────────────────────

    async createGroup(
      data: Omit<IGroup, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IGroup> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT INTO ${TABLES.groups}
        (id, tenantId, name, description, tenantRole, servicePermissions, source, externalId, createdBy, updatedBy, createdAt, updatedAt)
        VALUES (@id, @tenantId, @name, @description, @tenantRole, @servicePermissions, @source, @externalId, @createdBy, @updatedBy, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: data.tenantId,
        name: data.name,
        description: data.description ?? null,
        tenantRole: data.tenantRole ?? null,
        servicePermissions: this.toJson(normalizeServicePermissions(data.servicePermissions)),
        source: data.source ?? 'local',
        externalId: data.externalId ?? null,
        createdBy: data.createdBy,
        updatedBy: data.updatedBy ?? null,
        createdAt: now,
        updatedAt: now,
      });

      return {
        ...data,
        _id: id,
        source: data.source ?? 'local',
        servicePermissions: normalizeServicePermissions(data.servicePermissions),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };
    }

    async findGroupById(id: string): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.groups} WHERE id = @id`).get({ id }) as SqliteRow | undefined;
      return row ? this.mapGroupRow(row) : null;
    }

    async findGroupByExternalId(externalId: string): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.groups} WHERE externalId = @externalId LIMIT 1`)
        .get({ externalId }) as SqliteRow | undefined;
      return row ? this.mapGroupRow(row) : null;
    }

    async listGroups(tenantId: string): Promise<IGroup[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.groups} WHERE tenantId = @tenantId ORDER BY name ASC`)
        .all({ tenantId }) as SqliteRow[];
      return rows.map((r) => this.mapGroupRow(r));
    }

    async updateGroup(
      id: string,
      data: Partial<Pick<IGroup, 'name' | 'description' | 'updatedBy' | 'tenantRole' | 'servicePermissions' | 'source' | 'externalId'>>,
    ): Promise<IGroup | null> {
      const db = this.getTenantDb();
      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };

      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.description !== undefined) { sets.push('description = @description'); params.description = data.description; }
      if (data.updatedBy !== undefined) { sets.push('updatedBy = @updatedBy'); params.updatedBy = data.updatedBy; }
      if (data.tenantRole !== undefined) { sets.push('tenantRole = @tenantRole'); params.tenantRole = data.tenantRole ?? null; }
      if (data.servicePermissions !== undefined) {
        sets.push('servicePermissions = @servicePermissions');
        params.servicePermissions = this.toJson(normalizeServicePermissions(data.servicePermissions));
      }
      if (data.source !== undefined) { sets.push('source = @source'); params.source = data.source; }
      if (data.externalId !== undefined) { sets.push('externalId = @externalId'); params.externalId = data.externalId ?? null; }

      db.prepare(`UPDATE ${TABLES.groups} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return this.findGroupById(id);
    }

    async deleteGroup(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(`DELETE FROM ${TABLES.groups} WHERE id = @id`).run({ id });
      return result.changes > 0;
    }

    // ── GroupMember CRUD ─────────────────────────────────────────────────

    async addGroupMember(data: Omit<IGroupMember, '_id' | 'createdAt'>): Promise<IGroupMember> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();

      db.prepare(`
        INSERT OR REPLACE INTO ${TABLES.groupMembers}
        (id, tenantId, groupId, userId, role, source, addedBy, createdAt)
        VALUES (@id, @tenantId, @groupId, @userId, @role, @source, @addedBy, @createdAt)
      `).run({
        id,
        tenantId: data.tenantId,
        groupId: data.groupId,
        userId: data.userId,
        role: data.role,
        source: data.source ?? 'local',
        addedBy: data.addedBy ?? null,
        createdAt: now,
      });

      return { ...data, _id: id, source: data.source ?? 'local', createdAt: new Date(now) };
    }

    async removeGroupMember(groupId: string, userId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.groupMembers} WHERE groupId = @groupId AND userId = @userId`,
      ).run({ groupId, userId });
      return result.changes > 0;
    }

    async listGroupMembers(groupId: string): Promise<IGroupMember[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.groupMembers} WHERE groupId = @groupId`)
        .all({ groupId }) as SqliteRow[];
      return rows.map((r) => this.mapGroupMemberRow(r));
    }

    async listGroupMembersByUser(userId: string): Promise<IGroupMember[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.groupMembers} WHERE userId = @userId`)
        .all({ userId }) as SqliteRow[];
      return rows.map((r) => this.mapGroupMemberRow(r));
    }

    // ── GroupProject CRUD ────────────────────────────────────────────────

    async upsertGroupProject(data: Omit<IGroupProject, '_id' | 'createdAt' | 'updatedAt'>): Promise<IGroupProject> {
      const db = this.getTenantDb();
      const now = this.now();

      const existing = db.prepare(
        `SELECT id FROM ${TABLES.groupProjects} WHERE tenantId = @tenantId AND groupId = @groupId AND projectId = @projectId`,
      ).get({ tenantId: data.tenantId, groupId: data.groupId, projectId: data.projectId }) as SqliteRow | undefined;

      const servicePermsJson = this.toJson(normalizeServicePermissions(data.servicePermissions));

      if (existing) {
        db.prepare(`
          UPDATE ${TABLES.groupProjects}
          SET role = @role, servicePermissions = @servicePermissions, updatedAt = @updatedAt
          WHERE id = @id
        `).run({ id: existing.id, role: data.role, servicePermissions: servicePermsJson, updatedAt: now });

        const updated = db.prepare(`SELECT * FROM ${TABLES.groupProjects} WHERE id = @id`)
          .get({ id: existing.id }) as SqliteRow;
        return this.mapGroupProjectRow(updated);
      }

      const id = this.newId();
      db.prepare(`
        INSERT INTO ${TABLES.groupProjects}
        (id, tenantId, groupId, projectId, role, servicePermissions, createdAt, updatedAt)
        VALUES (@id, @tenantId, @groupId, @projectId, @role, @servicePermissions, @createdAt, @updatedAt)
      `).run({
        id,
        tenantId: data.tenantId,
        groupId: data.groupId,
        projectId: data.projectId,
        role: data.role,
        servicePermissions: servicePermsJson,
        createdAt: now,
        updatedAt: now,
      });

      return { ...data, _id: id, servicePermissions: normalizeServicePermissions(data.servicePermissions), createdAt: new Date(now), updatedAt: new Date(now) };
    }

    async removeGroupProject(groupId: string, projectId: string): Promise<boolean> {
      const db = this.getTenantDb();
      const result = db.prepare(
        `DELETE FROM ${TABLES.groupProjects} WHERE groupId = @groupId AND projectId = @projectId`,
      ).run({ groupId, projectId });
      return result.changes > 0;
    }

    async listGroupProjectsByProject(projectId: string): Promise<IGroupProject[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.groupProjects} WHERE projectId = @projectId`)
        .all({ projectId }) as SqliteRow[];
      return rows.map((r) => this.mapGroupProjectRow(r));
    }

    async listGroupProjectsByGroup(groupId: string): Promise<IGroupProject[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.groupProjects} WHERE groupId = @groupId`)
        .all({ groupId }) as SqliteRow[];
      return rows.map((r) => this.mapGroupProjectRow(r));
    }

    async deleteGroupMembersByGroup(groupId: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.groupMembers} WHERE groupId = @groupId`).run({ groupId });
    }

    async deleteGroupProjectsByGroup(groupId: string): Promise<void> {
      const db = this.getTenantDb();
      db.prepare(`DELETE FROM ${TABLES.groupProjects} WHERE groupId = @groupId`).run({ groupId });
    }

    // ── Private mappers ──────────────────────────────────────────────────

    protected mapGroupRow(r: SqliteRow): IGroup {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        name: r.name as string,
        description: r.description as string | undefined,
        tenantRole: (r.tenantRole as IGroup['tenantRole']) ?? undefined,
        servicePermissions: normalizeServicePermissions(this.parseJson(r.servicePermissions, {})),
        source: ((r.source as string) || 'local') as IGroup['source'],
        externalId: (r.externalId as string | null) ?? undefined,
        createdBy: r.createdBy as string,
        updatedBy: r.updatedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }

    protected mapGroupMemberRow(r: SqliteRow): IGroupMember {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        groupId: r.groupId as string,
        userId: r.userId as string,
        role: r.role as 'admin' | 'member',
        source: ((r.source as string) || 'local') as IGroupMember['source'],
        addedBy: r.addedBy as string | undefined,
        createdAt: this.toDate(r.createdAt),
      };
    }

    protected mapGroupProjectRow(r: SqliteRow): IGroupProject {
      return {
        _id: r.id as string,
        tenantId: r.tenantId as string,
        groupId: r.groupId as string,
        projectId: r.projectId as string,
        role: r.role as ProjectRole,
        servicePermissions: normalizeServicePermissions(this.parseJson(r.servicePermissions, {})),
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
