/**
 * MongoDB Provider – User operations mixin
 */

import { ObjectId, type Filter } from 'mongodb';
import type { IUser } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';
import { normalizeServicePermissions } from '@/lib/security/rbac';
import {
  decodeExternalIds,
  decodeUserDocExternalIds,
  encodeExternalIds,
  encodeIssuerKey,
  externalIdPath,
  isUsableIdentity,
} from '../provider/externalIds';

/** More than this many accounts holding one identity is not a race, it is a data problem; the resolver only needs the oldest. */
const MAX_IDENTITY_MATCHES = 5;

/** A stored user document as the application sees it: string id, decoded `externalIds`. */
function fromUserDoc(user: IUser): IUser {
  return { ...decodeUserDocExternalIds(user), _id: user._id?.toString() };
}

// We need access to tenant-related methods to sync the user directory.
// The mixin chain guarantees TenantMixin is applied before UserMixin.
interface WithTenantOps {
  findTenantById(id: string): Promise<import('../provider.interface').ITenant | null>;
  registerUserInDirectory(entry: import('../provider.interface').ITenantUserDirectoryEntry): Promise<void>;
  unregisterUserFromDirectory(email: string, tenantId: string): Promise<void>;
}

export function UserMixin<TBase extends Constructor<MongoDBProviderBase & WithTenantOps>>(Base: TBase) {
  return class UserOps extends Base {
    async findUserByEmail(email: string): Promise<IUser | null> {
      const trimmedInput = (email ?? '').trim();
      if (!trimmedInput) return null;

      const db = this.getTenantDb();
      const trimmedEmail = trimmedInput;
      const normalizedEmail = this.normalizeEmail(trimmedInput);
      // External accounts (people of a host application) are never found by email: they cannot sign in, and one of them
      // must never shadow a member who has the same address.
      const user = await db.collection<IUser>(COLLECTIONS.users).findOne({
        $and: [
          { $or: [{ emailLower: normalizedEmail }, { email: normalizedEmail }, { email: trimmedEmail }] },
          { kind: { $ne: 'external' } },
        ],
      });
      if (!user) return null;

      return fromUserDoc(user);
    }

    async findUserById(id: string): Promise<IUser | null> {
      const db = this.getTenantDb();
      const user = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOne({ _id: new ObjectId(id) });
      if (!user) return null;

      return fromUserDoc(user);
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
      const user = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOne({ authProvider, externalId } as Partial<IUser>);
      if (!user) return null;

      return fromUserDoc(user);
    }

    /** The accounts that hold this identity (issuer + subject), oldest first. Not indexed: a scan of the workspace's accounts. */
    async findUsersByExternalIdentity(issuer: string, subject: string): Promise<IUser[]> {
      // Strings only: an object here would be a query operator.
      if (!isUsableIdentity(issuer, subject)) return [];
      const docs = await this.getTenantDb()
        .collection<IUser>(COLLECTIONS.users)
        .find({ [externalIdPath(issuer)]: subject } as Filter<IUser>)
        .sort({ createdAt: 1, _id: 1 })
        .limit(MAX_IDENTITY_MATCHES)
        .toArray();
      return docs.map(fromUserDoc);
    }

    async linkUserExternalIdentity(
      userId: string,
      issuer: string,
      subject: string,
    ): Promise<'linked' | 'already' | 'conflict' | 'not_found'> {
      if (!isUsableIdentity(issuer, subject) || !ObjectId.isValid(userId)) return 'not_found';
      const users = this.getTenantDb().collection<IUser>(COLLECTIONS.users);
      const _id = new ObjectId(userId);
      const path = externalIdPath(issuer);
      // Atomic: written only while the account holds nothing for this issuer yet.
      const written = await users.updateOne(
        { _id, [path]: { $exists: false } } as Filter<IUser>,
        { $set: { [path]: subject, updatedAt: new Date() } } as never,
      );
      if (written.modifiedCount === 1) return 'linked';
      const doc = await users.findOne({ _id });
      if (!doc) return 'not_found';
      const held = (doc as { externalIds?: Record<string, unknown> }).externalIds?.[encodeIssuerKey(issuer)];
      return held === subject ? 'already' : 'conflict';
    }

    async countExternalUsers(): Promise<number> {
      return this.getTenantDb().collection<IUser>(COLLECTIONS.users).countDocuments({ kind: 'external' });
    }

    async createUser(
      userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IUser> {
      const db = this.getTenantDb();
      const now = new Date();
      const trimmedEmail = (userData.email ?? '').trim();
      const normalizedEmail = this.normalizeEmail(trimmedEmail);

      const { externalIds: _ignored, ...userFields } = userData;
      void _ignored;
      const storedExternalIds = encodeExternalIds(userData.externalIds);
      const userDocument = {
        ...userFields,
        ...(storedExternalIds ? { externalIds: storedExternalIds } : {}),
        email: trimmedEmail,
        emailLower: normalizedEmail,
        servicePermissions: normalizeServicePermissions(userData.servicePermissions),
        canLogin: userData.canLogin !== false,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db.collection(COLLECTIONS.users).insertOne(userDocument);

      const normalizedExternalIds = decodeExternalIds(storedExternalIds);
      const createdUser: IUser = {
        ...userFields,
        ...(normalizedExternalIds ? { externalIds: normalizedExternalIds } : {}),
        email: trimmedEmail,
        emailLower: normalizedEmail,
        servicePermissions: userDocument.servicePermissions,
        canLogin: userDocument.canLogin,
        _id: result.insertedId.toString(),
        createdAt: now,
        updatedAt: now,
      };

      // Programmatic users (canLogin=false, typically no email) have nothing
      // to register in the cross-tenant email directory; neither has an external account
      // (the address of a host application's person must not pull a sign-in here).
      if (trimmedEmail && userData.kind !== 'external') {
        try {
          const tenant = await this.findTenantById(userData.tenantId);
          if (tenant) {
            const tenantId =
              typeof tenant._id === 'string'
                ? tenant._id
                : (tenant._id?.toString() ?? userData.tenantId);
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
      const objectId = new ObjectId(id);
      const existingUser = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOne({ _id: objectId });

      if (!existingUser) {
        return null;
      }

      const payload: Partial<IUser> = { ...data };
      delete payload._id;
      // `externalIds` is stored with encoded field names; an empty map removes the field.
      const unset: Record<string, ''> = {};
      if ('externalIds' in data) {
        const stored = encodeExternalIds(data.externalIds);
        if (stored) (payload as Record<string, unknown>).externalIds = stored;
        else {
          delete payload.externalIds;
          unset.externalIds = '';
        }
      }

      if (payload.email) {
        const trimmedEmail = payload.email.trim();
        payload.email = trimmedEmail;
        payload.emailLower = this.normalizeEmail(trimmedEmail);
      }
      if (payload.servicePermissions) {
        payload.servicePermissions = normalizeServicePermissions(payload.servicePermissions);
      }

      payload.updatedAt = new Date();

      const result = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOneAndUpdate(
          { _id: objectId },
          { $set: payload, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      const updatedUser: IUser = fromUserDoc(result);

      try {
        // (an external account is never in the cross-tenant directory)
        const tenant = updatedUser.kind === 'external' ? null : await this.findTenantById(updatedUser.tenantId);
        if (tenant) {
          const tenantId =
            typeof tenant._id === 'string'
              ? tenant._id
              : (tenant._id?.toString() ?? updatedUser.tenantId);
          if (existingUser.email && existingUser.email !== updatedUser.email) {
            await this.unregisterUserFromDirectory(existingUser.email, tenantId);
          }
          // Programmatic users (canLogin=false) may have no email — nothing to register.
          if (updatedUser.email) {
            await this.registerUserInDirectory({
              email: updatedUser.email,
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

      return updatedUser;
    }

    async deleteUser(id: string): Promise<boolean> {
      const db = this.getTenantDb();
      const objectId = new ObjectId(id);
      const existingUser = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOne({ _id: objectId });

      if (!existingUser) {
        return false;
      }

      const result = await db.collection(COLLECTIONS.users).deleteOne({ _id: objectId });
      const deleted = result.deletedCount > 0;

      if (deleted && existingUser.kind !== 'external') {
        try {
          await this.unregisterUserFromDirectory(
            existingUser.email,
            existingUser.tenantId,
          );
        } catch (error) {
          logger.error('Failed to unregister user from directory', { error });
        }
      }

      return deleted;
    }

    async listUsers(options: { includeExternal?: boolean } = {}): Promise<IUser[]> {
      const db = this.getTenantDb();
      const users = await db
        .collection<IUser>(COLLECTIONS.users)
        // An account without a kind is a member.
        .find(options.includeExternal ? {} : { kind: { $ne: 'external' } })
        .sort({ createdAt: -1 })
        .toArray();

      return users.map((user: IUser) => fromUserDoc(user));
    }
  };
}
