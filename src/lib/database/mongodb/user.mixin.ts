/**
 * MongoDB Provider – User operations mixin
 */

import { ObjectId } from 'mongodb';
import type { IUser } from '../provider.interface';
import type { Constructor } from './types';
import { MongoDBProviderBase, COLLECTIONS, logger } from './base';

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
      const db = this.getTenantDb();
      const trimmedEmail = email.trim();
      const normalizedEmail = this.normalizeEmail(email);
      const user = await db.collection<IUser>(COLLECTIONS.users).findOne({
        $or: [
          { emailLower: normalizedEmail },
          { email: normalizedEmail },
          { email: trimmedEmail },
        ],
      });
      if (!user) return null;

      return {
        ...user,
        _id: user._id?.toString(),
      };
    }

    async findUserById(id: string): Promise<IUser | null> {
      const db = this.getTenantDb();
      const user = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOne({ _id: new ObjectId(id) });
      if (!user) return null;

      return {
        ...user,
        _id: user._id?.toString(),
      };
    }

    async createUser(
      userData: Omit<IUser, '_id' | 'createdAt' | 'updatedAt'>,
    ): Promise<IUser> {
      const db = this.getTenantDb();
      const now = new Date();
      const trimmedEmail = userData.email.trim();
      const normalizedEmail = this.normalizeEmail(trimmedEmail);

      const userDocument = {
        ...userData,
        email: trimmedEmail,
        emailLower: normalizedEmail,
        createdAt: now,
        updatedAt: now,
      };

      const result = await db.collection(COLLECTIONS.users).insertOne(userDocument);

      const createdUser: IUser = {
        ...userDocument,
        _id: result.insertedId.toString(),
        createdAt: now,
        updatedAt: now,
      };

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

      if (payload.email) {
        const trimmedEmail = payload.email.trim();
        payload.email = trimmedEmail;
        payload.emailLower = this.normalizeEmail(trimmedEmail);
      }

      payload.updatedAt = new Date();

      const result = await db
        .collection<IUser>(COLLECTIONS.users)
        .findOneAndUpdate(
          { _id: objectId },
          { $set: payload },
          { returnDocument: 'after' },
        );

      if (!result) {
        return null;
      }

      const updatedUser: IUser = {
        ...result,
        _id: result._id?.toString(),
      };

      try {
        const tenant = await this.findTenantById(updatedUser.tenantId);
        if (tenant) {
          const tenantId =
            typeof tenant._id === 'string'
              ? tenant._id
              : (tenant._id?.toString() ?? updatedUser.tenantId);
          if (existingUser.email && existingUser.email !== updatedUser.email) {
            await this.unregisterUserFromDirectory(existingUser.email, tenantId);
          }
          await this.registerUserInDirectory({
            email: updatedUser.email,
            tenantId,
            tenantSlug: tenant.slug,
            tenantDbName: tenant.dbName,
            tenantCompanyName: tenant.companyName,
          });
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

      if (deleted) {
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

    async listUsers(): Promise<IUser[]> {
      const db = this.getTenantDb();
      const users = await db
        .collection<IUser>(COLLECTIONS.users)
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      return users.map((user: IUser) => ({
        ...user,
        _id: user._id?.toString(),
      }));
    }
  };
}
