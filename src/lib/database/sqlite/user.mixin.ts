/**
 * SQLite Provider – User operations mixin
 */

import type { IUser } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES, logger } from './base';

interface WithTenantOps {
  findTenantById(id: string): Promise<import('../provider.interface').ITenant | null>;
  registerUserInDirectory(entry: import('../provider.interface').ITenantUserDirectoryEntry): Promise<void>;
  unregisterUserFromDirectory(email: string, tenantId: string): Promise<void>;
}

export function UserMixin<TBase extends Constructor<SQLiteProviderBase & WithTenantOps>>(Base: TBase) {
  return class UserOps extends Base {

    async findUserByEmail(email: string): Promise<IUser | null> {
      const db = this.getTenantDb();
      const normalizedEmail = this.normalizeEmail(email);
      const trimmedEmail = email.trim();

      const row = db.prepare(
        `SELECT * FROM ${TABLES.users} WHERE emailLower = @emailLower OR email = @email1 OR email = @email2 LIMIT 1`,
      ).get({
        emailLower: normalizedEmail,
        email1: normalizedEmail,
        email2: trimmedEmail,
      }) as SqliteRow | undefined;

      return row ? this.mapUserRow(row) : null;
    }

    async findUserById(id: string): Promise<IUser | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT * FROM ${TABLES.users} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapUserRow(row) : null;
    }

    async createUser(userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>): Promise<IUser> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      const trimmedEmail = userData.email.trim();
      const normalizedEmail = this.normalizeEmail(trimmedEmail);

      db.prepare(`
        INSERT INTO ${TABLES.users}
        (id, email, emailLower, password, name, tenantId, role, projectIds, licenseId, features,
         invitedBy, invitedAt, inviteAcceptedAt, mustChangePassword, createdAt, updatedAt)
        VALUES (@id, @email, @emailLower, @password, @name, @tenantId, @role, @projectIds, @licenseId, @features,
         @invitedBy, @invitedAt, @inviteAcceptedAt, @mustChangePassword, @createdAt, @updatedAt)
      `).run({
        id,
        email: trimmedEmail,
        emailLower: normalizedEmail,
        password: userData.password,
        name: userData.name,
        tenantId: userData.tenantId,
        role: userData.role,
        projectIds: this.toJson(userData.projectIds ?? []),
        licenseId: userData.licenseId,
        features: this.toJson(userData.features ?? []),
        invitedBy: userData.invitedBy ?? null,
        invitedAt: userData.invitedAt?.toISOString() ?? null,
        inviteAcceptedAt: userData.inviteAcceptedAt?.toISOString() ?? null,
        mustChangePassword: this.toBoolInt(userData.mustChangePassword),
        createdAt: now,
        updatedAt: now,
      });

      const createdUser: IUser = {
        ...userData,
        _id: id,
        email: trimmedEmail,
        emailLower: normalizedEmail,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };

      // Sync user directory
      try {
        const tenant = await this.findTenantById(userData.tenantId);
        if (tenant) {
          const tenantId = typeof tenant._id === 'string' ? tenant._id : (tenant._id?.toString() ?? userData.tenantId);
          await this.registerUserInDirectory({
            email: trimmedEmail,
            tenantId,
            tenantSlug: tenant.slug,
            tenantDbName: tenant.dbName,
            tenantCompanyName: tenant.companyName,
          });
        }
      } catch (error) {
        logger.error('Failed to register user in directory', { error });
      }

      return createdUser;
    }

    async updateUser(id: string, data: Partial<IUser>): Promise<IUser | null> {
      const db = this.getTenantDb();
      const existing = db.prepare(`SELECT * FROM ${TABLES.users} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      if (!existing) return null;

      const sets: string[] = ['updatedAt = @updatedAt'];
      const params: Record<string, unknown> = { id, updatedAt: this.now() };

      if (data.email !== undefined) {
        const trimmed = data.email.trim();
        sets.push('email = @email', 'emailLower = @emailLower');
        params.email = trimmed;
        params.emailLower = this.normalizeEmail(trimmed);
      }
      if (data.password !== undefined) { sets.push('password = @password'); params.password = data.password; }
      if (data.name !== undefined) { sets.push('name = @name'); params.name = data.name; }
      if (data.role !== undefined) { sets.push('role = @role'); params.role = data.role; }
      if (data.projectIds !== undefined) { sets.push('projectIds = @projectIds'); params.projectIds = this.toJson(data.projectIds); }
      if (data.licenseId !== undefined) { sets.push('licenseId = @licenseId'); params.licenseId = data.licenseId; }
      if (data.features !== undefined) { sets.push('features = @features'); params.features = this.toJson(data.features); }
      if (data.invitedBy !== undefined) { sets.push('invitedBy = @invitedBy'); params.invitedBy = data.invitedBy; }
      if (data.invitedAt !== undefined) { sets.push('invitedAt = @invitedAt'); params.invitedAt = data.invitedAt?.toISOString() ?? null; }
      if (data.inviteAcceptedAt !== undefined) { sets.push('inviteAcceptedAt = @inviteAcceptedAt'); params.inviteAcceptedAt = data.inviteAcceptedAt?.toISOString() ?? null; }
      if (data.mustChangePassword !== undefined) { sets.push('mustChangePassword = @mustChangePassword'); params.mustChangePassword = this.toBoolInt(data.mustChangePassword); }

      db.prepare(`UPDATE ${TABLES.users} SET ${sets.join(', ')} WHERE id = @id`).run(params);

      const updated = this.mapUserRow(
        db.prepare(`SELECT * FROM ${TABLES.users} WHERE id = @id`).get({ id }) as SqliteRow,
      );

      // Sync user directory
      try {
        const tenant = await this.findTenantById(updated.tenantId);
        if (tenant) {
          const tenantId = typeof tenant._id === 'string' ? tenant._id : (tenant._id?.toString() ?? updated.tenantId);
          const oldEmail = existing.email as string;
          if (oldEmail && oldEmail !== updated.email) {
            await this.unregisterUserFromDirectory(oldEmail, tenantId);
          }
          await this.registerUserInDirectory({
            email: updated.email,
            tenantId,
            tenantSlug: tenant.slug,
            tenantDbName: tenant.dbName,
            tenantCompanyName: tenant.companyName,
          });
        }
      } catch (error) {
        logger.error('Failed to sync user directory during update', { error });
      }

      return updated;
    }

    async deleteUser(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const existing = db.prepare(`SELECT * FROM ${TABLES.users} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      if (!existing) return false;

      const result = db.prepare(`DELETE FROM ${TABLES.users} WHERE id = @id`).run({ id });
      const deleted = result.changes > 0;

      if (deleted) {
        try {
          await this.unregisterUserFromDirectory(
            existing.email as string,
            existing.tenantId as string,
          );
        } catch (error) {
          logger.error('Failed to unregister user from directory', { error });
        }
      }

      return deleted;
    }

    async listUsers(): Promise<IUser[]> {
      const db = this.getTenantDb();
      const rows = db.prepare(`SELECT * FROM ${TABLES.users} ORDER BY createdAt DESC`)
        .all() as SqliteRow[];
      return rows.map((r) => this.mapUserRow(r));
    }

    protected mapUserRow(r: SqliteRow): IUser {
      return {
        _id: r.id as string,
        email: r.email as string,
        emailLower: r.emailLower as string,
        password: r.password as string,
        name: r.name as string,
        tenantId: r.tenantId as string,
        role: r.role as IUser['role'],
        projectIds: this.parseJson<string[]>(r.projectIds, []),
        licenseId: r.licenseId as string,
        features: this.parseJson<string[]>(r.features, []),
        invitedBy: r.invitedBy as string | undefined,
        invitedAt: this.toDate(r.invitedAt),
        inviteAcceptedAt: this.toDate(r.inviteAcceptedAt),
        mustChangePassword: this.fromBoolInt(r.mustChangePassword),
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
