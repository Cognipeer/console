/**
 * SQLite Provider – User operations mixin
 */

import type { IUser } from '../provider.interface';
import type { Constructor, SqliteRow } from './types';
import { SQLiteProviderBase, TABLES, logger } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import { isUsableIdentity, normalizeExternalIds } from '../provider/externalIds';
import { iamCollectionTableExists } from './iam-docs.mixin';
import {
  IDENTITY_COLLECTION,
  deleteIdentityDoc,
  ensureIdentityCollection,
  identityOfRow,
  identitySql,
  isIdentityEmpty,
  readIdentityDoc,
  writeIdentityDoc,
  type IdentityFields,
} from './userIdentity';

/** More than this many accounts holding one identity is not a race, it is a data problem; the resolver only needs the oldest. */
const MAX_IDENTITY_MATCHES = 5;

interface WithTenantOps {
  findTenantById(id: string): Promise<import('../provider.interface').ITenant | null>;
  registerUserInDirectory(entry: import('../provider.interface').ITenantUserDirectoryEntry): Promise<void>;
  unregisterUserFromDirectory(email: string, tenantId: string): Promise<void>;
}

export function UserMixin<TBase extends Constructor<SQLiteProviderBase & WithTenantOps>>(Base: TBase) {
  return class UserOps extends Base {

    async findUserByEmail(email: string): Promise<IUser | null> {
      const trimmedInput = (email ?? '').trim();
      if (!trimmedInput) return null;

      const db = this.getTenantDb();
      const normalizedEmail = this.normalizeEmail(trimmedInput);
      const trimmedEmail = trimmedInput;

      // External accounts (people of a host application) are never found by email: they cannot sign in, and one of them
      // must never shadow a member who has the same address.
      const identity = identitySql(db);
      const row = db.prepare(
        `SELECT ${TABLES.users}.*${identity.column} FROM ${TABLES.users}
         WHERE (emailLower = @emailLower OR email = @email1 OR email = @email2) AND ${identity.member} LIMIT 1`,
      ).get({
        emailLower: normalizedEmail,
        email1: normalizedEmail,
        email2: trimmedEmail,
      }) as SqliteRow | undefined;

      return row ? this.mapUserRow(row) : null;
    }

    async findUserById(id: string): Promise<IUser | null> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT ${TABLES.users}.*${identitySql(db).column} FROM ${TABLES.users} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      return row ? this.mapUserRow(row) : null;
    }

    /**
     * Looks up a user by their external-directory identity (e.g. an OIDC
     * `sub` or LDAP entry DN), NOT by email. Used by external-auth providers
     * whose stable identifier isn't the email — a synthesized/placeholder
     * email must never orphan the account, so this lookup wins over email
     * matching when it hits.
     */
    async findUserByExternalId(
      authProvider: NonNullable<IUser['authProvider']>,
      externalId: string,
    ): Promise<IUser | null> {
      if (!externalId) return null;
      const db = this.getTenantDb();
      const row = db.prepare(
        `SELECT ${TABLES.users}.*${identitySql(db).column} FROM ${TABLES.users}
         WHERE authProvider = @authProvider AND externalId = @externalId LIMIT 1`,
      ).get({ authProvider, externalId }) as SqliteRow | undefined;
      return row ? this.mapUserRow(row) : null;
    }

    /** The accounts that hold this identity (issuer + subject), oldest first. Not indexed: a scan of the identity documents. */
    async findUsersByExternalIdentity(issuer: string, subject: string): Promise<IUser[]> {
      if (!isUsableIdentity(issuer, subject)) return [];
      const db = this.getTenantDb();
      // (no document, no identity: a workspace that never met one has not even got the table)
      if (!iamCollectionTableExists(db, IDENTITY_COLLECTION)) return [];
      const rows = db.prepare(
        `SELECT ${TABLES.users}.*, ${IDENTITY_COLLECTION}.data AS identityData
         FROM ${IDENTITY_COLLECTION}
         JOIN ${TABLES.users} ON ${TABLES.users}.id = ${IDENTITY_COLLECTION}.id
         WHERE EXISTS (
           SELECT 1 FROM json_each(${IDENTITY_COLLECTION}.data, '$.externalIds') WHERE json_each.key = @issuer AND json_each.value = @subject
         )
         ORDER BY ${TABLES.users}.createdAt ASC, ${TABLES.users}.id ASC LIMIT @limit`,
      ).all({ issuer, subject, limit: MAX_IDENTITY_MATCHES }) as SqliteRow[];
      return rows.map((row) => this.mapUserRow(row));
    }

    async linkUserExternalIdentity(
      userId: string,
      issuer: string,
      subject: string,
    ): Promise<'linked' | 'already' | 'conflict' | 'not_found'> {
      if (!isUsableIdentity(issuer, subject)) return 'not_found';
      const db = this.getTenantDb();
      const exists = (): boolean => Boolean(db.prepare(`SELECT 1 AS present FROM ${TABLES.users} WHERE id = @id`).get({ id: userId }));
      if (!exists()) return 'not_found';
      ensureIdentityCollection(db);
      // One synchronous, immediate transaction: nobody can write between the read and the write.
      return db.transaction((): 'linked' | 'already' | 'conflict' | 'not_found' => {
        if (!exists()) return 'not_found';
        const current = readIdentityDoc(db, userId) ?? {};
        const held = normalizeExternalIds(current.externalIds) ?? {};
        if (Object.prototype.hasOwnProperty.call(held, issuer)) return held[issuer] === subject ? 'already' : 'conflict';
        const now = this.now();
        writeIdentityDoc(db, userId, { ...current, externalIds: { ...held, [issuer]: subject } }, now);
        db.prepare(`UPDATE ${TABLES.users} SET updatedAt = @updatedAt WHERE id = @id`).run({ id: userId, updatedAt: now });
        return 'linked';
      }).immediate();
    }

    async countExternalUsers(): Promise<number> {
      const db = this.getTenantDb();
      if (!iamCollectionTableExists(db, IDENTITY_COLLECTION)) return 0;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM ${IDENTITY_COLLECTION}
           JOIN ${TABLES.users} ON ${TABLES.users}.id = ${IDENTITY_COLLECTION}.id
           WHERE json_extract(${IDENTITY_COLLECTION}.data, '$.kind') = 'external'`,
        )
        .get() as SqliteRow | undefined;
      return Number(row?.c) || 0;
    }

    async createUser(userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>): Promise<IUser> {
      const db = this.getTenantDb();
      const id = this.newId();
      const now = this.now();
      const trimmedEmail = (userData.email ?? '').trim();
      const normalizedEmail = this.normalizeEmail(trimmedEmail);
      const canLogin = userData.canLogin !== false;
      const externalIds = normalizeExternalIds(userData.externalIds);
      // The kind and the external identities are not columns of the users table; they go to the account's identity document
      // (userIdentity.ts), in the same transaction as the account.
      const identity: IdentityFields = { kind: userData.kind ?? undefined, externalIds };
      const hasIdentity = !isIdentityEmpty(identity);
      if (hasIdentity) ensureIdentityCollection(db);

      db.transaction(() => {
        db.prepare(`
          INSERT INTO ${TABLES.users}
          (id, email, emailLower, password, name, tenantId, role, projectIds, servicePermissions, licenseId, features,
           invitedBy, invitedAt, inviteAcceptedAt, mustChangePassword, passwordChangedAt, authProvider, externalId, canLogin,
           status, disabledAt, disabledBy, disabledReason, createdAt, updatedAt)
          VALUES (@id, @email, @emailLower, @password, @name, @tenantId, @role, @projectIds, @servicePermissions, @licenseId, @features,
           @invitedBy, @invitedAt, @inviteAcceptedAt, @mustChangePassword, @passwordChangedAt, @authProvider, @externalId, @canLogin,
           @status, @disabledAt, @disabledBy, @disabledReason, @createdAt, @updatedAt)
        `).run({
          id,
          email: trimmedEmail,
          emailLower: normalizedEmail,
          password: userData.password,
          name: userData.name,
          tenantId: userData.tenantId,
          role: userData.role,
          projectIds: this.toJson(userData.projectIds ?? []),
          servicePermissions: this.toJson(normalizeServicePermissions(userData.servicePermissions)),
          licenseId: userData.licenseId,
          features: this.toJson(userData.features ?? []),
          invitedBy: userData.invitedBy ?? null,
          invitedAt: userData.invitedAt?.toISOString() ?? null,
          inviteAcceptedAt: userData.inviteAcceptedAt?.toISOString() ?? null,
          mustChangePassword: this.toBoolInt(userData.mustChangePassword),
          passwordChangedAt: userData.passwordChangedAt?.toISOString() ?? now,
          authProvider: userData.authProvider ?? 'local',
          externalId: userData.externalId ?? null,
          canLogin: this.toBoolInt(canLogin),
          status: userData.status ?? null,
          disabledAt: userData.disabledAt?.toISOString() ?? null,
          disabledBy: userData.disabledBy ?? null,
          disabledReason: userData.disabledReason ?? null,
          createdAt: now,
          updatedAt: now,
        });
        if (hasIdentity) writeIdentityDoc(db, id, identity, now);
      })();

      const { externalIds: _ignored, ...userFields } = userData;
      void _ignored;
      const createdUser: IUser = {
        ...userFields,
        ...(externalIds ? { externalIds } : {}),
        _id: id,
        email: trimmedEmail,
        emailLower: normalizedEmail,
        canLogin,
        createdAt: new Date(now),
        updatedAt: new Date(now),
      };

      // Sync user directory. Programmatic users (canLogin=false, typically no
      // email) have nothing to register; neither has an external account (the address of a host application's
      // person must not pull a sign-in here).
      if (trimmedEmail && userData.kind !== 'external') {
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
      if (data.servicePermissions !== undefined) {
        sets.push('servicePermissions = @servicePermissions');
        params.servicePermissions = this.toJson(normalizeServicePermissions(data.servicePermissions));
      }
      if (data.licenseId !== undefined) { sets.push('licenseId = @licenseId'); params.licenseId = data.licenseId; }
      if (data.features !== undefined) { sets.push('features = @features'); params.features = this.toJson(data.features); }
      if (data.invitedBy !== undefined) { sets.push('invitedBy = @invitedBy'); params.invitedBy = data.invitedBy; }
      if (data.invitedAt !== undefined) { sets.push('invitedAt = @invitedAt'); params.invitedAt = data.invitedAt?.toISOString() ?? null; }
      if (data.inviteAcceptedAt !== undefined) { sets.push('inviteAcceptedAt = @inviteAcceptedAt'); params.inviteAcceptedAt = data.inviteAcceptedAt?.toISOString() ?? null; }
      if (data.mustChangePassword !== undefined) { sets.push('mustChangePassword = @mustChangePassword'); params.mustChangePassword = this.toBoolInt(data.mustChangePassword); }
      if (data.passwordChangedAt !== undefined) {
        sets.push('passwordChangedAt = @passwordChangedAt');
        params.passwordChangedAt = data.passwordChangedAt?.toISOString() ?? null;
      }
      if (data.authProvider !== undefined) { sets.push('authProvider = @authProvider'); params.authProvider = data.authProvider; }
      if (data.externalId !== undefined) { sets.push('externalId = @externalId'); params.externalId = data.externalId ?? null; }
      if (data.canLogin !== undefined) { sets.push('canLogin = @canLogin'); params.canLogin = this.toBoolInt(data.canLogin); }
      // Lifecycle fields accept null to clear (re-enabling resets all four).
      if (data.status !== undefined) { sets.push('status = @status'); params.status = data.status ?? null; }
      if (data.disabledAt !== undefined) { sets.push('disabledAt = @disabledAt'); params.disabledAt = data.disabledAt?.toISOString() ?? null; }
      if (data.disabledBy !== undefined) { sets.push('disabledBy = @disabledBy'); params.disabledBy = data.disabledBy ?? null; }
      if (data.disabledReason !== undefined) { sets.push('disabledReason = @disabledReason'); params.disabledReason = data.disabledReason ?? null; }

      // The kind and the external identities are not columns of the users table: they are in the account's identity document
      // (userIdentity.ts), changed in the same transaction as the account. A null kind clears it; `externalIds` is a whole new
      // map (an empty one clears it).
      const changesIdentity = data.kind !== undefined || data.externalIds !== undefined;
      const nextExternalIds = data.externalIds !== undefined ? normalizeExternalIds(data.externalIds) : undefined;
      const updateAccount = (): void => {
        db.prepare(`UPDATE ${TABLES.users} SET ${sets.join(', ')} WHERE id = @id`).run(params);
      };
      if (!changesIdentity) {
        updateAccount();
      } else {
        if (data.kind || nextExternalIds) ensureIdentityCollection(db);
        db.transaction(() => {
          updateAccount();
          const next: IdentityFields = { ...(readIdentityDoc(db, id) ?? {}) };
          if (data.kind !== undefined) {
            if (data.kind) next.kind = data.kind;
            else delete next.kind;
          }
          if (data.externalIds !== undefined) {
            if (nextExternalIds) next.externalIds = nextExternalIds;
            else delete next.externalIds;
          }
          writeIdentityDoc(db, id, next, String(params.updatedAt));
        }).immediate();
      }

      const updated = this.mapUserRow(
        db.prepare(`SELECT ${TABLES.users}.*${identitySql(db).column} FROM ${TABLES.users} WHERE id = @id`).get({ id }) as SqliteRow,
      );

      // Sync user directory (an external account is never in it)
      try {
        const tenant = updated.kind === 'external' ? null : await this.findTenantById(updated.tenantId);
        if (tenant) {
          const tenantId = typeof tenant._id === 'string' ? tenant._id : (tenant._id?.toString() ?? updated.tenantId);
          const oldEmail = existing.email as string;
          if (oldEmail && oldEmail !== updated.email) {
            await this.unregisterUserFromDirectory(oldEmail, tenantId);
          }
          // Programmatic users (canLogin=false) may have no email — nothing to register.
          if (updated.email) {
            await this.registerUserInDirectory({
              email: updated.email,
              tenantId,
              tenantSlug: tenant.slug,
              tenantDbName: tenant.dbName,
              tenantCompanyName: tenant.companyName,
            });
          }
        }
      } catch (error) {
        logger.error('Failed to sync user directory during update', { error });
      }

      return updated;
    }

    async deleteUser(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const row = db.prepare(`SELECT ${TABLES.users}.*${identitySql(db).column} FROM ${TABLES.users} WHERE id = @id`)
        .get({ id }) as SqliteRow | undefined;
      if (!row) return false;
      const existing = this.mapUserRow(row);

      // (the account's identity document goes with it)
      const result = db.transaction(() => {
        const removed = db.prepare(`DELETE FROM ${TABLES.users} WHERE id = @id`).run({ id });
        deleteIdentityDoc(db, id);
        return removed;
      })();
      const deleted = result.changes > 0;

      if (deleted && existing.kind !== 'external') {
        try {
          await this.unregisterUserFromDirectory(
            existing.email,
            existing.tenantId,
          );
        } catch (error) {
          logger.error('Failed to unregister user from directory', { error });
        }
      }

      return deleted;
    }

    async listUsers(options: { includeExternal?: boolean } = {}): Promise<IUser[]> {
      const db = this.getTenantDb();
      // An account without an identity document is a member.
      const identity = identitySql(db);
      const where = options.includeExternal ? '' : `WHERE ${identity.member}`;
      const rows = db.prepare(`SELECT ${TABLES.users}.*${identity.column} FROM ${TABLES.users} ${where} ORDER BY createdAt DESC`)
        .all() as SqliteRow[];
      return rows.map((r) => this.mapUserRow(r));
    }

    protected mapUserRow(r: SqliteRow): IUser {
      const identity = identityOfRow(r);
      return {
        _id: r.id as string,
        email: r.email as string,
        emailLower: r.emailLower as string,
        password: r.password as string,
        name: r.name as string,
        tenantId: r.tenantId as string,
        role: r.role as IUser['role'],
        projectIds: this.parseJson<string[]>(r.projectIds, []),
        servicePermissions: normalizeServicePermissions(this.parseJson(r.servicePermissions, {})),
        licenseId: r.licenseId as string,
        features: this.parseJson<string[]>(r.features, []),
        invitedBy: r.invitedBy as string | undefined,
        invitedAt: this.toDate(r.invitedAt),
        inviteAcceptedAt: this.toDate(r.inviteAcceptedAt),
        mustChangePassword: this.fromBoolInt(r.mustChangePassword),
        passwordChangedAt: this.toDate(r.passwordChangedAt),
        authProvider: ((r.authProvider as string) || 'local') as IUser['authProvider'],
        externalId: (r.externalId as string | null) ?? undefined,
        // Missing/undefined column (pre-migration rows before the column
        // default kicked in) is treated as true — back-compat default.
        canLogin: r.canLogin === undefined ? true : this.fromBoolInt(r.canLogin),
        // NULL status (every pre-existing row) stays undefined = active.
        status: (r.status as IUser['status'] | null) ?? undefined,
        disabledAt: this.toDate(r.disabledAt),
        disabledBy: (r.disabledBy as string | null) ?? undefined,
        disabledReason: (r.disabledReason as string | null) ?? undefined,
        // No identity document (every account that is not external and holds no external identity) = a member.
        kind: identity.kind,
        externalIds: identity.externalIds,
        createdAt: this.toDate(r.createdAt),
        updatedAt: this.toDate(r.updatedAt),
      };
    }
  };
}
